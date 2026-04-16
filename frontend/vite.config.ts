/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import basicSsl from '@vitejs/plugin-basic-ssl'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    basicSsl(),
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        room: resolve(__dirname, 'room.html'),
      },
    }
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      // Proxy LND customer REST calls so the browser avoids TLS errors from
      // the self-signed certificate used in the regtest docker environment.
      '/lnd-customer': {
        target: 'https://localhost:8082',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/lnd-customer/, ''),
      },
      // Proxy Cashu mint HTTP calls through the Vite HTTPS origin so that LAN
      // devices reach the local mint without mixed-content errors and without
      // needing to know the host machine's IP address.
      '/mint': {
        target: 'http://localhost:3338',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mint/, ''),
      },
      // Proxy signaling WebSocket through the Vite HTTPS origin so that LAN
      // devices can connect without mixed-content (wss vs ws) errors.
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    env: {
      VITE_MINT_URL: 'http://localhost:3338'
    }
  }
})
