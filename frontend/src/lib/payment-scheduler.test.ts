/**
 * payment-scheduler.test.ts
 *
 * Unit tests for PaymentScheduler using vi.useFakeTimers().
 * All wallet and data-channel interactions are mocked — no network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaymentScheduler } from './payment-scheduler.js';
import type { DataChannel } from './data-channel.js';
import type { DataChannelMessage } from '../types/data-channel.js';
import type { Proof } from '../types/cashu.js';

// ---------------------------------------------------------------------------
// Mock wallet-store so getBalance() is controllable in tests
// ---------------------------------------------------------------------------

vi.mock('./wallet-store.js', () => ({
  getBalance: vi.fn(() => 100),
  spendProofs: vi.fn(),
  addProofs: vi.fn(),
  getProofs: vi.fn(() => []),
  setProofs: vi.fn(),
  onBalanceChange: vi.fn(() => () => undefined),
}));

import { getBalance } from './wallet-store.js';

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal DataChannel mock that:
 * - captures the onMessage handler registered by PaymentScheduler
 * - records every sendMessage call
 * - exposes a triggerMessage() helper for the test to deliver inbound messages
 */
function makeMockDataChannel() {
  let inboundHandler: ((msg: DataChannelMessage) => void) | null = null;
  const sent: DataChannelMessage[] = [];

  const dc = {
    onMessage(handler: (msg: DataChannelMessage) => void): void {
      inboundHandler = handler;
    },
    sendMessage(msg: DataChannelMessage): void {
      sent.push(msg);
    },
    get isOpen(): boolean {
      return true;
    },
    // Test helper: deliver a message as if it arrived from the tutor.
    triggerMessage(msg: DataChannelMessage): void {
      if (inboundHandler !== null) {
        inboundHandler(msg);
      }
    },
    sent,
  } as unknown as DataChannel & {
    triggerMessage: (msg: DataChannelMessage) => void;
    sent: DataChannelMessage[];
  };

  return dc;
}

/**
 * Creates a mock selectProofs function that returns a dummy proof synchronously.
 * Mirrors the real spendProofs signature: (amountSats: number) => Proof[]
 */
function makeMockSelectProofs() {
  return vi.fn((_amountSats: number): Proof[] => {
    return [{ id: 'mock-id', amount: _amountSats, secret: 'mock-secret', C: 'mock-C' } as unknown as Proof];
  });
}

/** Creates a mock encodeToken function that returns a deterministic string. */
function makeMockEncodeToken() {
  return vi.fn((_proofs: Proof[], _mintUrl: string): string => {
    return 'cashuA_mock_encoded_token';
  });
}

const INTERVAL_SECS = 10;
const CHUNK_SATS = 1;
const MINT_URL = 'http://localhost:3338';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: wallet has plenty of balance.
    vi.mocked(getBalance).mockReturnValue(100);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1 — Happy path
  // -------------------------------------------------------------------------
  it('happy path: after 3 intervals, chunkId === 3 and totalSatsPaid === 3 * chunkSats', async () => {
    const dc = makeMockDataChannel();
    const selectProofs = makeMockSelectProofs();
    const encodeToken = makeMockEncodeToken();

    let chunkCount = 0;
    let totalPaid = 0;

    const stateChanges: { chunkId: number; totalSatsPaid: number }[] = [];

    const scheduler = new PaymentScheduler(dc, selectProofs, encodeToken, {
      intervalSecs: INTERVAL_SECS,
      chunkSats: CHUNK_SATS,
      mintUrl: MINT_URL,
      onStateChange: (state) => { stateChanges.push({ ...state }); },
    });

    scheduler.onChunkPaid((_chunkId, tp, _balance) => {
      chunkCount += 1;
      totalPaid = tp;
    });

    scheduler.start();

    // Advance through 3 complete payment cycles.
    for (let i = 0; i < 3; i++) {
      // Advance past the interval timer so tick() fires.
      await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

      // The scheduler sent a token_payment — simulate an immediate ack.
      const sentPayments = dc.sent.filter((m) => m.type === 'token_payment');
      const lastPayment = sentPayments[sentPayments.length - 1];
      if (lastPayment?.type === 'token_payment') {
        dc.triggerMessage({ type: 'payment_ack', chunkId: lastPayment.chunkId });
      }
    }

    scheduler.stop();

    expect(chunkCount).toBe(3);
    expect(totalPaid).toBe(3 * CHUNK_SATS);
    expect(stateChanges).toHaveLength(3);
    // The final state should have chunkId === 3 (next id after the third chunk)
    expect(stateChanges[2]?.chunkId).toBe(3);
    expect(stateChanges[2]?.totalSatsPaid).toBe(3 * CHUNK_SATS);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Retry on ack timeout
  // -------------------------------------------------------------------------
  it('retry: drops first ack (timeout), acks the retry, scheduler continues', async () => {
    const dc = makeMockDataChannel();
    const selectProofs = makeMockSelectProofs();
    const encodeToken = makeMockEncodeToken();

    const chunksPaid: number[] = [];
    const failureReasons: string[] = [];

    const scheduler = new PaymentScheduler(dc, selectProofs, encodeToken, {
      intervalSecs: INTERVAL_SECS,
      chunkSats: CHUNK_SATS,
      mintUrl: MINT_URL,
    });

    scheduler.onChunkPaid((chunkId) => { chunksPaid.push(chunkId); });
    scheduler.onPaymentFailure((reason) => { failureReasons.push(reason); });

    scheduler.start();

    // First interval fires — sends the initial token_payment.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

    // Simulate the first ack timeout (5 seconds pass without an ack).
    await vi.advanceTimersByTimeAsync(5_000);

    // At this point, exactly 2 token_payment messages should have been sent
    // (original + retry) with the same chunkId.
    const payments = dc.sent.filter((m) => m.type === 'token_payment');
    expect(payments).toHaveLength(2);

    // Both should share the same chunkId.
    const firstChunkId = (payments[0] as { type: 'token_payment'; chunkId: number }).chunkId;
    const retryChunkId = (payments[1] as { type: 'token_payment'; chunkId: number }).chunkId;
    expect(firstChunkId).toBe(retryChunkId);

    // Now the retry ack arrives.
    dc.triggerMessage({ type: 'payment_ack', chunkId: retryChunkId });

    // Scheduler should have registered one paid chunk and no failures.
    expect(chunksPaid).toHaveLength(1);
    expect(chunksPaid[0]).toBe(0);
    expect(failureReasons).toHaveLength(0);

    // Verify the scheduler is still running (schedules the next tick).
    // Advance one more interval to confirm it fires again.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

    const paymentsAfterContinue = dc.sent.filter((m) => m.type === 'token_payment');
    // Should now be 3 total: original, retry, and next chunk.
    expect(paymentsAfterContinue).toHaveLength(3);
    const nextChunkId = (paymentsAfterContinue[2] as { type: 'token_payment'; chunkId: number }).chunkId;
    expect(nextChunkId).toBe(1);

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 3 — Double timeout triggers onPaymentFailure and stops the scheduler
  // -------------------------------------------------------------------------
  it('double timeout: onPaymentFailure fires after two 5s timeouts and scheduler stops', async () => {
    const dc = makeMockDataChannel();
    const selectProofs = makeMockSelectProofs();
    const encodeToken = makeMockEncodeToken();

    const failureReasons: string[] = [];
    const chunksPaid: number[] = [];

    const scheduler = new PaymentScheduler(dc, selectProofs, encodeToken, {
      intervalSecs: INTERVAL_SECS,
      chunkSats: CHUNK_SATS,
      mintUrl: MINT_URL,
    });

    scheduler.onChunkPaid((chunkId) => { chunksPaid.push(chunkId); });
    scheduler.onPaymentFailure((reason) => { failureReasons.push(reason); });

    scheduler.start();

    // First interval fires — sends the initial token_payment.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

    // First ack timeout (5 seconds) — triggers one retry.
    await vi.advanceTimersByTimeAsync(5_000);

    // At this point one retry should have been sent, still no ack.
    const paymentsAfterFirstTimeout = dc.sent.filter((m) => m.type === 'token_payment');
    expect(paymentsAfterFirstTimeout).toHaveLength(2); // original + retry

    // Second ack timeout (another 5 seconds) — should trigger permanent failure.
    await vi.advanceTimersByTimeAsync(5_000);

    // onPaymentFailure must have fired exactly once.
    expect(failureReasons).toHaveLength(1);
    expect(failureReasons[0]).toMatch(/chunk #0/);

    // No chunks should have been paid successfully.
    expect(chunksPaid).toHaveLength(0);

    // A session_paused message should have been sent over the data channel.
    const pausedMessages = dc.sent.filter((m) => m.type === 'session_paused');
    expect(pausedMessages).toHaveLength(1);

    // Scheduler must be stopped — advancing time further should not send more tokens.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000 * 3);
    const totalPayments = dc.sent.filter((m) => m.type === 'token_payment').length;
    expect(totalPayments).toBe(2); // still exactly 2 — no further attempts
  });

  // -------------------------------------------------------------------------
  // Test 4 — Budget exhaustion via getBalance()
  // -------------------------------------------------------------------------
  it('budget exhaustion: onBudgetExhausted fires when getBalance() drops below chunkSats', async () => {
    const dc = makeMockDataChannel();
    const selectProofs = makeMockSelectProofs();
    const encodeToken = makeMockEncodeToken();

    let budgetExhaustedCount = 0;
    let chunksPaidCount = 0;

    // Start with enough balance for 3 chunks.
    vi.mocked(getBalance).mockReturnValue(3);

    const scheduler = new PaymentScheduler(dc, selectProofs, encodeToken, {
      intervalSecs: INTERVAL_SECS,
      chunkSats: CHUNK_SATS,
      mintUrl: MINT_URL,
    });

    scheduler.onBudgetExhausted(() => { budgetExhaustedCount += 1; });
    scheduler.onChunkPaid(() => { chunksPaidCount += 1; });

    scheduler.start();

    // Run through 3 payment cycles, simulating balance decrement each time.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

      const payments = dc.sent.filter((m) => m.type === 'token_payment');
      const lastPayment = payments[payments.length - 1];
      if (lastPayment?.type === 'token_payment') {
        // Simulate balance decreasing after each chunk is paid.
        vi.mocked(getBalance).mockReturnValue(3 - (i + 1));
        dc.triggerMessage({ type: 'payment_ack', chunkId: lastPayment.chunkId });
      }
    }

    // onBudgetExhausted should have fired exactly once.
    expect(budgetExhaustedCount).toBe(1);
    expect(chunksPaidCount).toBe(3);

    // Count how many token_payment messages were sent.
    const totalSent = dc.sent.filter((m) => m.type === 'token_payment').length;
    expect(totalSent).toBe(3); // exactly 3 — no 4th

    // Advance time further to confirm no 4th token is sent.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

    const totalSentAfter = dc.sent.filter((m) => m.type === 'token_payment').length;
    expect(totalSentAfter).toBe(3); // still 3
  });

  // -------------------------------------------------------------------------
  // Test 5 — selectProofs is called synchronously (no await)
  // -------------------------------------------------------------------------
  it('selectProofs is called synchronously with chunkSats on each tick', async () => {
    const dc = makeMockDataChannel();
    const selectProofs = makeMockSelectProofs();
    const encodeToken = makeMockEncodeToken();

    const scheduler = new PaymentScheduler(dc, selectProofs, encodeToken, {
      intervalSecs: INTERVAL_SECS,
      chunkSats: CHUNK_SATS,
      mintUrl: MINT_URL,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_SECS * 1000);

    expect(selectProofs).toHaveBeenCalledWith(CHUNK_SATS);
    expect(selectProofs).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
