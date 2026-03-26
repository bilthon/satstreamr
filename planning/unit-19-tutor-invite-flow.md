# Unit 19: Tutor Invite Flow

## Summary
Add an "Invite Student" button to the tutor page that generates a formatted invite message containing the session URL, cost estimate (sats/minute), and a link to a wallet setup guide. This replaces manual URL copy-paste and gives the viewer enough context to prepare before joining.

## Prerequisites
- Unit 06 (tutor page creates a session and has a session ID)
- Unit 12 (session UI — invite lives on the pre-session screen)

## Deliverables
1. Tutor pre-session screen shows an "Invite Student" button that becomes active after the session is created (session ID assigned).
   - Verification: Button is disabled before `session_created` is received and enabled after.
2. Clicking the button generates an invite message and copies it to the clipboard. The message contains:
   - The full viewer URL: `http://localhost:5173/viewer.html?session=<sessionId>`.
   - Cost estimate: "Rate: <N> sat/min" based on `chunkSats` and `intervalSecs` from the session config.
   - A static wallet setup link (configurable via `VITE_WALLET_SETUP_URL` env var, defaults to `#`).
   - Verification: Clipboard content after clicking matches the expected format.
3. After copying, the button label changes to "Copied!" for 2 seconds then reverts.
   - Verification: Label changes visible in the UI after clicking.
4. The invite message is also displayed in a read-only `<textarea>` below the button for manual copy if clipboard API is blocked.
   - Verification: `<textarea>` contains the same text that was copied to clipboard.
5. `VITE_WALLET_SETUP_URL` is documented in `frontend/.env.example`.
   - Verification: Key present in the example file.

## Implementation Notes
- Use `navigator.clipboard.writeText()` for clipboard access; wrap in a try/catch and fall back to selecting the `<textarea>` content if the API is blocked (e.g., non-HTTPS context in some browsers).
- The cost estimate calculation: `(chunkSats / intervalSecs) * 60` sats/min. Round to the nearest integer.
- The `chunkSats` and `intervalSecs` values are currently constants — expose them as `VITE_CHUNK_SATS` and `VITE_INTERVAL_SECS` environment variables so they are configurable without a code change.
- Do not include any Cashu proof data, session keys, or server addresses other than the viewer URL in the invite message.

## Files to Create/Modify
- `frontend/src/pages/tutor.ts` — invite generation and clipboard logic
- `frontend/tutor.html` — invite button and textarea elements
- `frontend/.env.example` — add `VITE_WALLET_SETUP_URL`, `VITE_CHUNK_SATS`, `VITE_INTERVAL_SECS`

## Estimated Effort
2–3 hours
