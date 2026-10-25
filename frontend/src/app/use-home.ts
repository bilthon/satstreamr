import { nextTick, onMounted, onUnmounted, reactive, useTemplateRef } from 'vue';
import QRCode from 'qrcode';
import type { HomeWallet, WalletStatus, WithdrawalEstimate } from '../payments/home-wallet.js';
import { parseInvite } from '../lib/session-invite.js';
import { clearSession } from '../lib/session-storage.js';
import { loadSessionHistory } from '../lib/session-history.js';

/** View state only: monetary operations and proof ownership stay behind HomeWallet. */
export function useHome(wallet: HomeWallet, navigate: (url: string) => void, search: string) {
  const joinParam = new URLSearchParams(search).get('join');
  const invite = joinParam === null ? null : parseInvite(joinParam);

  const state = reactive({
    wallet: wallet.snapshot(),
    detailsOpen: false,

    sessionId: '',
    joinError: '',
    invite,
    hasInvite: joinParam !== null,
    history: loadSessionHistory().slice(0, 10),

    depositOpen: false,
    amount: '' as string | number,
    depositBusy: false,
    invoice: '',
    depositMessage: '',
    depositVariant: '',
    depositedAmount: 0,
    celebrating: false,
    countdown: 0,
    invoiceCopied: false,
    confetti: false,

    withdrawOpen: false,
    withdrawInvoice: '',
    withdrawBusy: false,
    withdrawStatus: null as WalletStatus | null,
    estimate: null as WithdrawalEstimate | null,
    amountCopied: false,
  });

  // Vue binds these keys to HomeApp's template during setup. DOM handles stay
  // private here; the component only needs state and actions for rendering.
  const depositAmountInput = useTemplateRef<HTMLInputElement>('depositAmountInput');
  const withdrawInvoiceInput = useTemplateRef<HTMLTextAreaElement>('withdrawInvoiceInput');
  const sessionInput = useTemplateRef<HTMLInputElement>('sessionInput');
  const qrCanvas = useTemplateRef<HTMLCanvasElement>('qrCanvas');
  const confettiCanvas = useTemplateRef<HTMLCanvasElement>('confettiCanvas');
  const depositPanel = useTemplateRef<HTMLElement>('depositPanel');

  let alive = true;
  let unsubscribe: (() => void) | undefined;
  let depositController: AbortController | undefined;

  // Each panel generation identifies the view that requested an async result.
  // Closing/reopening invalidates old results without cancelling settlement.
  let estimateGeneration = 0;
  let withdrawalGeneration = 0;

  let celebrationTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let animationFrame = 0;
  const copyTimers = new Set<ReturnType<typeof setTimeout>>();

  // Deposit view and observation lifecycle

  function cancelCelebration(): void {
    clearTimeout(celebrationTimer);
    clearInterval(countdownTimer);
    cancelAnimationFrame(animationFrame);

    state.celebrating = false;
    state.confetti = false;
    state.countdown = 0;
  }

  function resetDeposit(): void {
    // Abort detaches this view; wallet polling/minting continues to completion
    // or expiry. Clean UI timers and ignore late results without abandoning funds.
    depositController?.abort();
    depositController = undefined;
    cancelCelebration();

    state.amount = '';
    state.depositBusy = false;
    state.invoice = '';
    state.depositMessage = '';
    state.depositVariant = '';
    state.invoiceCopied = false;
  }

  async function openDeposit(): Promise<void> {
    resetDeposit();
    state.depositOpen = true;

    // Wait for Vue to show the panel before focusing its input.
    await nextTick();
    if (alive) {
      depositAmountInput.value?.focus();
    }
  }

  function closeDeposit(): void {
    state.depositOpen = false;
    resetDeposit();
  }

  async function resetAndFocus(): Promise<void> {
    resetDeposit();

    // Reset may reenable the input; focus after that DOM update.
    await nextTick();
    if (alive) {
      depositAmountInput.value?.focus();
    }
  }

  function escape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && state.depositOpen) {
      closeDeposit();
    }
  }

  function depositStatus(message: string, variant: string): void {
    state.depositMessage = message;
    state.depositVariant = variant;
  }

  async function generateInvoice(): Promise<void> {
    if (state.depositBusy) {
      return;
    }

    const raw = String(state.amount).trim();
    const amount = parseInt(raw, 10);
    if (!raw || isNaN(amount) || amount <= 0) {
      depositStatus('Please enter a valid amount.', 'error');
      return;
    }

    cancelCelebration();
    depositController?.abort();
    const controller = new AbortController();
    depositController = controller;
    const current = (): boolean => alive && !controller.signal.aborted;

    state.depositBusy = true;
    state.invoice = '';
    state.depositMessage = '';

    try {
      const result = await wallet.deposit(amount, invoice => {
        if (!current()) {
          return;
        }

        state.invoice = invoice;
        depositStatus('Waiting for payment…', 'waiting');

        // Draw only after Vue has updated the invoice area, and only if this
        // deposit is still being observed when that update completes.
        void nextTick().then(() => {
          if (current() && qrCanvas.value) {
            return QRCode.toCanvas(qrCanvas.value, `lightning:${invoice}`, { width: 220 });
          }
        }).catch((error: unknown) => {
          console.error('[deposit] QR code render failed', error);
        });
      }, controller.signal);

      if (!current()) {
        return;
      }

      if (result === 'paid') {
        state.invoice = '';
        state.amount = '';
        state.depositedAmount = amount;
        state.celebrating = true;
        depositStatus('', 'success');

        state.countdown = 8;
        countdownTimer = setInterval(() => {
          if (state.countdown > 1) {
            state.countdown--;
          }
        }, 1000);
        celebrationTimer = setTimeout(resetDeposit, 8_000);

        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          state.confetti = true;

          // The conditional canvas must be mounted before measuring/drawing.
          await nextTick();
          if (current()) {
            launchConfetti();
          }
        }
      } else if (result === 'expired') {
        depositStatus('Invoice expired — please try again.', 'expired');
      }
    } catch (error) {
      if (current()) {
        depositStatus(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      if (current()) {
        state.depositBusy = false;
      }
    }
  }

  // Canvas drawing is an effect; Vue owns the canvas element and its lifetime.
  function launchConfetti(): void {
    const canvas = confettiCanvas.value;
    const panel = depositPanel.value;
    if (!canvas || !panel) {
      return;
    }

    canvas.width = panel.offsetWidth;
    canvas.height = panel.offsetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      state.confetti = false;
      return;
    }

    const colors = ['#10d9a0', '#f7931a', '#f0c419', '#7c3aed', '#38bdf8', '#eef2ff'];
    const particles = Array.from({ length: 40 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * 60,
      y: canvas.height * 0.35,
      vx: (Math.random() - 0.5) * 8,
      vy: -(Math.random() * 6 + 2),
      w: Math.random() * 6 + 3,
      h: Math.random() * 4 + 2,
      color: colors[Math.floor(Math.random() * colors.length)] ?? '#10d9a0',
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.3,
    }));
    const start = performance.now();

    function frame(now: number): void {
      if (!alive || !state.confetti || !ctx || !canvas) {
        return;
      }

      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particles) {
        p.vy += 0.12;
        p.vx *= 0.98;
        p.vy *= 0.98;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.globalAlpha = elapsed > 1700 ? Math.max(0, 1 - (elapsed - 1700) / 800) : 1;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      if (elapsed < 2500) {
        animationFrame = requestAnimationFrame(frame);
      } else {
        state.confetti = false;
      }
    }

    animationFrame = requestAnimationFrame(frame);
  }

  // Clipboard feedback is shared by the funding and withdrawal panels.

  async function copy(kind: 'invoice' | 'amount'): Promise<void> {
    const value = kind === 'invoice' ? state.invoice : String(state.estimate?.maxAmount ?? '');
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      if (!alive) {
        return;
      }

      if (kind === 'invoice') {
        state.invoiceCopied = true;
      } else {
        state.amountCopied = true;
      }

      const timer = setTimeout(() => {
        copyTimers.delete(timer);
        if (kind === 'invoice') {
          state.invoiceCopied = false;
        } else {
          state.amountCopied = false;
        }
      }, 1800);
      copyTimers.add(timer);
    } catch (error) {
      console.error(`[${kind === 'invoice' ? 'deposit' : 'withdraw'}] clipboard write failed`, error);
    }
  }

  // Withdrawal view: hide stale results, but let the wallet finish settlement.

  async function openWithdraw(): Promise<void> {
    state.withdrawOpen = true;
    state.withdrawInvoice = '';
    state.withdrawStatus = null;
    state.estimate = null;
    state.amountCopied = false;

    const generation = ++estimateGeneration;

    // The panel must be visible before its invoice input can receive focus.
    await nextTick();
    if (!alive) {
      return;
    }
    withdrawInvoiceInput.value?.focus();

    try {
      const estimate = await wallet.estimateWithdrawal();
      if (alive && generation === estimateGeneration) {
        state.estimate = estimate;
      }
    } catch (error) {
      console.warn('[withdraw] could not estimate max withdrawable:', error);
    }
  }

  function closeWithdraw(): void {
    estimateGeneration++;
    withdrawalGeneration++;

    state.withdrawOpen = false;
    state.withdrawInvoice = '';
    state.withdrawStatus = null;
    state.estimate = null;
  }

  async function payInvoice(): Promise<void> {
    if (state.withdrawBusy) {
      return;
    }

    const invoice = state.withdrawInvoice.trim();
    if (!invoice) {
      state.withdrawStatus = {
        message: 'Please paste a Lightning invoice.',
        variant: 'error',
      };
      return;
    }

    const lower = invoice.toLowerCase();
    if (!lower.startsWith('lnbc') && !lower.startsWith('lnbcrt')) {
      state.withdrawStatus = {
        message: 'Unrecognised invoice prefix — expected lnbc… (mainnet) or lnbcrt… (regtest). Continuing anyway, but payment may fail.',
        variant: 'warning',
      };
    }

    const generation = ++withdrawalGeneration;
    const current = (): boolean => alive && generation === withdrawalGeneration;
    state.withdrawBusy = true;

    try {
      const result = await wallet.withdraw(invoice, progress => {
        if (current()) {
          state.withdrawStatus = progress;
        }
      });

      if (current()) {
        state.withdrawStatus = result;
        if (result.variant === 'success') {
          state.withdrawInvoice = '';
        }
      }
    } catch (error) {
      if (current()) {
        state.withdrawStatus = {
          message: error instanceof Error ? error.message : String(error),
          variant: 'error',
        };
      }
    } finally {
      // Keep the submit guard until settlement ends, even if the panel closed.
      if (alive) {
        state.withdrawBusy = false;
      }
    }
  }

  // Session navigation and history display

  function startStreaming(): void {
    clearSession();
    navigate('/room.html');
  }

  function navigateToViewer(sessionId: string): void {
    clearSession();
    navigate(`/room.html?session=${encodeURIComponent(sessionId)}`);
  }

  function join(): void {
    const sessionId = state.sessionId.trim();
    if (!sessionId) {
      state.joinError = 'Please enter a session ID.';
      return;
    }

    state.joinError = '';
    navigateToViewer(sessionId);
  }

  function joinInvite(): void {
    if (invite) {
      sessionStorage.setItem('pending_join', JSON.stringify(invite));
      navigateToViewer(invite.sessionId);
    } else {
      sessionInput.value?.focus();
      sessionInput.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      state.joinError = 'Could not decode the invite link. Please enter the session ID manually.';
    }
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  function formatDuration(seconds: number): string {
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  // This composable owns subscriptions, document listeners and scheduled effects.
  // Vue owns the DOM refs; teardown also invalidates work awaiting wallet results.
  onMounted(() => {
    unsubscribe = wallet.subscribe(snapshot => {
      state.wallet = snapshot;
    });
    state.wallet = wallet.snapshot();
    document.addEventListener('keydown', escape);
  });

  onUnmounted(() => {
    alive = false;
    unsubscribe?.();
    resetDeposit();
    estimateGeneration++;
    withdrawalGeneration++;

    document.removeEventListener('keydown', escape);
    for (const timer of copyTimers) {
      clearTimeout(timer);
    }
  });

  return {
    state,

    openDeposit,
    closeDeposit,
    resetAndFocus,
    generateInvoice,
    copy,

    openWithdraw,
    closeWithdraw,
    payInvoice,

    startStreaming,
    join,
    joinInvite,
    formatDate,
    formatDuration,
  };
}
