import type { Role } from '../types/session.js';

export interface SessionHistoryRecord {
  sessionId: string;
  role: Role;
  startedAt: string;       // ISO-8601
  durationSeconds: number;
  totalSats: number;
  totalChunks: number;
}

const STORAGE_KEY = 'satstreamr_session_history';
const MAX_RECORDS = 50;

function loadRaw(): SessionHistoryRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as SessionHistoryRecord[];
  } catch {
    return [];
  }
}

export function appendSessionRecord(record: SessionHistoryRecord): void {
  const records = loadRaw();
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (e) {
    console.warn('[session-history] failed to persist record:', e);
  }
}

export function loadSessionHistory(): SessionHistoryRecord[] {
  return loadRaw();
}

export function clearSessionHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}
