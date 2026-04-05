/**
 * cashu-wallet.ts
 *
 * Browser-targeted Cashu wallet module for satstreamr.
 *
 * Wraps @cashu/cashu-ts to provide the Cashu operations needed by the
 * payment flow:
 *   - swapP2PKToken   — NUT-03 swap with NUT-11 P2PK lock (single HTTP POST, no Lightning)
 *   - redeemToken     — NUT-03 swap using NUT-11 private key signature
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
import { spendProofs, addProofs } from './wallet-store.js';

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
 * Swaps existing wallet proofs into NUT-11 P2PK-locked proofs for the recipient.
 *
 * Uses a single HTTP POST to the mint (NUT-03 swap) — no Lightning invoice,
 * no polling. Latency is ~50-200ms versus ~2-3s for a Lightning round-trip.
 *
 * Flow:
 *   1. Select proofs from the local wallet covering amountSats.
 *   2. Calculate the swap fee; re-select if the first selection is too small.
 *   3. POST to the mint: returns P2PK-locked send proofs + unlocked change.
 *   4. Return change proofs to the wallet.
 *   5. On any error, roll back all consumed proofs to the wallet.
 *
 * The viewer pays the tutor's future redemption fee via `includeFees: true`.
 *
 * @param amountSats      Net value the recipient will hold after redeeming.
 * @param recipientPubkey Compressed secp256k1 public key (33-byte hex, 66 chars).
 * @returns Array of P2PK-locked Proofs ready to send to the tutor.
 */
export async function swapP2PKToken(
  amountSats: number,
  recipientPubkey: string
): Promise<Proof[]> {
  const { wallet } = await buildWallet();

  // Select proofs from the wallet for the requested amount.
  let inputProofs = spendProofs(amountSats);

  // Calculate the swap fee based on the selected inputs and re-select if
  // the first selection is not large enough to cover amount + fee.
  const fee = wallet.getFeesForProofs(inputProofs);
  const totalNeeded = amountSats + fee;
  const totalSelected = inputProofs.reduce((s, p) => s + p.amount, 0);

  if (totalSelected < totalNeeded) {
    // Return the under-sized selection and pick a larger batch.
    addProofs(inputProofs);
    inputProofs = spendProofs(totalNeeded);
  }

  try {
    // Swap at the mint: locked proofs go to the tutor, change comes back.
    // includeFees: true means the viewer covers the tutor's redemption fee.
    const result = await wallet.send(amountSats, inputProofs, {
      p2pk: { pubkey: recipientPubkey },
      includeFees: true,
    });

    // Return change to the wallet store.
    if (result.keep.length > 0) {
      addProofs(result.keep);
    }

    return result.send;
  } catch (err) {
    // Rollback: put all consumed proofs back in the wallet on any failure.
    addProofs(inputProofs);
    throw err;
  }
}

/**
 * Redeems P2PK-locked Cashu proofs using the holder's private key.
 *
 * Executes a NUT-03 swap, signing each proof's secret with privkeyHex so the
 * mint's NUT-11 spending condition is satisfied.
 *
 * @param proofs      The P2PK-locked proofs to redeem.
 * @param privkeyHex  Hex-encoded 32-byte private key matching the lock pubkey.
 * @returns `{ success: true }` on successful redemption.
 */
export async function redeemToken(
  proofs: Proof[],
  privkeyHex: string
): Promise<{ success: boolean; newProofs: Proof[] }> {
  const { wallet } = await buildWallet();

  const totalAmount = proofs.reduce((s, p) => s + p.amount, 0);
  const fee = wallet.getFeesForProofs(proofs);
  const receiveAmount = totalAmount - fee;

  if (receiveAmount <= 0) {
    throw new Error(
      `Proof total (${totalAmount}) is not enough to cover the swap fee (${fee})`
    );
  }

  const swapResult = await wallet.swap(receiveAmount, proofs, {
    privkey: privkeyHex,
  });

  const newProofs = [...swapResult.keep, ...swapResult.send];
  if (!newProofs || newProofs.length === 0) {
    throw new Error('swap returned empty proofs — redemption failed');
  }

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
