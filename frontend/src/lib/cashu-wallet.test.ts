/**
 * cashu-wallet.test.ts
 *
 * Integration tests for the Cashu wallet module.
 * Runs against the live Nutshell mint at http://localhost:3338.
 *
 * Prerequisites:
 *   - Nutshell mint running at VITE_MINT_URL (set in vitest config)
 *   - lnd_customer docker container reachable (for invoice payment)
 */

import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  mintP2PKToken,
  redeemToken,
  checkTokenState,
  DLEQVerificationError,
} from './cashu-wallet.js';
import type { Proof } from '../types/cashu.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cashu wallet module — integration tests', () => {
  // Shared state across sequential tests.
  let spentProofs: Proof[] = [];
  let privkeyHex = '';

  it(
    'mintP2PKToken: returns proofs locked to a fresh pubkey with no DLEQ error',
    async () => {
      const { secretKey, publicKey } = secp256k1.keygen();
      privkeyHex = bytesToHex(secretKey);
      const pubkeyHex = bytesToHex(publicKey);

      let error: unknown;
      let proofs: Proof[] = [];

      try {
        proofs = await mintP2PKToken(2, pubkeyHex);
      } catch (e) {
        error = e;
      }

      expect(error).toBeUndefined();
      expect(error).not.toBeInstanceOf(DLEQVerificationError);
      expect(proofs.length).toBeGreaterThan(0);
      expect(proofs.reduce((s, p) => s + p.amount, 0)).toBeGreaterThanOrEqual(2);

      spentProofs = proofs;
    },
    60_000
  );

  it(
    'redeemToken: returns { success: true } for the locked proofs',
    async () => {
      expect(spentProofs.length).toBeGreaterThan(0);
      expect(privkeyHex).toHaveLength(64);

      const result = await redeemToken(spentProofs, privkeyHex);
      expect(result).toEqual({ success: true });
    },
    60_000
  );

  it(
    'checkTokenState: returns "spent" for already-redeemed proofs',
    async () => {
      expect(spentProofs.length).toBeGreaterThan(0);

      const state = await checkTokenState(spentProofs);
      expect(state).toBe('spent');
    },
    30_000
  );

  it(
    'checkTokenState: returns "unspent" for freshly minted (unredeemed) proofs',
    async () => {
      const { publicKey } = secp256k1.keygen();
      const freshPubkeyHex = bytesToHex(publicKey);

      const freshProofs = await mintP2PKToken(2, freshPubkeyHex);
      expect(freshProofs.length).toBeGreaterThan(0);

      const state = await checkTokenState(freshProofs);
      expect(state).toBe('unspent');
    },
    60_000
  );
});
