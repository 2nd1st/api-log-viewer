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
  //   - Generate is authFetch -> Blob -> synthesized <a download> click,
  //     because a navigation can't carry the Authorization header.
  //
  // INVENTED prop signature:
  //   - authFetch: same fn the rest of the app uses. Used both for the
  //     one-shot /api/traces sample (to populate autocomplete datalists)
  //     and for the actual /api/export blob download.

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
  //
  // NB: f_limit is a string deliberately. An earlier pass used a
  // type="number" input bound to string state; Svelte's two-way binding
  // coerced the value to a `number` after the first generate() commit,
  // and the subsequent .trim() call blew up with "a(...).trim is not a
  // function". Keeping the input as type="text" + inputmode="numeric"
  // sidesteps the coercion entirely and matches how the other filter
  // fields work.

  let f_status = $state<string>('');
  let f_path = $state<string>('');
  let f_model = $state<string>('');
  let f_keyhash = $state<string>('');
  let f_session = $state<string>('');
  let f_since = $state<string>('');
  let f_until = $state<string>('');
  let f_limit = $state<string>('1000');

  // ---------- autocomplete sample ----------
  //
  // One-shot probe of /api/traces?limit=200 on mount. We collect the
  // distinct path / model / key_hash (8-char prefix) values seen in the
  // sample and surface them as <datalist> options. This is a snapshot,
  // not live — typing in the filter inputs does NOT re-fetch. The point
  // is to give the operator "did I mean /v1/messages?" hints, not a
  // full search index.

  let knownPaths = $state<string[]>([]);
  let knownModels = $state<string[]>([]);
  let knownKeys = $state<string[]>([]);
  let sampleLoaded = false;

  async function loadSample(): Promise<void> {
    if (sampleLoaded) return;
    sampleLoaded = true;
    try {
      const r = await authFetch('api/traces?limit=200');
      if (!r.ok) return;
      const j = await r.json();
      const rows: Array<{ path?: string; model?: string; key_hash?: string }> =
        j.traces || [];
      const paths = new Set<string>();
      const models = new Set<string>();
      const keys = new Set<string>();
      for (const t of rows) {
        if (t.path) paths.add(t.path);
        if (t.model) models.add(t.model);
        if (t.key_hash) keys.add(t.key_hash.slice(0, 8));
      }
      knownPaths = [...paths].sort();
      knownModels = [...models].sort();
      knownKeys = [...keys].sort();
    } catch {
      /* sample is best-effort; silent failure is fine */
    }
  }

  $effect(() => {
    void loadSample();
  });

  // ---------- query string construction ----------
  //
  // buildQS() returns a URLSearchParams with the current filter values,
  // omitting empty fields. Used for both the download URL and the URL
  // hint below the button. Validation is the server's job — bad input
  // gets a 400 with a structured error, which we surface as genError.

  function buildQS(): URLSearchParams {
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
    return qs;
  }

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

  // The URL Generate will actually request. Surfaced as a hint below
  // the button — pure transparency, not a preview semantic.
  const requestUrl = $derived(api('api/export?' + buildQS().toString()));
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
          list="x-dl-paths"
          placeholder="/v1/* (prefix)"
          autocomplete="off"
          bind:value={f_path}
        />
        <datalist id="x-dl-paths">
          {#each knownPaths as v (v)}
            <option value={v}></option>
          {/each}
        </datalist>
      </div>

      <div class="row">
        <label for="x-model">model</label>
        <input
          class="input"
          id="x-model"
          list="x-dl-models"
          placeholder="any"
          autocomplete="off"
          bind:value={f_model}
        />
        <datalist id="x-dl-models">
          {#each knownModels as v (v)}
            <option value={v}></option>
          {/each}
        </datalist>
      </div>

      <div class="row">
        <label for="x-keyhash">key_hash <span class="hint">(8 or 16-char prefix)</span></label>
        <input
          class="input"
          id="x-keyhash"
          list="x-dl-keys"
          placeholder="prefix"
          autocomplete="off"
          bind:value={f_keyhash}
        />
        <datalist id="x-dl-keys">
          {#each knownKeys as v (v)}
            <option value={v}></option>
          {/each}
        </datalist>
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
        <label for="x-limit">limit <span class="hint">(no upper bound)</span></label>
        <input
          class="input"
          id="x-limit"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="off"
          bind:value={f_limit}
        />
      </div>
    </div>
  </section>

  <!-- GENERATE -->
  <section class="card">
    <h3>generate</h3>
    <div class="actions">
      <button
        type="button"
        class="primary"
        onclick={generate}
        disabled={generating}
      >
        {generating ? 'generating…' : 'Generate &amp; download'}
      </button>
      {#if genError}
        <div class="err foot">{genError}</div>
      {/if}
    </div>
    <div class="dim foot debug" title={requestUrl}>{requestUrl}</div>
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

  /* Form grid: label on the left, control on the right. The <datalist>
     elements render as display:none by default, so they sit invisibly
     in the grid cells without disturbing the layout. */
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
