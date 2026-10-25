import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cashuHomeWallet } from './cashu-home-wallet.js';
import * as store from '../lib/wallet-store.js';
import * as cashu from '../lib/cashu-wallet.js';
import * as deposit from '../lib/deposit.js';

vi.mock('../lib/wallet-store.js', () => ({
  getBalance: vi.fn(), getProofs: vi.fn(), onBalanceChange: vi.fn(),
  spendProofs: vi.fn(), addProofs: vi.fn(),
}));
vi.mock('../lib/cashu-wallet.js', () => ({
  getMeltQuote: vi.fn(), meltTokens: vi.fn(), estimateMaxWithdrawable: vi.fn(),
}));
vi.mock('../lib/deposit.js', () => ({
  requestMintQuote: vi.fn(), checkMintQuote: vi.fn(), mintProofsFromQuote: vi.fn(),
}));
const proof = { amount: 16, id: 'test', secret: 'fake', C: 'fake' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(store.getBalance).mockReturnValue(32);
  vi.mocked(store.getProofs).mockReturnValue([proof, { ...proof, secret: 'fake2' }]);
  vi.mocked(store.spendProofs).mockReturnValue([proof]);
  vi.mocked(cashu.getMeltQuote).mockResolvedValue({ quote: 'q', amount: 10, fee_reserve: 2, inputFee: 1 });
  vi.mocked(cashu.meltTokens).mockResolvedValue({ paid: true, change: [], payment_preimage: null });
  vi.mocked(deposit.requestMintQuote).mockResolvedValue({ quote: 'q', invoice: 'lnbc-test' });
  vi.mocked(deposit.checkMintQuote).mockResolvedValue({ paid: true });
  vi.mocked(deposit.mintProofsFromQuote).mockResolvedValue([proof]);
});
afterEach(() => vi.useRealTimers());

describe('home Cashu application contract', () => {
  it('exposes denomination summaries, not bearer proofs, and unsubscribe', () => {
    const unsubscribe = vi.fn();
    vi.mocked(store.onBalanceChange).mockReturnValue(unsubscribe);
    expect(cashuHomeWallet.snapshot()).toEqual({ balance: 32, cashu: {
      denominations: [{ amount: 16, count: 2, subtotal: 32 }], proofCount: 2,
    } });
    const listener = vi.fn();
    cashuHomeWallet.subscribe(listener)();
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.mocked(store.onBalanceChange).mock.calls[0]![0](32);
    expect(listener).toHaveBeenCalledWith(cashuHomeWallet.snapshot());
  });

  it('deposits through quote, payment check and mint storage helper', async () => {
    const invoice = vi.fn();
    await expect(cashuHomeWallet.deposit(16, invoice, new AbortController().signal)).resolves.toBe('paid');
    expect(invoice).toHaveBeenCalledWith('lnbc-test');
    expect(deposit.mintProofsFromQuote).toHaveBeenCalledWith('q', 16);
  });

  it.each(['quote', 'mint'])('reports %s failure with its original stage', async stage => {
    if (stage === 'quote') vi.mocked(deposit.requestMintQuote).mockRejectedValue(new Error('offline'));
    else vi.mocked(deposit.mintProofsFromQuote).mockRejectedValue(new Error('offline'));
    await expect(cashuHomeWallet.deposit(16, vi.fn(), new AbortController().signal))
      .rejects.toThrow(stage === 'quote' ? 'Failed to generate invoice: offline' : 'Deposit confirmed but minting failed: offline');
  });

  it('credits a late paid check once after view cancellation and clears polling timers', async () => {
    vi.useFakeTimers();
    vi.mocked(store.addProofs).mockImplementation(proofs => {
      vi.mocked(store.getBalance).mockReturnValue(store.getBalance() + proofs.reduce((sum, p) => sum + p.amount, 0));
    });
    vi.mocked(deposit.mintProofsFromQuote).mockImplementation(async () => {
      store.addProofs([proof]);
      return [proof];
    });
    let resolve!: (value: { paid: boolean }) => void;
    vi.mocked(deposit.checkMintQuote).mockReturnValue(new Promise(r => { resolve = r; }));
    const controller = new AbortController();
    const pending = cashuHomeWallet.deposit(16, vi.fn(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    resolve({ paid: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deposit.mintProofsFromQuote).toHaveBeenCalledExactlyOnceWith('q', 16);
    expect(store.addProofs).toHaveBeenCalledExactlyOnceWith([proof]);
    expect(cashuHomeWallet.snapshot().balance).toBe(48);
    await expect(pending).resolves.toBe('paid');
    expect(deposit.checkMintQuote).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses a late invoice but completes the quote requested before view cancellation', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { quote: string; invoice: string }) => void;
    vi.mocked(deposit.requestMintQuote).mockReturnValue(new Promise(r => { resolve = r; }));
    vi.mocked(deposit.checkMintQuote).mockResolvedValueOnce({ paid: false });
    const invoice = vi.fn();
    const controller = new AbortController();
    const pending = cashuHomeWallet.deposit(16, invoice, controller.signal);
    controller.abort();
    resolve({ quote: 'q', invoice: 'lnbc-test' });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe('paid');
    expect(invoice).not.toHaveBeenCalled();
    expect(deposit.checkMintQuote).toHaveBeenCalledTimes(2);
    expect(deposit.mintProofsFromQuote).toHaveBeenCalledExactlyOnceWith('q', 16);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not submit a pre-aborted deposit', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(cashuHomeWallet.deposit(16, vi.fn(), controller.signal)).resolves.toBe('cancelled');
    expect(deposit.requestMintQuote).not.toHaveBeenCalled();
    expect(deposit.mintProofsFromQuote).not.toHaveBeenCalled();
  });

  it('retries transient polling failures after view cancellation and expires after ten minutes', async () => {
    vi.useFakeTimers();
    vi.mocked(deposit.checkMintQuote).mockRejectedValue(new Error('offline'));
    const controller = new AbortController();
    const pending = cashuHomeWallet.deposit(16, vi.fn(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(vi.mocked(deposit.checkMintQuote).mock.calls.length).toBeGreaterThan(1);
    await expect(pending).resolves.toBe('expired');
    expect(deposit.mintProofsFromQuote).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('selects quote plus fees and adds only paid change', async () => {
    vi.mocked(cashu.meltTokens).mockResolvedValue({ paid: true, change: [{ ...proof, amount: 2 }], payment_preimage: null });
    const progress = vi.fn();
    expect(await cashuHomeWallet.withdraw('lnbc-test', progress)).toEqual({
      variant: 'success', message: 'Payment sent! (2 sats fee change returned)',
    });
    expect(store.spendProofs).toHaveBeenCalledWith(13);
    expect(cashu.meltTokens).toHaveBeenCalledWith('lnbc-test', 'q', [proof]);
    expect(store.addProofs).toHaveBeenCalledExactlyOnceWith([{ ...proof, amount: 2 }]);
  });

  it.each([false, true])('restores selected proofs on unpaid or thrown melt (%s)', async throws => {
    if (throws) vi.mocked(cashu.meltTokens).mockRejectedValue(new Error('offline'));
    else vi.mocked(cashu.meltTokens).mockResolvedValue({ paid: false, change: [], payment_preimage: null });
    expect((await cashuHomeWallet.withdraw('lnbc-test', vi.fn())).variant).toBe('error');
    expect(store.addProofs).toHaveBeenCalledExactlyOnceWith([proof]);
  });

  it('does not select proofs when quote fails or balance cannot cover fees', async () => {
    vi.mocked(store.getBalance).mockReturnValue(12);
    expect(await cashuHomeWallet.withdraw('lnbc-test', vi.fn())).toEqual({
      variant: 'warning', message: 'Balance too low for this invoice. Try requesting ~9 sats instead.',
    });
    vi.mocked(cashu.getMeltQuote).mockRejectedValue(new Error('offline'));
    expect((await cashuHomeWallet.withdraw('lnbc-test', vi.fn())).message).toBe('Failed to get quote: offline');
    expect(store.spendProofs).not.toHaveBeenCalled();
  });
});
