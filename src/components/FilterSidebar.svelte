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
    <label for="f-status">status</label>
    <select
      id="f-status"
      bind:value={values.status}
      onchange={handleStatusChange}
      onkeydown={handleKeydown}
    >
      <option value="">any</option>
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
      >path <span class="hint">(end with * for prefix)</span></label
    >
    <input
      class="input"
      id="f-path"
      list="dl-paths"
      placeholder="/v1/*"
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
    <label for="f-model">model</label>
    <input
      class="input"
      id="f-model"
      list="dl-models"
      placeholder="any"
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
    <label for="f-keyhash">key_hash</label>
    <input
      class="input"
      id="f-keyhash"
      list="dl-keys"
      placeholder="prefix"
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
    <label for="f-session">session_root_id</label>
    <input
      class="input"
      id="f-session"
      placeholder="ULID"
      autocomplete="off"
      bind:value={values.session_root_id}
      onkeydown={handleKeydown}
    />
  </div>

  <div class="group">
    <label for="f-since">since (ISO 8601)</label>
    <input
      class="input"
      id="f-since"
      placeholder="2026-05-28T00:00:00Z"
      autocomplete="off"
      bind:value={values.since}
      onkeydown={handleKeydown}
    />
  </div>

  <div class="group">
    <label for="f-limit">limit</label>
    <input
      class="input"
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
      >Apply</button
    >
    <button type="button" id="f-clear" onclick={clear}>Clear</button>
  </div>
</aside>

<style>
  /* Mirrors the original #filters CSS rules from index.html, translated
     onto the zinc palette in app.css:
       --line       -> --border
       --line-2     -> --border-strong
       --panel      -> --bg-elev
       --muted      -> --fg-muted
       --muted-2    -> --fg-dim
       --fg-dim     -> --fg-muted   (same idea — secondary text)
       --r          -> --radius
     The structure (width, padding, group spacing, label uppercase,
     input/select styling, custom select chevron, actions row with a
     primary button) is preserved 1:1. */

  #filters {
    width: 208px;
    flex: none;
    padding: 12px 12px 16px;
    border-right: 1px solid var(--border);
    background: var(--bg-elev);
    overflow: auto;
  }

  #filters .group {
    margin-bottom: 12px;
  }

  #filters label {
    display: block;
    font-size: 10.5px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }

  #filters label .hint {
    color: var(--fg-dim);
    text-transform: none;
    font-size: 9.5px;
  }

  #filters .input,
  #filters select {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 5px 7px;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.4;
    outline: none;
  }
  #filters .input:focus,
  #filters select:focus {
    border-color: var(--border-strong);
  }

  #filters select {
    appearance: none;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%),
      linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 9px,
      calc(100% - 9px) 9px;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    padding-right: 22px;
  }

  #filters .actions {
    display: flex;
    gap: 6px;
    margin-top: 16px;
  }
  #filters .actions button {
    flex: 1;
    background: var(--bg);
    color: var(--fg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 5px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
  }
  #filters .actions button:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }
  #filters .actions button.primary {
    background: var(--accent);
    color: #0a1714;
    border-color: var(--accent);
  }
  #filters .actions button.primary:hover {
    background: var(--accent-dim);
  }
</style>
