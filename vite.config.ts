import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Backend (api-log Go binary) listens on $APILOG_API_ADDR — default 7862.
// A production reverse proxy routes /api/* and /healthz to it on the same origin.
const BACKEND = process.env.APILOG_BACKEND ?? 'http://127.0.0.1:7862';

export default defineConfig({
  // Relative-path build so the SPA loads from any mount point —
  // the api-log backend serves this dist under `/viewer/`, while
  // a typical Caddy / nginx reverse-proxy serves it at the host
  // root. An absolute `/assets/...` reference would 404 under
  // `/viewer/` because the asset path would resolve at the host
  // root, not under the viewer prefix.
  base: './',
  plugins: [svelte()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/healthz': { target: BACKEND, changeOrigin: true },
    },
  },
});
