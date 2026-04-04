# Satstreamr MVP — Progress Tracker

Last updated: 2026-04-04

## Legend
- ✅ Complete
- 🔄 In progress
- ⬜ Not started
- 🚧 Blocked

## Units

| Unit | Title | Status | Notes |
|------|-------|--------|-------|
| 01 | Regtest Lightning Network Setup | ✅ | Docker Compose (ARM64); bitcoind + lnd_mint + lnd_customer running |
| 02 | Nutshell Cashu Mint Setup | ✅ | Nutshell 0.19.2; LndRestWallet; mint live at :3338 |
| 03 | NUT-11 P2PK CLI Round-Trip Verification | ✅ | Gate 1 — PASSED 2026-03-22; cashu-ts 2.9.0 |
| 04 | Signaling Server Core | ✅ | WebSocket server (ws); 10 tests passing; port 8080 |
| 05 | Frontend Scaffold | ✅ | Vite + TS multi-page; SignalingClient; zero build errors |
| 06 | WebRTC Peer Connection | ✅ | Gate 2 — PASSED 2026-03-22; ICE connected in two browser tabs |
| 07 | Data Channel Setup | ✅ | DataChannel wrapper; ordered; devSend helper; merged |
| 08 | Cashu Wallet Module (browser) | ✅ | 4 integration tests passing; merged |
| 09 | WebSocket Reconnect & Session Persistence | ✅ | Merged; exponential backoff, session_rejoined ack, sessionStorage |
| 10 | Token Transfer over Data Channel | ✅ | Gate 3 — PASSED 2026-03-26; P2PK token delivered over data channel |
| 11 | Payment Scheduler | ✅ | Gate 4 — PASSED 2026-03-29; ~10s interval, self-scheduling setTimeout |
| 12 | Session UI | ✅ | Elapsed timer, budget display, pulse animation, session-end summary overlay |
| 13 | Coturn + ICE Restart | ⬜ | MVP |
| 14 | ~~Screen Sharing~~ | ❌ | Dropped — post-MVP |
| 15 | ~~Browser Detection~~ | ❌ | Dropped — post-MVP |
| 16 | Cash-out via Lightning Invoice | ⬜ | MVP |
| 17 | ~~Session Recording~~ | ❌ | Dropped — post-MVP |
| 18 | Same-Mint Enforcement | ⬜ | MVP |
| 19 | ~~Tutor Invite Flow~~ | ❌ | Dropped — post-MVP |
| 20 | E2E Integration Test | ⬜ | MVP |
| 21 | Developer README | ⬜ | MVP |

## Go/No-Go Gates

| Gate | Unit | Condition | Status |
|------|------|-----------|--------|
| 1 | 03 | NUT-11 P2PK round-trip passes on live mint | ✅ |
| 2 | 06 | WebRTC peer connection established between two browser tabs | ✅ |
| 3 | 10 | Cashu token delivered over data channel, verified by recipient | ✅ |
| 4 | 11 | Payment scheduler runs for 60s without missed chunks | ✅ |

## Repos

| Repo | Purpose | Bot access |
|------|---------|------------|
| [bilthon/satstreamr](https://github.com/bilthon/satstreamr) | Frontend app | backend-dev-bot, frontend-dev-bot, qa-dev-bot |
| [bilthon/satstreamr-signaling](https://github.com/bilthon/satstreamr-signaling) | Signaling server | backend-dev-bot, frontend-dev-bot, qa-dev-bot |

## Bot Identities

| Bot | Role | App ID |
|-----|------|--------|
| frontend-dev-bot | Frontend, WebRTC, Cashu browser wallet | 3157905 |
| backend-dev-bot | Signaling server, infra scripts | 3154069 |
| qa-dev-bot | Reviews PRs, approves merges | 3157936 |
