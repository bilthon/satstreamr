export type Role = 'tutor' | 'viewer';

export interface SessionState {
  sessionId: string;
  peerId: string;
  role: Role;
  chunkCount: number;
  totalSatsPaid: number;
  /** Epoch ms when the opening free preview ends. Absent when the tutor offered none. */
  freeEndsAt?: number;
}
