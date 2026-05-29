<script lang="ts">
  // ReplayTab — speed-selectable streaming replay of a trace's response.
  //
  // 1:1 port of `renderReplay(panel, row)` in the original viewer
  // (api-log/internal/viewer/static/index.html, ~lines 1245-1284), plus
  // the matching `.replay-controls` / `.replay-out` CSS block
  // (lines 258-277).
  //
  // Behavioral fidelity:
  //   - Four speed buttons (1×, 2×, 10×, nodelay) + a stop button.
  //   - Endpoint: `api/traces/${row.id}/replay` (relative; joined via api()).
  //     - speed === '0'  →  ?nodelay=1
  //     - else           →  ?speed=<n>
  //   - Authorization header: `Bearer ${token}` (raw fetch, NOT authFetch —
  //     the original used raw fetch here so it could pass an AbortSignal and
  //     keep the streaming reader semantics identical to the upstream).
  //   - Stream the response body via ReadableStream + TextDecoder, append
  //     each decoded chunk into the output box, scroll to bottom after each
  //     chunk.
  //   - Single in-flight stream at a time: starting a new run aborts any
  //     prior AbortController; stop button aborts current.
  //   - Status text: 'idle' (initial — original placeholder lives in the
  //     output box only, status starts at 'idle' implicitly via the same
  //     unwritten textContent; original used the literal 'idle' string in
  //     the markup, so we mirror that). Then 'streaming…', then 'done',
  //     'stopped', `http <status>` on non-2xx, or `failed: <msg>` on
  //     non-abort errors.
  //   - Output box initial placeholder: '(press a speed button)'.
  //
  // Invented signature: `trace` prop carries `{ id: string }` (same as
  // every other tab). Token comes from lib/api.ts via getToken() — the
  // original read `state.token` directly; getToken() is the Svelte-port
  // equivalent.

  import { api, getToken } from '../../lib/api';

  interface TraceShape {
    id: string;
  }

  const { trace }: { trace: TraceShape } = $props();

  let status = $state('idle');
  let output = $state('(press a speed button)');

  // Single in-flight controller. Module-level `state.replayAbort` in the
  // original; here a component-scoped $state is sufficient because the tab
  // is unmounted (and the abort triggered via $effect cleanup) when the
  // user switches trace or tab.
  let abortCtrl: AbortController | null = $state(null);

  // Output element ref for scroll-to-bottom on each chunk.
  let outEl: HTMLDivElement | null = $state(null);

  function stop(): void {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
      status = 'stopped';
    }
  }

  async function run(speed: string): Promise<void> {
    stop();
    output = '';
    const url =
      api(`api/traces/${trace.id}/replay`) +
      (speed === '0' ? '?nodelay=1' : `?speed=${speed}`);
    status = 'streaming…';
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    try {
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + getToken() },
        signal: ctrl.signal,
      });
      if (!r.ok) {
        status = `http ${r.status}`;
        return;
      }
      const body = r.body;
      if (!body) {
        status = 'done';
        return;
      }
      const reader = body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          status = 'done';
          break;
        }
        output += dec.decode(value, { stream: true });
        // Scroll the output container to the bottom after the DOM update.
        // Using queueMicrotask keeps this in the same tick as the original
        // `out.scrollTop = out.scrollHeight` assignment that ran immediately
        // after textContent mutation (which was synchronous in the original
        // since it touched a real DOM node).
        queueMicrotask(() => {
          if (outEl) outEl.scrollTop = outEl.scrollHeight;
        });
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name !== 'AbortError') {
        status = 'failed: ' + (err?.message ?? String(e));
      }
    } finally {
      abortCtrl = null;
    }
  }

  // Abort any in-flight stream when the component unmounts (tab switch,
  // trace change, etc.).
  $effect(() => {
    return () => {
      if (abortCtrl) {
        abortCtrl.abort();
        abortCtrl = null;
      }
    };
  });
</script>

<div class="replay-controls">
  <button class="run" onclick={() => run('1')}>1×</button>
  <button class="run" onclick={() => run('2')}>2×</button>
  <button class="run" onclick={() => run('10')}>10×</button>
  <button class="run" onclick={() => run('0')}>nodelay</button>
  <button class="stop" onclick={stop}>stop</button>
  <span class="status">{status}</span>
</div>
<div class="replay-out" bind:this={outEl}>{output}</div>

<style>
  /* Mirrors original .replay-controls / .replay-out (index.html 258-277).
     Uses app.css tokens where available; the original referenced
     --panel / --line / --line-2 / --muted / --bad / --r which map to
     --bg-elev / --border / --border-strong / --fg-muted / --err / --radius
     in the Svelte port's app.css. */
  .replay-controls {
    display: flex;
    gap: var(--gap-1);
    align-items: center;
    margin-bottom: 10px;
    font-family: var(--mono);
    font-size: 11px;
  }
  .replay-controls button {
    background: var(--bg-elev);
    color: var(--fg-dim);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
  }
  .replay-controls button:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }
  .replay-controls button.run {
    color: var(--accent);
    border-color: rgba(94, 234, 212, 0.4);
  }
  .replay-controls button.stop {
    color: var(--err);
    border-color: rgba(252, 165, 165, 0.4);
  }
  .replay-controls .status {
    margin-left: auto;
    color: var(--fg-muted);
  }
  .replay-out {
    background: #06070a;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: #c9c9c9;
    font-family: var(--mono);
    font-size: 11px;
    padding: 10px 12px;
    min-height: 200px;
    max-height: 520px;
    overflow: auto;
    white-space: pre-wrap;
  }
</style>
