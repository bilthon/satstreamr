/**
 * config.ts
 *
 * Shared runtime configuration helpers for satstreamr.
 *
 * Each helper follows the same pattern as getSignalingUrl() in the page
 * scripts: prefer an explicit Vite env variable (for production or custom
 * setups), and fall back to a path-based proxy so the app works on both
 * localhost and LAN without any manual configuration.
 */

/**
 * Returns the Cashu mint base URL.
 *
 * Resolution order:
 *   1. VITE_MINT_URL env var — set explicitly for production or a non-default
 *      host/port.
 *   2. `${window.location.origin}/mint` — routes through the Vite dev-server
 *      proxy (path rewrite strips `/mint` before forwarding to the real mint
 *      at http://localhost:3338).  This works for both localhost and LAN
 *      devices because the returned URL is always fully qualified with the
 *      current origin.
 *
 * The cashu-ts CashuMint / CashuWallet constructors receive the full URL, so
 * both forms are valid for library construction.
 */
export function getMintUrl(): string {
  const env = import.meta.env['VITE_MINT_URL'] as string | undefined;
  if (env) return env;
  return `${window.location.origin}/mint`;
}
