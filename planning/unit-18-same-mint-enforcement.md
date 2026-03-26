# Unit 18: Same-Mint Enforcement

## Summary
Ensure that both tutor and viewer are using the same Cashu mint before any payment tokens are exchanged. The mint URL is hardcoded in the build via `VITE_MINT_URL`; on session join the viewer's mint URL is checked against the session metadata and the session is blocked if there is a mismatch.

## Prerequisites
- Unit 04 (signaling server — session metadata is carried in `session_created` / `join_session` messages)
- Unit 10 (token transfer — the check must gate before the first token is sent)

## Deliverables
1. Tutor page includes `mintUrl: import.meta.env.VITE_MINT_URL` in the `create_session` signaling message.
   - Verification: Signaling server logs show `mintUrl` in the `create_session` payload.
2. Viewer page reads `mintUrl` from the `session_created` response (via signaling) and compares it to `import.meta.env.VITE_MINT_URL`.
   - If they match: session proceeds normally.
   - If they differ: show a blocking error overlay "Mint mismatch. This session requires mint: <url>. Your configured mint: <url>." and do not open the data channel.
   - Verification: Set viewer's `VITE_MINT_URL` to a different value and attempt to join a session; the error overlay appears and no WebRTC data channel is opened.
3. The mint URL comparison is case-insensitive and trailing-slash-normalized.
   - Verification: `http://localhost:3338/` and `http://localhost:3338` are treated as equal.
4. `frontend/src/lib/mint-guard.ts` exports `assertSameMint(sessionMintUrl: string): void` — throws a `MintMismatchError` if the URLs differ.
   - Verification: Unit test asserts `MintMismatchError` is thrown for mismatched URLs and not thrown for matching URLs.

## Implementation Notes
- For MVP there is no mint chooser UI — `VITE_MINT_URL` is set at build time and baked into the bundle (Technical Risk #5). The enforcement check is a sanity guard, not a user-facing selection flow.
- Normalize URLs before comparison: `new URL(url).href` produces a canonical form. Compare canonical forms.
- Do not log the full mint URL to the signaling server's stdout in production (it reveals infrastructure). For this developer preview it is acceptable.
- This check must run before `PaymentScheduler.start()` is called. Gate the scheduler start on `assertSameMint()` passing.

## Files to Create/Modify
- `frontend/src/lib/mint-guard.ts` — `assertSameMint()` function and `MintMismatchError` class
- `frontend/src/lib/mint-guard.test.ts` — unit tests
- `frontend/src/pages/viewer.ts` — call `assertSameMint()` after receiving `session_created` payload
- `frontend/src/types/signaling.ts` — add `mintUrl` field to `create_session` and `session_created` types
- `frontend/viewer.html` — mint mismatch error overlay markup

## Estimated Effort
2–3 hours
