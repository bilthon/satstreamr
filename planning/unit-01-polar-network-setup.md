# Unit 01: Regtest Lightning Network Setup

> **Status: COMPLETE** — Docker Compose approach deployed (headless ARM64 Raspberry Pi).
> The original Polar-based approach has been superseded; Polar requires a GUI and cannot
> run headlessly on the Pi. All deliverables below are met via Docker Compose.

## Summary

Stand up a regtest Bitcoin/LND environment with two funded LND nodes and an open channel
between them. This is the foundational Bitcoin layer that all subsequent payment flows
depend on. Without a working channel and confirmed inbound liquidity on the mint side, no
Lightning-based Cashu operations can be tested.

## Environment

- **Platform**: Raspberry Pi 4, ARM64, Linux (headless, SSH only)
- **Docker**: v29.2.1 with Docker Compose v5 plugin (`docker compose`)
- **Bitcoin Core image**: `lncm/bitcoind:v27.0` (native ARM64, Docker Hub)
- **LND image**: `lightninglabs/lnd:v0.18.5-beta` (native ARM64, Docker Hub)
- **Network**: `bitcoind`, `lnd_mint`, `lnd_customer` on a shared Docker bridge network

## Files Created

| File | Purpose | Committed? |
|------|---------|------------|
| `infra/docker-compose.yml` | Three-service stack definition | Yes |
| `infra/bootstrap-regtest.sh` | Idempotent chain + channel bootstrap | Yes |
| `infra/.env.lnd.example` | Template for LND connection vars | Yes |
| `infra/.env.lnd` | Actual LND connection vars for Nutshell | No (gitignored) |
| `infra/lnd-mint-creds/tls.cert` | TLS cert for lnd_mint REST API | No (gitignored) |
| `infra/lnd-mint-creds/admin.macaroon` | Admin macaroon for lnd_mint | No (gitignored) |

## Deliverables

### 1. Regtest network running with two LND nodes

Services started via:
```bash
cd infra/
docker compose up -d
```

Three containers: `bitcoind`, `lnd_mint`, `lnd_customer` — all healthy.

- `lnd_mint` REST: `https://127.0.0.1:8081` (TLS, macaroon auth)
- `lnd_customer` REST: `https://127.0.0.1:8082`
- `lnd_mint` gRPC: `127.0.0.1:10009`
- `lnd_customer` gRPC: `127.0.0.1:10010`

### 2. Regtest chain bootstrapped, both nodes funded

Bootstrap script handles:
1. Creates Bitcoin Core `default` wallet (required since Core 27+)
2. Mines 101 blocks for initial chain maturity
3. Mines 10 blocks to each LND node + 100 maturity blocks (coinbase requires 100 confirmations)
4. Waits for LND nodes to report confirmed balance

Confirmed balances after bootstrap:
- `lnd_mint`: ~99,998,991,763 sat (on-chain)
- `lnd_customer`: ~50,000,000,000 sat (on-chain)

### 3. Channel open between nodes

Channel opened from `lnd_mint` → `lnd_customer`:
- Capacity: 1,000,000 sat
- Pushed to `lnd_customer`: 500,000 sat
- Channel type: ANCHORS (default for LND v0.18)
- Status: `active: true`
- `lnd_mint` local balance: ~496,530 sat (after channel reserve and commit fee)
- `lnd_customer` remote balance: 500,000 sat

Bootstrap is idempotent — running it again skips any steps already complete.

### 4. LND connection details extracted

```bash
infra/lnd-mint-creds/tls.cert        # TLS cert for lnd_mint REST API
infra/lnd-mint-creds/admin.macaroon  # Admin macaroon (binary)
infra/.env.lnd                       # LND connection env vars for Nutshell
```

### 5. Nutshell mint switched to LndRestWallet

`infra/nutshell.env` updated:
- `MINT_BACKEND_BOLT11_SAT=LndRestWallet`
- `MINT_LND_REST_ENDPOINT=https://127.0.0.1:8081`
- `MINT_LND_REST_CERT=...infra/lnd-mint-creds/tls.cert`
- `MINT_LND_REST_MACAROON=<hex>`

Mint running and responding at `http://localhost:3338/v1/info` with NUT-4 and NUT-5
bolt11/sat enabled, confirming real Lightning connectivity.

## Quick Start (after cloning)

```bash
cd infra/

# 1. Start the regtest network
docker compose up -d

# 2. Bootstrap chain, fund nodes, open channel, extract creds
bash bootstrap-regtest.sh

# 3. Extract macaroon hex and update nutshell.env
MACAROON_HEX=$(python3 -c "
with open('lnd-mint-creds/admin.macaroon', 'rb') as f:
    print(f.read().hex())
")
# Then update nutshell.env: set LndRestWallet backend and paste the hex

# 4. Start the mint
bash start-mint.sh &

# 5. Verify
curl -s http://localhost:3338/v1/info | python3 -m json.tool
```

## Key Design Decisions

**Why not Polar?** Polar requires a GUI (Electron app). The Pi is accessed headlessly over SSH; no display server is available.

**Why `lncm/bitcoind` instead of `ghcr.io/bitcoin/bitcoin`?** The GitHub Container Registry image returned a `denied` error (likely rate-limiting or auth requirement). `lncm/bitcoind:v27.0` is a well-maintained public Docker Hub image with native ARM64 builds.

**Why mine 100 extra blocks after funding LND nodes?** Bitcoin coinbase outputs have a 100-block maturity requirement before they can be spent. LND refuses to open a channel from immature UTXOs. The bootstrap script mines 10 blocks to each node's address, then 100 dummy blocks to satisfy maturity.

**Why `commitment_type: ANCHORS`?** LND v0.18+ defaults to anchor channels (`option_anchors`). This enables dynamic fee-bumping of commitment transactions via CPFP on the anchor outputs, which is safer for long-running regtest setups.

## Port Reference

| Service | Container Port | Host Port | Protocol |
|---------|---------------|-----------|----------|
| bitcoind | 18443 | 18443 | RPC (regtest) |
| bitcoind | 28332 | 28332 | ZMQ rawblock |
| bitcoind | 28333 | 28333 | ZMQ rawtx |
| lnd_mint | 10009 | 10009 | gRPC |
| lnd_mint | 8080 | 8081 | REST (HTTPS) |
| lnd_customer | 10009 | 10010 | gRPC |
| lnd_customer | 8080 | 8082 | REST (HTTPS) |
| Nutshell mint | 3338 | 3338 | HTTP |

## Troubleshooting

**`not enough witness outputs` when opening channel**: coinbase UTXOs haven't matured. Run the bootstrap script again — it will detect the pending channel state and mine the remaining blocks.

**`lnd_mint` shows 0 balance after funding**: LND needs time to sync after blocks are mined. The bootstrap script polls `walletbalance` until the balance appears (up to 120 seconds).

**TLS errors connecting Nutshell to LND**: ensure `MINT_LND_REST_CERT` points to the correct absolute path and the file is readable by the mint process.

**Mint fails to start with LndRestWallet**: check env var names against `infra/nutshell-venv/lib/python*/site-packages/cashu/core/settings.py` — the authoritative source is `LndRestFundingSource` class fields (prefixed `mint_lnd_rest_*`, uppercased as env vars).
