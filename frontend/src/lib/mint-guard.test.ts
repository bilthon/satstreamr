import { describe, it, expect, vi } from 'vitest';
import { assertSameMint, MintMismatchError } from './mint-guard.js';

describe('assertSameMint', () => {
  it('does not throw when both URLs are identical', () => {
    vi.stubEnv('VITE_MINT_URL', 'http://localhost:3338');
    expect(() => assertSameMint('http://localhost:3338')).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('does not throw when URLs differ only by trailing slash', () => {
    vi.stubEnv('VITE_MINT_URL', 'http://localhost:3338');
    expect(() => assertSameMint('http://localhost:3338/')).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('throws MintMismatchError when hosts differ', () => {
    vi.stubEnv('VITE_MINT_URL', 'http://localhost:3338');
    expect(() => assertSameMint('http://other-mint.example.com:3338')).toThrow(MintMismatchError);
    vi.unstubAllEnvs();
  });
});
