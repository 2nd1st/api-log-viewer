<script lang="ts">
  // Scaffold shell. Phase B2 fills in the actual viewer surfaces
  // (filter sidebar, trace list, sessions list, detail panel, etc.)
  // ported 1:1 from internal/viewer/static/index.html.
</script>

<header class="topbar">
  <div class="brand">api-log</div>
  <div class="spacer"></div>
  <div class="hint">scaffold — content port pending</div>
</header>

<main>
  <p>Vite dev server is up. Proxying <code>/api/*</code> and <code>/healthz</code> to backend.</p>
</main>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .brand {
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--accent);
  }
  .spacer { flex: 1; }
  .hint {
    color: var(--fg-dim);
    font-size: 12px;
  }
  main { padding: 16px; color: var(--fg-muted); }
</style>
