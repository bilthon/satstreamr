// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import RoomApp from './RoomApp.vue';
import type { RoomServices } from './use-room.js';
import type { SignalingMessage } from '../types/signaling.js';
import type { SignalingClient } from '../signaling-client.js';
import type { PeerConnection } from '../lib/peer-connection.js';
import type { ReceiptCallbacks, SendingSessionOptions } from '../payments/session-payments.js';
import type { DataChannelMessage } from '../types/data-channel.js';
import { MintMismatchError } from '../lib/mint-guard.js';
import { saveSession, loadSession } from '../lib/session-storage.js';

const played: string[] = [];
vi.stubGlobal('Audio', class {
  currentTime = 0;
  constructor(readonly src: string) {}
  play() { played.push(this.src); return Promise.resolve(); }
});

let app: App | undefined;
let root: HTMLDivElement;
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await nextTick(); };

function harness(search = '', balance = 20, options?: { distinctPeers?: boolean }) {
  let connected = () => {};
  let disconnecting = () => {};
  let disconnected = () => {};
  let reconnected = () => {};
  let balanceChanged = (_balance: number) => {};
  let paymentFailure = (_reason: string) => {};
  let exhausted = () => {};
  let paid = (_id: number, _total: number, _balance: number) => {};
  let receipt!: ReceiptCallbacks;
  let channelMessage = (_message: DataChannelMessage) => {};
  let sessionOptions!: SendingSessionOptions;
  const unsubscribe = vi.fn();
  const scheduler = {
    start: vi.fn(), stop: vi.fn(),
    onPaymentFailure: (fn: typeof paymentFailure) => { paymentFailure = fn; },
    onBudgetExhausted: (fn: typeof exhausted) => { exhausted = fn; },
    onChunkPaid: (fn: typeof paid) => { paid = fn; },
  };
  const channel = { sendMessage: vi.fn(), onMessage: (fn: typeof channelMessage) => { channelMessage = fn; } };
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const receiver = { receive: vi.fn(), reset: vi.fn() };
  const quote = { amount: 10, feeReserve: 2, inputFee: 1, pay: vi.fn().mockResolvedValue({ paid: true, changeSats: 1 }) };
  const cashOut = {
    hasFunds: true,
    balance: 14,
    explain: vi.fn().mockResolvedValue({ balance: 14, inputFee: 3, lightningBuffer: 2, maxAmount: 9 }),
    quote: vi.fn().mockResolvedValue(quote),
  };
  let message = (_message: SignalingMessage) => {};
  const send = vi.fn();
  const client = {
    onConnect: (fn: () => void) => { connected = fn; },
    onMessage: (fn: (msg: SignalingMessage) => void) => { message = fn; },
    onDisconnecting: (fn: () => void) => { disconnecting = fn; },
    onDisconnect: (fn: () => void) => { disconnected = fn; },
    onReconnected: (fn: () => void) => { reconnected = fn; },
    setSessionId: vi.fn(), send, disconnect: vi.fn(),
  };
  const peers: Array<{
    onIceCandidate: ReturnType<typeof vi.fn>;
    onTrack: PeerConnection['onTrack'];
    onIceStateChange: PeerConnection['onIceStateChange'];
    onDataChannel: PeerConnection['onDataChannel'];
    initMedia: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    createPaymentChannel: ReturnType<typeof vi.fn>;
    createOffer: ReturnType<typeof vi.fn>;
    handleOffer: ReturnType<typeof vi.fn>;
    handleAnswer: ReturnType<typeof vi.fn>;
    addIceCandidate: ReturnType<typeof vi.fn>;
    useIceServers: ReturnType<typeof vi.fn>;
  }> = [];
  function makePeer() {
    const created = {
      onIceCandidate: vi.fn(),
      onTrack: null as PeerConnection['onTrack'],
      onIceStateChange: null as PeerConnection['onIceStateChange'],
      onDataChannel: null as PeerConnection['onDataChannel'],
      initMedia: vi.fn().mockResolvedValue(stream), close: vi.fn(), createPaymentChannel: vi.fn(),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake' }),
      handleOffer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake' }),
      handleAnswer: vi.fn(), addIceCandidate: vi.fn(), useIceServers: vi.fn(),
    };
    peers.push(created);
    return created;
  }
  let peer = options?.distinctPeers ? undefined : makePeer();
  const services: RoomServices = {
    createClient: () => client as unknown as SignalingClient,
    createPeer: () => {
      if (!options?.distinctPeers) return peer as unknown as PeerConnection;
      peer = makePeer();
      return peer as unknown as PeerConnection;
    },
    createChannel: vi.fn().mockReturnValue(channel),
    wallet: { createCashOut: vi.fn().mockReturnValue(cashOut), estimateReceiptFee: vi.fn().mockResolvedValue(1) },
    sender: {
      getBalance: () => balance,
      onBalanceChange: vi.fn(fn => { balanceChanged = fn; return unsubscribe; }),
      prepare: vi.fn<(amount: number) => Promise<number>>().mockResolvedValue(10),
      createSession: vi.fn((_transport, options) => { sessionOptions = options; return scheduler; }),
    },
    createReceiver: vi.fn(callbacks => { receipt = callbacks; return receiver; }),
    validateMint: vi.fn(), mintUrl: 'https://mint.test', isDev: true,
    navigate: vi.fn(),
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(RoomApp, { services, search });
  app.mount(root);
  if (peer === undefined) throw new Error('peer was not created');
  const roomPeer = peer;
  return {
    services, client, peer: roomPeer, peers, send, stream, stopTrack, scheduler, unsubscribe, receiver, cashOut, quote, channel,
    receipt: () => receipt,
    connect: () => connected(),
    disconnecting: () => disconnecting(),
    disconnected: () => disconnected(),
    reconnected: () => reconnected(),
    message: (msg: SignalingMessage) => message(msg),
    balance: (value: number) => balanceChanged(value),
    fail: (reason: string) => paymentFailure(reason),
    exhaust: () => exhausted(),
    paid: (id: number, total: number, remaining: number) => paid(id, total, remaining),
    receive: (amount: number) => receipt.onReceived(amount),
    channelMessage: (msg: DataChannelMessage) => channelMessage(msg),
    persist: (chunkId: number, totalSatsPaid: number) => sessionOptions.onStateChange?.({ chunkId, totalSatsPaid }),
    openChannel() {
      const raw = { onopen: null, onclose: null } as unknown as RTCDataChannel;
      roomPeer.onDataChannel?.({ channel: raw } as RTCDataChannelEvent);
      raw.onopen?.call(raw, new Event('open'));
      return raw;
    },
  };
}

afterEach(() => {
  app?.unmount();
  root?.remove();
  localStorage.clear();
  sessionStorage.clear();
  played.length = 0;
  vi.useRealTimers();
});

it('selects tutor without a session query and creates only after Start Session', async () => {
  const h = harness();
  h.connect();
  await flush();
  expect(root.querySelector('#status')?.textContent).toBe('connected -- configure rate and click Start Session');
  expect(h.send).not.toHaveBeenCalled();
  root.querySelector<HTMLButtonElement>('#start-session-btn')!.click();
  await flush();
  expect(h.send).toHaveBeenCalledWith({ type: 'create_session', mintUrl: 'https://mint.test', rateSatsPerInterval: 2, intervalSeconds: 10, freeSeconds: 0 });
  expect(root.querySelector<HTMLButtonElement>('#start-session-btn')!.disabled).toBe(true);
});

const el = <T extends HTMLElement = HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
async function click(id: string): Promise<void> { el(id).click(); await flush(); }
async function input(id: string, value: string): Promise<void> {
  el<HTMLInputElement>(id).value = value;
  el(id).dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
const created: SignalingMessage = {
  type: 'session_created', sessionId: 'demo', mintUrl: 'https://mint.test', rateSatsPerInterval: 2, intervalSeconds: 10,
};
async function acceptViewer(h: ReturnType<typeof harness>): Promise<void> {
  h.connect();
  h.message(created);
  await flush();
  await click('join-confirm-accept');
  h.message({ type: 'offer', sessionId: 'demo', sdp: { type: 'offer', sdp: 'fake' } });
  await flush();
}

it('delays the first charge by the free preview on the session', async () => {
  const h = harness('?session=demo');
  h.connect();
  h.message({ ...created, freeSeconds: 45 });
  await flush();
  expect(el('join-confirm-free').textContent).toBe('Free for 45s, then the rate below.');
  await click('join-confirm-accept');
  h.openChannel();
  expect(h.services.sender.createSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    initialDelaySecs: 45,
    intervalSecs: 10,
  }));
});

it('shows the free preview draining until the first charge', async () => {
  vi.useFakeTimers();
  const h = harness('?session=demo');
  h.connect();
  h.message({ ...created, freeSeconds: 45 });
  await flush();
  await click('join-confirm-accept');
  h.openChannel();
  await flush();
  expect(el('free-preview').getAttribute('aria-valuenow')).toBe('45');
  expect(el('free-preview').getAttribute('aria-valuemax')).toBe('45');
  expect(el('free-preview-remaining').textContent).toBe('00:45');
  expect(el('free-preview-fill').style.width).toBe('100%');
  await vi.advanceTimersByTimeAsync(15_000);
  await flush();
  expect(el('free-preview').getAttribute('aria-valuenow')).toBe('30');
  expect(el('free-preview-remaining').textContent).toBe('00:30');
  expect(el('free-preview-fill').style.width).toBe(`${30 / 45 * 100}%`);
  await vi.advanceTimersByTimeAsync(30_000);
  await flush();
  expect(root.querySelector('#free-preview')).toBeNull();
});

it('shows no free preview when the session offers none', async () => {
  const h = harness('?session=demo');
  h.connect();
  h.message(created);
  await flush();
  await click('join-confirm-accept');
  h.openChannel();
  await flush();
  expect(el('viewer-stats').style.display).toBe('flex');
  expect(root.querySelector('#free-preview')).toBeNull();
});

it('resumes the free preview from the saved deadline after a refresh', async () => {
  vi.useFakeTimers();
  saveSession({ sessionId: 'demo', peerId: '', role: 'viewer', chunkCount: 0, totalSatsPaid: 0, freeEndsAt: Date.now() + 20_000 });
  const h = harness('?session=demo');
  h.connect();
  h.message({ ...created, freeSeconds: 45 });
  await flush();
  await click('join-confirm-accept');
  h.openChannel();
  await flush();
  expect(el('free-preview').getAttribute('aria-valuenow')).toBe('20');
  expect(el('free-preview').getAttribute('aria-valuemax')).toBe('45');
  expect(el('free-preview-remaining').textContent).toBe('00:20');
  expect(el('free-preview-fill').style.width).toBe(`${20 / 45 * 100}%`);
  expect(h.services.sender.createSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialDelaySecs: 20 }));
});

it('keeps both video nodes and srcObject stable through rate, ceremony, receipt and summary updates', async () => {
  vi.useFakeTimers();
  const h = harness();
  const local = el<HTMLVideoElement>('local-video');
  const remote = el<HTMLVideoElement>('remote-video');
  const remoteStream = {} as MediaStream;
  h.peer.onTrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent);
  await input('rate-sats-input', '5');
  await input('rate-interval-input', '15');
  expect(el('effective-rate-display').textContent).toBe('20.0');
  h.connect();
  await click('start-session-btn');
  h.message(created);
  await flush();
  expect(local.srcObject).toBe(h.stream);
  expect(el('go-live-count').textContent).toBe('3');
  await vi.advanceTimersByTimeAsync(3400);
  await flush();
  expect(el('invite-url').textContent).toContain('/room.html?session=demo');
  h.message({ type: 'viewer_joined', viewerId: 'viewer' });
  await flush();
  expect(h.peer.createPaymentChannel.mock.invocationCallOrder[0]).toBeLessThan(h.peer.createOffer.mock.invocationCallOrder[0]!);
  h.openChannel();
  h.receive(2);
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
  expect(el('elapsed-time').textContent).toBe('00:02');
  expect(el('sats-received').textContent).toBe('2');
  await click('exit-session-btn');
  expect(el('session-summary-overlay').classList.contains('visible')).toBe(true);
  expect(el('summary-sats').textContent).toBe('2');
  expect(el('local-video')).toBe(local);
  expect(el('remote-video')).toBe(remote);
  expect(remote.srcObject).toBe(remoteStream);
  expect(h.stopTrack).toHaveBeenCalled();
  h.message({ type: 'session_ended' });
  expect(JSON.parse(localStorage.getItem('satstreamr_session_history')!).length).toBe(1);
  await click('summary-close-btn');
  expect(h.services.navigate).toHaveBeenCalledWith('/');
  expect(loadSession()).toBeNull();
});

it('keeps the newest receipt float for its own lifetime', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.openChannel();
  h.receive(2);
  await vi.advanceTimersByTimeAsync(500);
  h.receive(3);
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(root.querySelector('.payment-float')?.textContent).toBe('+3 S');
  await vi.advanceTimersByTimeAsync(500);
  await flush();
  expect(root.querySelector('.payment-float')).toBeNull();
});

it('waits for signaling if Start is clicked early and supports rate info toggle', async () => {
  const h = harness();
  await click('fee-info-btn');
  expect(el('fee-info-panel').classList.contains('open')).toBe(true);
  await click('start-session-btn');
  expect(h.send).not.toHaveBeenCalled();
  h.connect();
  expect(h.send).toHaveBeenCalledOnce();
});

it('rejoins saved tutor sessions and handles a stale-session error without inventing new counters', async () => {
  vi.useFakeTimers();
  saveSession({ sessionId: 'saved', peerId: '', role: 'tutor', chunkCount: 7, totalSatsPaid: 14 });
  const h = harness();
  h.connect();
  expect(h.send).toHaveBeenCalledWith({ type: 'rejoin_session', sessionId: 'saved' });
  h.message({ type: 'error', code: 'SESSION_NOT_FOUND', message: 'gone' });
  await flush();
  expect(loadSession()).toBeNull();
  expect(el('status').textContent).toBe('connected -- configure rate and click Start Session');
  await click('start-session-btn');
  expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create_session' }));
});

it('reacquires tutor media and renegotiates after session_rejoined', async () => {
  saveSession({ sessionId: 'saved', peerId: '', role: 'tutor', chunkCount: 0, totalSatsPaid: 0 });
  const h = harness();
  h.connect();
  h.message({ type: 'session_rejoined', sessionId: 'saved', bufferedCount: 0 });
  await flush();
  expect(h.peer.initMedia).toHaveBeenCalledOnce();
  expect(h.peer.createOffer).toHaveBeenCalledWith(h.stream);
  expect(h.send).toHaveBeenCalledWith({ type: 'offer', sessionId: 'saved', sdp: { type: 'offer', sdp: 'fake' } });
  expect(el('rate-config').style.display).toBe('none');
  expect(el('exit-session-btn').style.display).toBe('inline-block');
});

it('shows empty-wallet guidance without starting payments', async () => {
  vi.useFakeTimers();
  const h = harness('?session=demo', 0);
  h.connect(); h.message(created); await flush();
  expect(root.querySelector('.toast-warning')?.textContent).toBe('Your wallet is empty. Fund your wallet before joining a session.');
  expect(el('join-confirm-duration').textContent).toBe('0 — deposit first');
  expect(h.services.sender.prepare).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(8500);
  await flush();
  expect(root.querySelector('.toast-warning')).toBeNull();
});

it('requires viewer consent before media, wallet preparation or offer/answer', async () => {
  vi.useFakeTimers();
  const h = harness('?session=demo');
  h.connect();
  h.message(created);
  h.message({ type: 'offer', sessionId: 'demo', sdp: { type: 'offer', sdp: 'fake' } });
  await flush();
  expect(el('rate-config').style.display).toBe('none');
  expect(el('join-confirm-overlay').classList.contains('hidden')).toBe(false);
  expect(document.activeElement).toBe(el('join-confirm-accept'));
  expect(h.peer.initMedia).not.toHaveBeenCalled();
  expect(h.services.sender.prepare).not.toHaveBeenCalled();
  expect(h.peer.handleOffer).not.toHaveBeenCalled();
  expect(loadSession()).toBeNull();
  await click('join-confirm-accept');
  // Offer can already be waiting for media; allow its existing 100ms polling step.
  await vi.advanceTimersByTimeAsync(100);
  await flush();
  expect(h.peer.initMedia).toHaveBeenCalledOnce();
  expect(h.services.sender.prepare).toHaveBeenCalledWith(2);
  expect(h.peer.handleOffer).toHaveBeenCalled();
  expect(loadSession()?.role).toBe('viewer');
});

it('renders pending invite consent before connection and cancels without charging', async () => {
  sessionStorage.setItem('pending_join', JSON.stringify({ rateSatsPerInterval: 5, intervalSeconds: 30, mintUrl: '<img src=x>' }));
  const h = harness('?session=demo');
  await flush();
  expect(el('join-confirm-rate').textContent).toBe('5 S every 30s');
  expect(el('join-confirm-mint').textContent).toBe('<img src=x>');
  expect(el('join-confirm-mint').querySelector('img')).toBeNull();
  h.connect();
  await click('join-confirm-cancel');
  expect(h.services.navigate).toHaveBeenCalledWith('/');
  expect(h.client.disconnect).toHaveBeenCalled();
  expect(h.send).toHaveBeenCalledWith({ type: 'end_session', sessionId: 'demo' });
  expect(h.services.sender.prepare).not.toHaveBeenCalled();
  expect(h.peer.initMedia).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('pending_join')).toBeNull();
});

it('blocks a mint mismatch and preserves the empty session query viewer role', async () => {
  const h = harness('?session=');
  vi.mocked(h.services.validateMint).mockImplementation(() => { throw new MintMismatchError('https://other.test', 'https://mint.test'); });
  h.connect();
  h.message(created);
  await flush();
  expect(h.send).toHaveBeenCalledWith({ type: 'join_session', sessionId: '' });
  expect(el('mint-mismatch-overlay').classList.contains('hidden')).toBe(false);
  expect(el('session-mint-url').textContent).toBe('https://other.test');
  expect(h.services.sender.prepare).not.toHaveBeenCalled();
});

it('restores viewer counters, updates budget, pauses/reconnects and releases channel subscriptions', async () => {
  vi.useFakeTimers();
  saveSession({ sessionId: 'demo', peerId: 'peer', role: 'viewer', chunkCount: 4, totalSatsPaid: 8 });
  const h = harness('?session=demo');
  await acceptViewer(h);
  const video = el('remote-video');
  const raw = h.openChannel();
  await flush();
  expect(h.services.sender.createSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialChunkId: 4, initialTotalSatsPaid: 8 }));
  expect(h.scheduler.start).toHaveBeenCalledOnce();
  h.balance(2);
  await flush();
  expect(el('budget-display').textContent).toBe('2 S');
  expect(el('budget-low-banner').classList.contains('countdown-phase')).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  await flush();
  expect(el('countdown-display').textContent).toBe('9s');
  h.fail('offline');
  await flush();
  expect(el('payment-paused-banner').classList.contains('visible')).toBe(true);
  h.paid(4, 10, 20);
  h.persist(5, 10);
  await flush();
  expect(loadSession()?.chunkCount).toBe(5);
  expect(el('payment-paused-banner').classList.contains('visible')).toBe(false);
  h.disconnecting();
  await flush();
  expect(el('reconnect-overlay').style.display).toBe('flex');
  expect(h.scheduler.stop).toHaveBeenCalled();
  h.reconnected();
  await flush();
  expect(el('status').textContent).toBe('reconnected -- session demo');
  expect(el('remote-video')).toBe(video);
  raw.onclose?.call(raw, new Event('close'));
  expect(h.unsubscribe).toHaveBeenCalledOnce();
  await click('exit-session-btn');
  expect(el('summary-sats').textContent).toBe('10');
  app!.unmount(); app = undefined;
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(h.client.disconnect).toHaveBeenCalled();
});

it('ends an exhausted viewer session and stops media/scheduling', async () => {
  const h = harness('?session=demo');
  await acceptViewer(h);
  h.openChannel();
  h.exhaust();
  await flush();
  expect(el('error').textContent).toBe('Budget exhausted — session ended');
  expect(el('session-summary-overlay').classList.contains('visible')).toBe(true);
  expect(h.scheduler.stop).toHaveBeenCalled();
  expect(h.unsubscribe).toHaveBeenCalled();
  expect(h.stopTrack).toHaveBeenCalled();
  expect(h.client.disconnect).toHaveBeenCalled();
});

it('stops media that resolves after unmount without preparing a new session', async () => {
  const h = harness('?session=demo');
  let resolve!: (stream: MediaStream) => void;
  h.peer.initMedia.mockReturnValue(new Promise(r => { resolve = r; }));
  h.connect(); h.message(created); await flush(); await click('join-confirm-accept');
  app!.unmount(); app = undefined;
  resolve(h.stream); await flush();
  expect(h.stopTrack).toHaveBeenCalledOnce();
  expect(h.peer.handleOffer).not.toHaveBeenCalled();
});

it.each(['paid', 'unpaid', 'quote-error', 'pay-error'] as const)('preserves tutor cash-out %s behavior', async outcome => {
  vi.useFakeTimers();
  const h = harness();
  h.connect(); h.message(created); await flush();
  await vi.advanceTimersByTimeAsync(3400); await flush();
  h.receive(42);
  await click('exit-session-btn');
  expect(h.services.wallet.createCashOut).toHaveBeenCalledOnce();
  expect(el('summary-sats').textContent).toBe('42');
  expect(el('summary-melt-fee').textContent).toContain('3');
  expect(el('summary-lightning').textContent).toContain('2');
  expect(el('summary-available').textContent).toContain('37');
  await input('invoice-input', 'wrong');
  expect(el('cashout-status').textContent).toContain('Invalid invoice');
  await click('pay-invoice-btn');
  expect(h.cashOut.quote).not.toHaveBeenCalled();
  await input('invoice-input', 'lnbcrt-fake');
  expect(el('invoice-countdown').textContent).toBe('600s');
  if (outcome === 'unpaid') h.quote.pay.mockResolvedValue({ paid: false, changeSats: 0 });
  if (outcome === 'quote-error') h.cashOut.quote.mockRejectedValue(new Error('quote offline'));
  if (outcome === 'pay-error') h.quote.pay.mockRejectedValue(new Error('pay offline'));
  await click('pay-invoice-btn');
  const expected = { paid: '✓ Payment sent! (1 sats fee change returned)', unpaid: 'Payment not confirmed by mint. Please retry.', 'quote-error': 'quote offline', 'pay-error': 'pay offline' };
  expect(el('cashout-status').textContent).toBe(expected[outcome]);
  expect(el<HTMLButtonElement>('pay-invoice-btn').disabled).toBe(outcome === 'paid');
  if (outcome === 'paid') {
    expect(el('summary-melt-fee').textContent).toContain('1');
    expect(el('summary-lightning').textContent).toContain('2');
    expect(el('summary-available').textContent).toContain('39');
    expect(el('summary-available').textContent).not.toContain('~');
  }
});

it('lets an in-flight receipt finish after disposal without sending on the closed view transport', async () => {
  const h = harness();
  const credit = vi.fn();
  let finish!: () => void;
  h.receiver.receive.mockImplementation(() => new Promise<void>(resolve => {
    finish = () => {
      h.receipt().sendMessage({ type: 'payment_ack', chunkId: 0 });
      h.receipt().onReceived(2);
      credit(2);
      h.receipt().onReady();
      resolve();
    };
  }));
  h.openChannel();
  h.channelMessage({ type: 'token_payment', chunkId: 0, encodedToken: 'fake-token' });
  expect(h.receiver.receive).toHaveBeenCalledWith(0, 'fake-token');
  app!.unmount(); app = undefined;
  h.channel.sendMessage.mockImplementation(() => { throw new Error('closed'); });
  expect(() => finish()).not.toThrow();
  await flush();
  expect(credit).toHaveBeenCalledExactlyOnceWith(2);
  expect(root.children.length).toBe(0);
});

it('does not abandon cash-out settlement when the room unmounts during quote lookup', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.connect(); h.message(created); await flush();
  await vi.advanceTimersByTimeAsync(3400); await flush();
  await click('exit-session-btn');
  let resolve!: (quote: typeof h.quote) => void;
  h.cashOut.quote.mockReturnValue(new Promise(r => { resolve = r; }));
  await input('invoice-input', 'lnbcrt-fake');
  await click('pay-invoice-btn');
  app!.unmount(); app = undefined;
  resolve(h.quote); await flush();
  expect(h.quote.pay).toHaveBeenCalledOnce();
  expect(root.children.length).toBe(0);
});

const turnServers = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }];
const remoteSrflx = {
  candidate: 'candidate:1 1 udp 2122260223 203.0.113.5 50000 typ srflx',
  sdpMid: '0',
  sdpMLineIndex: 0,
};

it('answers with remote candidates that arrived before local media was ready', async () => {
  vi.useFakeTimers();
  const h = harness('?session=demo', 20, { distinctPeers: true });
  let resolveMedia!: (stream: MediaStream) => void;
  h.peers[0]!.initMedia.mockReturnValue(new Promise(resolve => { resolveMedia = resolve; }));
  h.connect();
  h.message(created);
  await flush();
  await click('join-confirm-accept');
  h.message({ type: 'offer', sessionId: 'demo', sdp: { type: 'offer', sdp: 'fake' } });
  h.message({ type: 'ice_candidate', candidate: remoteSrflx, fromPeerId: 'tutor' });
  resolveMedia(h.stream);
  await vi.advanceTimersByTimeAsync(100);
  await flush();
  const answering = h.peers.find(item => item.handleOffer.mock.calls.length > 0);
  expect(answering?.addIceCandidate).toHaveBeenCalledWith(remoteSrflx);
});

it('gives the negotiated peer the TURN servers from signaling', async () => {
  const viewer = harness('?session=demo', 20, { distinctPeers: true });
  viewer.connect();
  viewer.message({ ...created, iceServers: turnServers } as SignalingMessage);
  await flush();
  await click('join-confirm-accept');
  viewer.message({ type: 'offer', sessionId: 'demo', sdp: { type: 'offer', sdp: 'fake' } });
  await flush();
  const answering = viewer.peers.find(item => item.handleOffer.mock.calls.length > 0);
  expect(answering?.useIceServers).toHaveBeenCalledWith(turnServers);
  app?.unmount();
  root.remove();

  const tutor = harness('', 20, { distinctPeers: true });
  tutor.connect();
  await click('start-session-btn');
  tutor.message({ ...created, iceServers: turnServers } as SignalingMessage);
  await flush();
  tutor.message({ type: 'viewer_joined', viewerId: 'viewer', iceServers: turnServers } as SignalingMessage);
  await flush();
  const offering = tutor.peers.find(item => item.createOffer.mock.calls.length > 0);
  expect(offering?.useIceServers).toHaveBeenCalledWith(turnServers);
});

it('keeps the answer status when wallet preparation finishes afterwards', async () => {
  const h = harness('?session=demo');
  let resolvePrepare!: (value: number) => void;
  vi.mocked(h.services.sender.prepare).mockReturnValue(new Promise(resolve => { resolvePrepare = resolve; }));
  h.connect();
  h.message(created);
  await flush();
  await click('join-confirm-accept');
  h.message({ type: 'offer', sessionId: 'demo', sdp: { type: 'offer', sdp: 'fake' } });
  await flush();
  expect(el('status').textContent).toBe('answer sent -- waiting for ICE…');
  resolvePrepare(10);
  await flush();
  expect(el('status').textContent).toBe('answer sent -- waiting for ICE…');
});

const muteButton = () => el<HTMLButtonElement>('tip-sound-mute');
const soundChoice = () => el<HTMLSelectElement>('tip-sound-choice');
async function choose(value: string): Promise<void> {
  soundChoice().value = value;
  soundChoice().dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}
function remount(search = ''): ReturnType<typeof harness> {
  app!.unmount();
  root.remove();
  return harness(search);
}

it('shows the tip sound controls to the tutor only', async () => {
  harness();
  await flush();
  expect(muteButton().getAttribute('aria-label')).toBe('Mute tip sound');
  expect(muteButton().getAttribute('aria-pressed')).toBe('false');
  expect(soundChoice().getAttribute('aria-label')).toBe('Tip sound');
  expect(soundChoice().value).toBe('sats-zap');
  expect([...soundChoice().options].map(option => option.textContent)).toEqual(['Zap', 'Coin', 'Sparkle', 'Cash register', 'Off']);

  remount('?session=demo');
  await flush();
  expect(root.querySelector('#tip-sound-mute')).toBeNull();
  expect(root.querySelector('#tip-sound-choice')).toBeNull();
});

it('mutes and unmutes the tip sound and remembers it across a remount', async () => {
  harness();
  await flush();
  await click('tip-sound-mute');
  expect(played).toEqual([]);
  expect(muteButton().getAttribute('aria-label')).toBe('Unmute tip sound');
  expect(muteButton().getAttribute('aria-pressed')).toBe('true');
  expect(soundChoice().value).toBe('off');

  remount();
  await flush();
  expect(muteButton().getAttribute('aria-pressed')).toBe('true');
  expect(soundChoice().value).toBe('off');
  await click('tip-sound-mute');
  expect(muteButton().getAttribute('aria-label')).toBe('Mute tip sound');
  expect(soundChoice().value).toBe('sats-zap');
  expect(played).toHaveLength(1);
  expect(played[0]).toContain('sats-zap.mp3');
});

it('previews a chosen sound, treats Off as mute, and remembers the choice across a remount', async () => {
  harness();
  await flush();
  await choose('sats-coin');
  expect(played).toHaveLength(1);
  expect(played[0]).toContain('sats-coin.mp3');
  await choose('off');
  expect(played).toHaveLength(1);
  expect(muteButton().getAttribute('aria-pressed')).toBe('true');

  remount();
  await flush();
  expect(soundChoice().value).toBe('off');
  await click('tip-sound-mute');
  expect(soundChoice().value).toBe('sats-coin');
  expect(played.at(-1)).toContain('sats-coin.mp3');
});

it('plays the tip sound for a claimed payment unless muted', async () => {
  const h = harness();
  h.openChannel();
  h.receive(2);
  await flush();
  expect(el('sats-received').textContent).toContain('2');
  expect(played).toHaveLength(1);
  expect(played[0]).toContain('sats-zap.mp3');

  await click('tip-sound-mute');
  h.receive(3);
  await flush();
  expect(el('sats-received').textContent).toContain('5');
  expect(played).toHaveLength(1);
});
