# Unit 04: Signaling Server Core (WebSocket)

> **Status: COMPLETE** — Implemented 2026-03-22 by backend-dev-bot.
> WebSocket signaling server running on port 8080 using the `ws` npm package with TypeScript.
> All 10 integration tests pass. Commit `08a8376` pushed to
> https://github.com/bilthon/satstreamr-signaling.

## Summary
Build the Node.js WebSocket signaling server that brokers session setup between a tutor and one viewer. The server handles session creation, joining, and relaying of WebRTC offer/answer/ICE messages. It must stay alive across client reconnects because payment state lives in the browser — the server must not evict a session on a momentary WebSocket drop.

## Prerequisites
- Node.js 18+ and npm
- No prior units required (pure server-side work, no Cashu or Polar dependency)

## Deliverables
1. Server at `signaling/src/server.ts` starts on port 8080 and accepts WebSocket connections.
   - Verification: `wscat -c ws://localhost:8080` connects without error.
2. Server handles these message types (JSON protocol):
   - `create_session` → responds with `{ type: "session_created", sessionId }` (UUID v4).
   - `join_session` → notifies tutor with `{ type: "viewer_joined", viewerId }`.
   - `offer`, `answer`, `ice_candidate` → relayed to the other peer in the session.
   - `end_session` → sends `{ type: "session_ended" }` to both peers and clears server state.
   - `ping` → responds with `pong`.
   - Verification: A Node.js integration test (`signaling/test/protocol.test.ts`) sends each message type and asserts the correct response using `ws` npm package.
3. Session state persists for 30 seconds after a client WebSocket closes, allowing reconnect without data loss.
   - Verification: Test closes WS, waits 5 seconds, reconnects with same `sessionId` and receives buffered messages.
4. Server logs (to stdout, JSON lines) every message type received and sent, including `sessionId` and `peerId`.
   - Verification: Log lines appear in terminal when running integration test.

## Implementation Notes
- Use the `ws` npm package (not Socket.IO) to keep the dependency surface small.
- Each WebSocket connection gets a random `peerId` assigned by the server on connect; the client does not choose it.
- Session capacity: exactly 2 peers (tutor + viewer). Reject a third `join_session` with `{ type: "error", code: "SESSION_FULL" }`.
- WebSocket reconnect with backoff is the client's responsibility (Unit 09). The server just needs to hold session state during the grace period (Technical Risk #2).
- Keep all state in a `Map<sessionId, SessionRecord>` in memory. No database needed for MVP.
- Build with `tsc` and run with `node dist/server.js`. Provide an npm script `start` in `signaling/package.json`.

## Files to Create/Modify
- `signaling/src/server.ts` — WebSocket signaling server
- `signaling/src/types.ts` — shared message type definitions
- `signaling/package.json` — dependencies: `ws`, `uuid`; devDependencies: `typescript`, `@types/ws`, `@types/node`
- `signaling/tsconfig.json` — TypeScript config
- `signaling/test/protocol.test.ts` — integration tests
- `signaling/start.sh` — convenience startup script

## Estimated Effort
4–6 hours
