<script setup lang="ts">
import { computed } from 'vue';
import { formatElapsed, useRoom, type RoomServices } from './use-room.js';

const props = defineProps<{
  services: RoomServices;
  search: string;
}>();

const {
  state: r,
  effectiveRate,
  feePercent,
  feeWarning,
  joinPerMinute,
  copyInvite,
  closeSummary,
  start,
  leave,
  acceptJoin,
  cancelJoin,
  invoiceChanged,
  payInvoice,
  finishCeremony,
} = useRoom(props.services, props.search);

const cashoutAvailable = computed(() => {
  const funds = r.cashoutFunds;
  if (!funds) return 0;
  return Math.max(0, (r.summarySats ?? 0) - funds.meltFee - funds.lightning);
});
</script>

<template>
  <h1>Satstreamr — Room</h1>
  <div class="status-bar">
    <span id="status">{{ r.status }}</span>
    <span class="status-sep">&middot;</span>
    <span id="dc-status">payment channel: {{ r.dcStatus }}</span>
  </div>
  <p id="session-display">{{ r.sessionDisplay }}</p>

  <div id="rate-config" class="rate-config-card" v-show="r.rateVisible">
    <h2>Session Rate</h2>
    <div class="rate-config-row">
      <div class="rate-inputs-group">
        <label class="rate-config-label">
          Sats per payment
          <input type="number" id="rate-sats-input" v-model="r.rateSats" min="1" class="rate-config-input" />
        </label>
        <label class="rate-config-label">
          Interval (seconds)
          <input type="number" id="rate-interval-input" v-model="r.rateInterval" min="5" class="rate-config-input" />
        </label>
        <label class="rate-config-label">
          Free at the start (seconds)
          <input type="number" id="free-seconds-input" v-model="r.freeSeconds" min="0" class="rate-config-input" />
        </label>
      </div>
      <div class="rate-derived-group">
        <div class="effective-rate">
          <span class="derived-label">Effective rate</span>
          <span class="derived-value"><strong id="effective-rate-display">{{ effectiveRate }}</strong> <span class="sat">S</span>/min</span>
        </div>
        <div class="fee-overhead">
          <span class="derived-label">Fee overhead</span>
          <span class="derived-value" id="fee-overhead-display" :class="{ warn: feeWarning }">
            <template v-if="r.feeUnavailable">unavailable</template>
            <template v-else-if="r.receiptFee === 0">none</template>
            <template v-else>~{{ r.receiptFee }} <span class="sat">S</span>/cycle (~{{ feePercent }}%)</template>
          </span>
          <button id="fee-info-btn" type="button" class="info-icon-btn" aria-label="Fee info" @click="r.feeInfoOpen = !r.feeInfoOpen">i</button>
        </div>
      </div>
    </div>
    <div id="fee-info-panel" class="fee-info-panel" :class="{ open: r.feeInfoOpen }">
      Each payment cycle, the viewer sends a Cashu token which the streamer swaps with the mint to claim. This swap incurs a small fee. Larger payments per cycle reduce the fee overhead percentage.
    </div>
    <button id="start-session-btn" type="button" class="btn-primary" :disabled="r.startDisabled" @click="start">Start Session</button>
  </div>

  <div id="invite-section" class="invite-card" :style="{ display: r.inviteVisible ? 'block' : 'none' }">
    <h2>Share Session</h2>
    <p class="invite-label">Session code (read aloud):</p>
    <div id="invite-session-id" class="invite-code">{{ r.inviteId }}</div>
    <p class="invite-label">Invite link:</p>
    <div id="invite-url" class="invite-url">{{ r.inviteUrl }}</div>
    <button id="copy-invite-btn" type="button" class="btn-invite" @click="copyInvite">{{ r.inviteCopied ? 'Copied!' : 'Copy Invite Link' }}</button>
  </div>

  <div id="tutor-stats" :style="{ display: r.role === 'tutor' && r.statsVisible ? 'flex' : 'none' }">
    <div>
      <span class="stat-label">Session time</span>
      <span class="stat-value" id="elapsed-time">{{ r.elapsed }}</span>
    </div>
    <div>
      <span class="stat-label"><span class="sat">S</span> received</span>
      <span class="stat-value" id="sats-received" :key="r.paymentAnimation" :class="{ 'payment-highlight': r.paymentAnimation > 0 }">{{ r.satsReceived }}<span v-if="r.paymentFloat !== null" class="payment-float">+{{ r.paymentFloat }} <span class="sat">S</span></span></span>
    </div>
  </div>

  <div id="viewer-stats" :style="{ display: r.role === 'viewer' && r.statsVisible ? 'flex' : 'none' }">
    <div>
      <span class="stat-label">Remaining budget</span>
      <span id="budget-display" :class="{ warning: r.lowFunds === 'warning', countdown: r.lowFunds === 'countdown' }"><template v-if="r.budget !== null">{{ r.budget }} <span class="sat">S</span></template><template v-else>—</template></span>
      <span id="chunk-indicator" :key="r.chunkAnimation" :class="{ pulse: r.chunkPulse }" title="Payment sent"></span>
    </div>
    <div>
      <span class="stat-label">Est. duration</span>
      <span id="est-duration-display">{{ r.duration }}</span>
    </div>
    <div v-if="r.freePreview && r.freeRemaining > 0" id="free-preview" role="progressbar" aria-valuemin="0" :aria-valuenow="r.freeRemaining" :aria-valuemax="r.freePreview.totalSecs" aria-label="Free time left">
      <div class="free-preview-head">
        <span class="stat-label">Free time</span>
        <span id="free-preview-remaining">{{ formatElapsed(r.freeRemaining) }}</span>
      </div>
      <div class="free-preview-track">
        <div id="free-preview-fill" :class="{ warn: r.freeRemaining <= 10 }" :style="{ width: `${r.freeRemaining / r.freePreview.totalSecs * 100}%` }"></div>
      </div>
    </div>
  </div>

  <button id="exit-session-btn" type="button" class="btn-exit" :style="{ display: r.exitVisible ? 'inline-block' : 'none' }" @click="leave">Leave Session</button>
  <div id="payment-paused-banner" :class="{ visible: r.paused }">Payment paused</div>
  <div id="budget-low-banner" :class="{ 'warning-phase': r.lowFunds === 'warning', 'countdown-phase': r.lowFunds === 'countdown' }">
    <span id="budget-low-text">{{ r.lowFunds === 'countdown' ? 'Ending in' : 'Low balance — session will end soon' }}</span>
    <span id="countdown-display"><template v-if="r.countdown !== null"><span class="count-digit" :key="r.countdown">{{ r.countdown }}</span>s</template></span>
  </div>
  <div id="error" :style="{ display: r.error ? 'block' : 'none' }">{{ r.error }}</div>

  <div id="go-live-overlay" :class="{ visible: r.goLive, 'fade-out': r.goLiveFade }" role="status" aria-live="assertive" @animationend.self="finishCeremony">
    <div id="go-live-content">
      <div id="go-live-count"><span v-if="r.goLiveDigit !== null" class="count-digit" :key="r.goLiveDigit">{{ r.goLiveDigit }}</span></div>
      <div id="go-live-label" :class="{ visible: r.goLiveLabel }">GO LIVE</div>
    </div>
  </div>

  <div id="join-confirm-overlay" :class="{ hidden: !r.joinVisible }" role="alertdialog" aria-modal="true" aria-labelledby="join-confirm-title">
    <div class="join-confirm-card">
      <h2 id="join-confirm-title">Confirm Join</h2>
      <p id="join-confirm-free" class="join-confirm-intro" v-show="r.joinFreeSeconds > 0">Free for {{ r.joinFreeSeconds }}s, then the rate below.</p>
      <p class="join-confirm-intro">The streamer is charging:</p>
      <div class="join-confirm-rate-hero">
        <span id="join-confirm-rate"><strong>{{ r.joinRate }}</strong> <span class="sat">S</span> every <strong>{{ r.joinInterval }}</strong>s</span>
        <span class="join-confirm-rate-per-min" id="join-confirm-rate-per-min"><template v-if="joinPerMinute">= {{ joinPerMinute }} <span class="sat">S</span>/min</template></span>
      </div>
      <div class="join-confirm-details">
        <div class="join-confirm-row">
          <span class="label">Your balance</span>
          <span class="value" id="join-confirm-balance">{{ r.joinBalance.toLocaleString() }} <span class="sat">S</span></span>
        </div>
        <div class="join-confirm-row">
          <span class="label">Watch time</span>
          <span class="value" id="join-confirm-duration"><span v-if="r.joinBalance === 0" class="warn">{{ r.joinDuration }}</span><template v-else>{{ r.joinDuration }}</template></span>
        </div>
        <div class="join-confirm-row join-confirm-mint-row">
          <span class="label">Mint</span>
          <span class="value mint"><code id="join-confirm-mint">{{ r.joinMint }}</code></span>
        </div>
      </div>
      <p class="join-confirm-fine-print">
        You will only be charged after you accept and the session starts. Cancel to return home — nothing will be charged.
      </p>
      <div class="join-confirm-actions">
        <button id="join-confirm-cancel" type="button" class="btn-join-cancel" @click="cancelJoin">Cancel</button>
        <button id="join-confirm-accept" ref="joinAccept" type="button" class="btn-join-accept" @click="acceptJoin">Accept &amp; Join</button>
      </div>
    </div>
  </div>

  <div id="mint-mismatch-overlay" :class="{ hidden: !r.mismatch }" role="alertdialog" aria-modal="true" aria-labelledby="mint-mismatch-title">
    <div class="mint-mismatch-card">
      <h2 id="mint-mismatch-title">Mint Mismatch</h2>
      <p>This session requires mint: <code id="session-mint-url">{{ r.sessionMint }}</code></p>
      <p>Your configured mint: <code id="local-mint-url">{{ services.mintUrl }}</code></p>
      <p>Update your <code>VITE_MINT_URL</code> to join this session.</p>
    </div>
  </div>

  <div id="session-summary-overlay" :class="{ visible: r.summaryVisible }" role="dialog" aria-modal="true" aria-labelledby="summary-title">
    <div id="session-summary-card">
      <h2 id="summary-title">Session ended</h2>
      <div class="summary-row">
        <span class="label">Duration</span>
        <span class="value" id="summary-duration">{{ r.summaryDuration }}</span>
      </div>
      <div class="summary-row">
        <span class="label">Total <span class="sat">S</span> exchanged</span>
        <span class="value" id="summary-sats">{{ r.summarySats ?? '—' }}</span>
      </div>
      <template v-if="r.cashoutFunds">
        <div class="summary-row deduction">
          <span class="label">Melt fee</span>
          <span class="value" id="summary-melt-fee">−{{ r.cashoutFunds.meltFee }} <span class="sat">S</span></span>
        </div>
        <div class="summary-row deduction">
          <span class="label">Lightning reserve</span>
          <span class="value" id="summary-lightning">−{{ r.cashoutFunds.lightning }} <span class="sat">S</span></span>
        </div>
        <div class="summary-row available">
          <span class="label">Available</span>
          <span class="value" id="summary-available">{{ r.cashoutFunds.estimated ? '~' : '' }}{{ cashoutAvailable }} <span class="sat">S</span></span>
        </div>
      </template>
      <div id="cashout-section">
        <h3>Cash Out</h3>
        <div id="invoice-input-row">
          <input type="text" id="invoice-input" v-model="r.invoice" placeholder="Paste Lightning invoice (lnbcrt…)" @input="invoiceChanged" />
          <span id="invoice-countdown" :style="{ color: r.invoiceUrgent ? '#dc2626' : '' }">{{ r.invoiceCountdown }}</span>
        </div>
        <button id="pay-invoice-btn" type="button" :disabled="r.cashoutDisabled" @click="payInvoice">Pay Invoice</button>
        <div id="cashout-status" :style="{ color: r.cashoutError ? '#dc2626' : '' }"><template v-if="r.cashoutAmount !== null">Paying {{ r.cashoutAmount }} <span class="sat">S</span></template><template v-else>{{ r.cashoutStatus }}</template></div>
      </div>
      <button id="summary-close-btn" type="button" @click="closeSummary">Close</button>
    </div>
  </div>

  <!-- Never conditionally mount or key these nodes: srcObject belongs to the
       existing media/peer lifecycle, not reactive text/overlay updates. -->
  <div class="video-row">
    <div class="video-wrap-remote">
      <label>Remote</label>
      <video id="remote-video" ref="remoteVideo" autoplay playsinline></video>
    </div>
    <div class="video-wrap-local">
      <label>You</label>
      <video id="local-video" ref="localVideo" muted autoplay playsinline></video>
    </div>
  </div>

  <div id="reconnect-overlay" :style="{ display: r.reconnecting ? 'flex' : 'none' }" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);color:#fff;font-size:1.5rem;align-items:center;justify-content:center;z-index:9999;">reconnecting…</div>
  <div id="toast-container">
    <Transition name="room-toast">
      <div v-if="r.toast" class="toast toast-warning toast-visible" role="alert">Your wallet is empty. Fund your wallet before joining a session.</div>
    </Transition>
  </div>
</template>
