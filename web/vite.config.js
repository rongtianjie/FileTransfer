import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      input: [resolve(root, 'index.html'), resolve(root, 'admin/index.html')],
    },
  },
  server: {
    proxy: {
      '/api/session': { target: 'ws://127.0.0.1:8080', ws: true },
      '/api/admin': { target: 'http://127.0.0.1:8080' },
    },
  },
})
