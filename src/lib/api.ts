// HTTP client for authenticated API calls + token management.
//
// MOUNT MODEL (post-v0.1.0):
//   The api-log Go binary serves ONLY the read API and exposes no
//   embedded HTML. Deployments place a reverse proxy (Caddy / nginx /
//   ingress) in front and serve this viewer as a static SPA at some
//   path while routing `/api/*` and `/healthz` to the backend on the
//   same origin. Concretely:
//     - viewer assets:  <origin>/<viewer-prefix>/...   (e.g. `/` or `/ui/`)
//     - read API:       <origin>/api/*
//     - healthz:        <origin>/healthz
//
// `apiBase` math:
//   We compute `new URL('../', window.location.href)`. Given a viewer
//   page at `<origin>/<viewer-prefix>/index.html`, `../` walks one
//   path segment up and yields `<origin>/<viewer-prefix>/` collapsed to
//   `<origin>/` when the prefix is empty (the default). `api('traces')`
//   then resolves to `<origin>/api/traces`, which is what Caddy routes.
//   This deliberately does not hard-code the prefix so the same bundle
//   works whether the operator mounts at `/`, `/ui/`, or `/internal/ui/`.
//
// localStorage keys (do NOT rename — operators may have existing tokens):
//   apilog.token         — admin Bearer token
//   apilog.default_path  — default path filter (e.g. '/v1/*')
//
// localStorage SAFETY:
//   Safari private windows and sandboxed iframes can throw on every
//   localStorage access. The reads below are at module-evaluation time,
//   so an unguarded throw would abort import of this file and take the
//   whole app down before any defensive UI can render. Each access is
//   wrapped in try/catch with a sensible fallback. Same pattern as
//   lib/i18n.svelte.ts.

// ---------- localStorage keys ----------

export const TOKEN_KEY = 'apilog.token';
export const DEFAULT_PATH_KEY = 'apilog.default_path';

// Default path filter — hides /api/v1/* admin-UI noise on sub2api
// deployments. Stored in localStorage so a future settings UI can edit
// this; for now operators can clear the input to "*" to see everything.
function loadDefaultPathFilter(): string {
  try {
    return localStorage.getItem(DEFAULT_PATH_KEY) || '/v1/*';
  } catch {
    // Private-mode Safari / sandboxed iframe — fall back to the ship default.
    return '/v1/*';
  }
}

export const DEFAULT_PATH_FILTER: string = loadDefaultPathFilter();

// ---------- API URL computation ----------

// Base URL — one directory up from the current page. See the MOUNT MODEL
// note at the top of the file for why `../` is the correct math against
// the documented mount layout. Computed once at module load.
export const apiBase: URL = new URL('../', window.location.href);

// api joins a path (with or without leading slash) onto apiBase and
// returns an absolute URL string.
export function api(path: string): string {
  return new URL(path.replace(/^\//, ''), apiBase).toString();
}

// ---------- token state ----------

// Token is held in a module-level mutable cell so authFetch can read the
// current value without callers having to thread it through. Svelte
// components that want reactivity should mirror it in a $state rune and
// call setToken() to write back.
function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    // Private-mode Safari / sandboxed iframe — start with an empty token;
    // the auth modal will prompt the operator the first time authFetch fires.
    return '';
  }
}

let _token: string = loadToken();

export function getToken(): string {
  return _token;
}

// setToken updates the in-memory token AND persists to localStorage,
// matching the original behavior in the token-save click handler.
// The in-memory update happens unconditionally; persistence is
// best-effort so a throwing localStorage does not block the operator
// from using the app for the current session.
export function setToken(t: string): void {
  _token = t;
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // see loadToken() — silently no-op; token still works in-memory.
  }
}

// ---------- auth-modal hook ----------
//
// The original called a free function `showAuthModal()` from authFetch.
// In the Svelte port the modal lives in a component, so we expose a
// registration hook the App component (or whoever owns the modal) wires
// up at mount time.
//
// INVENTED SIGNATURE — documented in notes: `registerAuthModalHandler`
// stores a callback; authFetch invokes it on missing-token / 401.

type AuthModalHandler = () => void;
let _showAuthModal: AuthModalHandler = () => {
  // Default no-op; replaced once the modal component mounts.
};

export function registerAuthModalHandler(fn: AuthModalHandler): void {
  _showAuthModal = fn;
}

// ---------- authFetch ----------
//
// Ported 1:1: requires a token, attaches Authorization: Bearer header,
// surfaces 401 by popping the modal and throwing 'unauthorized'.
export async function authFetch(
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  if (!_token) {
    _showAuthModal();
    throw new Error('no token');
  }
  const r = await fetch(api(path), {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + _token,
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401) {
    _showAuthModal();
    throw new Error('unauthorized');
  }
  return r;
}
