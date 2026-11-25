import type { CashOut, CashOutQuote } from '../payments/session-payments.js';
import type { DataChannel } from '../lib/data-channel.js';
import { saveSession, loadSession, clearSession } from '../lib/session-storage.js';
import { createInviteUrl } from '../lib/session-invite.js';
import { wireSharedPeerHandlers } from '../lib/peer-setup.js';
import { formatElapsed, type RoomActions, type RoomContext } from './use-room.js';

/** Tutor orchestration retains the existing receipt, signaling and cash-out order. */
export function useTutor(room: RoomContext): RoomActions {
  const { state, services, ui } = room;
  const client = services.createClient();
  let peer = services.createPeer();
  let localStream: MediaStream | null = null;
  let dataChannel: DataChannel | null = null;
  let signalingReady = false;
  let startRequested = false;
  let ended = false;
  let totalSats = 0;
  let totalChunks = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let invoiceTimer: ReturnType<typeof setInterval> | undefined;
  let cashOut: CashOut | undefined;
  let finishGoLive: (() => void) | undefined;

  const active = (): boolean => room.alive() && !ended;
  const receiver = services.createReceiver({
    sendMessage(message) {
      // Disposal closes the view's channel, but must not make a pending claim
      // throw before the wallet credits its proofs. Mounted receipt ordering is unchanged.
      if (room.alive()) dataChannel!.sendMessage(message);
    },
    onReceived(amount) {
      totalSats += amount;
      totalChunks++;
      if (!active()) return;
      state.satsReceived = totalSats;
      state.paymentFloat = amount;
      const animation = ++state.paymentAnimation;
      room.later(() => {
        // Replaced badges own their timeout; an old receipt must not erase a new one.
        if (state.paymentAnimation === animation) state.paymentFloat = null;
      }, 750);
    },
    onReady() { if (active()) state.paused = false; },
  });

  function stopElapsed(): void {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }

  function clearInvoiceCountdown(): void {
    clearInterval(invoiceTimer);
    invoiceTimer = undefined;
    state.invoiceCountdown = '';
    state.invoiceUrgent = false;
  }

  function stopMedia(): void {
    peer.close();
    localStream?.getTracks().forEach(track => track.stop());
  }

  async function startMedia(): Promise<void> {
    try {
      const stream = await peer.initMedia();
      // A permission prompt can resolve after Leave/unmount. Do not leak tracks.
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

  function endSession(): void {
    ended = true;
    stopMedia();
    stopElapsed();
    finishGoLive?.();
    state.goLive = false;
    state.exitVisible = false;
    if (!state.summaryVisible) {
      room.showSummary(totalSats, totalChunks);
      // Preserve capture-at-summary semantics rather than capturing at Pay.
      cashOut = services.wallet.createCashOut();
    }
  }

  function sendCreateSession(): void {
    ui.setStatus('connected -- creating session…');
    client.send({ type: 'create_session', mintUrl: services.mintUrl, ...room.getRate() });
  }

  function playCeremony(): Promise<void> {
    return new Promise(resolve => {
      let finished = false;
      finishGoLive = () => {
        if (finished) return;
        finished = true;
        state.goLive = false;
        state.goLiveFade = false;
        resolve();
      };
      state.goLive = true;
      state.goLiveLabel = false;
      const steps = [3, 2, 1];
      let index = 0;
      const next = (): void => {
        if (!active()) return;
        if (index < steps.length) {
          state.goLiveDigit = steps[index++]!;
          room.later(next, 700);
        } else {
          state.goLiveDigit = null;
          state.goLiveLabel = true;
          room.later(() => {
            state.goLiveFade = true;
            room.later(() => finishGoLive?.(), 500);
          }, 800);
        }
      };
      next();
    });
  }

  function sessionCreated(id: string): void {
    state.sessionId = id;
    state.rateVisible = false;
    client.setSessionId(id);
    saveSession({ sessionId: id, peerId: '', role: 'tutor', chunkCount: 0, totalSatsPaid: 0 });
    const invite = createInviteUrl({ sessionId: id, mintUrl: services.mintUrl, ...room.getRate() });

    // Media permission and ceremony run in parallel, as before.
    void startMedia();
    void playCeremony().then(() => {
      if (!active()) return;
      state.inviteId = id;
      state.inviteUrl = invite;
      state.inviteVisible = true;
      state.exitVisible = true;
      ui.setStatus('session created -- waiting for viewer…');
    });
  }

  function setupPeer(): void {
    wireSharedPeerHandlers(peer, () => state.sessionId, client, ui.setStatus, room.remoteVideo());
    peer.onDataChannel = event => {
      if (!active()) return;
      dataChannel = services.createChannel(event.channel);
      ui.setDcStatus('open');
      if (elapsedTimer === undefined) {
        room.startTimer();
        elapsedTimer = setInterval(() => { state.elapsed = formatElapsed(room.elapsedSeconds()); }, 1000);
      }
      room.showStats();
      state.paused = false;

      event.channel.onclose = () => {
        ui.setDcStatus('closed');
        stopElapsed();
      };
      dataChannel.onMessage(message => {
        if (!active()) return;
        if (message.type === 'session_paused') {
          state.paused = true;
          return;
        }
        if (message.type === 'token_payment' && dataChannel !== null) {
          // Already-started receipt/credit remains wallet-owned after teardown.
          void receiver.receive(message.chunkId, message.encodedToken);
        }
      });
    };
  }

  async function viewerJoined(): Promise<void> {
    if (state.sessionId === null) {
      ui.showError('viewer_joined received but sessionId is unknown');
      return;
    }
    if (localStream === null) {
      ui.showError('viewer_joined received but local media stream not ready');
      return;
    }
    ui.setStatus('viewer joined -- creating offer…');
    peer.close();
    peer = services.createPeer();
    setupPeer();
    receiver.reset();
    dataChannel = null;

    try {
      // The payment channel must be negotiated before the initial offer.
      peer.createPaymentChannel();
      ui.setDcStatus('connecting…');
      const offer = await peer.createOffer(localStream);
      if (!active()) return;
      client.send({ type: 'offer', sessionId: state.sessionId, sdp: offer });
      ui.setStatus('offer sent -- waiting for answer…');
    } catch (error) {
      if (active()) ui.showError(`Failed to create offer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function setCashoutStatus(text: string, error = false): void {
    if (!room.alive()) return;
    state.cashoutStatus = text;
    state.cashoutError = error;
    state.cashoutAmount = null;
  }

  function validInvoice(invoice: string): boolean {
    const prefix = services.isDev ? 'lnbcrt' : 'lnbc';
    if (invoice.toLowerCase().startsWith(prefix)) return true;
    setCashoutStatus(`Invalid invoice — expected a ${services.isDev ? 'regtest' : 'mainnet'} invoice (${prefix}…)`, true);
    return false;
  }

  function invoiceChanged(): void {
    if (!cashOut) return;
    clearInvoiceCountdown();
    setCashoutStatus('');
    const invoice = state.invoice.trim();
    if (!invoice || !validInvoice(invoice)) return;
    let remaining = 600;
    state.invoiceCountdown = '600s';
    invoiceTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInvoiceCountdown();
        state.invoiceCountdown = 'expired';
        state.invoiceUrgent = true;
      } else {
        state.invoiceCountdown = `${remaining}s`;
        state.invoiceUrgent = remaining <= 60;
      }
    }, 1000);
  }

  async function payInvoice(): Promise<void> {
    if (!cashOut || state.cashoutDisabled) return;
    const invoice = state.invoice.trim();
    if (!invoice) {
      setCashoutStatus('Please paste a Lightning invoice first.', true);
      return;
    }
    if (!validInvoice(invoice)) return;
    if (!cashOut.hasFunds) {
      setCashoutStatus('No accumulated proofs to pay with.', true);
      return;
    }
    state.cashoutDisabled = true;
    setCashoutStatus('Fetching quote…');
    let quote: CashOutQuote;
    try {
      quote = await cashOut.quote(invoice);
    } catch (error) {
      setCashoutStatus(error instanceof Error ? error.message : String(error), true);
      if (room.alive()) state.cashoutDisabled = false;
      return;
    }
    if (room.alive()) {
      state.cashoutStatus = '';
      state.cashoutAmount = quote.amount;
      state.cashoutFee = quote.feeReserve + quote.inputFee;
    }

    // View disposal cannot abandon a submitted quote/payment. Only presentation
    // updates are gated; the application interface retains settlement ownership.
    try {
      const result = await quote.pay();
      if (!room.alive()) return;
      if (result.paid) {
        clearInvoiceCountdown();
        state.invoice = '';
        const note = result.changeSats > 0 ? ` (${result.changeSats} sats fee change returned)` : '';
        setCashoutStatus(`✓ Payment sent!${note}`);
      } else {
        setCashoutStatus('Payment not confirmed by mint. Please retry.', true);
        state.cashoutDisabled = false;
      }
    } catch (error) {
      setCashoutStatus(error instanceof Error ? error.message : String(error), true);
      if (room.alive()) state.cashoutDisabled = false;
    }
  }

  setupPeer();
  void services.wallet.estimateReceiptFee().then(fee => {
    if (room.alive()) state.receiptFee = fee;
  }).catch(error => {
    console.warn('[tutor] could not fetch mint fee info:', error);
    if (room.alive()) state.feeUnavailable = true;
  });

  client.onConnect(() => {
    if (!active()) return;
    ui.hideReconnectOverlay();
    const existing = loadSession();
    if (existing !== null) {
      client.setSessionId(existing.sessionId);
      ui.setStatus('reconnecting -- rejoining session…');
      client.send({ type: 'rejoin_session', sessionId: existing.sessionId });
    } else {
      signalingReady = true;
      ui.setStatus('connected -- configure rate and click Start Session');
      if (startRequested) sendCreateSession();
    }
  });
  client.onDisconnecting(() => {
    ui.showReconnectOverlay();
    ui.setStatus('reconnecting…');
  });
  client.onDisconnect(() => ui.setStatus('disconnected'));
  client.onReconnected(() => {
    ui.hideReconnectOverlay();
    const saved = loadSession();
    ui.setStatus(saved ? `reconnected -- session ${saved.sessionId}` : 'reconnected');
  });
  client.onMessage(message => {
    if (!active()) return;
    switch (message.type) {
      case 'session_created':
        sessionCreated(message.sessionId);
        break;
      case 'viewer_joined':
        void viewerJoined();
        break;
      case 'answer':
        void peer.handleAnswer(message.sdp as RTCSessionDescriptionInit);
        break;
      case 'ice_candidate':
        void peer.addIceCandidate(message.candidate as RTCIceCandidateInit);
        break;
      case 'session_ended':
        endSession();
        break;
      case 'error':
        if (message.code === 'SESSION_NOT_FOUND') {
          clearSession();
          signalingReady = true;
          ui.setStatus('connected -- configure rate and click Start Session');
          if (startRequested) sendCreateSession();
        } else {
          console.error('[tutor] signaling error:', message.code, message.message);
        }
        break;
      case 'session_rejoined':
        state.sessionId = message.sessionId;
        client.setSessionId(message.sessionId);
        saveSession({ sessionId: message.sessionId, peerId: '', role: 'tutor', chunkCount: totalChunks, totalSatsPaid: totalSats });
        state.rateVisible = false;
        state.exitVisible = true;
        ui.setStatus('rejoined session — starting media…');
        localStream?.getTracks().forEach(track => track.stop());
        localStream = null;
        void startMedia().then(() => { if (active() && localStream) void viewerJoined(); });
        break;
    }
  });

  room.onDispose(() => {
    ended = true;
    stopElapsed();
    clearInvoiceCountdown();
    finishGoLive?.();
    stopMedia();
    client.disconnect();
  });

  return {
    start() {
      state.startDisabled = true;
      startRequested = true;
      if (signalingReady) sendCreateSession();
      else ui.setStatus('connecting… session will start when ready');
    },
    leave() {
      if (state.sessionId !== null) client.send({ type: 'end_session', sessionId: state.sessionId });
      endSession();
    },
    invoiceChanged,
    payInvoice,
    finishCeremony() { if (state.goLiveFade) finishGoLive?.(); },
    acceptJoin() {},
    cancelJoin() {},
  };
}
