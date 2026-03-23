/**
 * Discriminated union of all messages sent over the WebRTC payment data channel.
 *
 * Viewer → Tutor: token_payment
 * Tutor → Viewer: payment_ack | payment_nack
 */

export type TokenPaymentMessage = {
  type: 'token_payment';
  chunkId: number;
  proofs: unknown[]; // Proof[] from cashu-ts — typed as unknown here to avoid circular deps
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

export type DataChannelMessage =
  | TokenPaymentMessage
  | PaymentAckMessage
  | PaymentNackMessage;
