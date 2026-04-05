import { getMintUrl } from './config.js';

export class MintMismatchError extends Error {
  constructor(public sessionMintUrl: string, public localMintUrl: string) {
    super(`Mint mismatch. Session requires: ${sessionMintUrl}. Local: ${localMintUrl}`);
    this.name = 'MintMismatchError';
  }
}

function normalize(url: string): string {
  // Use new URL(url).href for canonical form (lowercases scheme/host, adds trailing slash)
  // then strip the trailing slash for comparison so both forms are treated equal.
  return new URL(url).href.replace(/\/$/, '');
}

export function assertSameMint(sessionMintUrl: string): void {
  const local = getMintUrl();
  if (normalize(sessionMintUrl) !== normalize(local)) {
    throw new MintMismatchError(sessionMintUrl, local);
  }
}
