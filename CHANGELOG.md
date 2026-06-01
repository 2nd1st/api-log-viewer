# Changelog

All notable changes to this project will be documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning:
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Storage retention surface** (matches api-log v0.1.1 backend):
  Landing STATUS strip's `data` cell gains a state badge (ok /
  warning / critical) when the backend has retention configured.
  Settings adds a new **Storage** card with `max_bytes` /
  `max_age_days` / `warn_at_percent` inputs that GET + PUT
  `/api/config/retention`. Both knobs zero surfaces a "disabled"
  status row; 503 from a coord-less backend renders the card with
  a helpful hint. i18n strings for both languages.

### Changed

### Fixed

### Removed

## [0.1.0] - 2026-05-31

### Added
- Phase L Vercel-leaning UI revamp: foundation tokens + theme toggle +
  Cmd+K palette (eb7a8c1), Landing rewrite (a8b0fe6), Home/Export/
  Settings centred page containers (7f6c730), density sweeps across
  secondary surfaces (06b84b2, dbc6a49).
- Plugins tab promoted from Settings to a top-level nav entry
  (W4.2, 4cacbd6).
- Project-context extraction from `AGENTS.md` / `CLAUDE.md` and the
  declared-skills list rendered on the Overview tab (W4.1, 276dc1b).
- `localStorage` access wrapped in try/catch so Safari private mode
  and sandboxed iframes no longer crash at module load (8769b35).
- `PluginAPIError` carries the backend `{error, detail}` envelope;
  failures in `PluginEditModal` save now map to the per-code i18n
  dictionary instead of a generic alert (8769b35).
- `SECURITY.md` plus a minimal GitHub Actions pipeline running
  `pnpm install`, `pnpm check`, `pnpm test`, `vite build` (7831797).
- `LICENSE` (MIT, 1ec6b9d).
- en/zh i18n threaded through DetailPanel, ConversationTab, RawTab
  (including the `jsonHL` HTML builder), and Settings (94b0d5e,
  79b9854, b0fa43c, 5351488).

### Changed
- `theme.svelte.ts` reactor migrated to module-scoped `$state`;
  duplicate format helpers consolidated (c85682b).

### Removed
- "Restart api-log to apply" banner — backend W4.2 hot-reload makes
  it obsolete (292d311).
- Embedded `homelab.lan` upstream link from Settings → About
  (109cade) and the same leaks from README (1ec6b9d).
