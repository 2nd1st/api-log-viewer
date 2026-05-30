// Theme module — dark + light, dark default.
//
// Two-key scheme: [data-theme="light"] on <html> overrides the dark
// defaults defined in app.css :root. Persistence key matches the
// existing apilog.* convention (see DEFAULT_PATH_FILTER in lib/api.ts).
//
// App.svelte calls applyTheme(getTheme()) at boot, before first render,
// to avoid a dark-to-light flash on reload when the operator's choice
// is light.

export type Theme = 'dark' | 'light';

const KEY = 'apilog.theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // localStorage can throw in private-mode Safari; silently fall
    // through and at least apply the in-memory choice.
  }
  applyTheme(t);
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
