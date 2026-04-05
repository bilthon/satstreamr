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
 * @param invoice  BOLT11 Lightning invoice string.
 * @returns Quote object containing `quote` ID, `amount`, and `fee_reserve`.
 */
export async function getMeltQuote(
  invoice: string
): Promise<{ quote: string; amount: number; fee_reserve: number }> {
  const mintUrl = getMintUrl();
  const response = await fetch(`${mintUrl}/v1/melt/quote/bolt11`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit: 'sat', request: invoice }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`getMeltQuote failed: HTTP ${response.status} — ${text}`);
  }

  const data = (await response.json()) as { quote: string; amount: number; fee_reserve: number };
  return data;
}

/**
 * Melts Cashu proofs to pay a BOLT11 Lightning invoice (NUT-05).
 *
 * @param invoice   BOLT11 invoice to pay.
 * @param quoteId   Quote ID previously obtained from getMeltQuote.
 * @param proofs    Proofs to use as inputs for the payment.
 * @returns `{ paid, payment_preimage }` on success.
 * @throws A user-friendly error string on failure.
 */
export async function meltTokens(
  invoice: string,
  quoteId: string,
  proofs: Proof[]
): Promise<{ paid: boolean; payment_preimage: string | null }> {
  const mintUrl = getMintUrl();
  const response = await fetch(`${mintUrl}/v1/melt/bolt11`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote: quoteId, inputs: proofs }),
  });

  if (!response.ok) {
    // Map common HTTP status codes / error patterns to friendly messages
    if (response.status === 402) {
      throw new Error('Not enough tokens to cover the invoice amount and fees');
    }

    const text = await response.text().catch(() => '');

    // Check invoice prefix mismatch (regtest expects lnbcrt)
    if (
      invoice.length > 0 &&
      !invoice.toLowerCase().startsWith('lnbcrt') &&
      import.meta.env.DEV
    ) {
      throw new Error('Invalid invoice — expected a regtest invoice (lnbcrt\u2026)');
    }

    // Check for expiry keyword in error body
    if (text.toLowerCase().includes('expir')) {
      throw new Error('Invoice expired — please generate a new one');
    }

    // Generic fallback
    let mintMessage = text;
    try {
      const parsed = JSON.parse(text) as { detail?: string; error?: string };
      mintMessage = parsed.detail ?? parsed.error ?? text;
    } catch {
      // leave mintMessage as raw text
    }
    throw new Error(`Payment failed: ${mintMessage}`);
  }

  const data = (await response.json()) as { paid: boolean; payment_preimage: string | null };
  return data;
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
