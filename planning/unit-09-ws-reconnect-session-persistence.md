# Unit 09: WebSocket Reconnect and Session Persistence

## Summary
Harden the signaling client with exponential backoff reconnection and persist payment-critical state in `sessionStorage` so that a momentary WebSocket drop does not lose the session or payment context. The signaling server must not be a single point of failure for an in-progress paid session.

## Prerequisites
- Unit 04 (signaling server with 30-second session grace period)
- Unit 05 (frontend scaffold with basic signaling client)
- Unit 07 (data channel in place — payment state lives in browser, not server)

## Deliverables
1. `frontend/src/signaling-client.ts` upgraded with reconnect logic:
   - Exponential backoff: initial delay 500ms, max delay 16s, jitter ±20%.
   - On reconnect, re-sends `{ type: "rejoin_session", sessionId, peerId }` to reclaim session slot.
   - Emits a `reconnected` event that the page can listen to for UI updates.
   - Verification: Manually kill and restart the signaling server while a session is active; within 20 seconds the UI shows "reconnected" and the data channel remains open.
2. Payment-critical state persisted in `sessionStorage` under key `streaming_session`:
   - `sessionId`, `peerId`, `role` (`"tutor"` | `"viewer"`), `chunkCount`, `totalSatsPaid`, `budgetRemaining`.
   - Written after every payment event; read on page load to restore UI state.
   - Verification: Reload the viewer page mid-session; UI restores `chunkCount` and `budgetRemaining` from `sessionStorage`.
3. Signaling server updated to accept `rejoin_session` message type and reconnect the peer to its existing session within the grace period.
   - Verification: Integration test in `signaling/test/protocol.test.ts` asserts that a client that disconnects and reconnects within 25 seconds receives any buffered messages.
4. UI shows a "reconnecting…" overlay with an animated spinner when the WebSocket is not connected.
   - Verification: Visible in both tutor and viewer pages when signaling server is stopped.

## Implementation Notes
- Payment state must live in `sessionStorage` (not `localStorage`) so it is tab-scoped and clears when the tab is closed (Technical Risk #2).
- The `peerId` assigned by the server must be stored in `sessionStorage` on first connect and re-sent on reconnect so the server can identify which slot to restore.
- Buffered ICE candidates from before reconnect may be stale; do not replay them after reconnect. Only relay new ICE candidates.
- The data channel may need to be re-established after ICE reconnect; the scheduler (Unit 11) must handle the case where the data channel transitions from `"open"` to `"closed"` and back.
- Do not attempt to reconnect if the session has been explicitly ended (`end_session` message received).

## Files to Create/Modify
- `frontend/src/signaling-client.ts` — add reconnect logic and `rejoin_session` support
- `frontend/src/lib/session-storage.ts` — typed `sessionStorage` read/write helpers
- `frontend/src/types/session.ts` — `SessionState` type
- `frontend/src/pages/tutor.ts` — wire up reconnect event and session restore
- `frontend/src/pages/viewer.ts` — wire up reconnect event and session restore
- `signaling/src/server.ts` — add `rejoin_session` message handler
- `signaling/test/protocol.test.ts` — add reconnect integration test

## Estimated Effort
5–7 hours
