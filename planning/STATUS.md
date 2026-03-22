# Satstreamr MVP — Progress Tracker

Last updated: 2026-03-22 (Unit 06 code complete)

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
| 06 | WebRTC Peer Connection | 🔄 | Gate 2 — code complete, pending browser verification |
| 07 | Data Channel Setup | ⬜ | |
| 08 | Cashu Wallet Module (browser) | 🔄 | 4 integration tests passing; PR pending merge |
| 09 | WebSocket Reconnect & Session Persistence | ⬜ | |
| 10 | Token Transfer over Data Channel | ⬜ | Gate 3 |
| 11 | Payment Scheduler | ⬜ | Gate 4 |
| 12 | Session UI | ⬜ | |
| 13 | Coturn + ICE Restart | ⬜ | |
| 14 | Screen Sharing | ⬜ | |
| 15 | Browser Detection | ⬜ | |
| 16 | Cash-out via Lightning Invoice | ⬜ | |
| 17 | Session Recording | ⬜ | |
| 18 | Same-Mint Enforcement | ⬜ | |
| 19 | Tutor Invite Flow | ⬜ | |
| 20 | E2E Integration Test | ⬜ | |
| 21 | Developer README | ⬜ | |

## Go/No-Go Gates

| Gate | Unit | Condition | Status |
|------|------|-----------|--------|
| 1 | 03 | NUT-11 P2PK round-trip passes on live mint | ✅ |
| 2 | 06 | WebRTC peer connection established between two browser tabs | ⬜ |
| 3 | 10 | Cashu token delivered over data channel, verified by recipient | ⬜ |
| 4 | 11 | Payment scheduler runs for 60s without missed chunks | ⬜ |

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
