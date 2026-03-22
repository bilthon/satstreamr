import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import type { SignalingMessage } from '../types/signaling.js';

const signalingUrl = (import.meta.env['VITE_SIGNALING_URL'] as string | undefined) ?? 'ws://localhost:8080';

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
const sessionIdEl = document.getElementById('session-id');
const sessionContainerEl = document.getElementById('session-container');
const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;
const errorEl = document.getElementById('error');

function setStatus(text: string): void {
  if (statusEl !== null) {
    statusEl.textContent = text;
  }
}

function showError(text: string): void {
  console.error('[tutor]', text);
  if (errorEl !== null) {
    errorEl.textContent = text;
    errorEl.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionId: string | null = null;
let localStream: MediaStream | null = null;
const peer = new PeerConnection();

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

client.onConnect(() => {
  setStatus('connected — creating session…');
  client.send({ type: 'create_session' });
});

client.onDisconnect(() => {
  setStatus('disconnected');
});

// ---------------------------------------------------------------------------
// Wire up ICE candidate forwarding
// ---------------------------------------------------------------------------

peer.onIceCandidate((candidate) => {
  if (sessionId === null) {
    console.warn('[tutor] ICE candidate arrived but no sessionId yet — dropping');
    return;
  }
  client.send({ type: 'ice_candidate', sessionId, candidate });
});

// ---------------------------------------------------------------------------
// ICE state display
// ---------------------------------------------------------------------------

peer.onIceStateChange = (state) => {
  setStatus(`ICE connection state: ${state}`);
};

// ---------------------------------------------------------------------------
// Remote track → remote video
// ---------------------------------------------------------------------------

peer.onTrack = (event) => {
  // Tutor can optionally display the viewer's video in a remote-video element.
  const remoteVideoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
  if (remoteVideoEl !== null && event.streams[0] !== undefined) {
    remoteVideoEl.srcObject = event.streams[0];
  }
};

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

client.onMessage((msg: SignalingMessage) => {
  switch (msg.type) {
    case 'session_created':
      handleSessionCreated(msg.sessionId);
      break;

    case 'viewer_joined':
      void handleViewerJoined();
      break;

    case 'answer':
      void peer.handleAnswer(msg.sdp as RTCSessionDescriptionInit);
      break;

    case 'ice_candidate':
      void peer.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      break;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleSessionCreated(id: string): void {
  sessionId = id;
  console.log('[tutor] session created:', id);

  if (sessionIdEl !== null) {
    sessionIdEl.textContent = id;
  }
  if (sessionContainerEl !== null) {
    sessionContainerEl.style.display = 'block';
  }

  setStatus('session created — waiting for viewer…');

  // Start media immediately so the tutor can see themselves while waiting.
  void startMedia();
}

async function startMedia(): Promise<void> {
  try {
    localStream = await peer.initMedia();
    if (localVideoEl !== null) {
      localVideoEl.srcObject = localStream;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(message);
  }
}

async function handleViewerJoined(): Promise<void> {
  if (sessionId === null) {
    showError('viewer_joined received but sessionId is unknown');
    return;
  }
  if (localStream === null) {
    showError('viewer_joined received but local media stream not ready');
    return;
  }

  setStatus('viewer joined — creating offer…');

  try {
    const offer = await peer.createOffer(localStream);
    client.send({ type: 'offer', sessionId, sdp: offer });
    setStatus('offer sent — waiting for answer…');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`Failed to create offer: ${message}`);
  }
}
