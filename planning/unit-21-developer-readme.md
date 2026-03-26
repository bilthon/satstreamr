# Unit 21: Developer README

## Summary
Write the developer README that enables a new engineer to clone the repository and get a fully working session running end-to-end in one sitting. The README covers prerequisites, service startup order, known limitations, and key architecture decisions.

## Prerequisites
- All prior units (01–20) complete — the README documents the final state of the system.

## Deliverables
1. `README.md` at the project root with the following sections:
   - **Overview** — one paragraph describing the project.
   - **Architecture Diagram** — ASCII diagram showing the components (Polar, Nutshell mint, signaling server, Coturn, frontend, recording server) and the data flows between them.
   - **Prerequisites** — exact software with minimum versions: Polar, Docker, Node.js, Python, Playwright.
   - **Quick Start** — numbered steps to get a session running, covering: start Polar, start mint, start signaling server, start Coturn, start recording server, run `npm run dev` in `frontend/`, open tutor and viewer pages.
   - **Environment Variables** — table of all `VITE_*` variables with default values and descriptions.
   - **Payment Flow** — explanation of the P2PK token lifecycle (mint → send over data channel → redeem → ack).
   - **Known Limitations** — list covering: not seekable recordings (with mkvmerge command), no user accounts, single hardcoded mint, iOS Safari blocked, Polar invoice 600s TTL.
   - **Troubleshooting** — 5+ common failure modes with diagnosis and fix.
   - Verification: A developer not involved in the project can follow the README and reach ICE `"connected"` in two browser tabs within 30 minutes.
2. Each service subdirectory (`signaling/`, `recording-server/`, `infra/`) has its own minimal `README.md` with start command, port, and configuration options.
   - Verification: Files exist in each subdirectory.

## Implementation Notes
- The ASCII architecture diagram should show: `[Browser A (Tutor)] <--WebRTC--> [Browser B (Viewer)]` with the signaling server, TURN server, mint, and recording server as supporting infrastructure.
- The Troubleshooting section must include: ICE stuck in "checking" (TURN not running), mint returns 500 (LND not connected to Polar), data channel never opens (firewall), double-spend error on first payment (stale sessionStorage from previous session), WebSocket drops and does not reconnect (browser tab backgrounded on mobile).
- Technical Risk notes from the plan should appear inline in the README where relevant (e.g., invoice TTL in the Quick Start steps, single-mint note in Known Limitations).
- Do not include any private keys, macaroon values, or `.env` file contents in the README — reference the `.env.example` files.

## Files to Create/Modify
- `README.md` — main developer README
- `signaling/README.md` — signaling server README
- `recording-server/README.md` — recording server README (update the stub from Unit 17)
- `infra/README-polar.md` — update the stub from Unit 01

## Estimated Effort
3–5 hours
