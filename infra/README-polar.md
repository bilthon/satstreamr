# Polar Regtest Network Setup

This document explains how to stand up the local Lightning regtest environment used by satstreamr. All payment flows depend on this network being running before starting any application services.

## Prerequisites

- [Polar](https://lightningpolar.com/) installed (v2.x or later recommended)
- Docker Desktop installed and **running** before you open Polar

---

## Option A: Import an existing network (after first export)

Once a developer has completed the manual setup (Option B) and committed `infra/polar-network.json`, subsequent developers can import it directly.

1. Open Polar.
2. Go to **File > Import Network**.
3. Select `infra/polar-network.json` from this repository.
4. Polar recreates the network topology. Click **Start** to launch the containers.
5. Skip to [Fill in credentials](#fill-in-credentials) below.

---

## Option B: Create the network from scratch

Follow these steps the first time, or whenever the exported file is not yet available.

### 1. Create the network

1. Open Polar.
2. Click **Create Network**.
3. Set the network name to `p2p-streaming-dev`.
4. Add two LND nodes. Rename them:
   - `mint-node`
   - `customer-node`
5. Click **Start**. Polar pulls Docker images, mines the regtest genesis block, and funds both nodes with on-chain balance automatically. Wait until both nodes show a green status indicator.

### 2. Open a balanced channel

1. In the Polar canvas, click **mint-node**.
2. In the node panel, go to **Actions > Open Channel**.
3. Fill in the form:
   - **To:** `customer-node`
   - **Capacity:** `10000000` sat
   - **Push Amount:** `5000000` sat
4. Click **Open Channel**. Polar mines 6 confirmation blocks automatically.
5. Verify in the Polar canvas that the channel appears as active between the two nodes.
   - `mint-node` should show ~5,000,000 sat outbound (used for Cashu peg-out)
   - `customer-node` should show ~5,000,000 sat outbound toward mint (used for Cashu peg-in)

### 3. Export the network topology

1. Go to **File > Export Network**.
2. Save the file as `infra/polar-network.json` in this repository.
3. Commit the file so other developers can use Option A.

---

## Fill in credentials

### Locate the credential files

Polar exposes LND credential files on the host filesystem at:

```
~/.polar/networks/<network-id>/volumes/lnd/mint-node/
  tls.cert
  data/chain/bitcoin/regtest/admin.macaroon
```

Replace `<network-id>` with the numeric ID shown in the Polar URL or directory listing:

```bash
ls ~/.polar/networks/
```

### Find the REST port

In Polar, click **mint-node** and open the **Connect** tab. Note the **REST Host** port (e.g. `8081`).

### Create infra/.env.polar

Copy the example template and fill in your values:

```bash
cp infra/.env.polar.example infra/.env.polar
```

Edit `infra/.env.polar`:

```env
MINT_LND_REST_ENDPOINT=https://127.0.0.1:8081
MINT_LND_TLS_CERT_PATH=/Users/<you>/.polar/networks/<id>/volumes/lnd/mint-node/tls.cert
MINT_LND_MACAROON_PATH=/Users/<you>/.polar/networks/<id>/volumes/lnd/mint-node/data/chain/bitcoin/regtest/admin.macaroon
```

`infra/.env.polar` is gitignored and must never be committed.

### Extract the macaroon as hex (if required by the application)

Some services expect the admin macaroon as a hex string rather than a file path. Extract it with:

```bash
xxd -p -c 1000 ~/.polar/networks/<id>/volumes/lnd/mint-node/data/chain/bitcoin/regtest/admin.macaroon
```

Copy the single-line hex output into whichever environment variable requires it.

---

## Verification checklist

- [ ] Both `mint-node` and `customer-node` show green status in Polar UI
- [ ] Each node has a non-zero on-chain balance
- [ ] One active channel exists between the two nodes with 10,000,000 sat total capacity
- [ ] `infra/.env.polar` exists locally and contains all three variables with real paths/ports
- [ ] `infra/polar-network.json` has been exported and committed (or is the placeholder)

---

## Stopping and restarting

- **Stop:** Click **Stop** in Polar. Containers are paused; channel state is preserved.
- **Restart:** Click **Start**. Nodes resume from their saved state.
- **Reset:** Delete the network in Polar and repeat Option B if you need a clean slate.
