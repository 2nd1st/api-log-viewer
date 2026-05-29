<script lang="ts">
  // Overview is the landing tab. Surfaces, in order:
  //   1. THIS TRACE    — id / method · path / status / model / duration / tokens
  //   2. CLIENT & SOURCE — UA-derived client family (lib/client.ts) +
  //      key / upstream / ip + prompt source classification
  //      (lib/promptSource.ts) over the system text we can extract from
  //      trace.req.body using the same logic ConversationTab's adapters
  //      use (Responses .instructions, Anthropic .system, Chat first
  //      system message).
  //   3. CONTENT SHAPE — what's structurally in the trace: block-type
  //      chips (moved out of THIS TRACE), tool inventory grouped by
  //      tool_name, response shape one-liner (json body size, SSE event
  //      count, b64 presence), truncation flags.
  //   4. MODEL BEHAVIOR — stop reason via lib/stopReason.ts with a
  //      severity tone dot, reasoning-block count, tool-call count,
  //      first reply latency derived from the earliest text/output
  //      delta event.
  //   5. SESSION — unchanged from the previous incarnation.
  //
  // The previous RAW ROW card is gone; the Raw tab covers that need.
  //
  // PHILOSOPHY:
  //   - One accent (--accent). Tones (--ok/--warn/--err) only for
  //     severity, never for role coding.
  //   - We render what's there; classification helpers are explicit
  //     opt-in carve-outs (UA -> client family, system text -> prompt
  //     source). No synthesis.

  import { adapt } from '../../lib/adapters';
  import { countByType } from '../../lib/blocks';
  import type { Block } from '../../lib/blocks';
  import { classifyClient } from '../../lib/client';
  import { classifyPromptSource } from '../../lib/promptSource';
  import { translateStopReason } from '../../lib/stopReason';
  import type { StopTone } from '../../lib/stopReason';
  import { shortId, humanBytes } from '../../lib/format';
  import type { TraceBlob, TraceRow } from '../DetailPanel.svelte';

  interface Props {
    row: TraceRow;
    trace: TraceBlob;
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    onSelect?: (id: string) => void;
  }

  const { row, trace, authFetch, onSelect }: Props = $props();

  // ---------- per-trace block timeline ----------

  const blocks = $derived<Block[]>(adapt(row.path ?? '', trace ?? {}));
  const counts = $derived(countByType(blocks));

  // ---------- timing & tokens (from row) ----------

  const durMs = $derived.by<number | null>(() => {
    if (!row?.ts_start || !row?.ts_end) return null;
    return new Date(row.ts_end).getTime() - new Date(row.ts_start).getTime();
  });

  function fmtMs(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function fmtNum(n: number | null | undefined): string {
    if (n == null) return '—';
    return n.toLocaleString();
  }

  // ---------- CLIENT & SOURCE ----------

  const ua = $derived<string>(
    (trace?.req?.headers?.['user-agent'] ??
      trace?.req?.headers?.['User-Agent'] ??
      '') as string,
  );

  const client = $derived(classifyClient(ua));

  /**
   * Pull the protocol-level system / instructions text out of the
   * request body. Same logic the adapters use to surface a system
   * block: Responses .instructions string, Anthropic .system (string
   * or array of {type:'text', text}), Chat first system message.
   */
  const systemText = $derived.by<string>(() => {
    const body: any = trace?.req?.body;
    if (!body || typeof body !== 'object') return '';
    // Responses — top-level instructions string
    if (typeof body.instructions === 'string' && body.instructions.length > 0) {
      return body.instructions;
    }
    // Anthropic Messages — system: string | Array<{type:'text', text}>
    const sys = body.system;
    if (typeof sys === 'string' && sys.length > 0) return sys;
    if (Array.isArray(sys)) {
      const parts: string[] = [];
      for (const item of sys) {
        if (typeof item === 'string') parts.push(item);
        else if (item && typeof item === 'object' && typeof item.text === 'string') {
          parts.push(item.text);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    // Chat Completions — first system message in messages[]
    const msgs = body.messages;
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        if (m.role !== 'system' && m.role !== 'developer') continue;
        const c = m.content;
        if (typeof c === 'string' && c.length > 0) return c;
        if (Array.isArray(c)) {
          const parts: string[] = [];
          for (const part of c) {
            if (typeof part === 'string') parts.push(part);
            else if (part && typeof part === 'object' && typeof part.text === 'string') {
              parts.push(part.text);
            }
          }
          if (parts.length > 0) return parts.join('\n');
        }
        break;
      }
    }
    return '';
  });

  const promptSource = $derived(classifyPromptSource(systemText));

  function truncSignals(signals: string[], max = 4): string {
    if (signals.length === 0) return '';
    const shown = signals.slice(0, max).join(', ');
    return signals.length > max ? `${shown}, +${signals.length - max} more` : shown;
  }

  // ---------- CONTENT SHAPE ----------

  /**
   * Tool inventory: group tool_call blocks by tool_name and count.
   * Returns rows in descending-count order.
   */
  const toolInventory = $derived.by<Array<{ name: string; n: number }>>(() => {
    const m = new Map<string, number>();
    for (const b of blocks) {
      if (b.type !== 'tool_call') continue;
      const name = b.tool_name || '(unnamed)';
      m.set(name, (m.get(name) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n);
  });

  /**
   * Best-effort byte size of resp.body. JSON.stringify so we report
   * what an operator would see in the Body tab pretty-print, not
   * whatever the transport carried.
   */
  function bodyBytes(body: any): number {
    if (body == null) return 0;
    if (typeof body === 'string') return body.length;
    try {
      return JSON.stringify(body).length;
    } catch {
      return 0;
    }
  }

  const respShape = $derived.by<string>(() => {
    const parts: string[] = [];
    const rb: any = trace?.resp?.body;
    if (rb != null) {
      parts.push(`json body ${humanBytes(bodyBytes(rb))}`);
    }
    const events = trace?.resp?.events;
    if (Array.isArray(events) && events.length > 0) {
      parts.push(`${events.length} SSE events`);
    }
    const b64 = trace?.resp?.body_b64;
    if (typeof b64 === 'string' && b64.length > 0) {
      parts.push(`b64 ${humanBytes(b64.length)}`);
    } else {
      // Mirror the spec example which always reports a b64 column.
      parts.push('b64 0');
    }
    return parts.join(' · ');
  });

  const truncatedReq = $derived(!!(row as any).truncated_req);
  const truncatedResp = $derived(!!(row as any).truncated_resp);

  // ---------- MODEL BEHAVIOR ----------

  const stop = $derived(translateStopReason((row as any).finish_reason));

  const reasoningCount = $derived(counts.reasoning ?? 0);
  const toolCallCount = $derived(counts.tool_call ?? 0);

  /**
   * First reply latency: earliest event signaling visible model
   * output. We accept Responses' `response.output_text.delta` and
   * Anthropic's `content_block_delta` (text variant). Events carry
   * `t_delta_ms` relative to ts_start, so the value is already a
   * latency. Returns null when we can't determine it.
   */
  const firstReplyMs = $derived.by<number | null>(() => {
    const events = trace?.resp?.events;
    if (!Array.isArray(events) || events.length === 0) return null;
    for (const ev of events) {
      const name = (ev as any)?.event ?? '';
      const t = (ev as any)?.t_delta_ms;
      if (typeof t !== 'number') continue;
      if (
        name === 'response.output_text.delta' ||
        name === 'content_block_delta' ||
        // Chat-style streaming chunks have no event name; fall back
        // to the first event with a t_delta_ms.
        name === ''
      ) {
        return t;
      }
    }
    return null;
  });

  function toneClass(tone: StopTone): string {
    if (tone === 'ok') return 'dot ok';
    if (tone === 'warn') return 'dot warn';
    if (tone === 'err') return 'dot err';
    return 'dot';
  }

  // ---------- SESSION (unchanged) ----------

  interface SessionStats {
    turns: number;
    toolCalls: number;
    reasoning: number;
    text: number;
    media: number;
    errors: number;
    promptTokensTotal: number;
    completionTokensTotal: number;
    firstTs: string | null;
    lastTs: string | null;
    distinctModels: string[];
  }

  type SessionState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; stats: SessionStats };

  let session = $state<SessionState>({ kind: 'idle' });

  $effect(() => {
    const sid = row.session_root_id;
    if (!sid) {
      session = { kind: 'idle' };
      return;
    }
    let cancelled = false;
    session = { kind: 'loading' };
    (async () => {
      try {
        const r = await authFetch(
          `api/traces?session_root_id=${sid}&limit=500`,
        );
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        const rows: TraceRow[] = (j.traces || []) as TraceRow[];
        if (cancelled) return;

        const stats: SessionStats = {
          turns: rows.length,
          toolCalls: 0,
          reasoning: 0,
          text: 0,
          media: 0,
          errors: 0,
          promptTokensTotal: 0,
          completionTokensTotal: 0,
          firstTs: null,
          lastTs: null,
          distinctModels: [],
        };
        const modelSet = new Set<string>();

        for (const r2 of rows) {
          if (r2.prompt_tokens) stats.promptTokensTotal += Number(r2.prompt_tokens);
          if (r2.completion_tokens) stats.completionTokensTotal += Number(r2.completion_tokens);
          if (r2.model) modelSet.add(String(r2.model));
          const ts = r2.ts_start as string | undefined;
          if (ts) {
            if (!stats.firstTs || ts < stats.firstTs) stats.firstTs = ts;
            if (!stats.lastTs || ts > stats.lastTs) stats.lastTs = ts;
          }
        }
        stats.distinctModels = Array.from(modelSet);

        session = { kind: 'ready', stats };
      } catch (e: any) {
        if (cancelled) return;
        session = { kind: 'error', message: e?.message ?? String(e) };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function sessionSpanMs(): number | null {
    if (session.kind !== 'ready') return null;
    const s = session.stats;
    if (!s.firstTs || !s.lastTs) return null;
    return new Date(s.lastTs).getTime() - new Date(s.firstTs).getTime();
  }

  function clickParent(e: MouseEvent, parentId: string) {
    if (onSelect) {
      e.preventDefault();
      onSelect(parentId);
    }
  }
</script>

<div class="overview">
  <!-- THIS TRACE -->
  <section class="card">
    <h3>this trace</h3>
    <dl class="kv">
      <dt>id</dt>            <dd class="mono">{row.id ?? '—'}</dd>
      <dt>method · path</dt> <dd class="mono">{row.method ?? '—'} {row.path ?? ''}</dd>
      <dt>status</dt>        <dd class="mono">{row.status ?? '—'}</dd>
      <dt>model</dt>         <dd class="mono">{row.model ?? '—'}</dd>
      <dt>duration</dt>      <dd class="mono">{fmtMs(durMs)}</dd>
      <dt>tokens</dt>        <dd class="mono">
        {fmtNum(row.prompt_tokens)} in · {fmtNum(row.completion_tokens)} out
        {#if row.total_tokens != null} · {fmtNum(row.total_tokens)} total{/if}
      </dd>
    </dl>
  </section>

  <!-- CLIENT & SOURCE -->
  <section class="card">
    <h3>client &amp; source</h3>
    <dl class="kv">
      <dt>client</dt> <dd class="mono">
        <strong>{client.family}</strong>{#if client.version} <span class="dim">{client.version}</span>{/if}
        {#if client.raw && client.family !== client.raw}
          <div class="ua dim">{client.raw}</div>
        {/if}
      </dd>
      <dt>key</dt>      <dd class="mono">{(row.key_hash || '—').slice(0, 16)}{#if row.key_hash && row.key_hash.length > 16}…{/if}</dd>
      <dt>upstream</dt> <dd class="mono">{row.upstream ?? '—'}</dd>
      <dt>client ip</dt><dd class="mono">{row.client ?? '—'}</dd>
      <dt>prompt source</dt>
      <dd class="mono">
        {#if !systemText}
          <span class="dim">(no system text)</span>
        {:else}
          <strong>{promptSource.source}</strong> <span class="dim">{promptSource.layer}</span>
          {#if promptSource.signals.length > 0}
            <div class="ua dim">signals: {truncSignals(promptSource.signals)}</div>
          {/if}
        {/if}
      </dd>
    </dl>
  </section>

  <!-- CONTENT SHAPE -->
  <section class="card">
    <h3>content shape</h3>
    <dl class="kv">
      <dt>blocks</dt>
      <dd class="mono">
        {#each Object.entries(counts) as [k, n] (k)}
          {#if n > 0}<span class="chip">{n} {k}</span>{/if}
        {/each}
        {#if Object.values(counts).every((n) => !n)}<span class="dim">—</span>{/if}
      </dd>
      <dt>tools called</dt>
      <dd class="mono">
        {#if toolInventory.length === 0}
          <span class="dim">—</span>
        {:else}
          <ul class="tool-list">
            {#each toolInventory as t (t.name)}
              <li><span class="tool-n">{t.n}×</span> {t.name}</li>
            {/each}
          </ul>
        {/if}
      </dd>
      <dt>response shape</dt>
      <dd class="mono">{respShape || '—'}</dd>
      <dt>truncation</dt>
      <dd class="mono">
        {#if !truncatedReq && !truncatedResp}
          <span class="dim">none</span>
        {:else}
          {#if truncatedReq}<span class="badge warn">req truncated</span>{/if}
          {#if truncatedResp}<span class="badge warn">resp truncated</span>{/if}
        {/if}
      </dd>
    </dl>
  </section>

  <!-- MODEL BEHAVIOR -->
  <section class="card">
    <h3>model behavior</h3>
    <dl class="kv">
      <dt>stop reason</dt>
      <dd class="mono">
        <span class={toneClass(stop.tone)} aria-hidden="true"></span>
        {stop.label}
      </dd>
      <dt>reasoning blocks</dt>
      <dd class="mono">{reasoningCount}</dd>
      <dt>tool calls</dt>
      <dd class="mono">{toolCallCount}</dd>
      <dt>first reply</dt>
      <dd class="mono">{firstReplyMs == null ? '—' : fmtMs(firstReplyMs)}</dd>
    </dl>
  </section>

  <!-- SESSION -->
  <section class="card">
    <h3>session</h3>
    {#if !row.session_root_id}
      <div class="dim foot">(no session)</div>
    {:else if session.kind === 'loading'}
      <div class="dim foot">loading session siblings…</div>
    {:else if session.kind === 'error'}
      <div class="err">session fetch failed: {session.message}</div>
    {:else if session.kind === 'ready'}
      {@const s = session.stats}
      {@const span = sessionSpanMs()}
      <dl class="kv">
        <dt>session root</dt> <dd class="mono">{shortId(row.session_root_id)}</dd>
        <dt>turns</dt>        <dd class="mono">{s.turns}</dd>
        <dt>tokens (sum)</dt> <dd class="mono">{fmtNum(s.promptTokensTotal)} in · {fmtNum(s.completionTokensTotal)} out</dd>
        <dt>span</dt>         <dd class="mono">{fmtMs(span)}</dd>
        <dt>models</dt>       <dd class="mono">
          {#if s.distinctModels.length === 0}—
          {:else}{s.distinctModels.join(', ')}{/if}
        </dd>
        {#if row.parent_id}
          <dt>parent trace</dt>
          <dd class="mono">
            <a href="#/traces/{row.parent_id}" onclick={(e) => clickParent(e, row.parent_id!)}>{shortId(row.parent_id)}</a>
          </dd>
        {/if}
      </dl>
      <div class="dim foot">
        per-block totals across the whole session need fetching every
        sibling trace — not done in this pass. The numbers above are
        derived from row metadata only.
      </div>
    {/if}
  </section>
</div>

<style>
  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: 0;
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

  .kv {
    margin: 0;
    display: grid;
    grid-template-columns: 140px 1fr;
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

  .chip {
    display: inline-block;
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-elev);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .ua { margin-top: 4px; font-size: 11px; word-break: break-all; }
  .dim { color: var(--fg-dim); }
  .err { padding: 10px var(--gap-3); color: var(--err); font-size: 12px; }
  .foot { padding: var(--gap-2) var(--gap-3); font-size: 11px; line-height: 1.4; }

  /* Tool inventory: a tight, mono list. No background fill — just
     spacing + a faint left edge to set it apart from the surrounding
     kv row, in line with PHILOSOPHY (edge accents, not role fills). */
  .tool-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tool-list li {
    padding-left: var(--gap-2);
    border-left: 1px solid var(--border);
    color: var(--fg);
  }
  .tool-n {
    display: inline-block;
    min-width: 2.2em;
    color: var(--fg-muted);
  }

  /* Severity tone dot for stop reason. Single accent rule per
     PHILOSOPHY — these tones are severity, not role. */
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    background: var(--fg-dim);
    vertical-align: middle;
  }
  .dot.ok   { background: var(--ok); }
  .dot.warn { background: var(--warn); }
  .dot.err  { background: var(--err); }

  /* Truncation badge. Warn-toned outline, no fill. */
  .badge {
    display: inline-block;
    margin-right: 6px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    border: 1px solid var(--border);
    color: var(--fg-muted);
  }
  .badge.warn {
    color: var(--warn);
    border-color: var(--warn);
  }
</style>
