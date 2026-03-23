# Unit 07: WebRTC Data Channel Setup

## Summary
Open a reliable, ordered WebRTC data channel alongside the existing media streams. The data channel carries Cashu token JSON in one direction (viewer to tutor) and acknowledgment messages in the other. This unit delivers the transport layer for the payment system — no payment logic yet, just verified bidirectional messaging.

## Prerequisites
- Unit 06 (WebRTC peer connection with audio/video established)

## Deliverables
1. Tutor creates the data channel (`label: "payment"`, `{ ordered: true }`) before creating the offer so it is negotiated with the initial peer connection.
   - Verification: Browser console on tutor tab shows `data channel open` when viewer connects.
2. Viewer receives the data channel via `ondatachannel` event and holds a reference to it.
   - Verification: Browser console on viewer tab shows `data channel open`.
3. `frontend/src/lib/data-channel.ts` wraps the `RTCDataChannel` and exposes:
   - `sendMessage(msg: DataChannelMessage): void` — serializes to JSON and sends.
   - `onMessage(handler: (msg: DataChannelMessage) => void): void` — deserializes and dispatches.
   - Typed union type `DataChannelMessage` covering `token_payment`, `payment_ack`, `payment_nack`.
   - Verification: `npm run build` with zero TypeScript errors.
4. Manual round-trip test: typing a test message in a browser console `devSend()` helper on the viewer tab causes the tutor tab to log the received message, and vice versa.
   - Verification: Described test produces visible console output on both sides.
5. Data channel state is surfaced in the UI as a status badge ("payment channel: open / closed").
   - Verification: Badge visible and correct in both tutor and viewer UI.

## Implementation Notes
- Create the data channel on the tutor side before `createOffer()`. If added after, a new negotiation round is needed — avoid this.
- The payment protocol (Unit 08) requires `ordered: true` so chunk IDs arrive in sequence. Do not change this option.
- Data channel messages are plain JSON strings. Define the `DataChannelMessage` discriminated union in `frontend/src/types/data-channel.ts` and share it between the wrapper and the pages.
- The `readyState` of the data channel must be `"open"` before any payment message is sent. The payment scheduler (Unit 11) must gate on this state.
- Keep the `devSend()` helper only in development builds — wrap with `if (import.meta.env.DEV)`.

## Files to Create/Modify
- `frontend/src/lib/data-channel.ts` — RTCDataChannel wrapper
- `frontend/src/types/data-channel.ts` — DataChannelMessage union types
- `frontend/src/pages/tutor.ts` — wire up data channel creation
- `frontend/src/pages/viewer.ts` — wire up ondatachannel handler
- `frontend/tutor.html` — add payment channel status badge
- `frontend/viewer.html` — add payment channel status badge

## Estimated Effort
3–5 hours

## Status

**🔄 In progress — implementation complete, PR open**

Implemented 2026-03-22 by frontend-dev-bot.

- `frontend/src/types/data-channel.ts` — `DataChannelMessage` discriminated union created.
- `frontend/src/lib/data-channel.ts` — `DataChannel` wrapper with typed send/receive, `devSend()` DEV helper, JSON validation.
- `frontend/src/lib/peer-connection.ts` — `createPaymentChannel()` added; tutor calls this before `createOffer()`.
- `frontend/src/pages/tutor.ts` — creates payment channel before offer, handles `onDataChannel`, updates badge.
- `frontend/src/pages/viewer.ts` — handles `ondatachannel` via `peer.onDataChannel`, waits for `onopen` before marking ready, updates badge.
- `frontend/tutor.html` / `frontend/viewer.html` — `#dc-status` badge added.
- `npm run build` exits 0 with zero TypeScript errors.

Integration note: `peer-connection.ts` already had `onDataChannel` and `ondatachannel` wired in the constructor (Unit 06 stub). The viewer side was already correct. Only the tutor side needed a new `createPaymentChannel()` method that synthesises an `RTCDataChannelEvent` on `channel.onopen` and fires the existing `onDataChannel` callback.
