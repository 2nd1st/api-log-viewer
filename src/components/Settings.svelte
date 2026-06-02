<script lang="ts">
  // Settings — viewer-side preferences + token surface + about.
  //
  // Settings constraints:
  //   - "It is not THE frontend; it is A frontend." Composable, not
  //     authoritative. Plugin / gate / redact config does NOT live
  //     here — that's a backend YAML concern.
  //   - Operational, not analytics-heavy. No live healthz counters
  //     (uptime / appended / drops / data-dir / last-poll) — that
  //     surface duplicates what the upstream gateway's own dashboard
  //     already renders. Keep About → version + healthz endpoint URL.
  //   - Single accent (--accent, teal-300) reserved for active state,
  //     selected row, and focus ring ONLY. Toggle on-state uses
  //     high-contrast var(--fg), NOT accent.
  //   - i18n: every visible string goes through t(). The dictionaries
  //     live in en.ts / zh.ts; on a missing key
  //     t() returns the key string itself which would surface as
  //     literal "settings.xxx" text. Every key used here is verified
  //     present in en.ts before write.
  //
  // SECTIONS (4 cards):
  //   1. Display          — theme toggle, language toggle
  //   2. Default Filters  — default path filter, traces auto-refresh,
  //                         save-attachments (backend-connected), reset
  //   3. Auth             — masked admin token, change button, clear
  //                         button (calls setToken('') in place)
  //   4. About            — viewer version (hardcoded — no vite define),
  //                         healthz endpoint URL, upstream repo link
  //
  // localStorage keys (do not rename — same constants as lib/api.ts and
  // TracesList.svelte):
  //   apilog.default_path        — default path filter, fallback '/v1/*'
  //   apilog.traces.autorefresh  — traces list auto-refresh cadence
  //   apilog.token               — admin Bearer token
  //   apilog.theme               — 'dark' | 'light' (lib/theme.ts)
  //   apilog.lang                — 'en' | 'zh' (lib/i18n.svelte.ts)

  import { onMount } from 'svelte';
  import { DEFAULT_PATH_KEY, api, getToken, setToken } from '../lib/api';
  import { getTheme, setTheme, type Theme } from '../lib/theme.svelte';
  import { getLang, setLang, t } from '../lib/i18n.svelte';

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    onOpenAuthModal: () => void;
  }

  const { authFetch, onOpenAuthModal }: Props = $props();

  // ---------- DISPLAY: theme ----------
  //
  // getTheme() is backed by module $state in lib/theme.svelte.ts —
  // reading it in-template is reactive (Header relies on the same
  // pattern). No local mirror.

  function toggleThemeRow() {
    const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }

  // ---------- DISPLAY: language ----------
  //
  // getLang() is backed by module $state — reading it in-template is
  // reactive (Header relies on the same pattern). No local mirror.

  function toggleLangRow() {
    setLang(getLang() === 'en' ? 'zh' : 'en');
  }

  // ---------- DEFAULT FILTERS: default path ----------

  const PATH_DEFAULT = '/v1/*';

  function readPath(): string {
    try {
      return localStorage.getItem(DEFAULT_PATH_KEY) || PATH_DEFAULT;
    } catch {
      return PATH_DEFAULT;
    }
  }

  let pathValue = $state<string>(readPath());
  let pathHintVisible = $state<boolean>(false);
  let pathHintTimer: ReturnType<typeof setTimeout> | null = null;

  function persistPath() {
    const v = pathValue.trim() || PATH_DEFAULT;
    pathValue = v;
    try {
      localStorage.setItem(DEFAULT_PATH_KEY, v);
    } catch {
      // private mode / sandboxed iframe — silently no-op, same as
      // TracesList.svelte's readPersistedRefresh().
    }
    pathHintVisible = true;
    if (pathHintTimer) clearTimeout(pathHintTimer);
    pathHintTimer = setTimeout(() => {
      pathHintVisible = false;
    }, 1000);
  }

  // ---------- DEFAULT FILTERS: traces auto-refresh ----------

  type RefreshOpt = 'off' | '5s' | '10s' | '30s' | '60s' | '5m';
  const REFRESH_OPTIONS: RefreshOpt[] = ['off', '5s', '10s', '30s', '60s', '5m'];
  const REFRESH_KEY = 'apilog.traces.autorefresh';

  function readRefresh(): RefreshOpt {
    try {
      const v = localStorage.getItem(REFRESH_KEY);
      if (v && (REFRESH_OPTIONS as string[]).includes(v)) {
        return v as RefreshOpt;
      }
    } catch {
      // see persistPath()
    }
    return 'off';
  }

  let refreshOpt = $state<RefreshOpt>(readRefresh());

  function onRefreshChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value as RefreshOpt;
    refreshOpt = v;
    try {
      localStorage.setItem(REFRESH_KEY, v);
    } catch {
      // see persistPath()
    }
  }

  // ---------- DEFAULT FILTERS: save attachments (backend) ----------
  //
  // Backend GET /api/config/media → { save_attachments, source }
  // Backend PUT /api/config/media { save_attachments } persists to
  // runtime_overrides.json and updates in-memory config. The change is NOT
  // retroactive; existing files are left alone.
  //
  // This is the only Default-Filters row that talks to the backend.
  // We keep it here (rather than dropping it with the healthz live
  // counters) because it controls export attachment behavior.

  type MediaCfgState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; value: boolean; source: string };

  let mediaCfg = $state<MediaCfgState>({ kind: 'idle' });
  let mediaHintVisible = $state<boolean>(false);
  let mediaHintTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadMediaCfg() {
    mediaCfg = { kind: 'loading' };
    try {
      const r = await authFetch('api/config/media');
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { save_attachments?: boolean; source?: string };
      mediaCfg = {
        kind: 'ready',
        value: j.save_attachments === true,
        source: typeof j.source === 'string' ? j.source : 'default',
      };
    } catch (e: any) {
      mediaCfg = { kind: 'error', message: e?.message ?? String(e) };
    }
  }

  async function onMediaToggle() {
    // Inline switch: derive next from the current ready value (or
    // false if we never loaded). Optimistic UI — flip immediately,
    // revert on failure.
    if (mediaCfg.kind !== 'ready') return;
    const next = !mediaCfg.value;
    const prev = mediaCfg;
    mediaCfg = { ...mediaCfg, value: next };
    try {
      const r = await authFetch('api/config/media', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save_attachments: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { save_attachments?: boolean; source?: string };
      mediaCfg = {
        kind: 'ready',
        value: j.save_attachments === true,
        source: typeof j.source === 'string' ? j.source : 'override',
      };
      mediaHintVisible = true;
      if (mediaHintTimer) clearTimeout(mediaHintTimer);
      mediaHintTimer = setTimeout(() => {
        mediaHintVisible = false;
      }, 1000);
    } catch (e: any) {
      mediaCfg = prev;
      void e;
    }
  }

  // ---------- STORAGE: retention (backend, v0.1.1) ----------
  //
  // GET /api/config/retention → { max_bytes, max_age_days, warn_at_percent, source }
  // PUT /api/config/retention { max_bytes, max_age_days, warn_at_percent } persists
  // to runtime_overrides.json and updates the in-memory coordinator.
  //
  // Both knobs zero means "engine still runs, never deletes" — the
  // documented disable path; we surface it explicitly so an operator
  // who set everything to zero sees "Retention disabled" instead of
  // wondering why nothing's being evicted.
  //
  // 503 indicates the backend started without StorageCoord (older
  // build or unusual config); we render the controls disabled with a
  // hint pointing at the upgrade.

  type RetentionCfgState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'unavailable' }
    | { kind: 'ready'; maxBytes: number; maxAgeDays: number; warnAtPercent: number; source: string };

  let retentionCfg = $state<RetentionCfgState>({ kind: 'idle' });
  let retentionDraft = $state<{ maxBytes: string; maxAgeDays: string; warnAtPercent: string }>({
    maxBytes: '0',
    maxAgeDays: '0',
    warnAtPercent: '80',
  });
  let retentionSaving = $state<boolean>(false);
  let retentionSaveError = $state<string | null>(null);
  let retentionHintVisible = $state<boolean>(false);
  let retentionHintTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadRetentionCfg() {
    retentionCfg = { kind: 'loading' };
    try {
      const r = await authFetch('api/config/retention');
      if (r.status === 503) {
        retentionCfg = { kind: 'unavailable' };
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as {
        max_bytes?: number;
        max_age_days?: number;
        warn_at_percent?: number;
        source?: string;
      };
      const next = {
        maxBytes: typeof j.max_bytes === 'number' ? j.max_bytes : 0,
        maxAgeDays: typeof j.max_age_days === 'number' ? j.max_age_days : 0,
        warnAtPercent: typeof j.warn_at_percent === 'number' ? j.warn_at_percent : 80,
        source: typeof j.source === 'string' ? j.source : 'yaml',
      };
      retentionCfg = { kind: 'ready', ...next };
      retentionDraft = {
        maxBytes: String(next.maxBytes),
        maxAgeDays: String(next.maxAgeDays),
        warnAtPercent: String(next.warnAtPercent),
      };
    } catch (e: any) {
      retentionCfg = { kind: 'error', message: e?.message ?? String(e) };
    }
  }

  // saveRetention validates the draft then PUTs. We do client-side
  // validation only to avoid round-tripping for obvious typos — the
  // backend re-validates the same way storage.UpdateConfig does and
  // is the source of truth.
  async function saveRetention() {
    if (retentionCfg.kind !== 'ready') return;
    retentionSaveError = null;
    const maxBytes = Number(retentionDraft.maxBytes);
    const maxAgeDays = Number(retentionDraft.maxAgeDays);
    const warnAtPercent = Number(retentionDraft.warnAtPercent);
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      retentionSaveError = t('settings.retentionBadMaxBytes');
      return;
    }
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
      retentionSaveError = t('settings.retentionBadMaxAgeDays');
      return;
    }
    if (!Number.isInteger(warnAtPercent) || warnAtPercent < 0 || warnAtPercent > 100) {
      retentionSaveError = t('settings.retentionBadWarnAt');
      return;
    }
    retentionSaving = true;
    try {
      const r = await authFetch('api/config/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_bytes: Math.floor(maxBytes),
          max_age_days: maxAgeDays,
          warn_at_percent: warnAtPercent,
        }),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => null);
        throw new Error(errBody?.detail || String(r.status));
      }
      const j = (await r.json()) as {
        max_bytes?: number;
        max_age_days?: number;
        warn_at_percent?: number;
        source?: string;
      };
      retentionCfg = {
        kind: 'ready',
        maxBytes: typeof j.max_bytes === 'number' ? j.max_bytes : 0,
        maxAgeDays: typeof j.max_age_days === 'number' ? j.max_age_days : 0,
        warnAtPercent: typeof j.warn_at_percent === 'number' ? j.warn_at_percent : 80,
        source: typeof j.source === 'string' ? j.source : 'override',
      };
      retentionHintVisible = true;
      if (retentionHintTimer) clearTimeout(retentionHintTimer);
      retentionHintTimer = setTimeout(() => {
        retentionHintVisible = false;
      }, 1500);
    } catch (e: any) {
      retentionSaveError = e?.message ?? String(e);
    } finally {
      retentionSaving = false;
    }
  }

  // retentionIsDisabled — both knobs zero means "engine on, no policy"
  // (storage.UpdateConfig clears the retention pointer). Surface that
  // explicitly in the card so operators don't think a 0-on-both setting
  // is broken.
  const retentionIsDisabled = $derived(
    retentionCfg.kind === 'ready' &&
      retentionCfg.maxBytes === 0 &&
      retentionCfg.maxAgeDays === 0,
  );

  // ---------- DEFAULT FILTERS: reset ----------

  function resetDefaults() {
    try {
      localStorage.removeItem(DEFAULT_PATH_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      // see persistPath()
    }
    pathValue = PATH_DEFAULT;
    refreshOpt = 'off';
    pathHintVisible = true;
    if (pathHintTimer) clearTimeout(pathHintTimer);
    pathHintTimer = setTimeout(() => {
      pathHintVisible = false;
    }, 1000);
  }

  // ---------- AUTH: masked token ----------

  // Snapshot the token on mount and on window focus. AuthModal saves write
  // through setToken() in lib/api.ts; we re-snapshot when the tab regains focus.
  let tokenSnapshot = $state<string>(getToken());

  function refreshTokenSnapshot() {
    tokenSnapshot = getToken();
  }

  onMount(() => {
    const onFocus = () => refreshTokenSnapshot();
    window.addEventListener('focus', onFocus);
    // Backend-connected default-filters row — failures surface inline
    // (404 -> backend does not support media config yet; non-fatal).
    void loadMediaCfg();
    // v0.1.1 retention. 503 = backend without StorageCoord; surface
    // the controls as disabled with a helpful hint.
    void loadRetentionCfg();
    return () => window.removeEventListener('focus', onFocus);
  });

  // Mask as sk-XXX...XX9N shape — first 6 + last 4 with an
  // ellipsis. Tokens shorter than 12 chars (would-be edge case) render
  // in full.
  const maskedToken = $derived.by<string>(() => {
    const tok = tokenSnapshot;
    if (!tok) return t('settings.adminTokenNotSet');
    if (tok.length <= 12) return tok;
    return tok.slice(0, 6) + '…' + tok.slice(-4);
  });

  function openAuthModal() {
    onOpenAuthModal();
    // Modal close is async; the focus listener re-snapshots on
    // focus regain so the masked display picks up the new value.
  }

  function clearToken() {
    setToken('');
    refreshTokenSnapshot();
  }

  // ---------- ABOUT ----------
  //
  // VIEWER_VERSION is hardcoded — there's no vite define for it and
  // package.json isn't readable at runtime. Bump in sync with
  // package.json's "version" field when cutting a release.
  const VIEWER_VERSION = '0.1.2';
  const HEALTHZ_URL = api('healthz');
</script>

<div class="settings">
  <div class="page-container page-container--narrow">
  <!-- 1. DISPLAY -->
  <section class="card">
    <header class="card-head">
      <h3>{t('settings.display')}</h3>
      <p class="sub">{t('settings.theme')} · {t('settings.language')}</p>
    </header>

    <div class="rows">
      <div class="settings-row">
        <label for="settings-theme-toggle" class="settings-row-label">{t('settings.theme')}</label>
        <div class="settings-row-helper"></div>
        <div class="settings-row-control">
          <button
            id="settings-theme-toggle"
            type="button"
            role="switch"
            aria-checked={getTheme() === 'light'}
            class="switch"
            class:on={getTheme() === 'light'}
            onclick={toggleThemeRow}
            title={t('ui.themeToggle')}
          >
            <span class="knob"></span>
          </button>
        </div>
      </div>

      <div class="settings-row">
        <label for="settings-lang-toggle" class="settings-row-label">{t('settings.language')}</label>
        <div class="settings-row-helper"></div>
        <div class="settings-row-control">
          <button
            id="settings-lang-toggle"
            type="button"
            role="switch"
            aria-checked={getLang() === 'zh'}
            class="switch"
            class:on={getLang() === 'zh'}
            onclick={toggleLangRow}
            title={t('ui.langToggle')}
          >
            <span class="knob"></span>
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- 2. DEFAULT FILTERS -->
  <section class="card">
    <header class="card-head">
      <h3>{t('settings.defaultFilters')}</h3>
      <p class="sub">{t('settings.defaultPathNote')}</p>
    </header>

    <div class="rows">
      <div class="settings-row">
        <label for="settings-default-path" class="settings-row-label">{t('settings.defaultPath')}</label>
        <div class="settings-row-helper">{t('settings.defaultPathNote')}</div>
        <div class="settings-row-control path-control">
          <input
            id="settings-default-path"
            type="text"
            bind:value={pathValue}
            onblur={persistPath}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            placeholder="/v1/*"
            spellcheck="false"
            autocomplete="off"
          />
          <button type="button" class="btn" onclick={persistPath}>{t('settings.save')}</button>
          <span class="hint" class:show={pathHintVisible}>{t('ui.saved')}</span>
        </div>
      </div>

      <div class="settings-row">
        <label for="settings-refresh" class="settings-row-label">{t('settings.tracesAutoRefresh')}</label>
        <div class="settings-row-helper">{t('settings.tracesAutoRefreshNote')}</div>
        <div class="settings-row-control">
          <select id="settings-refresh" value={refreshOpt} onchange={onRefreshChange}>
            {#each REFRESH_OPTIONS as opt (opt)}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="settings-row">
        <label for="settings-media-toggle" class="settings-row-label">{t('settings.saveAttachments')}</label>
        <div class="settings-row-helper">{t('settings.saveAttachmentsNote')}</div>
        <div class="settings-row-control">
          {#if mediaCfg.kind === 'loading' || mediaCfg.kind === 'idle'}
            <span class="dim">{t('ui.loading')}</span>
          {:else if mediaCfg.kind === 'error'}
            <span class="dim">{t('settings.saveAttachmentsUnavailable', { message: mediaCfg.message })}</span>
          {:else}
            <button
              id="settings-media-toggle"
              type="button"
              role="switch"
              aria-checked={mediaCfg.value}
              aria-label={t('settings.saveAttachments')}
              class="switch"
              class:on={mediaCfg.value}
              onclick={onMediaToggle}
            >
              <span class="knob"></span>
            </button>
            <span class="mono dim source">{t('settings.saveAttachmentsSource', { source: mediaCfg.source })}</span>
            <span class="hint" class:show={mediaHintVisible}>{t('ui.saved')}</span>
          {/if}
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-row-label">{t('settings.reset')}</span>
        <div class="settings-row-helper">{t('settings.resetNote')}</div>
        <div class="settings-row-control">
          <button type="button" class="btn" onclick={resetDefaults}>{t('settings.resetButton')}</button>
        </div>
      </div>
    </div>
  </section>

  <!-- 3. STORAGE (retention; v0.1.1+) -->
  <section class="card">
    <header class="card-head">
      <h3>{t('settings.storage')}</h3>
      <p class="sub">{t('settings.storageNote')}</p>
    </header>

    <div class="rows">
      {#if retentionCfg.kind === 'loading' || retentionCfg.kind === 'idle'}
        <div class="settings-row">
          <span class="settings-row-label">{t('settings.retentionLoading')}</span>
          <div class="settings-row-helper"></div>
          <div class="settings-row-control"></div>
        </div>
      {:else if retentionCfg.kind === 'unavailable'}
        <div class="settings-row">
          <span class="settings-row-label">{t('settings.retentionUnavailable')}</span>
          <div class="settings-row-helper">{t('settings.retentionUnavailableNote')}</div>
          <div class="settings-row-control"></div>
        </div>
      {:else if retentionCfg.kind === 'error'}
        <div class="settings-row">
          <span class="settings-row-label">{t('settings.retentionLoadError')}</span>
          <div class="settings-row-helper">{retentionCfg.message}</div>
          <div class="settings-row-control">
            <button type="button" class="btn" onclick={() => loadRetentionCfg()}>{t('settings.retry')}</button>
          </div>
        </div>
      {:else}
        {#if retentionIsDisabled}
          <div class="settings-row">
            <span class="settings-row-label">{t('settings.retentionStatus')}</span>
            <div class="settings-row-helper">{t('settings.retentionDisabledNote')}</div>
            <div class="settings-row-control">
              <span class="mono dim">{t('settings.retentionDisabled')}</span>
            </div>
          </div>
        {/if}

        <div class="settings-row">
          <label for="settings-retention-max-bytes" class="settings-row-label">{t('settings.retentionMaxBytes')}</label>
          <div class="settings-row-helper">{t('settings.retentionMaxBytesNote')}</div>
          <div class="settings-row-control">
            <input
              id="settings-retention-max-bytes"
              type="number"
              min="0"
              step="1"
              class="settings-input"
              bind:value={retentionDraft.maxBytes} />
          </div>
        </div>

        <div class="settings-row">
          <label for="settings-retention-max-age" class="settings-row-label">{t('settings.retentionMaxAgeDays')}</label>
          <div class="settings-row-helper">{t('settings.retentionMaxAgeDaysNote')}</div>
          <div class="settings-row-control">
            <input
              id="settings-retention-max-age"
              type="number"
              min="0"
              step="1"
              class="settings-input"
              bind:value={retentionDraft.maxAgeDays} />
          </div>
        </div>

        <div class="settings-row">
          <label for="settings-retention-warn-at" class="settings-row-label">{t('settings.retentionWarnAt')}</label>
          <div class="settings-row-helper">{t('settings.retentionWarnAtNote')}</div>
          <div class="settings-row-control">
            <input
              id="settings-retention-warn-at"
              type="number"
              min="0"
              max="100"
              step="1"
              class="settings-input"
              bind:value={retentionDraft.warnAtPercent} />
          </div>
        </div>

        <div class="settings-row">
          <span class="settings-row-label">{t('settings.retentionSave')}</span>
          <div class="settings-row-helper">
            {#if retentionSaveError}
              <span class="settings-error">{retentionSaveError}</span>
            {:else if retentionHintVisible}
              <span class="dim">{t('settings.retentionSaved')}</span>
            {:else}
              <span class="mono dim source">{t('settings.retentionSource', { source: retentionCfg.source })}</span>
            {/if}
          </div>
          <div class="settings-row-control">
            <button type="button" class="btn" onclick={saveRetention} disabled={retentionSaving}>
              {retentionSaving ? t('settings.retentionSaving') : t('settings.retentionSaveButton')}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- 4. AUTH -->
  <section class="card">
    <header class="card-head">
      <h3>{t('settings.auth')}</h3>
      <p class="sub">{t('settings.changeTokenNote')}</p>
    </header>

    <div class="rows">
      <div class="settings-row">
        <span class="settings-row-label">{t('settings.adminToken')}</span>
        <div class="settings-row-helper"></div>
        <div class="settings-row-control token-control">
          <span class="mono token-mask">{maskedToken}</span>
          <button type="button" class="btn" onclick={openAuthModal}>{t('settings.changeTokenButton')}</button>
          {#if tokenSnapshot}
            <button type="button" class="btn" onclick={clearToken}>{t('filters.clear')}</button>
          {/if}
        </div>
      </div>
    </div>
  </section>

  <!-- 5. ABOUT -->
  <section class="card">
    <header class="card-head">
      <h3>{t('settings.about')}</h3>
      <p class="sub">{t('settings.aboutWhat')}</p>
    </header>

    <div class="rows">
      <div class="settings-row">
        <span class="settings-row-label">{t('settings.version')}</span>
        <div class="settings-row-helper"></div>
        <div class="settings-row-control">
          <span class="mono">{VIEWER_VERSION}</span>
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-row-label">{t('settings.backend')}</span>
        <div class="settings-row-helper"></div>
        <div class="settings-row-control">
          <a class="mono link" href={HEALTHZ_URL} target="_blank" rel="noopener noreferrer">{HEALTHZ_URL}</a>
        </div>
      </div>

    </div>
  </section>
  </div>
</div>

<style>
  /* Settings chrome: bordered cards, no shadow, canonical theme tokens.
     Each section uses --radius-lg = 8px and --space-6 padding. Title
     14px sans 600; subtitle 12px sans muted. Rows are a grid with
     hairline-separated borders. Toggle is a custom button with
     role="switch" — accent reserved for active state / selected row /
     focus ring only, so the toggle on-state uses var(--fg) for high
     contrast, never --accent. */

  .settings {
    padding: 0;
  }

  /* The flex column + gap rhythm lives on the page-container, not on
     .settings, because .page-container--narrow is the actual parent
     of the 4 cards. Without this rule, the cards would stack flush
     and the 1px hairline borders of adjacent cards would visually
     merge into a 2px line. */
  .settings :global(.page-container) {
    display: flex;
    flex-direction: column;
    gap: var(--space-section);  /* 32px between major cards */
  }

  /* ---------- card chrome ---------- */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
  }
  .card-head {
    margin: 0 0 var(--space-4);
  }
  .card-head h3 {
    margin: 0;
    padding: 0;
    font-family: var(--font-sans);
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
    background: transparent;
    border: 0;
    letter-spacing: 0;
    text-transform: none;
    line-height: 1.4;
  }
  .card-head .sub {
    margin: 4px 0 0;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--fg-muted);
    line-height: 1.5;
  }

  /* ---------- rows ----------
     3-column grid:
       col 1: label, capped at content width with 160px floor so short
              labels still line up across rows
       col 2: optional helper text (or empty spacer), takes the slack
       col 3: control, right-justified
     Controls stay close enough to labels to remain scannable on wide screens. */
  .rows {
    display: flex;
    flex-direction: column;
  }
  .settings-row {
    display: grid;
    grid-template-columns: minmax(160px, max-content) 1fr auto;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }
  .settings-row:last-child {
    border-bottom: 0;
  }
  .settings-row-label {
    font-family: var(--font-sans);
    font-size: var(--size-input);
    color: var(--fg);
    line-height: 1.4;
  }
  .settings-row-helper {
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-muted);
    line-height: 1.5;
    min-width: 0;
  }
  .settings-row-control {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    justify-self: end;
    min-width: 0;
  }
  .path-control {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .path-control input {
    width: 220px;
  }
  .token-control {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .token-mask {
    color: var(--fg-muted);
    font-size: 13px;
  }

  /* ---------- form controls ---------- */
  .settings-row-control input[type="text"],
  .settings-row-control input[type="number"],
  .settings-row-control select {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.4;
    outline: none;
    box-shadow: none;
    transition: border-color 150ms ease;
  }
  .settings-row-control input[type="text"]:focus,
  .settings-row-control input[type="number"]:focus,
  .settings-row-control select:focus {
    border-color: var(--accent);
  }
  .settings-input {
    width: 200px;
  }
  .settings-error {
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* Outline buttons — same shape as FilterSidebar Apply. */
  .btn {
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 6px 12px;
    font-family: var(--font-sans);
    font-size: 13px;
    cursor: pointer;
    box-shadow: none;
    transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
  }
  .btn:hover {
    background: var(--surface-elevated);
    color: var(--fg);
    border-color: var(--fg);
  }

  /* ---------- toggle switch ----------
     36 x 20 track, round knob. Off → surface-elevated track + bg knob.
     On → var(--fg) track + var(--bg) knob (high contrast, NOT accent).
     150ms transition matches the rest of the page. */
  .switch {
    appearance: none;
    -webkit-appearance: none;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--surface-elevated);
    border: 1px solid var(--border);
    position: relative;
    cursor: pointer;
    padding: 0;
    margin: 0;
    flex: none;
    transition: background-color 150ms ease, border-color 150ms ease;
    display: inline-block;
  }
  .switch .knob {
    position: absolute;
    top: 50%;
    left: 1px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg);
    transform: translate(0, -50%);
    transition: transform 150ms ease, background-color 150ms ease;
    pointer-events: none;
  }
  .switch.on {
    background: var(--fg);
    border-color: var(--fg);
  }
  .switch.on .knob {
    transform: translate(16px, -50%);
    background: var(--bg);
  }
  .switch:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }

  /* ---------- atoms ---------- */
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .dim { color: var(--fg-dim); font-family: var(--font-sans); font-size: 12px; }
  .source { margin-left: 4px; }

  .link {
    color: var(--fg-muted);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
    transition: color 150ms ease, border-color 150ms ease;
    word-break: break-all;
  }
  .link:hover {
    color: var(--fg);
    border-bottom-color: var(--fg-muted);
  }

  .hint {
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--accent);
    opacity: 0;
    transition: opacity 160ms ease-out;
  }
  .hint.show {
    opacity: 1;
  }
</style>
