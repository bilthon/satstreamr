/**
 * session-invite.ts
 *
 * Utilities for encoding and decoding session invite payloads.
 * Invites are base64-encoded JSON objects passed as the `?join=` query param.
 */

export interface InvitePayload {
  sessionId: string;
  rateSatsPerInterval: number;
  intervalSeconds: number;
  mintUrl: string;
}

/**
 * Encode an InvitePayload as a base64 string suitable for use in a URL
 * query parameter.
 */
export function createInvite(payload: InvitePayload): string {
  return btoa(JSON.stringify(payload));
}

/**
 * Build a complete shareable invite URL using the current page origin.
 * Returns a URL of the form: `<origin>/?join=<base64payload>`
 */
export function createInviteUrl(payload: InvitePayload): string {
  const encoded = createInvite(payload);
  return `${window.location.origin}/?join=${encoded}`;
}

/**
 * Decode a base64-encoded invite string produced by `createInvite`.
 * Returns the parsed InvitePayload, or null if decoding or validation fails.
 */
export function parseInvite(encoded: string): InvitePayload | null {
  try {
    const json = atob(encoded);
    const parsed: unknown = JSON.parse(json);

    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (
      typeof obj['sessionId'] !== 'string' ||
      typeof obj['rateSatsPerInterval'] !== 'number' ||
      typeof obj['intervalSeconds'] !== 'number' ||
      typeof obj['mintUrl'] !== 'string'
    ) {
      return null;
    }

    return {
      sessionId: obj['sessionId'],
      rateSatsPerInterval: obj['rateSatsPerInterval'],
      intervalSeconds: obj['intervalSeconds'],
      mintUrl: obj['mintUrl'],
    };
  } catch {
    return null;
  }
}
