import { createApp, type App } from 'vue';
import HomeApp from '../app/HomeApp.vue';
import { cashuHomeWallet } from '../payments/cashu-home-wallet.js';

let app: App | undefined;
function mount(): void {
  app = createApp(HomeApp, {
    wallet: cashuHomeWallet,
    navigate: (url: string) => { window.location.href = url; },
    search: window.location.search,
  });
  app.mount(document.body);
}
function unmount(): void {
  app?.unmount();
  app = undefined;
}
function restore(event: PageTransitionEvent): void {
  if (event.persisted && !app) mount();
}
mount();

// Stop polling on page exit, including bfcache; restore a fresh view on Back.
window.addEventListener('pagehide', unmount);
window.addEventListener('pageshow', restore);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('pagehide', unmount);
    window.removeEventListener('pageshow', restore);
    unmount();
  });
}
