// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

const { unsubscribe, subscribe } = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return { unsubscribe, subscribe: vi.fn(() => unsubscribe) };
});
vi.mock('../payments/cashu-home-wallet.js', () => ({ cashuHomeWallet: {
  snapshot: () => ({ balance: 0, cashu: { denominations: [], proofCount: 0 } }),
  subscribe,
} }));

it('cleans up on page exit and remounts on back-forward cache restoration without a wrapper', async () => {
  await import('../pages/home.js');
  expect(document.body.firstElementChild?.tagName).toBe('H1');
  document.querySelector<HTMLButtonElement>('#deposit-btn')!.click();
  await nextTick();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await nextTick();
  expect(document.querySelector('#deposit-overlay')!.classList.contains('is-open')).toBe(false);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(unsubscribe).toHaveBeenCalledOnce();
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await nextTick();
  expect(document.querySelector('#start-streaming-btn')).not.toBeNull();
  expect(subscribe).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});
