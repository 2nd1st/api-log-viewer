# api-log-viewer

Separate frontend for `api-log` — the transparent HTTP recording proxy
for LLM gateway traffic.

Two-repo layout per CLIProxyAPI's separation philosophy: the backend
exposes pure HTTP API; this repo is one of (potentially many) frontends.

## Status

Pre-release. Expects api-log backend `>= 0.1.0`; the wire contract is
stable but commit history may still rebase before the v0.1.0 tag.

(screenshots coming with the v0.1.0 tag)

## Project docs

- [PHILOSOPHY.md](./PHILOSOPHY.md) — restraint discipline and the
  small-core / many-plugins position.
- [SECURITY.md](./SECURITY.md) — threat model, bearer-token handling,
  and what the capture path does and does not redact.
- [api-log backend](https://github.com/xiayangzhang/api-log) — the Go
  recording proxy this viewer reads from.

## Stack

- Svelte 5 (runes) + Vite + TypeScript
- No CSS framework, no component library, no router lib — kept restrained
- Single-bundle SPA, ~77 KB JS gzipped, hash router

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
your.domain {
  root * /opt/api-log-viewer/dist
  file_server
  handle /api/*   { reverse_proxy 127.0.0.1:7862 }
  handle /healthz { reverse_proxy 127.0.0.1:7862 }
}
```

## License

[MIT](./LICENSE) — © 2026 Leo Yun.
