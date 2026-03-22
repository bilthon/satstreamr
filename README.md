# satstreamr

A P2P metered live video streaming platform using [Cashu](https://cashu.space) e-cash micropayments and WebRTC.

## Concept

Viewers pay tutors/educators in real time using Cashu tokens sent over a WebRTC data channel. No platform intermediary holds funds — payments flow directly between peers, locked to the recipient's public key via NUT-11 (P2PK).

## Status

🚧 Developer preview — regtest only, not for production use.

## Architecture

- **Frontend** (this repo): TypeScript + Vite, WebRTC peer connection, in-browser Cashu wallet
- **Signaling server** ([satstreamr-signaling](https://github.com/bilthon/satstreamr-signaling)): Node.js WebSocket server for WebRTC session negotiation
- **Cashu mint**: [Nutshell](https://github.com/cashubtc/nutshell) connected to LND on regtest

## Getting Started

See `infra/README-polar.md` for the regtest environment setup.

## Tech Stack

- WebRTC (RTCPeerConnection + RTCDataChannel)
- Cashu NUT-11 (P2PK token locking), NUT-07 (token state), NUT-12 (DLEQ proofs)
- TypeScript, Vite
- LND (Lightning Network Daemon) via REST API
- Nutshell Cashu mint

## License

MIT
