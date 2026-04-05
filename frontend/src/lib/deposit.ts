/**
 * deposit.ts
 *
 * "Fund your wallet" flow for satstreamr.
 *
 * Implements the Lightning-to-Cashu deposit process:
 *   1. requestMintQuote  — asks the mint for a BOLT11 invoice
 *   2. checkMintQuote    — polls whether the user has paid the invoice
 *   3. pollForPayment    — automates the polling loop with timeout
 *   4. mintProofsFromQuote — mints Cashu proofs once paid, stores them locally
 *
 * The mint URL is resolved via getMintUrl() from lib/config.ts: it prefers
 * VITE_MINT_URL when set, otherwise uses the Vite proxy path /mint so the
 * app works on both localhost and LAN without manual configuration.
 */

import type { Proof } from '@cashu/cashu-ts';
import { buildWallet } from './cashu-wallet.js';
import { addProofs } from './wallet-store.js';
import { getMintUrl } from './config.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Requests a Lightning invoice from the Cashu mint for the given amount.
 *
 * Issues a NUT-04 mint quote request (POST /v1/mint/quote/bolt11).
 *
 * @param amountSats  Amount to deposit in satoshis.
 * @returns `{ quote, invoice }` — the opaque quote ID and the BOLT11 invoice string.
 * @throws On non-200 HTTP responses or network errors.
 */
export async function requestMintQuote(
  amountSats: number
): Promise<{ quote: string; invoice: string }> {
  const mintUrl = getMintUrl();

  const response = await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountSats, unit: 'sat' }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`requestMintQuote failed: HTTP ${response.status} — ${text}`);
  }

  const data = (await response.json()) as { quote: string; request: string };
  return { quote: data.quote, invoice: data.request };
}

/**
 * Checks whether the Lightning invoice for a previously issued mint quote has
 * been paid.
 *
 * Issues a NUT-04 quote state check (GET /v1/mint/quote/bolt11/{quoteId}).
 *
 * @param quoteId  The quote ID returned by `requestMintQuote`.
 * @returns `{ paid: true }` if the invoice has been paid, `{ paid: false }` otherwise.
 * @throws On non-200 HTTP responses or network errors.
 */
export async function checkMintQuote(quoteId: string): Promise<{ paid: boolean }> {
  const mintUrl = getMintUrl();

  const response = await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quoteId}`);

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`checkMintQuote failed: HTTP ${response.status} — ${text}`);
  }

  const data = (await response.json()) as { state: string; paid?: boolean };

  // The mint may return either a `paid` boolean field (older NUT-04) or a
  // `state` string field (newer NUT-04 revision: "UNPAID" | "PAID" | "ISSUED").
  const paid =
    data.paid === true ||
    data.state === 'PAID' ||
    data.state === 'ISSUED';

  return { paid };
}

/**
 * Polls `checkMintQuote` at a regular interval until the invoice is paid or
 * the timeout is exceeded.
 *
 * Uses a Promise + setTimeout chain (no setInterval) so cleanup is reliable
 * on both the paid and timed-out paths.
 *
 * @param quoteId     The quote ID to poll.
 * @param opts.intervalMs  Polling interval in milliseconds (default 3000).
 * @param opts.timeoutMs   Maximum wait time in milliseconds (default 600000 = 10 min).
 * @returns `true` if the invoice was paid before the timeout, `false` otherwise.
 */
export function pollForPayment(
  quoteId: string,
  opts?: { intervalMs?: number; timeoutMs?: number }
): Promise<boolean> {
  const intervalMs = opts?.intervalMs ?? 3_000;
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (pollHandle !== null) clearTimeout(pollHandle);
        resolve(false);
      }
    }, timeoutMs);

    async function poll(): Promise<void> {
      if (settled) return;

      try {
        const { paid } = await checkMintQuote(quoteId);
        if (paid) {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutHandle);
            resolve(true);
          }
          return;
        }
      } catch {
        // Swallow transient network errors and keep polling.
      }

      if (!settled) {
        pollHandle = setTimeout(() => {
          void poll();
        }, intervalMs);
      }
    }

    void poll();
  });
}

/**
 * Mints Cashu proofs for a previously paid mint quote and stores them in the
 * local wallet store.
 *
 * @param quoteId     The quote ID returned by `requestMintQuote`.
 * @param amountSats  The amount (in satoshis) that was requested in the quote.
 * @returns The newly minted proofs.
 * @throws If the mint call fails or returns no proofs.
 */
export async function mintProofsFromQuote(
  quoteId: string,
  amountSats: number
): Promise<Proof[]> {
  const { wallet } = await buildWallet();

  const proofs = await wallet.mintProofs(amountSats, quoteId);

  if (!proofs || proofs.length === 0) {
    throw new Error('mintProofs returned an empty proof array');
  }

  addProofs(proofs);

  return proofs;
}
