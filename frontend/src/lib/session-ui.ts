export interface SessionUI {
  setStatus(text: string): void;
  showError(text: string): void;
  setDcStatus(text: string): void;
  showReconnectOverlay(): void;
  hideReconnectOverlay(): void;
}
