# satstreamr

Satstreamr is a peer-to-peer metered live video tutoring platform. A viewer connects directly to a tutor's browser over WebRTC and pays in Cashu e-cash micropayments sent over a WebRTC data channel — no payment processor required. This is a regtest-only developer preview; mainnet support is not implemented.

---

## Architecture

```
                        ┌─────────────────────────┐
                        │   Signaling Server       │
                        │   ws://localhost:8080    │
                        └────────┬────────┬────────┘
                                 │        │
                    offer/answer │        │ offer/answer
                                 │        │
              ┌──────────────────┘        └──────────────────┐
              │                                              │
   ┌──────────▼──────────┐    WebRTC (video +     ┌─────────▼───────────┐
   │  Browser (Tutor)    │◄──── data channel) ───►│  Browser (Viewer)   │
   │  :5173/tutor.html   │                         │  :5173/viewer.html  │
   └─────────────────────┘                         └─────────────────────┘
              ▲                                              │
              │  Cashu tokens (P2PK, over data channel)     │
              └──────────────────────────────────────────────┘

   Supporting services:

   ┌──────────────────────┐        ┌──────────────────────────┐
   │  Nutshell Mint       │        │  Coturn TURN Server      │
   │  http://localhost:   │        │  UDP/TCP port 3478       │
   │  3338                │        │  (relay for symmetric    │
   │  (Cashu e-cash mint) │        │   NAT environments)      │
   └──────────────────────┘        └──────────────────────────┘
              ▲
              │  LND REST (regtest)
   ┌──────────┴───────────┐
   │  Docker Compose      │
   │  bitcoind (regtest)  │
   │  lnd_mint  :8081     │
   │  lnd_customer :8082  │
   └──────────────────────┘
```

---

## Prerequisites

| Dependency | Minimum version | Notes |
|---|---|---|
| Node.js | 18+ | Required for frontend and signaling server |
| npm | 9+ | Bundled with Node.js 18 |
| Python | 3.11+ | Required for Nutshell Cashu mint |
| Docker + Docker Compose | Docker 24+ | Runs the regtest Lightning stack |
| coturn | any recent | `apt install coturn` (Linux) or `brew install coturn` (macOS) |
| Polar | latest | Optional — GUI for the Lightning nodes (macOS/Linux desktop only) |

---

## Quick Start

Work through the steps in order. Each service depends on the previous one being healthy.

### Step 1: Start the regtest Lightning stack

```bash
cd /path/to/satstreamr/infra
docker compose up -d
bash bootstrap-regtest.sh
```

`bootstrap-regtest.sh` is idempotent — safe to re-run. It waits for bitcoind and both LND nodes to become ready, mines initial blocks, funds each node, opens a channel between them, and extracts `lnd_mint` credentials to `infra/lnd-mint-creds/`.

**Services started:**

| Container | Host port | Purpose |
|---|---|---|
| `bitcoind` | 18443 (RPC) | Regtest Bitcoin node |
| `lnd_mint` | 8081 (REST), 10009 (gRPC) | LND node backing the Cashu mint |
| `lnd_customer` | 8082 (REST), 10010 (gRPC) | LND node used by the viewer browser |

### Step 2: Start the Nutshell Cashu mint

```bash
cp infra/nutshell.env.example infra/nutshell.env
```

Edit `infra/nutshell.env` and set:

- `MINT_BACKEND_BOLT11_SAT=LndRestWallet`
- `LND_REST_ENDPOINT=https://127.0.0.1:8081`
- `MINT_LND_REST_CERT=` absolute path to `infra/lnd-mint-creds/tls.cert`
- `MINT_LND_REST_MACAROON=` hex string from `xxd -p -c 1000 infra/lnd-mint-creds/admin.macaroon`
- `CASHU_DIR=` absolute path to a local directory for mint storage (e.g. `/home/<you>/Development/satstreamr/infra/cashu-data`)
- `MINT_PRIVATE_KEY=` output of `openssl rand -hex 32`

You also need a Python virtual environment with Nutshell installed:

```bash
cd infra
python3 -m venv nutshell-venv
nutshell-venv/bin/pip install cashu==0.19.2
```

Then start the mint:

```bash
bash infra/start-mint.sh   # mint listens on http://localhost:3338
```

### Step 3: Start the Coturn TURN server

```bash
cp infra/coturn.env.example infra/coturn.env
```

Edit `infra/coturn.env` and set:

```
TURN_SHARED_SECRET=<output of: openssl rand -hex 32>
```

Then start coturn:

```bash
bash infra/start-coturn.sh   # TURN listens on port 3478
```

Keep this terminal open or run it as a background process. Coturn logs go to `/var/log/coturn/coturn.log`.

### Step 4: Start the signaling server

The signaling server lives in a separate repository (`satstreamr-signaling`). Clone it alongside `satstreamr` if you have not already:

```bash
git clone https://github.com/bilthon/satstreamr-signaling.git
```

Then start it, passing the same shared secret used in Step 3:

```bash
cd satstreamr-signaling/signaling
npm install
TURN_SHARED_SECRET=<same secret from coturn.env> TURN_HOST=localhost npm run dev
# signaling server listens on ws://localhost:8080
```

### Step 5: Start the frontend

```bash
cd frontend
cp .env.example .env
```

Edit `frontend/.env` and fill in `VITE_LND_CUSTOMER_MACAROON_HEX`. Extract the hex value from the running container:

```bash
docker exec lnd_customer xxd -p -c 256 \
  /root/.lnd/data/chain/bitcoin/regtest/admin.macaroon
```

Then install dependencies and start the dev server:

```bash
npm install
npm run dev
```

Open two browser tabs:

- Tutor: [http://localhost:5173/tutor.html](http://localhost:5173/tutor.html)
- Viewer: [http://localhost:5173/viewer.html](http://localhost:5173/viewer.html)

---

## Environment Variables Reference

### `infra/nutshell.env`

| Variable | Required | Description | Example |
|---|---|---|---|
| `MINT_BACKEND_BOLT11_SAT` | Yes | Wallet backend for BOLT-11 payments | `LndRestWallet` |
| `MINT_URL` | Yes | Public URL of the mint | `http://127.0.0.1:3338` |
| `MINT_PORT` | Yes | Port the mint listens on | `3338` |
| `MINT_HOST` | Yes | Bind address | `0.0.0.0` |
| `MINT_PRIVATE_KEY` | Yes | 32-byte hex key for the mint | `openssl rand -hex 32` |
| `CASHU_DIR` | Yes | Absolute path for mint data storage | `/home/you/satstreamr/infra/cashu-data` |
| `MINT_LND_REST_ENDPOINT` | Yes (LndRestWallet) | LND REST API URL | `https://127.0.0.1:8081` |
| `MINT_LND_REST_CERT` | Yes (LndRestWallet) | Absolute path to LND TLS cert | `/home/you/satstreamr/infra/lnd-mint-creds/tls.cert` |
| `MINT_LND_REST_MACAROON` | Yes (LndRestWallet) | Hex-encoded admin macaroon | `0201...` |

### `frontend/.env`

| Variable | Required | Description | Example |
|---|---|---|---|
| `VITE_SIGNALING_URL` | Yes | WebSocket URL of the signaling server | `ws://localhost:8080` |
| `VITE_MINT_URL` | Yes | HTTP URL of the Nutshell mint | `http://localhost:3338` |
| `VITE_LND_CUSTOMER_REST_URL` | Yes | LND REST API for the customer node | `https://localhost:8082` |
| `VITE_LND_CUSTOMER_MACAROON_HEX` | Yes | Hex-encoded admin macaroon for `lnd_customer` | `0201...` |

---

## Running Tests

### Signaling server tests

```bash
cd satstreamr-signaling/signaling
npm run build
npm test
```

Uses Jest. Runs 10 tests covering WebSocket message handling and session management. All 10 should pass.

### Frontend unit tests

```bash
cd frontend
npm test
```

Uses Vitest. Covers the Cashu wallet module and data channel helpers.

---

## Gate Verification Checklist

The MVP has four go/no-go gates. To manually verify each one:

**Gate 1 — NUT-11 P2PK round-trip**
With the mint running, open `tutor.html` and use the browser console to mint a token locked to a public key, then redeem it with the corresponding private key. Expect no errors and a confirmed proof.

**Gate 2 — WebRTC peer connection**
Start all services. Open `tutor.html` and `viewer.html` in two tabs. Start a session on the tutor tab. The viewer tab should show "Connected" and display the tutor's video stream. Check the browser console for `iceConnectionState: "connected"`.

**Gate 3 — Cashu token over data channel**
With a live Gate 2 session, watch the browser console. Within ~10 seconds the viewer should log "token received" and the tutor should log "token redeemed". Balances in the UI update accordingly.

**Gate 4 — Payment scheduler runs for 60 seconds**
Keep the Gate 3 session running for at least 60 seconds without closing either tab. Confirm payment chunks continue to be logged at approximately 10-second intervals with no missed chunks or double-spend errors.

---

## Repo Structure

```
satstreamr/                      # This repository
  frontend/                      # Vite + TypeScript browser app
    src/                         #   Source modules (wallet, datachannel, signaling)
    tutor.html                   #   Tutor entry point
    viewer.html                  #   Viewer entry point
    .env.example                 #   Frontend environment variable template
  infra/                         # Docker Compose, mint, and TURN config
    docker-compose.yml           #   bitcoind + lnd_mint + lnd_customer
    bootstrap-regtest.sh         #   Idempotent regtest network setup script
    nutshell.env.example         #   Mint environment variable template
    coturn.env.example           #   Coturn environment variable template
    start-mint.sh                #   Starts the Nutshell mint
    start-coturn.sh              #   Starts the Coturn TURN server
    lnd-mint-creds/              #   Auto-generated by bootstrap script (git-ignored)
  planning/                      # Unit plans and STATUS.md

satstreamr-signaling/            # Separate repository
  signaling/                     # WebSocket signaling server (Node.js + ws)
    src/server.ts                #   Server entry point
    test/                        #   Jest test suite (10 tests)
    package.json
```

---

## Payment Flow

1. **Mint:** The viewer's browser mints a batch of Cashu tokens against the Nutshell mint, paying the mint invoice via the `lnd_customer` Lightning node.
2. **Lock:** Each token is locked to the tutor's public key using NUT-11 P2PK so only the tutor can redeem it.
3. **Send:** The payment scheduler sends one locked token per interval (~10 s) over the WebRTC data channel.
4. **Redeem:** The tutor's browser redeems the received token against the mint, converting it to a fresh unspent proof stored in browser memory.
5. **Acknowledge:** The tutor sends a data-channel acknowledgement back to the viewer. If no ACK arrives within the timeout, the viewer pauses the stream.
6. **Cash-out:** The tutor can sweep accumulated proofs to a Lightning invoice at any time using the cash-out UI.

---

## Troubleshooting

**ICE stuck in "checking" — stream never starts**
Coturn is not running or `TURN_SHARED_SECRET` in the signaling server does not match `coturn.env`. Verify `bash infra/start-coturn.sh` is running and both processes use the same secret.

**Mint returns HTTP 500 on mint/melt requests**
`lnd_mint` is not connected or has no channel balance. Run `docker exec lnd_mint lncli --network=regtest getinfo` to check sync state and `listchannels` to verify an active channel exists. Re-run `bash infra/bootstrap-regtest.sh` if needed.

**Data channel never opens**
A firewall is blocking direct WebRTC traffic and the TURN relay is also unreachable. Ensure UDP port 3478 is accessible from both browser tabs. On a single machine this is loopback — verify coturn is actually running.

**Double-spend error on first payment after a page reload**
Stale proof state in `sessionStorage` from a previous session. Open DevTools > Application > Session Storage, clear the `satstreamr-*` keys, then reload.

**WebSocket disconnects and does not reconnect on mobile**
Chrome and Safari on mobile aggressively suspend background tabs. The signaling client uses exponential backoff reconnection, but a fully frozen tab cannot execute JavaScript. Keep the browser tab in the foreground during a session.

**`start-mint.sh` fails with "No such file or directory: nutshell-venv/bin/mint"**
The Python virtual environment has not been created. See Step 2 for the `python3 -m venv` and `pip install cashu==0.19.2` commands.

---

## Known Limitations (MVP)

- **Regtest only.** No mainnet or testnet support; the Lightning stack is a local Docker network.
- **Single viewer per session.** The signaling protocol supports exactly one tutor and one viewer per room.
- **No authentication.** Any client can join any room by knowing the room ID.
- **Coturn has no TLS.** The TURN server runs with `--no-tls --no-dtls`. Do not expose it to the public internet.
- **LND invoice 600-second TTL.** LND invoices expire after 600 seconds by default. If the viewer does not pay the mint invoice within 10 minutes the mint request will fail.
- **Single hardcoded mint.** Both tutor and viewer must use the same mint URL. The frontend enforces this and shows a blocking overlay on mismatch.
- **No session recording.** Screen/video recording is a post-MVP feature.
- **iOS Safari not supported.** WebRTC data channel behaviour on iOS Safari is incompatible with the current token delivery implementation.

---

## License

MIT
