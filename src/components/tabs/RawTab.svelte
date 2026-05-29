<script lang="ts">
  // Raw tab — merges the retired Headers + Body tabs into a single,
  // collapsible four-section view. Order: request headers, request body,
  // response headers, response body. Bodies expanded by default; headers
  // collapsed by default. Each section header carries a size hint.
  //
  // The JSON pretty-print + elideHuge pipeline is brought over verbatim
  // from BodyTab.svelte (palette-clean since 51530f1). The header grid is
  // brought over from HeadersTab.svelte. Nothing else changes.
  //
  // When response.body is absent but response.events is present (streaming
  // SSE), the RESPONSE BODY section shows a pointer to the conversation
  // tab — never the retired events tab.

  import type { TraceBlob } from '../DetailPanel.svelte';

  const { trace }: { trace: TraceBlob | null | undefined } = $props();

  // ---------------------------------------------------------------------
  // Derived sub-objects: request side vs response side.
  // ---------------------------------------------------------------------
  type HeaderMap = Record<string, string>;

  const reqHeaders = $derived<HeaderMap>((trace?.req && trace.req.headers) || {});
  const resHeaders = $derived<HeaderMap>((trace?.resp && trace.resp.headers) || {});

  // Same `(body) || (body_b64)` fallback as the original BodyTab. jsonHL
  // stringifies a base64 fallback into a quoted JSON string — preserved.
  const reqBody = $derived<unknown>(
    (trace?.req && trace.req.body) || (trace?.req && trace.req.body_b64) || null,
  );
  const respBody = $derived<unknown>(
    (trace?.resp && trace.resp.body) || (trace?.resp && trace.resp.body_b64) || null,
  );
  const hasRespEvents = $derived<boolean>(
    Array.isArray(trace?.resp?.events) && (trace?.resp?.events?.length ?? 0) > 0,
  );

  const reqHeaderEntries = $derived(Object.entries(reqHeaders));
  const resHeaderEntries = $derived(Object.entries(resHeaders));

  // ---------------------------------------------------------------------
  // Collapse state. Bodies expanded, headers collapsed — per task spec.
  // ---------------------------------------------------------------------
  let openReqHeaders = $state(false);
  let openReqBody = $state(true);
  let openResHeaders = $state(false);
  let openResBody = $state(true);

  // ---------------------------------------------------------------------
  // Size hints. Headers count = number of pairs. Body size = humanBytes of
  // the JSON-stringified body length. For base64 fallback strings the
  // body comes in as a string; JSON.stringify gives a quoted form, which
  // is fine as a rough indicator of payload weight.
  // ---------------------------------------------------------------------
  function humanBytes(n: number): string {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function bodyByteSize(v: unknown): number {
    if (v == null) return 0;
    try {
      const s = JSON.stringify(v);
      return s ? s.length : 0;
    } catch {
      return 0;
    }
  }

  const reqHeadersCount = $derived(reqHeaderEntries.length);
  const resHeadersCount = $derived(resHeaderEntries.length);
  const reqBodyBytes = $derived(bodyByteSize(reqBody));
  const respBodyBytes = $derived(bodyByteSize(respBody));

  // ---------------------------------------------------------------------
  // JSON pretty-print pipeline (verbatim from BodyTab.svelte). The
  // elideHuge pre-walk swaps oversized strings (>4 KiB) for sentinel
  // tokens so the regex highlighter never sees a multi-MB literal. The
  // original is preserved in `elidedStore` for lazy expansion via the
  // delegated click handler on the panel root.
  // ---------------------------------------------------------------------
  const JSON_ELIDE_MAX_BYTES = 4096;

  let elidedStore = new Map<string, { value: string; parentKey: string }>();
  let elidedSeq = 0;

  function esc(s: unknown): string {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string),
    );
  }

  function looksLikeBase64Image(s: string, parentKey: string): boolean {
    if (typeof s !== 'string' || s.length < 1024) return false;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(s.slice(0, 96))) return false;
    const k = (parentKey || '').toLowerCase();
    return k === 'b64_json' || k === 'image' || k === 'data' || /image|png|jpeg|jpg|webp/.test(k);
  }

  function elideHuge(value: unknown, parentKey: string): unknown {
    if (value == null) return value;
    if (typeof value === 'string') {
      if (value.length > JSON_ELIDE_MAX_BYTES) {
        const token = '__apilog_elided_' + (++elidedSeq) + '__';
        elidedStore.set(token, { value, parentKey: parentKey || '' });
        return token;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v, i) => elideHuge(v, parentKey + '[' + i + ']'));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = elideHuge(v, k);
      }
      return out;
    }
    return value;
  }

  function jsonHL(value: unknown): string {
    const elided = elideHuge(value, '');
    const j = JSON.stringify(elided, null, 2);
    if (j == null) return '';
    let out = esc(j).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (m, str, colon, lit) => {
        if (str) return colon ? `<span class="json-key">${str}</span>${colon}` : `<span class="json-string">${str}</span>`;
        if (lit) return `<span class="json-${lit === 'null' ? 'null' : 'bool'}">${lit}</span>`;
        return `<span class="json-num">${m}</span>`;
      },
    );
    out = out.replace(
      /<span class="json-string">"(__apilog_elided_\d+__)"<\/span>/g,
      (_, tok) => {
        const e = elidedStore.get(tok);
        if (!e) return tok;
        const sz = humanBytes(e.value.length);
        const isImg = looksLikeBase64Image(e.value, e.parentKey);
        const imgBtn = isImg
          ? ` <button class="elide-btn" data-tok="${tok}" data-kind="image">show as image</button>`
          : '';
        const rawBtn = ` <button class="elide-btn" data-tok="${tok}" data-kind="raw">show raw</button>`;
        return `<span class="elided">[elided ${sz}${isImg ? ' · base64 image' : ''} · key=${esc(e.parentKey || '?')}]</span>${imgBtn}${rawBtn}`;
      },
    );
    return out;
  }

  // Reset the elision store at the start of each render pass so tokens
  // from a previous trace never leak into the current one. The store is
  // shared across reqHtml + respHtml within a single pass — they emit
  // monotonically-increasing token ids so collisions can't happen.
  const reqBodyHtml = $derived.by(() => {
    void reqBody;
    elidedStore = new Map();
    elidedSeq = 0;
    return reqBody ? jsonHL(reqBody) : '<span style="color:var(--fg-dim)">empty</span>';
  });
  const respBodyHtml = $derived.by(() => {
    void respBody;
    return respBody ? jsonHL(respBody) : null;
  });

  // Delegated click handler for the elision expand-buttons. Scoped to
  // this component root rather than a document-level listener.
  function onPanelClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest('.elide-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const tok = btn.dataset.tok || '';
    const kind = btn.dataset.kind || '';
    const e2 = elidedStore.get(tok);
    if (!e2) return;
    const host = btn.parentElement;
    if (!host) return;
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,' + e2.value.replace(/\s+/g, '');
      img.style.maxWidth = '100%';
      img.style.maxHeight = '420px';
      img.style.border = '1px solid var(--border)';
      img.style.borderRadius = 'var(--radius)';
      img.style.marginTop = '6px';
      host.appendChild(img);
      btn.remove();
    } else if (kind === 'raw') {
      const ta = document.createElement('textarea');
      ta.value = e2.value;
      ta.readOnly = true;
      ta.style.width = '100%';
      ta.style.minHeight = '200px';
      ta.style.maxHeight = '320px';
      ta.style.marginTop = '6px';
      ta.style.fontFamily = 'var(--mono)';
      ta.style.fontSize = '11px';
      ta.style.background = 'var(--bg)';
      ta.style.color = 'var(--fg-dim)';
      ta.style.border = '1px solid var(--border)';
      ta.style.borderRadius = 'var(--radius)';
      host.appendChild(ta);
      btn.remove();
    }
  }
</script>

<div class="raw" onclick={onPanelClick} role="presentation">
  <!-- REQUEST HEADERS -->
  <section class="sec">
    <button
      type="button"
      class="sec-head"
      aria-expanded={openReqHeaders}
      onclick={() => (openReqHeaders = !openReqHeaders)}
    >
      <span class="glyph">{openReqHeaders ? '▾' : '▸'}</span>
      <span class="label">request headers</span>
      <span class="hint">{reqHeadersCount} {reqHeadersCount === 1 ? 'entry' : 'entries'}</span>
    </button>
    {#if openReqHeaders}
      <div class="sec-body">
        {#if reqHeaderEntries.length > 0}
          <div class="kv">
            {#each reqHeaderEntries as [k, v] (k)}
              <div class="k">{k}</div>
              <div class="v">{v}</div>
            {/each}
          </div>
        {:else}
          <div class="empty">no headers captured</div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- REQUEST BODY -->
  <section class="sec">
    <button
      type="button"
      class="sec-head"
      aria-expanded={openReqBody}
      onclick={() => (openReqBody = !openReqBody)}
    >
      <span class="glyph">{openReqBody ? '▾' : '▸'}</span>
      <span class="label">request body</span>
      <span class="hint">{reqBodyBytes > 0 ? humanBytes(reqBodyBytes) : 'empty'}</span>
    </button>
    {#if openReqBody}
      <div class="sec-body">
        <pre class="json">{@html reqBodyHtml}</pre>
      </div>
    {/if}
  </section>

  <!-- RESPONSE HEADERS -->
  <section class="sec">
    <button
      type="button"
      class="sec-head"
      aria-expanded={openResHeaders}
      onclick={() => (openResHeaders = !openResHeaders)}
    >
      <span class="glyph">{openResHeaders ? '▾' : '▸'}</span>
      <span class="label">response headers</span>
      <span class="hint">{resHeadersCount} {resHeadersCount === 1 ? 'entry' : 'entries'}</span>
    </button>
    {#if openResHeaders}
      <div class="sec-body">
        {#if resHeaderEntries.length > 0}
          <div class="kv">
            {#each resHeaderEntries as [k, v] (k)}
              <div class="k">{k}</div>
              <div class="v">{v}</div>
            {/each}
          </div>
        {:else}
          <div class="empty">no headers captured</div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- RESPONSE BODY -->
  <section class="sec">
    <button
      type="button"
      class="sec-head"
      aria-expanded={openResBody}
      onclick={() => (openResBody = !openResBody)}
    >
      <span class="glyph">{openResBody ? '▾' : '▸'}</span>
      <span class="label">response body</span>
      <span class="hint"
        >{respBodyBytes > 0
          ? humanBytes(respBodyBytes)
          : hasRespEvents
            ? 'streamed'
            : 'empty'}</span
      >
    </button>
    {#if openResBody}
      <div class="sec-body">
        {#if respBodyHtml != null}
          <pre class="json">{@html respBodyHtml}</pre>
        {:else if hasRespEvents}
          <pre class="json"><span style="color:var(--fg-dim)"
              >response was streamed; see conversation tab for accumulated blocks</span
            ></pre>
        {:else}
          <pre class="json"><span style="color:var(--fg-dim)">empty</span></pre>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  /* Sections — hairline divider between them, no role-coded fills. */
  .raw {
    display: flex;
    flex-direction: column;
  }

  .sec {
    border-bottom: 1px solid var(--border);
  }
  .sec:first-child {
    border-top: 1px solid var(--border);
  }

  .sec-head {
    /* Reset default <button> chrome so the header reads as a row, not a
       pill. The collapse glyph + label + size hint do the talking. */
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    width: 100%;
    padding: var(--gap-2) var(--gap-3);
    background: transparent;
    border: 0;
    border-radius: 0;
    text-align: left;
    cursor: pointer;
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .sec-head:hover {
    color: var(--fg);
  }
  .sec-head .glyph {
    color: var(--fg-dim);
    width: 0.9em;
    display: inline-block;
    text-align: center;
  }
  .sec-head .label {
    font-weight: 500;
  }
  .sec-head .hint {
    margin-left: auto;
    color: var(--fg-dim);
    text-transform: none;
    letter-spacing: 0;
    font-size: 11px;
  }

  .sec-body {
    padding: 0 var(--gap-3) var(--gap-3);
  }

  .empty {
    color: var(--fg-dim);
    font-family: var(--mono);
    font-size: 11.5px;
    padding: var(--gap-2) 0;
  }

  /* Headers grid — same shape as the retired HeadersTab. */
  .kv {
    font-family: var(--mono);
    font-size: 11px;
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
  }
  .kv .v {
    color: var(--fg);
  }

  /* JSON pre — same shape as the retired BodyTab. */
  pre.json {
    margin: 0;
    padding: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 480px;
    overflow: auto;
  }

  /* JSON syntax classes — palette-only per PHILOSOPHY §5 (single
     accent). Keys are subordinate labels (muted); strings carry the
     content (default fg); numbers are the operator's eye-magnet (the
     one accent); booleans / null are sparse, dim. No off-palette
     hex literals. :global() because {@html} bypasses Svelte scoping. */
  :global(.json-key) {
    color: var(--fg-muted);
  }
  :global(.json-string) {
    color: var(--fg);
  }
  :global(.json-num) {
    color: var(--accent);
  }
  :global(.json-bool),
  :global(.json-null) {
    color: var(--fg-dim);
  }

  :global(.elided) {
    color: var(--fg-muted);
    font-style: italic;
    background: var(--bg);
    padding: 0 4px;
    border-radius: 2px;
    border: 1px dashed var(--border-strong);
  }
  :global(.elide-btn) {
    background: var(--bg-elev-2);
    color: var(--fg-dim);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 1px 7px;
    cursor: pointer;
    font: inherit;
    font-family: var(--mono);
    font-size: 10.5px;
    margin-left: 4px;
  }
  :global(.elide-btn:hover) {
    color: var(--fg);
    border-color: var(--border-strong);
  }
</style>
