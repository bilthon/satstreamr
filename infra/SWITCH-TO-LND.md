# Switching from FakeWallet to LndRestWallet

Once Unit 01 (Polar network `p2p-streaming-dev`) is running and `mint-node` has active channels, follow these steps to connect the Nutshell mint to real Lightning.

## Prerequisites

- Polar is running on the laptop with the `p2p-streaming-dev` network active.
- `mint-node` is visible in the Polar UI with at least one open channel.
- `infra/.env.polar` has been created with the LND connection strings (see Unit 01 docs).

## Step 1: Find LND credentials

Polar stores credentials at:

```
~/.polar/networks/<id>/volumes/lnd/mint-node/tls.cert
~/.polar/networks/<id>/volumes/lnd/mint-node/data/chain/bitcoin/regtest/admin.macaroon
```

The REST port for `mint-node` is shown in the Polar UI under the node's **Connect** tab (typically `8081`).

## Step 2: Encode the macaroon as hex

Nutshell expects the admin macaroon as a hex string:

```bash
xxd -p -c 1000 ~/.polar/networks/<id>/volumes/lnd/mint-node/data/chain/bitcoin/regtest/admin.macaroon
```

Copy the single-line output — that is your `MINT_LND_REST_MACAROON` value.

## Step 3: Update infra/nutshell.env

Edit `infra/nutshell.env` and make the following changes:

1. Change the backend line:
   ```
   MINT_BACKEND_BOLT11_SAT=LndRestWallet
   ```
   (Remove or comment out the `FakeWallet` line.)

2. Add LND connection variables:
   ```
   MINT_LND_REST_ENDPOINT=https://127.0.0.1:8081
   MINT_LND_REST_CERT=/path/to/.polar/networks/<id>/volumes/lnd/mint-node/tls.cert
   MINT_LND_REST_MACAROON=<hex string from step 2>
   ```

   > Note: Nutshell 0.19.x uses the `MINT_LND_REST_*` prefix. Double-check
   > `infra/nutshell-venv/lib/python*/site-packages/cashu/core/settings.py`
   > for the exact env var names if the mint fails to start.

## Step 4: Restart the mint

```bash
bash infra/start-mint.sh
```

Verify the mint is connected to LND by checking the info endpoint:

```bash
curl -s http://localhost:3338/v1/info | jq .
```

The response should still include `"pubkey"` and the full `"nuts"` list. The mint keyset (`MINT_PRIVATE_KEY`) must remain unchanged — regenerating it invalidates all previously issued tokens.

## Troubleshooting

- **TLS errors**: Ensure the path to `tls.cert` is correct and readable.
- **Macaroon errors**: Re-run the `xxd` command and paste a fresh hex string.
- **Connection refused**: Confirm Polar is running and the REST port matches what's in Polar UI.
- **Wrong env var names**: Check `cashu/core/settings.py` in the venv for the authoritative list.
