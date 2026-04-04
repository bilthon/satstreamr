/**
 * wallet-store.ts
 *
 * localStorage-backed Cashu proof storage for satstreamr.
 *
 * All Cashu proofs are persisted under a single localStorage key so that the
 * wallet balance survives tab close and browser restarts.
 *
 * Key: satstreamr_wallet_proofs
 * Value: JSON-serialised Proof[]
 */

import type { Proof } from '@cashu/cashu-ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'satstreamr_wallet_proofs';

// ---------------------------------------------------------------------------
// Internal listener registry
// ---------------------------------------------------------------------------

const balanceListeners: Set<(balance: number) => void> = new Set();

function notifyListeners(): void {
  const balance = getBalance();
  for (const cb of balanceListeners) {
    cb(balance);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Reads all stored proofs from localStorage. */
export function getProofs(): Proof[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    return JSON.parse(raw) as Proof[];
  } catch {
    return [];
  }
}

/** Replaces the stored proofs with the provided array. */
export function setProofs(proofs: Proof[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(proofs));
  notifyListeners();
}

/** Appends the provided proofs to the existing stored proofs. */
export function addProofs(proofs: Proof[]): void {
  const existing = getProofs();
  setProofs([...existing, ...proofs]);
}

/**
 * Selects and removes proofs totaling >= the requested amount.
 *
 * Strategy: sort proofs ascending by amount and greedily select until the
 * running sum meets or exceeds `amount`. Returns the selected proofs and
 * removes them from the store.
 *
 * Throws if the wallet does not hold enough proofs to cover `amount`.
 */
export function spendProofs(amount: number): Proof[] {
  const all = getProofs();

  // Sort ascending so we use smaller denominations first.
  const sorted = [...all].sort((a, b) => a.amount - b.amount);

  const selected: Proof[] = [];
  let total = 0;

  for (const proof of sorted) {
    if (total >= amount) break;
    selected.push(proof);
    total += proof.amount;
  }

  if (total < amount) {
    throw new Error(
      `Insufficient wallet balance: need ${amount} sats, have ${total} sats`
    );
  }

  // Remove selected proofs from the store.
  const selectedSecrets = new Set(selected.map((p) => p.secret));
  const remaining = all.filter((p) => !selectedSecrets.has(p.secret));
  setProofs(remaining);

  return selected;
}

/** Returns the sum of all stored proof amounts. */
export function getBalance(): number {
  return getProofs().reduce((sum, p) => sum + p.amount, 0);
}

/**
 * Subscribes to balance changes.
 *
 * The callback is invoked after any mutation (setProofs, addProofs, spendProofs)
 * with the new balance.
 *
 * @returns An unsubscribe function.
 */
export function onBalanceChange(cb: (balance: number) => void): () => void {
  balanceListeners.add(cb);
  return () => {
    balanceListeners.delete(cb);
  };
}
