import { getDecodedToken } from '@cashu/cashu-ts';
import type { Proof } from '../types/cashu.js';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { checkTokenState, claimProofs, getMeltQuote, meltTokens } from '../lib/cashu-wallet.js';
import type { SignalingMessage } from '../types/signaling.js';
import { saveSession, loadSession, clearSession } from '../lib/session-storage.js';
import { getProofs, addProofs } from '../lib/wallet-store.js';
import { createInviteUrl } from '../lib/session-invite.js';
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

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
const sessionIdEl = document.getElementById('session-id');
const sessionContainerEl = document.getElementById('session-container');
const localVideoEl = document.getElementById('local-video') as HTMLVideoElement | null;
const errorEl = document.getElementById('error');
const dcStatusEl = document.getElementById('dc-status');

// Rate configuration UI elements
const rateConfigEl = document.getElementById('rate-config');
const rateSatsInputEl = document.getElementById('rate-sats-input') as HTMLInputElement | null;
const rateIntervalInputEl = document.getElementById('rate-interval-input') as HTMLInputElement | null;
const effectiveRateDisplayEl = document.getElementById('effective-rate-display');
const startSessionBtnEl = document.getElementById('start-session-btn') as HTMLButtonElement | null;

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

// Invite display elements
const inviteSectionEl = document.getElementById('invite-section');
const inviteSessionIdEl = document.getElementById('invite-session-id');
const inviteUrlEl = document.getElementById('invite-url');
const copyInviteBtnEl = document.getElementById('copy-invite-btn') as HTMLButtonElement | null;

// Cash-out UI elements
const invoiceInputEl = document.getElementById('invoice-input') as HTMLInputElement | null;
const invoiceCountdownEl = document.getElementById('invoice-countdown');
const payInvoiceBtnEl = document.getElementById('pay-invoice-btn') as HTMLButtonElement | null;
const cashoutStatusEl = document.getElementById('cashout-status');

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
let invoiceCountdownHandle: ReturnType<typeof setInterval> | null = null;

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

  // Wire up cash-out logic
  wireCashOut();
}

/** Display a message in #cashout-status, optionally styled as an error. */
function setCashoutStatus(text: string, isError = false): void {
  if (cashoutStatusEl === null) return;
  cashoutStatusEl.textContent = text;
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

  setCashoutStatus(`Paying ${String(amount)} sats + up to ${String(feeReserve)} sats fee\u2026`);

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

// Wire up the close button
if (summaryCloseBtnEl !== null) {
  summaryCloseBtnEl.addEventListener('click', () => {
    clearSession();
    window.location.href = '/';
  });
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

/** Update the effective-rate display: (sats / interval * 60) sats/min. */
function updateEffectiveRateDisplay(): void {
  if (effectiveRateDisplayEl === null) return;
  const { rateSatsPerInterval, intervalSeconds } = getRateConfig();
  effectiveRateDisplayEl.textContent = (rateSatsPerInterval / intervalSeconds * 60).toFixed(1);
}

// Wire up real-time rate display updates
if (rateSatsInputEl !== null) {
  rateSatsInputEl.addEventListener('input', updateEffectiveRateDisplay);
}
if (rateIntervalInputEl !== null) {
  rateIntervalInputEl.addEventListener('input', updateEffectiveRateDisplay);
}
// Initialise the display with the defaults
updateEffectiveRateDisplay();

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
const peer = new PeerConnection();

/** Last chunkId successfully processed. Starts at -1 so first chunkId=0 is valid. */
let lastSeenChunkId = -1;

// ---------------------------------------------------------------------------
// Signaling client
// ---------------------------------------------------------------------------

const client = new SignalingClient(signalingUrl);

/** Send the create_session message using the currently configured rate. */
function sendCreateSession(): void {
  const { rateSatsPerInterval, intervalSeconds } = getRateConfig();
  setStatus('connected -- creating session\u2026');
  client.send({
    type: 'create_session',
    mintUrl: getMintUrl(),
    rateSatsPerInterval,
    intervalSeconds,
  });
}

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
    // Mark signaling as ready; session is created when the tutor clicks the button.
    signalingReady = true;
    setStatus('connected -- configure rate and click Start Session');
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
      setStatus('connecting\u2026 session will start when ready');
    }
  });
}

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
    hidePaymentPausedBanner();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[payment] claimProofs failed for chunk #${chunkId}:`, reason);
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

  if (sessionIdEl !== null) {
    sessionIdEl.textContent = id;
  }
  if (sessionContainerEl !== null) {
    sessionContainerEl.style.display = 'block';
  }

  // Build and display the invite using the configured rate
  const { rateSatsPerInterval, intervalSeconds } = getRateConfig();
  const inviteUrl = createInviteUrl({
    sessionId: id,
    rateSatsPerInterval,
    intervalSeconds,
    mintUrl: getMintUrl(),
  });

  if (inviteSessionIdEl !== null) {
    inviteSessionIdEl.textContent = id;
  }
  if (inviteUrlEl !== null) {
    inviteUrlEl.textContent = inviteUrl;
  }
  if (inviteSectionEl !== null) {
    inviteSectionEl.style.display = 'block';
  }

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
