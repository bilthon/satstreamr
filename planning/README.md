# P2P Metered Live Video Streaming Platform — MVP Planning

Browser-based P2P live video streaming for tutoring sessions, with per-minute metered payment via Cashu e-cash (NUT-11 P2PK) over a WebRTC data channel, running on a Bitcoin regtest stack (Polar + Nutshell).

---

## Work Units

| ID | Title | Summary |
|----|-------|---------|
| [Unit 01](unit-01-polar-network-setup.md) | Polar Regtest Network Setup | Stand up two funded LND nodes in Polar with an open channel providing inbound liquidity for the mint. |
| [Unit 02](unit-02-nutshell-mint-setup.md) | Nutshell Cashu Mint Setup | Install and configure the Nutshell Python mint connected to the Polar LND backend on port 3338. |
| [Unit 03](unit-03-p2pk-cli-verification.md) | NUT-11 P2PK CLI Round-Trip Verification | CLI script that mints, redeems, and detects double-spend of a P2PK-locked Cashu token against the live mint. |
| [Unit 04](unit-04-signaling-server-core.md) | Signaling Server Core (WebSocket) | Node.js WebSocket server that brokers session creation, joining, and WebRTC offer/answer/ICE relay. |
| [Unit 05](unit-05-frontend-scaffold.md) | Frontend Scaffold (TypeScript + Vite) | Vite multi-page app with tutor and viewer HTML entry points, typed signaling client, and environment config. |
| [Unit 06](unit-06-webrtc-peer-connection.md) | WebRTC Peer Connection (Audio/Video) | Bidirectional audio/video RTCPeerConnection established between two browser tabs via the signaling server. |
| [Unit 07](unit-07-data-channel-setup.md) | WebRTC Data Channel Setup | Reliable ordered data channel alongside media streams, with typed message wrapper for payment protocol messages. |
| [Unit 08](unit-08-cashu-wallet-module.md) | Cashu Wallet Module (Browser) | Browser-side module wrapping cashu-ts for P2PK token minting (NUT-11), state check (NUT-07), and DLEQ verification (NUT-12). |
| [Unit 09](unit-09-ws-reconnect-session-persistence.md) | WebSocket Reconnect and Session Persistence | Exponential backoff WS reconnect and sessionStorage persistence of payment state so a brief disconnect does not lose the session. |
| [Unit 10](unit-10-token-transfer-over-data-channel.md) | Token Transfer Over Data Channel | End-to-end manual token send from viewer to tutor over the data channel, with ack/nack and double-spend rejection. |
| [Unit 11](unit-11-payment-scheduler.md) | Payment Scheduler and Session Metering | Automatic per-interval token payment loop with retry, one-token-at-a-time enforcement, and budget exhaustion detection. |
| [Unit 12](unit-12-session-ui.md) | Session UI (Metering, Budget, and Session End) | Elapsed time, sats counter, budget display, chunk pulse animation, and session-end summary screen for both parties. |
| [Unit 13](unit-13-coturn-ice-restart.md) | Coturn TURN Server and ICE Restart | Coturn relay with HMAC short-lived credentials, automatic ICE restart on disconnect, and reconnection countdown UI. |
| [Unit 14](unit-14-screen-sharing.md) | Screen Sharing and Camera/Screen Toggle | getDisplayMedia with pre-flight check modal and replaceTrack toggle between camera and screen without ICE renegotiation. |
| [Unit 15](unit-15-browser-detection.md) | Browser Detection and Compatibility Gating | Block iOS Safari, warn macOS Safari, and show Chrome recommendation banner using UA and feature detection. |
| [Unit 16](unit-16-cashout-ln-invoice.md) | Tutor Cash-Out via Lightning Invoice | Tutor pastes an LN invoice post-session; browser calls Nutshell melt API to burn tokens and pay the invoice. |
| [Unit 17](unit-17-session-recording.md) | Session Recording (Chunked Upload) | MediaRecorder on tutor side produces 60-second WebM chunks uploaded to an Express endpoint with a download link in the summary. |
| [Unit 18](unit-18-same-mint-enforcement.md) | Same-Mint Enforcement | Viewer's mint URL is checked against session metadata on join; mismatches show a blocking error before any token is sent. |
| [Unit 19](unit-19-tutor-invite-flow.md) | Tutor Invite Flow | "Invite Student" button generates a formatted message with the viewer URL, cost estimate, and wallet setup link. |
| [Unit 20](unit-20-e2e-integration-test.md) | End-to-End Integration Test | Playwright tests covering the happy path (3 payment cycles + session end), double-spend rejection, and mint mismatch blocking. |
| [Unit 21](unit-21-developer-readme.md) | Developer README | Comprehensive README with architecture diagram, quick start, environment variables, known limitations, and troubleshooting guide. |

---

## Dependency Order (suggested implementation sequence)

```
01 → 02 → 03
         ↓
04 → 05 → 06 → 07 → 10 → 11 → 12
              ↓         ↑
             08 ────────┘
         ↓
09 (hardens 04+05)
13 (hardens 06)
14 (extends 06)
15 (extends 05)
16 (extends 10+12)
17 (extends 06+12)
18 (extends 04+10)
19 (extends 06+12)
20 (requires all above)
21 (requires all above)
```

Units 03 and 04 can be worked in parallel after Units 01–02 are complete. Units 13–19 can largely be parallelized once Units 06–12 are stable.
