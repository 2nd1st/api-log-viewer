<script lang="ts">
  // HealthzView — operator healthz dashboard.
  //
  // Direct port of the original viewer's healthz surface in
  // api-log/internal/viewer/static/index.html:
  //   - HTML markup       lines 500-509 (#healthz section + two .cards grids)
  //   - CSS               lines 347-367 (#healthz / .cards / .card variants)
  //   - loadHealthz()     lines 1288-1300 (fetch + setStatus)
  //   - renderHealthz()   lines 1302-1332 (card grid + per-trace timings)
  //   - startHealthz()    line 1334 (5s polling, fires immediately then setInterval)
  //   - stopHealthz()     line 1335 (clearInterval guard)
  //
  // Behavior preserved 1:1:
  //   - GET /healthz on mount, then every 5000ms via setInterval (matches original).
  //   - On success: pushes a status line — either `${appended} traces` (good) or
  //     `${drops} drops` (bad) when any drop counter is non-zero. The drop sum is
  //     drop_writer_full + drop_jsonl_fail + drop_sqlite_fail (bitwise-OR-zero
  //     coerced to int, exactly like the original `|0`).
  //   - On failure: status = 'healthz down' / 'bad'.
  //   - 8 summary cards in the order: uptime, appended, indexed, drops,
  //     truncated, writer chan, slow traces, upstream dial err.
  //   - 3 timing cards in the order: drain, parse, sqlite (the `_ms` suffix
  //     is stripped from the label; sub-line shows p95 / p99 / count / mean).
  //   - Card .kind ('bad' | 'warn' | null) drives the value color — same
  //     thresholds as the original.
  //   - uptime sub-line shows the ISO start time (Z, sliced to seconds), same
  //     `Date.now() - uptime_seconds*1000` math as the original.
  //   - mean uses .toFixed(2) (with ?? 0 default), matching the original.
  //
  // Shared utilities — see notes in PORT_SCHEMA.
  //   authFetch: (path: string) => Promise<Response>  (same shape as
  //     SessionsList; signature already exists in src/lib/api.ts).
  //   setStatus: (text: string, kind?: 'good' | 'bad' | '') => void
  //     (same shape as SessionsList — pushes to the shared status banner).

  // ---------- types matching the /healthz JSON shape ----------

  interface TimingBucket {
    p50_ms?: number;
    p95_ms?: number;
    p99_ms?: number;
    count?: number;
    mean_ms?: number;
  }

  interface HealthzCounters {
    appended?: number;
    appended_2xx?: number;
    appended_4xx?: number;
    appended_5xx?: number;
    indexed?: number;
    drop_writer_full?: number;
    drop_jsonl_fail?: number;
    drop_sqlite_fail?: number;
    truncated_req_total?: number;
    truncated_resp_total?: number;
    writer_chan_high_water?: number;
    slow_traces?: number;
    upstream_dial_err?: number;
    timings?: Record<string, TimingBucket>;
  }

  interface Healthz {
    uptime_seconds: number;
    counters?: HealthzCounters;
  }

  interface CardSpec {
    label: string;
    value: string | number;
    sub: string;
    kind?: 'bad' | 'warn' | 'good' | null;
  }

  // ---------- props ----------

  interface Props {
    authFetch: (path: string) => Promise<Response>;
    setStatus: (text: string, kind?: 'good' | 'bad' | '') => void;
  }

  const { authFetch, setStatus }: Props = $props();

  // ---------- state ----------

  let healthz = $state<Healthz | null>(null);

  // ---------- fetch + status update ----------

  async function loadHealthz() {
    try {
      const r = await authFetch('healthz');
      if (!r.ok) throw new Error(String(r.status));
      healthz = await r.json();
      const c = (healthz?.counters || {}) as HealthzCounters;
      const drops =
        ((c.drop_writer_full ?? 0) | 0) +
        ((c.drop_jsonl_fail ?? 0) | 0) +
        ((c.drop_sqlite_fail ?? 0) | 0);
      setStatus(
        drops > 0 ? `${drops} drops` : `${c.appended} traces`,
        drops > 0 ? 'bad' : 'good',
      );
    } catch (_e) {
      setStatus('healthz down', 'bad');
    }
  }

  // ---------- 5s polling ----------
  //
  // Mirrors startHealthz / stopHealthz: kick off an immediate load then
  // schedule every 5000ms; clear on unmount.
  $effect(() => {
    loadHealthz();
    const t = setInterval(loadHealthz, 5000);
    return () => clearInterval(t);
  });

  // ---------- derived card specs ----------

  const cards = $derived.by<CardSpec[]>(() => {
    if (!healthz) return [];
    const h = healthz;
    const c = (h.counters || {}) as HealthzCounters;
    const drops =
      ((c.drop_writer_full ?? 0) | 0) +
      ((c.drop_jsonl_fail ?? 0) | 0) +
      ((c.drop_sqlite_fail ?? 0) | 0);
    const trunc =
      ((c.truncated_req_total ?? 0) | 0) +
      ((c.truncated_resp_total ?? 0) | 0);
    return [
      {
        label: 'uptime',
        value: Math.floor(h.uptime_seconds / 60) + 'm',
        sub:
          new Date(Date.now() - h.uptime_seconds * 1000)
            .toISOString()
            .slice(0, 19) + 'Z',
      },
      {
        label: 'appended',
        value: c.appended ?? 0,
        sub: `2xx ${(c.appended_2xx ?? 0) | 0} · 4xx ${(c.appended_4xx ?? 0) | 0} · 5xx ${(c.appended_5xx ?? 0) | 0}`,
      },
      {
        label: 'indexed',
        value: c.indexed ?? 0,
        sub: `lag ${(c.appended ?? 0) - (c.indexed ?? 0)}`,
      },
      {
        label: 'drops',
        value: drops,
        sub: `writer ${(c.drop_writer_full ?? 0) | 0} · jsonl ${(c.drop_jsonl_fail ?? 0) | 0} · sqlite ${(c.drop_sqlite_fail ?? 0) | 0}`,
        kind: drops > 0 ? 'bad' : null,
      },
      {
        label: 'truncated',
        value: trunc,
        sub: `req ${(c.truncated_req_total ?? 0) | 0} · resp ${(c.truncated_resp_total ?? 0) | 0}`,
        kind: trunc > 0 ? 'warn' : null,
      },
      {
        label: 'writer chan',
        value: c.writer_chan_high_water ?? 0,
        sub: 'high-water / 1024',
      },
      {
        label: 'slow traces',
        value: (c.slow_traces ?? 0) | 0,
        sub: '> 30s end-to-end',
        kind: ((c.slow_traces ?? 0) | 0) > 0 ? 'warn' : null,
      },
      {
        label: 'upstream dial err',
        value: (c.upstream_dial_err ?? 0) | 0,
        sub: 'dns / tls / refused',
        kind: ((c.upstream_dial_err ?? 0) | 0) > 0 ? 'bad' : null,
      },
    ];
  });

  // ---------- derived timing specs ----------

  // Fixed order — matches the original's ['drain_ms','parse_ms','sqlite_ms']
  // string array; label = key without the '_ms' suffix.
  const TIMING_KEYS = ['drain_ms', 'parse_ms', 'sqlite_ms'] as const;

  const timings = $derived.by(() => {
    if (!healthz) return [];
    const t = healthz.counters?.timings || {};
    return TIMING_KEYS.map((k) => {
      const v: TimingBucket = t[k] || {};
      return {
        key: k,
        label: k.replace('_ms', ''),
        p50: v.p50_ms ?? 0,
        p95: v.p95_ms ?? 0,
        p99: v.p99_ms ?? 0,
        count: v.count ?? 0,
        mean: (v.mean_ms ?? 0).toFixed(2),
      };
    });
  });
</script>

<section class="healthz">
  <div>
    <h3 class="group-title">writer / index</h3>
    <div class="cards">
      {#each cards as card (card.label)}
        <div class="card" class:bad={card.kind === 'bad'} class:warn={card.kind === 'warn'} class:good={card.kind === 'good'}>
          <div class="label">{card.label}</div>
          <div class="value">{card.value}</div>
          <div class="sub">{card.sub}</div>
        </div>
      {/each}
    </div>
  </div>

  <div>
    <h3 class="group-title">per-trace timings (ms)</h3>
    <div class="cards">
      {#each timings as t (t.key)}
        <div class="card">
          <div class="label">{t.label}</div>
          <div class="value">{t.p50} <span class="p50-tag">p50</span></div>
          <div class="sub">p95 {t.p95} · p99 {t.p99} · n {t.count} · mean {t.mean}</div>
        </div>
      {/each}
    </div>
  </div>
</section>

<style>
  /* Mirrors the original #healthz / .cards / .card rules from index.html
     (lines 347-367), translated to the new CSS variable names defined in
     app.css (--border for --line, --fg-muted for --muted, --err/--warn/--ok
     for --bad/--warn/--good). */
  .healthz {
    display: flex;
    flex-direction: column;
    padding: 16px 20px;
    gap: 18px;
    overflow: auto;
  }
  .group-title {
    font-size: 10px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 8px;
  }
  .cards {
    display: grid;
    gap: 1px;
    grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    background: var(--border);
    border: 1px solid var(--border);
  }
  .card {
    background: var(--bg-elev);
    padding: 12px 14px;
  }
  .card .label {
    color: var(--fg-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .card .value {
    font-family: var(--mono);
    font-size: 20px;
    font-weight: 500;
    margin-top: 4px;
  }
  .card .sub {
    color: var(--fg-muted);
    font-size: 11px;
    font-family: var(--mono);
    margin-top: 4px;
  }
  .card.bad  .value { color: var(--err); }
  .card.warn .value { color: var(--warn); }
  .card.good .value { color: var(--ok); }

  /* Inline-style replacement for the original's `style="color:...;font-size:12px;font-weight:400"`
     on the "p50" suffix tag. Kept as a scoped class so the .svelte file stays
     style-attribute-free per the project conventions. */
  .p50-tag {
    color: var(--fg-muted);
    font-size: 12px;
    font-weight: 400;
  }
</style>