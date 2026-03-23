export type Role = 'tutor' | 'viewer';

export interface SessionState {
  sessionId: string;
  peerId: string;
  role: Role;
  chunkCount: number;
  totalSatsPaid: number;
  budgetRemaining: number;
}
