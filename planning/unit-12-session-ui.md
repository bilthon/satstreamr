# Unit 12: Session UI (Metering, Budget, and Session End)

## Summary
Build the in-session UI elements for both the tutor and viewer pages: elapsed time display, accumulated sats counter, chunk pulse animation, remaining budget indicator, and the session-end summary screen shown to both parties. This unit makes the payment system visible and comprehensible to users.

## Prerequisites
- Unit 11 (payment scheduler firing events)
- Unit 06 (WebRTC video streams displayed)

## Deliverables
1. Tutor page shows:
   - Elapsed session time in `MM:SS` format (primary, large display), counting up from session start.
   - Accumulated sats received (secondary display), updated after each `payment_ack` sent.
   - Verification: Manual test — elapsed timer increments every second; sats counter increases by `chunkSats` after each payment cycle.
2. Viewer page shows:
   - Remaining budget in sats (large display), decremented after each `payment_ack` received.
   - Chunk pulse animation: a small indicator flashes on each successful payment (CSS animation, 500ms).
   - Verification: Manual test — budget decrements; pulse animation visible on each payment.
3. Both pages show a session-end summary screen when `end_session` is received or `onBudgetExhausted` fires, containing:
   - Total session duration.
   - Total sats exchanged.
   - Total chunk count.
   - A "Close" button that clears `sessionStorage` and reloads to the starting page.
   - Verification: Clicking "End Session" on the tutor page shows the summary on both tutor and viewer pages within 2 seconds.
4. Payment failure state is shown as a full-width banner with text "Payment paused — check your wallet" on the viewer page and "Payment paused — waiting for viewer" on the tutor page.
   - Verification: Triggering `onPaymentFailure` in the scheduler shows the banner on both pages.

## Implementation Notes
- All UI updates must happen in the main thread. Subscribe to scheduler events via callbacks/EventTarget; do not poll.
- The elapsed timer runs on the tutor side from the moment the data channel opens. It is not synchronized with the viewer's clock — do not attempt NTP-style sync for MVP.
- The pulse animation can be a simple CSS `@keyframes` scale/opacity effect on a `<span>` element. Trigger it by toggling a CSS class and removing it after 500ms via `setTimeout`.
- The session-end summary screen should overlay the video (not replace the page) so the user can still see the frozen last frame while reading the summary.
- Keep all UI logic in `frontend/src/pages/tutor.ts` and `frontend/src/pages/viewer.ts` — avoid creating a UI framework. Plain DOM manipulation is fine.

## Files to Create/Modify
- `frontend/tutor.html` — add elapsed time, sats counter, summary overlay elements
- `frontend/viewer.html` — add budget display, pulse indicator, summary overlay elements
- `frontend/src/pages/tutor.ts` — wire scheduler events to UI elements
- `frontend/src/pages/viewer.ts` — wire scheduler events to UI elements
- `frontend/src/styles/session.css` — pulse animation keyframes and summary overlay styles

## Estimated Effort
4–6 hours
