<script lang="ts">
  // EventsTab — SSE event table with t_delta / event / data columns.
  // Click a row to toggle expansion (data column wraps + shows full payload).
  //
  // Port of original index.html lines ~941-950 (the `tab === 'events'` branch
  // inside renderDetailTab) plus the .events-table CSS block (lines 245-256).
  //
  // 1:1 behavior:
  //   - Events come from trace.resp.events (array of { t_delta_ms, event, data }).
  //   - t_delta cell: `${t_delta_ms} ms` or '—' when null/undefined.
  //   - event cell: e.event or '(data-only)' when falsy.
  //   - data cell: stringified if object; raw string otherwise. Single-line
  //     ellipsis by default; row.expanded → pre-wrap full text.
  //   - Click row toggles `expanded` class (Svelte handles HTML escaping
  //     automatically via {…}, so no esc() helper is needed).

  type SSEEvent = {
    t_delta_ms?: number | null;
    event?: string | null;
    data?: unknown;
  };

  type Trace = {
    resp?: {
      events?: SSEEvent[];
    } | null;
  } | null | undefined;

  let { trace }: { trace?: Trace } = $props();

  const events: SSEEvent[] = $derived((trace?.resp?.events) || []);

  // Per-row expansion state. Keyed by index — events list is rebuilt when
  // the trace changes, so a fresh state instance is acceptable.
  let expanded = $state<Set<number>>(new Set());

  // Reset expansion when the underlying events array identity changes
  // (e.g. user opens a different trace).
  $effect(() => {
    // depend on the events reference
    events;
    expanded = new Set();
  });

  function toggle(i: number) {
    const next = new Set(expanded);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    expanded = next;
  }

  function fmtData(d: unknown): string {
    if (d === undefined || d === null) return '';
    if (typeof d === 'object') {
      try {
        return JSON.stringify(d);
      } catch {
        return String(d);
      }
    }
    return String(d);
  }
</script>

<table class="events-table">
  <thead>
    <tr>
      <th>t_delta</th>
      <th>event</th>
      <th>data</th>
    </tr>
  </thead>
  <tbody>
    {#each events as e, i (i)}
      <tr
        class:expanded={expanded.has(i)}
        onclick={() => toggle(i)}
      >
        <td class="t">{e.t_delta_ms != null ? `${e.t_delta_ms} ms` : '—'}</td>
        <td class="ev">{e.event || '(data-only)'}</td>
        <td class="data" title="click to expand">{fmtData(e.data)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  /* Mirrors original .events-table block (index.html lines 245-256).
     Uses app.css variables; falls back to local approximations for tokens
     not yet declared in app.css (--muted, --muted-2, --line, --panel, --fg-dim). */
  .events-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .events-table th,
  .events-table td {
    text-align: left;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .events-table th {
    color: var(--fg-muted);
    font-weight: 500;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .events-table td.t {
    width: 72px;
    color: var(--fg-dim);
  }
  .events-table td.ev {
    width: 180px;
    color: var(--accent);
  }
  .events-table td.data {
    color: var(--fg-dim);
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .events-table tr {
    cursor: pointer;
  }
  .events-table tbody tr:hover {
    background: var(--bg-elev);
  }
  .events-table tr.expanded td.data {
    white-space: pre-wrap;
    max-width: none;
    overflow: visible;
    word-break: break-word;
  }
</style>
