import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Backend (api-log Go binary) listens on $APILOG_API_ADDR — default 7862.
// A production reverse proxy routes /api/* and /healthz to it on the same origin.
const BACKEND = process.env.APILOG_BACKEND ?? 'http://127.0.0.1:7862';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/healthz': { target: BACKEND, changeOrigin: true },
    },
  },
});
