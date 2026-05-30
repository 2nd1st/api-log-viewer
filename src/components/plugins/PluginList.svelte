<script lang="ts">
  // Plugin list — Settings card body for the plugin management surface.
  //
  // PHILOSOPHY (viewer/PHILOSOPHY.md):
  //   - Viewer is A frontend, not THE frontend. Plugin config lives in
  //     backend YAML; this surface is a typed editor for that YAML +
  //     a runtime-override layer. The source pill (yaml vs override)
  //     surfaces which side currently owns the value.
  //   - Single accent (--accent / teal-300) is reserved for active row /
  //     focus ring ONLY. The enabled-toggle on-state uses var(--fg) for
  //     high contrast, matching Settings.svelte's switch convention.
  //   - All visible strings go through t(); the dictionary is owned by
  //     Foundation A. Missing keys surface as the raw key string — that
  //     is intentional during the parallel-phase window.
  //   - No new dependencies — repeatable rule rows + JSON fallback are
  //     hand-rolled inside PluginEditModal. Schema is hardcoded per
  //     plugin type, NOT derived from a JSON-Schema runtime.
  //
  // BACKEND API (v0.1, all under /api/config/plugins, admin-token gated):
  //   GET    /api/config/plugins         → { instances, source }
  //   PUT    /api/config/plugins         body { instances: [...] }
  //                                      → full replace, returns ok+errors
  //   PUT    /api/config/plugins/{id}    body { enabled?, config? }
  //                                      → patch one instance
  //   DELETE /api/config/plugins         → revert override, source: yaml
  //   GET    /api/plugins/types          → registered types + descriptions
  //
  // HOT-RELOAD (W4.2 backend, 2026-05-31): PUT / PATCH / DELETE on
  // /api/config/plugins swap the live registry atomically. No restart
  // required; mutations take effect on the next request that flows
  // through the proxy.

  import { onMount } from 'svelte';
  import {
    listTypes,
    listInstances,
    replaceAll,
    patchInstance,
    deleteAll,
    PluginAPIError,
    type PluginType,
    type PluginInstance,
    type AuthFetch,
  } from '../../lib/plugins';
  import { t } from '../../lib/i18n.svelte';
  import PluginEditModal from './PluginEditModal.svelte';

  // formatPluginError turns whatever bubbled out of the plugin client
  // into a string the operator can read. PluginAPIError gets routed to
  // the backend-coded i18n key (`plugins.error.<error>`) with the
  // `detail` interpolated; unknown backend codes fall through to the
  // generic `plugins.error.unknown` template. Anything else (network,
  // unauthorized) keeps its native message — those already read well.
  function formatPluginError(e: unknown, fallbackKey: string): string {
    if (e instanceof PluginAPIError) {
      const codeKey = `plugins.error.${e.error}`;
      const detail = e.detail || e.message;
      const codeMsg = t(codeKey, { detail });
      // i18n.t() returns the raw key on miss — fall back to the
      // unknown template so the operator still sees the detail.
      if (codeMsg === codeKey) {
        return t('plugins.error.unknown', { detail: `${e.error}${detail ? ': ' + detail : ''}` });
      }
      return codeMsg;
    }
    const msg = (e as { message?: string })?.message;
    // Fallback templates may contain {message}/{detail} placeholders
    // (e.g. plugins.error.saveFailed). Pass empties so they render
    // clean rather than leaking literal '{message}' to the operator.
    return msg || t(fallbackKey, { message: '', detail: '' });
  }

  interface Props {
    authFetch: AuthFetch;
  }

  const { authFetch }: Props = $props();

  // ---------- state ----------
  //
  // Source-of-truth for the list lives in `instances`. Every mutation
  // path (toggle, edit save, delete, revert) re-syncs from the backend
  // response so the source pill stays accurate — flipping yaml↔override
  // is driven by the server, not local optimism.

  let instances = $state<PluginInstance[]>([]);
  let types = $state<PluginType[]>([]);
  let source = $state<string>('yaml');
  let loading = $state<boolean>(false);
  let error = $state<string>('');

  // Modal state. `adding` and `editing` are mutually exclusive — when
  // adding is true we pass null instance to the modal; when editing is
  // non-null we pass that instance. The modal handles both via its
  // `instance: PluginInstance | null` prop.
  let editing = $state<PluginInstance | null>(null);
  let adding = $state<boolean>(false);

  // ---------- loaders ----------

  async function loadAll() {
    loading = true;
    error = '';
    try {
      const [tRes, iRes] = await Promise.all([
        listTypes(authFetch),
        listInstances(authFetch),
      ]);
      types = tRes;
      instances = iRes.instances;
      source = iRes.source;
    } catch (e: unknown) {
      error = formatPluginError(e, 'plugins.error.unknown');
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadAll();
  });

  // ---------- row actions ----------

  async function toggleEnabled(inst: PluginInstance) {
    const next = !inst.enabled;
    // Optimistic flip — revert on backend failure. Source pill may
    // legitimately flip to "override" on this call (first mutation
    // against a yaml-only config), so we re-read it from the response.
    const prevInstances = instances;
    const prevSource = source;
    instances = instances.map((i) =>
      i.id === inst.id ? { ...i, enabled: next } : i
    );
    try {
      const res = await patchInstance(authFetch, inst.id, { enabled: next });
      if (!res.ok || !res.instance) throw new Error(t('plugins.error.patchFailed'));
      const updated = res.instance;
      // Re-sync the one row from the canonical response.
      instances = instances.map((i) =>
        i.id === inst.id ? updated : i
      );
      // PATCH responses don't carry source — assume any mutation flips
      // us into override mode if we weren't already there.
      if (source === 'yaml') source = 'override';
    } catch (e: unknown) {
      instances = prevInstances;
      source = prevSource;
      error = formatPluginError(e, 'plugins.error.patchFailed');
    }
  }

  async function deleteOne(inst: PluginInstance) {
    // Inline confirm via window.confirm — the operator volume here is
    // low (handful of plugins) so a richer dialog would be overkill.
    const ok = window.confirm(
      t('plugins.action.confirmDelete') + '\n\n' + inst.id
    );
    if (!ok) return;
    const next = instances.filter((i) => i.id !== inst.id);
    try {
      const res = await replaceAll(authFetch, next);
      if (!res.ok || !res.instances) {
        const msg = res.errors && res.errors.length > 0
          ? res.errors.join(', ')
          : t('plugins.error.deleteFailed');
        throw new Error(msg);
      }
      instances = res.instances;
      source = 'override';
    } catch (e: unknown) {
      error = formatPluginError(e, 'plugins.error.deleteFailed');
    }
  }

  async function revertToYaml() {
    const ok = window.confirm(t('plugins.action.confirmRevert'));
    if (!ok) return;
    try {
      const res = await deleteAll(authFetch);
      if (!res.ok) throw new Error(t('plugins.error.revertFailed'));
      // Re-fetch — DELETE returns ok+source but not the instance list.
      await loadAll();
    } catch (e: unknown) {
      error = formatPluginError(e, 'plugins.error.revertFailed');
    }
  }

  // ---------- modal callbacks ----------

  function openAdd() {
    adding = true;
    editing = null;
  }

  function openEdit(inst: PluginInstance) {
    editing = inst;
    adding = false;
  }

  function closeModal() {
    editing = null;
    adding = false;
  }

  function onModalSaved(_next: PluginInstance) {
    // Modal already issued the PUT / PATCH. We refresh from backend to
    // pick up the canonical instance list AND the (possibly flipped)
    // source pill in one round-trip.
    closeModal();
    void loadAll();
  }

  // ---------- derived ----------

  const showRevertButton = $derived(source === 'override');
  const modalOpen = $derived(adding || editing !== null);
</script>

<section class="card">
  <header class="card-head">
    <div class="card-head-row">
      <div class="card-head-text">
        <h3>{t('settings.plugins.sectionTitle')}</h3>
        <p class="sub">{t('settings.plugins.sectionHelper')}</p>
      </div>
      <div class="card-head-actions">
        <span class="source-pill" title={t('settings.plugins.sourcePillTitle')}>
          {source}
        </span>
        <button type="button" class="btn" onclick={openAdd}>
          {t('plugins.action.add')}
        </button>
      </div>
    </div>
  </header>


  {#if error}
    <div class="error-banner" role="alert">
      {error}
    </div>
  {/if}

  <div class="plugin-list">
    {#if loading && instances.length === 0}
      <div class="empty"><span class="dim">{t('ui.loading')}</span></div>
    {:else if instances.length === 0}
      <div class="empty"><span class="dim">{t('settings.plugins.emptyState')}</span></div>
    {:else}
      {#each instances as inst (inst.id)}
        <div class="plugin-list-row">
          <span class="plugin-type-badge" title={inst.type}>{inst.type}</span>
          <span class="plugin-id mono">{inst.id}</span>
          <div class="plugin-row-actions">
            <button
              type="button"
              role="switch"
              aria-checked={inst.enabled}
              aria-label={t('plugins.field.enabled')}
              class="switch"
              class:on={inst.enabled}
              onclick={() => toggleEnabled(inst)}
            >
              <span class="knob"></span>
            </button>
            <button type="button" class="btn small" onclick={() => openEdit(inst)}>
              {t('plugins.action.edit')}
            </button>
            <button type="button" class="btn small danger" onclick={() => deleteOne(inst)}>
              {t('plugins.action.delete')}
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if showRevertButton}
    <div class="card-footer">
      <button type="button" class="btn small" onclick={revertToYaml}>
        {t('plugins.action.revertToYaml')}
      </button>
    </div>
  {/if}
</section>

{#if modalOpen}
  <PluginEditModal
    instance={editing}
    {types}
    {authFetch}
    currentInstances={instances}
    onClose={closeModal}
    onSaved={onModalSaved}
  />
{/if}

<style>
  /* Plugin list — re-uses the .card / .btn / .switch chrome conventions
     from Settings.svelte. New plugin-specific classes prefixed
     .plugin-* so the cascade stays predictable. */

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
  }
  .card-head {
    margin: 0 0 var(--space-4);
  }
  .card-head-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .card-head-text {
    min-width: 0;
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
    line-height: 1.4;
  }
  .card-head .sub {
    margin: 4px 0 0;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--fg-muted);
    line-height: 1.5;
  }
  .card-head-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  /* Source pill — yaml vs override. Muted by default; we don't ramp it
     visually because "override" is not an alarm state, just info. */
  .source-pill {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    background: var(--surface-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 2px 8px;
    line-height: 1.5;
  }

  .error-banner {
    background: var(--surface-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--fg);
    line-height: 1.5;
    margin-bottom: var(--space-3);
  }

  /* ---------- list ---------- */
  .plugin-list {
    display: flex;
    flex-direction: column;
  }
  .empty {
    padding: var(--space-4) 0;
    text-align: center;
  }
  .plugin-list-row {
    display: grid;
    grid-template-columns: max-content 1fr auto;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }
  .plugin-list-row:last-child {
    border-bottom: 0;
  }
  .plugin-type-badge {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 2px 6px;
    line-height: 1.5;
    white-space: nowrap;
  }
  .plugin-id {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--fg);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plugin-row-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .card-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  /* ---------- buttons (same shape as Settings.svelte .btn) ---------- */
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
  .btn.small {
    padding: 4px 8px;
    font-size: 12px;
  }
  .btn.danger:hover {
    color: var(--fg);
    border-color: var(--fg);
  }

  /* ---------- toggle switch (mirrors Settings.svelte) ---------- */
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

  .mono { font-family: var(--font-mono); font-size: 12px; }
  .dim { color: var(--fg-dim); font-family: var(--font-sans); font-size: 12px; }
</style>
