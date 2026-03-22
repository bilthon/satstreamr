import type { SignalingMessage } from './types/signaling.js';

export class SignalingClient {
  private ws: WebSocket;
  private messageHandlers: Array<(msg: SignalingMessage) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      console.log('[signaling] connected');
      for (const handler of this.connectHandlers) {
        handler();
      }
    });

    this.ws.addEventListener('close', () => {
      console.log('[signaling] disconnected');
      for (const handler of this.disconnectHandlers) {
        handler();
      }
    });

    this.ws.addEventListener('error', (event) => {
      console.error('[signaling] error', event);
    });

    this.ws.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as SignalingMessage;
        console.log('[signaling] ←', msg);
        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      } catch (err) {
        console.error('[signaling] failed to parse message', err);
      }
    });
  }

  send(msg: SignalingMessage): void {
    console.log('[signaling] →', msg);
    this.ws.send(JSON.stringify(msg));
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

  get readyState(): number {
    return this.ws.readyState;
  }
}
