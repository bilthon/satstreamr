import { getDecodedToken } from '@cashu/cashu-ts';
import type { Proof } from '../types/cashu.js';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { buildWallet, checkTokenState, claimProofs, getMeltQuote, meltTokens } from '../lib/cashu-wallet.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession, clearSession } from '../lib/session-storage.js';
import { getProofs, addProofs } from '../lib/wallet-store.js';
import { createInviteUrl } from '../lib/session-invite.js';
import { getMintUrl } from '../lib/config.js';
import { getSignalingUrl } from '../lib/signaling-url.js';
import { createSessionUI } from '../lib/session-ui.js';
import { startMedia as sharedStartMedia } from '../lib/media.js';
import { createSessionSummary } from '../lib/session-summary.js';
import { wireSharedPeerHandlers, recreatePeer } from '../lib/peer-setup.js';

const signalingUrl = getSignalingUrl();

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const ui = createSessionUI('tutor');

const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;

// Rate configuration UI elements
const rateConfigEl = document.getElementById('rate-config');
const rateSatsInputEl = document.getElementById('rate-sats-input') as HTMLInputElement | null;
const rateIntervalInputEl = document.getElementById('rate-interval-input') as HTMLInputElement | null;
const effectiveRateDisplayEl = document.getElementById('effective-rate-display');
const feeOverheadDisplayEl = document.getElementById('fee-overhead-display');
const feeInfoBtnEl = document.getElementById('fee-info-btn') as HTMLButtonElement | null;
const feeInfoPanelEl = document.getElementById('fee-info-panel');
const startSessionBtnEl = document.getElementById('start-session-btn') as HTMLButtonElement | null;

// Session UI elements
const elapsedTimeEl = document.getElementById('elapsed-time');
const satsReceivedEl = document.getElementById('sats-received');

// Invite display elements
const inviteSectionEl = document.getElementById('invite-section');
const inviteSessionIdEl = document.getElementById('invite-session-id');
const inviteUrlEl = document.getElementById('invite-url');
const copyInviteBtnEl = document.getElementById('copy-invite-btn') as HTMLButtonElement | null;

// Exit session button
const exitSessionBtnEl = document.getElementById('exit-session-btn') as HTMLButtonElement | null;

// Go Live ceremony overlay
const goLiveOverlayEl = document.getElementById('go-live-overlay');
const goLiveCountEl = document.getElementById('go-live-count');
const goLiveLabelEl = document.getElementById('go-live-label');

// Cash-out UI elements
const invoiceInputEl = document.getElementById('invoice-input') as HTMLInputElement | null;
const invoiceCountdownEl = document.getElementById('invoice-countdown');
const payInvoiceBtnEl = document.getElementById('pay-invoice-btn') as HTMLButtonElement | null;
const cashoutStatusEl = document.getElementById('cashout-status');

// ---------------------------------------------------------------------------
// Session UI state
// ---------------------------------------------------------------------------

let elapsedTimerHandle: ReturnType<typeof setInterval> | null = null;
let totalSatsReceived = 0;
let totalChunksReceived = 0;
let invoiceCountdownHandle: ReturnType<typeof setInterval> | null = null;

const sessionSummary = createSessionSummary({
  onBeforeSummary: () => { stopElapsedTimer(); },
  onAfterSummary: () => { wireCashOut(); },
  statsElId: 'tutor-stats',
});

/** Start the elapsed timer. Called when the data channel opens. */
function startElapsedTimer(): void {
  if (elapsedTimerHandle !== null) return;
  sessionSummary.startSessionTimer();
  elapsedTimerHandle = setInterval(() => {
    const elapsed = sessionSummary.getElapsedSeconds();
    if (elapsedTimeEl !== null) {
      elapsedTimeEl.textContent = sessionSummary.formatElapsed(elapsed);
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

/** Update the sats-received counter. */
function updateSatsReceived(delta: number): void {
  totalSatsReceived += delta;
  totalChunksReceived += 1;
  if (satsReceivedEl !== null) {
    satsReceivedEl.textContent = String(totalSatsReceived);
  }
  showPaymentFloat(delta);
  highlightSatsReceived();
}

/** Spawn a floating "+N S" badge that animates upward from the counter. */
function showPaymentFloat(amount: number): void {
  if (satsReceivedEl === null) return;
  const float = document.createElement('span');
  float.className = 'payment-float';
  float.innerHTML = `+${amount} <span class="sat">S</span>`;
  satsReceivedEl.appendChild(float);
  setTimeout(() => float.remove(), 750);
}

/** Flash the sats-received counter with a brief amber highlight. */
function highlightSatsReceived(): void {
  if (satsReceivedEl === null) return;
  satsReceivedEl.classList.remove('payment-highlight');
  void satsReceivedEl.offsetWidth; // force reflow to restart animation
  satsReceivedEl.classList.add('payment-highlight');
}

/**
 * Play the "3… 2… 1… GO LIVE" countdown ceremony.
 * Returns a promise that resolves when the ceremony finishes.
 */
function playGoLiveCeremony(): Promise<void> {
  return new Promise((resolve) => {
    if (goLiveOverlayEl === null || goLiveCountEl === null || goLiveLabelEl === null) {
      resolve();
      return;
    }

    goLiveOverlayEl.classList.add('visible');
    goLiveLabelEl.classList.remove('visible');

    const steps = [3, 2, 1];
    let i = 0;

    function showNext(): void {
      if (i < steps.length) {
        goLiveCountEl!.innerHTML = `<span class="count-digit">${steps[i]}</span>`;
        i++;
        setTimeout(showNext, 700);
      } else {
        // Clear the number and show "GO LIVE"
        goLiveCountEl!.textContent = '';
        goLiveLabelEl!.classList.add('visible');

        // Fade out after a beat
        setTimeout(() => {
          goLiveOverlayEl!.classList.add('fade-out');
          goLiveOverlayEl!.addEventListener('animationend', () => {
            goLiveOverlayEl!.classList.remove('visible', 'fade-out');
            resolve();
          }, { once: true });
          // Fallback in case animationend doesn't fire
          setTimeout(() => {
            goLiveOverlayEl!.classList.remove('visible', 'fade-out');
            resolve();
          }, 500);
        }, 800);
      }
    }

    showNext();
  });
}

/** Clear the invoice countdown timer. */
function clearInvoiceCountdown(): void {
  if (invoiceCountdownHandle !== null) {
    clearInterval(invoiceCountdownHandle);
    invoiceCountdownHandle = null;
  }
  if (invoiceCountdownEl !== null) {
    invoiceCountdownEl.textContent = '';
    invoiceCountdownEl.style.color = '';
  }
}

/** Start a 600s countdown displayed in #invoice-countdown. */
function startInvoiceCountdown(): void {
  clearInvoiceCountdown();
  let remaining = 600;
  const update = (): void => {
    if (invoiceCountdownEl === null) return;
    invoiceCountdownEl.textContent = `${String(remaining)}s`;
    invoiceCountdownEl.style.color = remaining <= 60 ? '#dc2626' : '';
  };
  update();
  invoiceCountdownHandle = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInvoiceCountdown();
      if (invoiceCountdownEl !== null) {
        invoiceCountdownEl.textContent = 'expired';
        invoiceCountdownEl.style.color = '#dc2626';
      }
    } else {
      update();
    }
  }, 1000);
}

/** Show the session-end summary overlay. */
function showSessionSummary(): void {
  sessionSummary.showSessionSummary(totalSatsReceived, totalChunksReceived);
}

/** Shared cleanup for session end (local exit or remote session_ended). */
function endSession(): void {
  peer.close();
  if (localStream !== null) {
    localStream.getTracks().forEach(t => t.stop());
  }
  if (exitSessionBtnEl !== null) exitSessionBtnEl.style.display = 'none';
  showSessionSummary();
}

/** Display a message in #cashout-status, optionally styled as an error. */
function setCashoutStatus(text: string, isError = false, html = false): void {
  if (cashoutStatusEl === null) return;
  if (html) {
    cashoutStatusEl.innerHTML = text;
  } else {
    cashoutStatusEl.textContent = text;
  }
  cashoutStatusEl.style.color = isError ? '#dc2626' : '';
}

/** Determine valid invoice prefix based on environment. */
function validInvoicePrefix(): string {
  return import.meta.env.DEV ? 'lnbcrt' : 'lnbc';
}

/** Wire up invoice input and pay button in the session summary overlay. */
function wireCashOut(): void {
  if (invoiceInputEl === null || payInvoiceBtnEl === null) return;

  // Load accumulated proofs from the persistent wallet store
  const accumulatedProofs: Proof[] = getProofs();

  // Invoice input: validate prefix and start countdown on paste/input
  invoiceInputEl.addEventListener('input', () => {
    clearInvoiceCountdown();
    setCashoutStatus('');
    const value = invoiceInputEl.value.trim();
    if (value.length === 0) return;

    const prefix = validInvoicePrefix();
    if (!value.toLowerCase().startsWith(prefix)) {
      setCashoutStatus(
        `Invalid invoice — expected a ${import.meta.env.DEV ? 'regtest' : 'mainnet'} invoice (${prefix}\u2026)`,
        true
      );
      return;
    }

    startInvoiceCountdown();
  });

  // Pay button click handler
  payInvoiceBtnEl.addEventListener('click', () => {
    void handlePayInvoice(accumulatedProofs);
  });
}

async function handlePayInvoice(proofs: Proof[]): Promise<void> {
  if (invoiceInputEl === null || payInvoiceBtnEl === null) return;

  const invoice = invoiceInputEl.value.trim();
  if (invoice.length === 0) {
    setCashoutStatus('Please paste a Lightning invoice first.', true);
    return;
  }

  const prefix = validInvoicePrefix();
  if (!invoice.toLowerCase().startsWith(prefix)) {
    setCashoutStatus(
      `Invalid invoice — expected a ${import.meta.env.DEV ? 'regtest' : 'mainnet'} invoice (${prefix}\u2026)`,
      true
    );
    return;
  }

  if (proofs.length === 0) {
    setCashoutStatus('No accumulated proofs to pay with.', true);
    return;
  }

  payInvoiceBtnEl.disabled = true;
  setCashoutStatus('Fetching quote\u2026');

  let quoteId: string;
  let amount: number;
  let feeReserve: number;

  try {
    const quote = await getMeltQuote(invoice);
    quoteId = quote.quote;
    amount = quote.amount;
    feeReserve = quote.fee_reserve;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setCashoutStatus(msg, true);
    payInvoiceBtnEl.disabled = false;
    return;
  }

  setCashoutStatus(`Paying ${String(amount)} <span class="sat">S</span> + up to ${String(feeReserve)} <span class="sat">S</span> fee\u2026`, false, true);

  try {
    const result = await meltTokens(invoice, quoteId, proofs);
    if (result.paid) {
      clearInvoiceCountdown();
      const preimage = result.payment_preimage ?? '(none)';
      setCashoutStatus(`\u2713 Payment sent! Preimage: ${preimage}`);
      // Button stays disabled — payment is complete
    } else {
      setCashoutStatus('Payment not confirmed by mint. Please retry.', true);
      payInvoiceBtnEl.disabled = false;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setCashoutStatus(msg, true);
    payInvoiceBtnEl.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Rate configuration helpers
// ---------------------------------------------------------------------------

/** Read the current configured rate values from the UI inputs. */
function getRateConfig(): { rateSatsPerInterval: number; intervalSeconds: number } {
  const sats = Math.max(1, parseInt(rateSatsInputEl?.value ?? '2', 10) || 2);
  const interval = Math.max(5, parseInt(rateIntervalInputEl?.value ?? '10', 10) || 10);
  return { rateSatsPerInterval: sats, intervalSeconds: interval };
}

/** Mint's input fee in parts-per-thousand; loaded from keyset on page init. */
let mintFeePpk: number | null = null;

/** Update the effective-rate display: (sats / interval * 60) sats/min. */
function updateEffectiveRateDisplay(): void {
  if (effectiveRateDisplayEl === null) return;
  const { rateSatsPerInterval, intervalSeconds } = getRateConfig();
  effectiveRateDisplayEl.textContent = (rateSatsPerInterval / intervalSeconds * 60).toFixed(1);
}

/** Estimated swap fee for a single proof (1 input) at the current feePpk. */
function estimatedFeePerCycle(): number {
  if (mintFeePpk === null || mintFeePpk === 0) return 0;
  return Math.max(1, Math.ceil(mintFeePpk / 1000));
}

/** Update the fee overhead display based on current rate and feePpk. */
function updateFeeOverheadDisplay(): void {
  if (feeOverheadDisplayEl === null) return;
  const fee = estimatedFeePerCycle();
  if (fee === 0) {
    feeOverheadDisplayEl.textContent = 'Fee overhead: none';
    feeOverheadDisplayEl.classList.remove('warn');
    return;
  }
  const { rateSatsPerInterval } = getRateConfig();
  const pct = ((fee / rateSatsPerInterval) * 100).toFixed(0);
  feeOverheadDisplayEl.innerHTML = `Fee overhead: ~${fee} <span class="sat">S</span>/cycle (~${pct}%)`;
  if (fee / rateSatsPerInterval > 0.3) {
    feeOverheadDisplayEl.classList.add('warn');
  } else {
    feeOverheadDisplayEl.classList.remove('warn');
  }
}

// Wire up real-time rate display updates
if (rateSatsInputEl !== null) {
  rateSatsInputEl.addEventListener('input', updateEffectiveRateDisplay);
  rateSatsInputEl.addEventListener('input', updateFeeOverheadDisplay);
}
if (rateIntervalInputEl !== null) {
  rateIntervalInputEl.addEventListener('input', updateEffectiveRateDisplay);
}
// Initialise the displays with the defaults
updateEffectiveRateDisplay();
updateFeeOverheadDisplay();

// Fetch mint fee info for the overhead display
void buildWallet().then(({ feePpk }) => {
  mintFeePpk = feePpk;
  updateFeeOverheadDisplay();
}).catch((err: unknown) => {
  console.warn('[tutor] could not fetch mint fee info:', err);
  if (feeOverheadDisplayEl !== null) {
    feeOverheadDisplayEl.textContent = 'Fee overhead: unavailable';
  }
});

// Info icon toggle
if (feeInfoBtnEl !== null && feeInfoPanelEl !== null) {
  feeInfoBtnEl.addEventListener('click', () => {
    feeInfoPanelEl.classList.toggle('open');
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionId: string | null = null;

/** Whether the signaling connection is ready for the tutor to create a session. */
let signalingReady = false;
/** Whether the tutor has clicked "Start Session". */
let sessionStartRequested = false;
let localStream: MediaStream | null = null;
let dataChannel: DataChannel | null = null;
let peer = new PeerConnection();

/** Last chunkId successfully processed. Starts at -1 so first chunkId=0 is valid. */
let lastSeenChunkId = -1;

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

/** Send the create_session message using the currently configured rate. */
function sendCreateSession(): void {
  const { rateSatsPerInterval, intervalSeconds } = getRateConfig();
  ui.setStatus('connected -- creating session\u2026');
  client.send({
    type: 'create_session',
    mintUrl: getMintUrl(),
    rateSatsPerInterval,
    intervalSeconds,
  });
}

client.onConnect(() => {
  ui.hideReconnectOverlay();
  const existing = loadSession();
  if (existing !== null) {
    // A session was previously established (e.g. SignalingClient lost its
    // in-memory sessionId but sessionStorage still has it).  Rejoin rather
    // than creating a new orphan session.
    client.setSessionId(existing.sessionId);
    ui.setStatus('reconnecting -- rejoining session\u2026');
    client.send({ type: 'rejoin_session', sessionId: existing.sessionId });
  } else {
    // Mark signaling as ready; session is created when the tutor clicks the button.
    signalingReady = true;
    ui.setStatus('connected -- configure rate and click Start Session');
    if (sessionStartRequested) {
      // Button was clicked before the connection was ready
      sendCreateSession();
    }
  }
});

// "Start Session" button handler
if (startSessionBtnEl !== null) {
  startSessionBtnEl.addEventListener('click', () => {
    if (startSessionBtnEl !== null) {
      startSessionBtnEl.disabled = true;
    }
    sessionStartRequested = true;
    if (signalingReady) {
      sendCreateSession();
    } else {
      ui.setStatus('connecting\u2026 session will start when ready');
    }
  });
}

// "Leave Session" button handler
if (exitSessionBtnEl !== null) {
  exitSessionBtnEl.addEventListener('click', () => {
    if (sessionId !== null) {
      client.send({ type: 'end_session', sessionId });
    }
    endSession();
  });
}

client.onDisconnecting(() => {
  ui.showReconnectOverlay();
  ui.setStatus('reconnecting\u2026');
});

client.onDisconnect(() => {
  ui.setStatus('disconnected');
});

client.onReconnected(() => {
  ui.hideReconnectOverlay();
  const saved = loadSession();
  if (saved !== null) {
    ui.setStatus(`reconnected -- session ${saved.sessionId}`);
  } else {
    ui.setStatus('reconnected');
  }
});

// ---------------------------------------------------------------------------
// Peer event handler wiring
// ---------------------------------------------------------------------------

function setupPeerHandlers(): void {
  const remoteVideoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
  wireSharedPeerHandlers(peer, () => sessionId, client, ui.setStatus, remoteVideoEl);

  // Data channel -- token receipt, verify, ack/nack (Unit 10)
  peer.onDataChannel = (event) => {
    dataChannel = new DataChannel(event.channel);
    console.log('[datachannel] open');
    ui.setDcStatus('open');

    // Start the elapsed timer now that the data channel is open
    startElapsedTimer();
    sessionSummary.showSessionStats();
    sessionSummary.hidePaymentPausedBanner();

    event.channel.onclose = () => {
      console.log('[datachannel] closed');
      ui.setDcStatus('closed');
      stopElapsedTimer();
    };

    dataChannel.onMessage((msg) => {
      if (msg.type === 'session_paused') {
        // Viewer signaled that payment was paused
        sessionSummary.showPaymentPausedBanner();
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
}

setupPeerHandlers();

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

  // 3. Claim proofs via plain NUT-03 swap (no P2PK signature required)
  try {
    const { newProofs } = await claimProofs(proofs);
    lastSeenChunkId = chunkId;
    console.log(`[payment] ack #${chunkId}`);
    dataChannel.sendMessage({ type: 'payment_ack', chunkId });

    // Update the sats-received counter using the post-redemption proof amounts
    // (i.e. after the mint has deducted its swap fee), so the displayed total
    // reflects what the tutor actually holds.
    const chunkSats = newProofs.reduce((sum: number, p: Proof) => sum + p.amount, 0);
    updateSatsReceived(chunkSats);

    // Persist the newly redeemed proofs to the wallet store for cash-out.
    addProofs(newProofs);

    // If the payment was previously paused and a new chunk just succeeded, hide the banner.
    sessionSummary.hidePaymentPausedBanner();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[payment] claimProofs failed for chunk #${chunkId}:`, reason);
    dataChannel.sendMessage({ type: 'payment_nack', chunkId, reason });
  }
}

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

    case 'session_ended':
      endSession();
      break;

    case 'error': {
      const errorMsg = msg as { type: 'error'; code?: string; message?: string };
      if (errorMsg.code === 'SESSION_NOT_FOUND') {
        console.warn('[tutor] stale session cleared:', errorMsg.message);
        clearSession();
        signalingReady = true;
        ui.setStatus('connected -- configure rate and click Start Session');
        if (sessionStartRequested) {
          sendCreateSession();
        }
      } else {
        console.error('[tutor] signaling error:', errorMsg.code, errorMsg.message);
      }
      break;
    }

    case 'session_rejoined': {
      // Tutor successfully rejoined an existing session — restore state
      // and trigger a fresh WebRTC offer so video resumes.
      const rejoinedMsg = msg as import('../types/signaling.js').SessionRejoinedMessage;
      sessionId = rejoinedMsg.sessionId;
      client.setSessionId(rejoinedMsg.sessionId);

      // Defensively persist session so storage stays consistent even if
      // it was cleared during an intermediate error path.
      saveSession({
        sessionId: rejoinedMsg.sessionId,
        peerId: '',
        role: 'tutor',
        chunkCount: totalChunksReceived,
        totalSatsPaid: totalSatsReceived,
      });

      // Hide rate config, show session info (same as handleSessionCreated)
      if (rateConfigEl !== null) rateConfigEl.style.display = 'none';
      if (exitSessionBtnEl !== null) exitSessionBtnEl.style.display = 'inline-block';

      ui.setStatus('rejoined session — starting media…');

      // Release any stale media tracks before re-acquiring
      if (localStream !== null) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }

      // Start local media, then trigger a new offer to the viewer.
      // Note: sharedStartMedia only calls getUserMedia — it does not
      // interact with the PeerConnection, so using the current `peer`
      // reference is fine even though handleViewerJoined replaces it.
      void sharedStartMedia(peer, localVideoEl, ui.showError).then((stream) => {
        localStream = stream;
        if (stream !== null) {
          void handleViewerJoined();
        }
      });
      break;
    }

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

  // Hide the rate config panel now that the session is live
  if (rateConfigEl !== null) {
    rateConfigEl.style.display = 'none';
  }

  client.setSessionId(id);
  saveSession({
    sessionId: id,
    peerId: '',
    role: 'tutor',
    chunkCount: 0,
    totalSatsPaid: 0,
  });

  // Build the invite URL while the ceremony plays
  const { rateSatsPerInterval, intervalSeconds } = getRateConfig();
  const inviteUrl = createInviteUrl({
    sessionId: id,
    rateSatsPerInterval,
    intervalSeconds,
    mintUrl: getMintUrl(),
  });

  // Start media in parallel with the ceremony
  void sharedStartMedia(peer, localVideoEl, ui.showError).then((stream) => {
    localStream = stream;
  });

  // Play the Go Live ceremony, then reveal the session UI
  void playGoLiveCeremony().then(() => {
    if (inviteSessionIdEl !== null) {
      inviteSessionIdEl.textContent = id;
    }
    if (inviteUrlEl !== null) {
      inviteUrlEl.textContent = inviteUrl;
    }
    if (inviteSectionEl !== null) {
      inviteSectionEl.style.display = 'block';
    }
    if (exitSessionBtnEl !== null) exitSessionBtnEl.style.display = 'inline-block';

    if (copyInviteBtnEl !== null) {
      copyInviteBtnEl.addEventListener('click', () => {
        navigator.clipboard.writeText(inviteUrl).then(() => {
          if (copyInviteBtnEl === null) return;
          const original = copyInviteBtnEl.textContent;
          copyInviteBtnEl.textContent = 'Copied!';
          setTimeout(() => {
            copyInviteBtnEl.textContent = original;
          }, 1800);
        }).catch((err: unknown) => {
          console.error('[invite] clipboard write failed', err);
        });
      });
    }

    ui.setStatus('session created -- waiting for viewer\u2026');
  });
}

async function handleViewerJoined(): Promise<void> {
  if (sessionId === null) {
    ui.showError('viewer_joined received but sessionId is unknown');
    return;
  }
  if (localStream === null) {
    ui.showError('viewer_joined received but local media stream not ready');
    return;
  }

  ui.setStatus('viewer joined -- creating offer\u2026');

  // Close the stale peer connection and create a fresh one so that addTrack
  // does not throw "A sender already exists for the track" when a viewer
  // leaves and rejoins.
  peer = recreatePeer(peer);
  setupPeerHandlers();
  lastSeenChunkId = -1;
  dataChannel = null;

  try {
    // Create the payment data channel BEFORE createOffer() so it is negotiated
    // in the initial SDP exchange and no renegotiation is required.
    peer.createPaymentChannel();
    ui.setDcStatus('connecting\u2026');

    const offer = await peer.createOffer(localStream);
    client.send({ type: 'offer', sessionId, sdp: offer });
    ui.setStatus('offer sent -- waiting for answer\u2026');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ui.showError(`Failed to create offer: ${message}`);
  }
}
