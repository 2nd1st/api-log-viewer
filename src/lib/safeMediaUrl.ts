/**
 * safeMediaUrl — scheme allowlist for any URL that ends up in a
 * MediaBlock's `<img src>`, `<a href>`, `<audio src>`, `<video src>`.
 *
 * Why this exists when the page already ships a strict CSP: the CSP
 * is the last line of defense. Trace bodies come from upstream
 * gateway traffic; an attacker who controls a gateway response can
 * embed any URL they like. We don't want defense-in-depth to bottom
 * out at "CSP catches it" — the renderer itself filters at the
 * adapter / component boundary so a hostile URL never reaches the
 * DOM.
 *
 * Allowed:
 *   - same-origin `/api/media/...` (the backend-served extracted
 *     attachment endpoint — bearer-gated server-side)
 *   - `http://` and `https://` (external, e.g. b64_json fallback URL
 *     from an image-gen response)
 *   - `data:image/*`, `data:audio/*`, `data:video/*` (inline base64)
 *
 * Denied (returns null):
 *   - `javascript:` — script execution on click
 *   - `file:` — local FS access
 *   - `blob:` — page-local URL handle, attacker-crafted blob may
 *     leak data via redirect or window.open semantics
 *   - `data:text/*`, `data:application/*` — could carry HTML / script
 *     under the wrong content-type
 *   - relative paths other than `/api/media/...`
 *   - anything that doesn't parse as a URL
 */

const ALLOWED_DATA_PREFIXES = ['data:image/', 'data:audio/', 'data:video/'];

export function safeMediaUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // data: URIs — only image/audio/video subtypes pass.
  if (trimmed.toLowerCase().startsWith('data:')) {
    const head = trimmed.slice(0, 16).toLowerCase();
    return ALLOWED_DATA_PREFIXES.some((p) => head.startsWith(p)) ? trimmed : null;
  }

  // Relative same-origin path — only `/api/media/...` is allowed
  // through. Anything else under the root could navigate to a
  // route we didn't intend to expose as media content.
  if (trimmed.startsWith('/')) {
    return trimmed.startsWith('/api/media/') ? trimmed : null;
  }

  // Absolute URL — only http / https schemes.
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') return trimmed;
    return null;
  } catch {
    return null;
  }
}
