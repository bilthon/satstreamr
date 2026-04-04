/**
 * deposit.test.ts
 *
 * Unit tests for the deposit flow (deposit.ts).
 *
 * All network and wallet interactions are mocked — no live mint or Lightning
 * node is required.
 *
 * Mocking strategy:
 *  - `fetch` is replaced with a vi.fn() on globalThis.
 *  - `cashu-wallet.ts` is mocked via vi.mock() so that buildWallet() returns a
 *    controllable stub.
 *  - `wallet-store.ts` is mocked so addProofs() can be observed without
 *    touching localStorage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Proof } from '@cashu/cashu-ts';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the modules under test so
// that vitest hoists them before the module graph is resolved.
// ---------------------------------------------------------------------------

// Mock cashu-wallet so buildWallet() never hits the network.
vi.mock('./cashu-wallet.js', () => ({
  buildWallet: vi.fn(),
}));

// Mock wallet-store so addProofs() is observable.
vi.mock('./wallet-store.js', () => ({
  addProofs: vi.fn(),
}));

// Now import the module under test and its mocked dependencies.
import {
  requestMintQuote,
  checkMintQuote,
  pollForPayment,
  mintProofsFromQuote,
} from './deposit.js';
import { buildWallet } from './cashu-wallet.js';
import { addProofs } from './wallet-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal Proof-like object. */
function makeProof(amount: number): Proof {
  return {
    amount,
    secret: `secret-${amount}-${Math.random()}`,
    C: 'mock-C',
    id: 'mock-keyset-id',
  } as unknown as Proof;
}

/**
 * Creates a minimal Response-like object that satisfies what fetch returns
 * without requiring a real Response constructor.
 */
function makeResponse(status: number, body: unknown): Response {
  const bodyText = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const MINT_URL = 'http://localhost:3338';

beforeEach(() => {
  // Provide VITE_MINT_URL via import.meta.env (already set in vite.config.ts
  // test.env, but we set it explicitly here for clarity).
  vi.stubEnv('VITE_MINT_URL', MINT_URL);

  // Reset all mocks between tests.
  vi.resetAllMocks();

  // Install a global fetch mock.
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// requestMintQuote
// ---------------------------------------------------------------------------

describe('requestMintQuote', () => {
  it('makes a POST to /v1/mint/quote/bolt11 with the correct body', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, { quote: 'q1', request: 'lnbcrt...' })
    );

    await requestMintQuote(100);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MINT_URL}/v1/mint/quote/bolt11`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toEqual({ amount: 100, unit: 'sat' });
  });

  it('returns { quote, invoice } from the mint response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(200, { quote: 'abc123', request: 'lnbcrt500n1...' })
    );

    const result = await requestMintQuote(500);

    expect(result.quote).toBe('abc123');
    expect(result.invoice).toBe('lnbcrt500n1...');
  });

  it('throws on a non-200 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(400, { detail: 'bad request' })
    );

    await expect(requestMintQuote(1)).rejects.toThrow(/requestMintQuote failed: HTTP 400/);
  });
});

// ---------------------------------------------------------------------------
// checkMintQuote
// ---------------------------------------------------------------------------

describe('checkMintQuote', () => {
  it('makes a GET request to /v1/mint/quote/bolt11/{quoteId}', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(200, { state: 'UNPAID' })
    );

    await checkMintQuote('quote-xyz');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${MINT_URL}/v1/mint/quote/bolt11/quote-xyz`);
    // GET is the default; no explicit method is set.
    expect(init).toBeUndefined();
  });

  it('returns { paid: false } when state is UNPAID', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(200, { state: 'UNPAID' })
    );

    const result = await checkMintQuote('q1');
    expect(result.paid).toBe(false);
  });

  it('returns { paid: true } when state is PAID', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(200, { state: 'PAID' })
    );

    const result = await checkMintQuote('q1');
    expect(result.paid).toBe(true);
  });

  it('returns { paid: true } when state is ISSUED', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(200, { state: 'ISSUED' })
    );

    const result = await checkMintQuote('q1');
    expect(result.paid).toBe(true);
  });

  it('returns { paid: true } when the legacy paid boolean field is true', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(200, { paid: true, state: 'UNPAID' })
    );

    const result = await checkMintQuote('q1');
    expect(result.paid).toBe(true);
  });

  it('throws on a non-200 response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeResponse(404, { detail: 'not found' })
    );

    await expect(checkMintQuote('bad-quote')).rejects.toThrow(/checkMintQuote failed: HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// pollForPayment
// ---------------------------------------------------------------------------

describe('pollForPayment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true immediately when the first poll returns paid', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeResponse(200, { state: 'PAID' })
    );

    const resultPromise = pollForPayment('q1', { intervalMs: 100, timeoutMs: 5_000 });

    // Let the first async poll tick resolve.
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(true);
  });

  it('resolves true after a few unpaid polls then a paid poll', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);

    // First two polls return unpaid, third returns paid.
    mockFetch
      .mockResolvedValueOnce(makeResponse(200, { state: 'UNPAID' }))
      .mockResolvedValueOnce(makeResponse(200, { state: 'UNPAID' }))
      .mockResolvedValue(makeResponse(200, { state: 'PAID' }));

    const resultPromise = pollForPayment('q1', { intervalMs: 500, timeoutMs: 60_000 });

    // Advance enough time for 3 poll attempts (each 500 ms apart) to fire and
    // for all pending promises to settle.
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(true);

    // We should have called fetch at least 3 times.
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves false when the timeout is exceeded before payment', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeResponse(200, { state: 'UNPAID' })
    );

    const resultPromise = pollForPayment('q1', { intervalMs: 1_000, timeoutMs: 3_000 });

    // Advance past the timeout.
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(false);
  });

  it('swallows transient fetch errors and keeps polling', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);

    // First call throws, second call returns paid.
    mockFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue(makeResponse(200, { state: 'PAID' }));

    const resultPromise = pollForPayment('q1', { intervalMs: 500, timeoutMs: 10_000 });

    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mintProofsFromQuote
// ---------------------------------------------------------------------------

describe('mintProofsFromQuote', () => {
  it('calls wallet.mintProofs with the correct arguments', async () => {
    const mockMintProofs = vi.fn().mockResolvedValue([makeProof(100)]);
    vi.mocked(buildWallet).mockResolvedValue({
      wallet: { mintProofs: mockMintProofs } as unknown as import('@cashu/cashu-ts').CashuWallet,
      mintKeys: {} as unknown as import('../types/cashu.js').MintKeys,
      feePpk: 0,
    });

    await mintProofsFromQuote('quote-abc', 100);

    expect(mockMintProofs).toHaveBeenCalledOnce();
    expect(mockMintProofs).toHaveBeenCalledWith(100, 'quote-abc');
  });

  it('stores the returned proofs in wallet-store via addProofs', async () => {
    const proofs = [makeProof(50), makeProof(50)];
    const mockMintProofs = vi.fn().mockResolvedValue(proofs);
    vi.mocked(buildWallet).mockResolvedValue({
      wallet: { mintProofs: mockMintProofs } as unknown as import('@cashu/cashu-ts').CashuWallet,
      mintKeys: {} as unknown as import('../types/cashu.js').MintKeys,
      feePpk: 0,
    });

    await mintProofsFromQuote('quote-def', 100);

    expect(vi.mocked(addProofs)).toHaveBeenCalledOnce();
    expect(vi.mocked(addProofs)).toHaveBeenCalledWith(proofs);
  });

  it('returns the newly minted proofs', async () => {
    const proofs = [makeProof(200)];
    const mockMintProofs = vi.fn().mockResolvedValue(proofs);
    vi.mocked(buildWallet).mockResolvedValue({
      wallet: { mintProofs: mockMintProofs } as unknown as import('@cashu/cashu-ts').CashuWallet,
      mintKeys: {} as unknown as import('../types/cashu.js').MintKeys,
      feePpk: 0,
    });

    const result = await mintProofsFromQuote('quote-ghi', 200);

    expect(result).toEqual(proofs);
  });

  it('throws when mintProofs returns an empty array', async () => {
    const mockMintProofs = vi.fn().mockResolvedValue([]);
    vi.mocked(buildWallet).mockResolvedValue({
      wallet: { mintProofs: mockMintProofs } as unknown as import('@cashu/cashu-ts').CashuWallet,
      mintKeys: {} as unknown as import('../types/cashu.js').MintKeys,
      feePpk: 0,
    });

    await expect(mintProofsFromQuote('quote-empty', 100)).rejects.toThrow(
      /mintProofs returned an empty proof array/
    );
  });

  it('does not call addProofs when mintProofs throws', async () => {
    const mockMintProofs = vi.fn().mockRejectedValue(new Error('mint error'));
    vi.mocked(buildWallet).mockResolvedValue({
      wallet: { mintProofs: mockMintProofs } as unknown as import('@cashu/cashu-ts').CashuWallet,
      mintKeys: {} as unknown as import('../types/cashu.js').MintKeys,
      feePpk: 0,
    });

    await expect(mintProofsFromQuote('quote-fail', 100)).rejects.toThrow();
    expect(vi.mocked(addProofs)).not.toHaveBeenCalled();
  });
});
