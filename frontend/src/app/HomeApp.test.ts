// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HomeApp from './HomeApp.vue';
import QRCode from 'qrcode';
import type { HomeWallet, HomeWalletSnapshot, WalletStatus } from '../payments/home-wallet.js';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));
let app: App | undefined;
let root: HTMLDivElement;
let wallet: HomeWallet;
let navigate: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let notify: (snapshot: HomeWalletSnapshot) => void;
const snapshot: HomeWalletSnapshot = { balance: 32, cashu: {
  denominations: [{ amount: 16, count: 2, subtotal: 32 }], proofCount: 2,
} };
const control = <T extends HTMLElement = HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await nextTick(); };
async function click(id: string): Promise<void> { control(id).click(); await flush(); }
async function input(id: string, value: string): Promise<void> {
  control<HTMLInputElement>(id).value = value;
  control(id).dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
function mount(search = ''): void {
  app = createApp(HomeApp, { wallet, navigate, search });
  app.mount(root);
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  root = document.createElement('div'); document.body.append(root);
  navigate = vi.fn(); unsubscribe = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  wallet = {
    snapshot: () => snapshot,
    subscribe: vi.fn(listener => { notify = listener; return unsubscribe; }),
    estimateWithdrawal: vi.fn().mockResolvedValue({ maxAmount: 29, balance: 32, inputFee: 1, lightningBuffer: 2 }),
    deposit: vi.fn().mockResolvedValue('paid'),
    withdraw: vi.fn().mockResolvedValue({ message: 'Payment sent!', variant: 'success' }),
  };
});
afterEach(() => {
  app?.unmount(); app = undefined; root.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('renders balance, Cashu denominations and history safely and unsubscribes', async () => {
  localStorage.setItem('satstreamr_session_history', JSON.stringify([{
    sessionId: 'test', role: 'tutor', startedAt: '2026-01-01', durationSeconds: 65, totalSats: 4, totalChunks: 1,
  }]));
  mount();
  expect(control('balance-display').textContent).toContain('32');
  await click('token-details-toggle');
  expect(control('token-details-panel').classList.contains('is-open')).toBe(true);
  expect(control('token-details-summary').textContent).toContain('(2 proofs)');
  expect(control('session-history-list').textContent).toContain('Earned');
  expect(control('session-history-list').textContent).toContain('01:05');
  notify({ balance: 0, cashu: { denominations: [], proofCount: 0 } });
  await flush();
  expect(control('balance-display').textContent).toContain('0');
  expect(control('token-details-table').textContent).toContain('No tokens in wallet');
  app!.unmount(); app = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('validates joins, clears errors on input and preserves encoded navigation', async () => {
  mount(); await click('join-btn');
  expect(control('join-error').textContent).toBe('Please enter a session ID.');
  expect(navigate).not.toHaveBeenCalled();
  sessionStorage.setItem('streaming_session', 'old');
  await input('session-id-input', ' room/a &b ');
  control('session-id-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(navigate).toHaveBeenCalledWith('/room.html?session=room%2Fa%20%26b');
  expect(sessionStorage.getItem('streaming_session')).toBeNull();
  await click('start-streaming-btn');
  expect(navigate).toHaveBeenLastCalledWith('/room.html');
});

it('renders untrusted invite text without HTML and saves pending_join', async () => {
  const invite = { sessionId: 'abc', rateSatsPerInterval: 2, intervalSeconds: 60, mintUrl: '<img src=x onerror=alert(1)>' };
  mount(`?join=${encodeURIComponent(btoa(JSON.stringify(invite)))}`);
  expect(control('invite-json').textContent).toContain(invite.mintUrl);
  expect(control('invite-json').querySelector('img')).toBeNull();
  await click('invite-join-btn');
  expect(JSON.parse(sessionStorage.getItem('pending_join')!)).toEqual(invite);
  expect(navigate).toHaveBeenCalledWith('/room.html?session=abc');
});

it('rejects malformed invites and focuses manual join', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mount('?join=invalid'); await click('invite-join-btn');
  expect(control('invite-decode-error').textContent).toContain('Failed to decode');
  expect(control('join-error').textContent).toContain('Please enter the session ID manually');
  expect(document.activeElement).toBe(control('session-id-input'));
  expect(navigate).not.toHaveBeenCalled();
});

it('validates deposit input, displays invoice, celebrates payment and resets', async () => {
  vi.useFakeTimers();
  let finish!: (result: 'paid') => void;
  vi.mocked(wallet.deposit).mockImplementation((_amount, onInvoice) => {
    onInvoice('lnbc-test'); return new Promise(resolve => { finish = resolve; });
  });
  mount(); await click('deposit-btn'); await click('deposit-generate-btn');
  expect(control('deposit-status').textContent).toBe('Please enter a valid amount.');
  expect(wallet.deposit).not.toHaveBeenCalled();
  await input('deposit-amount-input', '16'); await click('deposit-generate-btn');
  expect(control('deposit-invoice-text').textContent).toBe('lnbc-test');
  expect(QRCode.toCanvas).toHaveBeenCalledWith(control('deposit-qr-canvas'), 'lightning:lnbc-test', { width: 220 });
  expect(control('deposit-status').textContent).toContain('Waiting for payment');
  finish('paid'); await flush();
  expect(control('deposit-status').textContent).toBe('Deposited 16 S!');
  expect(control('deposit-success-area').classList.contains('is-visible')).toBe(true);
  await vi.advanceTimersByTimeAsync(8_000); await flush();
  expect(control('deposit-status').textContent).toBe('');
});

it('focuses the deposit amount on open/reset and the withdrawal invoice on open', async () => {
  mount();
  await click('deposit-btn');
  expect(document.activeElement).toBe(control('deposit-amount-input'));

  control('deposit-reset-btn').focus();
  await click('deposit-reset-btn');
  expect(document.activeElement).toBe(control('deposit-amount-input'));

  await click('deposit-close-btn');
  await click('withdraw-btn');
  expect(document.activeElement).toBe(control('withdraw-invoice-input'));
});

it('measures the deposit panel, draws confetti on its canvas and cancels animation on close', async () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  const requestFrame = vi.fn<(callback: FrameRequestCallback) => number>().mockReturnValue(17);
  const cancelFrame = vi.fn();
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);

  const context = {
    clearRect: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    restore: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
  };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);

  try {
    mount();
    Object.defineProperties(control('deposit-panel'), {
      offsetWidth: { value: 400 },
      offsetHeight: { value: 500 },
    });
    await click('deposit-btn');
    await input('deposit-amount-input', '16');
    await click('deposit-generate-btn');

    const canvas = root.querySelector<HTMLCanvasElement>('.deposit-confetti-canvas')!;
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(500);
    expect(getContext.mock.contexts).toContain(canvas);

    requestFrame.mock.calls[0]![0](performance.now());
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 400, 500);
    expect(context.fillRect).toHaveBeenCalledTimes(40);

    await click('deposit-close-btn');
    expect(cancelFrame).toHaveBeenCalledWith(17);
    expect(root.querySelector('.deposit-confetti-canvas')).toBeNull();
  } finally {
    getContext.mockRestore();
  }
});

it('shows escaped deposit failures and allows retry', async () => {
  vi.mocked(wallet.deposit).mockRejectedValue(new Error('Failed to generate invoice: <img src=x>'));
  mount(); await click('deposit-btn'); await input('deposit-amount-input', '16'); await click('deposit-generate-btn');
  expect(control('deposit-status').textContent).toContain('<img src=x>');
  expect(control('deposit-status').querySelector('img')).toBeNull();
  expect(control<HTMLButtonElement>('deposit-generate-btn').disabled).toBe(false);
});

it.each(['close', 'reset', 'escape', 'unmount'])('aborts deposit observation on %s and ignores late completion', async action => {
  let signal!: AbortSignal;
  let finish!: (result: 'paid') => void;
  vi.mocked(wallet.deposit).mockImplementation((_amount, _invoice, s) => {
    signal = s; return new Promise(resolve => { finish = resolve; });
  });
  mount(); await click('deposit-btn'); await input('deposit-amount-input', '16'); await click('deposit-generate-btn');
  if (action === 'unmount') { app!.unmount(); app = undefined; }
  else if (action === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  else await click(`deposit-${action}-btn`);
  expect(signal.aborted).toBe(true);
  finish('paid'); await flush();
  if (action !== 'unmount') expect(control('deposit-success-area').classList.contains('is-visible')).toBe(false);
});

it.each(['success', 'error'] as const)('withdraws through the application contract and renders %s', async variant => {
  const result: WalletStatus = { variant, message: variant === 'success' ? 'Payment sent!' : 'Payment failed: offline — proofs returned to wallet.' };
  vi.mocked(wallet.withdraw).mockResolvedValue(result);
  mount(); await click('withdraw-btn');
  expect(control('withdraw-max-estimate').textContent).toContain('~29');
  await click('withdraw-pay-btn');
  expect(control('withdraw-status').textContent).toBe('Please paste a Lightning invoice.');
  await input('withdraw-invoice-input', ' lnbc-test '); await click('withdraw-pay-btn');
  expect(wallet.withdraw).toHaveBeenCalledWith('lnbc-test', expect.any(Function));
  expect(control('withdraw-status').textContent).toBe(result.message);
  expect(control<HTMLButtonElement>('withdraw-pay-btn').disabled).toBe(variant === 'success');
  expect(control<HTMLTextAreaElement>('withdraw-invoice-input').value).toBe(variant === 'success' ? '' : ' lnbc-test ');
});

it('preserves the original ID order and top-level layout without a wrapper', () => {
  mount();
  expect(root.firstElementChild?.tagName).toBe('H1');
  expect([...root.querySelectorAll('[id]')].map(element => element.id)).toEqual([
    'wallet-widget', 'balance-display', 'deposit-btn', 'withdraw-btn',
    'token-details-wrapper', 'token-details-toggle', 'token-details-panel', 'token-details-table', 'token-details-summary',
    'withdraw-panel', 'withdraw-max-estimate', 'withdraw-invoice-input', 'withdraw-status', 'withdraw-pay-btn', 'withdraw-close-btn',
    'invite-panel', 'invite-decode-error', 'invite-json', 'invite-join-btn', 'start-streaming-btn',
    'join-form', 'session-id-input', 'join-btn', 'join-error', 'session-history-section', 'session-history-list',
    'deposit-overlay', 'deposit-panel', 'deposit-panel-title', 'deposit-amount-row', 'deposit-amount-input', 'deposit-generate-btn',
    'deposit-invoice-area', 'deposit-qr-canvas', 'deposit-invoice-text', 'deposit-copy-btn',
    'deposit-success-area', 'deposit-checkmark', 'deposit-status', 'deposit-reset-countdown',
    'deposit-footer', 'deposit-reset-btn', 'deposit-close-btn',
  ]);
  expect(root.querySelector('footer a')?.getAttribute('href')).toBe('/about.html');
  expect(control('session-history-list').textContent).toBe('No sessions yet.');
});

it('displays expiry and reenables deposit controls', async () => {
  vi.mocked(wallet.deposit).mockResolvedValue('expired');
  mount(); await click('deposit-btn'); await input('deposit-amount-input', '16'); await click('deposit-generate-btn');
  expect(control('deposit-status').textContent).toBe('Invoice expired — please try again.');
  expect(control<HTMLButtonElement>('deposit-generate-btn').disabled).toBe(false);
});

it('copies invoices and estimates and clears timers and Escape listener on unmount', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const removeListener = vi.spyOn(document, 'removeEventListener');
  vi.mocked(wallet.deposit).mockImplementation((_amount, invoice) => {
    invoice('lnbc-test'); return new Promise(() => {});
  });
  mount(); await click('withdraw-btn');
  root.querySelector<HTMLButtonElement>('.copy-amount-btn')!.click(); await flush();
  expect(writeText).toHaveBeenCalledWith('29');
  await click('deposit-btn'); await input('deposit-amount-input', '16'); await click('deposit-generate-btn');
  await click('deposit-copy-btn');
  expect(writeText).toHaveBeenCalledWith('lnbc-test');
  expect(control('deposit-copy-btn').textContent).toBe('Copied!');
  app!.unmount(); app = undefined;
  // Drain DOM/framework microtasks; the clipboard reset timers must be gone.
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  removeListener.mockRestore();
});

it('ignores an estimate that resolves after closing and reopening', async () => {
  let finish!: (value: { maxAmount: number; balance: number; inputFee: number; lightningBuffer: number }) => void;
  vi.mocked(wallet.estimateWithdrawal).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mount(); await click('withdraw-btn'); await click('withdraw-close-btn'); await click('withdraw-btn');
  expect(control('withdraw-max-estimate').textContent).toContain('~29');
  finish({ maxAmount: 999, balance: 1000, inputFee: 0, lightningBuffer: 1 }); await flush();
  expect(control('withdraw-max-estimate').textContent).toContain('~29');
});

it('does not submit another payment while a closed-panel withdrawal settles', async () => {
  let finish!: (value: WalletStatus) => void;
  vi.mocked(wallet.withdraw).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount(); await click('withdraw-btn'); await input('withdraw-invoice-input', 'lnbc-test'); await click('withdraw-pay-btn');
  await click('withdraw-close-btn'); await click('withdraw-btn');
  await input('withdraw-invoice-input', 'lnbc-next'); await click('withdraw-pay-btn');
  expect(wallet.withdraw).toHaveBeenCalledOnce();
  finish({ variant: 'success', message: 'Payment sent!' }); await flush();
  expect(control('withdraw-status').textContent).toBe('');
  expect(control<HTMLTextAreaElement>('withdraw-invoice-input').value).toBe('lnbc-next');
  expect(control<HTMLButtonElement>('withdraw-pay-btn').disabled).toBe(false);
});
