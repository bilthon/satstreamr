# Unit 02: Nutshell Cashu Mint Setup

## Summary
Install the Nutshell Python Cashu mint, connect it to the `mint-node` LND container from the Polar network in Unit 01 via LND REST API, and verify it can issue and redeem tokens. This unit establishes the single hardcoded mint for the entire developer preview. It also covers running the mint as a persistent background process that survives terminal closes.

## Prerequisites
- Unit 01 complete: Polar network `p2p-streaming-dev` running, `mint-node` showing active channels in Polar UI.
- `infra/.env.polar` file exists with LND connection strings.
- Python 3.11+ available (`python3 --version` or `python3.11 --version`)
- `jq` installed: `brew install jq` (macOS) or `sudo apt install jq` (Linux)

## Deliverables

1. Nutshell installed in a Python virtual environment at `infra/nutshell-venv/`.
   - Verification: `infra/nutshell-venv/bin/mint --version` prints a version string without errors.

2. Nutshell config file `infra/nutshell.env` created with correct LND REST connection, TLS cert path, macaroon, and port 3338.
   - Verification: File exists and contains `MINT_BACKEND_BOLT11_SAT=LndRestWallet`, `LND_REST_ENDPOINT`, `LND_CERT`, `LND_MACAROON`.

3. Mint starts and info endpoint responds.
   - Verification:
     ```bash
     curl http://localhost:3338/v1/info
     ```
     Returns JSON with `"pubkey"` and `"nuts"` fields.

4. NUT-07, NUT-11, and NUT-12 confirmed present in mint info.
   - Verification:
     ```bash
     curl -s http://localhost:3338/v1/info | jq '.nuts | keys'
     ```
     Output includes `"7"`, `"11"`, `"12"`.

5. Mint public key recorded in `infra/mint-pubkey.txt`.
   - Verification: File contains a 66-character hex string.

6. Startup script `infra/start-mint.sh` available for foreground/dev use.
   - Verification: `bash infra/start-mint.sh` starts the mint in the foreground with log output visible.

7. Pinned dependency file committed.
   - Verification: `infra/requirements-mint.txt` exists with `cashu==<version>` pinned.

## Implementation Notes

### Install sequence (macOS / Linux)

```bash
cd infra
python3 -m venv nutshell-venv
source nutshell-venv/bin/activate
pip install --upgrade pip wheel
pip install cashu
```

On Linux (including Raspberry Pi if you ever test there), `pip install cashu` builds native extensions. Install system deps first:
```bash
sudo apt-get install -y build-essential pkg-config libssl-dev libffi-dev libsecp256k1-dev python3-dev
```

Pin the version once install succeeds:
```bash
pip freeze | grep cashu >> requirements-mint.txt
```

### Connecting to Polar's LND node

The `mint-node` REST port is shown in Polar UI under the node's **Connect** tab (typically `8081`). Polar stores credentials at:

```
~/.polar/networks/<id>/volumes/lnd/mint-node/tls.cert
~/.polar/networks/<id>/volumes/lnd/mint-node/data/chain/bitcoin/regtest/admin.macaroon
```

**Macaroon encoding**: Nutshell expects the macaroon as a hex string. Extract it:

```bash
xxd -p -c 1000 ~/.polar/networks/<id>/volumes/lnd/mint-node/data/chain/bitcoin/regtest/admin.macaroon
```

Copy the single-line output into `nutshell.env` as `LND_MACAROON=<hex>`.

Alternatively, some Nutshell versions accept `LND_MACAROON_PATH` pointing to the binary file. Check `cashu/core/settings.py` in your installed version to confirm the correct env var name.

### Full nutshell.env template

```env
MINT_BACKEND_BOLT11_SAT=LndRestWallet
LND_REST_ENDPOINT=https://127.0.0.1:8081
LND_CERT=/Users/<you>/.polar/networks/<id>/volumes/lnd/mint-node/tls.cert
LND_MACAROON=<hex string from xxd>
MINT_URL=http://127.0.0.1:3338
MINT_PORT=3338
MINT_HOST=0.0.0.0
MINT_PRIVATE_KEY=<openssl rand -hex 32>
```

`MINT_PRIVATE_KEY` is required — generate once and keep it stable. It derives the mint's keyset. Changing it invalidates all previously issued tokens.

### start-mint.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/nutshell.env"; set +a
exec "$SCRIPT_DIR/nutshell-venv/bin/mint"
```

Make executable: `chmod +x infra/start-mint.sh`

### Recording the mint public key

After the mint starts, capture its pubkey for use in Unit 03 and beyond:

```bash
curl -s http://localhost:3338/v1/info | jq -r '.pubkey' > infra/mint-pubkey.txt
```

### FakeWallet escape hatch

If Polar is stopped or Unit 01 is not yet complete, the mint can run without any Lightning backend for isolated Cashu flow testing:

```env
MINT_BACKEND_BOLT11_SAT=FakeWallet
```

In FakeWallet mode, the mint issues tokens without real Lightning invoices — useful for testing NUT-07/11/12 in Unit 03 before the full Polar network is up. Switch back to `LndRestWallet` before any end-to-end payment tests.

### Security note

`infra/nutshell.env` contains the mint private key and LND admin macaroon. Add to `.gitignore` — never commit it. Commit only `infra/nutshell.env.example` with placeholder values.

## Files to Create/Modify
- `infra/nutshell.env` — mint environment variables with real secrets (gitignored)
- `infra/nutshell.env.example` — template with placeholder values (committed)
- `infra/requirements-mint.txt` — pinned Nutshell version
- `infra/nutshell-venv/` — Python virtual environment (gitignored)
- `infra/start-mint.sh` — foreground startup script for development
- `infra/mint-pubkey.txt` — recorded mint public key
- `.gitignore` — add `infra/nutshell.env`, `infra/nutshell-venv/`, `infra/cashu-data/`

## Estimated Effort
3–5 hours
