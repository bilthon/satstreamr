import { getEncodedToken } from '@cashu/cashu-ts';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { preSplitProofs } from '../lib/cashu-wallet.js';
import { PaymentScheduler } from '../lib/payment-scheduler.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession, updateSession, clearSession } from '../lib/session-storage.js';
import { assertSameMint, MintMismatchError } from '../lib/mint-guard.js';
import { getBalance, onBalanceChange, spendProofs } from '../lib/wallet-store.js';
import { getMintUrl } from '../lib/config.js';
import { getSignalingUrl } from '../lib/signaling-url.js';
import { createSessionUI } from '../lib/session-ui.js';
import { startMedia as sharedStartMedia } from '../lib/media.js';
import { createSessionSummary } from '../lib/session-summary.js';
import { wireSharedPeerHandlers, recreatePeer } from '../lib/peer-setup.js';
import { showToast } from '../lib/toast.js';

const signalingUrl = getSignalingUrl();
const mintUrl = getMintUrl();

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const ui = createSessionUI('viewer');

// Hide tutor-only elements that are visible by default in room.html
const rateConfigEl = document.getElementById('rate-config');
if (rateConfigEl !== null) rateConfigEl.style.display = 'none';

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

// Budget low warning
const budgetLowBannerEl = document.getElementById('budget-low-banner');
const budgetLowTextEl = document.getElementById('budget-low-text');
const countdownDisplayEl = document.getElementById('countdown-display');

// Join confirmation overlay
const joinConfirmOverlayEl = document.getElementById('join-confirm-overlay');
const joinConfirmRateEl = document.getElementById('join-confirm-rate');
const joinConfirmRatePerMinEl = document.getElementById('join-confirm-rate-per-min');
const joinConfirmBalanceEl = document.getElementById('join-confirm-balance');
const joinConfirmDurationEl = document.getElementById('join-confirm-duration');
const joinConfirmMintEl = document.getElementById('join-confirm-mint');
const joinConfirmAcceptBtn = document.getElementById('join-confirm-accept') as HTMLButtonElement | null;
const joinConfirmCancelBtn = document.getElementById('join-confirm-cancel') as HTMLButtonElement | null;

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

// ---------------------------------------------------------------------------
// Low-funds warning & countdown
// ---------------------------------------------------------------------------

/** Seconds of remaining session time at which the warning phase begins. */
const LOW_FUNDS_WARNING_SECS = 60;
/** Seconds at which the animated countdown begins. */
const FINAL_COUNTDOWN_SECS = 10;

type LowFundsPhase = 'normal' | 'warning' | 'countdown';
let lowFundsPhase: LowFundsPhase = 'normal';
let countdownTimerId: ReturnType<typeof setInterval> | null = null;

/** Estimate remaining seconds based on current balance and active rate. */
function getRemainingSeconds(balanceSats: number): number {
  if (activeRateSatsPerInterval <= 0 || activeIntervalSeconds <= 0) return Infinity;
  const chunks = Math.floor(balanceSats / activeRateSatsPerInterval);
  return chunks * activeIntervalSeconds;
}

/** Transition into a low-funds phase, updating DOM classes and content. */
function enterPhase(phase: LowFundsPhase, remainingSecs?: number): void {
  if (phase === lowFundsPhase && phase !== 'countdown') return;
  lowFundsPhase = phase;

  if (budgetLowBannerEl === null) return;

  // Reset classes
  budgetLowBannerEl.classList.remove('warning-phase', 'countdown-phase');
  budgetDisplayEl?.classList.remove('warning', 'countdown');

  if (countdownDisplayEl !== null) countdownDisplayEl.textContent = '';

  switch (phase) {
    case 'normal':
      // Hide the banner entirely
      stopCountdownTimer();
      break;

    case 'warning':
      budgetLowBannerEl.classList.add('warning-phase');
      budgetDisplayEl?.classList.add('warning');
      if (budgetLowTextEl !== null) budgetLowTextEl.textContent = 'Low balance \u2014 session will end soon';
      stopCountdownTimer();
      break;

    case 'countdown':
      budgetLowBannerEl.classList.add('countdown-phase');
      budgetDisplayEl?.classList.add('countdown');
      if (budgetLowTextEl !== null) budgetLowTextEl.textContent = 'Ending in';
      startCountdownTimer(remainingSecs ?? FINAL_COUNTDOWN_SECS);
      break;
  }
}

/** Evaluate the current balance and enter the correct phase. */
function updateLowFundsState(balanceSats: number): void {
  const remaining = getRemainingSeconds(balanceSats);

  if (remaining <= FINAL_COUNTDOWN_SECS) {
    enterPhase('countdown', remaining);
  } else if (remaining <= LOW_FUNDS_WARNING_SECS) {
    enterPhase('warning');
  } else {
    enterPhase('normal');
  }
}

function startCountdownTimer(startSecs: number): void {
  stopCountdownTimer();
  let secs = startSecs;
  renderCountdownDigit(secs);

  countdownTimerId = setInterval(() => {
    secs -= 1;
    if (secs <= 0) {
      stopCountdownTimer();
      renderCountdownDigit(0);
      return;
    }
    renderCountdownDigit(secs);
  }, 1000);
}

function stopCountdownTimer(): void {
  if (countdownTimerId !== null) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
}

function renderCountdownDigit(secs: number): void {
  if (countdownDisplayEl === null) return;
  const text = String(secs);
  countdownDisplayEl.innerHTML = `<span class="count-digit">${text}</span>s`;
}

const sessionSummary = createSessionSummary({
  statsElId: 'viewer-stats',
  get sessionId() { return sessionId ?? undefined; },
  role: 'viewer',
});

/** Show the session stats bar and record start time. */
function showSessionStats(initialBudget: number): void {
  sessionSummary.showSessionStats(initialBudget);
  updateBudgetDisplay(initialBudget);
}

/** Update the remaining budget display and low-funds warning state. */
function updateBudgetDisplay(budgetSats: number): void {
  if (budgetDisplayEl !== null) {
    budgetDisplayEl.innerHTML = `${budgetSats} <span class="sat">S</span>`;
  }
  updateLowFundsState(budgetSats);
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
  stopCountdownTimer();
  enterPhase('normal');
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
let invitedRate: number | null = null;
let invitedInterval: number | null = null;
let invitedMintUrl: string | null = null;

try {
  const pendingJoinRaw = sessionStorage.getItem('pending_join');
  if (pendingJoinRaw !== null) {
    const pendingJoin = JSON.parse(pendingJoinRaw) as Record<string, unknown>;
    if (typeof pendingJoin['rateSatsPerInterval'] === 'number') {
      activeRateSatsPerInterval = pendingJoin['rateSatsPerInterval'] as number;
      invitedRate = activeRateSatsPerInterval;
    }
    if (typeof pendingJoin['intervalSeconds'] === 'number') {
      activeIntervalSeconds = pendingJoin['intervalSeconds'] as number;
      invitedInterval = activeIntervalSeconds;
    }
    if (typeof pendingJoin['mintUrl'] === 'string') {
      invitedMintUrl = pendingJoin['mintUrl'] as string;
    }
  }
} catch {
  // sessionStorage read/parse failures are non-fatal
}

// ---------------------------------------------------------------------------
// Join confirmation gate
//
// The viewer must explicitly accept the streamer's rate before any session
// setup happens (camera/mic prompt, pre-split, offer/answer, scheduler). The
// dialog is shown as soon as rate info is known — either from the invite
// (pending_join) on page load, or from the first session_created signaling
// message for a manual join.
// ---------------------------------------------------------------------------

let joinConfirmShown = false;
let joinDecisionResolve: ((accepted: boolean) => void) | null = null;
const joinDecisionPromise = new Promise<boolean>((resolve) => {
  joinDecisionResolve = resolve;
});

function populateJoinConfirm(rate: number, interval: number, dialogMintUrl: string | null): void {
  if (joinConfirmRateEl !== null) {
    joinConfirmRateEl.innerHTML =
      `<strong>${rate}</strong> <span class="sat">S</span> every <strong>${interval}</strong>s`;
  }
  if (joinConfirmRatePerMinEl !== null) {
    if (interval > 0) {
      const perMin = (rate * 60) / interval;
      const formatted = Number.isInteger(perMin) ? String(perMin) : perMin.toFixed(1);
      joinConfirmRatePerMinEl.innerHTML = `= ${formatted} <span class="sat">S</span>/min`;
    } else {
      joinConfirmRatePerMinEl.textContent = '';
    }
  }
  const balance = getBalance();
  if (joinConfirmBalanceEl !== null) {
    joinConfirmBalanceEl.innerHTML = `${balance.toLocaleString()} <span class="sat">S</span>`;
  }
  if (joinConfirmDurationEl !== null) {
    if (rate > 0 && interval > 0 && balance > 0) {
      const totalSeconds = Math.floor(balance / rate) * interval;
      if (totalSeconds >= 60) {
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        joinConfirmDurationEl.textContent =
          secs > 0 ? `~${mins} min ${secs}s` : `~${mins} min`;
      } else {
        joinConfirmDurationEl.textContent = `~${totalSeconds}s`;
      }
    } else if (balance === 0) {
      joinConfirmDurationEl.innerHTML = '<span class="warn">0 — deposit first</span>';
    } else {
      joinConfirmDurationEl.textContent = '—';
    }
  }
  if (joinConfirmMintEl !== null) {
    joinConfirmMintEl.textContent = dialogMintUrl ?? mintUrl;
  }
}

function showJoinConfirm(rate: number, interval: number, dialogMintUrl: string | null): void {
  if (joinConfirmShown) return;
  joinConfirmShown = true;
  populateJoinConfirm(rate, interval, dialogMintUrl);
  if (joinConfirmOverlayEl !== null) {
    joinConfirmOverlayEl.classList.remove('hidden');
  }
  joinConfirmAcceptBtn?.focus();
}

function hideJoinConfirm(): void {
  if (joinConfirmOverlayEl !== null) {
    joinConfirmOverlayEl.classList.add('hidden');
  }
}

function resolveJoinDecision(accepted: boolean): void {
  const resolve = joinDecisionResolve;
  joinDecisionResolve = null;
  if (resolve !== null) resolve(accepted);
}

if (joinConfirmAcceptBtn !== null) {
  joinConfirmAcceptBtn.addEventListener('click', () => {
    hideJoinConfirm();
    resolveJoinDecision(true);
  });
}

if (joinConfirmCancelBtn !== null) {
  joinConfirmCancelBtn.addEventListener('click', () => {
    hideJoinConfirm();
    resolveJoinDecision(false);
  });
}

// If the invite carried rate info, show the dialog before opening the
// signaling socket so the viewer sees the cost before any session setup.
if (invitedRate !== null && invitedInterval !== null) {
  showJoinConfirm(invitedRate, invitedInterval, invitedMintUrl);
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

  ui.setStatus(
    joinConfirmShown
      ? 'connected -- awaiting your confirmation\u2026'
      : 'connected -- loading session info\u2026',
  );
  client.send({ type: 'join_session', sessionId });

  // Persist session state for reconnect recovery
  client.setSessionId(sessionId);

  // Load existing session or create a fresh one.
  const walletBalance = getBalance();
  if (walletBalance === 0) {
    showToast(
      'Your wallet is empty. Fund your wallet before joining a session.',
      { variant: 'warning', duration: 8000 },
    );
  }

  // All further setup (media prompt, session persistence) is gated on the
  // viewer accepting the rate in the confirmation dialog.
  void joinDecisionPromise.then((accepted) => {
    if (!accepted) {
      handleCancelledJoin();
      return;
    }

    // Persist session state only after acceptance so a cancelled join does
    // not leave a phantom entry in localStorage.
    const existing = loadSession();
    const isSameSession = existing !== null && existing.sessionId === sessionId;
    saveSession({
      sessionId,
      peerId: isSameSession ? (existing.peerId ?? '') : '',
      role: 'viewer',
      chunkCount: isSameSession ? (existing.chunkCount ?? 0) : 0,
      totalSatsPaid: isSameSession ? (existing.totalSatsPaid ?? 0) : 0,
    });

    ui.setStatus('joining session…');
    void sharedStartMedia(peer, localVideoEl, ui.showError).then((stream) => {
      localStream = stream;
      if (stream !== null) {
        console.log('[viewer] local media ready');
      }
    });
  });
});

function handleCancelledJoin(): void {
  console.log('[viewer] user cancelled join — tearing down');
  ui.setStatus('cancelled');
  scheduler?.stop();
  if (sessionId !== null) {
    // Safe even if the socket is not open — sendRaw guards against that.
    client.send({ type: 'end_session', sessionId });
  }
  client.disconnect();
  clearSession();
  try {
    sessionStorage.removeItem('pending_join');
  } catch {
    // sessionStorage may be unavailable — non-fatal
  }
  window.location.href = '/';
}

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
        stopCountdownTimer();
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

      // Manual-entry flow: no invite data on page load, so the confirmation
      // dialog could not be shown yet. Show it now with the authoritative
      // rate from the signaling server.
      if (!joinConfirmShown) {
        showJoinConfirm(activeRateSatsPerInterval, activeIntervalSeconds, msg.mintUrl);
      }

      // Pre-split is gated on the viewer accepting the rate. If they cancel,
      // the `onConnect` handler tears down the session — we just no-op here.
      void joinDecisionPromise.then((accepted) => {
        if (!accepted) return;
        // Pre-split proofs into exact-denomination chunks before the session starts.
        ui.setStatus('preparing wallet\u2026');
        void preSplitProofs(activeRateSatsPerInterval, getBalance()).then((numChunks) => {
          console.log(`[viewer] pre-split complete: ${numChunks} chunks of ${activeRateSatsPerInterval} sats`);
          ui.setStatus('wallet ready — waiting for tutor\u2026');
        }).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          ui.showError(`Pre-split failed: ${reason}`);
        });
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

  // Do not answer the offer until the viewer has accepted the rate. A
  // cancelled join short-circuits the rest of the handshake here.
  const accepted = await joinDecisionPromise;
  if (!accepted) {
    console.log('[viewer] offer ignored — viewer cancelled join');
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

  stopCountdownTimer();
  lowFundsPhase = 'normal';
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
