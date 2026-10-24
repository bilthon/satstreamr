import { getDecodedToken, getEncodedToken } from '@cashu/cashu-ts';
import { buildWallet, checkTokenState, claimProofs, getMeltQuote, meltTokens, preSplitProofs } from '../lib/cashu-wallet.js';
import { addProofs, getBalance, getProofs, onBalanceChange, spendProofs } from '../lib/wallet-store.js';
import { getMintUrl } from '../lib/config.js';
import { PaymentScheduler } from '../lib/payment-scheduler.js';
import type { ReceiptCallbacks, SessionReceiver, SessionSender, SessionWallet } from './session-payments.js';
export { MintMismatchError, assertSameMint as validateCashuSessionMint } from '../lib/mint-guard.js';

/** Cashu composition: shared session callers never select proofs or encode tokens. */
export function createCashuSender(): SessionSender {
  const mintUrl = getMintUrl();
  return {
    getBalance,
    onBalanceChange,
    prepare: amount => preSplitProofs(amount, getBalance()),
    createSession: (transport, options) => new PaymentScheduler(transport, {
      getBalance,
      preparePayment: amount => {
        const proofs = spendProofs(amount);
        return getEncodedToken({ mint: mintUrl, proofs, unit: 'sat' });
      },
    }, options),
  };
}

/** The snapshot and quote closures keep proofs and quote IDs out of session UI. */
export function createCashuWallet(): SessionWallet {
  return {
    async estimateReceiptFee() {
      const { feePpk } = await buildWallet();
      return feePpk === 0 ? 0 : Math.max(1, Math.ceil(feePpk / 1000));
    },
    createCashOut() {
      const proofs = getProofs();
      return {
        hasFunds: proofs.length > 0,
        async quote(invoice) {
          const quote = await getMeltQuote(invoice, proofs);
          const totalNeeded = quote.amount + quote.fee_reserve + quote.inputFee;
          const proofTotal = proofs.reduce((sum, proof) => sum + proof.amount, 0);
          if (proofTotal < totalNeeded) {
            throw new Error(
              `Insufficient proofs — have ${proofTotal}, need ${totalNeeded} (${quote.amount} + ${quote.fee_reserve} fee + ${quote.inputFee} input fee).`,
            );
          }
          return {
            amount: quote.amount,
            feeReserve: quote.fee_reserve,
            inputFee: quote.inputFee,
            async pay() {
              const result = await meltTokens(invoice, quote.quote, proofs);
              const changeSats = result.paid
                ? result.change.reduce((sum, proof) => sum + proof.amount, 0)
                : 0;
              // Preserve existing cash-out accounting: append paid change only.
              if (result.paid && result.change.length > 0) addProofs(result.change);
              return { paid: result.paid, changeSats };
            },
          };
        },
      };
    },
  };
}

export function createCashuReceiver(callbacks: ReceiptCallbacks): SessionReceiver {
  let lastSeenChunkId = -1;
  return {
    reset() { lastSeenChunkId = -1; },
    async receive(chunkId, encodedToken) {
      if (chunkId <= lastSeenChunkId) {
        console.warn(`[payment] duplicate/out-of-order chunk #${chunkId} (last seen: ${lastSeenChunkId}) -- nack`);
        callbacks.sendMessage({ type: 'payment_nack', chunkId, reason: 'duplicate_chunk_id' });
        return;
      }

      let proofs: ReturnType<typeof getDecodedToken>['proofs'];
      try {
        proofs = getDecodedToken(encodedToken).proofs;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[payment] failed to decode token for chunk #${chunkId}:`, reason);
        callbacks.sendMessage({ type: 'payment_nack', chunkId, reason: `decode_error: ${reason}` });
        return;
      }

      try {
        const state = await checkTokenState(proofs);
        if (state === 'spent') {
          console.warn(`[payment] chunk #${chunkId} already spent -- nack`);
          callbacks.sendMessage({ type: 'payment_nack', chunkId, reason: 'double_spend' });
          return;
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[payment] checkTokenState failed for chunk #${chunkId}:`, reason);
        callbacks.sendMessage({ type: 'payment_nack', chunkId, reason: `state_check_error: ${reason}` });
        return;
      }

      // Deliberately no serialization: preserve the existing concurrent receipt behavior.
      try {
        const { newProofs } = await claimProofs(proofs);
        lastSeenChunkId = chunkId;
        console.log(`[payment] ack #${chunkId}`);
        callbacks.sendMessage({ type: 'payment_ack', chunkId });
        // Receipt totals are net of mint fees; viewer debits remain nominal.
        callbacks.onReceived(newProofs.reduce((sum, proof) => sum + proof.amount, 0));
        addProofs(newProofs);
        callbacks.onReady();
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[payment] claimProofs failed for chunk #${chunkId}:`, reason);
        callbacks.sendMessage({ type: 'payment_nack', chunkId, reason });
      }
    },
  };
}
