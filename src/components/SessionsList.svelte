<script lang="ts">
  // SessionsList — sessions-grouped list view.
  //
  // Direct port of the original viewer's loadSessions() + renderSessionsList()
  // path (api-log/internal/viewer/static/index.html, ~lines 803-859 and the
  // sess-row click handler around line 1387-1395).
  //
  // Behavior preserved 1:1:
  //   - fetches GET api/sessions?since=&limit= (only those two params)
  //   - columns: last seen | turns | status | path | model | session
  //   - clicking a session row fetches
  //       api/traces?session_root_id=<id>&limit=1
  //     and opens the *latest* trace in that session (the parent's
  //     selectTrace() does the actual navigation).
  //   - status messages: `${n} sessions` / `sessions failed` / `open session
  //     failed`.
  //   - pager controls (prev / next / info) get the "sessions empty" treatment:
  //     both disabled, info text = "empty" or "<n> sessions".
  //
  // Pager controls live outside this component in the original layout — we
  // surface that state via the `onPagerChange` callback so the parent can
  // wire it into its existing pager UI without us re-implementing it.

  // ---------- shared utility signatures (invented; documented in notes) ----------
  //
  // authFetch: same shape as the global fetch (URL string -> Promise<Response>),
  //   wrapper that injects the viewer's auth header. Caller passes it in.
  // setStatus: (text: string, kind: 'good' | 'bad' | '') => void — pushes a
  //   line to the shared status bar.
  // onSelectTrace: (id: string) => void — parent handles the actual trace
  //   selection / hash routing.
  // onPagerChange: ({ prevDisabled, nextDisabled, info }) => void — lets the
  //   parent reflect the sessions-mode pager state.

  export interface SessionRow {
    session_root_id: string;
    last_ts?: string | null;
    last_status?: number | null;
    last_path?: string | null;
    last_model?: string | null;
    n_turns?: number | null;
  }

  export interface SessionsFilters {
    since?: string;
    limit?: string;
  }

  interface Props {
    filters: SessionsFilters;
    /** bump to force a reload even if filters didn't change (e.g. mode switch). */
    reloadKey?: number;
    authFetch: (url: string) => Promise<Response>;
    setStatus: (text: string, kind?: 'good' | 'bad' | '') => void;
    onSelectTrace: (id: string) => void;
    onPagerChange?: (state: { prevDisabled: boolean; nextDisabled: boolean; info: string }) => void;
  }

  const {
    filters,
    reloadKey = 0,
    authFetch,
    setStatus,
    onSelectTrace,
    onPagerChange,
  }: Props = $props();

  let sessions = $state<SessionRow[]>([]);

  // ---------- fetch ----------

  async function loadSessions() {
    const qs = new URLSearchParams();
    if (filters.since) qs.set('since', filters.since);
    if (filters.limit) qs.set('limit', filters.limit);
    try {
      const r = await authFetch('api/sessions?' + qs.toString());
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      sessions = j.sessions || [];
      setStatus(`${sessions.length} sessions`, 'good');
      onPagerChange?.({
        prevDisabled: true,
        nextDisabled: true,
        info: sessions.length ? `${sessions.length} sessions` : 'empty',
      });
    } catch (_e) {
      setStatus('sessions failed', 'bad');
    }
  }

  // Re-fetch on filters or explicit reloadKey change. Effect sees filters as
  // a whole — Svelte's reactivity already tracks reads through $props().
  $effect(() => {
    // touch every field so the effect re-runs when any of them changes
    void filters.since;
    void filters.limit;
    void reloadKey;
    loadSessions();
  });

  // ---------- row click: open latest trace in the session ----------

  async function openLatest(sessionRootId: string) {
    try {
      const r = await authFetch(`api/traces?session_root_id=${sessionRootId}&limit=1`);
      const j = await r.json();
      const latest = (j.traces || [])[0];
      if (latest) onSelectTrace(latest.id);
    } catch (_e) {
      setStatus('open session failed', 'bad');
    }
  }

  // ---------- formatters (mirror original helpers) ----------

  function shortTs(ts?: string | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour12: false })
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function shortId(id?: string | null): string {
    return id ? id.slice(-8) : '';
  }

  function statusClass(s?: number | null): string {
    if (!s || s < 100) return 'st-x';
    const b = Math.floor(s / 100);
    return b === 2 ? 'st-2' : b === 4 ? 'st-4' : b === 5 ? 'st-5' : 'st-x';
  }
</script>

<table>
  <thead>
    <tr>
      <th>last seen</th>
      <th>turns</th>
      <th>status</th>
      <th>path</th>
      <th>model</th>
      <th>session</th>
    </tr>
  </thead>
  <tbody>
    {#each sessions as s (s.session_root_id)}
      <!-- Clicking opens the *latest* trace in this session — that's where
           the most recent activity is. From there, the session tab shows the
           whole tree. -->
      <tr
        class="sess-row"
        onclick={() => openLatest(s.session_root_id)}
      >
        <td class="t">{shortTs(s.last_ts)}</td>
        <td class="s n">{s.n_turns ?? ''}</td>
        <td class="s {statusClass(s.last_status)}">{s.last_status ?? '—'}</td>
        <td class="path">{s.last_path ?? ''}</td>
        <td class="m">{s.last_model ?? '—'}</td>
        <td class="sess" title={s.session_root_id ?? ''}>{shortId(s.session_root_id)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  /* Mirrors the original #list table styles. Scoped to this component so
     TracesList can keep its own copy without collision. */
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-elev);
  }
  th {
    text-align: left;
    font-weight: 500;
    color: var(--fg-muted);
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.t { width: 88px; color: var(--fg-dim); }
  td.s { width: 44px; }
  td.m { width: 88px; color: var(--fg-dim); }
  td.sess { width: 80px; color: var(--fg-muted); }

  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--bg-elev-2); }

  /* sessions-mode row tints — matches original lines 318-319 */
  tr.sess-row td.path { color: var(--fg-dim); }
  tr.sess-row td.n { color: var(--accent); }

  /* status-class color hooks (defined here so the component is
     self-contained; identical to globals .st-2/.st-4/.st-5/.st-x). */
  td.s.st-2 { color: var(--ok); }
  td.s.st-4 { color: var(--warn); }
  td.s.st-5 { color: var(--err); }
  td.s.st-x { color: var(--fg-muted); }
</style>
