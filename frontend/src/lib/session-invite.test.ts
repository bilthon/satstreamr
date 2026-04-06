/**
 * session-invite.test.ts
 *
 * Unit tests for createInvite, createInviteUrl, and parseInvite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createInvite, createInviteUrl, parseInvite } from './session-invite.js';
import type { InvitePayload } from './session-invite.js';

// ---------------------------------------------------------------------------
// Environment setup — provide window.location.origin for the Node environment
// ---------------------------------------------------------------------------

beforeAll(() => {
  // jsdom / happy-dom are not configured for this project, so we stub the
  // minimum globals needed by createInviteUrl.
  if (typeof window === 'undefined') {
    (globalThis as Record<string, unknown>)['window'] = {
      location: { origin: 'http://localhost:5173' },
    };
  } else if (typeof window.location === 'undefined' || window.location.origin === '') {
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost:5173' },
      writable: true,
    });
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PAYLOAD: InvitePayload = {
  sessionId: 'abc123',
  rateSatsPerInterval: 2,
  intervalSeconds: 10,
  mintUrl: 'https://mint.example.com',
};

// ---------------------------------------------------------------------------
// createInvite + parseInvite round-trip
// ---------------------------------------------------------------------------

describe('createInvite / parseInvite', () => {
  it('round-trips a payload without data loss', () => {
    const encoded = createInvite(SAMPLE_PAYLOAD);
    const decoded = parseInvite(encoded);
    expect(decoded).toEqual(SAMPLE_PAYLOAD);
  });

  it('produces a non-empty base64 string', () => {
    const encoded = createInvite(SAMPLE_PAYLOAD);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    // Should only contain base64 characters
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

// ---------------------------------------------------------------------------
// createInviteUrl
// ---------------------------------------------------------------------------

describe('createInviteUrl', () => {
  it('includes the origin in the URL', () => {
    const url = createInviteUrl(SAMPLE_PAYLOAD);
    expect(url.startsWith('http://localhost:5173')).toBe(true);
  });

  it('includes the ?session= query parameter with the session ID', () => {
    const url = createInviteUrl(SAMPLE_PAYLOAD);
    expect(url).toContain('/room.html?session=abc123');
  });

  it('the ?session= value matches the original sessionId', () => {
    const url = createInviteUrl(SAMPLE_PAYLOAD);
    const sid = new URL(url).searchParams.get('session');
    expect(sid).toBe(SAMPLE_PAYLOAD.sessionId);
  });
});

// ---------------------------------------------------------------------------
// parseInvite — error cases
// ---------------------------------------------------------------------------

describe('parseInvite error handling', () => {
  it('returns null for an invalid base64 string', () => {
    expect(parseInvite('!!!not-valid-base64!!!')).toBeNull();
  });

  it('returns null for valid base64 that is not JSON', () => {
    const notJson = btoa('hello world');
    expect(parseInvite(notJson)).toBeNull();
  });

  it('returns null when sessionId field is missing', () => {
    const incomplete = btoa(
      JSON.stringify({
        rateSatsPerInterval: 2,
        intervalSeconds: 10,
        mintUrl: 'https://mint.example.com',
      })
    );
    expect(parseInvite(incomplete)).toBeNull();
  });

  it('returns null when rateSatsPerInterval is not a number', () => {
    const invalid = btoa(
      JSON.stringify({
        sessionId: 'abc123',
        rateSatsPerInterval: '2',
        intervalSeconds: 10,
        mintUrl: 'https://mint.example.com',
      })
    );
    expect(parseInvite(invalid)).toBeNull();
  });

  it('returns null when intervalSeconds is missing', () => {
    const incomplete = btoa(
      JSON.stringify({
        sessionId: 'abc123',
        rateSatsPerInterval: 2,
        mintUrl: 'https://mint.example.com',
      })
    );
    expect(parseInvite(incomplete)).toBeNull();
  });

  it('returns null when mintUrl is missing', () => {
    const incomplete = btoa(
      JSON.stringify({
        sessionId: 'abc123',
        rateSatsPerInterval: 2,
        intervalSeconds: 10,
      })
    );
    expect(parseInvite(incomplete)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseInvite('')).toBeNull();
  });

  it('does not require tutorPubkey — payload without it is valid', () => {
    const payload = btoa(
      JSON.stringify({
        sessionId: 'abc123',
        rateSatsPerInterval: 2,
        intervalSeconds: 10,
        mintUrl: 'https://mint.example.com',
      })
    );
    const result = parseInvite(payload);
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe('abc123');
  });
});
