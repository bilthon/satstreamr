import { getEncodedToken } from '@cashu/cashu-ts';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { preSplitProofs } from '../lib/cashu-wallet.js';
import { PaymentScheduler } from '../lib/payment-scheduler.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession, updateSession } from '../lib/session-storage.js';
import { assertSameMint, MintMismatchError } from '../lib/mint-guard.js';
import { getBalance, onBalanceChange, spendProofs } from '../lib/wallet-store.js';
import { getMintUrl } from '../lib/config.js';
import { getSignalingUrl } from '../lib/signaling-url.js';
import { createSessionUI } from '../lib/session-ui.js';
import { startMedia as sharedStartMedia } from '../lib/media.js';
import { createSessionSummary } from '../lib/session-summary.js';
import { wireSharedPeerHandlers, recreatePeer } from '../lib/peer-setup.js';

const signalingUrl = getSignalingUrl();
const mintUrl = getMintUrl();

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const ui = createSessionUI('viewer');

const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;
const remoteVideoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
const sessionDisplayEl = document.getElementById('session-display');

// Session UI elements
const budgetDisplayEl = document.getElementById('budget-display');
const estDurationDisplayEl = document.getElementById('est-duration-display');
const chunkIndicatorEl = document.getElementById('chunk-indicator');

// Mint mismatch overlay
const mintMismatchOverlayEl = document.getElementById('mint-mismatch-overlay');
const sessionMintUrlEl = document.getElementById('session-mint-url');
const localMintUrlEl = document.getElementById('local-mint-url');

// Exit session button
const exitSessionBtnEl = document.getElementById('exit-session-btn') as HTMLButtonElement | null;

function showMintMismatch(sessionMint: string, localMint: string): void {
  if (sessionMintUrlEl !== null) sessionMintUrlEl.textContent = sessionMint;
  if (localMintUrlEl !== null) localMintUrlEl.textContent = localMint;
  if (mintMismatchOverlayEl !== null) {
    mintMismatchOverlayEl.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Session UI state
// ---------------------------------------------------------------------------

let totalSatsPaidDisplay = 0;
let totalChunksPaidDisplay = 0;

const sessionSummary = createSessionSummary({ statsElId: 'viewer-stats' });

/** Show the session stats bar and record start time. */
function showSessionStats(initialBudget: number): void {
  sessionSummary.showSessionStats(initialBudget);
  updateBudgetDisplay(initialBudget);
}

/** Update the remaining budget display. */
function updateBudgetDisplay(budgetSats: number): void {
  if (budgetDisplayEl !== null) {
    budgetDisplayEl.innerHTML = `${budgetSats} <span class="sat">S</span>`;
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

/** Show the session-end summary overlay. */
function showSessionSummary(): void {
  sessionSummary.showSessionSummary(totalSatsPaidDisplay, totalChunksPaidDisplay);
}

/** Shared cleanup for session end (local exit or remote session_ended). */
function endSession(): void {
  scheduler?.stop();
  peer.close();
  if (localStream !== null) {
    localStream.getTracks().forEach(t => t.stop());
  }
  if (exitSessionBtnEl !== null) exitSessionBtnEl.style.display = 'none';
  showSessionSummary();
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
let peer = new PeerConnection();

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

// "Leave Session" button handler
if (exitSessionBtnEl !== null) {
  exitSessionBtnEl.addEventListener('click', () => {
    if (sessionId !== null) {
      client.send({ type: 'end_session', sessionId });
    }
    endSession();
  });
}

client.onConnect(() => {
  ui.hideReconnectOverlay();
  if (sessionId === null) {
    ui.showError('No session ID found in URL. Add ?session=<id> to the URL.');
    ui.setStatus('error -- no session ID');
    return;
  }

  ui.setStatus('connected -- joining session\u2026');
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
  const isSameSession = existing !== null && existing.sessionId === sessionId;
  saveSession({
    sessionId,
    peerId: isSameSession ? (existing.peerId ?? '') : '',
    role: 'viewer',
    chunkCount: isSameSession ? (existing.chunkCount ?? 0) : 0,
    totalSatsPaid: isSameSession ? (existing.totalSatsPaid ?? 0) : 0,
  });

  // Start media in parallel with session join
  void sharedStartMedia(peer, localVideoEl, ui.showError).then((stream) => {
    localStream = stream;
    if (stream !== null) {
      console.log('[viewer] local media ready');
    }
  });
});

client.onDisconnecting(() => {
  ui.showReconnectOverlay();
  ui.setStatus('reconnecting\u2026');
  // Pause the scheduler while the signaling connection is down.
  scheduler?.stop();
});

client.onDisconnect(() => {
  ui.setStatus('disconnected');
  scheduler?.stop();
});

client.onReconnected(() => {
  ui.hideReconnectOverlay();
  const saved = loadSession();
  if (saved !== null) {
    ui.setStatus(`reconnected -- session ${saved.sessionId}`);
    if (sessionDisplayEl !== null) {
      sessionDisplayEl.textContent = `Session: ${saved.sessionId}`;
    }
  } else {
    ui.setStatus('reconnected');
  }
});

// ---------------------------------------------------------------------------
// Peer handler setup (extracted so it can be re-applied after renegotiation)
// ---------------------------------------------------------------------------

function setupPeerHandlers(): void {
  wireSharedPeerHandlers(peer, () => sessionId, client, ui.setStatus, remoteVideoEl);

  // Data channel
  peer.onDataChannel = (event) => {
    const rawChannel = event.channel;

    // Holds the unsubscribe function for the balance listener; set in onopen,
    // called in onclose so the subscription does not outlive the channel.
    let unsubscribeBalance: (() => void) | null = null;

    // ondatachannel fires when the channel is received but it may still be
    // in 'connecting' state. Wait for 'open' before marking ready.
    rawChannel.onopen = () => {
      dataChannel = new DataChannel(rawChannel);
      console.log('[datachannel] open');
      ui.setDcStatus('open');

      // Load persisted state so the scheduler survives page reloads.
      const session = loadSession();
      const initialChunkId = session?.chunkCount ?? 0;
      const initialTotalSatsPaid = session?.totalSatsPaid ?? 0;

      // Show the session stats bar with the current wallet balance.
      totalSatsPaidDisplay = initialTotalSatsPaid;
      totalChunksPaidDisplay = initialChunkId;
      showSessionStats(getBalance());
      sessionSummary.hidePaymentPausedBanner();

      // Subscribe to wallet balance changes for reactive budget display.
      unsubscribeBalance = onBalanceChange((balance) => {
        updateBudgetDisplay(balance);
      });

      scheduler = new PaymentScheduler(
        dataChannel,
        spendProofs,
        (proofs, url) =>
          getEncodedToken({ mint: url, proofs, unit: 'sat' }),
        {
          intervalSecs: activeIntervalSeconds,
          chunkSats: activeRateSatsPerInterval,
          mintUrl,
          initialChunkId,
          initialTotalSatsPaid,
          onStateChange: (state) => {
            updateSession({
              chunkCount: state.chunkId,
              totalSatsPaid: state.totalSatsPaid,
            });
          },
        },
      );

      scheduler.onBudgetExhausted(() => {
        ui.showError('Budget exhausted \u2014 session ended');
        scheduler?.stop();
        peer.close();
        if (localStream !== null) {
          localStream.getTracks().forEach(t => t.stop());
        }
        showSessionSummary();
        client.disconnect();
      });

      scheduler.onPaymentFailure((reason) => {
        ui.showError(`Payment failed \u2014 session paused: ${reason}`);
        sessionSummary.showPaymentPausedBanner();
      });

      scheduler.onChunkPaid((chunkId, totalPaid, balance) => {
        console.log(
          `[scheduler] chunk #${chunkId} paid — total: ${totalPaid} sats, balance: ${balance} sats`,
        );
        totalSatsPaidDisplay = totalPaid;
        totalChunksPaidDisplay = chunkId + 1;
        // Balance display is updated reactively via onBalanceChange subscription;
        // call updateBudgetDisplay here as a synchronous fallback.
        updateBudgetDisplay(balance);
        triggerChunkPulse();
        sessionSummary.hidePaymentPausedBanner();
      });

      scheduler.start();
    };

    rawChannel.onclose = () => {
      console.log('[datachannel] closed');
      ui.setDcStatus('closed');
      if (unsubscribeBalance !== null) {
        unsubscribeBalance();
        unsubscribeBalance = null;
      }
      scheduler?.stop();
      scheduler = null;
    };
  };
}

setupPeerHandlers();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

client.onMessage((msg: SignalingMessage) => {
  switch (msg.type) {
    case 'session_created':
      // Viewer receives session_created after joining; verify mint and pre-split proofs.
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
      // Signaling message is authoritative — override invite-derived rate if present
      if (typeof msg.rateSatsPerInterval === 'number') {
        activeRateSatsPerInterval = msg.rateSatsPerInterval;
      }
      if (typeof msg.intervalSeconds === 'number') {
        activeIntervalSeconds = msg.intervalSeconds;
      }
      console.log('[viewer] rate config:', activeRateSatsPerInterval, 'sats /', activeIntervalSeconds, 's');
      // Pre-split proofs into exact-denomination chunks before the session starts.
      ui.setStatus('preparing wallet\u2026');
      void preSplitProofs(activeRateSatsPerInterval, getBalance()).then((numChunks) => {
        console.log(`[viewer] pre-split complete: ${numChunks} chunks of ${activeRateSatsPerInterval} sats`);
        ui.setStatus('wallet ready — waiting for tutor\u2026');
      }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        ui.showError(`Pre-split failed: ${reason}`);
      });
      break;

    case 'viewer_joined':
      // No tutorPubkey needed in the plain-token architecture.
      break;

    case 'offer':
      void handleOffer(msg.sdp as RTCSessionDescriptionInit);
      break;

    case 'ice_candidate':
      void peer.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      break;

    case 'error':
      ui.showError(`Signaling error: ${msg.code}${msg.message !== undefined ? ' -- ' + msg.message : ''}`);
      break;

    case 'session_ended':
      endSession();
      break;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
  if (sessionId === null) {
    ui.showError('Offer received but no sessionId');
    return;
  }

  // Wait for local media if not yet available
  if (localStream === null) {
    ui.setStatus('offer received -- waiting for local media\u2026');
    await waitForLocalStream();
  }

  if (localStream === null) {
    ui.showError('Local media stream unavailable -- cannot answer offer');
    return;
  }

  ui.setStatus('offer received -- creating answer\u2026');

  // Recreate peer connection for renegotiation (tutor may have reconnected).
  peer = recreatePeer(peer);
  setupPeerHandlers();

  scheduler?.stop();
  scheduler = null;
  dataChannel = null;

  try {
    const answer = await peer.handleOffer(offer, localStream);
    client.send({ type: 'answer', sessionId, sdp: answer });
    ui.setStatus('answer sent -- waiting for ICE\u2026');
    if (exitSessionBtnEl !== null) exitSessionBtnEl.style.display = 'inline-block';
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ui.showError(`Failed to handle offer: ${message}`);
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
