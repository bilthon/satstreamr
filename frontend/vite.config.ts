/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        tutor: resolve(__dirname, 'tutor.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    }
  },
  server: {
    proxy: {
      // Proxy LND customer REST calls so the browser avoids TLS errors from
      // the self-signed certificate used in the regtest docker environment.
      '/lnd-customer': {
        target: 'https://localhost:8082',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/lnd-customer/, ''),
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
