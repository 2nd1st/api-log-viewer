<script lang="ts" module>
  // Trace shape types now live in $lib/trace.ts (relocated 2026-05-30).
  // Re-exported here for back-compat with any importer that still pulls
  // from this module path — preferred path going forward is
  // `import type { TraceBlob } from '../lib/trace'`.
  export type { TraceBlob, TraceDetail, TraceRow } from '../lib/trace';
  import type { TraceDetail } from '../lib/trace';

  // Tab strip kept intentionally small. The events/session/replay tabs
  // were retired 2026-05-29 — events was a low-level firehose nobody
  // read, session was redundant with the conversation include-session
  // toggle, and replay was capability-mode no operator used. The backend
  // /api/traces/:id/replay endpoint is preserved for scripting; the UI
  // surface is gone.
  //
  // 2026-05-30: headers + body merged into a single 'raw' tab. Operators
  // who want raw transport data want all four blocks (req headers, req
  // body, resp headers, resp body) co-located; the split made them tab
  // back and forth. See RawTab.svelte.
  export type DetailTab = 'overview' | 'conversation' | 'raw';

  // Snippet args for tabBody. Some tab-specific state lives here on
  // DetailPanel rather than inside the tab body (which gets remounted
  // on every tab switch) so it survives switching tabs within one
  // selected trace. Reset on traceId change — see the $effect below.
  export type TabBodyCtx = {
    detail: TraceDetail;
    tab: DetailTab;
    convoIncludeSession: boolean;
    setConvoIncludeSession: (v: boolean) => void;
  };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n.svelte';

  // ---------- props ----------
  //
  // - `traceId`: the currently-selected trace id, or null when nothing
  //   is selected. When it changes, the panel fetches `api/traces/:id`,
  //   updates the location hash to `#/traces/:id`, and resets the tab
  //   to 'conversation' (matches selectTrace() in the legacy viewer).
  // - `authFetch`: dependency-injected fetch wrapper that handles the
  //   bearer token + 401 modal. Signature mirrors window.fetch on a
  //   relative `api/...` path. Invented for the port.
  // - `tabBody`: a Snippet that renders the currently-active tab's
  //   contents. The shell knows about the *tab list* but not the
  //   per-tab markup; renderDetailTab() lives in sibling components
  //   (ConversationView, BodyView, etc.) and is composed in by App.svelte.
  //
  // Behavioral fidelity:
  //   - tab list = ['conversation','overview','headers','body',
  //                 events.length? 'events':null,'session',
  //                 events.length? 'replay':null].filter(Boolean)
  //   - default tab = 'conversation'
  //   - hash = `#/traces/${id}` (replaceState, not pushState, matches
  //     the legacy behavior so the back button doesn't pile up history)
  //   - clicking the parent link calls onSelect(parent_id) so the
  //     parent can drive the selection back into this same panel.

  type Props = {
    traceId: string | null;
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    onSelect?: (id: string) => void;
    tabBody?: Snippet<[TabBodyCtx]>;
  };

  let { traceId, authFetch, onSelect, tabBody }: Props = $props();

  // ---------- internal state ----------

  let detail = $state<TraceDetail | null>(null);
  // Default tab is now overview — operator lands on stats / identity /
  // session metrics, not on the raw conversation transcript.
  let detailTab = $state<DetailTab>('overview');
  let loadState = $state<'idle' | 'loading' | 'error'>('idle');
  let loadError = $state<string>('');

  // Tab-spanning state hoisted up so it survives tab switches within
  // one selected trace. ConversationTab's checkbox: see TabBodyCtx.
  let convoIncludeSession = $state<boolean>(false);

  // ---------- selectTrace: fetch + hash + reset ----------
  //
  // Mirrors selectTrace() from the legacy viewer. We trigger on every
  // traceId change rather than exposing it as an imperative function;
  // the parent updates `traceId` (from a list-row click or a hash
  // route change), and this effect handles the rest.

  $effect(() => {
    const id = traceId;
    detail = null;
    detailTab = 'overview';
    convoIncludeSession = false;
    if (!id) {
      loadState = 'idle';
      return;
    }
    // hash mirror — only replace when it isn't already the right hash,
    // to avoid loops with a hash-listening router upstream.
    if (typeof window !== 'undefined' && window.location.hash !== `#/traces/${id}`) {
      history.replaceState(null, '', `#/traces/${id}`);
    }
    loadState = 'loading';
    loadError = '';
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`api/traces/${id}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as TraceDetail;
        if (cancelled) return;
        detail = j;
        loadState = 'idle';
      } catch (e: any) {
        if (cancelled) return;
        loadError = e?.message ?? String(e);
        loadState = 'error';
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // ---------- derived: tab list + meta ----------
  //
  // Fixed three-tab strip — order matches the user's reading flow on
  // landing: stats first (overview), then transcript (conversation),
  // then raw transport details (raw).

  const tabs = $derived.by<DetailTab[]>(() => {
    if (!detail) return [];
    return ['overview', 'conversation', 'raw'];
  });

  const durMs = $derived.by<number | null>(() => {
    const row = detail?.row;
    if (!row?.ts_start || !row?.ts_end) return null;
    return new Date(row.ts_end).getTime() - new Date(row.ts_start).getTime();
  });

  // ---------- formatting helpers (1:1 with legacy) ----------

  function shortTs(ts: string | null | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    return (
      d.toLocaleTimeString('en-GB', { hour12: false }) +
      '.' +
      String(d.getMilliseconds()).padStart(3, '0')
    );
  }

  function fmtMs(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function statusClass(s: number | null | undefined): string {
    if (!s || s < 100) return 'st-x';
    const b = Math.floor(s / 100);
    return b === 2 ? 'st-2' : b === 4 ? 'st-4' : b === 5 ? 'st-5' : 'st-x';
  }

  function shortId(id: string | null | undefined): string {
    return id ? id.slice(-8) : '';
  }

  function selectTab(t: DetailTab) {
    detailTab = t;
  }

  function clickParent(e: MouseEvent, parentId: string) {
    // Let the parent route via onSelect rather than a raw hash jump,
    // so the in-memory state and the hash stay in lockstep.
    if (onSelect) {
      e.preventDefault();
      onSelect(parentId);
    }
  }
</script>

<div id="detail">
  {#if loadState === 'loading' && !detail}
    <div class="empty">{t('detail.loading', { id: traceId ?? '' })}</div>
  {:else if loadState === 'error'}
    <div class="empty">{t('detail.loadFailed', { message: loadError })}</div>
  {:else if !detail}
    <div class="empty">{t('detail.selectTrace')}</div>
  {:else}
    {@const row = detail.row}
    <div class="head">
      <div class="title">
        <span class="method">{row.method || 'POST'}</span>
        <span class="path">{row.path || ''}</span>
        <span class="status {statusClass(row.status)}">{row.status ?? '—'}</span>
        <span class="id">{row.id}</span>
      </div>
      <div class="meta">
        <span><b>{shortTs(row.ts_start)}</b></span>
        <span>{t('detail.metaDur')} <b>{fmtMs(durMs)}</b></span>
        <span>{t('detail.metaModel')} <b>{row.model || '—'}</b></span>
        <span>{t('detail.metaTokens')} <b>{row.prompt_tokens ?? '—'} / {row.completion_tokens ?? '—'}</b></span>
        <span>{t('detail.metaKey')} <b>{(row.key_hash || '').slice(0, 8) || '—'}</b></span>
        {#if row.parent_id}
          <span>
            {t('detail.metaParent')}
            <b>
              <a
                href={`#/traces/${row.parent_id}`}
                onclick={(e) => clickParent(e, row.parent_id!)}
              >{shortId(row.parent_id)}</a>
            </b>
          </span>
        {/if}
      </div>
    </div>
    <div class="tabs">
      {#each tabs as tab (tab)}
        <button
          type="button"
          data-tab={tab}
          class={tab === detailTab ? 'active' : ''}
          onclick={() => selectTab(tab)}
        >{t(
          tab === 'overview'
            ? 'detail.tabOverview'
            : tab === 'conversation'
              ? 'detail.tabConversation'
              : 'detail.tabRaw',
        )}</button>
      {/each}
    </div>
    <div class="body" id="detail-panel">
      {#if tabBody}
        {@render tabBody({
          detail,
          tab: detailTab,
          convoIncludeSession,
          setConvoIncludeSession: (v) => (convoIncludeSession = v),
        })}
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ---------- detail panel shell ----------
     Ported 1:1 from #detail / #detail .head / #detail .tabs in
     internal/viewer/static/index.html, with the legacy palette tokens
     remapped to the new app.css zinc palette:
       --muted     -> --fg-muted
       --muted-2   -> --fg-dim
       --line      -> --border
       --panel     -> --bg-elev
       --r         -> --radius
       --good/bad  -> --ok / --err
  */

  #detail {
    flex: 1;
    overflow: auto;
    padding: 0;
    min-width: 0;
    min-height: 0;
  }

  #detail .empty {
    color: var(--fg-muted);
    padding: 64px 32px;
    text-align: center;
    font-size: 12px;
  }

  #detail .head {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 12px 16px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  #detail .head .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 12.5px;
  }

  #detail .head .method { color: var(--fg-muted); }
  #detail .head .path   { color: var(--fg); }
  #detail .head .status { font-weight: 600; }
  #detail .head .id {
    color: var(--fg-dim);
    font-size: 11px;
    margin-left: auto;
  }

  #detail .head .meta {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  #detail .head .meta span b {
    color: var(--fg-dim);
    font-weight: 500;
  }

  #detail .tabs {
    display: flex;
    padding: 0 16px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 65px;
    z-index: 1;
  }
  #detail .tabs button {
    padding: 8px 14px;
    color: var(--fg-muted);
    background: transparent;
    border: 0;
    border-bottom: 1px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
  }
  #detail .tabs button:hover { color: var(--fg-dim); }
  #detail .tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }

  #detail .body { padding: 16px; }

  /* status color classes (also defined globally in the list view; kept
     here scoped so the detail header colors work in isolation). */
  .st-2 { color: var(--ok); }
  .st-4 { color: var(--warn); }
  .st-5 { color: var(--err); }
  .st-x { color: var(--fg-muted); }
</style>
