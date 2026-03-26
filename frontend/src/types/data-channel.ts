/**
 * Discriminated union of all messages sent over the WebRTC payment data channel.
 *
 * Viewer -> Tutor: token_payment
 * Tutor -> Viewer: payment_ack | payment_nack
 */

export type TokenPaymentMessage = {
  type: 'token_payment';
  chunkId: number;
  encodedToken: string; // cashu-ts getEncodedToken() output
};

export type PaymentAckMessage = {
  type: 'payment_ack';
  chunkId: number;
};

export type PaymentNackMessage = {
  type: 'payment_nack';
  chunkId: number;
  reason: string;
};

export type SessionPausedMessage = {
  type: 'session_paused';
  reason: string;
};

export type DataChannelMessage =
  | TokenPaymentMessage
  | PaymentAckMessage
  | PaymentNackMessage
  | SessionPausedMessage;
