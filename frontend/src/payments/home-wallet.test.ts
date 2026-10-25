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

  it('cancels polling and never mints a late paid check', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { paid: boolean }) => void;
    vi.mocked(deposit.checkMintQuote).mockReturnValue(new Promise(r => { resolve = r; }));
    const controller = new AbortController();
    const pending = cashuHomeWallet.deposit(16, vi.fn(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');
    resolve({ paid: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deposit.checkMintQuote).toHaveBeenCalledOnce();
    expect(deposit.mintProofsFromQuote).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries transient polling failures and expires after ten minutes', async () => {
    vi.useFakeTimers();
    vi.mocked(deposit.checkMintQuote).mockRejectedValue(new Error('offline'));
    const pending = cashuHomeWallet.deposit(16, vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(600_000);
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
