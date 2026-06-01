// i18n runtime — runes-based reactive language switcher.
//
// Runtime constraints:
//   - Open-source first: default language is detected from
//     navigator.language; "zh" prefix → 'zh', everything else → 'en'.
//   - Operator override persists to localStorage['apilog.lang'].
//   - No deps, no webfont, no chart lib — same restraint as the rest of
//     the viewer.
//   - The dictionary lives in two flat objects (en.ts / zh.ts) typed as
//     Record<string,string>. Lookup is a single map read; on a miss we
//     return the key string itself so a typo surfaces as visible text,
//     not as undefined.
//
// REACTIVITY:
//   - `lang` is `$state<Lang>` at module scope. setLang() reassigns it.
//   - t() reads the lang inside its body on every call so any Svelte
//     template that calls t() re-runs when lang flips. (If we resolved
//     the table outside t(), the call would snapshot it and the UI
//     would not update on setLang — that bug is the whole reason this
//     file is .svelte.ts and not .ts.)
//   - We do NOT export the $state cell itself (Svelte 5 disallows
//     exporting reassigned module state). Consumers go through
//     getLang() / setLang() / t().
//
// KEY NAMING:
//   - Flat dot-separated keys: 'home.status', 'ui.nav.home', etc.
//   - {param} substitution inside the dictionary value, e.g.
//     home.hitRate = "{percent}% hit". Substitution is a single
//     String#replace pass over /\{([a-zA-Z0-9_]+)\}/g.

import { en } from './i18n/en';
import { zh } from './i18n/zh';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'apilog.lang';

function loadLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    // localStorage can throw in private-mode Safari / sandboxed iframes
    // — fall through to navigator detection.
  }
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.language === 'string' &&
    navigator.language.toLowerCase().startsWith('zh')
  ) {
    return 'zh';
  }
  return 'en';
}

let lang = $state<Lang>(loadLang());

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next !== 'en' && next !== 'zh') return;
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // see loadLang() — silently no-op.
  }
}

const PARAM_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Look up a dictionary entry by flat dot-separated key and substitute
 * {param} placeholders. Missing keys fall back to the key string itself
 * so typos surface as visible text rather than `undefined`.
 *
 * Reactive: reads `lang` inside the function body, so Svelte templates
 * that call `t(...)` re-run when `setLang()` reassigns the cell.
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  const table: Record<string, string> = lang === 'zh' ? zh : en;
  const raw = table[key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(PARAM_RE, (m, name) => {
    const v = params[name];
    return v == null ? m : String(v);
  });
}
