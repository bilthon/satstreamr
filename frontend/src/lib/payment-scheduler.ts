/**
 * payment-scheduler.ts
 *
 * Automatic payment loop for satstreamr viewers.
 *
 * - Self-scheduling via setTimeout (never setInterval) to avoid drift.
 * - Strict one-token-at-a-time: skips the next tick if a payment ack is still
 *   pending from the previous send.
 * - Retry logic: if no ack arrives within ACK_TIMEOUT_MS, resends the same
 *   encoded token. A second timeout fires onPaymentFailure and stops the loop.
 * - Budget is decremented only after a payment_ack is received.
 * - State (chunkId, totalSatsPaid, budgetRemaining) is persisted via an
 *   injected onStateChange callback so this module has zero DOM dependencies
 *   and remains fully testable in a node environment.
 */

import type { DataChannel } from './data-channel.js';
import type { Proof } from '../types/cashu.js';
import { getBalance } from './wallet-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MintTokenFn = (amountSats: number, tutorPubkey: string) => Promise<Proof[]>;
export type EncodeTokenFn = (proofs: Proof[], mintUrl: string) => string;

export interface PaymentSchedulerOpts {
  intervalSecs: number;
  chunkSats: number;
  /** Budget in sats. If omitted, defaults to the current wallet-store balance. */
  budgetSats?: number;
  tutorPubkey: string;
  mintUrl: string;
  /** Initial chunkId — caller loads this from session storage. */
  initialChunkId?: number;
  /** Initial totalSatsPaid — caller loads this from session storage. */
  initialTotalSatsPaid?: number;
  /** Called after every state change so the caller can persist to storage. */
  onStateChange?: (state: SchedulerState) => void;
}

export interface SchedulerState {
  chunkId: number;
  totalSatsPaid: number;
  budgetRemaining: number;
}

// How long (ms) to wait for a payment_ack before retrying.
const ACK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// PaymentScheduler
// ---------------------------------------------------------------------------

export class PaymentScheduler {
  private readonly dc: DataChannel;
  private readonly mintToken: MintTokenFn;
  private readonly encodeToken: EncodeTokenFn;
  private readonly opts: Readonly<Required<PaymentSchedulerOpts>>;

  // Mutable scheduler state
  private chunkId: number;
  private totalSatsPaid: number;
  private budgetRemaining: number;

  private running = false;
  private pending = false;

  // setTimeout handles
  private intervalHandle: ReturnType<typeof setTimeout> | null = null;
  private ackTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // Retry tracking: number of times the current chunkId has been sent
  private retryCount = 0;
  // The encoded token for the current in-flight chunk (reused on retry)
  private inflightEncodedToken: string | null = null;
  // The actual amount minted (chunkSats + swapFee) for the current in-flight chunk
  private inflightMintedAmount = 0;

  // Listeners
  private budgetExhaustedListeners: Array<() => void> = [];
  private paymentFailureListeners: Array<(reason: string) => void> = [];
  private chunkPaidListeners: Array<(chunkId: number, totalPaid: number, budgetRemaining: number) => void> = [];

  constructor(
    dataChannel: DataChannel,
    mintTokenFn: MintTokenFn,
    encodeTokenFn: EncodeTokenFn,
    opts: PaymentSchedulerOpts,
  ) {
    this.dc = dataChannel;
    this.mintToken = mintTokenFn;
    this.encodeToken = encodeTokenFn;

    // Apply defaults for optional fields
    const resolvedBudget = opts.budgetSats ?? getBalance();
    this.opts = {
      ...opts,
      budgetSats: resolvedBudget,
      initialChunkId: opts.initialChunkId ?? 0,
      initialTotalSatsPaid: opts.initialTotalSatsPaid ?? 0,
      onStateChange: opts.onStateChange ?? (() => undefined),
    };

    this.chunkId = this.opts.initialChunkId;
    this.totalSatsPaid = this.opts.initialTotalSatsPaid;
    this.budgetRemaining = resolvedBudget;

    // Wire up incoming ack/nack handler
    this.dc.onMessage((msg) => {
      if (msg.type === 'payment_ack') {
        this.handleAck(msg.chunkId);
      } else if (msg.type === 'payment_nack') {
        this.handleNack(msg.chunkId, msg.reason);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.intervalHandle !== null) {
      clearTimeout(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.clearAckTimeout();
  }

  onBudgetExhausted(cb: () => void): void {
    this.budgetExhaustedListeners.push(cb);
  }

  onPaymentFailure(cb: (reason: string) => void): void {
    this.paymentFailureListeners.push(cb);
  }

  onChunkPaid(cb: (chunkId: number, totalPaid: number, budgetRemaining: number) => void): void {
    this.chunkPaidListeners.push(cb);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scheduleNext(): void {
    if (!this.running) return;
    this.intervalHandle = setTimeout(() => {
      void this.tick();
    }, this.opts.intervalSecs * 1000);
  }

  private async tick(): Promise<void> {
    this.intervalHandle = null;

    if (!this.running) return;

    if (this.pending) {
      console.warn('[payment-scheduler] tick fired while payment is still pending — skipping');
      this.scheduleNext();
      return;
    }

    if (this.budgetRemaining <= 0) {
      // Budget already exhausted; stop silently.
      this.stop();
      return;
    }

    const chunkId = this.chunkId;

    // Mint a fresh token for this chunk.
    let encodedToken: string;
    let mintedAmount: number;
    try {
      const proofs = await this.mintToken(this.opts.chunkSats, this.opts.tutorPubkey);
      encodedToken = this.encodeToken(proofs, this.opts.mintUrl);
      mintedAmount = proofs.reduce((sum, p) => sum + p.amount, 0);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[payment-scheduler] mintToken failed:', reason);
      this.fireFailed(reason);
      return;
    }

    this.inflightEncodedToken = encodedToken;
    this.inflightMintedAmount = mintedAmount;
    this.retryCount = 0;
    await this.sendChunk(chunkId, encodedToken);
  }

  /** Sends a token_payment message and starts the ack timeout. */
  private async sendChunk(chunkId: number, encodedToken: string): Promise<void> {
    this.pending = true;

    try {
      this.dc.sendMessage({ type: 'token_payment', chunkId, encodedToken });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[payment-scheduler] sendMessage failed:', reason);
      this.fireFailed(reason);
      return;
    }

    console.log(`[payment-scheduler] sent chunk #${chunkId} (attempt ${this.retryCount + 1})`);

    // Start the ack timeout
    this.ackTimeoutHandle = setTimeout(() => {
      void this.handleAckTimeout(chunkId);
    }, ACK_TIMEOUT_MS);
  }

  private async handleAckTimeout(chunkId: number): Promise<void> {
    this.ackTimeoutHandle = null;

    if (!this.running || !this.pending) return;

    if (this.retryCount === 0) {
      // First timeout: retry with the same encoded token.
      this.retryCount = 1;
      console.warn(`[payment-scheduler] no ack for chunk #${chunkId} — retrying`);
      if (this.inflightEncodedToken !== null) {
        await this.sendChunk(chunkId, this.inflightEncodedToken);
      }
    } else {
      // Second timeout: permanent failure.
      const reason = `No ack received for chunk #${chunkId} after retry`;
      console.error('[payment-scheduler]', reason);
      this.fireFailed(reason);
    }
  }

  private handleAck(ackedChunkId: number): void {
    if (ackedChunkId !== this.chunkId) {
      console.warn(
        `[payment-scheduler] received ack for chunk #${ackedChunkId} but expected #${this.chunkId} — ignoring`,
      );
      return;
    }

    this.clearAckTimeout();
    this.pending = false;
    this.inflightEncodedToken = null;

    // Decrement budget by the actual minted amount (chunkSats + swapFee) so
    // the viewer's budget reflects what was truly spent from their Cashu wallet.
    const spent = this.inflightMintedAmount;
    this.inflightMintedAmount = 0;
    this.budgetRemaining -= spent;
    this.totalSatsPaid += spent;
    const paidChunkId = this.chunkId;
    this.chunkId += 1;

    this.persistState();

    // Notify listeners
    for (const cb of this.chunkPaidListeners) {
      cb(paidChunkId, this.totalSatsPaid, this.budgetRemaining);
    }

    if (this.budgetRemaining <= 0) {
      for (const cb of this.budgetExhaustedListeners) {
        cb();
      }
      this.stop();
      return;
    }

    // Schedule the next payment.
    this.scheduleNext();
  }

  private handleNack(nackedChunkId: number, reason: string): void {
    if (nackedChunkId !== this.chunkId) return;

    this.clearAckTimeout();
    this.pending = false;
    this.inflightEncodedToken = null;

    console.warn(`[payment-scheduler] nack for chunk #${nackedChunkId}: ${reason}`);
    this.fireFailed(`payment_nack for chunk #${nackedChunkId}: ${reason}`);
  }

  /** Fires onPaymentFailure listeners, sends session_paused, and stops. */
  private fireFailed(reason: string): void {
    this.pending = false;
    this.clearAckTimeout();

    // Notify the tutor over the data channel.
    try {
      this.dc.sendMessage({ type: 'session_paused', reason });
    } catch {
      // Best effort; channel may already be closed.
    }

    for (const cb of this.paymentFailureListeners) {
      cb(reason);
    }

    this.stop();
  }

  private clearAckTimeout(): void {
    if (this.ackTimeoutHandle !== null) {
      clearTimeout(this.ackTimeoutHandle);
      this.ackTimeoutHandle = null;
    }
  }

  private persistState(): void {
    this.opts.onStateChange({
      chunkId: this.chunkId,
      totalSatsPaid: this.totalSatsPaid,
      budgetRemaining: this.budgetRemaining,
    });
  }
}
