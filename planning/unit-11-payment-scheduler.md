# Unit 11: Payment Scheduler and Session Metering

## Summary
Implement the automatic payment loop that sends a Cashu token every N seconds, waits for acknowledgment, retries once after 5 seconds if no ack arrives, and pauses the session if the retry also fails. This unit also tracks the viewer's budget and auto-ends the session when it reaches zero.

## Prerequisites
- Unit 10 (manual token transfer over data channel working end-to-end)
- Unit 09 (session state in sessionStorage)

## Deliverables
1. `frontend/src/lib/payment-scheduler.ts` exported class `PaymentScheduler` with:
   - Constructor: `(dataChannel: DataChannelWrapper, wallet: CashuWallet, opts: { intervalSecs: number, chunkSats: number, budgetSats: number, tutorPubkey: string })`
   - `start()` — begins the payment timer.
   - `stop()` — halts the timer and clears pending state.
   - `onBudgetExhausted(cb)` — fires when `budgetSats` hits 0.
   - `onPaymentFailure(cb)` — fires when a chunk fails after retry.
   - Verification: Unit test (mocked wallet and data channel) asserts that after 3 intervals, `chunkCount === 3` and `totalSatsPaid === 3 * chunkSats`.
2. Retry logic: if no `payment_ack` arrives within 5 seconds of sending, the scheduler resends the same token. If the second attempt also fails within 5 seconds, `onPaymentFailure` fires and the scheduler stops.
   - Verification: Unit test with a mock data channel that drops the first ack asserts exactly one retry and then continues on the second ack.
3. Budget tracking: `budgetRemaining` decremented by `chunkSats` only after `payment_ack` received (not on send). When `budgetRemaining <= 0`, `onBudgetExhausted` fires and session ends.
   - Verification: Unit test with `budgetSats: 3` and `chunkSats: 1` fires `onBudgetExhausted` after 3 successful acks and does not send a 4th token.
4. `chunkId` is monotonically increasing, stored in `sessionStorage`, and survives page reload (see Unit 09).
   - Verification: Reloading the viewer page mid-session continues from the last stored `chunkId`, not from 1.
5. All scheduler state (`chunkId`, `budgetRemaining`, `totalSatsPaid`) is written to `sessionStorage` after every state change.
   - Verification: Confirmed by inspecting Application > sessionStorage in browser DevTools after each payment event.

## Implementation Notes
- Strict one-token-at-a-time: the timer does not fire the next chunk until the current chunk's ack is received (Technical Risk #3). Implement this with a `pending: boolean` flag — if `pending` is true when the timer fires, skip that interval and log a warning.
- The 5-second retry timeout is per-attempt, not per-chunk. Use `setTimeout` and cancel it in the ack handler.
- Do not use `setInterval` for the payment loop — use a self-scheduling `setTimeout` so the interval accounts for the time spent waiting for the mint. This prevents drift accumulation over long sessions.
- The scheduler should emit progress events that the UI can subscribe to for the pulse animation (Unit 12) without coupling the scheduler to DOM code.
- On `onPaymentFailure`, the viewer UI must show a clear error — do not silently stop. The tutor side should also be notified via a `session_paused` data channel message.

## Files to Create/Modify
- `frontend/src/lib/payment-scheduler.ts` — PaymentScheduler class
- `frontend/src/lib/payment-scheduler.test.ts` — unit tests with mocks
- `frontend/src/pages/viewer.ts` — instantiate and start scheduler after data channel opens
- `frontend/src/lib/session-storage.ts` — add `chunkId` and scheduler state fields

## Estimated Effort
6–8 hours
