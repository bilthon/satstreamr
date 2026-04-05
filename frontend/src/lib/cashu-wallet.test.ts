/**
 * cashu-wallet.test.ts
 *
 * Unit tests for the Cashu wallet module.
 *
 * swapP2PKToken is tested with mocks for:
 *   - spendProofs/addProofs from wallet-store
 *   - CashuWallet instance methods (getFeesForProofs, send) via @cashu/cashu-ts mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Proof } from '../types/cashu.js';

// ---------------------------------------------------------------------------
// Mock wallet-store so spendProofs/addProofs never touch localStorage
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

const mockSend = vi.fn();
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
    send: mockSend,
    swap: vi.fn(),
    checkProofsStates: vi.fn(),
  })),
  hasValidDleq: vi.fn(() => true),
  getEncodedToken: vi.fn(() => 'cashuA_mock'),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { spendProofs, addProofs } from './wallet-store.js';
import { swapP2PKToken } from './cashu-wallet.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProof(amount: number, secret = 'mock-secret'): Proof {
  return { id: 'mock-id', amount, secret, C: 'mock-C' } as unknown as Proof;
}

const RECIPIENT_PUBKEY = '02' + 'ab'.repeat(32);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('swapP2PKToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no fee, fresh keyset list
    mockGetFeesForProofs.mockReturnValue(0);
    mockLoadMint.mockResolvedValue(undefined);
    mockGetKeys.mockResolvedValue({});
  });

  it('returns send proofs and adds change proofs to wallet on success', async () => {
    const inputProofs = [makeProof(2)];
    const sendProofs = [makeProof(1, 'send-secret')];
    const keepProofs = [makeProof(1, 'keep-secret')];

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSend.mockResolvedValue({ send: sendProofs, keep: keepProofs });

    const result = await swapP2PKToken(1, RECIPIENT_PUBKEY);

    expect(result).toEqual(sendProofs);
    expect(spendProofs).toHaveBeenCalledWith(1);
    expect(addProofs).toHaveBeenCalledWith(keepProofs);
  });

  it('re-selects proofs when fee makes initial selection insufficient', async () => {
    const smallProofs = [makeProof(1)];
    const largerProofs = [makeProof(2)];
    const sendProofs = [makeProof(1, 'send-secret')];

    // Fee of 1 means we need 2 total but only selected 1.
    mockGetFeesForProofs.mockReturnValue(1);
    vi.mocked(spendProofs)
      .mockReturnValueOnce(smallProofs)   // first selection (too small)
      .mockReturnValueOnce(largerProofs); // re-selection with fee included

    mockSend.mockResolvedValue({ send: sendProofs, keep: [] });

    const result = await swapP2PKToken(1, RECIPIENT_PUBKEY);

    expect(result).toEqual(sendProofs);
    // Returns under-sized proofs and re-selects with totalNeeded = 1 + 1 = 2
    expect(addProofs).toHaveBeenCalledWith(smallProofs);
    expect(spendProofs).toHaveBeenNthCalledWith(2, 2);
  });

  it('does not call addProofs for keep when keep is empty', async () => {
    const inputProofs = [makeProof(1)];
    const sendProofs = [makeProof(1, 'send-secret')];

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSend.mockResolvedValue({ send: sendProofs, keep: [] });

    await swapP2PKToken(1, RECIPIENT_PUBKEY);

    // addProofs should NOT have been called (no change to return)
    expect(addProofs).not.toHaveBeenCalled();
  });

  it('rolls back input proofs to wallet on send failure', async () => {
    const inputProofs = [makeProof(2)];

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSend.mockRejectedValue(new Error('mint unreachable'));

    await expect(swapP2PKToken(1, RECIPIENT_PUBKEY)).rejects.toThrow('mint unreachable');

    // Rollback: input proofs must be returned to the wallet.
    expect(addProofs).toHaveBeenCalledWith(inputProofs);
  });

  it('passes p2pk pubkey and includeFees to wallet.send()', async () => {
    const inputProofs = [makeProof(5)];
    const sendProofs = [makeProof(2, 'locked')];

    vi.mocked(spendProofs).mockReturnValue(inputProofs);
    mockSend.mockResolvedValue({ send: sendProofs, keep: [makeProof(3, 'change')] });

    await swapP2PKToken(2, RECIPIENT_PUBKEY);

    expect(mockSend).toHaveBeenCalledWith(
      2,
      inputProofs,
      expect.objectContaining({
        p2pk: { pubkey: RECIPIENT_PUBKEY },
        includeFees: true,
      }),
    );
  });
});
