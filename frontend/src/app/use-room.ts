import { computed, nextTick, onMounted, onUnmounted, reactive, useTemplateRef } from 'vue';
import type { SignalingClient } from '../signaling-client.js';
import type { PeerConnection } from '../lib/peer-connection.js';
import type { DataChannel } from '../lib/data-channel.js';
import type { ReceiptCallbacks, SessionReceiver, SessionSender, SessionWallet } from '../payments/session-payments.js';
import type { SessionUI } from '../lib/session-ui.js';
import { appendSessionRecord } from '../lib/session-history.js';
import { clearSession } from '../lib/session-storage.js';
import { useTutor } from './use-tutor.js';
import { useViewer } from './use-viewer.js';

/** Composition-root dependencies: no SDK objects or bearer proofs enter view state. */
export interface RoomServices {
  createClient(): SignalingClient;
  createPeer(): PeerConnection;
  createChannel(channel: RTCDataChannel): DataChannel;
  wallet: SessionWallet;
  sender: SessionSender;
  createReceiver(callbacks: ReceiptCallbacks): SessionReceiver;
  validateMint(url: string): void;
  mintUrl: string;
  isDev: boolean;
  navigate(url: string): void;
}

function createState(search: string) {
  const params = new URLSearchParams(search);
  return reactive({
    role: params.has('session') ? 'viewer' as const : 'tutor' as const,
    sessionId: params.get('session'),
    status: 'connecting...',
    error: '',
    dcStatus: '—',
    reconnecting: false,
    sessionDisplay: params.has('session') ? `Session: ${params.get('session')}` : '',
    rateVisible: !params.has('session'),
    rateSats: '2',
    rateInterval: '10',
    freeSeconds: '0',
    receiptFee: 0,
    feeUnavailable: false,
    feeInfoOpen: false,
    startDisabled: false,
    inviteVisible: false,
    inviteId: '',
    inviteUrl: '',
    inviteCopied: false,
    statsVisible: false,
    elapsed: '00:00',
    satsReceived: 0,
    paymentFloat: null as number | null,
    paymentAnimation: 0,
    budget: null as number | null,
    duration: '—',
    chunkPulse: false,
    chunkAnimation: 0,
    freePreview: null as { endsAt: number; totalSecs: number } | null,
    freeRemaining: 0,
    exitVisible: false,
    paused: false,
    lowFunds: 'normal' as 'normal' | 'warning' | 'countdown',
    countdown: null as number | null,
    goLive: false,
    goLiveDigit: null as number | null,
    goLiveLabel: false,
    goLiveFade: false,
    joinVisible: false,
    joinRate: 2,
    joinInterval: 10,
    joinFreeSeconds: 0,
    joinBalance: 0,
    joinDuration: '—',
    joinMint: '',
    mismatch: false,
    sessionMint: '',
    summaryVisible: false,
    summaryDuration: '—',
    summarySats: null as number | null,
    summaryChunks: null as number | null,
    invoice: '',
    invoiceCountdown: '',
    invoiceUrgent: false,
    cashoutStatus: '',
    cashoutError: false,
    cashoutAmount: null as number | null,
    cashoutDisabled: false,
    cashoutFunds: null as null | {
      balance: number;
      meltFee: number;
      lightning: number;
      estimated: boolean;
      maxInvoice: number;
    },
    toast: false,
  });
}

export interface RoomActions {
  start(): void;
  leave(): void;
  acceptJoin(): void;
  cancelJoin(): void;
  invoiceChanged(): void;
  payInvoice(): Promise<void>;
  finishCeremony(): void;
}

export interface RoomContext {
  state: ReturnType<typeof createState>;
  services: RoomServices;
  ui: SessionUI;
  localVideo(): HTMLVideoElement | null;
  remoteVideo(): HTMLVideoElement | null;
  alive(): boolean;
  later(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  onDispose(callback: () => void): void;
  focusJoin(): void;
  startTimer(): void;
  elapsedSeconds(): number;
  showStats(initialBudget?: number): void;
  showFreePreview(endsAt: number, totalSecs: number): void;
  showSummary(sats: number, chunks: number): void;
  getRate(): { rateSatsPerInterval: number; intervalSeconds: number; freeSeconds: number };
}

export function formatElapsed(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function useRoom(services: RoomServices, search: string) {
  const state = createState(search);
  const localVideo = useTemplateRef<HTMLVideoElement>('localVideo');
  const remoteVideo = useTemplateRef<HTMLVideoElement>('remoteVideo');
  const joinAccept = useTemplateRef<HTMLButtonElement>('joinAccept');
  let alive = true;
  let sessionStart: number | null = null;
  const cleanups: (() => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  let actions: RoomActions | undefined;

  const ui: SessionUI = {
    setStatus(text) {
      if (alive) state.status = text;
    },
    showError(text) {
      console.error(`[${state.role}]`, text);
      if (alive) state.error = text;
    },
    setDcStatus(text) {
      if (alive) state.dcStatus = text;
    },
    showReconnectOverlay() {
      if (alive) state.reconnecting = true;
    },
    hideReconnectOverlay() {
      if (alive) state.reconnecting = false;
    },
  };

  const context: RoomContext = {
    state,
    services,
    ui,
    localVideo: () => localVideo.value,
    remoteVideo: () => remoteVideo.value,
    alive: () => alive,
    later(callback, ms) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (alive) callback();
      }, ms);
      timers.add(timer);
      return timer;
    },
    onDispose(callback) {
      cleanups.push(callback);
    },
    focusJoin() {
      // Vue must reveal the dialog before its Accept button can receive focus.
      void nextTick().then(() => {
        if (alive && state.joinVisible) joinAccept.value?.focus();
      });
    },
    startTimer() {
      sessionStart = Date.now();
    },
    elapsedSeconds() {
      return sessionStart === null ? 0 : Math.floor((Date.now() - sessionStart) / 1000);
    },
    showStats(initialBudget) {
      if (initialBudget !== undefined && sessionStart === null) sessionStart = Date.now();
      state.statsVisible = true;
    },
    showFreePreview(endsAt, totalSecs) {
      stopFreePreview();
      if (!alive || totalSecs <= 0 || endsAt <= Date.now()) return;
      const tick = (): void => {
        state.freeRemaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        if (state.freeRemaining === 0) stopFreePreview();
      };
      state.freePreview = { endsAt, totalSecs };
      tick();
      previewTimer = setInterval(tick, 1000);
    },
    showSummary(sats, chunks) {
      if (!alive || state.summaryVisible) return;
      const elapsed = context.elapsedSeconds();
      // Exactly one history record per summary, with the existing key/schema.
      if (state.sessionId !== null) {
        appendSessionRecord({
          sessionId: state.sessionId,
          role: state.role,
          startedAt: new Date(Date.now() - elapsed * 1000).toISOString(),
          durationSeconds: elapsed,
          totalSats: sats,
          totalChunks: chunks,
        });
      }
      state.summaryDuration = formatElapsed(elapsed);
      state.summarySats = sats;
      state.summaryChunks = chunks;
      state.summaryVisible = true;
    },
    getRate() {
      return {
        rateSatsPerInterval: Math.max(1, parseInt(String(state.rateSats), 10) || 2),
        intervalSeconds: Math.max(5, parseInt(String(state.rateInterval), 10) || 10),
        freeSeconds: Math.max(0, parseInt(String(state.freeSeconds), 10) || 0),
      };
    },
  };

  function stopFreePreview(): void {
    clearInterval(previewTimer);
    previewTimer = undefined;
    state.freePreview = null;
    state.freeRemaining = 0;
  }

  const effectiveRate = computed(() => {
    const rate = context.getRate();
    return (rate.rateSatsPerInterval / rate.intervalSeconds * 60).toFixed(1);
  });
  const feePercent = computed(() => (state.receiptFee / context.getRate().rateSatsPerInterval * 100).toFixed(0));
  const feeWarning = computed(() => state.receiptFee / context.getRate().rateSatsPerInterval > 0.3);
  const joinPerMinute = computed(() => {
    if (state.joinInterval <= 0) return '';
    const rate = state.joinRate * 60 / state.joinInterval;
    return Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
  });

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(state.inviteUrl);
      if (!alive) return;
      state.inviteCopied = true;
      context.later(() => { state.inviteCopied = false; }, 1800);
    } catch (error) {
      console.error('[invite] clipboard write failed', error);
    }
  }

  function closeSummary(): void {
    clearSession();
    services.navigate('/');
  }

  onMounted(() => {
    // Media refs exist before either role opens signaling or handles peer events.
    actions = state.role === 'tutor' ? useTutor(context) : useViewer(context);
  });

  onUnmounted(() => {
    alive = false;
    for (const cleanup of cleanups) cleanup();
    for (const timer of timers) clearTimeout(timer);
    clearInterval(previewTimer);
    // Disposal stops scheduling/media, never rolls back submitted financial work.
  });

  return {
    state,
    effectiveRate,
    feePercent,
    feeWarning,
    joinPerMinute,
    copyInvite,
    closeSummary,
    start: () => actions?.start(),
    leave: () => actions?.leave(),
    acceptJoin: () => actions?.acceptJoin(),
    cancelJoin: () => actions?.cancelJoin(),
    invoiceChanged: () => actions?.invoiceChanged(),
    payInvoice: () => actions?.payInvoice(),
    finishCeremony: () => actions?.finishCeremony(),
  };
}
