# Unit 14: Screen Sharing and Camera/Screen Toggle

## Summary
Add `getDisplayMedia` screen sharing to the tutor page with a pre-flight check modal that requires the tutor to confirm their screen share is correct before going live. Implement camera-to-screen toggle using `replaceTrack` to avoid ICE renegotiation.

## Prerequisites
- Unit 06 (WebRTC peer connection with camera/mic tracks active)

## Deliverables
1. Tutor page has a "Share Screen" button. Clicking it opens a pre-flight modal showing a preview of the screen capture before it is sent to the viewer.
   - Verification: Clicking "Share Screen" shows a modal with a live preview of the captured display.
2. Pre-flight modal has "Go Live" and "Cancel" buttons. "Go Live" replaces the camera video track with the screen capture track using `replaceTrack` (no ICE renegotiation).
   - Verification: After "Go Live", the viewer tab shows the tutor's screen instead of camera. Browser console shows no new ICE negotiation messages.
3. "Stop Sharing" button reverts to the camera track using `replaceTrack`.
   - Verification: Viewer tab reverts to camera video after "Stop Sharing" is clicked.
4. Audio track is preserved (not replaced) during screen share toggle.
   - Verification: Viewer can hear tutor audio before, during, and after screen share.
5. `getDisplayMedia` errors (user cancels, browser blocks) are caught and shown as a dismissible error toast — the session continues with camera.
   - Verification: Pressing Esc on the system screen picker shows the error toast and camera video continues.

## Implementation Notes
- `getDisplayMedia` must be called in response to a user gesture (button click) — do not call it in a `setTimeout` or programmatically outside of a click handler, or browsers will block it.
- `replaceTrack` replaces the track in the `RTCRtpSender` without triggering renegotiation only if the track kind matches (`video → video`). Confirm this with browser DevTools — no new offer/answer should appear in the signaling server logs.
- The pre-flight modal preview uses a separate `<video>` element (not the main stream). Do not attach the `getDisplayMedia` stream to the `RTCPeerConnection` until the tutor confirms.
- On screen share stop (user clicks the browser's "Stop sharing" button), the `MediaStreamTrack` fires an `ended` event. Listen for this and revert to camera automatically.
- iOS Safari does not support `getDisplayMedia` — block it in Unit 15. macOS Safari supports it partially — warn.

## Files to Create/Modify
- `frontend/src/lib/media-manager.ts` — `getDisplayMedia` wrapper and `replaceTrack` helpers
- `frontend/src/pages/tutor.ts` — pre-flight modal logic and toggle button handlers
- `frontend/tutor.html` — "Share Screen" / "Stop Sharing" buttons, pre-flight modal markup
- `frontend/src/styles/session.css` — modal styles

## Estimated Effort
4–6 hours
