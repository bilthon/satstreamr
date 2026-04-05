/**
 * cashu-wallet.test.ts
 *
 * Unit tests for the Cashu wallet module.
 *
 * preSplitProofs is tested with mocks for:
 *   - spendProofs/addProofs/getProofs from wallet-store
 *   - CashuWallet instance methods (getFeesForProofs, swap) via @cashu/cashu-ts mock
 *
 * claimProofs is tested with mocks for:
 *   - CashuWallet.swap (plain swap, no privkey)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Proof } from '../types/cashu.js';

// ---------------------------------------------------------------------------
// Mock wallet-store so spendProofs/addProofs/getProofs never touch localStorage
// ---------------------------------------------------------------------------

vi.mock('./wallet-store.js', () => ({
  spendProofs: vi.fn(),
  addProofs: vi.fn(),
  getBalance: vi.fn(() => 100),
  getProofs: vi.fn(() => []),
  setProofs: vi.fn(),
  onBalanceChange: vi.fn(() => () => undefined),
}));

// ---------------------------------------------------------------------------
// Mock @cashu/cashu-ts so CashuWallet never hits the network
// ---------------------------------------------------------------------------

const mockSwap = vi.fn();
const mockGetFeesForProofs = vi.fn(() => 0);
const mockLoadMint = vi.fn(async () => undefined);
const mockGetKeys = vi.fn(async () => ({}));

// A minimal mock keyset so wallet.keysets.find() returns a valid object.
const MOCK_KEYSET = { active: true, unit: 'sat', id: 'mock-keyset-id', input_fee_ppk: 0 };

vi.mock('@cashu/cashu-ts', () => ({
  CashuMint: vi.fn(),
  CashuWallet: vi.fn().mockImplementation(() => ({
    loadMint: mockLoadMint,
    keysets: [MOCK_KEYSET],
    getKeys: mockGetKeys,
    getFeesForProofs: mockGetFeesForProofs,
    swap: mockSwap,
    send: vi.fn(),
    checkProofsStates: vi.fn(),
  })),
  hasValidDleq: vi.fn(() => true),
  getEncodedToken: vi.fn(() => 'cashuA_mock'),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { spendProofs, addProofs, getProofs } from './wallet-store.js';
import { preSplitProofs, claimProofs } from './cashu-wallet.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProof(amount: number, secret = 'mock-secret'): Proof {
  return { id: 'mock-id', amount, secret, C: 'mock-C' } as unknown as Proof;
}

// ---------------------------------------------------------------------------
// preSplitProofs tests
// ---------------------------------------------------------------------------

describe('preSplitProofs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFeesForProofs.mockReturnValue(0);
    mockLoadMint.mockResolvedValue(undefined);
    mockGetKeys.mockResolvedValue({});
    vi.mocked(getProofs).mockReturnValue([]);
  });

  it('returns the correct number of chunks and stores pre-split proofs', async () => {
    const chunkSats = 2;
    const totalBudget = 10;
    const numChunks = Math.floor(totalBudget / chunkSats); // 5

    const inputProofs = [makeProof(10)];
    const sendProofs = Array.from({ length: numChunks }, (_, i) =>
      makeProof(chunkSats, `send-secret-${i}`)
    );

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSwap.mockResolvedValue({ send: sendProofs, keep: [] });

    const result = await preSplitProofs(chunkSats, totalBudget);

    expect(result).toBe(numChunks);
    expect(spendProofs).toHaveBeenCalledWith(numChunks * chunkSats);
    // sendAmounts should be an array of numChunks entries each equal to chunkSats
    expect(mockSwap).toHaveBeenCalledWith(
      numChunks * chunkSats,
      inputProofs,
      expect.objectContaining({
        outputAmounts: {
          sendAmounts: Array(numChunks).fill(chunkSats),
        },
      })
    );
    expect(addProofs).toHaveBeenCalledWith(sendProofs);
  });

  it('adds change (keep) proofs back to the wallet', async () => {
    const chunkSats = 3;
    const totalBudget = 10; // floor(10/3) = 3 chunks, 9 sats, 1 sat change

    const inputProofs = [makeProof(10)];
    const sendProofs = [makeProof(3, 's1'), makeProof(3, 's2'), makeProof(3, 's3')];
    const keepProofs = [makeProof(1, 'change')];

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSwap.mockResolvedValue({ send: sendProofs, keep: keepProofs });

    await preSplitProofs(chunkSats, totalBudget);

    expect(addProofs).toHaveBeenCalledWith(sendProofs);
    expect(addProofs).toHaveBeenCalledWith(keepProofs);
  });

  it('throws when totalBudget is less than one chunkSats', async () => {
    await expect(preSplitProofs(10, 5)).rejects.toThrow(
      /Insufficient balance after fees/
    );
  });

  it('skips the swap when exact-denomination proofs already exist in sufficient quantity', async () => {
    const chunkSats = 2;
    const totalBudget = 6; // 3 chunks needed
    const existingProofs = [makeProof(2, 'a'), makeProof(2, 'b'), makeProof(2, 'c')];

    vi.mocked(getProofs).mockReturnValue(existingProofs);

    const result = await preSplitProofs(chunkSats, totalBudget);

    expect(result).toBe(3);
    expect(mockSwap).not.toHaveBeenCalled();
    expect(spendProofs).not.toHaveBeenCalled();
  });

  it('rolls back input proofs to wallet on swap failure', async () => {
    const inputProofs = [makeProof(10)];

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSwap.mockRejectedValue(new Error('mint unreachable'));

    await expect(preSplitProofs(2, 10)).rejects.toThrow('mint unreachable');

    // Rollback: input proofs must be returned to the wallet.
    expect(addProofs).toHaveBeenCalledWith(inputProofs);
  });

  it('reduces chunk count to account for swap fee', async () => {
    const chunkSats = 2;
    const totalBudget = 10; // fee=1 => spendable=9 => numChunks=floor(9/2)=4
    const inputProofs = [makeProof(10)];
    // 4 chunks of 2 sats each
    const sendProofs = Array.from({ length: 4 }, (_, i) => makeProof(2, `s${i}`));

    mockGetFeesForProofs.mockReturnValue(1); // fee of 1 sat
    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSwap.mockResolvedValue({ send: sendProofs, keep: [] });

    const result = await preSplitProofs(chunkSats, totalBudget);

    // numChunks = floor((10 - 1) / 2) = 4
    expect(result).toBe(4);
    // spendProofs called exactly once with totalAmount + fee = 4*2 + 1 = 9
    expect(spendProofs).toHaveBeenCalledTimes(1);
    expect(spendProofs).toHaveBeenCalledWith(9);
    // swap called once with the reduced totalAmount
    expect(mockSwap).toHaveBeenCalledTimes(1);
    expect(mockSwap).toHaveBeenCalledWith(
      8, // 4 chunks * 2 sats
      inputProofs,
      expect.objectContaining({
        outputAmounts: {
          sendAmounts: Array(4).fill(2),
        },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// claimProofs tests
// ---------------------------------------------------------------------------

describe('claimProofs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFeesForProofs.mockReturnValue(0);
    mockLoadMint.mockResolvedValue(undefined);
    mockGetKeys.mockResolvedValue({});
  });

  it('swaps proofs and returns success with new proofs', async () => {
    const inProofs = [makeProof(5, 'in1')];
    const keepProofs = [makeProof(4, 'keep1')];
    const sendProofs = [makeProof(1, 'send1')];

    mockGetFeesForProofs.mockReturnValue(0);
    mockSwap.mockResolvedValue({ keep: keepProofs, send: sendProofs });

    const result = await claimProofs(inProofs);

    expect(result.success).toBe(true);
    expect(result.newProofs).toEqual([...keepProofs, ...sendProofs]);
    // Should call swap with amount = totalAmount - fee = 5 - 0 = 5
    expect(mockSwap).toHaveBeenCalledWith(5, inProofs);
  });

  it('deducts fee from receiveAmount', async () => {
    const inProofs = [makeProof(5, 'in1')];
    const keepProofs = [makeProof(4, 'k1')];

    mockGetFeesForProofs.mockReturnValue(1); // 1 sat fee
    mockSwap.mockResolvedValue({ keep: keepProofs, send: [] });

    const result = await claimProofs(inProofs);

    // swap called with receiveAmount = 5 - 1 = 4
    expect(mockSwap).toHaveBeenCalledWith(4, inProofs);
    expect(result.success).toBe(true);
  });

  it('throws when fee exceeds proof total', async () => {
    const inProofs = [makeProof(1, 'tiny')];

    mockGetFeesForProofs.mockReturnValue(2); // fee exceeds total

    await expect(claimProofs(inProofs)).rejects.toThrow(
      'Proof total (1) cannot cover swap fee (2)'
    );
    expect(mockSwap).not.toHaveBeenCalled();
  });

  it('does not pass privkey to the swap call (plain swap, no P2PK)', async () => {
    const inProofs = [makeProof(3, 'plain')];
    mockSwap.mockResolvedValue({ keep: [makeProof(3, 'new')], send: [] });

    await claimProofs(inProofs);

    // swap should be called with exactly 2 arguments — no options object
    expect(mockSwap).toHaveBeenCalledWith(3, inProofs);
    // Verify no privkey option was passed
    const callArgs = mockSwap.mock.calls[0] as unknown[];
    expect(callArgs).toHaveLength(2);
  });
});
