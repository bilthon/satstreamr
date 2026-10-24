import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaymentScheduler } from './payment-scheduler.js';
import type { DataChannelMessage } from '../types/data-channel.js';

// No wallet module mock: each scheduler owns its injected balance/preparation.
function setup(initialBalance = 100, initialChunkId = 0, initialTotalSatsPaid = 0) {
  let balance = initialBalance;
  let inbound: (msg: DataChannelMessage) => void = () => undefined;
  const sent: DataChannelMessage[] = [];
  const transport = {
    onMessage(handler: (msg: DataChannelMessage) => void) { inbound = handler; },
    sendMessage: vi.fn((msg: DataChannelMessage) => { sent.push(msg); }),
  };
  const preparePayment = vi.fn((amountSats: number) => {
    balance -= amountSats;
    return `opaque-token-${preparePayment.mock.calls.length}`;
  });
  const getBalance = vi.fn(() => balance);
  const stateChanged = vi.fn();
  const paid = vi.fn();
  const failed = vi.fn();
  const exhausted = vi.fn();
  const scheduler = new PaymentScheduler(transport, { getBalance, preparePayment }, {
    intervalSecs: 10,
    chunkSats: 1,
    initialChunkId,
    initialTotalSatsPaid,
    onStateChange: stateChanged,
  });
  scheduler.onChunkPaid(paid);
  scheduler.onPaymentFailure(failed);
  scheduler.onBudgetExhausted(exhausted);
  return {
    scheduler, transport, sent, preparePayment, getBalance, stateChanged, paid, failed, exhausted,
    receive: (msg: DataChannelMessage) => inbound(msg),
    payments: () => sent.filter(m => m.type === 'token_payment'),
  };
}

describe('PaymentScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('happy path: three intervals persist three paid chunks', async () => {
    const t = setup();
    t.scheduler.start();
    for (let chunkId = 0; chunkId < 3; chunkId++) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.payments().at(-1)?.chunkId).toBe(chunkId);
      t.receive({ type: 'payment_ack', chunkId });
    }
    expect(t.paid).toHaveBeenCalledTimes(3);
    expect(t.stateChanged).toHaveBeenCalledTimes(3);
    expect(t.stateChanged).toHaveBeenLastCalledWith({ chunkId: 3, totalSatsPaid: 3 });
    t.scheduler.stop();
  });

  it('retries the identical token once without preparing another spend, then continues after ACK', async () => {
    const t = setup();
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.payments()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.payments()).toHaveLength(2);
    expect(t.payments()[1]).toEqual(t.payments()[0]);
    expect(t.preparePayment).toHaveBeenCalledTimes(1);
    t.receive({ type: 'payment_ack', chunkId: 0 });
    expect(t.paid).toHaveBeenCalledExactlyOnceWith(0, 1, 99);
    expect(t.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(t.payments()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.payments()[2]?.chunkId).toBe(1);
    t.scheduler.stop();
  });

  it('fails after the second five-second timeout without refunding or advancing counters', async () => {
    const t = setup();
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.failed).toHaveBeenCalledExactlyOnceWith('No ack received for chunk #0 after retry');
    expect(t.sent.at(-1)).toEqual({ type: 'session_paused', reason: 'No ack received for chunk #0 after retry' });
    expect(t.paid).not.toHaveBeenCalled();
    expect(t.stateChanged).not.toHaveBeenCalled();
    expect(t.getBalance()).toBe(99);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.payments()).toHaveLength(2);
    expect(t.preparePayment).toHaveBeenCalledTimes(1);
  });

  it('exhausts the injected balance after three acknowledged payments', async () => {
    const t = setup(3);
    t.scheduler.start();
    for (let chunkId = 0; chunkId < 3; chunkId++) {
      await vi.advanceTimersByTimeAsync(10_000);
      t.receive({ type: 'payment_ack', chunkId });
    }
    expect(t.exhausted).toHaveBeenCalledTimes(1);
    expect(t.paid).toHaveBeenCalledTimes(3);
    expect(t.paid).toHaveBeenLastCalledWith(2, 3, 0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.payments()).toHaveLength(3);
  });

  it('waits the initial interval and prepares synchronously before transmission', () => {
    const t = setup();
    t.transport.sendMessage.mockImplementation(msg => {
      expect(t.getBalance()).toBe(99);
      t.sent.push(msg);
    });
    t.scheduler.start();
    t.scheduler.start();
    vi.advanceTimersByTime(9_999);
    expect(t.preparePayment).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.preparePayment).toHaveBeenCalledExactlyOnceWith(1);
    expect(t.payments()).toEqual([{ type: 'token_payment', chunkId: 0, encodedToken: 'opaque-token-1' }]);
    t.scheduler.stop();
  });

  it('does not prepare a payment when its own injected balance is insufficient', async () => {
    const empty = setup(0);
    const funded = setup(2);
    empty.scheduler.start();
    funded.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(empty.exhausted).toHaveBeenCalledTimes(1);
    expect(empty.preparePayment).not.toHaveBeenCalled();
    expect(empty.sent).toEqual([]);
    expect(funded.payments()).toHaveLength(1);
    funded.scheduler.stop();
  });

  it('ignores unrelated and duplicate ACKs and resumes persisted counters', async () => {
    const t = setup(100, 7, 12);
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    t.receive({ type: 'payment_ack', chunkId: 6 });
    t.receive({ type: 'payment_nack', chunkId: 6, reason: 'old' });
    expect(t.stateChanged).not.toHaveBeenCalled();
    expect(t.failed).not.toHaveBeenCalled();
    t.receive({ type: 'payment_ack', chunkId: 7 });
    t.receive({ type: 'payment_ack', chunkId: 7 });
    expect(t.stateChanged).toHaveBeenCalledExactlyOnceWith({ chunkId: 8, totalSatsPaid: 13 });
    expect(t.paid).toHaveBeenCalledExactlyOnceWith(7, 13, 99);
    t.scheduler.stop();
  });

  it('stops on matching NACK without preparing again or refunding', async () => {
    const t = setup();
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    t.receive({ type: 'payment_nack', chunkId: 0, reason: 'rejected' });
    expect(t.failed).toHaveBeenCalledExactlyOnceWith('payment_nack for chunk #0: rejected');
    expect(t.stateChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.preparePayment).toHaveBeenCalledTimes(1);
    expect(t.getBalance()).toBe(99);
  });

  it.each(['preparation', 'transmission'] as const)('preserves %s failure reasons and pauses', async failure => {
    const t = setup();
    if (failure === 'preparation') {
      t.preparePayment.mockImplementation(() => { throw new Error('cannot prepare'); });
    } else {
      t.transport.sendMessage.mockImplementation(msg => {
        if (msg.type === 'token_payment') throw new Error('cannot transmit');
        t.sent.push(msg);
      });
    }
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const reason = failure === 'preparation' ? 'cannot prepare' : 'cannot transmit';
    expect(t.failed).toHaveBeenCalledExactlyOnceWith(reason);
    expect(t.sent).toEqual([{ type: 'session_paused', reason }]);
    expect(t.stateChanged).not.toHaveBeenCalled();
    expect(t.getBalance()).toBe(failure === 'preparation' ? 100 : 99);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.preparePayment).toHaveBeenCalledTimes(1);
  });

  it('stop cancels the initial timer and pending retry; a fresh scheduler resumes on reconnect', async () => {
    const t = setup();
    t.scheduler.start();
    t.scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sent).toEqual([]);
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    t.scheduler.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.payments()).toHaveLength(1);
    expect(t.failed).not.toHaveBeenCalled();
    const reconnected = setup(99);
    reconnected.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnected.payments()[0]?.chunkId).toBe(0);
    reconnected.scheduler.stop();
  });
});
