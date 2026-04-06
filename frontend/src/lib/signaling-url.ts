// Derive the signaling WebSocket URL. If VITE_SIGNALING_URL is set at build
// time it takes priority (e.g. a dedicated signaling server in production).
// Otherwise fall back to the Vite-proxied /ws path so that the connection
// works on any host — including LAN devices accessing the dev server over
// HTTPS — without mixed-content (wss vs ws) errors.
export function getSignalingUrl(): string {
  const env = import.meta.env['VITE_SIGNALING_URL'] as string | undefined;
  if (env) return env;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
