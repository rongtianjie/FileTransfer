import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api/session': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
})
