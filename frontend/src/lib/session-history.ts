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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function renderSessionHistory(containerEl: HTMLElement): void {
  const records = loadSessionHistory().slice(0, 10);

  if (records.length === 0) {
    containerEl.innerHTML = '<p class="session-history-empty">No sessions yet.</p>';
    return;
  }

  const rows = records.map(r => `
    <div class="session-history-row">
      <span class="session-history-date">${formatDate(r.startedAt)}</span>
      <span class="session-history-badge ${r.role}">${r.role.toLowerCase() === 'tutor' ? 'Earned' : 'Spent'}</span>
      <span class="session-history-duration">${formatDuration(r.durationSeconds)}</span>
      <span class="session-history-sats">${r.totalSats.toLocaleString()} <span class="sat">S</span></span>
    </div>`).join('');

  containerEl.innerHTML = `<p class="session-history-heading">Recent Sessions</p>${rows}`;
}
