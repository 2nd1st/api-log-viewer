<script lang="ts">
  // Body tab — request/response body pretty-printed with JSON
  // syntax highlighting and an elide-huge pre-walk so multi-MB
  // image payloads don't lock the main thread.
  //
  // 1:1 port of the `tab === 'body'` branch in
  // internal/viewer/static/index.html:
  //
  //   } else if (tab === 'body') {
  //     const req  = (tr.req  && tr.req.body)  || (tr.req  && tr.req.body_b64);
  //     const resp = (tr.resp && tr.resp.body) || (tr.resp && tr.resp.body_b64);
  //     const empty = '<pre class="json"><span style="color:var(--muted-2)">
  //                    empty (streaming — see events tab)</span></pre>';
  //     panel.innerHTML = `
  //       <h3 class="section">request body</h3>
  //       <pre class="json">${req ? jsonHL(req) : '<span style="color:var(--muted-2)">empty</span>'}</pre>
  //       <h3 class="section more">response body</h3>
  //       ${resp ? `<pre class="json">${jsonHL(resp)}</pre>` : empty}`;
  //   }
  //
  // Notes on fidelity:
  //   - When body is absent but body_b64 is present, the original passes
  //     the raw base64 string straight into jsonHL → JSON.stringify wraps
  //     it as a single quoted string. We preserve that exact behavior.
  //   - elideHuge swaps oversized strings for sentinel tokens (>4096B)
  //     so jsonHL emits a placeholder span with "show as image" /
  //     "show raw" affordances. Originals are kept in a per-instance
  //     Map for lazy on-click restoration.
  //   - Elide-button click handling is delegated on the component root
  //     (the original used a document-level listener; per-instance scope
  //     is sufficient here and cleans up automatically with the tab).

  // Invented prop signature — no shared types module yet. Matches the
  // `tr` shape the original viewer consumes.
  interface BodyShape {
    body?: unknown;
    body_b64?: string;
  }
  interface TraceShape {
    req?: BodyShape | null;
    resp?: BodyShape | null;
  }

  const { trace }: { trace: TraceShape | null | undefined } = $props();

  // Threshold above which a JSON string field is elided in the
  // pretty-print. Same value as the original (4 KiB) — image-generation
  // b64_json payloads can be megabytes; regex-highlighting them and
  // shoving them through innerHTML grinds the browser to a halt.
  const JSON_ELIDE_MAX_BYTES = 4096;

  // Per-render elision bookkeeping. Recreated when `trace` changes so
  // tokens never leak across selections.
  let elidedStore = new Map<string, { value: string; parentKey: string }>();
  let elidedSeq = 0;

  function humanBytes(n: number): string {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function esc(s: unknown): string {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string),
    );
  }

  // Heuristic: assume a long string is base64-encoded image bytes if
  // it's mostly base64 alphabet AND the field name hints at image data.
  function looksLikeBase64Image(s: string, parentKey: string): boolean {
    if (typeof s !== 'string' || s.length < 1024) return false;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(s.slice(0, 96))) return false;
    const k = (parentKey || '').toLowerCase();
    return k === 'b64_json' || k === 'image' || k === 'data' || /image|png|jpeg|jpg|webp/.test(k);
  }

  // elideHuge walks a JSON value and replaces any oversized string
  // with a sentinel token that jsonHL renders as a placeholder. The
  // original is preserved in elidedStore for on-demand expansion.
  // parentKey is the immediate JSON key, used for image-content
  // detection so we can offer an inline preview.
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
    // Replace elision tokens (they ended up inside json-string spans
    // because they were string literals). Render as a tagged
    // placeholder with optional "show as image" affordance.
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

  // Derived bodies. Mirror the original `(tr.req && tr.req.body) || (tr.req && tr.req.body_b64)`
  // pattern exactly: prefer the structured body, fall back to the
  // base64 blob string. When falling back, jsonHL will stringify the
  // base64 string into a quoted JSON string — same as the original.
  const req = $derived<unknown>(
    (trace?.req && trace.req.body) || (trace?.req && trace.req.body_b64) || null,
  );
  const resp = $derived<unknown>(
    (trace?.resp && trace.resp.body) || (trace?.resp && trace.resp.body_b64) || null,
  );

  // Recompute the highlighted HTML whenever inputs change. Resetting
  // the elision store first prevents stale tokens from leaking.
  const reqHtml = $derived.by(() => {
    // touch req so this re-runs when it changes
    void req;
    elidedStore = new Map();
    elidedSeq = 0;
    return req ? jsonHL(req) : '<span style="color:var(--fg-dim)">empty</span>';
  });
  const respHtml = $derived.by(() => {
    void resp;
    // Note: don't reset the store here — req was just rendered into the
    // same DOM tree and its tokens must remain resolvable. We re-key by
    // monotonic seq so collisions can't happen across the two calls.
    return resp ? jsonHL(resp) : null;
  });

  // Delegated click handler for elide-btn expansions. Mirrors the
  // original document-level listener but is scoped to this component.
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
      // Try common image MIME types; PNG covers most.
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

<div onclick={onPanelClick} role="presentation">
  <h3 class="section">request body</h3>
  <pre class="json">{@html reqHtml}</pre>

  <h3 class="section more">response body</h3>
  {#if respHtml != null}
    <pre class="json">{@html respHtml}</pre>
  {:else}
    <pre class="json"><span style="color:var(--fg-dim)"
      >empty (response was streamed; see conversation tab for accumulated blocks)</span
    ></pre>
  {/if}
</div>

<style>
  /* Mirrors the original detail-panel body-tab styling. The new zinc
     palette substitutes: --line → --border, --line-2 → --border-strong,
     --panel → --bg-elev, --panel-2 → --bg-elev-2, --muted → --fg-muted,
     --muted-2 → --fg-dim, --r → --radius, --bad → --err. */

  h3.section {
    margin: 0 0 6px;
    font-size: 10px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  h3.section + :global(*) {
    margin-top: 0;
  }
  h3.section.more {
    margin-top: 18px;
  }

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
