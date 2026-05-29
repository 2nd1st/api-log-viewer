<script lang="ts">
  import type { MediaBlock } from '../../lib/blocks';

  // ─── Props ─────────────────────────────────────────────────────────────
  let {
    block,
  }: {
    block: MediaBlock;
    // onJumpToPair is only used by ToolCallBlock + ToolResultBlock; ignored here.
    onJumpToPair?: (id: string) => void;
  } = $props();

  // ─── Derived metadata ──────────────────────────────────────────────────
  const isImage = $derived(block.mime_type?.startsWith('image/') ?? false);
  const hasInlineData = $derived(!!block.data_b64);
  const hasUrl = $derived(!!block.url);

  // Display filename: explicit > mime-derived > fallback.
  const displayName = $derived(
    block.filename ??
      (block.mime_type ? `inline.${mimeToExt(block.mime_type)}` : 'inline.bin'),
  );

  // Approximate decoded byte size from base64 length (b64 inflates ~4/3).
  // Cheap, no decode; used as label only.
  const approxBytes = $derived(
    block.data_b64 ? Math.floor((block.data_b64.length * 3) / 4) : 0,
  );
  const sizeLabel = $derived(approxBytes ? formatBytes(approxBytes) : '');

  // ─── Lazy state ────────────────────────────────────────────────────────
  // We never decode b64 in the render path. Only on user click.
  // imgSrc becomes a data: URL (or remote URL) the moment the user opts in.
  let imgSrc = $state<string | null>(null);
  let imgLoadError = $state<string | null>(null);
  let expanded = $state(false);

  // Image thumb: prefer remote URL (cheap); otherwise wait for user opt-in
  // and synthesize a data: URI from the b64 string. Either way, no parsing
  // of the b64 itself — we just hand it to the browser as a Data URL.
  function loadImage(): void {
    if (imgSrc) return;
    if (hasUrl) {
      imgSrc = block.url!;
      return;
    }
    if (hasInlineData) {
      try {
        imgSrc = `data:${block.mime_type};base64,${block.data_b64}`;
      } catch (e) {
        imgLoadError = e instanceof Error ? e.message : String(e);
      }
    }
  }

  // For images we eagerly hand the data: URL to <img> so the browser can
  // decode on its own thread. We still skip the b64 string in the DOM text.
  $effect(() => {
    if (isImage) loadImage();
  });

  function toggleExpand(): void {
    expanded = !expanded;
  }

  // ─── Download path (non-image, or image fallback) ─────────────────────
  // Decode b64 only on click. atob is sync but fast enough for normal
  // payloads; for >5MB we still tolerate it because the user explicitly
  // opted in. The huge-string elision rule was about *pretty-printing in
  // JSON*, not about download itself.
  function download(): void {
    if (!hasInlineData && hasUrl) {
      // Server-hosted — just open the URL in a new tab.
      window.open(block.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!block.data_b64) return;
    try {
      const bin = atob(block.data_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: block.mime_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Release the blob URL on the next tick so the download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      imgLoadError = e instanceof Error ? e.message : String(e);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
      'application/json': 'json',
      'text/plain': 'txt',
    };
    return map[mime] ?? (mime.split('/')[1] || 'bin');
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="block">
  <header class="row">
    <div class="left">
      <span class="glyph" aria-hidden="true">🖼</span>
      <span class="role">{block.role}</span>
    </div>
    <div class="meta mono">
      {#if block.token_estimate !== undefined}
        <span>{block.token_estimate}t</span>
      {/if}
      <span>{block.source.side}</span>
      <span>{block.source.container}</span>
    </div>
  </header>

  <div class="body">
    {#if isImage && imgSrc}
      <button
        type="button"
        class="thumb-btn"
        onclick={toggleExpand}
        aria-label={expanded ? 'Collapse image' : 'Expand image'}
      >
        <img
          src={imgSrc}
          alt={displayName}
          class="thumb"
          class:expanded
          loading="lazy"
          decoding="async"
          onerror={() => {
            imgLoadError = 'failed to decode image';
          }}
        />
      </button>
      {#if imgLoadError}
        <div class="err mono">{imgLoadError}</div>
      {/if}
      <div class="caption mono">
        <span class="name">{displayName}</span>
        <span class="sep">·</span>
        <span class="mime">{block.mime_type}</span>
        {#if sizeLabel}
          <span class="sep">·</span>
          <span class="size">{sizeLabel}</span>
        {/if}
        <button type="button" class="link" onclick={download}>download</button>
      </div>
    {:else}
      <div class="file">
        <div class="file-info">
          <div class="file-name mono">{displayName}</div>
          <div class="file-meta mono">
            <span>{block.mime_type || 'application/octet-stream'}</span>
            {#if sizeLabel}
              <span class="sep">·</span>
              <span>{sizeLabel}</span>
            {/if}
            <span class="sep">·</span>
            <span>{block.media_type}</span>
          </div>
        </div>
        <button
          type="button"
          class="dl"
          onclick={download}
          disabled={!hasInlineData && !hasUrl}
        >
          download
        </button>
      </div>
      {#if imgLoadError}
        <div class="err mono">{imgLoadError}</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--gap-3);
  }

  .left {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
  }

  .glyph {
    font-size: 12px;
    color: var(--fg-muted);
    line-height: 1;
  }

  .role {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .meta {
    font-size: 11px;
    color: var(--fg-dim);
    display: flex;
    gap: var(--gap-2);
    flex-shrink: 0;
  }

  .meta span + span::before {
    content: '·';
    margin-right: var(--gap-2);
    color: var(--fg-dim);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  /* ── Image variant ── */
  .thumb-btn {
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: zoom-in;
    align-self: flex-start;
    line-height: 0;
    overflow: hidden;
  }
  .thumb-btn:hover {
    border-color: var(--border-strong);
  }

  .thumb {
    display: block;
    max-width: 200px;
    max-height: 200px;
    width: auto;
    height: auto;
    object-fit: contain;
    background: var(--bg-elev);
  }

  .thumb.expanded {
    max-width: min(720px, 100%);
    max-height: 80vh;
  }

  .thumb-btn:has(.expanded) {
    cursor: zoom-out;
  }

  .caption {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--gap-2);
    font-size: 11px;
    color: var(--fg-dim);
  }

  .caption .name {
    color: var(--fg-muted);
  }

  .caption .sep {
    color: var(--fg-dim);
  }

  /* ── Non-image variant ── */
  .file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-3);
    padding: var(--gap-2) var(--gap-3);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .file-name {
    font-size: 12px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    font-size: 11px;
    color: var(--fg-dim);
    display: flex;
    gap: var(--gap-2);
    flex-wrap: wrap;
  }

  .dl {
    flex-shrink: 0;
    font-size: 11px;
    padding: 3px 10px;
  }

  /* ── Inline link button (image caption) ── */
  .link {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 11px;
    cursor: pointer;
    margin-left: auto;
  }
  .link:hover {
    color: var(--accent-dim);
    text-decoration: underline;
  }

  .err {
    font-size: 11px;
    color: var(--err);
  }
</style>
