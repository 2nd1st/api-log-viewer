// HTTP client for authenticated API calls + token management.
//
// Ported 1:1 from internal/viewer/static/index.html. The original computed
// `apiBase` from `window.location.href` via `new URL('../', ...)` because
// the viewer is served under `/admin/ui/` and talks to `/admin/api/*` —
// going up one directory yields the correct base. We preserve that exact
// computation so the viewer keeps working under whatever mount point the
// server picks.
//
// localStorage keys (do NOT rename — operators may have existing tokens):
//   apilog.token         — admin Bearer token
//   apilog.default_path  — default path filter (e.g. '/v1/*')

// ---------- localStorage keys ----------

export const TOKEN_KEY = 'apilog.token';
export const DEFAULT_PATH_KEY = 'apilog.default_path';

// Default path filter — hides /api/v1/* admin-UI noise on sub2api
// deployments. Stored in localStorage so a future settings UI can edit
// this; for now operators can clear the input to "*" to see everything.
export const DEFAULT_PATH_FILTER: string =
  localStorage.getItem(DEFAULT_PATH_KEY) || '/v1/*';

// ---------- API URL computation ----------

// Base URL — one directory up from the current page. The viewer lives at
// e.g. `/admin/ui/` and the API at `/admin/api/*`, so `../` is the shared
// parent. Computed once at module load to match the original.
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
let _token: string = localStorage.getItem(TOKEN_KEY) || '';

export function getToken(): string {
  return _token;
}

// setToken updates the in-memory token AND persists to localStorage,
// matching the original behavior in the token-save click handler.
export function setToken(t: string): void {
  _token = t;
  localStorage.setItem(TOKEN_KEY, t);
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
