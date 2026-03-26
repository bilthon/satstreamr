/**
 * test-p2pk.ts
 *
 * NUT-11 P2PK + NUT-12 DLEQ CLI round-trip verification.
 *
 * Steps:
 *   1. Generate a fresh secp256k1 keypair.
 *   2. Query the mint's active keyset to determine input_fee_ppk.
 *   3. Request a mint quote for (PAYLOAD_AMOUNT + fee) sats.
 *   4. Pay the invoice using lnd_customer (docker exec).
 *   5. Mint proofs with P2PK lock to the generated pubkey.
 *   6. Verify DLEQ proofs (NUT-12) on every minted proof.
 *   7. Swap (redeem) the P2PK-locked proofs by signing with the private key.
 *   8. Attempt double-spend — expect the mint to reject it.
 *   9. Exit 0 on full success.
 *
 * Fee note: Nutshell default keyset has input_fee_ppk=100, meaning 1 input
 * costs ceil(100/1000) = 1 sat. We mint (payload + fee) sats so the swap
 * has enough value to cover its own fee and still produce non-zero output.
 */

import { execSync } from 'child_process';
import { CashuMint, CashuWallet, hasValidDleq } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const MINT_URL = 'http://localhost:3338';

// The token value we want to hold after the redemption swap.
const PAYLOAD_AMOUNT = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function payInvoice(bolt11: string): void {
  const cmd = `docker exec lnd_customer lncli --network=regtest payinvoice --force ${bolt11}`;
  execSync(cmd, { stdio: 'pipe', timeout: 30_000 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calculate NUT-02 input fee: ceil(n_inputs * fee_ppk / 1000) */
function calcFee(nInputs: number, feePpk: number): number {
  return Math.ceil((nInputs * feePpk) / 1000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- Step 1: Generate keypair ---
  const { secretKey: privkeyBytes, publicKey: pubkeyBytes } = secp256k1.keygen();
  const privkeyHex = bytesToHex(privkeyBytes);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  console.log(`Keypair generated`);
  console.log(`  pubkey : ${pubkeyHex}`);
  console.log(`  privkey: ${privkeyHex}`);

  // --- Step 2: Connect to mint and load keys ---
  const mint = new CashuMint(MINT_URL);
  const wallet = new CashuWallet(mint, { unit: 'sat' });
  await wallet.loadMint();

  const activeKeyset = wallet.keysets.find((ks) => ks.active && ks.unit === 'sat');
  if (!activeKeyset) {
    throw new Error('No active sat keyset found on mint');
  }
  const mintKeys = await wallet.getKeys(activeKeyset.id);
  const feePpk = activeKeyset.input_fee_ppk ?? 0;
  console.log(`Connected to mint: ${MINT_URL}`);
  console.log(`  active keyset  : ${activeKeyset.id}`);
  console.log(`  input_fee_ppk  : ${feePpk}`);

  // We will mint one P2PK-locked proof. When we swap it, that's 1 input.
  // The swap output must be non-zero: total = PAYLOAD_AMOUNT + fee.
  const swapFee = calcFee(1, feePpk);
  const mintAmount = PAYLOAD_AMOUNT + swapFee;
  console.log(`  swap fee (1 input): ${swapFee} sat`);
  console.log(`  mint amount needed: ${mintAmount} sat`);

  // --- Step 3: Request mint quote ---
  console.log(`\nRequesting mint quote for ${mintAmount} sat...`);
  const mintQuote = await wallet.createMintQuote(mintAmount);
  console.log(`  quote id : ${mintQuote.quote}`);
  console.log(`  invoice  : ${mintQuote.request}`);

  // --- Step 4: Pay the invoice via lnd_customer ---
  console.log(`\nPaying invoice via lnd_customer...`);
  payInvoice(mintQuote.request);
  console.log(`  Invoice paid.`);

  // Wait for mint to process the payment
  await sleep(1500);

  let quoteState = await wallet.checkMintQuote(mintQuote.quote);
  let attempts = 0;
  while (quoteState.state !== 'PAID' && quoteState.state !== 'ISSUED' && attempts < 10) {
    await sleep(1000);
    quoteState = await wallet.checkMintQuote(mintQuote.quote);
    attempts++;
  }
  console.log(`  Quote state: ${quoteState.state}`);
  if (quoteState.state !== 'PAID' && quoteState.state !== 'ISSUED') {
    throw new Error(`Quote did not become PAID after payment. State: ${quoteState.state}`);
  }

  // --- Step 5: Mint P2PK-locked proofs ---
  console.log(`\nMinting ${mintAmount} sat P2PK-locked to pubkey...`);
  const lockedProofs = await wallet.mintProofs(mintAmount, mintQuote.quote, {
    p2pk: { pubkey: pubkeyHex },
  });

  if (!lockedProofs || lockedProofs.length === 0) {
    throw new Error('mintProofs returned empty proof array');
  }

  const lockedTotal = lockedProofs.reduce((s, p) => s + p.amount, 0);
  console.log(`  Minted ${lockedProofs.length} proof(s), total ${lockedTotal} sat:`);
  for (const p of lockedProofs) {
    console.log(`    amount=${p.amount}  id=${p.id}  secret=${p.secret.slice(0, 50)}...`);
  }

  console.log(`\nMINT OK — token locked to pubkey: ${pubkeyHex}`);

  // --- Step 6: Verify DLEQ proofs (NUT-12) ---
  console.log(`\nVerifying DLEQ proofs...`);
  let dleqFailed = false;
  for (const proof of lockedProofs) {
    if (proof.dleq) {
      const valid = hasValidDleq(proof, mintKeys);
      if (!valid) {
        console.error(`  DLEQ INVALID for proof amount=${proof.amount}`);
        dleqFailed = true;
      } else {
        console.log(`  DLEQ valid for proof amount=${proof.amount}`);
      }
    } else {
      console.log(`  Proof amount=${proof.amount}: no DLEQ data in response`);
    }
  }
  if (dleqFailed) {
    console.error('DLEQ verification FAILED — exiting 1');
    process.exit(1);
  }
  console.log(`DLEQ OK`);

  // --- Step 7: Redeem (swap) P2PK-locked proofs using the private key ---
  // We swap the full locked amount. The swap fee is deducted automatically;
  // we request PAYLOAD_AMOUNT out so the balance checks out:
  //   sum(inputs) - fee == sum(outputs)
  //   mintAmount - swapFee == PAYLOAD_AMOUNT  ✓
  console.log(`\nRedeeming P2PK-locked proof using private key...`);
  const swapResult = await wallet.swap(PAYLOAD_AMOUNT, lockedProofs, {
    privkey: privkeyHex,
  });
  const redeemedProofs = [...swapResult.keep, ...swapResult.send];

  if (!redeemedProofs || redeemedProofs.length === 0) {
    throw new Error('swap returned empty proofs — redemption failed');
  }
  const redeemedTotal = redeemedProofs.reduce((s, p) => s + p.amount, 0);
  console.log(`  Redeemed ${redeemedProofs.length} proof(s) totalling ${redeemedTotal} sat`);
  console.log(`REDEEM OK`);

  // --- Step 8: Attempt double-spend ---
  console.log(`\nAttempting double-spend with already-spent proof...`);
  try {
    await wallet.swap(PAYLOAD_AMOUNT, lockedProofs, {
      privkey: privkeyHex,
    });
    // Mint accepted the double-spend — this is a mint bug
    console.error(`ERROR: double-spend was accepted — this is a mint bug`);
    process.exit(1);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`DOUBLE-SPEND DETECTED: ${message}`);
  }

  console.log(`\nAll checks passed. Exiting 0.`);
}

main().catch((err: unknown) => {
  console.error(`FATAL:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
