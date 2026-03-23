import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession } from '../lib/session-storage.js';

const signalingUrl = (import.meta.env['VITE_SIGNALING_URL'] as string | undefined) ?? 'ws://localhost:8080';

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;
const remoteVideoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
const errorEl = document.getElementById('error');
const sessionDisplayEl = document.getElementById('session-display');
const dcStatusEl = document.getElementById('dc-status');

// Reconnect overlay — inserted programmatically so it works without HTML changes
const reconnectOverlayEl = document.createElement('div');
reconnectOverlayEl.id = 'reconnect-overlay';
reconnectOverlayEl.style.cssText =
  'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);' +
  'color:#fff;font-size:1.5rem;display:flex;align-items:center;' +
  'justify-content:center;z-index:9999;';
reconnectOverlayEl.textContent = 'reconnecting\u2026';
document.body.appendChild(reconnectOverlayEl);

function showReconnectOverlay(): void {
  reconnectOverlayEl.style.display = 'flex';
}

function hideReconnectOverlay(): void {
  reconnectOverlayEl.style.display = 'none';
}

function setStatus(text: string): void {
  if (statusEl !== null) {
    statusEl.textContent = text;
  }
}

function showError(text: string): void {
  console.error('[viewer]', text);
  if (errorEl !== null) {
    errorEl.textContent = text;
    errorEl.style.display = 'block';
  }
}

function setDcStatus(text: string): void {
  if (dcStatusEl !== null) {
    dcStatusEl.textContent = `payment channel: ${text}`;
  }
}

// ---------------------------------------------------------------------------
// Read sessionId from URL query param ?session=<id>
// ---------------------------------------------------------------------------

const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session');

if (sessionDisplayEl !== null) {
  sessionDisplayEl.textContent = sessionId !== null ? `Session: ${sessionId}` : 'No session ID in URL';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let localStream: MediaStream | null = null;
let dataChannel: DataChannel | null = null;
const peer = new PeerConnection();

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

client.onConnect(() => {
  if (sessionId === null) {
    showError('No session ID found in URL. Add ?session=<id> to the URL.');
    setStatus('error — no session ID');
    return;
  }

  setStatus('connected — joining session…');
  client.send({ type: 'join_session', sessionId });

  // Persist session state for reconnect recovery
  client.setSessionId(sessionId);
  saveSession({
    sessionId,
    peerId: '',
    role: 'viewer',
    chunkCount: 0,
    totalSatsPaid: 0,
    budgetRemaining: 0,
  });

  // Start media in parallel with session join
  void startMedia();
});

client.onDisconnecting(() => {
  showReconnectOverlay();
  setStatus('reconnecting\u2026');
});

client.onDisconnect(() => {
  setStatus('disconnected');
});

client.onReconnected(() => {
  hideReconnectOverlay();
  const saved = loadSession();
  if (saved !== null) {
    setStatus(`reconnected — session ${saved.sessionId}`);
    if (sessionDisplayEl !== null) {
      sessionDisplayEl.textContent = `Session: ${saved.sessionId}`;
    }
  } else {
    setStatus('reconnected');
  }
});

// ---------------------------------------------------------------------------
// Wire up ICE candidate forwarding
// ---------------------------------------------------------------------------

peer.onIceCandidate((candidate) => {
  if (sessionId === null) return;
  client.send({ type: 'ice_candidate', sessionId, candidate });
});

// ---------------------------------------------------------------------------
// ICE state display
// ---------------------------------------------------------------------------

peer.onIceStateChange = (state) => {
  setStatus(`ICE connection state: ${state}`);
};

// ---------------------------------------------------------------------------
// Data channel
// ---------------------------------------------------------------------------

peer.onDataChannel = (event) => {
  const rawChannel = event.channel;

  // ondatachannel fires when the channel is received but it may still be
  // in 'connecting' state. Wait for 'open' before marking ready.
  rawChannel.onopen = () => {
    dataChannel = new DataChannel(rawChannel);
    console.log('[datachannel] open');
    setDcStatus('open');

    dataChannel.onMessage((msg) => {
      console.log('[viewer] data channel message received:', msg);
    });
  };

  rawChannel.onclose = () => {
    console.log('[datachannel] closed');
    setDcStatus('closed');
  };
};

// ---------------------------------------------------------------------------
// Remote track → remote video
// ---------------------------------------------------------------------------

peer.onTrack = (event) => {
  console.log('[viewer] remote track received:', event.track.kind);
  if (remoteVideoEl !== null && event.streams[0] !== undefined) {
    remoteVideoEl.srcObject = event.streams[0];
  }
};

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

client.onMessage((msg: SignalingMessage) => {
  switch (msg.type) {
    case 'offer':
      void handleOffer(msg.sdp as RTCSessionDescriptionInit);
      break;

    case 'ice_candidate':
      void peer.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      break;

    case 'error':
      showError(`Signaling error: ${msg.code}${msg.message !== undefined ? ' — ' + msg.message : ''}`);
      break;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function startMedia(): Promise<void> {
  try {
    localStream = await peer.initMedia();
    if (localVideoEl !== null) {
      localVideoEl.srcObject = localStream;
    }
    console.log('[viewer] local media ready');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(message);
  }
}

async function handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
  if (sessionId === null) {
    showError('Offer received but no sessionId');
    return;
  }

  // Wait for local media if not yet available
  if (localStream === null) {
    setStatus('offer received — waiting for local media…');
    await waitForLocalStream();
  }

  if (localStream === null) {
    showError('Local media stream unavailable — cannot answer offer');
    return;
  }

  setStatus('offer received — creating answer…');

  try {
    const answer = await peer.handleOffer(offer, localStream);
    client.send({ type: 'answer', sessionId, sdp: answer });
    setStatus('answer sent — waiting for ICE…');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`Failed to handle offer: ${message}`);
  }
}

/**
 * Polls until localStream is set or a timeout elapses.
 * Necessary because join_session and startMedia() race on connect.
 */
async function waitForLocalStream(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (localStream === null && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
