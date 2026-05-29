# api-log-viewer

Separate frontend for [api-log](http://gitea.homelab.lan/leoyun/api-log) —
the transparent HTTP recording proxy for LLM gateway traffic.

Two-repo layout per CLIProxyAPI's separation philosophy: the backend
exposes pure HTTP API; this repo is one of (potentially many) frontends.

## Stack

- Svelte 5 (runes) + Vite + TypeScript
- No CSS framework, no component library, no router lib — kept restrained
- Bundle target < 50 KB gzipped

## Develop

```sh
pnpm install
pnpm dev
```

Runs at `http://localhost:5180`. Vite proxies `/api/*` and `/healthz` to
the backend at `$APILOG_BACKEND` (default `http://127.0.0.1:7862`).

## Deploy

Build static assets and serve them via Caddy alongside a reverse-proxy
to the backend on the same origin (no CORS):

```sh
pnpm build
# dist/ contains the static assets
```

Caddy example:

```caddyfile
apilog-sub2.homelab.lan {
  root * /opt/api-log-viewer/dist
  file_server
  handle /api/*   { reverse_proxy 127.0.0.1:7862 }
  handle /healthz { reverse_proxy 127.0.0.1:7862 }
}
```
