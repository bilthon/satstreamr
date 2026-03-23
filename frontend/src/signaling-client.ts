import type { SignalingMessage } from './types/signaling.js';

const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 16_000;
const JITTER_FACTOR = 0.2;

function backoffDelay(attempt: number): number {
  const base = Math.min(INITIAL_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = base * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private messageHandlers: Array<(msg: SignalingMessage) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private reconnectedHandlers: Array<() => void> = [];
  private disconnectingHandlers: Array<() => void> = [];

  private sessionId: string | null = null;
  private peerId: string | null = null;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private isReconnecting = false;

  constructor(url: string) {
    this.url = url;
    this.openSocket();
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log('[signaling] connected');
      if (this.isReconnecting && this.sessionId !== null) {
        // Rejoin existing session after reconnect
        this.sendRaw({ type: 'rejoin_session', sessionId: this.sessionId });
      } else {
        this.reconnectAttempt = 0;
        for (const handler of this.connectHandlers) {
          handler();
        }
      }
      this.isReconnecting = false;
    });

    ws.addEventListener('close', () => {
      console.log('[signaling] disconnected');
      if (this.intentionallyClosed) {
        for (const handler of this.disconnectHandlers) {
          handler();
        }
        return;
      }
      // Notify disconnecting listeners (show overlay)
      for (const handler of this.disconnectingHandlers) {
        handler();
      }
      for (const handler of this.disconnectHandlers) {
        handler();
      }
      this.scheduleReconnect();
    });

    ws.addEventListener('error', (event) => {
      console.error('[signaling] error', event);
    });

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as SignalingMessage;
        console.log('[signaling] <-', msg);

        // Track sessionId from session lifecycle messages
        if (msg.type === 'session_created') {
          this.sessionId = msg.sessionId;
        }

        // Stop reconnecting if session was explicitly ended
        if (msg.type === 'session_ended') {
          this.intentionallyClosed = true;
          this.cancelReconnect();
        }

        // Handle session_rejoined confirmation
        if (msg.type === 'session_rejoined') {
          this.reconnectAttempt = 0;
          for (const handler of this.reconnectedHandlers) {
            handler();
          }
        }

        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      } catch (err) {
        console.error('[signaling] failed to parse message', err);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    const delay = backoffDelay(this.reconnectAttempt);
    console.log(`[signaling] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})`);
    this.isReconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt += 1;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendRaw(msg: SignalingMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  send(msg: SignalingMessage): void {
    console.log('[signaling] ->', msg);
    this.sendRaw(msg);
  }

  /**
   * Store sessionId explicitly (called by pages after session_created).
   * This is used to send rejoin_session on reconnect.
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Store peerId for sessionStorage persistence.
   */
  setPeerId(id: string): void {
    this.peerId = id;
  }

  getPeerId(): string | null {
    return this.peerId;
  }

  onMessage(handler: (msg: SignalingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  /** Called when a reconnect has succeeded and the session was rejoined. */
  onReconnected(handler: () => void): void {
    this.reconnectedHandlers.push(handler);
  }

  /** Called immediately when the WebSocket closes unexpectedly (before reconnect). */
  onDisconnecting(handler: () => void): void {
    this.disconnectingHandlers.push(handler);
  }

  /** Clean teardown — stops reconnection and closes the socket. */
  disconnect(): void {
    this.intentionallyClosed = true;
    this.cancelReconnect();
    if (this.ws !== null) {
      this.ws.close();
    }
  }

  get readyState(): number {
    return this.ws !== null ? this.ws.readyState : WebSocket.CLOSED;
  }
}
