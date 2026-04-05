/**
 * cashu-wallet.ts
 *
 * Browser-targeted Cashu wallet module for satstreamr.
 *
 * Wraps @cashu/cashu-ts to provide the three Cashu operations needed by the
 * payment flow:
 *   - mintP2PKToken   — NUT-04 mint + NUT-11 P2PK lock + NUT-12 DLEQ verify
 *   - redeemToken     — NUT-03 swap using NUT-11 private key signature
 *   - checkTokenState — NUT-07 proof state query
 *
 * The mint URL is resolved via getMintUrl() from lib/config.ts: it prefers
 * VITE_MINT_URL when set, otherwise uses the Vite proxy path /mint so the
 * app works on both localhost and LAN without manual configuration.
 *
 * REGTEST NOTE: Invoice payment in mintP2PKToken uses the LND REST API
 * (proxied through Vite's dev server at /lnd-customer) to pay the invoice
 * automatically. This is regtest-only scaffolding. In production the user
 * pays the invoice in their own Lightning wallet and the caller polls
 * checkMintQuote until the state is PAID before calling mintProofs.
 */

import { CashuMint, CashuWallet, hasValidDleq } from '@cashu/cashu-ts';
import type { Proof, MintKeys } from '../types/cashu.js';
import { getMintUrl } from './config.js';

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

/** NUT-02 fee: ceil(n_inputs * fee_ppk / 1000) */
function calcFee(nInputs: number, feePpk: number): number {
  return Math.ceil((nInputs * feePpk) / 1000);
}

/**
 * Pays a BOLT11 invoice via the LND REST API proxied through Vite's dev server.
 *
 * REGTEST SCAFFOLDING — only called inside `if (import.meta.env.DEV)` guards.
 * Production flow: display the invoice to the user; they pay it in their own
 * Lightning wallet.
 *
 * Proxy: Vite forwards /lnd-customer/* → https://localhost:8082/* (secure: false)
 * so TLS certificate errors from the self-signed LND cert are bypassed in dev.
 */
async function payInvoiceRegtest(bolt11: string): Promise<void> {
  const macaroon = import.meta.env['VITE_LND_CUSTOMER_MACAROON_HEX'] as string | undefined;
  if (!macaroon) {
    throw new Error(
      'VITE_LND_CUSTOMER_MACAROON_HEX is not defined. ' +
      'Set it in your .env file for regtest invoice auto-payment.'
    );
  }

  const response = await fetch('/lnd-customer/v1/channels/transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Grpc-Metadata-macaroon': macaroon,
    },
    body: JSON.stringify({ payment_request: bolt11 }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(
      `LND payinvoice failed: HTTP ${response.status} — ${text}`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mints a NUT-11 P2PK-locked Cashu token.
 *
 * Internally:
 *   1. Fetches active keyset to determine input_fee_ppk.
 *   2. Mints amountSats + swap_fee so the recipient can swap without going
 *      below zero value.
 *   3. Pays the Lightning invoice via lnd_customer (regtest only).
 *   4. Mints proofs locked to recipientPubkey.
 *   5. Verifies NUT-12 DLEQ on every proof — throws DLEQVerificationError
 *      if any proof fails.
 *
 * @param amountSats     Net value the recipient will hold after redeeming.
 * @param recipientPubkey Compressed secp256k1 public key (33-byte hex, 66 chars).
 * @returns Array of P2PK-locked Proofs.
 */
export async function mintP2PKToken(
  amountSats: number,
  recipientPubkey: string
): Promise<Proof[]> {
  const { wallet, mintKeys, feePpk } = await buildWallet();

  // Add the swap fee so the recipient can redeem without going to zero.
  // One proof is minted (1 input during the recipient's swap).
  const swapFee = calcFee(1, feePpk);
  const mintAmount = amountSats + swapFee;

  // Request a mint quote.
  const mintQuote = await wallet.createMintQuote(mintAmount);

  // Pay the invoice (regtest scaffolding — see module doc comment).
  if (import.meta.env.DEV) {
    await payInvoiceRegtest(mintQuote.request);
  }

  // Poll until the mint sees the payment.
  await sleep(1500);
  let quoteState = await wallet.checkMintQuote(mintQuote.quote);
  for (let i = 0; i < 10 && quoteState.state !== 'PAID' && quoteState.state !== 'ISSUED'; i++) {
    await sleep(1000);
    quoteState = await wallet.checkMintQuote(mintQuote.quote);
  }
  if (quoteState.state !== 'PAID' && quoteState.state !== 'ISSUED') {
    throw new Error(`Mint quote did not reach PAID state. Current state: ${quoteState.state}`);
  }

  // Mint proofs locked to the recipient's public key.
  const lockedProofs = await wallet.mintProofs(mintAmount, mintQuote.quote, {
    p2pk: { pubkey: recipientPubkey },
  });

  if (!lockedProofs || lockedProofs.length === 0) {
    throw new Error('mintProofs returned an empty proof array');
  }

  // NUT-12 DLEQ verification.
  for (const proof of lockedProofs) {
    if (proof.dleq) {
      const valid = hasValidDleq(proof, mintKeys);
      if (!valid) {
        throw new DLEQVerificationError(
          `DLEQ verification failed for proof amount=${proof.amount}`
        );
      }
    }
  }
  console.log('DLEQ OK');

  return lockedProofs;
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
  const { wallet, feePpk } = await buildWallet();

  const totalAmount = proofs.reduce((s, p) => s + p.amount, 0);
  const fee = calcFee(proofs.length, feePpk);
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
