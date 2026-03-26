#!/usr/bin/env bash
# bootstrap-regtest.sh — idempotent regtest network bootstrap
# Safe to run multiple times; skips steps already completed.
set -euo pipefail

BITCOIN_CLI="docker exec bitcoind bitcoin-cli -regtest -rpcuser=regtest -rpcpassword=regtest"
LND_MINT="docker exec lnd_mint lncli --network=regtest"
LND_CUSTOMER="docker exec lnd_customer lncli --network=regtest"

wait_for_lnd_balance() {
  local node_label="$1"
  local lncli_cmd="$2"
  local attempts=0
  echo "  Waiting for $node_label to report confirmed balance..."
  while true; do
    BAL=$($lncli_cmd walletbalance 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d.get('confirmed_balance','0')))" 2>/dev/null || echo 0)
    if [ "$BAL" -gt 0 ]; then
      echo "  $node_label confirmed balance: $BAL sat"
      return 0
    fi
    attempts=$((attempts+1))
    if [ $attempts -ge 60 ]; then
      echo "  Timeout waiting for $node_label balance after 120s"
      return 1
    fi
    sleep 2
  done
}

# ── 1. Wait for bitcoind RPC ─────────────────────────────────────────────────
echo "[1/7] Waiting for bitcoind RPC..."
until $BITCOIN_CLI -getinfo >/dev/null 2>&1; do
  echo "  bitcoind not ready — retrying in 2s..."
  sleep 2
done
echo "  bitcoind ready."

# ── 1b. Ensure mining wallet exists (Bitcoin Core 27+ no longer auto-creates) ─
echo "[1b/7] Ensuring 'default' wallet exists..."
LOADED=$($BITCOIN_CLI listwallets 2>/dev/null | python3 -c "import sys,json; print('default' in json.load(sys.stdin))" 2>/dev/null || echo "False")
if [ "$LOADED" = "True" ]; then
  echo "  Wallet 'default' already loaded."
else
  $BITCOIN_CLI loadwallet "default" 2>/dev/null || $BITCOIN_CLI createwallet "default" 2>/dev/null || true
  echo "  Wallet 'default' ready."
fi

# ── 2. Wait for LND nodes ────────────────────────────────────────────────────
echo "[2/7] Waiting for lnd_mint..."
until $LND_MINT getinfo >/dev/null 2>&1; do
  echo "  lnd_mint not ready — retrying in 2s..."
  sleep 2
done
echo "  lnd_mint ready."

echo "[2/7] Waiting for lnd_customer..."
until $LND_CUSTOMER getinfo >/dev/null 2>&1; do
  echo "  lnd_customer not ready — retrying in 2s..."
  sleep 2
done
echo "  lnd_customer ready."

# ── 3. Mine initial blocks for chain maturity ────────────────────────────────
echo "[3/7] Checking block height..."
BLOCK_COUNT=$($BITCOIN_CLI getblockcount)
echo "  Current block count: $BLOCK_COUNT"
if [ "$BLOCK_COUNT" -lt 101 ]; then
  echo "  Mining 101 blocks to a fresh bitcoind address..."
  MINING_ADDR=$($BITCOIN_CLI getnewaddress)
  $BITCOIN_CLI generatetoaddress 101 "$MINING_ADDR" >/dev/null
  BLOCK_COUNT=$($BITCOIN_CLI getblockcount)
  echo "  Block count now: $BLOCK_COUNT"
else
  echo "  Already have $BLOCK_COUNT blocks — skipping initial mine."
fi

# ── 4. Fund lnd_mint ─────────────────────────────────────────────────────────
echo "[4/7] Checking lnd_mint on-chain balance..."
MINT_BALANCE=$($LND_MINT walletbalance 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d.get('confirmed_balance','0')))")
if [ "$MINT_BALANCE" -le 0 ]; then
  echo "  lnd_mint balance is zero — funding..."
  MINT_ADDR=$($LND_MINT newaddress p2wkh | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
  echo "  Mining 10 blocks to lnd_mint address $MINT_ADDR"
  $BITCOIN_CLI generatetoaddress 10 "$MINT_ADDR" >/dev/null
  echo "  Mining 100 more blocks for coinbase maturity..."
  DUMMY_ADDR=$($BITCOIN_CLI getnewaddress)
  $BITCOIN_CLI generatetoaddress 100 "$DUMMY_ADDR" >/dev/null
  wait_for_lnd_balance "lnd_mint" "$LND_MINT"
else
  echo "  lnd_mint already funded ($MINT_BALANCE sat) — skipping."
fi

echo "[4/7] Checking lnd_customer on-chain balance..."
CUST_BALANCE=$($LND_CUSTOMER walletbalance 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d.get('confirmed_balance','0')))")
if [ "$CUST_BALANCE" -le 0 ]; then
  echo "  lnd_customer balance is zero — funding..."
  CUST_ADDR=$($LND_CUSTOMER newaddress p2wkh | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
  echo "  Mining 10 blocks to lnd_customer address $CUST_ADDR"
  $BITCOIN_CLI generatetoaddress 10 "$CUST_ADDR" >/dev/null
  echo "  Mining 100 more blocks for coinbase maturity..."
  DUMMY_ADDR=$($BITCOIN_CLI getnewaddress)
  $BITCOIN_CLI generatetoaddress 100 "$DUMMY_ADDR" >/dev/null
  wait_for_lnd_balance "lnd_customer" "$LND_CUSTOMER"
else
  echo "  lnd_customer already funded ($CUST_BALANCE sat) — skipping."
fi

# ── 5. Open channel lnd_mint → lnd_customer ──────────────────────────────────
echo "[5/7] Checking channel state..."
CHANNEL_COUNT=$($LND_MINT listchannels | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('channels',[])))")
PENDING_COUNT=$($LND_MINT pendingchannels | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('pending_open_channels',[])))")

if [ "$CHANNEL_COUNT" -gt 0 ]; then
  echo "  Channel already exists ($CHANNEL_COUNT active) — skipping channel open."
elif [ "$PENDING_COUNT" -gt 0 ]; then
  echo "  Channel pending — mining 6 blocks to confirm..."
  DUMMY_ADDR=$($BITCOIN_CLI getnewaddress)
  $BITCOIN_CLI generatetoaddress 6 "$DUMMY_ADDR" >/dev/null
else
  echo "  No channels found — opening channel..."
  CUST_PUBKEY=$($LND_CUSTOMER getinfo | python3 -c "import sys,json; print(json.load(sys.stdin)['identity_pubkey'])")
  echo "  lnd_customer pubkey: $CUST_PUBKEY"

  # Connect lnd_mint → lnd_customer (ignore error if already connected)
  $LND_MINT connect "${CUST_PUBKEY}@lnd_customer:9735" 2>/dev/null || true

  echo "  Opening channel: 1,000,000 sat capacity, 500,000 sat pushed to customer..."
  $LND_MINT openchannel \
    --node_key="$CUST_PUBKEY" \
    --local_amt=1000000 \
    --push_amt=500000

  echo "  Mining 6 blocks to confirm channel..."
  DUMMY_ADDR=$($BITCOIN_CLI getnewaddress)
  $BITCOIN_CLI generatetoaddress 6 "$DUMMY_ADDR" >/dev/null

  # Wait for channel to become active
  echo "  Waiting for channel to become active..."
  for i in $(seq 1 30); do
    CH_ACTIVE=$($LND_MINT listchannels | python3 -c "
import sys, json
data = json.load(sys.stdin)
chs = data.get('channels', [])
print(any(c.get('active') for c in chs))
")
    if [ "$CH_ACTIVE" = "True" ]; then
      echo "  Channel is active."
      break
    fi
    sleep 2
  done
fi

# ── 6. Extract lnd_mint credentials to host ───────────────────────────────────
echo "[6/7] Extracting lnd_mint credentials..."
mkdir -p /home/bilthon/Development/satstreamr/infra/lnd-mint-creds

docker cp lnd_mint:/root/.lnd/tls.cert \
  /home/bilthon/Development/satstreamr/infra/lnd-mint-creds/tls.cert

MACAROON_PATH="/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon"
echo "  Waiting for admin.macaroon..."
until docker exec lnd_mint test -f "$MACAROON_PATH" 2>/dev/null; do
  echo "  macaroon not yet present — waiting 2s..."
  sleep 2
done
docker cp "lnd_mint:${MACAROON_PATH}" \
  /home/bilthon/Development/satstreamr/infra/lnd-mint-creds/admin.macaroon

echo "  Credentials extracted to infra/lnd-mint-creds/"
echo "    tls.cert:       $(ls -lh /home/bilthon/Development/satstreamr/infra/lnd-mint-creds/tls.cert | awk '{print $5}')"
echo "    admin.macaroon: $(ls -lh /home/bilthon/Development/satstreamr/infra/lnd-mint-creds/admin.macaroon | awk '{print $5}')"

# ── 7. Summary ───────────────────────────────────────────────────────────────
echo ""
echo "[7/7] Bootstrap complete."
echo ""
echo "Wallet balances:"
echo "  lnd_mint:     $($LND_MINT walletbalance | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('confirmed_balance','?'), 'sat confirmed')")"
echo "  lnd_customer: $($LND_CUSTOMER walletbalance | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('confirmed_balance','?'), 'sat confirmed')")"
echo ""
echo "Channels (lnd_mint view):"
$LND_MINT listchannels | python3 -c "
import sys, json
data = json.load(sys.stdin)
channels = data.get('channels', [])
if not channels:
    print('  (none)')
for ch in channels:
    print(f\"  chan_id={ch['chan_id']} active={ch['active']} local={ch['local_balance']} remote={ch['remote_balance']}\")
"
