import { clearSession } from './session-storage.js';
import { appendSessionRecord } from './session-history.js';
import type { Role } from '../types/session.js';

export interface SessionSummaryConfig {
  onBeforeSummary?: () => void;
  onAfterSummary?: () => void;
  statsElId?: string;
  sessionId?: string | undefined;
  role?: Role | undefined;
}

export interface SessionSummary {
  formatElapsed(secs: number): string;
  getElapsedSeconds(): number;
  startSessionTimer(): void;
  showPaymentPausedBanner(): void;
  hidePaymentPausedBanner(): void;
  showSessionSummary(totalSats: number, totalChunks: number): void;
  showSessionStats(initialBudget?: number): void;
}

export function createSessionSummary(config?: SessionSummaryConfig): SessionSummary {
  const sessionSummaryOverlayEl = document.getElementById('session-summary-overlay');
  const summaryDurationEl = document.getElementById('summary-duration');
  const summarySatsEl = document.getElementById('summary-sats');
  const summaryChunksEl = document.getElementById('summary-chunks');
  const summaryCloseBtnEl = document.getElementById('summary-close-btn');
  const paymentPausedBannerEl = document.getElementById('payment-paused-banner');
  const sessionStatsEl = document.getElementById(config?.statsElId ?? 'session-stats');

  let sessionStartTime: number | null = null;
  let summaryShown = false;

  // Wire up the close button
  if (summaryCloseBtnEl !== null) {
    summaryCloseBtnEl.addEventListener('click', () => {
      clearSession();
      window.location.href = '/';
    });
  }

  function formatElapsed(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function getElapsedSeconds(): number {
    if (sessionStartTime === null) return 0;
    return Math.floor((Date.now() - sessionStartTime) / 1000);
  }

  function startSessionTimer(): void {
    sessionStartTime = Date.now();
  }

  function showPaymentPausedBanner(): void {
    if (paymentPausedBannerEl !== null) {
      paymentPausedBannerEl.classList.add('visible');
    }
  }

  function hidePaymentPausedBanner(): void {
    if (paymentPausedBannerEl !== null) {
      paymentPausedBannerEl.classList.remove('visible');
    }
  }

  function showSessionSummary(totalSats: number, totalChunks: number): void {
    if (summaryShown) return;
    summaryShown = true;

    config?.onBeforeSummary?.();

    const elapsed = getElapsedSeconds();

    if (config?.sessionId !== undefined && config?.role !== undefined) {
      appendSessionRecord({
        sessionId: config.sessionId,
        role: config.role,
        startedAt: new Date(Date.now() - elapsed * 1000).toISOString(),
        durationSeconds: elapsed,
        totalSats,
        totalChunks,
      });
    }

    if (summaryDurationEl !== null) {
      summaryDurationEl.textContent = formatElapsed(elapsed);
    }
    if (summarySatsEl !== null) {
      summarySatsEl.textContent = String(totalSats);
    }
    if (summaryChunksEl !== null) {
      summaryChunksEl.textContent = String(totalChunks);
    }
    if (sessionSummaryOverlayEl !== null) {
      sessionSummaryOverlayEl.classList.add('visible');
    }

    config?.onAfterSummary?.();
  }

  function showSessionStats(initialBudget?: number): void {
    if (initialBudget !== undefined && sessionStartTime === null) {
      sessionStartTime = Date.now();
    }
    if (sessionStatsEl !== null) {
      sessionStatsEl.style.display = 'flex';
    }
  }

  return {
    formatElapsed,
    getElapsedSeconds,
    startSessionTimer,
    showPaymentPausedBanner,
    hidePaymentPausedBanner,
    showSessionSummary,
    showSessionStats,
  };
}
