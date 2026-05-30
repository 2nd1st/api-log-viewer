<script lang="ts">
  // Plugin edit modal — add or edit one PluginInstance.
  //
  // PHILOSOPHY (viewer/PHILOSOPHY.md):
  //   - The hardcoded form shapes for text-replace and text-append live
  //     in the viewer, NOT in a backend schema. v0.1 backend ships a
  //     minimal ConfigSchema ({fields: null}); the viewer is expected
  //     to know its first-party types and degrade to JSON-textarea for
  //     anything else. This is the explicit boundary between "viewer
  //     knows the operator's daily plugins" and "viewer is generic
  //     enough to talk to any backend".
  //   - No new dependencies — repeatable rule rows are a plain $state
  //     array; the JSON-fallback uses JSON.parse + try/catch at save.
  //   - Modal chrome (.modal-bg + .modal panel) mirrors AuthModal so the
  //     visual rhyme across the app stays tight.
  //
  // CONFIG SHAPES (per type — Foundation B contract):
  //   text-replace:
  //     { routes: string[], up?: {match, replace}[], down?: {match, replace}[] }
  //   text-append:
  //     { routes: string[],
  //       up?:   { suffix: string, target: 'last_user_message' | 'system_prompt' },
  //       down?: { suffix: string, target: 'content' | 'reasoning' },
  //       probability?: number | null }      (null = always fire)
  //   <unknown>:
  //     opaque JSON object, edited as raw text.
  //
  // SAVE SEMANTICS:
  //   - NEW mode: replaceAll([...currentInstances, next]).
  //   - EDIT mode: patchInstance(id, { enabled, config }). Type and id
  //     are immutable post-create — those inputs are disabled.

  import {
    replaceAll,
    patchInstance,
    PluginAPIError,
    type PluginType,
    type PluginInstance,
    type AuthFetch,
  } from '../../lib/plugins';
  import { t } from '../../lib/i18n.svelte';

  // formatPluginError mirrors the helper in PluginList.svelte. Kept
  // local because the modal mounts/unmounts per open and pulling a
  // shared module just for this one helper would add a `lib/` file
  // that exists only to dedupe ~15 lines. If a third caller appears,
  // hoist it then.
  function formatPluginError(e: unknown, fallbackKey: string): string {
    if (e instanceof PluginAPIError) {
      const codeKey = `plugins.error.${e.error}`;
      const detail = e.detail || e.message;
      const codeMsg = t(codeKey, { detail });
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
    instance: PluginInstance | null;
    types: PluginType[];
    authFetch: AuthFetch;
    currentInstances: PluginInstance[];
    onClose: () => void;
    onSaved: (next: PluginInstance) => void;
  }

  const {
    instance,
    types,
    authFetch,
    currentInstances,
    onClose,
    onSaved,
  }: Props = $props();

  // ---------- shape helpers ----------
  //
  // Each known type has a default-shaped config so "Add → pick type"
  // produces a usable, editable form on the first paint. The unknown
  // fallback is `{}`.

  type ReplaceRule = { match: string; replace: string };
  type AppendUp = { suffix: string; target: 'last_user_message' | 'system_prompt' };
  type AppendDown = { suffix: string; target: 'content' | 'reasoning' };

  function defaultConfig(type: string): Record<string, any> {
    switch (type) {
      case 'text-replace':
        return { routes: [], up: [], down: [] };
      case 'text-append':
        return {
          routes: [],
          up: { suffix: '', target: 'last_user_message' },
          down: { suffix: '', target: 'content' },
          probability: null,
        };
      default:
        return {};
    }
  }

  // ---------- mode / immutable inputs ----------
  //
  // The modal is mounted fresh by PluginList every time the user opens
  // Add or Edit (the {#if modalOpen} block unmounts between opens), so
  // we intentionally snapshot the incoming props at mount time. Svelte 5
  // warns about prop reads outside reactive scopes; the svelte-ignore
  // directives below are the documented escape hatch for this pattern.

  // svelte-ignore state_referenced_locally
  const isEdit = instance !== null;

  // Pick an initial type. In edit mode, lock to the existing instance's
  // type. In add mode, default to the first registered type — operators
  // pick from a populated dropdown rather than seeing an empty form.
  // svelte-ignore state_referenced_locally
  const initialType = instance
    ? instance.type
    : types.length > 0
      ? types[0].type
      : 'text-replace';

  // svelte-ignore state_referenced_locally
  let localType = $state<string>(initialType);
  // svelte-ignore state_referenced_locally
  let localId = $state<string>(instance ? instance.id : '');
  // svelte-ignore state_referenced_locally
  let localEnabled = $state<boolean>(instance ? instance.enabled : true);

  // ---------- config: text-replace ----------

  let trRoutes = $state<string>('');
  let trUp = $state<ReplaceRule[]>([]);
  let trDown = $state<ReplaceRule[]>([]);

  // ---------- config: text-append ----------

  let taRoutes = $state<string>('');
  let taUpSuffix = $state<string>('');
  let taUpTarget = $state<'last_user_message' | 'system_prompt'>('last_user_message');
  let taDownSuffix = $state<string>('');
  let taDownTarget = $state<'content' | 'reasoning'>('content');
  let taProbability = $state<number>(1);
  let taAlways = $state<boolean>(true);

  // ---------- config: unknown / JSON fallback ----------

  let jsonText = $state<string>('{}');

  // ---------- error + saving state ----------

  let error = $state<string>('');
  let saving = $state<boolean>(false);

  // ---------- initial population ----------
  //
  // Seed all three form-shape buckets from the incoming instance (or
  // from defaults). We populate all of them up front rather than
  // lazily because the user might toggle the type dropdown in add
  // mode and we want a clean reset path that doesn't carry over stale
  // values from a different type's bucket.

  function seedFromConfig(type: string, cfg: Record<string, any>) {
    // text-replace bucket
    const trCfg = type === 'text-replace' ? cfg : defaultConfig('text-replace');
    trRoutes = (trCfg.routes as string[] | undefined)?.join(', ') ?? '';
    trUp = ((trCfg.up as ReplaceRule[] | undefined) ?? []).map((r) => ({
      match: r.match ?? '',
      replace: r.replace ?? '',
    }));
    trDown = ((trCfg.down as ReplaceRule[] | undefined) ?? []).map((r) => ({
      match: r.match ?? '',
      replace: r.replace ?? '',
    }));

    // text-append bucket
    const taCfg = type === 'text-append' ? cfg : defaultConfig('text-append');
    taRoutes = (taCfg.routes as string[] | undefined)?.join(', ') ?? '';
    const up = taCfg.up as AppendUp | undefined;
    taUpSuffix = up?.suffix ?? '';
    taUpTarget = up?.target ?? 'last_user_message';
    const down = taCfg.down as AppendDown | undefined;
    taDownSuffix = down?.suffix ?? '';
    taDownTarget = down?.target ?? 'content';
    const prob = taCfg.probability;
    if (prob === null || prob === undefined) {
      taAlways = true;
      taProbability = 1;
    } else {
      taAlways = false;
      taProbability = typeof prob === 'number' ? prob : 1;
    }

    // unknown / JSON bucket — always hold the original config so the
    // operator can fall back to raw editing even on a known type, and
    // unknown-type-only instances get round-tripped untouched.
    try {
      jsonText = JSON.stringify(cfg, null, 2);
    } catch {
      jsonText = '{}';
    }
  }

  // Seed once at mount — Svelte 5 $effect with the imported instance
  // reference would re-run on every prop write, which we don't want.
  // The modal is mounted fresh per open by the parent.
  // svelte-ignore state_referenced_locally
  seedFromConfig(localType, instance ? instance.config : defaultConfig(localType));

  // ---------- type-change reset (add mode only) ----------
  //
  // When the operator picks a different type in add mode, blow away
  // the form with that type's defaults. In edit mode the type
  // dropdown is disabled so this never fires.

  function onTypeChange(e: Event) {
    if (isEdit) return;
    const next = (e.currentTarget as HTMLSelectElement).value;
    localType = next;
    seedFromConfig(next, defaultConfig(next));
  }

  // ---------- repeatable rule editor ----------

  function addRule(list: 'up' | 'down') {
    const empty: ReplaceRule = { match: '', replace: '' };
    if (list === 'up') trUp = [...trUp, empty];
    else trDown = [...trDown, empty];
  }
  function removeRule(list: 'up' | 'down', idx: number) {
    if (list === 'up') trUp = trUp.filter((_, i) => i !== idx);
    else trDown = trDown.filter((_, i) => i !== idx);
  }

  // ---------- helpers ----------

  function parseRoutes(csv: string): string[] {
    return csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ---------- save ----------
  //
  // Build the next instance from the active form bucket, validate
  // (id non-empty + unique; JSON parses on unknown types), then call
  // the appropriate API. We do NOT try to lock the modal during the
  // network call — operators see `saving` disable the save button
  // and that's enough; closing mid-flight is harmless because the
  // parent re-fetches on success.

  function buildConfig(): Record<string, any> | null {
    if (localType === 'text-replace') {
      const cfg: Record<string, any> = {
        routes: parseRoutes(trRoutes),
      };
      if (trUp.length > 0) cfg.up = trUp;
      if (trDown.length > 0) cfg.down = trDown;
      return cfg;
    }
    if (localType === 'text-append') {
      const cfg: Record<string, any> = {
        routes: parseRoutes(taRoutes),
      };
      if (taUpSuffix.trim().length > 0) {
        cfg.up = { suffix: taUpSuffix, target: taUpTarget };
      }
      if (taDownSuffix.trim().length > 0) {
        cfg.down = { suffix: taDownSuffix, target: taDownTarget };
      }
      cfg.probability = taAlways ? null : taProbability;
      return cfg;
    }
    // Unknown type — JSON textarea is canonical.
    try {
      const parsed = JSON.parse(jsonText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        error = t('plugins.error.invalidJsonShape');
        return null;
      }
      return parsed as Record<string, any>;
    } catch (e: any) {
      error = t('plugins.error.invalidJson') + ': ' + (e?.message ?? String(e));
      return null;
    }
  }

  function validateMeta(): boolean {
    if (!isEdit) {
      const id = localId.trim();
      if (id.length === 0) {
        error = t('plugins.error.idRequired');
        return false;
      }
      if (currentInstances.some((i) => i.id === id)) {
        error = t('plugins.error.idDuplicate');
        return false;
      }
    }
    return true;
  }

  async function save() {
    error = '';
    if (!validateMeta()) return;
    const cfg = buildConfig();
    if (cfg === null) return;

    saving = true;
    try {
      if (isEdit && instance) {
        const res = await patchInstance(authFetch, instance.id, {
          enabled: localEnabled,
          config: cfg,
        });
        if (!res.ok || !res.instance) throw new Error(t('plugins.error.patchFailed'));
        onSaved(res.instance);
      } else {
        const next: PluginInstance = {
          type: localType,
          id: localId.trim(),
          enabled: localEnabled,
          config: cfg,
        };
        const res = await replaceAll(authFetch, [...currentInstances, next]);
        if (!res.ok) {
          const msg = res.errors && res.errors.length > 0
            ? res.errors.join(', ')
            : t('plugins.error.saveFailed', { message: '' });
          throw new Error(msg);
        }
        // replaceAll returns the full list; find our newly-added row
        // so the parent can refresh from it (it doesn't actually use
        // the returned value beyond signalling — but we honor the
        // typed contract).
        const added = res.instances?.find((i) => i.id === next.id) ?? next;
        onSaved(added);
      }
    } catch (e: unknown) {
      error = formatPluginError(
        e,
        isEdit ? 'plugins.error.patchFailed' : 'plugins.error.saveFailed',
      );
    } finally {
      saving = false;
    }
  }

  function cancel() {
    onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="modal-bg show" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="plugin-modal-title">
    <header class="modal-head">
      <h2 id="plugin-modal-title">
        {isEdit ? t('plugins.action.edit') : t('plugins.action.add')}
      </h2>
      <button type="button" class="close" aria-label={t('ui.cancel')} onclick={cancel}>×</button>
    </header>

    <div class="modal-body">
      <!-- type -->
      <div class="form-row">
        <label class="form-label" for="plugin-type">{t('plugins.field.type')}</label>
        <select
          id="plugin-type"
          value={localType}
          onchange={onTypeChange}
          disabled={isEdit}
        >
          {#each types as ty (ty.type)}
            <option value={ty.type}>{ty.type}</option>
          {/each}
          <!-- If editing an instance whose type is no longer registered,
               keep it visible so the operator can still patch it. -->
          {#if isEdit && !types.some((ty) => ty.type === localType)}
            <option value={localType}>{localType}</option>
          {/if}
        </select>
      </div>

      <!-- id -->
      <div class="form-row">
        <label class="form-label" for="plugin-id">{t('plugins.field.id')}</label>
        <input
          id="plugin-id"
          type="text"
          bind:value={localId}
          disabled={isEdit}
          spellcheck="false"
          autocomplete="off"
          placeholder={t('plugins.field.idPlaceholder')}
        />
      </div>

      <!-- enabled -->
      <div class="form-row form-row-inline">
        <span id="plugin-enabled-label" class="form-label">{t('plugins.field.enabled')}</span>
        <button
          id="plugin-enabled"
          type="button"
          role="switch"
          aria-checked={localEnabled}
          aria-labelledby="plugin-enabled-label"
          class="switch"
          class:on={localEnabled}
          onclick={() => (localEnabled = !localEnabled)}
        >
          <span class="knob"></span>
        </button>
      </div>

      <!-- config form, switched by type -->
      <div class="config-section">
        <div class="config-section-title">{t('plugins.field.config')}</div>

        {#if localType === 'text-replace'}
          <div class="form-row">
            <label class="form-label" for="tr-routes">{t('plugins.field.routes')}</label>
            <input
              id="tr-routes"
              type="text"
              bind:value={trRoutes}
              spellcheck="false"
              autocomplete="off"
              placeholder={t('plugins.field.routesPlaceholder')}
            />
          </div>

          <div class="rule-block">
            <div class="rule-block-head">
              <span class="rule-block-title">{t('plugins.field.upRules')}</span>
              <button type="button" class="btn small" onclick={() => addRule('up')}>
                + {t('plugins.action.addRule')}
              </button>
            </div>
            {#if trUp.length === 0}
              <div class="rule-empty"><span class="dim">{t('plugins.field.noRules')}</span></div>
            {:else}
              {#each trUp as rule, idx (idx)}
                <div class="rule-row">
                  <input
                    type="text"
                    bind:value={rule.match}
                    placeholder={t('plugins.field.match')}
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <input
                    type="text"
                    bind:value={rule.replace}
                    placeholder={t('plugins.field.replace')}
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <button
                    type="button"
                    class="btn small"
                    aria-label={t('plugins.action.removeRule')}
                    onclick={() => removeRule('up', idx)}
                  >×</button>
                </div>
              {/each}
            {/if}
          </div>

          <div class="rule-block">
            <div class="rule-block-head">
              <span class="rule-block-title">{t('plugins.field.downRules')}</span>
              <button type="button" class="btn small" onclick={() => addRule('down')}>
                + {t('plugins.action.addRule')}
              </button>
            </div>
            {#if trDown.length === 0}
              <div class="rule-empty"><span class="dim">{t('plugins.field.noRules')}</span></div>
            {:else}
              {#each trDown as rule, idx (idx)}
                <div class="rule-row">
                  <input
                    type="text"
                    bind:value={rule.match}
                    placeholder={t('plugins.field.match')}
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <input
                    type="text"
                    bind:value={rule.replace}
                    placeholder={t('plugins.field.replace')}
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <button
                    type="button"
                    class="btn small"
                    aria-label={t('plugins.action.removeRule')}
                    onclick={() => removeRule('down', idx)}
                  >×</button>
                </div>
              {/each}
            {/if}
          </div>
        {:else if localType === 'text-append'}
          <div class="form-row">
            <label class="form-label" for="ta-routes">{t('plugins.field.routes')}</label>
            <input
              id="ta-routes"
              type="text"
              bind:value={taRoutes}
              spellcheck="false"
              autocomplete="off"
              placeholder={t('plugins.field.routesPlaceholder')}
            />
          </div>

          <div class="rule-block">
            <div class="rule-block-head">
              <span class="rule-block-title">{t('plugins.field.up')}</span>
            </div>
            <div class="form-row">
              <label class="form-label" for="ta-up-suffix">{t('plugins.field.suffix')}</label>
              <textarea
                id="ta-up-suffix"
                rows="3"
                bind:value={taUpSuffix}
                spellcheck="false"
                placeholder={t('plugins.field.suffixPlaceholder')}
              ></textarea>
            </div>
            <div class="form-row">
              <label class="form-label" for="ta-up-target">{t('plugins.field.target')}</label>
              <select id="ta-up-target" bind:value={taUpTarget}>
                <option value="last_user_message">{t('plugins.target.last_user_message')}</option>
                <option value="system_prompt">{t('plugins.target.system_prompt')}</option>
              </select>
            </div>
          </div>

          <div class="rule-block">
            <div class="rule-block-head">
              <span class="rule-block-title">{t('plugins.field.down')}</span>
            </div>
            <div class="form-row">
              <label class="form-label" for="ta-down-suffix">{t('plugins.field.suffix')}</label>
              <textarea
                id="ta-down-suffix"
                rows="3"
                bind:value={taDownSuffix}
                spellcheck="false"
                placeholder={t('plugins.field.suffixPlaceholder')}
              ></textarea>
            </div>
            <div class="form-row">
              <label class="form-label" for="ta-down-target">{t('plugins.field.target')}</label>
              <select id="ta-down-target" bind:value={taDownTarget}>
                <option value="content">{t('plugins.target.content')}</option>
                <option value="reasoning">{t('plugins.target.reasoning')}</option>
              </select>
            </div>
          </div>

          <div class="rule-block">
            <div class="rule-block-head">
              <span class="rule-block-title">{t('plugins.field.probability')}</span>
            </div>
            <div class="form-row form-row-inline">
              <label class="form-label" for="ta-always">{t('plugins.field.alwaysFire')}</label>
              <input
                id="ta-always"
                type="checkbox"
                bind:checked={taAlways}
              />
            </div>
            {#if !taAlways}
              <div class="form-row">
                <label class="form-label" for="ta-prob">{t('plugins.field.probabilityValue')}</label>
                <div class="slider-row">
                  <input
                    id="ta-prob"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    bind:value={taProbability}
                  />
                  <span class="mono prob-value">{taProbability.toFixed(2)}</span>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <!-- unknown type — raw JSON fallback -->
          <div class="form-row">
            <label class="form-label" for="json-fallback">{t('plugins.field.rawJson')}</label>
            <textarea
              id="json-fallback"
              class="json-textarea"
              rows="12"
              bind:value={jsonText}
              spellcheck="false"
            ></textarea>
          </div>
        {/if}
      </div>

      {#if error}
        <div class="error-row" role="alert">{error}</div>
      {/if}
    </div>

    <footer class="modal-foot">
      <button type="button" class="btn" onclick={cancel}>{t('ui.cancel')}</button>
      <button type="button" class="btn primary" onclick={save} disabled={saving}>
        {saving ? t('ui.loading') : t('ui.save')}
      </button>
    </footer>
  </div>
</div>

<style>
  /* Modal chrome — mirrors AuthModal so the visual rhyme stays tight.
     Sized comfortably (560px) for the repeatable rule editors; body
     scrolls when the form runs long. */

  .modal-bg {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal-bg.show {
    display: flex;
  }

  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: 560px;
    max-width: 92vw;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    box-shadow: none;
  }

  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-6);
    border-bottom: 1px solid var(--border);
  }
  .modal-head h2 {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--size-input);
    color: var(--fg);
    font-weight: 600;
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--fg-muted);
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    padding: 0 var(--space-1);
    transition: color 150ms ease;
  }
  .close:hover {
    color: var(--fg);
  }

  .modal-body {
    padding: var(--space-4) var(--space-6);
    overflow-y: auto;
    flex: 1 1 auto;
  }

  .modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-6);
    border-top: 1px solid var(--border);
  }

  /* ---------- form rows ---------- */
  .form-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }
  .form-row-inline {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }
  .form-label {
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--fg-muted);
    line-height: 1.4;
  }
  .form-row input[type="text"],
  .form-row select,
  .form-row textarea {
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
    width: 100%;
    box-sizing: border-box;
  }
  .form-row textarea {
    resize: vertical;
    min-height: 60px;
  }
  .form-row input[type="text"]:focus,
  .form-row select:focus,
  .form-row textarea:focus {
    border-color: var(--accent);
  }
  .form-row input:disabled,
  .form-row select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* ---------- config section ---------- */
  .config-section {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .config-section-title {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: var(--space-3);
  }

  /* ---------- repeatable rule blocks ---------- */
  .rule-block {
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .rule-block:last-child {
    border-bottom: 0;
    margin-bottom: 0;
  }
  .rule-block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .rule-block-title {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
  }
  .rule-empty {
    padding: var(--space-2) 0;
    text-align: center;
  }
  .rule-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    align-items: center;
  }
  .rule-row input[type="text"] {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    outline: none;
    box-shadow: none;
    transition: border-color 150ms ease;
    width: 100%;
    box-sizing: border-box;
  }
  .rule-row input[type="text"]:focus {
    border-color: var(--accent);
  }

  /* ---------- slider ---------- */
  .slider-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .slider-row input[type="range"] {
    flex: 1;
  }
  .prob-value {
    color: var(--fg-muted);
    min-width: 36px;
    text-align: right;
  }

  .json-textarea {
    min-height: 220px;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* ---------- error ---------- */
  .error-row {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--fg);
    line-height: 1.5;
  }

  /* ---------- buttons ---------- */
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
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.small {
    padding: 4px 8px;
    font-size: 12px;
  }
  .btn.primary {
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
