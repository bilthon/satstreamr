/**
 * Lightweight toast notification system.
 *
 * Creates a fixed container in the top-right corner and displays
 * auto-dismissing notification toasts styled with design tokens.
 */

type ToastVariant = 'warning' | 'error' | 'info' | 'success';

interface ToastOptions {
  /** Display duration in ms. Pass 0 for sticky (no auto-dismiss). Default 5000. */
  duration?: number;
  variant?: ToastVariant;
}

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container !== null) return container;
  container = document.createElement('div');
  container.id = 'toast-container';
  document.body.appendChild(container);
  return container;
}

/**
 * Show a toast notification.
 * Returns a function that dismisses it early if needed.
 */
export function showToast(message: string, options: ToastOptions = {}): () => void {
  const { duration = 5000, variant = 'info' } = options;
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.setAttribute('role', 'alert');
  el.textContent = message;

  const parent = ensureContainer();
  parent.appendChild(el);

  // Trigger entrance animation on next frame
  requestAnimationFrame(() => {
    el.classList.add('toast-visible');
  });

  const dismiss = (): void => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback removal if transitionend doesn't fire
    setTimeout(() => el.remove(), 400);
  };

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }

  return dismiss;
}
