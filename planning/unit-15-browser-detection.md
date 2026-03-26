# Unit 15: Browser Detection and Compatibility Gating

## Summary
Add browser detection to block iOS Safari (which lacks `getDisplayMedia` and has poor WebRTC data channel reliability), warn macOS Safari users, and show a Chrome recommendation banner for unsupported or degraded browsers. This prevents sessions from starting in environments where payment or media will silently fail.

## Prerequisites
- Unit 05 (frontend scaffold — both HTML pages exist)
- Unit 14 (screen sharing — the primary feature blocked on iOS Safari)

## Deliverables
1. `frontend/src/lib/browser-detect.ts` exports:
   - `isIOSSafari(): boolean`
   - `isMacOSSafari(): boolean`
   - `isChrome(): boolean`
   - `supportsGetDisplayMedia(): boolean`
   - Verification: Unit test (`browser-detect.test.ts`) with mocked `navigator.userAgent` and `navigator.mediaDevices` asserts each function returns the correct value for 5 representative UA strings.
2. On page load for both tutor and viewer pages:
   - iOS Safari: full-page blocking overlay with text "iOS Safari is not supported. Please open this page in Chrome on a desktop." — no session controls rendered.
   - macOS Safari: dismissible yellow warning banner "Safari has limited support. Chrome is recommended for the best experience."
   - Other browsers: no banner.
   - Verification: Manually set `navigator.userAgent` via DevTools override and reload; correct banner/block appears.
3. A Chrome recommendation banner appears if `supportsGetDisplayMedia()` returns false (tutor page only), since screen sharing is required for tutoring.
   - Verification: Banner renders when `navigator.mediaDevices.getDisplayMedia` is `undefined`.
4. Browser detection runs synchronously before any WebRTC or signaling code initializes — use a top-of-file guard in each page entry point.
   - Verification: Network tab shows no WebSocket connection attempt when the blocking overlay is shown.

## Implementation Notes
- UA string detection is inherently fragile; supplement with feature detection (`navigator.mediaDevices.getDisplayMedia !== undefined`) for the most critical checks.
- iOS detection: `navigator.userAgent` contains `iPhone` or `iPad`, combined with absence of `CriOS` (Chrome on iOS uses the same UA base but is also limited).
- Do not import the browser-detect module lazily — it must run before Vite's module graph executes async imports.
- Keep the blocking overlay in plain HTML/CSS added to each HTML file; do not rely on JavaScript for rendering it (avoids a flash of unblocked content).
- Document the browser support matrix in `frontend/src/lib/browser-detect.ts` as a comment block at the top of the file.

## Files to Create/Modify
- `frontend/src/lib/browser-detect.ts` — detection functions
- `frontend/src/lib/browser-detect.test.ts` — unit tests
- `frontend/src/pages/tutor.ts` — browser guard at entry point
- `frontend/src/pages/viewer.ts` — browser guard at entry point
- `frontend/tutor.html` — blocking overlay markup (hidden by default, shown by JS)
- `frontend/viewer.html` — blocking overlay markup

## Estimated Effort
3–4 hours
