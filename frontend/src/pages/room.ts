import { createApp, type App } from 'vue';
import RoomApp from '../app/RoomApp.vue';
import type { RoomServices } from '../app/use-room.js';
import { createCashuReceiver, createCashuSender, createCashuWallet, validateCashuSessionMint } from '../payments/cashu-session-payments.js';
import { SignalingClient } from '../signaling-client.js';
import { PeerConnection } from '../lib/peer-connection.js';
import { DataChannel } from '../lib/data-channel.js';
import { getMintUrl } from '../lib/config.js';
import { getSignalingUrl } from '../lib/signaling-url.js';

// Concrete payment and transport construction belongs here, outside Vue views.
const services: RoomServices = {
  createClient: () => new SignalingClient(getSignalingUrl()),
  createPeer: () => new PeerConnection(),
  createChannel: channel => new DataChannel(channel),
  wallet: createCashuWallet(),
  sender: createCashuSender(),
  createReceiver: createCashuReceiver,
  validateMint: validateCashuSessionMint,
  mintUrl: getMintUrl(),
  isDev: import.meta.env.DEV,
  navigate: url => { window.location.href = url; },
};

let app: App | undefined;
function mount(): void {
  app = createApp(RoomApp, { services, search: window.location.search });
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
window.addEventListener('pagehide', unmount);
window.addEventListener('pageshow', restore);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('pagehide', unmount);
    window.removeEventListener('pageshow', restore);
    unmount();
  });
}
