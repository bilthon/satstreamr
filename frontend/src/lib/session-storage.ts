import type { SessionState } from '../types/session.js';

const SESSION_KEY = 'streaming_session';

export function saveSession(state: SessionState): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
}

export function loadSession(): SessionState | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function updateSession(patch: Partial<SessionState>): void {
  const existing = loadSession();
  if (existing === null) return;
  saveSession({ ...existing, ...patch });
}
