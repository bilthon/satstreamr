# Unit 20: End-to-End Integration Test

## Summary
Write and run an automated end-to-end test that exercises the full happy path: two browser windows (Playwright), a live session, three payment cycles, and a clean session end with summary. This is the final quality gate before the developer README is written.

## Prerequisites
- All prior units (01–19) complete and all services running: Polar, Nutshell mint, signaling server, Coturn, recording server, Vite dev server.

## Deliverables
1. `e2e/` directory with Playwright test configured to run against `http://localhost:5173`.
   - Verification: `npx playwright test` discovers and runs the test file.
2. `e2e/tests/happy-path.spec.ts` — single test that:
   a. Opens tutor page in browser context A, creates a session.
   b. Opens viewer page in browser context B with the session URL.
   c. Asserts ICE connection state `"connected"` in both contexts within 10 seconds.
   d. Asserts data channel status badge shows "open" in both contexts.
   e. Waits for 3 payment cycles to complete (3 acks received by viewer).
   f. Clicks "End Session" on tutor page.
   g. Asserts summary screen visible on both pages within 3 seconds with `chunkCount >= 3`.
   - Verification: `npx playwright test` exits 0 with all assertions passing.
3. `e2e/tests/double-spend.spec.ts` — test that confirms re-sending an already-acked token results in a `payment_nack` with `reason: "double_spend"`.
   - Verification: Test exits 0.
4. `e2e/tests/mint-mismatch.spec.ts` — test that confirms a viewer with a mismatched `VITE_MINT_URL` sees the error overlay and no data channel is opened.
   - Verification: Test exits 0.
5. Test results reported in JUnit XML format at `e2e/results/junit.xml`.
   - Verification: File exists after test run; contains at least 3 `<testcase>` elements.

## Implementation Notes
- Playwright supports multiple browser contexts in a single test — use `browser.newContext()` to simulate two independent users without needing two separate machines.
- Use `page.evaluate()` to read browser-side state (ICE connection state, data channel state) rather than relying solely on UI text.
- The payment cycle wait should use `page.waitForFunction()` with a polling interval, not `page.waitForTimeout()` — avoid fixed sleeps.
- If the mint requires actual Lightning payments (not just regtest simulation), ensure Polar has mined enough blocks before the test and that channels have sufficient liquidity.
- Run tests in headed mode (`--headed`) first to visually confirm the flow, then switch to headless for CI.
- Add an `e2e` npm script to the root `package.json`: `"e2e": "playwright test"`.

## Files to Create/Modify
- `e2e/playwright.config.ts` — Playwright config (base URL, browser, reporters)
- `e2e/tests/happy-path.spec.ts` — main E2E test
- `e2e/tests/double-spend.spec.ts` — double-spend rejection test
- `e2e/tests/mint-mismatch.spec.ts` — mint mismatch error test
- `e2e/package.json` — Playwright dependency
- `package.json` (root) — add `e2e` script
- `e2e/.gitignore` — exclude `results/`, `test-results/`

## Estimated Effort
6–10 hours
