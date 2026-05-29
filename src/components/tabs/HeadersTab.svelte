<script lang="ts">
  // Headers tab — request/response header key-value grids.
  //
  // 1:1 port of the `tab === 'headers'` branch in
  // internal/viewer/static/index.html:
  //
  //   } else if (tab === 'headers') {
  //     const reqH = (tr.req && tr.req.headers) || {};
  //     const resH = (tr.resp && tr.resp.headers) || {};
  //     const kv = (h) => `<div class="kv">…</div>`;
  //     panel.innerHTML = `
  //       <h3 class="section">request</h3>${kv(reqH)}
  //       <h3 class="section more">response</h3>${kv(resH)}`;
  //   }
  //
  // Same exact strings ("request" / "response"), same .kv grid markup,
  // same .section / .section.more class pattern. Svelte handles escaping
  // automatically, replacing the original esc() calls.

  // Invented prop signature (no shared types module exists yet).
  // The caller passes the full trace object — same `tr` shape as the
  // original viewer:
  //   tr.req.headers?:  Record<string, string>
  //   tr.resp.headers?: Record<string, string>
  type HeaderMap = Record<string, string>;
  interface TraceShape {
    req?: { headers?: HeaderMap } | null;
    resp?: { headers?: HeaderMap } | null;
  }

  const { trace }: { trace: TraceShape | null | undefined } = $props();

  const reqH = $derived<HeaderMap>((trace?.req && trace.req.headers) || {});
  const resH = $derived<HeaderMap>((trace?.resp && trace.resp.headers) || {});

  // Object.entries preserves insertion order, matching the original.
  const reqEntries = $derived(Object.entries(reqH));
  const resEntries = $derived(Object.entries(resH));
</script>

<h3 class="section">request</h3>
<div class="kv">
  {#each reqEntries as [k, v] (k)}
    <div class="k">{k}</div>
    <div class="v">{v}</div>
  {/each}
</div>

<h3 class="section more">response</h3>
<div class="kv">
  {#each resEntries as [k, v] (k)}
    <div class="k">{k}</div>
    <div class="v">{v}</div>
  {/each}
</div>

<style>
  /* Mirrors the original detail-panel styling for h3.section and .kv,
     translated onto the new zinc palette (var(--border) replaces --line,
     var(--bg-elev) replaces --panel, var(--fg-muted)/--fg-dim replace
     --muted/--muted-2). */

  h3.section {
    margin: 0 0 6px;
    font-size: 10px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  h3.section + * {
    margin-top: 0;
  }
  h3.section.more {
    margin-top: 18px;
  }

  .kv {
    font-family: var(--mono);
    font-size: 11.5px;
    display: grid;
    grid-template-columns: 180px 1fr;
    border-top: 1px solid var(--border);
  }
  .kv > div {
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kv .k {
    color: var(--fg-muted);
    background: var(--bg-elev);
  }
</style>
