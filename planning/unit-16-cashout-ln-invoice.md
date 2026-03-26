# Unit 16: Tutor Cash-Out via Lightning Invoice

## Summary
Allow the tutor to cash out accumulated Cashu tokens by pasting a Lightning Network invoice into the UI. The browser calls the Nutshell mint's melt API, which pays the invoice, burns the tokens, and confirms the payment. This closes the economic loop for the tutor.

## Prerequisites
- Unit 02 (Nutshell mint running)
- Unit 10 (tutor accumulates redeemed tokens in memory)
- Unit 12 (session UI — cash-out button goes in the session summary or post-session screen)

## Deliverables
1. Post-session screen (from Unit 12) includes a "Cash Out" section with a text input for a Lightning invoice and a "Pay Invoice" button.
   - Verification: Cash-out section visible on the tutor's session-end summary screen.
2. Clicking "Pay Invoice" calls `frontend/src/lib/cashu-wallet.ts` `meltTokens(invoice: string, tokens: Token[]): Promise<MeltResult>` which posts to `http://localhost:3338/v1/melt`.
   - Verification: In browser DevTools network tab, a POST to `/v1/melt` is visible with correct proof payloads.
3. On success, the UI shows "Payment sent!" with the preimage.
   - Verification: After paying a regtest invoice, the success message and preimage appear in the UI.
4. On failure (insufficient tokens, expired invoice, mint error), a human-readable error message is shown — no raw JSON error bodies exposed to the user.
   - Verification: Paste an expired invoice; a friendly error "Invoice expired — please generate a new one" appears.
5. Polar invoice TTL is 600 seconds — the cash-out UI shows a countdown timer next to the invoice input field, starting from 600s when the invoice is pasted.
   - Verification: Countdown visible, decrements, and shows a warning at 60s remaining (Technical Risk #4).

## Implementation Notes
- Nutshell's melt endpoint is `/v1/melt/bolt11` (NUT-05). Confirm the exact path with `curl http://localhost:3338/v1/info` and check supported NUTs.
- The tutor accumulates Cashu proofs in memory as tokens are redeemed over the session. These proofs must be stored in `sessionStorage` from the moment of redemption so they survive a page reload before cash-out.
- For MVP, the tutor selects all available proofs for the melt — no denomination selection UI.
- The mint may require a melt quote step before the actual melt. Check if Nutshell implements NUT-05 quote flow; if so, add a `getMeltQuote()` call before `meltTokens()`.
- Regtest invoices generated in Polar use the `lnbcrt` prefix. Validate the invoice prefix before sending to avoid confusing error messages from the mint.

## Files to Create/Modify
- `frontend/src/lib/cashu-wallet.ts` — add `meltTokens()` and `getMeltQuote()` functions
- `frontend/src/pages/tutor.ts` — cash-out section logic and countdown timer
- `frontend/tutor.html` — cash-out invoice input and status elements
- `frontend/src/lib/session-storage.ts` — persist accumulated proofs

## Estimated Effort
4–6 hours
