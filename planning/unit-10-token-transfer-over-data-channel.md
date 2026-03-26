# Unit 10: Token Transfer Over Data Channel

## Summary
Wire together the Cashu wallet module and the data channel so the viewer can mint a P2PK-locked token and send it to the tutor, who verifies it and sends back an acknowledgment. This is the first end-to-end payment event — one token, manually triggered, fully verified including double-spend detection.

## Prerequisites
- Unit 07 (data channel open between tutor and viewer)
- Unit 08 (cashu-wallet.ts module tested against live mint)

## Deliverables
1. Viewer page has a "Send 1 sat test payment" button (visible only in dev mode). Clicking it:
   a. Mints a 1-sat P2PK-locked token locked to the tutor's public key (from session metadata).
   b. Sends a `token_payment` data channel message: `{ type: "token_payment", chunkId: 1, token: <serialized> }`.
   - Verification: Tutor tab console logs the received `token_payment` message.
2. Tutor page receives `token_payment` and:
   a. Calls `redeemToken()` from the cashu wallet module.
   b. On success sends `{ type: "payment_ack", chunkId: 1 }` back over the data channel.
   c. On failure sends `{ type: "payment_nack", chunkId: 1, reason: string }`.
   - Verification: Viewer tab console logs `payment_ack` with correct `chunkId`.
3. Re-sending the same token (clicking the dev button twice without refreshing) causes the tutor to receive a `payment_nack` with reason `"double_spend"`.
   - Verification: Viewer console shows `payment_nack` with `reason: "double_spend"`.
4. The tutor's keypair (for receiving P2PK-locked tokens) is generated on tutor page load, stored in `sessionStorage`, and the public key is included in the `session_created` signaling message.
   - Verification: Viewer can read `tutorPubkey` from the signaling `session_created` payload.
5. Chunk ID is monotonically increasing and validated on the tutor side — out-of-order or duplicate chunk IDs are rejected with `payment_nack`.
   - Verification: Sending `chunkId: 1` twice results in a nack on the second attempt.

## Implementation Notes
- Strict one-token-at-a-time: the viewer must not send the next token until `payment_ack` for the current chunk is received (Technical Risk #3). This unit only has a manual button — the scheduler in Unit 11 will enforce this programmatically.
- The tutor calls NUT-07 `checkTokenState` before redeeming to detect already-spent proofs rather than relying solely on the mint's redeem response — belt and suspenders.
- The tutor's private key must never leave the browser. Store only in `sessionStorage` (tab-scoped); log a warning if it is about to be serialized to a message.
- Serialize tokens with `cashu-ts`'s `getEncodedToken()` for the data channel message; deserialize with `getDecodedToken()` on the tutor side.
- This unit does not implement the retry or timeout logic — that is Unit 11. A missing ack simply leaves the viewer waiting (acceptable for this manual test).

## Files to Create/Modify
- `frontend/src/pages/tutor.ts` — add token receipt, verification, and ack/nack logic
- `frontend/src/pages/viewer.ts` — add dev payment button and token send logic
- `frontend/src/lib/cashu-wallet.ts` — add `redeemToken` integration if not yet complete from Unit 08
- `frontend/src/types/signaling.ts` — add `tutorPubkey` field to `session_created` message type
- `signaling/src/server.ts` — pass `tutorPubkey` through `session_created` response

## Estimated Effort
5–7 hours

## Status

🔄 In progress — 2026-03-22

### PRs
- Frontend: https://github.com/bilthon/satstreamr/pull/6
- Signaling: https://github.com/bilthon/satstreamr-signaling/pull/2

### Implementation notes
- Tutor keypair: secp256k1.keygen() from @noble/curves/secp256k1.js (direct dep added)
- Token encoding: getEncodedToken() / getDecodedToken() from @cashu/cashu-ts
- TokenPaymentMessage.proofs changed to encodedToken: string (breaking type change)
- chunkId validation: lastSeenChunkId starts at -1, strictly increasing
- NUT-07 check before redeemToken() for belt-and-suspenders double-spend detection
- child_process externalized in vite rollup config (browser build compat)
- tsconfig.json paths added for @noble/curves/secp256k1.js and utils.js
- Frontend PR includes Unit 09 (WebSocket reconnect) changes — merge conflict expected with Unit 09 PR
