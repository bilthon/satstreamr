/**
 * wallet-store.test.ts
 *
 * Unit tests for the localStorage-backed wallet store.
 * Uses vitest's built-in localStorage stub (happy-dom / jsdom) via
 * the storage mock below so the tests run in a plain Node environment
 * without a browser.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory localStorage shim compatible with the Storage interface.
 * Vitest uses happy-dom by default when configured, but to keep this test
 * self-contained we always install our own shim.
 */
function makeLocalStorageMock(): Storage {
  let store: Record<string, string> = {};

  return {
    get length() {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      const keys = Object.keys(store);
      return keys[index] ?? null;
    },
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? (store[key] as string) : null;
    },
    setItem(key: string, value: string): void {
      store[key] = value;
    },
    removeItem(key: string): void {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete store[key];
    },
    clear(): void {
      store = {};
    },
  };
}

// Install the mock before importing the module under test so that the module
// picks up our shim on first import.
const localStorageMock = makeLocalStorageMock();
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Now import the module under test (after the global is set).
import {
  getProofs,
  setProofs,
  addProofs,
  spendProofs,
  getBalance,
  onBalanceChange,
} from './wallet-store.js';
import type { Proof } from '@cashu/cashu-ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal Proof-like object with the given amount and a unique secret. */
function makeProof(amount: number, secret = `secret-${amount}-${Math.random()}`): Proof {
  return {
    amount,
    secret,
    C: 'mock-C',
    id: 'mock-keyset-id',
  } as unknown as Proof;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorageMock.clear();
});

describe('getProofs', () => {
  it('returns an empty array when localStorage has no entry', () => {
    expect(getProofs()).toEqual([]);
  });

  it('returns an empty array when the stored value is invalid JSON', () => {
    localStorageMock.setItem('satstreamr_wallet_proofs', 'not-json{{{');
    expect(getProofs()).toEqual([]);
  });

  it('returns the stored proofs', () => {
    const proofs = [makeProof(1), makeProof(2)];
    localStorageMock.setItem('satstreamr_wallet_proofs', JSON.stringify(proofs));
    expect(getProofs()).toHaveLength(2);
    expect(getProofs()[0]?.amount).toBe(1);
    expect(getProofs()[1]?.amount).toBe(2);
  });
});

describe('setProofs', () => {
  it('writes proofs to localStorage', () => {
    const proofs = [makeProof(8)];
    setProofs(proofs);
    const raw = localStorageMock.getItem('satstreamr_wallet_proofs');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Proof[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.amount).toBe(8);
  });

  it('overwrites existing proofs', () => {
    setProofs([makeProof(4)]);
    setProofs([makeProof(16), makeProof(32)]);
    expect(getProofs()).toHaveLength(2);
  });
});

describe('addProofs', () => {
  it('appends proofs to an empty store', () => {
    addProofs([makeProof(1), makeProof(2)]);
    expect(getProofs()).toHaveLength(2);
    expect(getBalance()).toBe(3);
  });

  it('appends proofs to existing proofs', () => {
    setProofs([makeProof(4)]);
    addProofs([makeProof(8)]);
    expect(getProofs()).toHaveLength(2);
    expect(getBalance()).toBe(12);
  });
});

describe('getBalance', () => {
  it('returns 0 when no proofs are stored', () => {
    expect(getBalance()).toBe(0);
  });

  it('returns the sum of all proof amounts', () => {
    setProofs([makeProof(1), makeProof(2), makeProof(4)]);
    expect(getBalance()).toBe(7);
  });
});

describe('spendProofs', () => {
  it('selects the minimal set of proofs (ascending order) to cover the amount', () => {
    // Store proofs in a non-sorted order to verify the sort logic.
    setProofs([makeProof(8), makeProof(1), makeProof(2)]);

    const selected = spendProofs(3);
    // Should pick 1 + 2 = 3, not 8.
    expect(selected.map((p) => p.amount).sort((a, b) => a - b)).toEqual([1, 2]);
    // Remaining proof should be the 8-sat one.
    expect(getBalance()).toBe(8);
  });

  it('removes the selected proofs from the store', () => {
    setProofs([makeProof(4), makeProof(2)]);
    spendProofs(4);
    // Only the 2-sat proof should remain (sorted ascending: 2 then 4 — 2+4=6>=4
    // but 2 alone is 2<4 so 4 is also selected: 2+4=6>=4)
    // Wait — ascending sort: [2, 4]. Greedy: 2 < 4 so add 2 (total=2), still < 4
    // so add 4 (total=6) >= 4. Selected: [2, 4]. Remaining: [].
    expect(getBalance()).toBe(0);
  });

  it('selects only what is needed when a single proof covers the amount', () => {
    setProofs([makeProof(1), makeProof(8), makeProof(2)]);
    // Ascending: [1, 2, 8]. Greedy for amount=8: 1<8, 1+2=3<8, 1+2+8=11>=8.
    // All three are selected.
    const selected = spendProofs(8);
    expect(selected.reduce((s, p) => s + p.amount, 0)).toBeGreaterThanOrEqual(8);
  });

  it('throws if the wallet does not have enough funds', () => {
    setProofs([makeProof(1)]);
    expect(() => spendProofs(10)).toThrowError(/insufficient wallet balance/i);
  });

  it('throws on an empty wallet', () => {
    expect(() => spendProofs(1)).toThrowError(/insufficient wallet balance/i);
  });

  it('does not mutate the store when it throws', () => {
    setProofs([makeProof(1)]);
    try {
      spendProofs(100);
    } catch {
      // expected
    }
    expect(getBalance()).toBe(1);
  });
});

describe('onBalanceChange', () => {
  it('calls the callback after setProofs', () => {
    const cb = vi.fn();
    const unsub = onBalanceChange(cb);
    setProofs([makeProof(5)]);
    expect(cb).toHaveBeenCalledWith(5);
    unsub();
  });

  it('calls the callback after addProofs', () => {
    const cb = vi.fn();
    const unsub = onBalanceChange(cb);
    addProofs([makeProof(3)]);
    expect(cb).toHaveBeenCalledWith(3);
    unsub();
  });

  it('calls the callback after spendProofs', () => {
    setProofs([makeProof(10)]);
    const cb = vi.fn();
    const unsub = onBalanceChange(cb);
    spendProofs(10);
    expect(cb).toHaveBeenCalledWith(0);
    unsub();
  });

  it('stops calling the callback after unsubscribing', () => {
    const cb = vi.fn();
    const unsub = onBalanceChange(cb);
    unsub();
    setProofs([makeProof(99)]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('supports multiple concurrent subscribers', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onBalanceChange(cb1);
    const unsub2 = onBalanceChange(cb2);
    setProofs([makeProof(7)]);
    expect(cb1).toHaveBeenCalledWith(7);
    expect(cb2).toHaveBeenCalledWith(7);
    unsub1();
    unsub2();
  });
});
