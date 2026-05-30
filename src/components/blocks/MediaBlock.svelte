<script lang="ts">
  // MediaBlock renderer.
  //
  // Backend PHILOSOPHY §1 (render what's there, no synthesis):
  //   - We render the NAMED inline fields the adapter populated:
  //     `block.url` (remote URL or backend-served extracted path) or
  //     `block.data_b64` (inline base64 from the protocol).
  //   - `body_b64` is NOT an attachment — it's the unparseable-fallback
  //     container — and is NOT routed into MediaBlock by the adapter.
  //
  // Backend §2: capture is non-blocking. The viewer reads what the
  //   extractor (and adapter) recorded; this renderer is a read-only
  //   view over those fields.
  //
  // Backend §6: filesystem is truth. When `block.url` points at the
  //   extracted file served by /api/media/..., the browser fetches the
  //   real bytes. When only `data_b64` is present we synthesize a
  //   data: URL — no JS decode of the b64 in the render path.
  //
  // Viewer PHILOSOPHY §5 (restraint):
  //   - No background fills on the block. Hairline border-bottom only.
  //   - Role label upper-left, small-caps, --fg-dim.
  //   - Right-aligned metadata strip: side · container · size · mime,
  //     11px mono, --fg-dim.
  //   - No emojis. Static rows use the `─` glyph; expand control on
  //     the image uses `▸`. Both come from the existing ASCII glyph
  //     family already used by the other Block renderers.
  //
  // onJumpToPair is accepted for symmetry with the other Block
  // renderers but is unused here.

  import type { MediaBlock } from '../../lib/blocks';
  import { t } from '../../lib/i18n.svelte';

  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

  type Props = {
    block: MediaBlock;
    onJumpToPair?: (id: string) => void;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { block, onJumpToPair: _onJumpToPair }: Props = $props();

  // ─── Type discrimination ───────────────────────────────────────────
  // Prefer mime_type because it's the protocol-derived truth; fall
  // back to media_type when mime is empty/missing.
  const mime = $derived((block.mime_type || '').toLowerCase());
  const isImage = $derived(mime.startsWith('image/') || block.media_type === 'image');
  const isAudio = $derived(mime.startsWith('audio/') || block.media_type === 'audio');
  const isVideo = $derived(mime.startsWith('video/') || block.media_type === 'video');
  // Documents and anything that isn't image/audio/video render as the
  // download chip.
  const isFile = $derived(!isImage && !isAudio && !isVideo);

  const hasInline = $derived(!!block.data_b64);
  const hasUrl = $derived(!!block.url);

  // ─── Source URL (data: or remote/backend-served) ───────────────────
  // Synthesized only when we have something to point at. We hand the
  // base64 to the browser as a data: URL — no atob in render.
  const src = $derived.by<string | null>(() => {
    if (hasInline) {
      return `data:${block.mime_type || 'application/octet-stream'};base64,${block.data_b64}`;
    }
    if (hasUrl) return block.url!;
    return null;
  });

  // ─── Display filename ─────────────────────────────────────────────
  const displayName = $derived(
    block.filename || `media.${mimeToExt(block.mime_type || '')}`,
  );

  // ─── Approximate size ─────────────────────────────────────────────
  // Base64 decodes to ~3/4 its length. Cheap, no decode. Used as a
  // human label only — never a precise value.
  const approxBytes = $derived(
    block.data_b64 ? Math.floor((block.data_b64.length * 3) / 4) : 0,
  );
  const sizeLabel = $derived(approxBytes ? formatBytes(approxBytes) : '');

  // ─── Metadata strip parts (right-aligned) ─────────────────────────
  const metaParts = $derived(
    [
      block.source.side,
      block.source.container,
      sizeLabel,
      block.mime_type || '',
    ].filter((s) => s.length > 0),
  );

  // ─── Inline image expand state ────────────────────────────────────
  let expanded = $state(false);
  function toggleExpand(): void {
    expanded = !expanded;
  }

  // ─── File download ────────────────────────────────────────────────
  // Decode b64 → Blob → object URL only on click. Revoke after 1s so
  // the browser has time to start the download. When only `url` is
  // present we let the anchor's native `download` attribute drive it.
  let downloadError = $state<string | null>(null);

  function downloadInline(): void {
    if (!block.data_b64) return;
    try {
      const bin = atob(block.data_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: block.mime_type || 'application/octet-stream',
      });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch (e) {
      downloadError = e instanceof Error ? e.message : String(e);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  function mimeToExt(m: string): string {
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
      'video/webm': 'webm',
      'application/pdf': 'pdf',
      'application/json': 'json',
      'text/plain': 'txt',
    };
    return map[m.toLowerCase()] ?? (m.split('/')[1] || 'bin');
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="block">
  <div class="head">
    <span class="role">{roleLabel(block.role)}</span>
    <span class="title">
      <span class="glyph" aria-hidden="true">{isImage ? '▸' : '─'}</span>
      <span class="kind">{block.media_type}</span>
    </span>
    <span class="meta">
      {#each metaParts as part, i (i)}
        {#if i > 0}<span class="sep">·</span>{/if}<span>{part}</span>
      {/each}
    </span>
  </div>

  <div class="body">
    {#if isImage && src}
      <button
        type="button"
        class="thumb-btn"
        class:expanded
        onclick={toggleExpand}
        aria-label={expanded ? t('blocks.collapseImage') : t('blocks.expandImage')}
      >
        <img
          src={src}
          alt={displayName}
          class="thumb"
          class:expanded
          loading="lazy"
          decoding="async"
        />
      </button>
    {:else if isAudio && src}
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio controls preload="metadata" src={src} class="audio"></audio>
    {:else if isVideo && src}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video controls preload="metadata" src={src} class="video"></video>
    {:else if isFile || !src}
      <div class="file">
        <div class="file-info">
          <div class="file-name mono">{displayName}</div>
          <div class="file-meta mono">
            <span>{block.mime_type || 'application/octet-stream'}</span>
            {#if sizeLabel}
              <span class="sep">·</span><span>{sizeLabel}</span>
            {/if}
          </div>
        </div>
        {#if hasInline}
          <button type="button" class="dl mono" onclick={downloadInline}>
            {t('blocks.download')}
          </button>
        {:else if hasUrl}
          <a
            class="dl mono"
            href={block.url}
            download={displayName}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('blocks.download')}
          </a>
        {:else}
          <span class="dl mono dl--disabled">{t('blocks.unavailable')}</span>
        {/if}
      </div>
    {/if}

    {#if downloadError}
      <div class="err mono">{downloadError}</div>
    {/if}
  </div>
</div>

<style>
  /* Phase 2B block frame — 4px left rail + hairline bottom only.
     MediaBlock has no role-class wiring (markup is frozen this pass)
     so the rail defaults to --border-strong. The head row's role
     label still carries role identity in text. */
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    line-height: 1;
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .role {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    color: var(--fg-muted);
    font-size: var(--size-label);
  }

  .title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--fg-muted);
  }

  .glyph {
    display: inline-block;
    width: 10px;
    color: var(--fg-dim);
  }

  /* Type indicator — lowercase outline chip per Phase 2B spec. */
  .kind {
    text-transform: lowercase;
    letter-spacing: 0.02em;
    font-size: var(--size-label);
    padding: 1px 4px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    line-height: 1;
    color: var(--fg-muted);
  }

  .meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--fg-dim);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .meta .sep { color: var(--fg-dim); }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ── Image ───────────────────────────────────────────────────────
     Collapsed: 200×200 thumbnail, zoom-in cursor.
     Expanded: natural size capped at 100% of container, zoom-out. */
  .thumb-btn {
    align-self: flex-start;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: zoom-in;
    line-height: 0;
    overflow: hidden;
    max-width: 100%;
  }
  .thumb-btn.expanded { cursor: zoom-out; }
  .thumb-btn:hover { border-color: var(--border-strong); }

  .thumb {
    display: block;
    max-width: 200px;
    max-height: 200px;
    width: auto;
    height: auto;
    object-fit: contain;
  }
  .thumb.expanded {
    max-width: 100%;
    max-height: none;
  }

  /* ── Audio / Video ──────────────────────────────────────────────── */
  .audio {
    display: block;
    width: 100%;
    max-width: 360px;
  }

  .video {
    display: block;
    max-width: 100%;
    max-height: 360px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  /* ── File / Document / Other ────────────────────────────────────── */
  .file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .file-name {
    font-size: var(--size-body);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    font-size: var(--size-label);
    color: var(--fg-dim);
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .file-meta .sep { color: var(--fg-dim); }

  .dl {
    flex-shrink: 0;
    font-size: var(--size-label);
    line-height: 1;
    padding: 4px 10px;
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--font-mono);
  }
  .dl:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .dl--disabled {
    color: var(--fg-dim);
    cursor: default;
  }
  .dl--disabled:hover {
    border-color: var(--border);
    color: var(--fg-dim);
  }

  .mono { font-family: var(--font-mono); }

  .err {
    font-size: var(--size-label);
    color: var(--err);
    font-family: var(--font-mono);
  }
</style>
