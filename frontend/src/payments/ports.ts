import type {
  DataChannelMessage,
  SessionPausedMessage,
  TokenPaymentMessage,
} from '../types/data-channel.js';

/** The scheduler's transport seam; no WebRTC lifecycle ownership. */
export interface PaymentTransport {
  sendMessage(message: TokenPaymentMessage | SessionPausedMessage): void;
  onMessage(handler: (message: DataChannelMessage) => void): void;
}

/** Synchronous operations needed by the current interval payment loop. */
export interface PaymentSource {
  getBalance(): number;
  /**
   * Reserve/spend funds before returning the opaque wire token, or throw.
   * Called once per new chunk, never on retry. A failed transmission does not
   * imply a refund: the recipient may already have received the token.
   */
  preparePayment(amountSats: number): string;
}
