import { PeerConnection } from './peer-connection.js';
import { SignalingClient } from '../signaling-client.js';

/**
 * Wires the shared peer handlers: ICE candidate forwarding, ICE state
 * display, and remote track -> video element binding.
 *
 * The onDataChannel handler is NOT wired here — it's role-specific.
 */
export function wireSharedPeerHandlers(
  peer: PeerConnection,
  getSessionId: () => string | null,
  client: SignalingClient,
  setStatus: (text: string) => void,
  remoteVideoEl: HTMLVideoElement | null,
): void {
  peer.onIceCandidate((candidate) => {
    const sid = getSessionId();
    if (sid === null) return;
    client.send({ type: 'ice_candidate', sessionId: sid, candidate });
  });

  peer.onIceStateChange = (state) => {
    setStatus(`ICE connection state: ${state}`);
  };

  peer.onTrack = (event) => {
    if (remoteVideoEl !== null && event.streams[0] !== undefined) {
      remoteVideoEl.srcObject = event.streams[0];
    }
  };
}

/**
 * Tears down the current peer and creates a fresh one.
 * Returns the new PeerConnection.
 */
export function recreatePeer(currentPeer: PeerConnection): PeerConnection {
  currentPeer.close();
  return new PeerConnection();
}
