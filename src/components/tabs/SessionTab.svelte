<script lang="ts">
  // Session tab — parent/child trace tree for a row's session.
  //
  // 1:1 port of `renderSessionTree` in
  // internal/viewer/static/index.html (~lines 1210–1243):
  //
  //   - GET `api/traces?session_root_id=<id>&limit=500` via authFetch
  //   - sort returned traces ascending by ts_start (localeCompare)
  //   - build parent/child map by id → kids[]; pick the root as either
  //     the node whose id === session_root_id, or any node without a
  //     resolvable parent_id, falling back to the first node.
  //   - recursive r2html prints status badge (statusClass), path, and
  //     "ts · shortId" meta. Root node gets `.tree-node.root`; the
  //     currently selected row gets `.tree-node.current`.
  //   - click on any node calls selectTrace(id) — invented as a prop
  //     callback `onSelect` so the parent App can switch the active row.
  //   - rows with no session_root_id render the "no session" placeholder;
  //     fetch errors render "session load failed: <message>".
  //
  // The tree-footer string "<N> traces · root <shortId>" is preserved
  // verbatim — same separator (' · '), same ordering.

  import { authFetch } from '../../lib/api';
  import { shortId, shortTs, statusClass } from '../../lib/format';

  // --- types --------------------------------------------------------

  interface TraceNode {
    id: string;
    parent_id?: string | null;
    session_root_id?: string | null;
    status?: number | null;
    path?: string | null;
    ts_start: string;
    [k: string]: unknown;
  }

  interface TreeNode extends TraceNode {
    kids: TreeNode[];
  }

  interface Row {
    id: string;
    session_root_id?: string | null;
    [k: string]: unknown;
  }

  // INVENTED SIGNATURE — documented in notes:
  //   onSelect(id): called when a tree node is clicked. Mirrors the
  //   original `selectTrace(el.dataset.id)`. Optional; if omitted the
  //   click is a no-op (matches "panel-only" rendering).
  interface Props {
    row: Row;
    onSelect?: (id: string) => void;
  }

  const { row, onSelect }: Props = $props();

  // --- load state ---------------------------------------------------

  type LoadState =
    | { kind: 'no-session' }
    | { kind: 'loading' }
    | { kind: 'empty' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; root: TreeNode; total: number };

  let loadState = $state<LoadState>(
    row?.session_root_id ? { kind: 'loading' } : { kind: 'no-session' },
  );

  // Re-fetch whenever the row's session_root_id changes. The original
  // re-rendered the panel from scratch each time the user clicked a
  // different row; $effect with the id as the tracked input matches.
  $effect(() => {
    const rootId = row?.session_root_id;
    const currentId = row?.id;
    if (!rootId) {
      loadState = { kind: 'no-session' };
      return;
    }
    loadState = { kind: 'loading' };

    // Abort guard for stale responses if row changes mid-flight.
    let stale = false;
    (async () => {
      try {
        const r = await authFetch(
          `api/traces?session_root_id=${rootId}&limit=500`,
        );
        const j = await r.json();
        if (stale) return;
        const nodes: TraceNode[] = (j.traces || [])
          .slice()
          .sort((a: TraceNode, b: TraceNode) =>
            a.ts_start.localeCompare(b.ts_start),
          );
        const byId = new Map<string, TreeNode>(
          nodes.map((n) => [n.id, { ...n, kids: [] as TreeNode[] }]),
        );
        let root: TreeNode | null = null;
        for (const n of byId.values()) {
          if (n.parent_id && byId.has(n.parent_id)) {
            byId.get(n.parent_id)!.kids.push(n);
          } else if (!n.parent_id || n.id === n.session_root_id) {
            root = n;
          }
        }
        if (!root) {
          root = nodes[0] ? byId.get(nodes[0].id) ?? null : null;
        }
        if (!root) {
          loadState = { kind: 'empty' };
          return;
        }
        loadState = { kind: 'ready', root, total: nodes.length };
      } catch (e) {
        if (stale) return;
        const message = e instanceof Error ? e.message : String(e);
        loadState = { kind: 'error', message };
      }
    })();

    return () => {
      stale = true;
    };

    // Reference currentId so $effect re-runs on selection change too
    // (the `.current` highlight must move when the user clicks
    // a different node).
    void currentId;
  });

  // --- recursive render helper -------------------------------------

  // We can't recurse with {#each} alone; pull the tree out as a flat
  // list with depth so we can render in one pass, mirroring the
  // original r2html string concatenation order (preorder DFS).
  interface FlatNode {
    node: TreeNode;
    depth: number;
  }

  function flatten(root: TreeNode): FlatNode[] {
    const out: FlatNode[] = [];
    const walk = (n: TreeNode, d: number) => {
      out.push({ node: n, depth: d });
      for (const k of n.kids) walk(k, d + 1);
    };
    walk(root, 0);
    return out;
  }

  const flat = $derived(
    loadState.kind === 'ready' ? flatten(loadState.root) : [],
  );

  function handleClick(e: MouseEvent, id: string) {
    e.stopPropagation();
    onSelect?.(id);
  }
</script>

{#if loadState.kind === 'no-session'}
  <div class="muted">no session</div>
{:else if loadState.kind === 'loading'}
  <div class="muted">loading session…</div>
{:else if loadState.kind === 'empty'}
  <div class="muted">empty</div>
{:else if loadState.kind === 'error'}
  <div class="bad">session load failed: {loadState.message}</div>
{:else}
  <div class="tree">
    {#each flat as { node, depth } (node.id)}
      <div
        class="tree-node"
        class:root={depth === 0}
        class:current={node.id === row.id}
        data-id={node.id}
        onclick={(e) => handleClick(e, node.id)}
        role="button"
        tabindex="0"
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick(e as unknown as MouseEvent, node.id);
          }
        }}
        style="margin-left: {depth === 0 ? 0 : 6 + (depth - 1) * 14}px"
      >
        <span class={statusClass(node.status)}>{node.status ?? '—'}</span>
        <span class="path">{node.path ?? ''}</span>
        <span class="meta">{shortTs(node.ts_start)} · {shortId(node.id)}</span>
      </div>
    {/each}
  </div>
  <div class="tree-footer">
    {loadState.total} traces · root {shortId(loadState.root.id)}
  </div>
{/if}

<style>
  /* Mirrors the original .tree / .tree-node / .tree-footer rules,
     translated to the new zinc palette:
       --line       → --border
       --panel      → --bg-elev
       --sel        → --bg-elev-2  (selected-row tint)
       --muted      → --fg-muted
       --fg-dim     → --fg-dim
       --bad        → --err
       --good/warn  → --ok / --warn (used by .st-* badge classes)

     The original used recursive nested DOM so child indent came from
     `margin-left: 6px` on each .tree-node. We flatten to a single list
     and apply per-depth `margin-left` inline (6 + (d-1)*14) to keep
     the visual nesting identical without the nesting markup. */

  .muted {
    color: var(--fg-muted);
  }
  .bad {
    color: var(--err);
  }

  .tree {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .tree-node {
    padding: 4px 8px;
    border-left: 1px dashed var(--border);
    padding-left: 14px;
    cursor: pointer;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .tree-node.root {
    border-left: none;
    padding-left: 0;
    margin-left: 0 !important;
  }
  .tree-node:hover {
    background: var(--bg-elev);
  }
  .tree-node.current {
    background: var(--bg-elev-2);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .tree-node .path {
    color: var(--fg-dim);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-node .meta {
    color: var(--fg-muted);
    font-size: 10.5px;
  }
  .tree-footer {
    color: var(--fg-muted);
    font-size: 11px;
    padding: 10px 0 0;
  }

  /* Status badge color classes — duplicated from the original
     so SessionTab is self-contained when used in isolation.
     If/when these become global in app.css they can be removed
     here without changing markup. */
  .tree-node :global(.st-2) {
    color: var(--ok);
  }
  .tree-node :global(.st-4) {
    color: var(--warn);
  }
  .tree-node :global(.st-5) {
    color: var(--err);
  }
  .tree-node :global(.st-x) {
    color: var(--fg-muted);
  }
</style>
