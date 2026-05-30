# Security

## Reporting a vulnerability

Open a private security advisory via the repository's GitHub Security tab.
If you cannot use GitHub, email the maintainer with subject `[api-log-viewer security]`.
Please do not file a public issue for a security report.

## Threat model

api-log-viewer is a single-bundle static SPA that reads captured trace
data from an api-log backend. The threats most relevant to its design —
and the ones a security review should focus on — are:

- **XSS via captured payload rendering.** Trace bodies (request /
  response JSON, SSE event streams) contain untrusted bytes from
  upstream clients and LLM providers. Any code path that renders
  captured strings as HTML (rather than text) is in scope. Detail
  panels, syntax-highlighted JSON, markdown previews of system
  prompts — all must escape, not interpret.
- **Stored auth token exposure.** The bearer token entered via the
  Auth modal persists in `localStorage` and is sent on every API
  request. Code paths that log the token, expose it to extension
  contexts, or attach it to outgoing requests other than the
  configured backend origin are in scope.
- **API origin confusion.** The viewer assumes same-origin proxying
  (`/api/*` → backend). A change that lets the backend URL be
  configured by URL parameter or trace content (rather than build /
  Caddy config) is in scope.
- **Open redirect via trace `path` / `upstream` fields.** Detail
  panel links built from captured strings must reject non-HTTP
  schemes (`javascript:` / `data:` / `vbscript:`).

## Not in scope

These are not vulnerabilities; they are deliberate design choices or
backend concerns:

- **Captured bearer tokens visible in the viewer.** api-log records
  upstream traffic verbatim (see backend [PHILOSOPHY.md](https://github.com/xiayangzhang/api-log)
  no-list). The viewer renders what was captured. Operators who do
  not want tokens visible should not capture them — that is a backend
  / pipeline decision, not a viewer concern.
- **Backend auth bypass.** The bearer token is checked by the backend.
  Bypass reports belong to the api-log backend repo's SECURITY.md.
- **Outdated dependency CVEs without a viewer-reachable code path.**
  npm-audit noise with no demonstrated XSS / RCE / data-exfil path
  through the viewer's actual use of the dependency will be closed
  with that note.
