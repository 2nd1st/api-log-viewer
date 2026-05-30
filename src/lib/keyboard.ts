// Keyboard module — global Cmd+K shortcut + a tiny pub/sub for the
// CommandPalette overlay.
//
// Why a pub/sub instead of a Svelte store: the palette open/close
// state lives inside CommandPalette.svelte itself; from the outside,
// callers only need to *trigger* an open. App.svelte binds the
// global shortcut once and the palette subscribes in onMount.
//
// Input-element guard: typing into a text input shouldn't pop the
// palette — among other things this would break native browser
// shortcuts like Cmd+K-in-omnibox flows when an input is focused.

type Listener = () => void;

let listeners: Listener[] = [];

export function onOpenPalette(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

export function openPalette(): void {
  for (const fn of listeners) fn();
}

export function bindGlobalShortcut(): () => void {
  function handler(e: KeyboardEvent): void {
    const isCmd = e.metaKey || e.ctrlKey;
    if (!isCmd) return;
    if (e.key.toLowerCase() !== 'k') return;
    // Skip if focused element is a text input — don't steal native
    // shortcuts (e.g. typing K in a search box).
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    const isEditable = t?.isContentEditable;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || isEditable) return;
    e.preventDefault();
    openPalette();
  }
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
