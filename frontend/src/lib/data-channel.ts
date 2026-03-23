/**
 * DataChannel — typed wrapper around RTCDataChannel for the satstreamr payment transport.
 *
 * - Serializes/deserializes DataChannelMessage as JSON.
 * - Guards sends on readyState === 'open'.
 * - Validates incoming message type before dispatching to handler.
 * - Logs every send/receive with [datachannel] → / ← prefix.
 * - In DEV mode, exposes devSend() on window for manual console testing.
 */

import type { DataChannelMessage } from '../types/data-channel.js';

const KNOWN_TYPES = new Set<string>(['token_payment', 'payment_ack', 'payment_nack']);

export class DataChannel {
  private readonly channel: RTCDataChannel;
  private messageHandler: ((msg: DataChannelMessage) => void) | null = null;

  constructor(channel: RTCDataChannel) {
    this.channel = channel;

    this.channel.onmessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        console.warn('[datachannel] received non-JSON message — ignoring');
        return;
      }

      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        !('type' in parsed) ||
        typeof (parsed as Record<string, unknown>)['type'] !== 'string' ||
        !KNOWN_TYPES.has((parsed as Record<string, unknown>)['type'] as string)
      ) {
        console.warn('[datachannel] received message with unknown type — ignoring', parsed);
        return;
      }

      const msg = parsed as DataChannelMessage;
      console.log('[datachannel] ←', msg);
      this.messageHandler?.(msg);
    };

    // DEV-only helper: attach devSend to window so it can be called from the browser console.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>)['devSend'] = (msg: DataChannelMessage) =>
        this.sendMessage(msg);
    }
  }

  /**
   * Sends a typed DataChannelMessage as a JSON string.
   * Throws if the channel is not open.
   */
  sendMessage(msg: DataChannelMessage): void {
    if (this.channel.readyState !== 'open') {
      throw new Error(
        `[datachannel] sendMessage called but channel is not open (readyState: ${this.channel.readyState})`,
      );
    }
    const serialized = JSON.stringify(msg);
    console.log('[datachannel] →', msg);
    this.channel.send(serialized);
  }

  /**
   * Registers a handler for incoming DataChannelMessages.
   * Only one handler is supported; calling this again replaces the previous handler.
   */
  onMessage(handler: (msg: DataChannelMessage) => void): void {
    this.messageHandler = handler;
  }

  /** Returns true if the underlying RTCDataChannel is open. */
  get isOpen(): boolean {
    return this.channel.readyState === 'open';
  }

  /** Returns the current readyState of the underlying RTCDataChannel. */
  get readyState(): RTCDataChannelState {
    return this.channel.readyState;
  }
}
