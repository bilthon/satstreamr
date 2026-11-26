import type { DataChannel } from '../lib/data-channel.js';
import type { SendingSession } from '../payments/session-payments.js';
import { MintMismatchError } from '../lib/mint-guard.js';
import { saveSession, loadSession, updateSession, clearSession } from '../lib/session-storage.js';
import { wireSharedPeerHandlers } from '../lib/peer-setup.js';
import type { RoomActions, RoomContext } from './use-room.js';

/** Viewer consent, transport and scheduler orchestration; wallet work stays behind SessionSender. */
export function useViewer(room: RoomContext): RoomActions {
  const { state, services, ui } = room;
  const payments = services.sender;
  const sessionId = state.sessionId;
  let rate = 2;
  let interval = 10;
  let freeSeconds = 0;
  let invitedRate: number | null = null;
  let invitedInterval: number | null = null;
  let invitedMint: string | null = null;
  let confirmationShown = false;
  let localStream: MediaStream | null = null;
  let dataChannel: DataChannel | null = null;
  let scheduler: SendingSession | null = null;
  let totalSats = 0;
  let totalChunks = 0;
  let ended = false;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeBalance: (() => void) | undefined;
  let resolveDecision: ((accepted: boolean) => void) | undefined;
  const decision = new Promise<boolean>(resolve => { resolveDecision = resolve; });
  const active = (): boolean => room.alive() && !ended;

  try {
    const raw = sessionStorage.getItem('pending_join');
    if (raw !== null) {
      const pending = JSON.parse(raw) as Record<string, unknown>;
      if (typeof pending['rateSatsPerInterval'] === 'number') rate = invitedRate = pending['rateSatsPerInterval'];
      if (typeof pending['intervalSeconds'] === 'number') interval = invitedInterval = pending['intervalSeconds'];
      if (typeof pending['freeSeconds'] === 'number' && pending['freeSeconds'] >= 0) freeSeconds = Math.floor(pending['freeSeconds']);
      if (typeof pending['mintUrl'] === 'string') invitedMint = pending['mintUrl'];
    }
  } catch {
    // Unavailable or malformed invite storage remains non-fatal.
  }

  function showConfirm(dialogRate: number, dialogInterval: number, mint: string | null): void {
    state.joinRate = dialogRate;
    state.joinInterval = dialogInterval;
    state.joinFreeSeconds = freeSeconds > 0 ? Math.floor(freeSeconds) : 0;
    state.joinMint = mint ?? services.mintUrl;
    const balance = payments.getBalance();
    state.joinBalance = balance;
    if (dialogRate > 0 && dialogInterval > 0 && balance > 0) {
      const seconds = Math.floor(balance / dialogRate) * dialogInterval + state.joinFreeSeconds;
      if (seconds >= 60) {
        const minutes = Math.floor(seconds / 60);
        state.joinDuration = seconds % 60 > 0 ? `~${minutes} min ${seconds % 60}s` : `~${minutes} min`;
      } else {
        state.joinDuration = `~${seconds}s`;
      }
    } else {
      state.joinDuration = balance === 0 ? '0 — deposit first' : '—';
    }
    if (confirmationShown) return;
    confirmationShown = true;
    state.joinVisible = true;
    room.focusJoin();
  }

  function decide(accepted: boolean): void {
    state.joinVisible = false;
    resolveDecision?.(accepted);
    resolveDecision = undefined;
  }

  // Preserve invite-before-socket consent presentation. No media or wallet
  // preparation happens until the same decision promise resolves to true.
  if (invitedRate !== null && invitedInterval !== null) {
    showConfirm(invitedRate, invitedInterval, invitedMint);
  }
  let peer = services.createPeer();
  let tutorOfferArrived = false;
  const client = services.createClient();

  function stopCountdown(): void {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }

  function enterPhase(phase: 'normal' | 'warning' | 'countdown', seconds = 10): void {
    if (phase === state.lowFunds && phase !== 'countdown') return;
    state.lowFunds = phase;
    state.countdown = null;
    stopCountdown();
    if (phase === 'countdown') {
      state.countdown = seconds;
      countdownTimer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
          stopCountdown();
          state.countdown = 0;
        } else {
          state.countdown = seconds;
        }
      }, 1000);
    }
  }

  function updateBudget(balance: number): void {
    if (!active()) return;
    state.budget = balance;
    const remaining = rate <= 0 || interval <= 0 ? Infinity : Math.floor(balance / rate) * interval;
    if (remaining <= 10) enterPhase('countdown', remaining);
    else if (remaining <= 60) enterPhase('warning');
    else enterPhase('normal');
    state.duration = rate <= 0 || interval <= 0 ? '—' : `~${Math.floor(balance / rate * interval / 60)} min at current rate`;
  }

  function releaseChannel(): void {
    unsubscribeBalance?.();
    unsubscribeBalance = undefined;
    scheduler?.stop();
    scheduler = null;
  }

  function stopMedia(): void {
    peer.close();
    localStream?.getTracks().forEach(track => track.stop());
  }

  function endSession(): void {
    ended = true;
    scheduler?.stop();
    stopCountdown();
    enterPhase('normal');
    releaseChannel();
    stopMedia();
    state.exitVisible = false;
    room.showSummary(totalSats, totalChunks);
  }

  async function startMedia(): Promise<void> {
    try {
      const stream = await peer.initMedia();
      if (!active()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      localStream = stream;
      const video = room.localVideo();
      if (video) video.srcObject = stream;
    } catch (error) {
      if (active()) ui.showError(error instanceof Error ? error.message : String(error));
    }
  }

  function cancelledJoin(): void {
    ui.setStatus('cancelled');
    scheduler?.stop();
    if (sessionId !== null) client.send({ type: 'end_session', sessionId });
    client.disconnect();
    clearSession();
    try {
      sessionStorage.removeItem('pending_join');
    } catch {
      // Optional invite storage can be unavailable.
    }
    services.navigate('/');
  }

  function setupPeer(): void {
    wireSharedPeerHandlers(peer, () => sessionId, client, ui.setStatus, room.remoteVideo());
    peer.onDataChannel = event => {
      const raw = event.channel;
      raw.onopen = () => {
        if (!active()) return;
        dataChannel = services.createChannel(raw);
        ui.setDcStatus('open');
        const saved = loadSession();
        const initialChunkId = saved?.chunkCount ?? 0;
        const initialTotalSatsPaid = saved?.totalSatsPaid ?? 0;
        let initialDelaySecs = interval;
        if (initialChunkId === 0) {
          if (typeof saved?.freeEndsAt === 'number') {
            const remaining = Math.ceil((saved.freeEndsAt - Date.now()) / 1000);
            initialDelaySecs = remaining > 0 ? remaining : interval;
            if (remaining > 0) room.showFreePreview(saved.freeEndsAt, Math.max(freeSeconds, remaining));
          } else if (freeSeconds > 0) {
            const freeEndsAt = Date.now() + freeSeconds * 1000;
            updateSession({ freeEndsAt });
            initialDelaySecs = freeSeconds;
            room.showFreePreview(freeEndsAt, freeSeconds);
          }
        }
        totalSats = initialTotalSatsPaid;
        totalChunks = initialChunkId;
        room.showStats(payments.getBalance());
        updateBudget(payments.getBalance());
        state.paused = false;
        unsubscribeBalance = payments.onBalanceChange(updateBudget);

        scheduler = payments.createSession(dataChannel, {
          intervalSecs: interval,
          chunkSats: rate,
          initialDelaySecs,
          initialChunkId,
          initialTotalSatsPaid,
          onStateChange: counters => updateSession({ chunkCount: counters.chunkId, totalSatsPaid: counters.totalSatsPaid }),
        });
        scheduler.onBudgetExhausted(() => {
          if (!active()) return;
          ui.showError('Budget exhausted — session ended');
          stopCountdown();
          scheduler?.stop();
          releaseChannel();
          stopMedia();
          ended = true;
          room.showSummary(totalSats, totalChunks);
          client.disconnect();
        });
        scheduler.onPaymentFailure(reason => {
          if (!active()) return;
          ui.showError(`Payment failed — session paused: ${reason}`);
          state.paused = true;
        });
        scheduler.onChunkPaid((chunkId, totalPaid, balance) => {
          totalSats = totalPaid;
          totalChunks = chunkId + 1;
          if (!active()) return;
          updateBudget(balance);
          state.chunkPulse = true;
          state.chunkAnimation++;
          room.later(() => { state.chunkPulse = false; }, 500);
          state.paused = false;
        });
        scheduler.start();
      };
      raw.onclose = () => {
        ui.setDcStatus('closed');
        releaseChannel();
      };
    };
  }

  // Waiting for media is presentation/session work, unlike a submitted wallet
  // operation. Disposal resolves outstanding waits and stops their timers.
  const mediaWaits = new Set<() => void>();
  async function waitForMedia(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (active() && localStream === null && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const finish = (): void => { mediaWaits.delete(finish); resolve(); };
        mediaWaits.add(finish);
        room.later(finish, 100);
      });
    }
  }

  async function handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (sessionId === null) {
      ui.showError('Offer received but no sessionId');
      return;
    }
    if (!await decision || !active()) return;
    if (localStream === null) {
      ui.setStatus('offer received -- waiting for local media…');
      await waitForMedia();
    }
    if (!active()) return;
    if (localStream === null) {
      ui.showError('Local media stream unavailable -- cannot answer offer');
      return;
    }
    ui.setStatus('offer received -- creating answer…');
    stopCountdown();
    state.lowFunds = 'normal';
    releaseChannel();
    dataChannel = null;
    try {
      const answer = await peer.handleOffer(offer, localStream);
      if (!active()) return;
      client.send({ type: 'answer', sessionId, sdp: answer });
      ui.setStatus('answer sent -- waiting for ICE…');
      state.exitVisible = true;
    } catch (error) {
      if (active()) ui.showError(`Failed to handle offer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setupPeer();
  client.onConnect(() => {
    if (!active()) return;
    ui.hideReconnectOverlay();
    if (sessionId === null) {
      ui.showError('No session ID found in URL. Add ?session=<id> to the URL.');
      ui.setStatus('error -- no session ID');
      return;
    }
    ui.setStatus(confirmationShown ? 'connected -- awaiting your confirmation…' : 'connected -- loading session info…');
    client.send({ type: 'join_session', sessionId });
    client.setSessionId(sessionId);
    if (payments.getBalance() === 0) {
      state.toast = true;
      room.later(() => { state.toast = false; }, 8000);
    }
    void decision.then(accepted => {
      if (!active()) return;
      if (!accepted) {
        cancelledJoin();
        return;
      }
      const existing = loadSession();
      const same = existing !== null && existing.sessionId === sessionId;
      saveSession({
        sessionId,
        peerId: same ? existing.peerId ?? '' : '',
        role: 'viewer',
        chunkCount: same ? existing.chunkCount ?? 0 : 0,
        totalSatsPaid: same ? existing.totalSatsPaid ?? 0 : 0,
        ...(same && typeof existing.freeEndsAt === 'number' ? { freeEndsAt: existing.freeEndsAt } : {}),
      });
      ui.setStatus('joining session…');
      void startMedia();
    });
  });
  client.onDisconnecting(() => {
    ui.showReconnectOverlay();
    ui.setStatus('reconnecting…');
    scheduler?.stop();
  });
  client.onDisconnect(() => {
    ui.setStatus('disconnected');
    scheduler?.stop();
  });
  client.onReconnected(() => {
    ui.hideReconnectOverlay();
    const saved = loadSession();
    ui.setStatus(saved ? `reconnected -- session ${saved.sessionId}` : 'reconnected');
    if (saved) state.sessionDisplay = `Session: ${saved.sessionId}`;
  });
  client.onMessage(message => {
    if (!active()) return;
    switch (message.type) {
      case 'session_created':
        if (message.iceServers && message.iceServers.length > 0) peer.useIceServers(message.iceServers);
        try {
          services.validateMint(message.mintUrl);
        } catch (error) {
          if (error instanceof MintMismatchError) {
            state.sessionMint = error.sessionMintUrl;
            state.mismatch = true;
            return;
          }
          throw error;
        }
        if (typeof message.rateSatsPerInterval === 'number') rate = message.rateSatsPerInterval;
        if (typeof message.intervalSeconds === 'number') interval = message.intervalSeconds;
        if (typeof message.freeSeconds === 'number' && Number.isFinite(message.freeSeconds)) {
          freeSeconds = Math.max(0, Math.floor(message.freeSeconds));
        }
        showConfirm(rate, interval, message.mintUrl);
        void decision.then(accepted => {
          if (!accepted || !active()) return;
          ui.setStatus('preparing wallet…');
          // Once preparation starts, its own wallet rollback/completion remains
          // independent of this view. Only late status/error display is suppressed.
          void payments.prepare(rate).then(() => {
            if (active() && !tutorOfferArrived) ui.setStatus('wallet ready — waiting for tutor…');
          }).catch(error => {
            if (active()) ui.showError(`Pre-split failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        });
        break;
      case 'offer':
        tutorOfferArrived = true;
        void handleOffer(message.sdp as RTCSessionDescriptionInit);
        break;
      case 'ice_candidate':
        void peer.addIceCandidate(message.candidate as RTCIceCandidateInit);
        break;
      case 'error':
        ui.showError(`Signaling error: ${message.code}${message.message !== undefined ? ' -- ' + message.message : ''}`);
        break;
      case 'session_ended':
        endSession();
        break;
    }
  });

  room.onDispose(() => {
    ended = true;
    decide(false);
    for (const finish of mediaWaits) finish();
    stopCountdown();
    releaseChannel();
    stopMedia();
    client.disconnect();
  });

  return {
    leave() {
      if (sessionId !== null) client.send({ type: 'end_session', sessionId });
      endSession();
    },
    acceptJoin() { decide(true); },
    cancelJoin() { decide(false); },
    start() {},
    invoiceChanged() {},
    async payInvoice() {},
    finishCeremony() {},
  };
}
