/**
 * cashu.ts
 *
 * Project-specific type aliases and extensions for Cashu types.
 * Re-exports the types used throughout the satstreamr frontend so
 * consumers import from this file rather than directly from cashu-ts.
 */

export type {
  Proof,
  MintKeys,
  MintKeyset,
  Token,
  ProofState,
} from '@cashu/cashu-ts';

export { CheckStateEnum } from '@cashu/cashu-ts';
