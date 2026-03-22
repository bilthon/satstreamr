import { SignalingClient } from '../signaling-client.js';

const signalingUrl = (import.meta.env['VITE_SIGNALING_URL'] as string | undefined) ?? 'ws://localhost:8080';
const statusEl = document.getElementById('status');

function setStatus(text: string): void {
  if (statusEl !== null) {
    statusEl.textContent = text;
  }
}

const client = new SignalingClient(signalingUrl);

client.onConnect(() => {
  setStatus('connected');
});

client.onDisconnect(() => {
  setStatus('disconnected');
});
