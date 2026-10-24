import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createCashuReceiver, createCashuSender, validateCashuSessionMint } from './cashu-session-payments.js';
import { getBalance, onBalanceChange, setProofs } from '../lib/wallet-store.js';
import { getMintUrl } from '../lib/config.js';
import type { DataChannelMessage } from '../types/data-channel.js';

const sdk = vi.hoisted(() => ({ decode: vi.fn(), swap: vi.fn(), states: vi.fn() }));
vi.mock('@cashu/cashu-ts', () => ({
  getDecodedToken: sdk.decode,
  getEncodedToken: vi.fn(() => 'encoded'),
  CashuMint: class {},
  CashuWallet: class {
    keysets = [{ active: true, unit: 'sat', id: 'key' }];
    loadMint = async () => {};
    getKeys = async () => ({});
    getFeesForProofs = () => 1;
    swap = sdk.swap;
    checkProofsStates = sdk.states;
  },
}));

const proof = (amount: number) => ({ amount, id: 'key', secret: `secret-${amount}`, C: 'point' });

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  sdk.decode.mockReset().mockReturnValue({ proofs: [proof(10)] });
  sdk.states.mockReset().mockResolvedValue([{ state: 'UNSPENT' }]);
  sdk.swap.mockReset().mockResolvedValue({ keep: [], send: [proof(9)] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
  const events: string[] = [];
  const sent: DataChannelMessage[] = [];
  let received = 0;
  const receiver = createCashuReceiver({
    sendMessage: message => { sent.push(message); events.push(message.type); },
    onReceived: amount => { received += amount; events.push(`received:${amount}`); },
    onReady: () => events.push('ready'),
  });
  return { receiver, events, sent, received: () => received };
}

describe('session sender', () => {
  it('validates mint without preparing and rolls back a failed preparation', async () => {
    const sender = createCashuSender();
    expect(() => validateCashuSessionMint('https://other.example')).toThrow('Mint mismatch');
    expect(sdk.swap).not.toHaveBeenCalled();
    validateCashuSessionMint(getMintUrl());
    setProofs([proof(21)]);
    sdk.swap.mockRejectedValue(new Error('offline'));
    await expect(sender.prepare(10)).rejects.toThrow('offline');
    expect(sender.getBalance()).toBe(21);
  });

  it('prepares exact chunks and reports nominal paid amounts after ACK', async () => {
    vi.useFakeTimers();
    const sender = createCashuSender();
    setProofs([proof(21)]);
    sdk.swap.mockResolvedValue({ keep: [], send: [proof(10), { ...proof(10), secret: 'second' }] });
    expect(await sender.prepare(10)).toBe(2);
    expect(sdk.swap).toHaveBeenCalledWith(20, [proof(21)], { outputAmounts: { sendAmounts: [10, 10] } });
    let incoming: (message: DataChannelMessage) => void = () => {};
    const sent = vi.fn();
    const paid = vi.fn();
    const state = vi.fn();
    const loop = sender.createSession({ sendMessage: sent, onMessage: handler => { incoming = handler; } }, {
      intervalSecs: 1, chunkSats: 10, initialChunkId: 3, initialTotalSatsPaid: 30, onStateChange: state,
    });
    loop.onChunkPaid(paid);
    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveBeenCalledWith({ type: 'token_payment', chunkId: 3, encodedToken: 'encoded' });
    expect(sender.getBalance()).toBe(10);
    incoming({ type: 'payment_ack', chunkId: 3 });
    expect(paid).toHaveBeenCalledWith(3, 40, 10);
    expect(state).toHaveBeenCalledWith({ chunkId: 4, totalSatsPaid: 40 });
    loop.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe('session receiver', () => {
  it('checks and claims before ACK, counts net sats before wallet append', async () => {
    const s = setup();
    sdk.states.mockImplementation(async () => { s.events.push('check'); return [{ state: 'UNSPENT' }]; });
    sdk.swap.mockImplementation(async (amount: number) => {
      s.events.push(`swap:${amount}`);
      return { keep: [], send: [proof(9)] };
    });
    const unsubscribe = onBalanceChange(balance => s.events.push(`wallet:${balance}`));
    await s.receiver.receive(0, 'token');
    unsubscribe();
    expect(s.events).toEqual(['check', 'swap:9', 'payment_ack', 'received:9', 'wallet:9', 'ready']);
    expect(s.received()).toBe(9);
    expect(getBalance()).toBe(9);
  });

  it.each([
    ['decode', 'decode_error: broken'],
    ['spent', 'double_spend'],
    ['check', 'state_check_error: broken'],
    ['claim', 'broken'],
  ])('rejects %s without credit or counter changes', async (failure, reason) => {
    const s = setup();
    if (failure === 'decode') sdk.decode.mockImplementation(() => { throw new Error('broken'); });
    if (failure === 'spent') sdk.states.mockResolvedValue([{ state: 'SPENT' }]);
    if (failure === 'check') sdk.states.mockRejectedValue(new Error('broken'));
    if (failure === 'claim') sdk.swap.mockRejectedValue(new Error('broken'));
    await s.receiver.receive(0, 'token');
    expect(s.sent).toEqual([{ type: 'payment_nack', chunkId: 0, reason }]);
    expect(s.received()).toBe(0);
    expect(getBalance()).toBe(0);
    if (failure !== 'claim') expect(sdk.swap).not.toHaveBeenCalled();
  });

  it('allows pending proofs through the existing swap path and retries rejected chunks', async () => {
    const s = setup();
    sdk.states.mockRejectedValueOnce(new Error('offline'));
    await s.receiver.receive(0, 'token');
    sdk.states.mockResolvedValue([{ state: 'PENDING' }]);
    await s.receiver.receive(0, 'token');
    expect(s.sent).toEqual([
      { type: 'payment_nack', chunkId: 0, reason: 'state_check_error: offline' },
      { type: 'payment_ack', chunkId: 0 },
    ]);
    expect(s.received()).toBe(9);
  });

  it('does not serialize in-flight claims or pin replies to an old channel', async () => {
    const replies: string[] = [];
    let channel = 'old';
    const receiver = createCashuReceiver({
      sendMessage: message => replies.push(`${channel}:${message.type}`),
      onReceived: () => {}, onReady: () => {},
    });
    let release!: (value: { keep: ReturnType<typeof proof>[]; send: ReturnType<typeof proof>[] }) => void;
    const claim = new Promise<{ keep: ReturnType<typeof proof>[]; send: ReturnType<typeof proof>[] }>(resolve => { release = resolve; });
    sdk.swap.mockReturnValue(claim);
    const first = receiver.receive(0, 'token');
    const second = receiver.receive(0, 'token');
    // Both receipts pass duplicate validation before either claim completes.
    channel = 'new';
    release({ keep: [], send: [proof(9)] });
    await Promise.all([first, second]);
    expect(sdk.swap).toHaveBeenCalledTimes(2);
    expect(replies).toEqual(['new:payment_ack', 'new:payment_ack']);
    expect(getBalance()).toBe(18);
  });

  it('rejects duplicate/out-of-order chunks before decoding and resets only explicitly', async () => {
    const s = setup();
    await s.receiver.receive(2, 'token');
    sdk.decode.mockClear();
    await s.receiver.receive(2, 'token');
    await s.receiver.receive(1, 'token');
    expect(sdk.decode).not.toHaveBeenCalled();
    expect(s.sent.slice(1)).toEqual([2, 1].map(chunkId => ({ type: 'payment_nack', chunkId, reason: 'duplicate_chunk_id' })));
    expect(s.received()).toBe(9);
    expect(getBalance()).toBe(9);
    s.receiver.reset();
    await s.receiver.receive(0, 'token');
    expect(s.received()).toBe(18);
  });
});
