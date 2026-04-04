/**
 * PeerConnection — RTCPeerConnection abstraction for satstreamr.
 *
 * Design goals:
 * - Typed event callbacks: onTrack, onIceStateChange, onDataChannel
 * - Trickle ICE with candidate buffering until setRemoteDescription completes
 * - Dynamic ICE server config (STUN + optional TURN) injected via constructor
 * - Raw RTCPeerConnection exposed via getPeerConnection() for Unit 07 data channel
 * - getUserMedia errors surfaced as human-readable strings, not raw DOMException
 * - ICE restart support (Unit 13): onIceRestartNeeded, restartIce(), onConnectionRestored,
 *   onConnectionLost
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

/** How long (ms) to wait in 'disconnected' state before triggering ICE restart. */
const DISCONNECT_DEBOUNCE_MS = 2_000;

/** How long (ms) to wait for recovery after an ICE restart before giving up. */
const RECOVERY_TIMEOUT_MS = 15_000;

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  // ICE restart state
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartInProgress = false;

  /** Called when a remote track arrives. */
  onTrack: ((event: RTCTrackEvent) => void) | null = null;

  /** Called whenever ICE connection state changes. */
  onIceStateChange: ((state: RTCIceConnectionState) => void) | null = null;

  /** Called when a remote data channel is received (Unit 07+). */
  onDataChannel: ((event: RTCDataChannelEvent) => void) | null = null;

  /**
   * Called (tutor/offerer side only) when the connection has been disconnected
   * for DISCONNECT_DEBOUNCE_MS and an ICE restart offer should be sent.
   */
  onIceRestartNeeded: (() => void) | null = null;

  /**
   * Called when the connection is restored to 'connected' after a restart attempt.
   */
  onConnectionRestored: (() => void) | null = null;

  /**
   * Called when recovery times out (RECOVERY_TIMEOUT_MS) with no restoration.
   */
  onConnectionLost: (() => void) | null = null;

  constructor(iceServers?: RTCIceServer[]) {
    const servers = (iceServers !== undefined && iceServers.length > 0)
      ? iceServers
      : DEFAULT_ICE_SERVERS;

    this.pc = new RTCPeerConnection({ iceServers: servers });

    this.pc.ontrack = (event) => {
      console.log('[peer] ontrack', event.track.kind);
      this.onTrack?.(event);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log('[peer] ICE connection state:', state);
      this.onIceStateChange?.(state);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log('[peer] connection state:', state);
      this.handleConnectionStateChange(state);
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
   * Handles an ICE-restart offer from the tutor side (viewer only).
   * Unlike the initial handleOffer(), this does NOT add tracks again (they are
   * already present) and does NOT re-register onDataChannel.
   */
  async handleRestartOffer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    console.log('[peer] ICE restart answer created');
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
   * Triggers an ICE restart on the offerer (tutor) side.
   * Creates a new offer with iceRestart:true, sets it as local description,
   * and returns the offer SDP for sending over the signaling channel.
   *
   * NOTE: The data channel is intentionally NOT closed/reopened here. The
   * existing channel remains open throughout the ICE restart.
   */
  async restartIce(): Promise<RTCSessionDescriptionInit> {
    console.log('[peer] starting ICE restart');
    this.iceRestartInProgress = true;

    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    // After a restart offer the remote description needs re-setting,
    // so reset the guard until handleAnswer() is called.
    this.remoteDescriptionSet = false;

    console.log('[peer] ICE restart offer created');
    return offer;
  }

  /**
   * Exposes the raw RTCPeerConnection for external use (e.g. Unit 07 data channel).
   * Do not call setLocalDescription / setRemoteDescription directly — use the methods above.
   */
  getPeerConnection(): RTCPeerConnection {
    return this.pc;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleConnectionStateChange(state: RTCPeerConnectionState): void {
    switch (state) {
      case 'disconnected':
        if (this.iceRestartInProgress) break;
        if (this.disconnectTimer !== null) break; // already scheduled
        console.log(`[peer] disconnected — will fire onIceRestartNeeded in ${DISCONNECT_DEBOUNCE_MS}ms`);
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (this.pc.connectionState !== 'disconnected') return;
          console.log('[peer] firing onIceRestartNeeded');
          this.onIceRestartNeeded?.();

          // Start recovery watchdog
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            if (this.pc.connectionState !== 'connected') {
              console.warn('[peer] recovery timeout — firing onConnectionLost');
              this.iceRestartInProgress = false;
              this.onConnectionLost?.();
            }
          }, RECOVERY_TIMEOUT_MS);
        }, DISCONNECT_DEBOUNCE_MS);
        break;

      case 'connected':
        // Clear any pending disconnect timer
        if (this.disconnectTimer !== null) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }
        // If we were restarting, signal success
        if (this.iceRestartInProgress) {
          if (this.recoveryTimer !== null) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
          }
          this.iceRestartInProgress = false;
          console.log('[peer] connection restored after ICE restart');
          this.onConnectionRestored?.();
        }
        break;

      case 'failed':
        // Clear any pending disconnect timer — failed is terminal without restart
        if (this.disconnectTimer !== null) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }
        break;

      default:
        break;
    }
  }

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
