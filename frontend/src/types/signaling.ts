// Inbound message types (client -> server)
export type InboundMessageType =
  | 'create_session'
  | 'join_session'
  | 'rejoin_session'
  | 'offer'
  | 'answer'
  | 'ice_candidate'
  | 'end_session'
  | 'ping';

// Outbound message types (server -> client)
export type OutboundMessageType =
  | 'session_created'
  | 'session_rejoined'
  | 'viewer_joined'
  | 'session_ended'
  | 'pong'
  | 'error'
  | 'offer'
  | 'answer'
  | 'ice_candidate';

// --- Inbound messages (client -> server) ---

export interface CreateSessionMessage {
  type: 'create_session';
  tutorPubkey: string;
  mintUrl: string;
}

export interface JoinSessionMessage {
  type: 'join_session';
  sessionId: string;
}

export interface RejoinSessionMessage {
  type: 'rejoin_session';
  sessionId: string;
}

export interface OfferMessage {
  type: 'offer';
  sessionId: string;
  sdp: unknown;
}

export interface AnswerMessage {
  type: 'answer';
  sessionId: string;
  sdp: unknown;
}

export interface IceCandidateMessage {
  type: 'ice_candidate';
  sessionId: string;
  candidate: unknown;
}

export interface EndSessionMessage {
  type: 'end_session';
  sessionId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type InboundMessage =
  | CreateSessionMessage
  | JoinSessionMessage
  | RejoinSessionMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | EndSessionMessage
  | PingMessage;

// --- Outbound messages (server -> client) ---

export interface SessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
  tutorPubkey: string;
  mintUrl: string;
}

export interface ViewerJoinedMessage {
  type: 'viewer_joined';
  viewerId: string;
  tutorPubkey: string;
}

export interface SessionRejoinedMessage {
  type: 'session_rejoined';
  sessionId: string;
  bufferedCount: number;
}

export interface SessionEndedMessage {
  type: 'session_ended';
}

export interface PongMessage {
  type: 'pong';
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message?: string;
}

export interface RelayOfferMessage {
  type: 'offer';
  sdp: unknown;
  fromPeerId: string;
}

export interface RelayAnswerMessage {
  type: 'answer';
  sdp: unknown;
  fromPeerId: string;
}

export interface RelayIceCandidateMessage {
  type: 'ice_candidate';
  candidate: unknown;
  fromPeerId: string;
}

export type OutboundMessage =
  | SessionCreatedMessage
  | SessionRejoinedMessage
  | ViewerJoinedMessage
  | SessionEndedMessage
  | PongMessage
  | ErrorMessage
  | RelayOfferMessage
  | RelayAnswerMessage
  | RelayIceCandidateMessage;

// Union of all messages the client may send or receive
export type SignalingMessage = InboundMessage | OutboundMessage;
