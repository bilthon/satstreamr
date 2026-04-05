/**
 * PeerConnection — RTCPeerConnection abstraction for satstreamr.
 *
 * Design goals:
 * - Typed event callbacks: onTrack, onIceStateChange, onDataChannel
 * - Trickle ICE with candidate buffering until setRemoteDescription completes
 * - STUN-only ICE config (TURN added in Unit 13)
 * - Raw RTCPeerConnection exposed via getPeerConnection() for Unit 07 data channel
 * - getUserMedia errors surfaced as human-readable strings, not raw DOMException
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  /** Called when a remote track arrives. */
  onTrack: ((event: RTCTrackEvent) => void) | null = null;

  /** Called whenever ICE connection state changes. */
  onIceStateChange: ((state: RTCIceConnectionState) => void) | null = null;

  /** Called when a remote data channel is received (Unit 07+). */
  onDataChannel: ((event: RTCDataChannelEvent) => void) | null = null;

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.ontrack = (event) => {
      console.log('[peer] ontrack', event.track.kind);
      this.onTrack?.(event);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log('[peer] ICE connection state:', state);
      this.onIceStateChange?.(state);
    };

    this.pc.ondatachannel = (event) => {
      console.log('[peer] ondatachannel', event.channel.label);
      this.onDataChannel?.(event);
    };
  }

  /**
   * Requests camera and microphone access via getUserMedia.
   * Throws a human-readable error string if permission is denied or device is unavailable.
   */
  async initMedia(): Promise<MediaStream> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      console.log('[peer] getUserMedia succeeded');
      return stream;
    } catch (err: unknown) {
      const message = buildGetUserMediaError(err);
      console.error('[peer] getUserMedia failed:', message);
      throw new Error(message);
    }
  }

  /**
   * Creates the payment data channel on the tutor side.
   * MUST be called before createOffer() so the channel is negotiated in the initial SDP exchange.
   * Fires onDataChannel with a synthetic RTCDataChannelEvent once the channel opens.
   */
  createPaymentChannel(): RTCDataChannel {
    const channel = this.pc.createDataChannel('payment', { ordered: true });
    console.log('[peer] payment data channel created');

    channel.onopen = () => {
      console.log('[peer] payment data channel open');
      // Synthesise an RTCDataChannelEvent and fire the existing onDataChannel callback.
      const event = new RTCDataChannelEvent('datachannel', { channel });
      this.onDataChannel?.(event);
    };

    return channel;
  }

  /**
   * Adds all tracks from stream and creates an SDP offer.
   * Call this on the tutor side after viewer_joined.
   * Ensure createPaymentChannel() has been called first.
   */
  async createOffer(stream: MediaStream): Promise<RTCSessionDescriptionInit> {
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.log('[peer] offer created');
    return offer;
  }

  /**
   * Sets the remote offer, adds local tracks, and returns an SDP answer.
   * Call this on the viewer side when an offer arrives.
   */
  async handleOffer(
    offer: RTCSessionDescriptionInit,
    stream: MediaStream,
  ): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();

    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    console.log('[peer] answer created');
    return answer;
  }

  /**
   * Sets the remote answer.
   * Call this on the tutor side after the viewer sends back an answer.
   */
  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();
    console.log('[peer] remote answer set');
  }

  /**
   * Adds a remote ICE candidate.
   * Buffers the candidate if setRemoteDescription has not yet completed.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionSet) {
      console.log('[peer] buffering ICE candidate (remote desc not yet set)');
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * Registers a callback to be called for each local ICE candidate.
   * Use this to forward candidates over the signaling channel.
   */
  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void {
    this.pc.onicecandidate = (event) => {
      if (event.candidate !== null) {
        console.log('[peer] local ICE candidate', event.candidate.type);
        handler(event.candidate.toJSON());
      }
    };
  }

  /**
   * Exposes the raw RTCPeerConnection for external use (e.g. Unit 07 data channel).
   * Do not call setLocalDescription / setRemoteDescription directly — use the methods above.
   */
  getPeerConnection(): RTCPeerConnection {
    return this.pc;
  }

  /**
   * Closes the underlying RTCPeerConnection, stopping all media transmission.
   * Call this whenever the session ends to ensure remote tracks are torn down
   * and cannot be accessed by removing UI overlays via developer tools.
   */
  close(): void {
    this.pc.close();
    console.log('[peer] connection closed');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async flushPendingCandidates(): Promise<void> {
    if (this.pendingCandidates.length === 0) return;
    console.log(`[peer] flushing ${String(this.pendingCandidates.length)} buffered ICE candidates`);
    const toFlush = this.pendingCandidates.splice(0);
    for (const candidate of toFlush) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGetUserMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Camera/microphone access was denied. Please allow permissions in your browser and try again.';
      case 'NotFoundError':
        return 'No camera or microphone found. Please connect a device and try again.';
      case 'NotReadableError':
        return 'Camera or microphone is already in use by another application.';
      case 'OverconstrainedError':
        return 'The requested media constraints could not be satisfied by your device.';
      case 'SecurityError':
        return 'Media access is blocked by a security policy. Make sure you are on a secure (HTTPS) origin.';
      default:
        return `Media access failed: ${err.name} — ${err.message}`;
    }
  }
  if (err instanceof Error) {
    return `Media access failed: ${err.message}`;
  }
  return 'An unknown error occurred while accessing camera/microphone.';
}
