import { getEncodedToken } from '@cashu/cashu-ts';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { mintP2PKToken } from '../lib/cashu-wallet.js';
import { PaymentScheduler } from '../lib/payment-scheduler.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession, updateSession, clearSession } from '../lib/session-storage.js';
import { assertSameMint, MintMismatchError } from '../lib/mint-guard.js';
import { getBalance } from '../lib/wallet-store.js';
import { getMintUrl } from '../lib/config.js';

// Derive the signaling WebSocket URL. If VITE_SIGNALING_URL is set at build
// time it takes priority (e.g. a dedicated signaling server in production).
// Otherwise fall back to the Vite-proxied /ws path so that the connection
// works on any host — including LAN devices accessing the dev server over
// HTTPS — without mixed-content (wss vs ws) errors.
function getSignalingUrl(): string {
  const env = import.meta.env['VITE_SIGNALING_URL'] as string | undefined;
  if (env) return env;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
const signalingUrl = getSignalingUrl();
const mintUrl = getMintUrl();

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;
const remoteVideoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
const errorEl = document.getElementById('error');
const sessionDisplayEl = document.getElementById('session-display');
const dcStatusEl = document.getElementById('dc-status');

// Session UI elements
const sessionStatsEl = document.getElementById('session-stats');
const budgetDisplayEl = document.getElementById('budget-display');
const estDurationDisplayEl = document.getElementById('est-duration-display');
const chunkIndicatorEl = document.getElementById('chunk-indicator');
const paymentPausedBannerEl = document.getElementById('payment-paused-banner');
const sessionSummaryOverlayEl = document.getElementById('session-summary-overlay');
const summaryDurationEl = document.getElementById('summary-duration');
const summarySatsEl = document.getElementById('summary-sats');
const summaryChunksEl = document.getElementById('summary-chunks');
const summaryCloseBtnEl = document.getElementById('summary-close-btn');

// Mint mismatch overlay
const mintMismatchOverlayEl = document.getElementById('mint-mismatch-overlay');
const sessionMintUrlEl = document.getElementById('session-mint-url');
const localMintUrlEl = document.getElementById('local-mint-url');

function showMintMismatch(sessionMint: string, localMint: string): void {
  if (sessionMintUrlEl !== null) sessionMintUrlEl.textContent = sessionMint;
  if (localMintUrlEl !== null) localMintUrlEl.textContent = localMint;
  if (mintMismatchOverlayEl !== null) {
    mintMismatchOverlayEl.classList.remove('hidden');
  }
}

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
// Session UI state
// ---------------------------------------------------------------------------

let sessionStartTime: number | null = null;
let totalSatsPaidDisplay = 0;
let totalChunksPaidDisplay = 0;
let summaryShown = false;

/** Format seconds as MM:SS. */
function formatElapsed(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Return elapsed seconds since session start (0 if not started). */
function getElapsedSeconds(): number {
  if (sessionStartTime === null) return 0;
  return Math.floor((Date.now() - sessionStartTime) / 1000);
}

/** Show the session stats bar and record start time. */
function showSessionStats(initialBudget: number): void {
  if (sessionStartTime === null) {
    sessionStartTime = Date.now();
  }
  if (sessionStatsEl !== null) {
    sessionStatsEl.style.display = 'flex';
  }
  updateBudgetDisplay(initialBudget);
}

/** Update the remaining budget display. */
function updateBudgetDisplay(budgetSats: number): void {
  if (budgetDisplayEl !== null) {
    budgetDisplayEl.textContent = `${budgetSats} sats`;
    if (budgetSats <= 10) {
      budgetDisplayEl.classList.add('low');
    } else {
      budgetDisplayEl.classList.remove('low');
    }
  }
  updateEstDurationDisplay(budgetSats);
}

/** Update the estimated session duration based on current balance and rate. */
function updateEstDurationDisplay(budgetSats: number): void {
  if (estDurationDisplayEl === null) return;
  if (activeRateSatsPerInterval <= 0 || activeIntervalSeconds <= 0) {
    estDurationDisplayEl.textContent = '—';
    return;
  }
  const mins = Math.floor(budgetSats / activeRateSatsPerInterval * activeIntervalSeconds / 60);
  estDurationDisplayEl.textContent = `~${mins} min at current rate`;
}

/** Trigger the chunk pulse animation on the indicator dot. */
function triggerChunkPulse(): void {
  if (chunkIndicatorEl === null) return;
  // Remove the class first to reset animation if it's already running
  chunkIndicatorEl.classList.remove('pulse');
  // Force a reflow so removing and re-adding the class restarts the animation
  void chunkIndicatorEl.offsetWidth;
  chunkIndicatorEl.classList.add('pulse');
  setTimeout(() => {
    chunkIndicatorEl.classList.remove('pulse');
  }, 500);
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

  const elapsed = getElapsedSeconds();

  if (summaryDurationEl !== null) {
    summaryDurationEl.textContent = formatElapsed(elapsed);
  }
  if (summarySatsEl !== null) {
    summarySatsEl.textContent = String(totalSatsPaidDisplay);
  }
  if (summaryChunksEl !== null) {
    summaryChunksEl.textContent = String(totalChunksPaidDisplay);
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
// Read sessionId from URL query param ?session=<id>
// ---------------------------------------------------------------------------

const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session');

if (sessionDisplayEl !== null) {
  sessionDisplayEl.textContent = sessionId !== null ? `Session: ${sessionId}` : 'No session ID in URL';
}

// ---------------------------------------------------------------------------
// Rate state (populated from signaling; invite is a fallback)
// ---------------------------------------------------------------------------

const DEFAULT_RATE_SATS = 2;
const DEFAULT_INTERVAL_SECS = 10;

let activeRateSatsPerInterval = DEFAULT_RATE_SATS;
let activeIntervalSeconds = DEFAULT_INTERVAL_SECS;

// Pre-populate from pending_join invite data if available (set by home.ts)
try {
  const pendingJoinRaw = sessionStorage.getItem('pending_join');
  if (pendingJoinRaw !== null) {
    const pendingJoin = JSON.parse(pendingJoinRaw) as Record<string, unknown>;
    if (typeof pendingJoin['rateSatsPerInterval'] === 'number') {
      activeRateSatsPerInterval = pendingJoin['rateSatsPerInterval'] as number;
    }
    if (typeof pendingJoin['intervalSeconds'] === 'number') {
      activeIntervalSeconds = pendingJoin['intervalSeconds'] as number;
    }
  }
} catch {
  // sessionStorage read/parse failures are non-fatal
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let localStream: MediaStream | null = null;
let dataChannel: DataChannel | null = null;
let scheduler: PaymentScheduler | null = null;
const peer = new PeerConnection();

/** Tutor's compressed secp256k1 pubkey received via signaling. */
let tutorPubkey: string | null = null;

/** Monotonically increasing chunk counter (used only by DEV manual payment). */
let nextChunkId = 0;

// ---------------------------------------------------------------------------
// DEV-only payment button (Unit 10)
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const payBtn = document.createElement('button');
  payBtn.id = 'dev-pay-btn';
  payBtn.textContent = 'Send 1 sat test payment';
  payBtn.style.cssText =
    'position:fixed;bottom:1rem;right:1rem;padding:0.5rem 1rem;' +
    'background:#f7931a;color:#fff;border:none;border-radius:4px;' +
    'font-size:1rem;cursor:pointer;z-index:9998;';

  payBtn.addEventListener('click', () => {
    void handleDevPayment();
  });

  document.body.appendChild(payBtn);
}

async function handleDevPayment(): Promise<void> {
  if (tutorPubkey === null) {
    showError('[DEV] tutorPubkey not yet received from signaling server');
    return;
  }
  if (dataChannel === null || !dataChannel.isOpen) {
    showError('[DEV] data channel is not open');
    return;
  }

  const chunkId = nextChunkId;

  try {
    // Mint a P2PK-locked token; 2 sat covers the 1 sat value + swap fee
    const proofs = await mintP2PKToken(2, tutorPubkey);

    const encodedToken = getEncodedToken({
      mint: mintUrl,
      proofs,
      unit: 'sat',
    });

    dataChannel.sendMessage({ type: 'token_payment', chunkId, encodedToken });
    nextChunkId += 1;
    console.log(`[payment] sent chunk #${chunkId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`[DEV] payment failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

client.onConnect(() => {
  hideReconnectOverlay();
  if (sessionId === null) {
    showError('No session ID found in URL. Add ?session=<id> to the URL.');
    setStatus('error -- no session ID');
    return;
  }

  setStatus('connected -- joining session\u2026');
  client.send({ type: 'join_session', sessionId });

  // Persist session state for reconnect recovery
  client.setSessionId(sessionId);

  // Load existing session or create a fresh one.
  const walletBalance = getBalance();
  if (walletBalance === 0) {
    alert(
      'Your wallet is empty. Please fund your wallet with Cashu tokens before joining a session.'
    );
  }

  const existing = loadSession();
  saveSession({
    sessionId,
    peerId: existing?.peerId ?? '',
    role: 'viewer',
    chunkCount: existing?.chunkCount ?? 0,
    totalSatsPaid: existing?.totalSatsPaid ?? 0,
    budgetRemaining: existing?.budgetRemaining ?? walletBalance,
  });

  // Start media in parallel with session join
  void startMedia();
});

client.onDisconnecting(() => {
  showReconnectOverlay();
  setStatus('reconnecting\u2026');
  // Pause the scheduler while the signaling connection is down.
  scheduler?.stop();
});

client.onDisconnect(() => {
  setStatus('disconnected');
  scheduler?.stop();
});

client.onReconnected(() => {
  hideReconnectOverlay();
  const saved = loadSession();
  if (saved !== null) {
    setStatus(`reconnected -- session ${saved.sessionId}`);
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

    if (tutorPubkey === null) {
      showError('[scheduler] tutorPubkey not available — cannot start payment scheduler');
      return;
    }

    // Load persisted state so the scheduler survives page reloads.
    const session = loadSession();
    const initialChunkId = session?.chunkCount ?? 0;
    const initialTotalSatsPaid = session?.totalSatsPaid ?? 0;
    const budgetSats = session?.budgetRemaining ?? getBalance();

    // Sync nextChunkId for the DEV manual payment button.
    nextChunkId = initialChunkId;

    // Show the session stats bar with the current budget
    totalSatsPaidDisplay = initialTotalSatsPaid;
    totalChunksPaidDisplay = initialChunkId;
    showSessionStats(budgetSats);
    hidePaymentPausedBanner();

    scheduler = new PaymentScheduler(
      dataChannel,
      mintP2PKToken,
      (proofs, url) =>
        getEncodedToken({ mint: url, proofs, unit: 'sat' }),
      {
        intervalSecs: activeIntervalSeconds,
        chunkSats: activeRateSatsPerInterval,
        budgetSats,
        tutorPubkey,
        mintUrl,
        initialChunkId,
        initialTotalSatsPaid,
        onStateChange: (state) => {
          updateSession({
            chunkCount: state.chunkId,
            totalSatsPaid: state.totalSatsPaid,
            budgetRemaining: state.budgetRemaining,
          });
        },
      },
    );

    scheduler.onBudgetExhausted(() => {
      showError('Budget exhausted \u2014 session ended');
      showSessionSummary();
      client.disconnect();
    });

    scheduler.onPaymentFailure((reason) => {
      showError(`Payment failed \u2014 session paused: ${reason}`);
      showPaymentPausedBanner();
    });

    scheduler.onChunkPaid((chunkId, totalPaid, budgetRemaining) => {
      console.log(
        `[scheduler] chunk #${chunkId} paid — total: ${totalPaid} sats, remaining: ${budgetRemaining} sats`,
      );
      totalSatsPaidDisplay = totalPaid;
      totalChunksPaidDisplay = chunkId + 1;
      updateBudgetDisplay(budgetRemaining);
      triggerChunkPulse();
      hidePaymentPausedBanner();
    });

    scheduler.start();
  };

  rawChannel.onclose = () => {
    console.log('[datachannel] closed');
    setDcStatus('closed');
    scheduler?.stop();
    scheduler = null;
  };
};

// ---------------------------------------------------------------------------
// Remote track -> remote video
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
    case 'session_created':
      // Viewer receives session_created after joining; verify mint then extract tutorPubkey.
      try {
        assertSameMint(msg.mintUrl);
      } catch (err) {
        if (err instanceof MintMismatchError) {
          showMintMismatch(err.sessionMintUrl, err.localMintUrl);
          console.error('[viewer] mint mismatch — aborting session setup');
          return;
        }
        throw err;
      }
      tutorPubkey = msg.tutorPubkey;
      console.log('[viewer] tutorPubkey received:', tutorPubkey);
      // Signaling message is authoritative — override invite-derived rate if present
      if (typeof msg.rateSatsPerInterval === 'number') {
        activeRateSatsPerInterval = msg.rateSatsPerInterval;
      }
      if (typeof msg.intervalSeconds === 'number') {
        activeIntervalSeconds = msg.intervalSeconds;
      }
      console.log('[viewer] rate config:', activeRateSatsPerInterval, 'sats /', activeIntervalSeconds, 's');
      break;

    case 'viewer_joined':
      // viewer_joined also carries tutorPubkey (belt-and-suspenders).
      tutorPubkey = msg.tutorPubkey;
      console.log('[viewer] tutorPubkey from viewer_joined:', tutorPubkey);
      break;

    case 'offer':
      void handleOffer(msg.sdp as RTCSessionDescriptionInit);
      break;

    case 'ice_candidate':
      void peer.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      break;

    case 'error':
      showError(`Signaling error: ${msg.code}${msg.message !== undefined ? ' -- ' + msg.message : ''}`);
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
    setStatus('offer received -- waiting for local media\u2026');
    await waitForLocalStream();
  }

  if (localStream === null) {
    showError('Local media stream unavailable -- cannot answer offer');
    return;
  }

  setStatus('offer received -- creating answer\u2026');

  try {
    const answer = await peer.handleOffer(offer, localStream);
    client.send({ type: 'answer', sessionId, sdp: answer });
    setStatus('answer sent -- waiting for ICE\u2026');
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
