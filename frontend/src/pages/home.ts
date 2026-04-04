import { getBalance, onBalanceChange } from '../lib/wallet-store.js';

// ---------------------------------------------------------------------------
// UI element references
// ---------------------------------------------------------------------------

const balanceDisplayEl = document.getElementById('balance-display');
const depositBtnEl = document.getElementById('deposit-btn') as HTMLButtonElement | null;
const withdrawBtnEl = document.getElementById('withdraw-btn') as HTMLButtonElement | null;

const startStreamingBtnEl = document.getElementById('start-streaming-btn') as HTMLButtonElement | null;

const sessionIdInputEl = document.getElementById('session-id-input') as HTMLInputElement | null;
const joinBtnEl = document.getElementById('join-btn') as HTMLButtonElement | null;
const joinErrorEl = document.getElementById('join-error');

const invitePanelEl = document.getElementById('invite-panel');
const inviteJsonEl = document.getElementById('invite-json');
const inviteDecodeErrorEl = document.getElementById('invite-decode-error');
const inviteJoinBtnEl = document.getElementById('invite-join-btn') as HTMLButtonElement | null;

// ---------------------------------------------------------------------------
// Balance display
// ---------------------------------------------------------------------------

function renderBalance(balance: number): void {
  if (balanceDisplayEl !== null) {
    balanceDisplayEl.textContent = `Balance: ${balance} sats`;
  }
}

// Initialise balance on load.
renderBalance(getBalance());

// Subscribe to reactive balance updates.
onBalanceChange((balance) => {
  renderBalance(balance);
});

// ---------------------------------------------------------------------------
// Deposit / Withdraw placeholders (wired in Units 25 / 26)
// ---------------------------------------------------------------------------

if (depositBtnEl !== null) {
  depositBtnEl.addEventListener('click', () => {
    // Unit 25 will implement this
    console.log('[home] deposit button clicked — not yet implemented');
  });
}

if (withdrawBtnEl !== null) {
  withdrawBtnEl.addEventListener('click', () => {
    // Unit 26 will implement this
    console.log('[home] withdraw button clicked — not yet implemented');
  });
}

// ---------------------------------------------------------------------------
// Start Streaming button
// ---------------------------------------------------------------------------

if (startStreamingBtnEl !== null) {
  startStreamingBtnEl.addEventListener('click', () => {
    window.location.href = '/tutor.html';
  });
}

// ---------------------------------------------------------------------------
// Join a Stream
// ---------------------------------------------------------------------------

function navigateToViewer(sessionId: string): void {
  window.location.href = `/viewer.html?session=${encodeURIComponent(sessionId)}`;
}

function showJoinError(message: string): void {
  if (joinErrorEl !== null) {
    joinErrorEl.textContent = message;
    joinErrorEl.style.display = 'block';
  }
}

function hideJoinError(): void {
  if (joinErrorEl !== null) {
    joinErrorEl.style.display = 'none';
  }
}

if (joinBtnEl !== null) {
  joinBtnEl.addEventListener('click', () => {
    const sessionId = sessionIdInputEl?.value.trim() ?? '';
    if (sessionId.length === 0) {
      showJoinError('Please enter a session ID.');
      return;
    }
    hideJoinError();
    navigateToViewer(sessionId);
  });
}

if (sessionIdInputEl !== null) {
  sessionIdInputEl.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      joinBtnEl?.click();
    }
  });

  sessionIdInputEl.addEventListener('input', () => {
    hideJoinError();
  });
}

// ---------------------------------------------------------------------------
// ?join=<base64> invite detection
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const joinParam = params.get('join');

if (joinParam !== null && invitePanelEl !== null) {
  invitePanelEl.style.display = 'block';

  let decodedJson: string | null = null;
  let inviteSessionId: string | null = null;

  try {
    const decoded = atob(joinParam);
    // Attempt to pretty-print if it is valid JSON; fall back to raw text.
    try {
      const parsed: unknown = JSON.parse(decoded);
      decodedJson = JSON.stringify(parsed, null, 2);
      // If the decoded object has a sessionId field, pre-fill the join form.
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'sessionId' in parsed &&
        typeof (parsed as Record<string, unknown>)['sessionId'] === 'string'
      ) {
        inviteSessionId = (parsed as Record<string, unknown>)['sessionId'] as string;
      }
    } catch {
      decodedJson = decoded;
    }

    if (inviteJsonEl !== null) {
      inviteJsonEl.textContent = decodedJson;
    }
  } catch {
    if (inviteDecodeErrorEl !== null) {
      inviteDecodeErrorEl.textContent = 'Failed to decode invite link — the base64 payload is invalid.';
      inviteDecodeErrorEl.style.display = 'block';
    }
    if (inviteJsonEl !== null) {
      inviteJsonEl.textContent = '';
    }
  }

  // Wire up the "Join This Session" button in the invite panel.
  if (inviteJoinBtnEl !== null) {
    inviteJoinBtnEl.addEventListener('click', () => {
      if (inviteSessionId !== null) {
        navigateToViewer(inviteSessionId);
      } else {
        // No sessionId found in decoded payload; prompt user to enter one manually.
        if (sessionIdInputEl !== null) {
          sessionIdInputEl.focus();
          sessionIdInputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        showJoinError('Could not find a session ID in the invite. Please enter it manually.');
      }
    });
  }
}
