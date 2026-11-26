// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import markup from '../../room.html?raw';
import type { SignalingMessage } from '../types/signaling.js';

const mock = vi.hoisted(() => ({
  connect: () => {},
  message: (_message: SignalingMessage) => {},
  send: vi.fn(),
  disconnect: vi.fn(),
  prepare: vi.fn(),
  media: vi.fn(),
}));
vi.mock('../signaling-client.js', () => ({ SignalingClient: class {
  onConnect(fn: () => void) { mock.connect = fn; }
  onMessage(fn: (msg: SignalingMessage) => void) { mock.message = fn; }
  onDisconnecting() {}
  onDisconnect() {}
  onReconnected() {}
  setSessionId() {}
  send = mock.send;
  disconnect = mock.disconnect;
} }));
vi.mock('../lib/peer-connection.js', () => ({ PeerConnection: class {
  onIceCandidate() {}
  close() {}
  initMedia = mock.media;
} }));
vi.mock('../lib/config.js', () => ({ getMintUrl: () => 'https://mint.test' }));
vi.mock('../payments/cashu-session-payments.js', () => ({
  createCashuWallet: () => ({ estimateReceiptFee: async () => 1, createCashOut: vi.fn() }),
  createCashuReceiver: () => ({ reset: vi.fn(), receive: vi.fn() }),
  createCashuSender: () => ({ getBalance: () => 20, prepare: mock.prepare }),
  validateCashuSessionMint: vi.fn(),
  MintMismatchError: class extends Error {},
}));
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await nextTick(); };
const el = (id: string): HTMLElement => document.getElementById(id)!;
const pageListeners = vi.spyOn(window, 'addEventListener');
afterAll(() => pageListeners.mockRestore());

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = markup.split('<body class="room-body">')[1]!.split('</body>')[0]!;
});
afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  for (const [type, listener] of pageListeners.mock.calls) {
    if (type === 'pagehide' || type === 'pageshow') window.removeEventListener(type, listener);
  }
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('characterizes tutor rate consent, fees and the default create-session message', async () => {
  window.history.replaceState({}, '', '/room.html');
  await import('../pages/room.js');
  mock.connect();
  await flush();
  expect(el('status').textContent).toBe('connected -- configure rate and click Start Session');
  expect(el('effective-rate-display').textContent).toBe('12.0');
  expect(el('fee-overhead-display').textContent).toContain('~1 S/cycle (~50%)');
  expect(mock.send).not.toHaveBeenCalled();
  const free = el('free-seconds-input') as HTMLInputElement;
  free.value = '45';
  free.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el('start-session-btn').click();
  await flush();
  expect(mock.send).toHaveBeenCalledExactlyOnceWith({
    type: 'create_session', mintUrl: 'https://mint.test', rateSatsPerInterval: 2, intervalSeconds: 10, freeSeconds: 45,
  });
  expect((el('start-session-btn') as HTMLButtonElement).disabled).toBe(true);
});

it('characterizes viewer manual join without media or preparation before consent', async () => {
  window.history.replaceState({}, '', '/room.html?session=demo');
  await import('../pages/room.js');
  mock.connect();
  mock.message({ type: 'session_created', sessionId: 'demo', mintUrl: 'https://mint.test', rateSatsPerInterval: 2, intervalSeconds: 10, freeSeconds: 60 });
  await flush();
  expect(el('rate-config').style.display).toBe('none');
  expect(el('session-display').textContent).toBe('Session: demo');
  expect(el('join-confirm-overlay').classList.contains('hidden')).toBe(false);
  expect(el('join-confirm-rate').textContent).toBe('2 S every 10s');
  expect(el('join-confirm-free').textContent).toBe('Free for 60s, then the rate below.');
  expect(el('join-confirm-duration').textContent).toBe('~2 min 40s');
  expect(mock.send).toHaveBeenCalledWith({ type: 'join_session', sessionId: 'demo' });
  expect(mock.media).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
});

it('disposes the room on pagehide and creates a fresh view after bfcache restoration', async () => {
  window.history.replaceState({}, '', '/room.html');
  await import('../pages/room.js');
  const video = el('local-video');
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(document.getElementById('local-video')).toBeNull();
  expect(mock.disconnect).toHaveBeenCalledOnce();
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await flush();
  expect(el('local-video')).not.toBe(video);
  expect(document.body.firstElementChild?.tagName).toBe('H1');
});
