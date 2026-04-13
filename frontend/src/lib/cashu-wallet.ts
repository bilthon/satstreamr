/**
 * cashu-wallet.ts
 *
 * Browser-targeted Cashu wallet module for satstreamr.
 *
 * Wraps @cashu/cashu-ts to provide the Cashu operations needed by the
 * payment flow:
 *   - preSplitProofs  — NUT-03 swap that pre-splits proofs into exact-denomination chunks
 *   - claimProofs     — NUT-03 plain swap to claim received proofs (tutor side)
 *   - checkTokenState — NUT-07 proof state query
 *
 * The mint URL is resolved via getMintUrl() from lib/config.ts: it prefers
 * VITE_MINT_URL when set, otherwise uses the Vite proxy path /mint so the
 * app works on both localhost and LAN without manual configuration.
 *
 * ARCHITECTURE NOTE: Lightning is used only for deposit (fund wallet) and
 * withdraw (cash out). Streaming micropayments use Cashu swaps — fast,
 * reliable, ~50-200ms, no Lightning round-trip in the payment loop.
 */

import { CashuMint, CashuWallet } from '@cashu/cashu-ts';
import type { Proof, MintKeys } from '../types/cashu.js';
import { getMintUrl } from './config.js';
import { spendProofs, addProofs, getProofs } from './wallet-store.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DLEQVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DLEQVerificationError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Builds a connected, key-loaded CashuWallet for the sat unit. */
export async function buildWallet(): Promise<{
  wallet: CashuWallet;
  mintKeys: MintKeys;
  feePpk: number;
}> {
  const mint = new CashuMint(getMintUrl());
  const wallet = new CashuWallet(mint, { unit: 'sat' });
  await wallet.loadMint();

  const activeKeyset = wallet.keysets.find((ks) => ks.active && ks.unit === 'sat');
  if (!activeKeyset) {
    throw new Error('No active sat keyset found on mint');
  }

  const mintKeys = await wallet.getKeys(activeKeyset.id);
  const feePpk = activeKeyset.input_fee_ppk ?? 0;

  return { wallet, mintKeys, feePpk };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-splits wallet proofs into exact `chunkSats`-denominated proofs.
 *
 * Executes a single NUT-03 swap with `outputAmounts.sendAmounts` set to an
 * array of `numChunks` entries each equal to `chunkSats`. This ensures every
 * per-tick payment is a synchronous proof selection with no HTTP call.
 *
 * The viewer pays no redemption fee — the tutor bears the fee when claiming.
 *
 * @param chunkSats    The exact denomination each payment chunk should be.
 * @param totalBudget  The total wallet balance available for the session.
 * @returns The number of payment chunks created.
 */
export async function preSplitProofs(
  chunkSats: number,
  totalBudget: number
): Promise<number> {
  const { wallet } = await buildWallet();

  // Probe the fee by estimating against all available proofs.
  // wallet.getFeesForProofs() is a pure local calculation — no network call.
  const allProofs = getProofs();
  const probeFee = wallet.getFeesForProofs(allProofs);

  // Subtract the fee headroom before calculating how many chunks fit.
  const spendable = totalBudget - probeFee;
  if (spendable < chunkSats) {
    throw new Error(
      `Insufficient balance after fees: ${totalBudget} sats available, ` +
      `${probeFee} sat fee, need at least ${chunkSats} sats`
    );
  }

  const numChunks = Math.floor(spendable / chunkSats);
  const totalAmount = numChunks * chunkSats;

  // Check if we already have enough exact-denomination proofs.
  const exactMatch = allProofs.filter((p) => p.amount === chunkSats);
  if (exactMatch.length >= numChunks) {
    return numChunks; // Already pre-split, skip the swap.
  }

  // Select inputs. The fee was already subtracted from numChunks so
  // totalAmount + probeFee should fit within totalBudget.
  const inputProofs = spendProofs(totalAmount + probeFee);

  try {
    const result = await wallet.swap(totalAmount, inputProofs, {
      outputAmounts: {
        sendAmounts: Array(numChunks).fill(chunkSats) as number[],
      },
    });
    addProofs(result.send);
    if (result.keep.length > 0) addProofs(result.keep);
    return numChunks;
  } catch (err) {
    addProofs(inputProofs); // rollback
    throw err;
  }
}

/**
 * Claims plain unlocked Cashu proofs by performing a NUT-03 swap.
 *
 * No private key or P2PK signature required — the proofs are plain unlocked
 * tokens. The tutor calls this to convert received proofs into fresh ones.
 * The swap fee is borne by the tutor (deducted from `receiveAmount`).
 *
 * @param proofs  Plain unlocked proofs received from the viewer.
 * @returns `{ success: true, newProofs }` on successful claim.
 */
export async function claimProofs(
  proofs: Proof[]
): Promise<{ success: boolean; newProofs: Proof[] }> {
  const { wallet } = await buildWallet();

  const totalAmount = proofs.reduce((s, p) => s + p.amount, 0);
  const fee = wallet.getFeesForProofs(proofs);
  const receiveAmount = totalAmount - fee;

  if (receiveAmount <= 0) {
    throw new Error(
      `Proof total (${totalAmount}) cannot cover swap fee (${fee})`
    );
  }

  // Plain swap — no privkey, no P2PK.
  const swapResult = await wallet.swap(receiveAmount, proofs);

  const newProofs = [...swapResult.keep, ...swapResult.send];
  return { success: true, newProofs };
}

// ---------------------------------------------------------------------------
// Melt (cash-out) — NUT-05
// ---------------------------------------------------------------------------

/**
 * Fetches a melt quote from the mint for a BOLT11 invoice.
 *
 * Uses the cashu-ts wallet.createMeltQuote() which returns a full
 * MeltQuoteResponse needed by meltTokens().
 *
 * @param invoice  BOLT11 Lightning invoice string.
 * @returns Quote object containing `quote` ID, `amount`, and `fee_reserve`.
 */
export async function getMeltQuote(
  invoice: string,
  proofs?: Proof[]
): Promise<{ quote: string; amount: number; fee_reserve: number; inputFee: number }> {
  const { wallet } = await buildWallet();
  const meltQuote = await wallet.createMeltQuote(invoice);
  const feeProofs = proofs ?? getProofs();
  const inputFee = wallet.getFeesForProofs(feeProofs);
  return {
    quote: meltQuote.quote,
    amount: meltQuote.amount,
    fee_reserve: meltQuote.fee_reserve,
    inputFee,
  };
}

/**
 * Melts Cashu proofs to pay a BOLT11 Lightning invoice (NUT-05).
 *
 * Uses wallet.meltProofs() which sends NUT-08 blank outputs so the mint
 * can return change for any unused fee reserve.
 *
 * @param invoice   BOLT11 invoice to pay (used to re-create the melt quote).
 * @param _quoteId  Unused — kept for API compatibility. The quote is re-fetched.
 * @param proofs    Proofs to use as inputs for the payment.
 * @returns `{ paid, payment_preimage, change }` on success.
 */
export async function meltTokens(
  invoice: string,
  _quoteId: string,
  proofs: Proof[]
): Promise<{ paid: boolean; payment_preimage: string | null; change: Proof[] }> {
  const { wallet } = await buildWallet();
  const meltQuote = await wallet.createMeltQuote(invoice);
  const result = await wallet.meltProofs(meltQuote, proofs);

  const paid = result.quote.state === 'PAID';
  const preimage = (result.quote as Record<string, unknown>)['payment_preimage'] as string | null ?? null;

  return { paid, payment_preimage: preimage, change: result.change };
}

// ---------------------------------------------------------------------------
// Withdraw estimation
// ---------------------------------------------------------------------------

/**
 * Estimates the maximum amount a user can withdraw via Lightning melt.
 *
 * Accounts for:
 *   - NUT-02 input fee: ceil(n_proofs * input_fee_ppk / 1000)
 *   - Lightning fee buffer: max(3, ceil(balance * 0.01)) — conservative estimate
 *     since the actual fee_reserve is unknown until an invoice exists.
 *
 * @returns maxAmount (safe invoice amount), inputFee, lightningBuffer, and balance.
 */
export async function estimateMaxWithdrawable(): Promise<{
  maxAmount: number;
  inputFee: number;
  lightningBuffer: number;
  balance: number;
}> {
  const { wallet } = await buildWallet();
  const proofs = getProofs();
  const balance = proofs.reduce((s, p) => s + p.amount, 0);
  const inputFee = wallet.getFeesForProofs(proofs);
  const lightningBuffer = Math.max(1, Math.ceil(balance * 0.01));
  const maxAmount = Math.max(0, balance - inputFee - lightningBuffer);
  return { maxAmount, inputFee, lightningBuffer, balance };
}

/**
 * Checks the spend state of a set of Cashu proofs (NUT-07).
 *
 * All proofs in a single payment chunk share the same state (they were minted
 * together and are redeemed together), so this returns the state of the first
 * proof as a convenience.
 *
 * @param proofs  The proofs to check.
 * @returns `"unspent"`, `"spent"`, or `"pending"`.
 */
export async function checkTokenState(
  proofs: Proof[]
): Promise<'unspent' | 'spent' | 'pending'> {
  const { wallet } = await buildWallet();
  const states = await wallet.checkProofsStates(proofs);

  if (states.length === 0) {
    throw new Error('checkProofsStates returned an empty response');
  }

  const firstState = states[0]!.state;

  switch (firstState) {
    case 'UNSPENT':
      return 'unspent';
    case 'SPENT':
      return 'spent';
    case 'PENDING':
      return 'pending';
    default:
      throw new Error(`Unknown proof state: ${String(firstState)}`);
  }
}
