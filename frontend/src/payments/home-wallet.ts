/** Home's application interface. Cashu details are display data, never bearer proofs. */
export interface HomeWalletSnapshot {
  balance: number;
  cashu: {
    denominations: { amount: number; count: number; subtotal: number }[];
    proofCount: number;
  };
}

export interface WithdrawalEstimate {
  maxAmount: number;
  inputFee: number;
  lightningBuffer: number;
  balance: number;
}

export interface WalletStatus {
  message: string;
  variant: 'info' | 'success' | 'error' | 'warning';
}

export interface HomeWallet {
  snapshot(): HomeWalletSnapshot;
  subscribe(listener: (snapshot: HomeWalletSnapshot) => void): () => void;
  estimateWithdrawal(): Promise<WithdrawalEstimate>;
  /** Cancellation stops observation/polling, not an already submitted mint operation. */
  deposit(amount: number, onInvoice: (invoice: string) => void, signal: AbortSignal): Promise<'paid' | 'expired' | 'cancelled'>;
  /** Once submitted, withdrawal completes/rolls back independently of view lifetime. */
  withdraw(invoice: string, onProgress: (status: WalletStatus) => void): Promise<WalletStatus>;
}
