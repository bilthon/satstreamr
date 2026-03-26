# Unit 13: Coturn TURN Server and ICE Restart

## Summary
Deploy Coturn as a TURN relay server and configure the signaling server to issue short-lived HMAC-based TURN credentials. Add ICE restart logic so that a degraded peer connection (e.g., network path change) automatically recovers without ending the session or losing payment state.

## Prerequisites
- Unit 04 (signaling server — must be extended to generate TURN credentials)
- Unit 06 (WebRTC peer connection)
- Unit 09 (session persistence — needed so reconnect does not reset payment state)

## Deliverables
1. Coturn running on port 3478 (UDP/TCP) with a shared secret configured.
   - Verification: `turnutils_uclient -T -u testuser -w testpass 127.0.0.1` exits 0 (or equivalent `nc`-based port check).
2. Signaling server generates HMAC-SHA1 TURN credentials (RFC 5766 style) valid for 3600 seconds, returned in the `session_created` and `viewer_joined` messages.
   - Verification: Signaling `session_created` response includes `{ iceServers: [{ urls: "turn:...", username, credential }] }`.
3. `frontend/src/lib/peer-connection.ts` updated to use the provided `iceServers` array instead of the hardcoded STUN-only config from Unit 06.
   - Verification: ICE candidates in browser console include `relay` type entries when TURN is active.
4. ICE restart triggered automatically when `RTCPeerConnection.connectionState === "disconnected"` for more than 2 seconds:
   - Tutor (offerer) calls `createOffer({ iceRestart: true })` and sends the new offer over signaling.
   - Verification: Simulate disconnect by blocking UDP in OS firewall; connection recovers within 15 seconds.
5. During ICE restart, both pages show a shared countdown UI ("Reconnecting… 13s") counting down from 15 seconds.
   - Verification: Countdown visible in both tabs during simulated disconnect.
6. Coturn config file `infra/coturn.conf` and startup script `infra/start-coturn.sh` committed.
   - Verification: `bash infra/start-coturn.sh` starts Coturn in the foreground without errors.

## Implementation Notes
- Use the ephemeral credentials mechanism: `username = "<timestamp>:<userid>"`, `credential = HMAC-SHA1(sharedSecret, username)`. The signaling server computes this; the shared secret is in an env var `TURN_SHARED_SECRET`.
- Do not use long-lived static credentials — they cannot be revoked per session.
- ICE restart is initiated by the offerer (tutor). The viewer receives the new offer and responds with an answer. The data channel survives ICE restart if the `RTCDataChannel` is not closed — verify this by checking data channel state after reconnect.
- Set a 15-second countdown before giving up on ICE restart and showing a "connection lost — please rejoin" message. Do not loop ICE restarts indefinitely.
- Coturn on regtest does not need TLS. For production it would, but that is out of MVP scope.
- The TURN credential TTL (3600s) is separate from the Polar invoice TTL (600s) — do not confuse them (Technical Risk #4).

## Files to Create/Modify
- `infra/coturn.conf` — Coturn configuration
- `infra/start-coturn.sh` — Coturn startup script
- `signaling/src/server.ts` — add TURN credential generation to session messages
- `signaling/src/turn-credentials.ts` — HMAC credential generation helper
- `frontend/src/lib/peer-connection.ts` — use dynamic iceServers, add ICE restart logic
- `frontend/src/pages/tutor.ts` — trigger ICE restart, show countdown UI
- `frontend/src/pages/viewer.ts` — show countdown UI during ICE restart

## Estimated Effort
5–8 hours
