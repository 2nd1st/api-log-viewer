English | [中文](README.zh.md)

# api-log-viewer: Svelte trace viewer for LLM proxy logs

[![CI](https://github.com/2nd1st/api-log-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/2nd1st/api-log-viewer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/2nd1st/api-log-viewer)](https://github.com/2nd1st/api-log-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bundle size](https://img.shields.io/badge/js%20gzipped-~77%20KB-informational)](#bundle-size)

api-log-viewer is a Svelte 5 SPA trace viewer for LLM gateway logs. It pairs with [api-log](https://github.com/2nd1st/api-log) to render recorded OpenAI Chat, Anthropic Messages, Responses, and Gemini traffic. Designed as a frontend rather than THE frontend — operators can point it at any compatible JSONL or SQLite-backed trace store. Useful for stacks running sub2api, CLIProxyAPI (CPA), or new-api to inspect requests, responses, SSE chunks, tool calls, reasoning content, sessions, and replay data.

> api-log-viewer 是一个面向 LLM 网关日志的 Svelte 5 SPA trace 查看器。它跟 [api-log](https://github.com/2nd1st/api-log) 配套，渲染录制下来的 OpenAI Chat、Anthropic Messages、Responses、Gemini 流量。设计上是一个前端而不是 THE 前端 —— 后续也可以对接到兼容的 JSONL / SQLite trace 存储。跑 sub2api、CLIProxyAPI（CPA）、new-api 的运维可以用它查看请求、响应、SSE chunk、tool call、reasoning 内容、session 和 replay 数据。

**Backend recorder:** [api-log](https://github.com/2nd1st/api-log) — Go HTTP recording proxy that captures OpenAI-compatible, Anthropic Messages, Responses, and Gemini gateway traffic into JSONL + SQLite.

## Screenshots

**Home** — aggregate dashboard: capacity, capability badges, active
clients (resolved from client headers), token-usage sums, traffic
volume.

![Home — aggregate dashboard](docs/screenshots/home.png)

**Traces** — list view with filter sidebar (status, path with
`*` prefix, model, key prefix, session, since, limit) + a
keyboard-friendly row table. Selecting a row opens the detail panel.

![Traces — list + filter sidebar](docs/screenshots/traces.png)

**Trace detail (Overview tab)** — request / response identity, tokens
in / out, duration, client + key + upstream, content shape (text /
reasoning / tool-call counts). Conversation + Raw tabs sit alongside.

![Trace detail — Overview tab](docs/screenshots/trace-detail.png)

**Plugins** — operator-opt-in mutate / intercept hooks. Per-instance
enable toggle, hot-reload via the backend PUT / PATCH / DELETE API
(no restart). YAML defaults + runtime override layer, source pill
shows which side currently owns each row.

![Plugins — operator-opt-in mutate / intercept hooks](docs/screenshots/plugins.png)

## Works with api-log

This viewer is a thin reader on top of the api-log HTTP read API. It does
not capture, route, store, or rewrite traffic. All recording is done by
the backend; see `ARCHITECTURE.md § 6` in the api-log repo for the read
API contract.

### Backend version

- This release tracks `api-log >= 0.1.0`. The wire contract (read API +
  trace JSON shape) is stable across patch versions of that line.
- Minor backend bumps may add fields; the viewer ignores unknown fields
  rather than failing closed.

### API base URL

The viewer talks to a single backend origin. In development it proxies
`/api/*` and `/healthz` to `$APILOG_BACKEND` (default
`http://127.0.0.1:7862`). In production the typical layout is to serve
the static bundle and reverse-proxy `/api/*` + `/healthz` from the same
hostname so there is no CORS surface.

### Hash-router deployment

Routing is hash-based (`#/landing`, `#/traces`, `#/traces/<id>`). The
bundle is a single SPA — any static file server that returns `index.html`
for `/` is sufficient; no rewrite rules are required.

## Quick start

### Develop locally

```sh
pnpm install
pnpm dev
```

Runs at `http://localhost:5180`. Vite proxies `/api/*` and `/healthz`
to the backend at `$APILOG_BACKEND` (default `http://127.0.0.1:7862`).

### Connect to a backend

Start the api-log backend first (see its
[Quick start](https://github.com/2nd1st/api-log#quick-start)),
then point the viewer at it:

```sh
APILOG_BACKEND=http://127.0.0.1:7862 pnpm dev
```

On first load the viewer asks for the admin bearer token. The backend
writes that token to `./data/admin_token` on its first run; paste it
into the auth modal. It is stored in `localStorage` (Safari private mode
and sandboxed iframes are tolerated — module load no longer crashes if
storage is unavailable).

## Views

Five top-level pages, addressable by hash route:

| Route | Page | What it shows |
|---|---|---|
| `#/landing` | Home | Backend health, recent trace summary, jump-off links |
| `#/traces` | Traces | List + filters + detail panel for recorded traces |
| `#/plugins` | Plugins | CRUD UI for text-replace, text-append, path-filter plugins |
| `#/export` | Export | Bundle a filter set into a downloadable zip for offline analysis |
| `#/settings` | Settings | Theme, language (en / zh), bearer token, about |

### Trace list

`#/traces` renders the result of `GET /api/traces` with a sidebar of
filter inputs: status code, path (exact or `prefix/*`), model,
`key_hash`, `session_root_id`, `since`, `limit`. Datalist suggestions
populate from observed values in the loaded page.

### Trace detail

Selecting a row opens the detail panel with three tabs:

| Tab | Contents |
|---|---|
| Overview | Identity, status, latency, model, tool-call summary, reasoning summary, project context extracted from `AGENTS.md` / `CLAUDE.md` if recorded |
| Conversation | Rendered messages — system / user / assistant / tool blocks, SSE replay, tool-call args + results |
| Raw | Request headers + body and response headers + body co-located, single tab so operators stop ping-ponging |

`Headers` and `Body` were folded into the Raw tab to keep diff-style
reading in one place. SSE replay is rendered inside Conversation rather
than as a separate tab.

### Plugins

The Plugins page lists configured plugins by category (text-replace /
text-append / path-filter), exposes per-plugin enable / edit / delete,
and hits `PUT /api/config/plugins/:id`, `PATCH …/enabled`, and
`DELETE …` on the backend. Backend hot-reload picks the change up
without a restart.

### Export

The Export page lets the operator apply a trace filter and download a
zip bundle (traces + matching JSONL + any project-context files), so a
downstream agent can ingest the bundle offline.

## Deploy

### Static build

```sh
pnpm build
# dist/ contains the static SPA bundle
```

The build produces a single bundle (one HTML + hashed JS/CSS). Bundle
size is auto-measured in CI at roughly 77 KB JS gzipped — small enough
that aggressive CDN caching is the only required performance work.

### Caddy reverse proxy

Serve the static bundle and reverse-proxy the backend on the same
origin to avoid CORS:

```caddyfile
your.domain {
  root * /opt/api-log-viewer/dist
  file_server
  handle /api/*   { reverse_proxy 127.0.0.1:7862 }
  handle /healthz { reverse_proxy 127.0.0.1:7862 }
}
```

### Nginx reverse proxy

```nginx
server {
  listen 443 ssl;
  server_name your.domain;

  root /opt/api-log-viewer/dist;
  index index.html;

  location / {
    try_files $uri /index.html;
  }

  location /api/    { proxy_pass http://127.0.0.1:7862; }
  location /healthz { proxy_pass http://127.0.0.1:7862; }
}
```

## Security notes

- The admin bearer token is held in `localStorage`. Anyone with DOM
  access to the viewer origin can read it; treat the viewer origin as
  trusted and gate it (mTLS, VPN, basic auth at the reverse proxy) on
  shared deployments.
- The viewer never re-issues recorded traffic to a real upstream. The
  Conversation tab's SSE replay is a render of recorded bytes, not a
  live request.
- The viewer does not perform redaction. What it shows is what the
  backend recorded; see api-log's `SECURITY.md` for the capture-side
  redaction posture.

## Compatibility

| Component | Version |
|---|---|
| api-log backend | `>= 0.1.0` |
| Node | `>= 22` (CI matrix: 22.x) |
| pnpm | `>= 9` |
| Browsers | Last two versions of Chrome, Firefox, Safari |

## Bundle size

CI measures gzipped JS size on each build. As of `0.1.0` the bundle is
approximately 77 KB JS gzipped, 141 source files, single-bundle SPA.

## Development

```sh
pnpm install
pnpm check        # svelte-check
pnpm test         # tsx-driven unit tests
pnpm build        # production bundle into dist/
pnpm dev          # dev server on :5180
```

CI runs `check + test + build` on push and pull request; release tags
on `v*` build artifacts. See `.github/workflows/ci.yml`.

Internals:

- Svelte 5 (runes) + Vite + TypeScript.
- No CSS framework, no component library, no client-side router lib.
- i18n is a dictionary in `src/lib/i18n/{en,zh}.ts` with runtime switch.
- All backend calls go through `src/lib/api.ts`, which handles bearer
  injection, 401 → auth modal, and the `PluginAPIError`
  `{error, detail}` envelope.

## Related projects

- [api-log](https://github.com/2nd1st/api-log) — Go recording
  proxy this viewer reads from. The HTTP read API contract lives in
  `ARCHITECTURE.md § 6` of that repo.
- [`SECURITY.md`](./SECURITY.md) — viewer-side threat model.
- [`CHANGELOG.md`](./CHANGELOG.md) — release notes.

## Acknowledgements

### Backend + design influence

- [`api-log`](https://github.com/2nd1st/api-log) — every
  surface in this viewer renders something the backend already
  recorded; the read API contract drives the shape of every page.
- **Svelte 5 (runes)** — module-level `$state` cells made the
  desync-prone i18n / theme / auth state surfaces tractable
  without a store library.

### Development assistance

This codebase and its documentation were developed with
**Claude Opus 4.8** (Anthropic) as the primary pair-programmer
for the Phase L UI revamp, the plugin management surface, the
i18n dictionary, the localStorage-hardening pass, and these
READMEs; and **GPT-5.5** via Codex CLI as a research and review
assistant — pre-release adversarial review, README structural
analysis against reference OSS projects (CLIProxyAPI, sub2api,
cc-switch), and tone audits. The cut / keep / amend judgments
are the human author's; AI assistance is named here for
transparency, not as authorship.

## License

[MIT](./LICENSE) — Copyright 2026 Leo Yun.
