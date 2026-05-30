<script lang="ts">
  // Export tab — bundle matching traces into a zip with agent instructions.
  //
  // Contract: phase-i-export-contract.md
  //   GET /api/export?status=&path=&model=&key_hash=&session_root_id=&since=&until=&limit=
  //   -> application/zip with Content-Disposition: attachment
  //
  // PHILOSOPHY:
  //   - Mirrors OverviewTab's .card / .kv shape so nothing on this page
  //     reads as a new visual idiom. Single accent. No off-palette hex.
  //   - The form is a compact inline echo of FilterSidebar — same field
  //     names, same hints, same Apply-style button shape. We don't want
  //     the operator to learn a second filter vocabulary.
  //   - Live preview is observational, not aspirational: we hit
  //     /api/traces?...&limit=1 with the same filters just to confirm
  //     "yes, your filter matches N traces, here is the earliest /
  //     latest timestamp". Cheap. Debounced 400ms so typing doesn't
  //     flood the API.
  //   - Generate is a single window.location.href = api('api/export?...'),
  //     letting the browser handle the download. The server emits a
  //     Content-Disposition attachment header per the contract.
  //
  // INVENTED prop signature:
  //   - authFetch: same fn the rest of the app uses, threaded so we can
  //     run the preview query under the same Bearer token plumbing. The
  //     download itself can't use authFetch (a navigation can't carry a
  //     custom header), so we currently rely on the operator already
  //     being authenticated via the existing token mechanism.
  //
  //     KNOWN LIMITATION: GET /api/export requires `Authorization: Bearer`.
  //     A plain window.location.href = api('api/export?...') CANNOT attach
  //     that header. Options for the Integrate phase:
  //       1) server accepts a one-shot signed token query param,
  //       2) viewer fetches the zip into a Blob and triggers a download
  //          via a temporary <a href=blob:>,
  //       3) server accepts the token via cookie set on /api/auth.
  //     For now we use (2): authFetch the zip, blob it, download via a
  //     synthesized <a download> click. This streams into memory but
  //     keeps the auth model intact and avoids a server contract change.

  import { api } from '../lib/api';

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  }

  const { authFetch }: Props = $props();

  // ---------- form state ----------
  //
  // Field names match FilterSidebar / the contract's query params 1:1.
  // Defaults are deliberately empty so the operator picks scope — the
  // export is a destructive-ish action (it writes a zip to disk and
  // hands data to an agent), so we don't pre-populate any filter.

  let f_status = $state<string>('');
  let f_path = $state<string>('');
  let f_model = $state<string>('');
  let f_keyhash = $state<string>('');
  let f_session = $state<string>('');
  let f_since = $state<string>('');
  let f_until = $state<string>('');
  let f_limit = $state<string>('1000');

  // ---------- query string construction ----------
  //
  // buildQS() returns a URLSearchParams with the current filter values,
  // omitting empty fields. Used for both the preview probe and the
  // download URL. We don't validate here — the server returns 400 with
  // a structured error on bad input and the operator sees that as a
  // failed preview / failed download.

  function buildQS(extra: Record<string, string> = {}): URLSearchParams {
    const qs = new URLSearchParams();
    const s = f_status.trim();
    if (s) qs.set('status', s);
    const p = f_path.trim();
    if (p && p !== '*') qs.set('path', p);
    const m = f_model.trim();
    if (m) qs.set('model', m);
    const k = f_keyhash.trim();
    if (k) qs.set('key_hash', k);
    const sr = f_session.trim();
    if (sr) qs.set('session_root_id', sr);
    const si = f_since.trim();
    if (si) qs.set('since', si);
    const un = f_until.trim();
    if (un) qs.set('until', un);
    const lim = f_limit.trim();
    if (lim) qs.set('limit', lim);
    for (const [k2, v2] of Object.entries(extra)) qs.set(k2, v2);
    return qs;
  }

  // ---------- live preview ----------
  //
  // We poke /api/traces with the same filter set + limit=1 (cheapest
  // call that returns count metadata). The response shape is the same
  // as TracesList sees: { traces: TraceRow[], next_cursor }. We don't
  // get a true count from a single-row query — what we can show is
  // "matched at least N (the earliest row)" plus the row's ts_start.
  //
  // To approximate the count without hammering the DB we issue a
  // second tiny request with limit=<the operator's limit>, count the
  // rows in the response, and report min/max ts_start across them.
  // This is bounded by the operator's own limit so it's safe to
  // refresh on every keystroke (with debounce).
  //
  // NB: the real /api/export streams; we use /api/traces for the
  // preview only because /api/export returns a zip stream, not JSON.

  type PreviewState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; count: number; earliest: string | null; latest: string | null; capped: boolean };

  let preview = $state<PreviewState>({ kind: 'idle' });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePreview(): void {
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPreview, 400);
  }

  async function runPreview(): Promise<void> {
    preview = { kind: 'loading' };
    try {
      // Use the operator's own limit as our probe ceiling. This keeps
      // the preview cost bounded to whatever they're about to export.
      const lim = Math.max(1, Math.min(5000, parseInt(f_limit, 10) || 1000));
      const qs = buildQS({ limit: String(lim) });
      const r = await authFetch('api/traces?' + qs.toString());
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const rows: Array<{ ts_start?: string }> = j.traces || [];
      let earliest: string | null = null;
      let latest: string | null = null;
      for (const t of rows) {
        const ts = t.ts_start;
        if (!ts) continue;
        if (!earliest || ts < earliest) earliest = ts;
        if (!latest || ts > latest) latest = ts;
      }
      preview = {
        kind: 'ready',
        count: rows.length,
        earliest,
        latest,
        capped: rows.length >= lim,
      };
    } catch (e: any) {
      preview = { kind: 'error', message: e?.message ?? String(e) };
    }
  }

  // Reactively re-probe whenever any filter changes.
  $effect(() => {
    // Touch every field so the effect re-runs on any change.
    void f_status;
    void f_path;
    void f_model;
    void f_keyhash;
    void f_session;
    void f_since;
    void f_until;
    void f_limit;
    schedulePreview();
  });

  // ---------- generate ----------
  //
  // Build the URL, hit it with authFetch (so the bearer token rides
  // along), convert the response body into a Blob, then synthesize an
  // <a download> click. We can't just set window.location.href because
  // that's a navigation, which can't carry an Authorization header.

  let generating = $state<boolean>(false);
  let genError = $state<string | null>(null);

  async function generate(): Promise<void> {
    if (generating) return;
    generating = true;
    genError = null;
    try {
      const qs = buildQS();
      const r = await authFetch('api/export?' + qs.toString());
      if (!r.ok) {
        // Try to read a JSON error per the contract; fall back to status.
        let msg = `export failed (${r.status})`;
        try {
          const j = await r.json();
          if (j && j.message) msg = `${j.error ?? 'error'}: ${j.message}`;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      // Pull a filename out of Content-Disposition if present, else
      // synthesize one. The contract guarantees attachment + filename
      // but a defensive fallback costs nothing.
      const cd = r.headers.get('Content-Disposition') ?? '';
      let filename = 'api-log-export.zip';
      const m = cd.match(/filename="?([^";]+)"?/);
      if (m) filename = m[1];
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick so the browser has a chance to start
      // the download. Same pattern Chrome's File System Access shim uses.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      genError = e?.message ?? String(e);
    } finally {
      generating = false;
    }
  }

  // ---------- format helpers ----------

  function fmtTs(s: string | null): string {
    if (!s) return '—';
    // Cut the ms+Z tail for the preview blurb; full ts is in the data.
    return s.replace(/\.\d+Z$/, 'Z');
  }

  // Disable Generate while preview is loading OR generating, AND when
  // the preview reports zero matches (no point exporting an empty zip,
  // even though the server will happily emit one).
  const generateDisabled = $derived(
    generating ||
      preview.kind === 'loading' ||
      (preview.kind === 'ready' && preview.count === 0),
  );

  // The URL we'd hit if Generate were a navigation. Surfaced for
  // copy/paste debugging — not used by the actual button.
  const debugUrl = $derived(api('api/export?' + buildQS().toString()));
</script>

<div class="export">
  <!-- HEADER -->
  <header class="head">
    <div class="title">EXPORT</div>
    <div class="subtitle">bundle matching traces into a zip with agent instructions</div>
  </header>

  <!-- FILTER FORM -->
  <section class="card">
    <h3>filters</h3>
    <div class="form">
      <div class="row">
        <label for="x-status">status</label>
        <select id="x-status" bind:value={f_status}>
          <option value="">any</option>
          <option value="2xx">2xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
          <option value="200">200</option>
          <option value="401">401</option>
          <option value="403">403</option>
          <option value="404">404</option>
          <option value="429">429</option>
          <option value="500">500</option>
          <option value="502">502</option>
        </select>
      </div>

      <div class="row">
        <label for="x-path">path <span class="hint">(end with * for prefix)</span></label>
        <input
          class="input"
          id="x-path"
          placeholder="(any)"
          autocomplete="off"
          bind:value={f_path}
        />
      </div>

      <div class="row">
        <label for="x-model">model</label>
        <input
          class="input"
          id="x-model"
          placeholder="any"
          autocomplete="off"
          bind:value={f_model}
        />
      </div>

      <div class="row">
        <label for="x-keyhash">key_hash <span class="hint">(8 or 16-char prefix)</span></label>
        <input
          class="input"
          id="x-keyhash"
          placeholder="prefix"
          autocomplete="off"
          bind:value={f_keyhash}
        />
      </div>

      <div class="row">
        <label for="x-session">session_root_id</label>
        <input
          class="input"
          id="x-session"
          placeholder="ULID"
          autocomplete="off"
          bind:value={f_session}
        />
      </div>

      <div class="row">
        <label for="x-since">since <span class="hint">(ISO 8601)</span></label>
        <input
          class="input"
          id="x-since"
          placeholder="2026-05-28T00:00:00Z"
          autocomplete="off"
          bind:value={f_since}
        />
      </div>

      <div class="row">
        <label for="x-until">until <span class="hint">(ISO 8601)</span></label>
        <input
          class="input"
          id="x-until"
          placeholder="2026-05-30T00:00:00Z"
          autocomplete="off"
          bind:value={f_until}
        />
      </div>

      <div class="row">
        <label for="x-limit">limit <span class="hint">(max 5000)</span></label>
        <input
          class="input"
          id="x-limit"
          type="number"
          min="1"
          max="5000"
          bind:value={f_limit}
        />
      </div>
    </div>
  </section>

  <!-- LIVE PREVIEW -->
  <section class="card">
    <h3>preview</h3>
    <dl class="kv">
      <dt>matches</dt>
      <dd class="mono">
        {#if preview.kind === 'idle'}
          <span class="dim">—</span>
        {:else if preview.kind === 'loading'}
          <span class="dim">probing…</span>
        {:else if preview.kind === 'error'}
          <span class="err">{preview.message}</span>
        {:else}
          <strong>{preview.count}</strong> trace{preview.count === 1 ? '' : 's'}
          {#if preview.capped}<span class="dim"> (capped at limit)</span>{/if}
        {/if}
      </dd>
      <dt>earliest</dt>
      <dd class="mono">{preview.kind === 'ready' ? fmtTs(preview.earliest) : '—'}</dd>
      <dt>latest</dt>
      <dd class="mono">{preview.kind === 'ready' ? fmtTs(preview.latest) : '—'}</dd>
    </dl>
  </section>

  <!-- GENERATE -->
  <section class="card">
    <h3>generate</h3>
    <div class="actions">
      <button
        type="button"
        class="primary"
        onclick={generate}
        disabled={generateDisabled}
      >
        {generating ? 'generating…' : 'Generate &amp; download'}
      </button>
      {#if genError}
        <div class="err foot">{genError}</div>
      {/if}
    </div>
    <div class="dim foot debug" title={debugUrl}>{debugUrl}</div>
  </section>

  <!-- WHAT'S IN THE ZIP -->
  <section class="card">
    <h3>what's in the zip</h3>
    <dl class="kv">
      <dt class="mono">data/&lt;YYYY-MM-DD&gt;/&lt;keyhash&gt;.jsonl</dt>
      <dd>recorded transactions, one JSON object per line, grouped by UTC day and API key hash. Files ending in <span class="mono">.partial.jsonl</span> contain only the matching subset of that day's traces.</dd>
      <dt class="mono">agent/CLAUDE.md</dt>
      <dd>instructions for an LLM agent who receives the zip — explains the data layout, the JSONL schema, and what kinds of questions the operator typically asks.</dd>
      <dt class="mono">agent/jq-cheatsheet.md</dt>
      <dd>one-liners for slicing the JSONL with <span class="mono">jq</span> — common patterns like filtering by status, counting tool calls, reconstructing sessions.</dd>
      <dt class="mono">README.md</dt>
      <dd>operator-facing explainer with a summary of what's in this specific export: trace count, date range, filters applied.</dd>
    </dl>
  </section>
</div>

<style>
  /* Reuses the OverviewTab .card / .kv / .err / .dim / .foot grammar so
     this page reads as the same visual idiom. No new colors, no new
     role fills — just edges and spacing. */

  .export {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--gap-4);
    overflow: auto;
    flex: 1;
    min-height: 0;
    max-width: 760px;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }
  .head .title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .head .subtitle {
    font-size: 12px;
    color: var(--fg-dim);
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
  }
  .card h3 {
    margin: 0;
    padding: var(--gap-2) var(--gap-3);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }

  /* Form grid: label on the left, control on the right. Mirrors the
     .kv proportions so the form lines up with the preview card below. */
  .form {
    display: grid;
    grid-template-columns: 140px 1fr;
    font-size: 12px;
  }
  .form .row {
    display: contents;
  }
  .form label {
    padding: 6px var(--gap-3);
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--sans);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .form label .hint {
    color: var(--fg-dim);
    font-size: 10.5px;
    text-transform: none;
    letter-spacing: 0;
  }
  .form .input,
  .form select {
    margin: 0;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding: 6px var(--gap-3);
    background: var(--bg);
    color: var(--fg);
    font-family: var(--mono);
    font-size: 11.5px;
    outline: none;
  }
  .form .input:focus,
  .form select:focus {
    border-bottom-color: var(--accent-dim);
  }
  .form select {
    appearance: none;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%),
      linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 12px,
      calc(100% - 9px) 12px;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    padding-right: 22px;
  }
  .form .row:last-child label,
  .form .row:last-child .input,
  .form .row:last-child select {
    border-bottom: 0;
  }

  /* Reused kv block from OverviewTab. */
  .kv {
    margin: 0;
    display: grid;
    grid-template-columns: 240px 1fr;
    font-size: 12px;
  }
  .kv dt {
    padding: 6px var(--gap-3);
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--sans);
  }
  .kv dd {
    margin: 0;
    padding: 6px var(--gap-3);
    border-bottom: 1px solid var(--border);
    color: var(--fg);
    overflow-wrap: anywhere;
  }
  .kv dt:last-of-type,
  .kv dd:last-of-type { border-bottom: 0; }

  /* Actions row matches FilterSidebar.actions, including the primary
     button rule. Single .primary that uses var(--accent) with --bg text
     — same pattern as the Apply button. */
  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-3);
  }
  .actions .primary {
    align-self: flex-start;
    background: var(--accent);
    color: var(--bg);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: 6px 14px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .actions .primary:hover {
    background: var(--accent-dim);
    border-color: var(--accent-dim);
  }
  .actions .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .dim { color: var(--fg-dim); }
  .err { color: var(--err); }
  .foot {
    padding: 0 var(--gap-3) var(--gap-3);
    font-size: 11px;
    line-height: 1.4;
  }
  .debug {
    border-top: 1px solid var(--border);
    padding: var(--gap-2) var(--gap-3);
    font-family: var(--mono);
    font-size: 10.5px;
    overflow-wrap: anywhere;
  }
</style>
