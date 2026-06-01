// Formatting helpers ported from the legacy static viewer.
//
// These are pure presentation utilities — no state, no side effects.

/**
 * HTML-escape a value for safe interpolation into innerHTML strings.
 * Mirrors the original esc() — null/undefined collapse to "".
 */
export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
      })[c] as string,
  );
}

/**
 * humanBytes formats a byte count using B / KB / MB.
 * Matches the original thresholds and precision exactly.
 */
export function humanBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * shortId returns the last 8 chars of an id (empty string if falsy).
 */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(-8) : '';
}

/**
 * shortTs renders an ISO/parsable timestamp as HH:MM:SS.mmm using
 * the en-GB locale (24h). Returns '' for falsy input.
 */
export function shortTs(ts: string | number | Date | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return (
    d.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

/**
 * fmtMs formats a duration in ms. null/undefined → '—'.
 * Sub-second: "Nms"; ≥1s: "N.NNs".
 */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

/**
 * statusClass maps an HTTP status code to one of the st-2 / st-4 /
 * st-5 / st-x CSS classes used by the row badges.
 */
export function statusClass(s: number | null | undefined): string {
  if (!s || s < 100) return 'st-x';
  const b = Math.floor(s / 100);
  return b === 2 ? 'st-2' : b === 4 ? 'st-4' : b === 5 ? 'st-5' : 'st-x';
}
