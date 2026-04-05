import QRCode from 'qrcode';
import { getBalance, onBalanceChange, spendProofs, addProofs, getProofs } from '../lib/wallet-store.js';
import { getMeltQuote, meltTokens } from '../lib/cashu-wallet.js';
import { requestMintQuote, pollForPayment, mintProofsFromQuote } from '../lib/deposit.js';
import { parseInvite } from '../lib/session-invite.js';
import { clearSession } from '../lib/session-storage.js';

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const balanceDisplayEl = document.getElementById('balance-display');
const depositBtnEl = document.getElementById('deposit-btn') as HTMLButtonElement | null;
const withdrawBtnEl = document.getElementById('withdraw-btn') as HTMLButtonElement | null;

// Withdraw panel elements
const withdrawPanelEl = document.getElementById('withdraw-panel');
const withdrawInvoiceInputEl = document.getElementById('withdraw-invoice-input') as HTMLTextAreaElement | null;
const withdrawQuoteDisplayEl = document.getElementById('withdraw-quote-display');
const withdrawStatusEl = document.getElementById('withdraw-status');
const withdrawGetQuoteBtnEl = document.getElementById('withdraw-get-quote-btn') as HTMLButtonElement | null;
const withdrawPayBtnEl = document.getElementById('withdraw-pay-btn') as HTMLButtonElement | null;
const withdrawCloseBtnEl = document.getElementById('withdraw-close-btn') as HTMLButtonElement | null;

const startStreamingBtnEl = document.getElementById('start-streaming-btn') as HTMLButtonElement | null;

const sessionIdInputEl = document.getElementById('session-id-input') as HTMLInputElement | null;
const joinBtnEl = document.getElementById('join-btn') as HTMLButtonElement | null;
const joinErrorEl = document.getElementById('join-error');

const invitePanelEl = document.getElementById('invite-panel');
const inviteJsonEl = document.getElementById('invite-json');
const inviteDecodeErrorEl = document.getElementById('invite-decode-error');
const inviteJoinBtnEl = document.getElementById('invite-join-btn') as HTMLButtonElement | null;

// Token details elements
const tokenDetailsToggleEl = document.getElementById('token-details-toggle') as HTMLButtonElement | null;
const tokenDetailsPanelEl = document.getElementById('token-details-panel');
const tokenDetailsTableEl = document.getElementById('token-details-table');
const tokenDetailsSummaryEl = document.getElementById('token-details-summary');

// ---------------------------------------------------------------------------
// Balance display
// ---------------------------------------------------------------------------

function renderBalance(balance: number): void {
  if (balanceDisplayEl !== null) {
    balanceDisplayEl.textContent = `Balance: ${balance} sats`;
  }
}

// Initialise balance on load.
renderBalance(getBalance());

// Subscribe to reactive balance updates.
onBalanceChange((balance) => {
  renderBalance(balance);
  // Keep token details in sync while the panel is open.
  if (tokenDetailsPanelEl !== null && tokenDetailsPanelEl.classList.contains('is-open')) {
    renderTokenDetails();
  }
});

// ---------------------------------------------------------------------------
// Token denomination breakdown
// ---------------------------------------------------------------------------

function renderTokenDetails(): void {
  const proofs = getProofs();

  if (tokenDetailsTableEl === null || tokenDetailsSummaryEl === null) return;

  const tbody = tokenDetailsTableEl.querySelector('tbody');
  if (tbody === null) return;

  if (proofs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:#6b7280;font-style:italic;padding:0.4rem 0.5rem;">No tokens in wallet</td></tr>`;
    tokenDetailsSummaryEl.textContent = '';
    return;
  }

  // Group proofs by denomination.
  const groups = new Map<number, number>();
  for (const proof of proofs) {
    groups.set(proof.amount, (groups.get(proof.amount) ?? 0) + 1);
  }

  // Sort ascending by denomination.
  const sorted = [...groups.entries()].sort((a, b) => a[0] - b[0]);

  tbody.innerHTML = sorted
    .map(([denom, count]) => {
      const subtotal = denom * count;
      return `<tr>
        <td>${denom} sat${denom === 1 ? '' : 's'}</td>
        <td>${count}</td>
        <td>${subtotal} sat${subtotal === 1 ? '' : 's'}</td>
      </tr>`;
    })
    .join('');

  const totalSats = proofs.reduce((sum, p) => sum + p.amount, 0);
  tokenDetailsSummaryEl.textContent = `Total: ${totalSats} sat${totalSats === 1 ? '' : 's'} (${proofs.length} proof${proofs.length === 1 ? '' : 's'})`;
}

// Wire up toggle button.
if (tokenDetailsToggleEl !== null && tokenDetailsPanelEl !== null) {
  tokenDetailsToggleEl.addEventListener('click', () => {
    const isOpen = tokenDetailsPanelEl.classList.toggle('is-open');
    tokenDetailsToggleEl.textContent = isOpen ? 'Hide token details' : 'Show token details';
    if (isOpen) {
      renderTokenDetails();
    }
  });
}

// ---------------------------------------------------------------------------
// Deposit modal — Unit 25
// ---------------------------------------------------------------------------

const depositOverlayEl = document.getElementById('deposit-overlay');
const depositAmountInputEl = document.getElementById('deposit-amount-input') as HTMLInputElement | null;
const depositGenerateBtnEl = document.getElementById('deposit-generate-btn') as HTMLButtonElement | null;
const depositInvoiceAreaEl = document.getElementById('deposit-invoice-area');
const depositQrCanvasEl = document.getElementById('deposit-qr-canvas') as HTMLCanvasElement | null;
const depositInvoiceTextEl = document.getElementById('deposit-invoice-text');
const depositCopyBtnEl = document.getElementById('deposit-copy-btn') as HTMLButtonElement | null;
const depositStatusEl = document.getElementById('deposit-status');
const depositCloseBtnEl = document.getElementById('deposit-close-btn') as HTMLButtonElement | null;

/** Currently displayed invoice string (used by the copy button). */
let depositCurrentInvoice: string | null = null;

type DepositStatusVariant = 'waiting' | 'success' | 'expired' | 'error';

function showDepositStatus(message: string, variant: DepositStatusVariant): void {
  if (depositStatusEl === null) return;
  depositStatusEl.className = `is-visible is-${variant}`;
  depositStatusEl.innerHTML =
    variant === 'waiting'
      ? `<span class="deposit-spinner" aria-hidden="true"></span>${message}`
      : message;
}

function hideDepositStatus(): void {
  if (depositStatusEl === null) return;
  depositStatusEl.className = '';
  depositStatusEl.textContent = '';
}

function showDepositInvoice(invoice: string): void {
  depositCurrentInvoice = invoice;

  if (depositInvoiceTextEl !== null) {
    depositInvoiceTextEl.textContent = invoice;
  }

  if (depositInvoiceAreaEl !== null) {
    depositInvoiceAreaEl.classList.add('is-visible');
  }

  // Render QR code — prefix with "lightning:" for wallet compatibility.
  if (depositQrCanvasEl !== null) {
    QRCode.toCanvas(depositQrCanvasEl, `lightning:${invoice}`, { width: 220 }).catch((err: unknown) => {
      console.error('[deposit] QR code render failed', err);
    });
  }
}

function hideDepositInvoice(): void {
  depositCurrentInvoice = null;
  if (depositInvoiceAreaEl !== null) {
    depositInvoiceAreaEl.classList.remove('is-visible');
  }
  if (depositInvoiceTextEl !== null) {
    depositInvoiceTextEl.textContent = '';
  }
}

function resetDepositPanel(): void {
  if (depositAmountInputEl !== null) depositAmountInputEl.value = '';
  if (depositGenerateBtnEl !== null) depositGenerateBtnEl.disabled = false;
  hideDepositInvoice();
  hideDepositStatus();
}

function openDepositModal(): void {
  resetDepositPanel();
  if (depositOverlayEl !== null) depositOverlayEl.classList.add('is-open');
  depositAmountInputEl?.focus();
}

function closeDepositModal(): void {
  if (depositOverlayEl !== null) depositOverlayEl.classList.remove('is-open');
  resetDepositPanel();
}

// Open deposit modal when Deposit button is clicked.
if (depositBtnEl !== null) {
  depositBtnEl.addEventListener('click', () => {
    openDepositModal();
  });
}

// Close button dismisses the modal and resets state.
if (depositCloseBtnEl !== null) {
  depositCloseBtnEl.addEventListener('click', () => {
    closeDepositModal();
  });
}

// Close modal when clicking outside the panel (on the overlay backdrop).
if (depositOverlayEl !== null) {
  depositOverlayEl.addEventListener('click', (event: MouseEvent) => {
    if (event.target === depositOverlayEl) {
      closeDepositModal();
    }
  });
}

// Close modal on Escape key.
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && depositOverlayEl?.classList.contains('is-open')) {
    closeDepositModal();
  }
});

// Copy button copies the invoice to clipboard.
if (depositCopyBtnEl !== null) {
  depositCopyBtnEl.addEventListener('click', () => {
    if (depositCurrentInvoice === null) return;
    navigator.clipboard.writeText(depositCurrentInvoice).then(() => {
      const original = depositCopyBtnEl.textContent;
      depositCopyBtnEl.textContent = 'Copied!';
      setTimeout(() => {
        depositCopyBtnEl.textContent = original;
      }, 1800);
    }).catch((err: unknown) => {
      console.error('[deposit] clipboard write failed', err);
    });
  });
}

// Generate Invoice button: request quote, render QR, then poll for payment.
if (depositGenerateBtnEl !== null) {
  depositGenerateBtnEl.addEventListener('click', () => {
    const rawAmount = depositAmountInputEl?.value.trim() ?? '';
    const amount = parseInt(rawAmount, 10);

    if (!rawAmount || isNaN(amount) || amount <= 0) {
      showDepositStatus('Please enter a valid amount in sats.', 'error');
      return;
    }

    depositGenerateBtnEl.disabled = true;
    hideDepositInvoice();
    hideDepositStatus();

    void (async () => {
      let quoteId: string;
      let invoice: string;

      try {
        ({ quote: quoteId, invoice } = await requestMintQuote(amount));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showDepositStatus(`Failed to generate invoice: ${message}`, 'error');
        depositGenerateBtnEl.disabled = false;
        return;
      }

      showDepositInvoice(invoice);
      showDepositStatus('Waiting for payment…', 'waiting');

      let paid: boolean;
      try {
        paid = await pollForPayment(quoteId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showDepositStatus(`Payment check failed: ${message}`, 'error');
        depositGenerateBtnEl.disabled = false;
        return;
      }

      if (!paid) {
        showDepositStatus('Invoice expired — please try again.', 'expired');
        depositGenerateBtnEl.disabled = false;
        return;
      }

      try {
        await mintProofsFromQuote(quoteId, amount);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showDepositStatus(`Deposit confirmed but minting failed: ${message}`, 'error');
        depositGenerateBtnEl.disabled = false;
        return;
      }

      // Balance is updated reactively via onBalanceChange — just show success.
      showDepositStatus(`Deposited ${amount} sats!`, 'success');
      depositGenerateBtnEl.disabled = false;
    })();
  });
}

// ---------------------------------------------------------------------------
// Withdraw panel — Unit 26
// ---------------------------------------------------------------------------

/** Withdraw flow state */
interface WithdrawState {
  quoteId: string | null;
  quoteAmount: number;
  quoteFeeReserve: number;
}

const withdrawState: WithdrawState = {
  quoteId: null,
  quoteAmount: 0,
  quoteFeeReserve: 0,
};

type StatusVariant = 'info' | 'success' | 'error' | 'warning';

function showWithdrawStatus(message: string, variant: StatusVariant = 'info'): void {
  if (withdrawStatusEl === null) return;
  withdrawStatusEl.textContent = message;
  withdrawStatusEl.className = `status-${variant}`;
  withdrawStatusEl.style.display = 'block';
}

function hideWithdrawStatus(): void {
  if (withdrawStatusEl === null) return;
  withdrawStatusEl.style.display = 'none';
  withdrawStatusEl.textContent = '';
  withdrawStatusEl.className = '';
}

function showWithdrawQuote(amount: number, fee: number): void {
  if (withdrawQuoteDisplayEl === null) return;
  const total = amount + fee;
  withdrawQuoteDisplayEl.textContent = `Amount: ${amount} sats, Fee: ${fee} sats, Total: ${total} sats`;
  withdrawQuoteDisplayEl.style.display = 'block';
}

function hideWithdrawQuote(): void {
  if (withdrawQuoteDisplayEl === null) return;
  withdrawQuoteDisplayEl.style.display = 'none';
  withdrawQuoteDisplayEl.textContent = '';
}

function resetWithdrawPanel(): void {
  if (withdrawInvoiceInputEl !== null) withdrawInvoiceInputEl.value = '';
  if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = true;
  if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
  hideWithdrawQuote();
  hideWithdrawStatus();
  withdrawState.quoteId = null;
  withdrawState.quoteAmount = 0;
  withdrawState.quoteFeeReserve = 0;
}

function openWithdrawPanel(): void {
  resetWithdrawPanel();
  if (withdrawPanelEl !== null) withdrawPanelEl.style.display = 'block';
  withdrawInvoiceInputEl?.focus();
}

function closeWithdrawPanel(): void {
  if (withdrawPanelEl !== null) withdrawPanelEl.style.display = 'none';
  resetWithdrawPanel();
}

/** Validates invoice prefix. Returns a warning string or null if OK. */
function checkInvoicePrefix(invoice: string): string | null {
  const lower = invoice.toLowerCase();
  if (lower.startsWith('lnbc') || lower.startsWith('lnbcrt')) {
    return null; // valid mainnet or regtest
  }
  return `Unrecognised invoice prefix — expected lnbc… (mainnet) or lnbcrt… (regtest). Continuing anyway, but payment may fail.`;
}

// Open withdraw panel when Withdraw button clicked
if (withdrawBtnEl !== null) {
  withdrawBtnEl.addEventListener('click', () => {
    openWithdrawPanel();
  });
}

// Close button
if (withdrawCloseBtnEl !== null) {
  withdrawCloseBtnEl.addEventListener('click', () => {
    closeWithdrawPanel();
  });
}

// Get Quote button
if (withdrawGetQuoteBtnEl !== null) {
  withdrawGetQuoteBtnEl.addEventListener('click', async () => {
    const invoice = withdrawInvoiceInputEl?.value.trim() ?? '';

    if (invoice.length === 0) {
      showWithdrawStatus('Please paste a Lightning invoice.', 'error');
      return;
    }

    // Prefix warning
    const prefixWarning = checkInvoicePrefix(invoice);
    if (prefixWarning !== null) {
      showWithdrawStatus(prefixWarning, 'warning');
    } else {
      hideWithdrawStatus();
    }

    // Reset prior quote state
    hideWithdrawQuote();
    if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = true;
    if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = true;

    try {
      showWithdrawStatus('Fetching quote…', 'info');
      const quote = await getMeltQuote(invoice);

      withdrawState.quoteId = quote.quote;
      withdrawState.quoteAmount = quote.amount;
      withdrawState.quoteFeeReserve = quote.fee_reserve;

      const total = quote.amount + quote.fee_reserve;
      const balance = getBalance();

      showWithdrawQuote(quote.amount, quote.fee_reserve);

      if (balance < total) {
        showWithdrawStatus(
          `Insufficient balance — you have ${balance} sats, need ${total} sats`,
          'error'
        );
        if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
        return;
      }

      hideWithdrawStatus();
      if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showWithdrawStatus(`Failed to get quote: ${message}`, 'error');
    } finally {
      if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
    }
  });
}

// Pay Invoice button
if (withdrawPayBtnEl !== null) {
  withdrawPayBtnEl.addEventListener('click', async () => {
    const invoice = withdrawInvoiceInputEl?.value.trim() ?? '';
    const { quoteId, quoteAmount, quoteFeeReserve } = withdrawState;

    if (quoteId === null || invoice.length === 0) {
      showWithdrawStatus('Please get a quote first.', 'error');
      return;
    }

    const totalNeeded = quoteAmount + quoteFeeReserve;

    // Disable both action buttons while paying
    if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = true;
    if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = true;

    showWithdrawStatus('Paying…', 'info');

    let selectedProofs;
    try {
      selectedProofs = spendProofs(totalNeeded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showWithdrawStatus(`Insufficient balance — ${message}`, 'error');
      if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
      if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = false;
      return;
    }

    try {
      const result = await meltTokens(invoice, quoteId, selectedProofs);

      if (result.paid) {
        const preimage = result.payment_preimage ?? '(none)';
        showWithdrawStatus(`Payment sent! Preimage: ${preimage}`, 'success');
        if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = true;
        if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
        // Balance already updated by spendProofs removing proofs from the store
      } else {
        // Mint returned paid: false — return proofs
        addProofs(selectedProofs);
        showWithdrawStatus('Payment did not complete — proofs returned to wallet. Please try again.', 'error');
        if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
        if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = false;
      }
    } catch (err) {
      // Melt failed — return the proofs so balance is unchanged
      addProofs(selectedProofs);
      const message = err instanceof Error ? err.message : String(err);
      showWithdrawStatus(`Payment failed: ${message} — proofs returned to wallet.`, 'error');
      if (withdrawGetQuoteBtnEl !== null) withdrawGetQuoteBtnEl.disabled = false;
      if (withdrawPayBtnEl !== null) withdrawPayBtnEl.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Start Streaming button
// ---------------------------------------------------------------------------

if (startStreamingBtnEl !== null) {
  startStreamingBtnEl.addEventListener('click', () => {
    clearSession();
    window.location.href = '/tutor.html';
  });
}

// ---------------------------------------------------------------------------
// Join a Stream
// ---------------------------------------------------------------------------

function navigateToViewer(sessionId: string): void {
  clearSession();
  window.location.href = `/viewer.html?session=${encodeURIComponent(sessionId)}`;
}

function showJoinError(message: string): void {
  if (joinErrorEl !== null) {
    joinErrorEl.textContent = message;
    joinErrorEl.style.display = 'block';
  }
}

function hideJoinError(): void {
  if (joinErrorEl !== null) {
    joinErrorEl.style.display = 'none';
  }
}

if (joinBtnEl !== null) {
  joinBtnEl.addEventListener('click', () => {
    const sessionId = sessionIdInputEl?.value.trim() ?? '';
    if (sessionId.length === 0) {
      showJoinError('Please enter a session ID.');
      return;
    }
    hideJoinError();
    navigateToViewer(sessionId);
  });
}

if (sessionIdInputEl !== null) {
  sessionIdInputEl.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      joinBtnEl?.click();
    }
  });

  sessionIdInputEl.addEventListener('input', () => {
    hideJoinError();
  });
}

// ---------------------------------------------------------------------------
// ?join=<base64> invite detection
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const joinParam = params.get('join');

if (joinParam !== null && invitePanelEl !== null) {
  invitePanelEl.style.display = 'block';

  const invite = parseInvite(joinParam);

  if (invite !== null) {
    // Build rich preview from decoded invite fields
    const balance = getBalance();
    // Estimated minutes = (balance / rateSatsPerInterval) * (intervalSeconds / 60)
    const estimatedMinutes =
      invite.rateSatsPerInterval > 0
        ? Math.floor((balance / invite.rateSatsPerInterval) * (invite.intervalSeconds / 60))
        : 0;

    const rateLabel = `${invite.rateSatsPerInterval} sats every ${invite.intervalSeconds} seconds`;
    const durationLabel =
      balance > 0
        ? `${balance} sats (~${String(estimatedMinutes)} min)`
        : '0 sats (deposit first)';

    if (inviteJsonEl !== null) {
      inviteJsonEl.innerHTML = [
        `<strong>Rate:</strong> ${rateLabel}`,
        `<strong>Mint:</strong> ${invite.mintUrl}`,
        `<strong>Your balance:</strong> ${durationLabel}`,
      ].join('<br>');
    }

    if (inviteDecodeErrorEl !== null) {
      inviteDecodeErrorEl.style.display = 'none';
    }

    // Wire up "Join This Session" button — store session params then navigate
    if (inviteJoinBtnEl !== null) {
      inviteJoinBtnEl.addEventListener('click', () => {
        sessionStorage.setItem(
          'pending_join',
          JSON.stringify({
            sessionId: invite.sessionId,
            rateSatsPerInterval: invite.rateSatsPerInterval,
            intervalSeconds: invite.intervalSeconds,
            mintUrl: invite.mintUrl,
          })
        );
        navigateToViewer(invite.sessionId);
      });
    }
  } else {
    // Invite could not be decoded — show error
    if (inviteDecodeErrorEl !== null) {
      inviteDecodeErrorEl.textContent = 'Failed to decode invite link — the base64 payload is invalid or missing required fields.';
      inviteDecodeErrorEl.style.display = 'block';
    }
    if (inviteJsonEl !== null) {
      inviteJsonEl.textContent = '';
    }

    // Fallback: button prompts manual entry
    if (inviteJoinBtnEl !== null) {
      inviteJoinBtnEl.addEventListener('click', () => {
        if (sessionIdInputEl !== null) {
          sessionIdInputEl.focus();
          sessionIdInputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        showJoinError('Could not decode the invite link. Please enter the session ID manually.');
      });
    }
  }
}
