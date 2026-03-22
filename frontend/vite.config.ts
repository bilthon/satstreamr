import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        tutor: resolve(__dirname, 'tutor.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      }
    }
  }
})
