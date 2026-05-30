// Theme module — runes-based source-of-truth for dark / light.
//
// Mirrors the pattern in lib/i18n.svelte.ts: a `$state` cell at module
// scope, read through a getter so every Svelte template that observes
// the cell re-runs when `setTheme()` flips it. The .svelte.ts suffix
// is required for module-level runes per Svelte 5.
//
// Persistence key matches the existing apilog.* convention. The cell
// is loaded once from localStorage on module init; subsequent writes
// go through setTheme() / toggleTheme() which both update the cell and
// persist.
//
// App.svelte calls applyTheme(getTheme()) at boot, before first render,
// to avoid a dark-to-light flash on reload when the operator's choice
// is light.

export type Theme = 'dark' | 'light';

const KEY = 'apilog.theme';

function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    // localStorage can throw in private-mode Safari / sandboxed iframes
    // — fall through to the dark default.
    return 'dark';
  }
}

let theme = $state<Theme>(loadTheme());

export function getTheme(): Theme {
  return theme;
}

export function setTheme(t: Theme): void {
  theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // see loadTheme() — silently no-op, at least apply the in-memory
    // choice via applyTheme() below.
  }
  applyTheme(t);
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

export function toggleTheme(): Theme {
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
