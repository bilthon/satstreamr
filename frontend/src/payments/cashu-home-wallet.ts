import { getBalance, getProofs, onBalanceChange, spendProofs, addProofs } from '../lib/wallet-store.js';
import { estimateMaxWithdrawable, getMeltQuote, meltTokens } from '../lib/cashu-wallet.js';
import { requestMintQuote, checkMintQuote, mintProofsFromQuote } from '../lib/deposit.js';
import type { HomeWallet, HomeWalletSnapshot, WalletStatus } from './home-wallet.js';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function snapshot(): HomeWalletSnapshot {
  const proofs = getProofs();
  const groups = new Map<number, number>();
  for (const proof of proofs) groups.set(proof.amount, (groups.get(proof.amount) ?? 0) + 1);
  return {
    balance: getBalance(),
    cashu: {
      proofCount: proofs.length,
      denominations: [...groups].sort(([a], [b]) => a - b).map(([amount, count]) => ({
        amount, count, subtotal: amount * count,
      })),
    },
  };
}

/** Same cadence, timeout and transient-error policy as deposit.pollForPayment,
 * but cancellable without changing that helper's existing room callers.
 * An in-flight read may finish; it cannot schedule more polls or mint after abort.
 */
function waitForPayment(quote: string, signal: AbortSignal): Promise<'paid' | 'expired' | 'cancelled'> {
  return new Promise(resolve => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => finish('expired'), 600_000);
    function finish(result: 'paid' | 'expired' | 'cancelled'): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(pollTimer);
      signal.removeEventListener('abort', cancel);
      resolve(result);
    }
    function cancel(): void { finish('cancelled'); }
    async function poll(): Promise<void> {
      try {
        const { paid } = await checkMintQuote(quote);
        if (settled) return;
        if (paid) { finish('paid'); return; }
      } catch { /* Preserve retry on transient network errors. */ }
      if (!settled) pollTimer = setTimeout(() => { void poll(); }, 3_000);
    }
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else void poll();
  });
}

export const cashuHomeWallet: HomeWallet = {
  snapshot,
  subscribe: listener => onBalanceChange(() => listener(snapshot())),
  estimateWithdrawal: estimateMaxWithdrawable,
  async deposit(amount, onInvoice, signal) {
    if (signal.aborted) return 'cancelled';
    let quote;
    try { quote = await requestMintQuote(amount); }
    catch (error) { throw new Error(`Failed to generate invoice: ${message(error)}`); }
    if (signal.aborted) return 'cancelled';
    onInvoice(quote.invoice);
    const result = await waitForPayment(quote.quote, signal);
    if (signal.aborted) return 'cancelled';
    if (result !== 'paid') return result;
    // Do not abort monetary settlement once submitted. The UI ignores late results.
    try { await mintProofsFromQuote(quote.quote, amount); }
    catch (error) { throw new Error(`Deposit confirmed but minting failed: ${message(error)}`); }
    return 'paid';
  },
  async withdraw(invoice, onProgress) {
    const status = (message: string, variant: WalletStatus['variant']): WalletStatus => ({ message, variant });
    let quote;
    try {
      onProgress(status('Fetching quote…', 'info'));
      quote = await getMeltQuote(invoice);
    } catch (error) { return status(`Failed to get quote: ${message(error)}`, 'error'); }
    const total = quote.amount + quote.fee_reserve + quote.inputFee;
    const balance = getBalance();
    if (balance < total) {
      const suggested = balance - quote.fee_reserve - quote.inputFee;
      return suggested > 0
        ? status(`Balance too low for this invoice. Try requesting ~${suggested} sats instead.`, 'warning')
        : status('Balance too low to cover fees.', 'error');
    }
    let selected;
    try { selected = spendProofs(total); }
    catch (error) { return status(`Insufficient balance — ${message(error)}`, 'error'); }
    try {
      onProgress(status('Paying…', 'info'));
      const result = await meltTokens(invoice, quote.quote, selected);
      if (result.paid) {
        const changeSats = result.change.reduce((sum, proof) => sum + proof.amount, 0);
        if (result.change.length > 0) addProofs(result.change);
        return status(`Payment sent!${changeSats > 0 ? ` (${changeSats} sats fee change returned)` : ''}`, 'success');
      }
      addProofs(selected);
      return status('Payment did not complete — proofs returned to wallet. Please try again.', 'error');
    } catch (error) {
      addProofs(selected);
      return status(`Payment failed: ${message(error)} — proofs returned to wallet.`, 'error');
    }
  },
};
