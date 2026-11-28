<script setup lang="ts">
import type { HomeWallet } from '../payments/home-wallet.js';
import { useHome } from './use-home.js';

const buildStamp = __BUILD_STAMP_LABEL__;

const props = defineProps<{
  wallet: HomeWallet;
  navigate: (url: string) => void;
  search: string;
}>();

const {
  state: h,

  openDeposit,
  closeDeposit,
  resetAndFocus,
  generateInvoice,
  copy,

  openWithdraw,
  closeWithdraw,
  payInvoice,

  startStreaming,
  join,
  joinInvite,
  formatDate,
  formatDuration,
} = useHome(props.wallet, props.navigate, props.search);
</script>

<template>
  <h1>Satstreamr</h1>
  <p class="tagline">Earn sats per minute, streaming video over Lightning</p>

  <!-- Wallet widget -->
  <div id="wallet-widget">
    <div class="wallet-label">Wallet Balance</div>
    <div id="balance-display">{{ h.wallet.balance.toLocaleString() }} <span class="sat">S</span></div>
    <div class="wallet-actions">
      <button class="wallet-btn" id="deposit-btn" type="button" @click="openDeposit">Deposit</button>
      <button class="wallet-btn" id="withdraw-btn" type="button" @click="openWithdraw">Withdraw</button>
    </div>
  </div>

  <!-- Cashu denomination details are display data, not proofs. -->
  <div id="token-details-wrapper">
    <button id="token-details-toggle" type="button" @click="h.detailsOpen = !h.detailsOpen">{{ h.detailsOpen ? 'Hide token details' : 'Show token details' }}</button>
    <div id="token-details-panel" :class="{ 'is-open': h.detailsOpen }">
      <table id="token-details-table">
        <thead>
          <tr><th>Denomination</th><th>Count</th><th>Subtotal</th></tr>
        </thead>
        <tbody>
          <tr v-if="h.wallet.cashu.proofCount === 0"><td colspan="3" style="color:#6b7280;font-style:italic;padding:0.4rem 0.5rem;">No tokens in wallet</td></tr>
          <tr v-for="group in h.wallet.cashu.denominations" :key="group.amount">
            <td>{{ group.amount }} <span class="sat">S</span></td>
            <td>{{ group.count }}</td>
            <td>{{ group.subtotal }} <span class="sat">S</span></td>
          </tr>
        </tbody>
      </table>
      <div id="token-details-summary">
        <template v-if="h.wallet.cashu.proofCount">Total: {{ h.wallet.balance }} <span class="sat">S</span> ({{ h.wallet.cashu.proofCount }} proof{{ h.wallet.cashu.proofCount === 1 ? '' : 's' }})</template>
      </div>
    </div>
  </div>

  <div id="withdraw-panel" :style="{ display: h.withdrawOpen ? 'block' : 'none' }">
    <h2>Withdraw via Lightning</h2>
    <div id="withdraw-max-estimate" aria-live="polite" :style="{ display: h.estimate && h.estimate.balance > 0 ? 'block' : 'none' }">
      <template v-if="h.estimate && h.estimate.balance > 0">
        <div v-if="h.estimate.maxAmount <= 0" class="max-main">Balance: {{ h.estimate.balance }} <span class="sat">S</span> — fees may exceed this, but try with a small invoice.</div>
        <template v-else>
          <div class="max-main">
            <span class="max-amount">Maximum withdrawable amount: ~{{ h.estimate.maxAmount }} <span class="sat">S</span></span>
            <button class="copy-amount-btn" type="button" @click="copy('amount')">{{ h.amountCopied ? 'Copied!' : 'Copy' }}</button>
          </div>
          <div class="max-breakdown">
            {{ h.estimate.balance }} <span class="sat">S</span> balance
            − {{ h.estimate.inputFee }} <span class="sat">S</span> proof fee
            − {{ h.estimate.lightningBuffer }} <span class="sat">S</span> lightning buffer
          </div>
        </template>
      </template>
    </div>
    <textarea
      id="withdraw-invoice-input"
      ref="withdrawInvoiceInput"
      v-model="h.withdrawInvoice"
      placeholder="Paste Lightning invoice here"
      autocomplete="off"
      spellcheck="false"
      rows="3"
    ></textarea>
    <div id="withdraw-status" :class="h.withdrawStatus ? `status-${h.withdrawStatus.variant}` : ''" :style="{ display: h.withdrawStatus ? 'block' : 'none' }">{{ h.withdrawStatus?.message }}</div>
    <div class="withdraw-actions">
      <button class="btn-withdraw btn-withdraw-primary" id="withdraw-pay-btn" type="button" :disabled="h.withdrawBusy || h.withdrawStatus?.variant === 'success'" @click="payInvoice">Pay Invoice</button>
      <button class="btn-withdraw btn-withdraw-ghost" id="withdraw-close-btn" type="button" @click="closeWithdraw">Close</button>
    </div>
  </div>

  <div id="invite-panel" :style="{ display: h.hasInvite ? 'block' : 'none' }">
    <h2>Session Invite</h2>
    <p>You received an invite link. Session details:</p>
    <div id="invite-decode-error" :style="{ display: h.hasInvite && !h.invite ? 'block' : 'none' }">
      <template v-if="h.hasInvite && !h.invite">Failed to decode invite link — the base64 payload is invalid or missing required fields.</template>
    </div>
    <div id="invite-json">
      <template v-if="h.invite">
        <strong>Rate:</strong> {{ h.invite.rateSatsPerInterval }} <span class="sat">S</span> every {{ h.invite.intervalSeconds }} seconds<br>
        <strong>Mint:</strong> {{ h.invite.mintUrl }}<br>
        <strong>Your balance:</strong> {{ h.wallet.balance }} <span class="sat">S</span>
        <template v-if="h.wallet.balance > 0"> (~{{ h.invite.rateSatsPerInterval > 0 ? Math.floor((h.wallet.balance / h.invite.rateSatsPerInterval) * (h.invite.intervalSeconds / 60)) : 0 }} min)</template>
        <template v-else> (deposit first)</template>
      </template>
    </div>
    <button class="btn-primary" id="invite-join-btn" type="button" style="margin-top:0.75rem;padding:0.65rem 1.6rem;font-size:1.05rem;" @click="joinInvite">Join This Session</button>
  </div>

  <div class="section-card">
    <h2>Start Streaming</h2>
    <p>Share your screen or camera and receive sats per minute from viewers.</p>
    <button class="btn-primary" id="start-streaming-btn" type="button" @click="startStreaming">Start Streaming</button>
  </div>

  <div class="section-card">
    <h2>Join a Stream</h2>
    <p>Enter the session ID shared by the streamer to join and watch.</p>
    <div id="join-form">
      <input
        type="text"
        id="session-id-input"
        ref="sessionInput"
        v-model="h.sessionId"
        placeholder="Session ID"
        autocomplete="off"
        spellcheck="false"
        @input="h.joinError = ''"
        @keydown.enter="join"
      />
      <button class="btn-primary" id="join-btn" type="button" @click="join">Join</button>
    </div>
    <div id="join-error" :style="{ display: h.joinError ? 'block' : 'none' }">{{ h.joinError }}</div>
  </div>

  <section id="session-history-section">
    <div id="session-history-list">
      <p v-if="!h.history.length" class="session-history-empty">No sessions yet.</p>
      <template v-else>
        <p class="session-history-heading">Recent Sessions</p>
        <div v-for="(record, index) in h.history" :key="index" class="session-history-row">
          <span class="session-history-date">{{ formatDate(record.startedAt) }}</span>
          <span class="session-history-badge" :class="record.role">{{ record.role.toLowerCase() === 'tutor' ? 'Earned' : 'Spent' }}</span>
          <span class="session-history-duration">{{ formatDuration(record.durationSeconds) }}</span>
          <span class="session-history-sats">{{ record.totalSats.toLocaleString() }} <span class="sat">S</span></span>
        </div>
      </template>
    </div>
  </section>

  <div id="deposit-overlay" :class="{ 'is-open': h.depositOpen }" role="dialog" aria-modal="true" aria-labelledby="deposit-panel-title" @click.self="closeDeposit">
    <div id="deposit-panel" ref="depositPanel">
      <h2 id="deposit-panel-title">Deposit via Lightning</h2>
      <div id="deposit-amount-row">
        <input
          type="number"
          id="deposit-amount-input"
          ref="depositAmountInput"
          v-model="h.amount"
          :disabled="h.depositBusy && !!h.invoice"
          placeholder="Amount"
          min="1"
          step="1"
          aria-label="Amount in satoshis"
        />
        <button class="btn-primary" id="deposit-generate-btn" type="button" :disabled="h.depositBusy" @click="generateInvoice">Generate Invoice</button>
      </div>

      <div id="deposit-invoice-area" :class="{ 'is-visible': !!h.invoice }" aria-live="polite">
        <canvas id="deposit-qr-canvas" ref="qrCanvas" aria-label="Lightning invoice QR code"></canvas>
        <pre id="deposit-invoice-text">{{ h.invoice }}</pre>
        <button id="deposit-copy-btn" type="button" @click="copy('invoice')">{{ h.invoiceCopied ? 'Copied!' : 'Copy Invoice' }}</button>
      </div>

      <div id="deposit-success-area" :class="{ 'is-visible': h.celebrating }" aria-live="polite">
        <svg id="deposit-checkmark" viewBox="0 0 80 80" width="100" height="100" aria-label="Payment confirmed">
          <circle class="checkmark-circle" cx="40" cy="40" r="36" fill="none" stroke="var(--color-success)" stroke-width="3"/>
          <path class="checkmark-tick" d="M24 42 L35 53 L56 28" fill="none" stroke="var(--color-success)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>

      <div
        id="deposit-status"
        :class="h.depositMessage || h.celebrating ? `is-visible is-${h.depositVariant}` : ''"
        role="status"
        aria-live="polite"
      >
        <span v-if="h.depositVariant === 'waiting'" class="deposit-spinner" aria-hidden="true"></span>
        <template v-if="h.celebrating">Deposited {{ h.depositedAmount }} <span class="sat">S</span>!</template>
        <template v-else>{{ h.depositMessage }}</template>
      </div>
      <div id="deposit-reset-countdown" :class="{ 'is-visible': h.countdown > 0 }" aria-live="polite">
        <template v-if="h.countdown > 0">Resetting in {{ h.countdown }}</template>
      </div>

      <div id="deposit-footer">
        <button class="btn-withdraw btn-withdraw-ghost" id="deposit-reset-btn" type="button" @click="resetAndFocus">Reset</button>
        <button class="btn-withdraw btn-withdraw-ghost" id="deposit-close-btn" type="button" @click="closeDeposit">Close</button>
      </div>
      <canvas v-if="h.confetti" ref="confettiCanvas" class="deposit-confetti-canvas"></canvas>
    </div>
  </div>

  <footer class="site-footer">
    <a href="/about.html">About</a>
    <span class="sep">·</span>
    <a href="https://github.com/bilthon/satstreamr" target="_blank" rel="noopener noreferrer">GitHub</a>
    <span class="sep">·</span>
    <a href="https://njump.me/npub1qqqqqzwwsdha2f5fvel4gtj02rgnw9syyuv4hqywg8unucgc9e3qxsll4h" target="_blank" rel="noopener noreferrer">Nostr</a>
    <span class="sep">·</span>
    <a href="mailto:satstreamr.ouqux@aleeas.com">Email</a>
    <span class="build-stamp">{{ buildStamp }}</span>
  </footer>
</template>
