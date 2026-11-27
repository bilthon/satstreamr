import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCashuWallet } from './cashu-session-payments.js';
import { addProofs, getBalance, getProofs, onBalanceChange, setProofs } from '../lib/wallet-store.js';

const sdk = vi.hoisted(() => ({ quote: vi.fn(), melt: vi.fn(), load: vi.fn(), feePpk: 500 }));
vi.mock('@cashu/cashu-ts', () => ({
  getEncodedToken: vi.fn(),
  getDecodedToken: vi.fn(),
  CashuMint: class {},
  CashuWallet: class {
    keysets = [{ active: true, unit: 'sat', id: 'key', input_fee_ppk: sdk.feePpk }];
    loadMint = sdk.load;
    getKeys = async () => ({});
    getFeesForProofs = () => 1;
    createMeltQuote = sdk.quote;
    meltProofs = sdk.melt;
  },
}));
const proof = (amount: number) => ({ amount, id: 'key', secret: `secret-${amount}`, C: 'point' });

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  sdk.feePpk = 500;
  sdk.load.mockReset().mockResolvedValue(undefined);
  sdk.quote.mockReset().mockResolvedValue({ quote: 'quote-id', amount: 10, fee_reserve: 2 });
  sdk.melt.mockReset().mockResolvedValue({ quote: { state: 'PAID' }, change: [proof(2)] });
});
afterEach(() => vi.unstubAllGlobals());

describe('session wallet', () => {
  it('rejects an unaffordable quote with the existing exact reason and no wallet effects', async () => {
    setProofs([proof(12)]);
    const cashOut = createCashuWallet().createCashOut();
    await expect(cashOut.quote('invoice')).rejects.toThrow(
      'Insufficient proofs — have 12, need 13 (10 + 2 fee + 1 input fee).',
    );
    expect(getBalance()).toBe(12);
    expect(sdk.melt).not.toHaveBeenCalled();
  });
  it('captures empty readiness without picking up later deposits', () => {
    const cashOut = createCashuWallet().createCashOut();
    addProofs([proof(20)]);
    expect(cashOut.hasFunds).toBe(false);
    expect(createCashuWallet().createCashOut().hasFunds).toBe(true);
    expect(sdk.quote).not.toHaveBeenCalled();
  });

  it.each(['quote', 'refetch', 'melt', 'unpaid'])('preserves wallet accounting for %s', async failure => {
    setProofs([proof(20)]);
    const cashOut = createCashuWallet().createCashOut();
    const changes: number[] = [];
    const unsubscribe = onBalanceChange(balance => changes.push(balance));
    if (failure === 'quote') {
      sdk.quote.mockRejectedValue(new Error('quote unavailable'));
      await expect(cashOut.quote('invoice')).rejects.toThrow('quote unavailable');
      expect(sdk.melt).not.toHaveBeenCalled();
    } else {
      const quote = await cashOut.quote('invoice');
      if (failure === 'refetch') {
        sdk.quote.mockRejectedValue(new Error('quote expired'));
        await expect(quote.pay()).rejects.toThrow('quote expired');
        expect(sdk.melt).not.toHaveBeenCalled();
      } else if (failure === 'melt') {
        sdk.melt.mockRejectedValue(new Error('payment failed'));
        await expect(quote.pay()).rejects.toThrow('payment failed');
      } else {
        sdk.melt.mockResolvedValue({ quote: { state: 'UNPAID' }, change: [proof(2)] });
        expect(await quote.pay()).toEqual({ paid: false, changeSats: 0 });
      }
    }
    unsubscribe();
    expect(changes).toEqual([]);
    expect(getProofs()).toEqual([proof(20)]);
  });

  it.each([[0, 0], [1, 1], [1000, 1], [1001, 2]])('estimates receipt fee for %s ppk', async (ppk, fee) => {
    sdk.feePpk = ppk;
    expect(await createCashuWallet().estimateReceiptFee()).toBe(fee);
    expect(getBalance()).toBe(0);
  });

  it('propagates fee lookup failure without changing wallet funds', async () => {
    sdk.load.mockRejectedValue(new Error('mint offline'));
    await expect(createCashuWallet().estimateReceiptFee()).rejects.toThrow('mint offline');
    expect(getBalance()).toBe(0);
  });

  it('replaces the captured proofs with the mint change and keeps funds received after the snapshot', async () => {
    setProofs([proof(20)]);
    const cashOut = createCashuWallet().createCashOut();
    expect(cashOut.hasFunds).toBe(true);
    addProofs([proof(5)]);
    const changes: number[] = [];
    const unsubscribe = onBalanceChange(balance => changes.push(balance));
    const quote = await cashOut.quote('invoice');
    expect(quote).toMatchObject({ amount: 10, feeReserve: 2, inputFee: 1 });
    expect(changes).toEqual([]);
    sdk.quote.mockResolvedValue({ quote: 'fresh-id', amount: 11, fee_reserve: 2 });
    expect(await quote.pay()).toEqual({ paid: true, changeSats: 2 });
    unsubscribe();
    expect(sdk.quote).toHaveBeenCalledTimes(2);
    expect(sdk.melt).toHaveBeenCalledWith({ quote: 'fresh-id', amount: 11, fee_reserve: 2 }, [proof(20)]);
    expect(getProofs()).toEqual([proof(5), proof(2)]);
    expect(getBalance()).toBe(7);
  });

  it('explains the melt fee and lightning reserve for the captured balance', async () => {
    setProofs([proof(14)]);
    const limit = await createCashuWallet().createCashOut().explain();
    expect(limit).toEqual({ balance: 14, inputFee: 1, lightningBuffer: 2, maxAmount: 11 });
  });

  it('drops the captured proofs when the mint pays and returns no change', async () => {
    setProofs([proof(20)]);
    const quote = await createCashuWallet().createCashOut().quote('invoice');
    sdk.melt.mockResolvedValue({ quote: { state: 'PAID' }, change: [] });
    expect(await quote.pay()).toEqual({ paid: true, changeSats: 0 });
    expect(getProofs()).toEqual([]);
    expect(getBalance()).toBe(0);
  });
});
