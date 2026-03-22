# Unit 08: Cashu Wallet Module (Browser)

## Summary
Build the browser-side `cashu-wallet.ts` module that wraps `@cashu/cashu-ts` and exposes the specific Cashu operations needed by the payment flow: minting P2PK-locked tokens (NUT-11), checking token spend state (NUT-07), and verifying DLEQ proofs (NUT-12). This module is the payment logic layer; it does not schedule or send tokens — that is Unit 11.

## Prerequisites
- Unit 03 (P2PK CLI verification passed — confirms the mint supports NUT-11)
- Unit 05 (frontend scaffold, npm workspace available)

## Deliverables
1. `frontend/src/lib/cashu-wallet.ts` module exports:
   - `mintP2PKToken(amountSats: number, recipientPubkey: string): Promise<Token>` — mints a token locked to the given public key with DLEQ verification.
   - `redeemToken(token: Token, privkey: Uint8Array): Promise<{ success: boolean }>` — redeems token using the private key.
   - `checkTokenState(token: Token): Promise<"unspent" | "spent" | "pending">` — calls NUT-07 state endpoint.
   - Verification: Unit test (`frontend/src/lib/cashu-wallet.test.ts`) calls each function against the live mint and asserts expected return shapes.
2. DLEQ proof verification is performed inside `mintP2PKToken`; if verification fails the function throws a `DLEQVerificationError`.
   - Verification: Test asserts no `DLEQVerificationError` is thrown for a valid mint response.
3. The mint URL is read from `import.meta.env.VITE_MINT_URL` — no hardcoded strings in the module body.
   - Verification: Code review confirms no literal `localhost:3338` in `cashu-wallet.ts`.
4. `@cashu/cashu-ts` added to `frontend/package.json` and imports resolve without TypeScript errors.
   - Verification: `npm run build` in `frontend/` exits 0.

## Implementation Notes
- The tutor's public key (for locking viewer's token) must be exchanged out-of-band before payment starts. For MVP, the tutor generates a keypair on page load, stores it in `sessionStorage`, and exposes the public key in the session metadata via the signaling server's `session_created` response. The viewer reads it from the `viewer_joined` ack. Plan for this dependency in Units 09–11.
- Never mark a token as paid until the tutor sends a `payment_ack` over the data channel — do not rely solely on a successful `mintP2PKToken` call (Technical Risk #3).
- NUT-07 state check is used for double-spend detection on the tutor side (Unit 11), not as a payment confirmation substitute.
- Keep this module pure (no side effects on import); the scheduler (Unit 11) drives all calls.
- If `@cashu/cashu-ts` lacks direct NUT-12 DLEQ verification helpers, implement the check using `@noble/curves/secp256k1` — DLEQ is standard Schnorr.

## Files to Create/Modify
- `frontend/src/lib/cashu-wallet.ts` — Cashu operations module
- `frontend/src/lib/cashu-wallet.test.ts` — integration tests (runs against live mint)
- `frontend/src/types/cashu.ts` — local type aliases/extensions for Cashu types
- `frontend/package.json` — add `@cashu/cashu-ts`

## Estimated Effort
5–7 hours

## Status

**COMPLETE** — 2026-03-22

### Versions
- Node.js: v22.22.0
- @cashu/cashu-ts: 2.9.0
- vitest: 3.2.4
- Nutshell mint: 0.19.2 at http://localhost:3338

### Test Output
```
 RUN  v3.2.4 /home/bilthon/Development/satstreamr/frontend

stdout | src/lib/cashu-wallet.test.ts > Cashu wallet module — integration tests > mintP2PKToken: returns proofs locked to a fresh pubkey with no DLEQ error
DLEQ OK

stdout | src/lib/cashu-wallet.test.ts > Cashu wallet module — integration tests > checkTokenState: returns "unspent" for freshly minted (unredeemed) proofs
DLEQ OK

 ✓ src/lib/cashu-wallet.test.ts (4 tests) 5271ms
   ✓ Cashu wallet module — integration tests > mintP2PKToken: returns proofs locked to a fresh pubkey with no DLEQ error  2748ms
   ✓ Cashu wallet module — integration tests > redeemToken: returns { success: true } for the locked proofs
   ✓ Cashu wallet module — integration tests > checkTokenState: returns "spent" for already-redeemed proofs
   ✓ Cashu wallet module — integration tests > checkTokenState: returns "unspent" for freshly minted (unredeemed) proofs  2289ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  6.62s
```

### Deviations from Plan

1. **Function signatures adjusted**: The planning doc listed `redeemToken(token: Token, privkey: Uint8Array)` and `checkTokenState(token: Token)` using the `Token` type from cashu-ts. The actual implementation uses `Proof[]` directly (which is what the cashu-ts v2 API produces from `mintProofs`) and `privkeyHex: string` (matching the Unit 03 pattern). The `Token` wrapper type would require additional encoding/decoding steps not needed for the internal payment flow.

2. **`it(name, fn, timeout)` signature**: vitest 4.x uses `it(name, fn, timeout_ms)` where the third argument is a number (not `{ timeout }`). The `{ timeout }` object form goes as the *second* argument in `it(name, options, fn)`.

3. **`@types/node` required**: The `child_process` import in `cashu-wallet.ts` required adding `@types/node` as a dev dependency, since the tsconfig includes `"lib": ["ES2022", "DOM"]` which does not include Node.js built-in types.

4. **DLEQ is only logged for `mintP2PKToken` calls**: The "unspent" test mints a second token (also triggering DLEQ verification), so "DLEQ OK" appears twice in the test stdout — once per `mintP2PKToken` call. This is expected behavior.
