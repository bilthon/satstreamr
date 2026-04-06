export interface SessionUI {
  setStatus(text: string): void;
  showError(text: string): void;
  setDcStatus(text: string): void;
  showReconnectOverlay(): void;
  hideReconnectOverlay(): void;
}

export function createSessionUI(role: 'tutor' | 'viewer'): SessionUI {
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const dcStatusEl = document.getElementById('dc-status');

  // Reconnect overlay -- inserted programmatically so it works without HTML changes
  const reconnectOverlayEl = document.createElement('div');
  reconnectOverlayEl.id = 'reconnect-overlay';
  reconnectOverlayEl.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.6);' +
    'color:#fff;font-size:1.5rem;align-items:center;' +
    'justify-content:center;z-index:9999;';
  reconnectOverlayEl.style.display = 'none';
  reconnectOverlayEl.textContent = 'reconnecting\u2026';
  document.body.appendChild(reconnectOverlayEl);

  return {
    setStatus(text: string): void {
      if (statusEl !== null) {
        statusEl.textContent = text;
      }
    },

    showError(text: string): void {
      console.error(`[${role}]`, text);
      if (errorEl !== null) {
        errorEl.textContent = text;
        errorEl.style.display = 'block';
      }
    },

    setDcStatus(text: string): void {
      if (dcStatusEl !== null) {
        dcStatusEl.textContent = `payment channel: ${text}`;
      }
    },

    showReconnectOverlay(): void {
      reconnectOverlayEl.style.display = 'flex';
    },

    hideReconnectOverlay(): void {
      reconnectOverlayEl.style.display = 'none';
    },
  };
}
