<script lang="ts">
  // Filter sidebar — status / path / model / key_hash / session_root_id /
  // since / limit + Apply / Clear.
  //
  // Ported 1:1 from internal/viewer/static/index.html (the #filters <aside>
  // and its wiring in readFilters, refreshDatalist, and the f-apply /
  // f-clear click handlers). Behaviors preserved verbatim:
  //
  //   - exact filter parameter names (status, path, model, key_hash,
  //     session_root_id, since, limit) — these are sent on the wire to
  //     /api/traces and must match the original
  //   - exact UI strings ("status", "path", "model", "key_hash",
  //     "session_root_id", "since (ISO 8601)", "limit", "Apply", "Clear",
  //     "(end with * for prefix)", "any", "ULID", placeholders, etc.)
  //   - exact <select> option list for status (any / 2xx / 4xx / 5xx /
  //     200 / 401 / 403 / 404 / 429 / 500 / 502)
  //   - default path filter loaded from localStorage['apilog.default_path']
  //     with fallback '/v1/*' (via DEFAULT_PATH_FILTER from lib/api.ts)
  //   - trailing-* prefix convention preserved (just a value; backend
  //     does the prefix expansion). Empty box or "*" alone = no path
  //     filter, matching readFilters() in the original.
  //   - datalist autocomplete on path / model / key_hash, fed by the
  //     parent's accumulated Set<string> of seen values (knownPaths,
  //     knownModels, knownKeys in the original state object).
  //   - Apply button (and Enter in any input, and change on the status
  //     <select>) triggers loadList({ reset: true }). Clear resets the
  //     other fields, restores DEFAULT_PATH_FILTER in the path box, puts
  //     limit back to '100', then also triggers a reload.
  //
  // INVENTED prop signature (no shared types module exists):
  //   - values: bindable Filters object that owns the seven filter
  //     fields; parent reads it in its own readFilters() equivalent.
  //   - knownPaths / knownModels / knownKeys: Set<string> for datalist
  //     autocomplete suggestions. Parent populates these as it receives
  //     trace rows.
  //   - onApply: called when the user hits Apply / Enter / changes the
  //     status select. Parent does loadList({ reset: true }).
  //   - onClear: called after Clear resets the fields. Parent typically
  //     calls onApply equivalent (loadList({ reset: true })). Kept
  //     separate from onApply so the parent can distinguish if needed,
  //     matching the original's separate f-apply / f-clear handlers.

  import { DEFAULT_PATH_FILTER } from '../lib/api';
  import { t } from '../lib/i18n.svelte';

  export interface Filters {
    status: string;
    path: string;
    model: string;
    key_hash: string;
    session_root_id: string;
    since: string;
    limit: string;
  }

  interface Props {
    values: Filters;
    knownPaths?: Set<string>;
    knownModels?: Set<string>;
    knownKeys?: Set<string>;
    onApply?: () => void;
    onClear?: () => void;
  }

  let {
    values = $bindable(),
    knownPaths = new Set<string>(),
    knownModels = new Set<string>(),
    knownKeys = new Set<string>(),
    onApply,
    onClear,
  }: Props = $props();

  // Sort matches refreshDatalist() in the original (it iterates
  // [...set].sort()). We do it reactively here so new entries added to
  // the parent's Set surface in the <datalist> options.
  const pathOptions = $derived([...knownPaths].filter(Boolean).sort());
  const modelOptions = $derived([...knownModels].filter(Boolean).sort());
  const keyOptions = $derived([...knownKeys].filter(Boolean).sort());

  // Count of active (non-default) filter fields. The path field is
  // pre-populated with DEFAULT_PATH_FILTER so it only counts when the
  // operator has actually edited it. limit '100' is the default; only
  // count when changed. Surfaced as "Apply (N)" so the operator sees
  // at a glance how many constraints the next request will carry.
  const activeCount = $derived.by<number>(() => {
    let n = 0;
    if ((values.status ?? '').trim()) n++;
    const p = (values.path ?? '').trim();
    if (p && p !== '' && p !== DEFAULT_PATH_FILTER && p !== '*') n++;
    if ((values.model ?? '').trim()) n++;
    if ((values.key_hash ?? '').trim()) n++;
    if ((values.session_root_id ?? '').trim()) n++;
    if ((values.since ?? '').trim()) n++;
    const lim = (values.limit ?? '').trim();
    if (lim && lim !== '100') n++;
    return n;
  });

  function apply() {
    onApply?.();
  }

  function clear() {
    // Mirrors the original f-clear handler exactly:
    //   $('f-status').value = '';
    //   ['f-model','f-keyhash','f-session','f-since'].forEach(id => $(id).value = '');
    //   $('f-path').value = DEFAULT_PATH_FILTER;  // not empty — keep operator default
    //   $('f-limit').value = '100';
    //   loadList({ reset: true });
    values.status = '';
    values.model = '';
    values.key_hash = '';
    values.session_root_id = '';
    values.since = '';
    values.path = DEFAULT_PATH_FILTER;
    values.limit = '100';
    onClear?.();
  }

  // Enter in any filter input applies. Matches the original:
  //   document.querySelectorAll('#filters .input, #filters select')
  //     .forEach((el) => el.addEventListener('keydown', ...));
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  }

  // The original also did `el.addEventListener('change', ...)` for the
  // status <select> specifically — picking a new status auto-applies.
  function handleStatusChange() {
    apply();
  }
</script>

<aside id="filters">
  <div class="group">
    <label for="f-status">{t('filters.status')}</label>
    <select
      id="f-status"
      bind:value={values.status}
      onchange={handleStatusChange}
      onkeydown={handleKeydown}
    >
      <option value="">{t('ui.any')}</option>
      <option value="2xx">2xx</option>
      <option value="4xx">4xx</option>
      <option value="5xx">5xx</option>
      <option value="200">200</option>
      <option value="401">401</option>
      <option value="403">403</option>
      <option value="404">404</option>
      <option value="429">429</option>
      <option value="500">500</option>
      <option value="502">502</option>
    </select>
  </div>

  <div class="group">
    <label for="f-path"
      >{t('filters.path')} <span class="hint">{t('filters.hintPrefix')}</span></label
    >
    <input
      class="input"
      id="f-path"
      list="dl-paths"
      placeholder={t('filters.placeholderPath')}
      autocomplete="off"
      bind:value={values.path}
      onkeydown={handleKeydown}
    />
    <datalist id="dl-paths">
      {#each pathOptions as v (v)}
        <option value={v}></option>
      {/each}
    </datalist>
  </div>

  <div class="group">
    <label for="f-model">{t('filters.model')}</label>
    <input
      class="input"
      id="f-model"
      list="dl-models"
      placeholder={t('ui.any')}
      autocomplete="off"
      bind:value={values.model}
      onkeydown={handleKeydown}
    />
    <datalist id="dl-models">
      {#each modelOptions as v (v)}
        <option value={v}></option>
      {/each}
    </datalist>
  </div>

  <div class="group">
    <label for="f-keyhash">{t('filters.keyHash')}</label>
    <input
      class="input"
      id="f-keyhash"
      list="dl-keys"
      placeholder={t('filters.placeholderPrefix')}
      autocomplete="off"
      bind:value={values.key_hash}
      onkeydown={handleKeydown}
    />
    <datalist id="dl-keys">
      {#each keyOptions as v (v)}
        <option value={v}></option>
      {/each}
    </datalist>
  </div>

  <div class="group">
    <label for="f-session">{t('filters.sessionRootId')}</label>
    <input
      class="input"
      id="f-session"
      placeholder={t('filters.placeholderUlid')}
      autocomplete="off"
      bind:value={values.session_root_id}
      onkeydown={handleKeydown}
    />
  </div>

  <div class="group">
    <label for="f-since">{t('filters.sinceIso')}</label>
    <input
      class="input"
      id="f-since"
      placeholder={t('filters.placeholderIsoSince')}
      autocomplete="off"
      bind:value={values.since}
      onkeydown={handleKeydown}
    />
  </div>

  <div class="group">
    <label for="f-limit">{t('filters.limit')}</label>
    <input
      class="input num"
      id="f-limit"
      type="number"
      min="1"
      max="500"
      bind:value={values.limit}
      onkeydown={handleKeydown}
    />
  </div>

  <div class="actions">
    <button type="button" id="f-apply" class="primary" onclick={apply}
      >{activeCount > 0 ? t('filters.applyWithCount', { n: activeCount }) : t('filters.apply')}</button
    >
    <button type="button" id="f-clear" onclick={clear}>{t('filters.clear')}</button>
  </div>
</aside>

<style>
  /* Phase 2 C density pass — Phase L canonical tokens.
     No bg fills beyond var(--surface). No drop shadows. No gradients
     beyond the functional <select> chevron. Hairline dividers between
     groups; outline-only buttons. */

  #filters {
    width: 208px;
    flex: none;
    padding: var(--space-3) var(--space-3) var(--space-4);
    border-right: 1px solid var(--border);
    background: var(--surface);
    overflow: auto;
  }

  #filters .group {
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  #filters .group:last-of-type {
    border-bottom: 0;
  }

  #filters label {
    display: block;
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: var(--space-1);
  }

  #filters label .hint {
    color: var(--fg-dim);
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--size-label);
  }

  #filters .input,
  #filters select {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: var(--size-input);
    line-height: 1.4;
    outline: none;
    box-shadow: none;
  }
  #filters .input.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  #filters .input:focus,
  #filters select:focus {
    border-color: var(--accent);
  }

  #filters select {
    appearance: none;
    /* Functional dropdown chevron — not a decorative fill. */
    background-image:
      linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%),
      linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 12px,
      calc(100% - 9px) 12px;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    padding-right: 22px;
  }

  #filters .actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
  #filters .actions button {
    flex: 1;
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 6px 12px;
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: var(--size-body);
    box-shadow: none;
  }
  #filters .actions button:hover {
    color: var(--fg);
    border-color: var(--fg);
  }
  #filters .actions button.primary {
    background: transparent;
    color: var(--fg-muted);
    border-color: var(--border-strong);
  }
  #filters .actions button.primary:hover {
    color: var(--fg);
    border-color: var(--fg);
  }
</style>
