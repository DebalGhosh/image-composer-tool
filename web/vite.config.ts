import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Listen on all interfaces so a remote browser (e.g. over SSH) can reach the
    // dev server at the host's IP without a tunnel. Harmless for local use.
    host: true,
    // Proxy API calls to the Go backend during development. VITE_API_TARGET
    // lets a parallel test instance point at a non-default port (e.g. 8081
    // when the primary Go server on 8080 must stay untouched).
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Emit into dist/ for embedding into the Go binary via embed.FS.
    outDir: 'dist',
  },
})
