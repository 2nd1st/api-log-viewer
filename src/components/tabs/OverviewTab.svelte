<script lang="ts">
  // Overview is the landing tab. Surfaces:
  //   - per-trace block counts derived from adapt()
  //   - identity: key_hash short, client (UA-derived), upstream
  //   - session metrics: turns, total tool calls, total reasoning,
  //     time span — fetched once from /api/traces?session_root_id=X
  //   - raw row at the bottom, collapsed by default
  //
  // No autoplay, no fancy charts — small dense table-of-tables that
  // answers "what is this trace + what does its session look like".

  import { adapt } from '../../lib/adapters';
  import { countByType } from '../../lib/blocks';
  import type { Block } from '../../lib/blocks';
  import { shortId } from '../../lib/format';
  import type { TraceBlob, TraceRow } from '../DetailPanel.svelte';

  interface Props {
    row: TraceRow;
    trace: TraceBlob;
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    onSelect?: (id: string) => void;
  }

  const { row, trace, authFetch, onSelect }: Props = $props();

  // ---------- per-trace block counts ----------

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

  // ---------- identity: client (from req UA) + upstream ----------

  const ua = $derived<string>(
    (trace?.req?.headers?.['user-agent'] ??
      trace?.req?.headers?.['User-Agent'] ??
      '') as string,
  );

  // Best-effort client identification — by UA prefix. Falls back to raw UA.
  // Per memory feedback_ultracode_target: keep it honest; show what we have.
  const client = $derived.by<{ family: string; version?: string; raw: string }>(() => {
    const u = ua.trim();
    if (!u) return { family: 'unknown', raw: '' };
    // Codex CLI family
    if (/codex/i.test(u)) {
      const m = u.match(/codex[^0-9]*([\d.]+)/i);
      return { family: 'codex', version: m?.[1], raw: u };
    }
    if (/claude-cli|claude-code/i.test(u)) {
      const m = u.match(/(?:claude-cli|claude-code)\/([\d.]+)/i);
      return { family: 'claude-code', version: m?.[1], raw: u };
    }
    if (/opencode/i.test(u)) {
      const m = u.match(/opencode\/([\d.]+)/i);
      return { family: 'opencode', version: m?.[1], raw: u };
    }
    if (/^OpenAI\//.test(u) || /openai-python|openai-node/i.test(u)) {
      const m = u.match(/(?:openai[^0-9]*)([\d.]+)/i);
      return { family: 'openai-sdk', version: m?.[1], raw: u };
    }
    if (/anthropic-sdk|anthropic-python|anthropic-typescript/i.test(u)) {
      const m = u.match(/(?:anthropic[^0-9]*)([\d.]+)/i);
      return { family: 'anthropic-sdk', version: m?.[1], raw: u };
    }
    if (/cursor/i.test(u)) return { family: 'cursor', raw: u };
    if (/continue/i.test(u)) return { family: 'continue', raw: u };
    if (/^curl\//.test(u)) {
      const m = u.match(/curl\/([\d.]+)/i);
      return { family: 'curl', version: m?.[1], raw: u };
    }
    if (/^Mozilla\//.test(u)) return { family: 'browser', raw: u };
    // First non-space chunk before /
    const first = u.split(/[\s/]/, 1)[0];
    return { family: first || 'unknown', raw: u };
  });

  // ---------- session metrics ----------

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

        // For block-level counts across the session we'd need to fetch
        // every detail — too expensive. We surface only what row
        // metadata gives us (turns, tokens, time span, models).
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

  // ---------- raw row (collapsed) ----------

  let rawOpen = $state(false);
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
      <dt>blocks</dt>        <dd class="mono">
        {#each Object.entries(counts) as [k, n] (k)}
          {#if n > 0}<span class="chip">{n} {k}</span>{/if}
        {/each}
        {#if Object.values(counts).every(n => !n)}<span class="dim">—</span>{/if}
      </dd>
    </dl>
  </section>

  <!-- IDENTITY -->
  <section class="card">
    <h3>identity</h3>
    <dl class="kv">
      <dt>client</dt> <dd class="mono">
        <strong>{client.family}</strong>{#if client.version} <span class="dim">{client.version}</span>{/if}
        {#if client.raw && client.family !== client.raw}
          <div class="ua dim">{client.raw}</div>
        {/if}
      </dd>
      <dt>key</dt>     <dd class="mono">{(row.key_hash || '—').slice(0, 16)}{#if row.key_hash && row.key_hash.length > 16}…{/if}</dd>
      <dt>upstream</dt><dd class="mono">{row.upstream ?? '—'}</dd>
      <dt>client ip</dt><dd class="mono">{row.client ?? '—'}</dd>
    </dl>
  </section>

  <!-- SESSION -->
  <section class="card">
    <h3>session</h3>
    {#if !row.session_root_id}
      <div class="dim">(no session)</div>
    {:else if session.kind === 'loading'}
      <div class="dim">loading session siblings…</div>
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

  <!-- RAW -->
  <section class="card raw">
    <button type="button" class="raw-toggle" onclick={() => (rawOpen = !rawOpen)}>
      <span aria-hidden="true">{rawOpen ? '▾' : '▸'}</span>
      raw row
    </button>
    {#if rawOpen}
      <dl class="kv raw-kv">
        {#each Object.entries(row ?? {}) as [k, v] (k)}
          <dt>{k}</dt>
          <dd class="mono" class:empty={v == null || v === ''}>
            {v == null || v === '' ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v))}
          </dd>
        {/each}
      </dl>
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
    padding: 8px 12px;
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
    padding: 6px 12px;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--sans);
  }
  .kv dd {
    margin: 0;
    padding: 6px 12px;
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
  .err { padding: 10px 12px; color: var(--err); font-size: 12px; }
  .foot { padding: 8px 12px; font-size: 11px; line-height: 1.4; }

  .raw .raw-toggle {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 8px 12px;
    color: var(--fg-muted);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .raw .raw-toggle:hover { color: var(--fg); }
  .raw-kv {
    grid-template-columns: 180px 1fr;
    font-family: var(--mono);
    font-size: 11px;
    border-top: 1px solid var(--border);
  }
  .raw-kv .empty { color: var(--fg-dim); }
</style>
