# Unit 06: WebRTC Peer Connection (Audio/Video)

## Status

| Field | Value |
|-------|-------|
| State | 🔄 Code complete — pending browser verification |
| Branch | `feat/unit-06-webrtc-peer-connection` |
| Updated | 2026-03-22 |
| Build | `npm run build` exits 0, zero TypeScript errors |
| Browser test | Deferred — requires machine with camera/mic and two browser tabs |

## Summary
Establish a bidirectional audio/video RTCPeerConnection between the tutor and viewer pages using the signaling server for offer/answer/ICE exchange. The goal is two browser tabs on localhost that can see and hear each other. This is the media foundation on which the data channel and payment layer are built.

## Prerequisites
- Unit 04 (signaling server running)
- Unit 05 (frontend scaffold with signaling client)

## Deliverables
1. Tutor page: captures local camera/mic via `getUserMedia`, creates an `RTCPeerConnection`, creates a session via signaling, and displays own video in a `<video>` element (muted).
   - Verification: Local video appears in tutor tab without audio echo.
2. Viewer page: joins an existing session (session ID from URL query param `?session=<id>`), creates its own `RTCPeerConnection`, and completes offer/answer exchange via signaling server.
   - Verification: Both tabs show `ICE connection state: connected` in the browser console.
3. Remote video/audio renders in both tabs (tutor sees viewer, viewer sees tutor — bidirectional).
   - Verification: Manual test — speak into mic on one tab, hear audio in the other tab.
4. `frontend/src/lib/peer-connection.ts` encapsulates all RTCPeerConnection setup and emits typed events (`onTrack`, `onIceStateChange`, `onDataChannel`).
   - Verification: `npm run build` completes without TypeScript errors.
5. STUN-only ICE config pointing to `stun:stun.l.google.com:19302` (TURN added in Unit 13).
   - Verification: ICE candidates in browser console show `srflx` or `host` type entries.

## Implementation Notes
- Use `onnegotiationneeded` on the tutor side to initiate the offer; viewer responds with an answer. Do not trigger renegotiation from viewer side in this unit.
- Add all tracks to the peer connection before creating the offer to avoid a second negotiation cycle.
- ICE candidate trickle: send candidates over signaling as they arrive via `onicecandidate`; buffer them on the receiver until `setRemoteDescription` completes.
- The `RTCPeerConnection` object must be accessible from outside `peer-connection.ts` so the data channel (Unit 07) can be added to the same connection without ICE renegotiation.
- On localhost, STUN is usually sufficient for ICE to succeed. TURN (Coturn) is Unit 13.
- Error handling: if `getUserMedia` is denied, show a human-readable error message in the UI, not just a console log.

## Files to Create/Modify
- `frontend/src/lib/peer-connection.ts` — RTCPeerConnection abstraction
- `frontend/src/pages/tutor.ts` — add session creation and media logic
- `frontend/src/pages/viewer.ts` — add session joining and media logic
- `frontend/tutor.html` — add `<video>` elements
- `frontend/viewer.html` — add `<video>` elements

## Estimated Effort
5–8 hours
