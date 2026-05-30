<script lang="ts">
  // Settings — viewer-side preferences + token surface + read-only
  // backend info + about.
  //
  // PHILOSOPHY (viewer/PHILOSOPHY.md):
  //   - The viewer holds no state the backend doesn't already know
  //     about; everything here is either a local presentation
  //     preference (display section) or a read-only mirror of backend
  //     state (backend section). Plugin/gate/redact config does NOT
  //     live here — that's a backend YAML concern (principle 6).
  //   - Restraint aesthetic: same .card + .kv pattern as
  //     OverviewTab. No role-coded background fills, no decorative
  //     accents. Single --accent. Severity tones only on signal.
  //   - We render what's in /healthz; if a field is absent (older
  //     backend that hasn't been redeployed with total_bytes yet) we
  //     show "—".
  //
  // localStorage keys (do not rename — operators may have existing
  // values; same constants as lib/api.ts and TracesList.svelte):
  //   apilog.default_path        — default path filter, fallback '/v1/*'
  //   apilog.traces.autorefresh  — traces list auto-refresh cadence
  //   apilog.token               — admin Bearer token

  import { onMount } from 'svelte';
  import { humanBytes } from '../lib/format';
  import { DEFAULT_PATH_KEY, getToken } from '../lib/api';

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    onOpenAuthModal: () => void;
  }

  const { authFetch, onOpenAuthModal }: Props = $props();

  // ---------- DISPLAY: default path filter ----------

  const PATH_DEFAULT = '/v1/*';

  function readPath(): string {
    try {
      return localStorage.getItem(DEFAULT_PATH_KEY) || PATH_DEFAULT;
    } catch {
      return PATH_DEFAULT;
    }
  }

  let pathValue = $state<string>(readPath());
  let pathHintVisible = $state<boolean>(false);
  let pathHintTimer: ReturnType<typeof setTimeout> | null = null;

  function persistPath() {
    const v = pathValue.trim() || PATH_DEFAULT;
    pathValue = v;
    try {
      localStorage.setItem(DEFAULT_PATH_KEY, v);
    } catch {
      // private mode / sandboxed iframe — silently no-op, same as
      // TracesList.svelte's readPersistedRefresh().
    }
    pathHintVisible = true;
    if (pathHintTimer) clearTimeout(pathHintTimer);
    pathHintTimer = setTimeout(() => {
      pathHintVisible = false;
    }, 1000);
  }

  // ---------- DISPLAY: save attachments (backend media extraction) ----------
  //
  // Backend GET /api/config/media → { save_attachments: bool, source: string }
  // Backend PUT /api/config/media { save_attachments } persists to
  // runtime_overrides.json and updates in-memory config so subsequent
  // traces honor it immediately. Per Phase K § 5.3 the change is NOT
  // retroactive — existing files on disk are left alone.
  //
  // This is the only DISPLAY-section control that talks to the backend
  // (everything else is local localStorage). We render it here anyway
  // because operationally the operator thinks of it as a viewer setting
  // — the "do extracted files show up in the export bundle" knob.

  type MediaCfgState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; value: boolean; source: string };

  let mediaCfg = $state<MediaCfgState>({ kind: 'idle' });
  let mediaHintVisible = $state<boolean>(false);
  let mediaHintTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadMediaCfg() {
    mediaCfg = { kind: 'loading' };
    try {
      const r = await authFetch('api/config/media');
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { save_attachments?: boolean; source?: string };
      mediaCfg = {
        kind: 'ready',
        value: j.save_attachments === true,
        source: typeof j.source === 'string' ? j.source : 'default',
      };
    } catch (e: any) {
      mediaCfg = { kind: 'error', message: e?.message ?? String(e) };
    }
  }

  async function onMediaToggle(e: Event) {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    // Optimistic UI: flip immediately, revert on failure.
    const prev = mediaCfg;
    mediaCfg =
      mediaCfg.kind === 'ready'
        ? { ...mediaCfg, value: checked }
        : { kind: 'ready', value: checked, source: 'override' };
    try {
      const r = await authFetch('api/config/media', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save_attachments: checked }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { save_attachments?: boolean; source?: string };
      mediaCfg = {
        kind: 'ready',
        value: j.save_attachments === true,
        source: typeof j.source === 'string' ? j.source : 'override',
      };
      mediaHintVisible = true;
      if (mediaHintTimer) clearTimeout(mediaHintTimer);
      mediaHintTimer = setTimeout(() => {
        mediaHintVisible = false;
      }, 1000);
    } catch (e: any) {
      mediaCfg =
        prev.kind === 'ready'
          ? prev
          : { kind: 'error', message: e?.message ?? String(e) };
    }
  }

  // ---------- DISPLAY: traces auto-refresh ----------

  type RefreshOpt = 'off' | '5s' | '10s' | '30s' | '60s' | '5m';
  const REFRESH_OPTIONS: RefreshOpt[] = ['off', '5s', '10s', '30s', '60s', '5m'];
  const REFRESH_KEY = 'apilog.traces.autorefresh';

  function readRefresh(): RefreshOpt {
    try {
      const v = localStorage.getItem(REFRESH_KEY);
      if (v && (REFRESH_OPTIONS as string[]).includes(v)) {
        return v as RefreshOpt;
      }
    } catch {
      // see persistPath()
    }
    return 'off';
  }

  let refreshOpt = $state<RefreshOpt>(readRefresh());

  function onRefreshChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value as RefreshOpt;
    refreshOpt = v;
    try {
      localStorage.setItem(REFRESH_KEY, v);
    } catch {
      // see persistPath()
    }
  }

  // ---------- DISPLAY: reset to defaults ----------

  function resetDefaults() {
    try {
      localStorage.removeItem(DEFAULT_PATH_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      // see persistPath()
    }
    pathValue = PATH_DEFAULT;
    refreshOpt = 'off';
    pathHintVisible = true;
    if (pathHintTimer) clearTimeout(pathHintTimer);
    pathHintTimer = setTimeout(() => {
      pathHintVisible = false;
    }, 1000);
  }

  // ---------- AUTH: masked token ----------

  // We read the token through getToken() — same module-level cell the
  // AuthModal writes to via setToken(). The masked display only updates
  // when this component remounts or after the parent re-opens the modal
  // and we get rerendered; that's intentional and matches the rest of
  // the viewer's "snapshot on mount" stance.
  let tokenSnapshot = $state<string>(getToken());

  function refreshTokenSnapshot() {
    tokenSnapshot = getToken();
  }

  // Re-snapshot whenever the window regains focus — covers the case
  // where the operator clicked "change token" and saved in the modal.
  // No effect/derived loop; just a passive listener.
  onMount(() => {
    const onFocus = () => refreshTokenSnapshot();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  const maskedToken = $derived.by<string>(() => {
    const t = tokenSnapshot;
    if (!t) return '(not set)';
    if (t.length <= 16) return t;
    return t.slice(0, 8) + '…' + t.slice(-8);
  });

  function openAuthModal() {
    onOpenAuthModal();
    // The modal closes async; refresh on focus covers the saved case.
  }

  // ---------- BACKEND: /healthz one-shot ----------

  interface HealthzCounters {
    appended?: number;
    drop_writer_full?: number;
    drop_jsonl_fail?: number;
    drop_sqlite_fail?: number;
    total_bytes?: number;
  }

  interface Healthz {
    version?: string;
    uptime_seconds?: number;
    counters?: HealthzCounters;
  }

  type HealthzState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: Healthz; fetchedAt: number };

  let healthz = $state<HealthzState>({ kind: 'idle' });

  // Tick for "last poll: X ago". 1s cadence is enough.
  let now = $state<number>(Date.now());

  onMount(() => {
    let cancelled = false;
    healthz = { kind: 'loading' };
    (async () => {
      try {
        const r = await authFetch('healthz');
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Healthz;
        if (cancelled) return;
        healthz = { kind: 'ready', data: j, fetchedAt: Date.now() };
      } catch (e: any) {
        if (cancelled) return;
        healthz = { kind: 'error', message: e?.message ?? String(e) };
      }
    })();

    // Load backend media config in parallel; failures surface inline on
    // the row, not as a global error (a 404 here would mean the operator
    // is on an older backend without Phase K endpoints — non-fatal).
    void loadMediaCfg();

    const tick = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  });

  function fmtUptime(s: number | undefined): string {
    if (s == null || !Number.isFinite(s)) return '—';
    const sec = Math.max(0, Math.floor(s));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  function fmtNum(n: number | null | undefined): string {
    if (n == null) return '—';
    return n.toLocaleString();
  }

  const dataDirLabel = $derived.by(() => {
    if (healthz.kind !== 'ready') return '—';
    const b = healthz.data.counters?.total_bytes;
    if (b == null) return '—';
    return humanBytes(b);
  });

  const appendedLabel = $derived.by(() => {
    if (healthz.kind !== 'ready') return '—';
    return fmtNum(healthz.data.counters?.appended);
  });

  const dropsTotalLabel = $derived.by(() => {
    if (healthz.kind !== 'ready') return '—';
    const c = healthz.data.counters || {};
    const total =
      ((c.drop_writer_full ?? 0) | 0) +
      ((c.drop_jsonl_fail ?? 0) | 0) +
      ((c.drop_sqlite_fail ?? 0) | 0);
    return fmtNum(total);
  });

  const lastPollLabel = $derived.by(() => {
    if (healthz.kind !== 'ready') return '—';
    const ageSec = Math.max(0, Math.floor((now - healthz.fetchedAt) / 1000));
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    return `${Math.floor(ageSec / 3600)}h ago`;
  });
</script>

<div class="settings">
  <!-- DISPLAY -->
  <section class="card">
    <h3>display</h3>
    <dl class="kv">
      <dt>default path filter</dt>
      <dd>
        <div class="row">
          <input
            type="text"
            bind:value={pathValue}
            onblur={persistPath}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            placeholder="/v1/*"
            spellcheck="false"
            autocomplete="off"
          />
          <button type="button" onclick={persistPath}>save</button>
          <span class="hint" class:show={pathHintVisible}>saved</span>
        </div>
        <div class="note">trailing <code>*</code> = prefix match. exact path = exact match. blank reverts to <code>/v1/*</code>.</div>
      </dd>

      <dt>save attachments</dt>
      <dd>
        <div class="row">
          {#if mediaCfg.kind === 'loading' || mediaCfg.kind === 'idle'}
            <span class="dim mono">loading…</span>
          {:else if mediaCfg.kind === 'error'}
            <label class="row">
              <input type="checkbox" disabled />
              <span class="dim">unavailable ({mediaCfg.message})</span>
            </label>
          {:else}
            <label class="row">
              <input
                type="checkbox"
                checked={mediaCfg.value}
                onchange={onMediaToggle}
              />
              <span class="mono dim">source: {mediaCfg.source}</span>
            </label>
            <span class="hint" class:show={mediaHintVisible}>saved</span>
          {/if}
        </div>
        <div class="note">writes extracted images/files to <code>data/&lt;date&gt;/&lt;keyhash&gt;/media/</code>. set in YAML or here; runtime value wins.</div>
      </dd>

      <dt>traces auto-refresh</dt>
      <dd>
        <select value={refreshOpt} onchange={onRefreshChange}>
          {#each REFRESH_OPTIONS as opt (opt)}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
        <div class="note">cadence for the traces list page-1 poller.</div>
      </dd>

      <dt>reset</dt>
      <dd>
        <button type="button" onclick={resetDefaults}>reset to defaults</button>
        <div class="note">clears the display localStorage keys on this device.</div>
      </dd>
    </dl>
  </section>

  <!-- AUTH -->
  <section class="card">
    <h3>auth</h3>
    <dl class="kv">
      <dt>admin token</dt>
      <dd>
        <span class="mono">{maskedToken}</span>
      </dd>
      <dt>change</dt>
      <dd>
        <button type="button" onclick={openAuthModal}>change token</button>
        <div class="note">
          the token is sent as <code>Bearer</code> in <code>/api/*</code> and
          <code>/healthz</code> requests; cleared on this device only.
        </div>
      </dd>
    </dl>
  </section>

  <!-- BACKEND -->
  <section class="card">
    <h3>backend</h3>
    {#if healthz.kind === 'loading'}
      <div class="foot dim">loading /healthz…</div>
    {:else if healthz.kind === 'error'}
      <div class="err">healthz fetch failed: {healthz.message}</div>
    {:else if healthz.kind === 'ready'}
      <dl class="kv">
        <dt>version</dt>       <dd class="mono">{healthz.data.version ?? '—'}</dd>
        <dt>uptime</dt>        <dd class="mono">{fmtUptime(healthz.data.uptime_seconds)}</dd>
        <dt>data dir</dt>      <dd class="mono">{dataDirLabel}</dd>
        <dt>appended</dt>      <dd class="mono">{appendedLabel}</dd>
        <dt>drops total</dt>   <dd class="mono">{dropsTotalLabel}</dd>
        <dt>last poll</dt>     <dd class="mono">{lastPollLabel}</dd>
      </dl>
    {:else}
      <div class="foot dim">—</div>
    {/if}
  </section>

  <!-- ABOUT -->
  <section class="card">
    <h3>about</h3>
    <dl class="kv">
      <dt>what</dt>
      <dd>api-log-viewer — a Svelte 5 client for the api-log recorder</dd>
      <dt>upstream</dt>
      <dd>
        <a
          href="http://gitea.homelab.lan/leoyun/api-log-viewer"
          target="_blank"
          rel="noopener noreferrer"
        >gitea.homelab.lan/leoyun/api-log-viewer</a>
      </dd>
    </dl>
  </section>
</div>

<style>
  /* Phase 2 C density pass — Phase L canonical tokens.
     Card chrome stripped; sections separated by a top hairline. Label
     left mono (per per-file rule — the dt column reads as data keys).
     Toggle switches use surface-elevated track + accent on-indicator
     via appearance:none restyle of the native checkbox. */

  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: 0;
  }

  /* Strip card chrome — top hairline + uppercase section label only. */
  .card {
    border: 0;
    border-top: 1px solid var(--border);
    background: transparent;
    padding-top: var(--space-3);
  }
  .card h3 {
    margin: 0 0 var(--space-3);
    padding: 0;
    font-family: var(--font-sans);
    font-size: var(--size-label);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
    background: transparent;
    border: 0;
  }

  .kv {
    margin: 0;
    display: grid;
    grid-template-columns: 180px 1fr;
    column-gap: var(--space-3);
    row-gap: 0;
    font-size: var(--size-input);
  }
  .kv dt {
    padding: 6px 0;
    color: var(--fg-muted);
    border-bottom: 1px solid var(--border);
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    display: flex;
    align-items: center;
  }
  .kv dd {
    margin: 0;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    color: var(--fg);
    font-size: var(--size-input);
    overflow-wrap: anywhere;
  }
  .kv dt:last-of-type,
  .kv dd:last-of-type { border-bottom: 0; }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* Inputs match FilterSidebar. */
  .kv input[type="text"],
  .kv select {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: var(--size-input);
    line-height: 1.4;
    outline: none;
    box-shadow: none;
  }
  .kv input[type="text"]:focus,
  .kv select:focus {
    border-color: var(--accent);
  }
  .row input[type="text"] {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* Outline buttons match FilterSidebar Apply. */
  .kv button {
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 6px 12px;
    font-family: var(--font-sans);
    font-size: var(--size-body);
    cursor: pointer;
    box-shadow: none;
  }
  .kv button:hover {
    color: var(--fg);
    border-color: var(--fg);
  }

  /* Toggle switch — restyle native checkbox via appearance:none.
     28px wide track, surface-elevated bg, hairline border, accent
     dot indicator when checked. No drop shadow. */
  .kv input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 28px;
    height: 16px;
    border-radius: var(--radius-md);
    background: var(--surface-elevated);
    border: 1px solid var(--border);
    position: relative;
    cursor: pointer;
    margin: 0;
    flex: none;
  }
  .kv input[type="checkbox"]::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 3px;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: var(--radius-sm);
    background: var(--border-strong);
    transition: left 120ms ease-out, background 120ms ease-out;
  }
  .kv input[type="checkbox"]:checked::after {
    left: 15px;
    background: var(--accent);
  }
  .kv input[type="checkbox"]:focus {
    outline: none;
    border-color: var(--accent);
  }
  .kv input[type="checkbox"]:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .note {
    margin-top: var(--space-1);
    font-size: var(--size-meta);
    color: var(--fg-dim);
    line-height: 1.5;
  }
  .note code {
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg-muted);
  }

  /* Tiny "saved" hint — fades in/out on persist. */
  .hint {
    font-size: var(--size-meta);
    color: var(--accent);
    opacity: 0;
    transition: opacity 160ms ease-out;
  }
  .hint.show {
    opacity: 1;
  }

  .dim { color: var(--fg-dim); }
  .err { padding: var(--space-2) 0; color: var(--err); font-size: var(--size-body); }
  .foot { padding: var(--space-2) 0; font-size: var(--size-meta); line-height: 1.4; }
</style>
