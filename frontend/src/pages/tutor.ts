import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { getDecodedToken } from '@cashu/cashu-ts';
import type { Proof } from '../types/cashu.js';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { checkTokenState, redeemToken } from '../lib/cashu-wallet.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession, clearSession } from '../lib/session-storage.js';

const signalingUrl = (import.meta.env['VITE_SIGNALING_URL'] as string | undefined) ?? 'ws://localhost:8080';

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
const sessionIdEl = document.getElementById('session-id');
const sessionContainerEl = document.getElementById('session-container');
const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;
const errorEl = document.getElementById('error');
const dcStatusEl = document.getElementById('dc-status');

// Session UI elements
const sessionStatsEl = document.getElementById('session-stats');
const elapsedTimeEl = document.getElementById('elapsed-time');
const satsReceivedEl = document.getElementById('sats-received');
const paymentPausedBannerEl = document.getElementById('payment-paused-banner');
const sessionSummaryOverlayEl = document.getElementById('session-summary-overlay');
const summaryDurationEl = document.getElementById('summary-duration');
const summarySatsEl = document.getElementById('summary-sats');
const summaryChunksEl = document.getElementById('summary-chunks');
const summaryCloseBtnEl = document.getElementById('summary-close-btn');

// Reconnect overlay -- inserted programmatically so it works without HTML changes
const reconnectOverlayEl = document.createElement('div');
reconnectOverlayEl.id = 'reconnect-overlay';
reconnectOverlayEl.style.cssText =
  'position:fixed;inset:0;background:rgba(0,0,0,0.6);' +
  'color:#fff;font-size:1.5rem;align-items:center;' +
  'justify-content:center;z-index:9999;';
reconnectOverlayEl.style.display = 'none';
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
  console.error('[tutor]', text);
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
// Session UI state
// ---------------------------------------------------------------------------

let sessionStartTime: number | null = null;
let elapsedTimerHandle: ReturnType<typeof setInterval> | null = null;
let totalSatsReceived = 0;
let totalChunksReceived = 0;
let summaryShown = false;

/** Format seconds as MM:SS. */
function formatElapsed(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Start the elapsed timer. Called when the data channel opens. */
function startElapsedTimer(): void {
  if (elapsedTimerHandle !== null) return;
  sessionStartTime = Date.now();
  elapsedTimerHandle = setInterval(() => {
    if (sessionStartTime === null) return;
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    if (elapsedTimeEl !== null) {
      elapsedTimeEl.textContent = formatElapsed(elapsed);
    }
  }, 1000);
}

/** Stop and clear the elapsed timer. */
function stopElapsedTimer(): void {
  if (elapsedTimerHandle !== null) {
    clearInterval(elapsedTimerHandle);
    elapsedTimerHandle = null;
  }
}

/** Return elapsed seconds since session start (0 if not started). */
function getElapsedSeconds(): number {
  if (sessionStartTime === null) return 0;
  return Math.floor((Date.now() - sessionStartTime) / 1000);
}

/** Show the session stats bar. */
function showSessionStats(): void {
  if (sessionStatsEl !== null) {
    sessionStatsEl.style.display = 'flex';
  }
}

/** Update the sats-received counter. */
function updateSatsReceived(delta: number): void {
  totalSatsReceived += delta;
  totalChunksReceived += 1;
  if (satsReceivedEl !== null) {
    satsReceivedEl.textContent = String(totalSatsReceived);
  }
}

/** Show the payment-paused banner. */
function showPaymentPausedBanner(): void {
  if (paymentPausedBannerEl !== null) {
    paymentPausedBannerEl.classList.add('visible');
  }
}

/** Hide the payment-paused banner. */
function hidePaymentPausedBanner(): void {
  if (paymentPausedBannerEl !== null) {
    paymentPausedBannerEl.classList.remove('visible');
  }
}

/** Show the session-end summary overlay. */
function showSessionSummary(): void {
  if (summaryShown) return;
  summaryShown = true;

  stopElapsedTimer();
  const elapsed = getElapsedSeconds();

  if (summaryDurationEl !== null) {
    summaryDurationEl.textContent = formatElapsed(elapsed);
  }
  if (summarySatsEl !== null) {
    summarySatsEl.textContent = String(totalSatsReceived);
  }
  if (summaryChunksEl !== null) {
    summaryChunksEl.textContent = String(totalChunksReceived);
  }
  if (sessionSummaryOverlayEl !== null) {
    sessionSummaryOverlayEl.classList.add('visible');
  }
}

// Wire up the close button
if (summaryCloseBtnEl !== null) {
  summaryCloseBtnEl.addEventListener('click', () => {
    clearSession();
    window.location.href = '/';
  });
}

// ---------------------------------------------------------------------------
// Keypair generation (Unit 10)
// ---------------------------------------------------------------------------

const PRIVKEY_STORAGE_KEY = 'tutor_privkey';

/** Generate or restore the tutor's secp256k1 keypair from sessionStorage. */
function getOrGenerateKeypair(): { privkeyHex: string; pubkeyHex: string } {
  const stored = sessionStorage.getItem(PRIVKEY_STORAGE_KEY);
  if (stored !== null) {
    const privBytes = Uint8Array.from(
      (stored.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
    );
    const pubkeyBytes = secp256k1.getPublicKey(privBytes, true);
    return { privkeyHex: stored, pubkeyHex: bytesToHex(pubkeyBytes) };
  }
  const { secretKey, publicKey } = secp256k1.keygen();
  const privkeyHex = bytesToHex(secretKey);
  const pubkeyHex = bytesToHex(publicKey);
  sessionStorage.setItem(PRIVKEY_STORAGE_KEY, privkeyHex);
  return { privkeyHex, pubkeyHex };
}

const { privkeyHex: tutorPrivkeyHex, pubkeyHex: tutorPubkeyHex } = getOrGenerateKeypair();
console.log('[tutor] pubkey:', tutorPubkeyHex);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionId: string | null = null;
let localStream: MediaStream | null = null;
let dataChannel: DataChannel | null = null;
const peer = new PeerConnection();

/** Last chunkId successfully processed. Starts at -1 so first chunkId=0 is valid. */
let lastSeenChunkId = -1;

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

client.onConnect(() => {
  hideReconnectOverlay();
  const existing = loadSession();
  if (existing !== null) {
    // A session was previously established (e.g. SignalingClient lost its
    // in-memory sessionId but sessionStorage still has it).  Rejoin rather
    // than creating a new orphan session.
    client.setSessionId(existing.sessionId);
    setStatus('reconnecting -- rejoining session\u2026');
    client.send({ type: 'rejoin_session', sessionId: existing.sessionId });
  } else {
    setStatus('connected -- creating session\u2026');
    client.send({ type: 'create_session', tutorPubkey: tutorPubkeyHex });
  }
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
    setStatus(`reconnected -- session ${saved.sessionId}`);
    if (sessionIdEl !== null) {
      sessionIdEl.textContent = saved.sessionId;
    }
    if (sessionContainerEl !== null) {
      sessionContainerEl.style.display = 'block';
    }
  } else {
    setStatus('reconnected');
  }
});

// ---------------------------------------------------------------------------
// Wire up ICE candidate forwarding
// ---------------------------------------------------------------------------

peer.onIceCandidate((candidate) => {
  if (sessionId === null) {
    console.warn('[tutor] ICE candidate arrived but no sessionId yet -- dropping');
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
// Data channel -- token receipt, verify, ack/nack (Unit 10)
// ---------------------------------------------------------------------------

peer.onDataChannel = (event) => {
  dataChannel = new DataChannel(event.channel);
  console.log('[datachannel] open');
  setDcStatus('open');

  // Start the elapsed timer now that the data channel is open
  startElapsedTimer();
  showSessionStats();
  hidePaymentPausedBanner();

  event.channel.onclose = () => {
    console.log('[datachannel] closed');
    setDcStatus('closed');
    stopElapsedTimer();
  };

  dataChannel.onMessage((msg) => {
    if (msg.type === 'session_paused') {
      // Viewer signaled that payment was paused
      showPaymentPausedBanner();
      return;
    }

    if (msg.type !== 'token_payment') {
      console.log('[tutor] data channel message received:', msg);
      return;
    }

    const { chunkId, encodedToken } = msg;

    // Validate chunkId is strictly greater than last seen
    if (chunkId <= lastSeenChunkId) {
      console.warn(
        `[payment] duplicate/out-of-order chunk #${chunkId} (last seen: ${lastSeenChunkId}) -- nack`,
      );
      dataChannel?.sendMessage({ type: 'payment_nack', chunkId, reason: 'duplicate_chunk_id' });
      return;
    }

    void handleTokenPayment(chunkId, encodedToken);
  });
};

async function handleTokenPayment(chunkId: number, encodedToken: string): Promise<void> {
  if (dataChannel === null) return;

  // 1. Decode the token
  let proofs: ReturnType<typeof getDecodedToken>['proofs'];
  try {
    const decoded = getDecodedToken(encodedToken);
    proofs = decoded.proofs;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[payment] failed to decode token for chunk #${chunkId}:`, reason);
    dataChannel.sendMessage({ type: 'payment_nack', chunkId, reason: `decode_error: ${reason}` });
    return;
  }

  // 2. NUT-07 state check -- belt-and-suspenders double-spend detection
  try {
    const state = await checkTokenState(proofs);
    if (state === 'spent') {
      console.warn(`[payment] chunk #${chunkId} already spent -- nack`);
      dataChannel.sendMessage({ type: 'payment_nack', chunkId, reason: 'double_spend' });
      return;
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[payment] checkTokenState failed for chunk #${chunkId}:`, reason);
    dataChannel.sendMessage({ type: 'payment_nack', chunkId, reason: `state_check_error: ${reason}` });
    return;
  }

  // 3. Redeem (NUT-03 swap with NUT-11 P2PK signature)
  try {
    await redeemToken(proofs, tutorPrivkeyHex);
    lastSeenChunkId = chunkId;
    console.log(`[payment] ack #${chunkId}`);
    dataChannel.sendMessage({ type: 'payment_ack', chunkId });

    // Update the sats-received counter (each chunk carries chunkSats — read from
    // the decoded proofs total rather than hardcoding the chunk size).
    const chunkSats = (proofs as Proof[]).reduce((sum: number, p: Proof) => sum + p.amount, 0);
    updateSatsReceived(chunkSats);

    // If the payment was previously paused and a new chunk just succeeded, hide the banner.
    hidePaymentPausedBanner();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[payment] redeemToken failed for chunk #${chunkId}:`, reason);
    dataChannel.sendMessage({ type: 'payment_nack', chunkId, reason });
  }
}

// ---------------------------------------------------------------------------
// Remote track -> remote video
// ---------------------------------------------------------------------------

peer.onTrack = (event) => {
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

    case 'end_session':
      showSessionSummary();
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

  client.setSessionId(id);
  saveSession({
    sessionId: id,
    peerId: '',
    role: 'tutor',
    chunkCount: 0,
    totalSatsPaid: 0,
    budgetRemaining: 0,
  });

  if (sessionIdEl !== null) {
    sessionIdEl.textContent = id;
  }
  if (sessionContainerEl !== null) {
    sessionContainerEl.style.display = 'block';
  }

  setStatus('session created -- waiting for viewer\u2026');

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

  setStatus('viewer joined -- creating offer\u2026');

  try {
    // Create the payment data channel BEFORE createOffer() so it is negotiated
    // in the initial SDP exchange and no renegotiation is required.
    peer.createPaymentChannel();
    setDcStatus('connecting\u2026');

    const offer = await peer.createOffer(localStream);
    client.send({ type: 'offer', sessionId, sdp: offer });
    setStatus('offer sent -- waiting for answer\u2026');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`Failed to create offer: ${message}`);
  }
}
