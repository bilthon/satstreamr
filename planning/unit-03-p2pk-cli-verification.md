# Unit 03: NUT-11 P2PK CLI Round-Trip Verification

## Status

**COMPLETE** — 2026-03-22

### Versions
- Node.js: v22.22.0
- npm: 10.9.4
- @cashu/cashu-ts: 2.9.0
- @noble/curves (secp256k1): bundled with cashu-ts
- Nutshell mint: 0.19.2 at http://localhost:3338

### Script Output (successful run)
```
Keypair generated
  pubkey : 0271df144c83dd56fd9bbaa5b7f82e2308473346b38e5b2dbe338b5988c40bdba1
  privkey: 2d3839eccaabc810850febf07f0bcc2382edb1df66518007c4dabe463440248f
Connected to mint: http://localhost:3338
  active keyset  : 00c3784110a5ef73
  input_fee_ppk  : 100
  swap fee (1 input): 1 sat
  mint amount needed: 2 sat

Requesting mint quote for 2 sat...
  quote id : rj84iSLBSKkjJ3Sd48BOoW-5yUVZ_x6Vi8W4BKV9
  invoice  : lnbcrt20n1p5uqa3kpp5...

Paying invoice via lnd_customer...
  Invoice paid.
  Quote state: PAID

Minting 2 sat P2PK-locked to pubkey...
  Minted 1 proof(s), total 2 sat:
    amount=2  id=00c3784110a5ef73  secret=["P2PK",{"nonce":"ce852ae598daf4a1e23eb2e6c06b919e...

MINT OK — token locked to pubkey: 0271df144c83dd56fd9bbaa5b7f82e2308473346b38e5b2dbe338b5988c40bdba1

Verifying DLEQ proofs...
  DLEQ valid for proof amount=2
DLEQ OK

Redeeming P2PK-locked proof using private key...
  Redeemed 1 proof(s) totalling 1 sat
REDEEM OK

Attempting double-spend with already-spent proof...
DOUBLE-SPEND DETECTED: proofs already spent

All checks passed. Exiting 0.
```

### Deviations from Plan

1. **Import path for @noble/curves**: The plan suggested `@noble/secp256k1`. The correct import
   in cashu-ts 2.9.0's bundled dependency is `@noble/curves/secp256k1.js` (with `.js` extension
   required for ESM). `@noble/curves` is the updated package (v2.x); `@noble/secp256k1` is the
   older standalone package.

2. **Key generation API**: The plan referenced `secp256k1.utils.randomPrivateKey()`. In
   `@noble/curves` v1.x the method is `secp256k1.utils.randomSecretKey()`, but the cleanest
   approach is `secp256k1.keygen()` which returns `{ secretKey, publicKey }` directly.

3. **Fee handling**: The active keyset has `input_fee_ppk=100`, meaning 1 input costs
   ceil(100/1000) = 1 sat. The plan specified minting 1 sat but that leaves zero value after
   the swap fee. The script dynamically computes the fee and mints `PAYLOAD_AMOUNT + fee` (2 sat
   total). After the swap, 1 sat net is recovered. This is documented with a comment in the script.

4. **`includeFees` option**: Setting `SwapOptions.includeFees=true` inflates the amount further
   (to cover the fee of the *extra change outputs*) which caused a second failure. The correct
   call is `wallet.swap(PAYLOAD_AMOUNT, lockedProofs, { privkey })` with no `includeFees` flag —
   the fee is implicitly absorbed from the locked proof's surplus value.

5. **`mintProofs` API**: In cashu-ts v2.x, the method is `mintProofs(amount, quoteId, options)`
   where `options.p2pk.pubkey` carries the locking key. The old `mintTokens()` method from v0.x
   is gone.

6. **DLEQ verification**: `hasValidDleq(proof, mintKeys)` is the correct v2 API call. The mint
   did include DLEQ data (`proof.dleq` was present), and it verified correctly.

7. **Double-spend error message**: The mint returned the error string "proofs already spent"
   (HTTP 400), caught as an exception by cashu-ts and re-thrown as `Error("proofs already spent")`.

---

## Summary
Write and run a CLI test script that exercises the full Cashu P2PK (NUT-11) token lifecycle against the live Nutshell mint: mint a P2PK-locked token, redeem it with the correct key, then confirm that replaying the same token is rejected as double-spent (NUT-07). This is the most critical early risk item — all browser payment logic is worthless if the mint's P2PK behavior is not verified first.

## Prerequisites
- Unit 01 (Polar network running)
- Unit 02 (Nutshell mint running on port 3338)
- Node.js 18+ and npm available

## Deliverables
1. Script `scripts/test-p2pk.ts` (runnable via `npx tsx scripts/test-p2pk.ts`) that:
   a. Mints a 1-sat P2PK-locked Cashu token locked to a freshly generated keypair.
   b. Redeems the token using the correct private key and prints `REDEEM OK`.
   c. Attempts to redeem the same token again and prints `DOUBLE-SPEND DETECTED` when the mint rejects it.
   - Verification: Running the script prints all three status lines and exits 0.
2. Script output includes the token string, the public key used for locking, and the mint's response on the double-spend attempt.
   - Verification: Inspectable from stdout — no silent failures.
3. NUT-12 DLEQ proof is verified client-side during mint step.
   - Verification: Script logs `DLEQ OK` after minting; any DLEQ failure causes the script to exit non-zero.

## Implementation Notes
- Use `@cashu/cashu-ts` for all Cashu operations. Install it in a `scripts/` package.json or at project root.
- NUT-11 P2PK requires the mint to support it — confirm via `curl http://localhost:3338/v1/info` and check the `nuts` field includes `"11"`.
- For the keypair, use the `@noble/curves/secp256k1.js` import (bundled with cashu-ts). Use `secp256k1.keygen()` to generate a fresh keypair.
- The double-spend test must call the mint's `/v1/swap` endpoint with the already-spent proof. The mint returns HTTP 400 and cashu-ts throws an Error with the message from the mint.
- This script is the single source of truth that NUT-11 works on this mint before any browser code is written (Technical Risk #1). Block all Phase 2 work on this passing.
- Fee note: the default Nutshell keyset has input_fee_ppk=100. Always compute the swap fee and mint enough to cover it. Use `ceil(n_inputs * fee_ppk / 1000)` per NUT-02.

## Files Created
- `scripts/test-p2pk.ts` — CLI verification script
- `scripts/package.json` — adds `@cashu/cashu-ts@^2.0.0`, `tsx@^4.0.0`
- `scripts/tsconfig.json` — TypeScript config for scripts directory

## Estimated Effort
4–6 hours (actual: ~2 hours including API research and fee debugging)
