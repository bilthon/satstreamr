import type { PaymentTransport } from './ports.js';
import type { DataChannelMessage } from '../types/data-channel.js';

export interface SendingSession {
  start(): void;
  /** Stops scheduling; does not imply settlement or refund. */
  stop(): void;
  onBudgetExhausted(listener: () => void): void;
  onPaymentFailure(listener: (reason: string) => void): void;
  onChunkPaid(listener: (chunkId: number, totalPaid: number, balance: number) => void): void;
}

export interface SendingSessionOptions {
  intervalSecs: number;
  chunkSats: number;
  /** Wait before the first charge. Defaults to intervalSecs. */
  initialDelaySecs?: number;
  initialChunkId?: number;
  initialTotalSatsPaid?: number;
  onStateChange?: (state: { chunkId: number; totalSatsPaid: number }) => void;
}

export interface SessionSender {
  getBalance(): number;
  onBalanceChange(listener: (balance: number) => void): () => void;
  /** Invoke only after rate consent; returns available payment chunks. */
  prepare(amountSats: number): Promise<number>;
  createSession(transport: PaymentTransport, options: SendingSessionOptions): SendingSession;
}

export interface SessionReceiver {
  receive(chunkId: number, payment: string): Promise<void>;
  /** Reset on a new session, not on transport reconnect. Does not settle payments. */
  reset(): void;
}

/** Callbacks retain page-owned counters and the current (possibly replaced) channel. */
export interface ReceiptCallbacks {
  sendMessage(message: DataChannelMessage): void;
  onReceived(amountSats: number): void;
  onReady(): void;
}

/** A wallet snapshot taken when the cash-out UI is wired, not at quote/payment time. */
export interface CashOut {
  readonly hasFunds: boolean;
  readonly balance: number;
  /** Melt fee and lightning reserve for this snapshot, before an invoice exists. */
  explain(): Promise<MeltSpendLimit>;
  /** Validates affordability against the snapshot; errors retain displayable reasons. */
  quote(invoice: string): Promise<CashOutQuote>;
}

export interface MeltSpendLimit {
  balance: number;
  inputFee: number;
  lightningBuffer: number;
  maxAmount: number;
}

export interface CashOutQuote {
  readonly amount: number;
  readonly feeReserve: number;
  readonly inputFee: number;
  /** May refetch the quote; no guarantee of final settlement beyond `paid`. */
  pay(): Promise<{ paid: boolean; changeSats: number }>;
}

export interface SessionWallet {
  createCashOut(): CashOut;
  /** Estimated receiving fee for one payment cycle, in sats. */
  estimateReceiptFee(): Promise<number>;
}
