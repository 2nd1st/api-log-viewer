<script lang="ts">
  // Admin-token modal.
  //
  // Ported 1:1 from internal/viewer/static/index.html (showAuthModal /
  // hideAuthModal / token-save handler / token-input keydown / modal-bg
  // overlay markup at lines ~370-399, 512-522, 1339-1356).
  //
  // Original behavior to preserve:
  //   - showAuthModal():
  //       - prefill <input id="token-input"> with state.token
  //       - add .show class to #modal-bg (the overlay)
  //       - focus the input on next tick (setTimeout(..., 0))
  //   - hideAuthModal(): drop .show
  //   - Save click: trim input, write to state.token AND
  //     localStorage.setItem('apilog.token', …) (exact key — operators
  //     may already have tokens persisted under it), hide, then
  //     re-trigger the current view's loader (loadList for traces,
  //     loadHealthz for healthz). In the port the per-view reload is
  //     the parent's responsibility via onSaved.
  //   - Cancel click: hide, no write.
  //   - Enter key inside the input: preventDefault + click Save.
  //   - The modal copy is exact: "admin token", the explanatory
  //     paragraph mentioning $APILOG_DATA_DIR/admin_token,
  //     localStorage, and /api/* + /healthz, the placeholder
  //     "64 hex chars…", "Cancel" / "Save" button labels.
  //
  // localStorage write goes through setToken() in lib/api.ts which uses
  // the same TOKEN_KEY = 'apilog.token' constant — single source of
  // truth, but key value is byte-for-byte identical to the original.
  //
  // Open/close is exposed as a bindable `open` prop so the parent (App)
  // can call showAuthModal() from the header auth-btn AND lib/api.ts
  // can pop it from a 401 (via registerAuthModalHandler).

  import { getToken, setToken } from '../lib/api';

  interface Props {
    open: boolean;
    onSaved?: () => void;
  }

  let { open = $bindable(false), onSaved }: Props = $props();

  // Local mirror of the input value. We sync it from getToken() each
  // time the modal opens (matches the original prefill behavior).
  let tokenValue = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  // Open transition: prefill from current token + focus input on next
  // tick. The setTimeout(..., 0) in the original existed because the
  // element had just been made visible via class toggle; here $effect
  // runs after the DOM updates, and we still defer focus one task to
  // match the "next tick" semantics.
  $effect(() => {
    if (open) {
      tokenValue = getToken();
      const el = inputEl;
      if (el) {
        setTimeout(() => el.focus(), 0);
      }
    }
  });

  function save() {
    const trimmed = tokenValue.trim();
    setToken(trimmed); // persists to localStorage['apilog.token']
    open = false;
    onSaved?.();
  }

  function cancel() {
    open = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  }
</script>

<div class="modal-bg" class:show={open} role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
    <h2 id="auth-modal-title">admin token</h2>
    <p>
      Bearer from <code>$APILOG_DATA_DIR/admin_token</code>. Stored in
      <code>localStorage</code> on this device only; sent on every
      <code>/api/*</code> and <code>/healthz</code> request from this tab.
    </p>
    <input
      bind:this={inputEl}
      bind:value={tokenValue}
      type="password"
      placeholder="64 hex chars…"
      autocomplete="off"
      onkeydown={onKeydown}
    />
    <div class="btn-row">
      <button type="button" class="secondary" onclick={cancel}>Cancel</button>
      <button type="button" class="primary" onclick={save}>Save</button>
    </div>
  </div>
</div>

<style>
  /* Mirrors the original .modal-bg / .modal rules from index.html,
     translated to the new CSS variable names in app.css
     (--border instead of --line, --bg-elev instead of --panel,
     --fg-muted instead of --muted, --radius instead of --r). */

  .modal-bg {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.66);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(2px);
  }
  .modal-bg.show {
    display: flex;
  }

  .modal {
    background: var(--bg-elev);
    padding: 18px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 460px;
    max-width: 90vw;
  }
  .modal h2 {
    margin: 0 0 8px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
    font-weight: 500;
  }
  .modal p {
    color: var(--fg-muted);
    font-size: 11.5px;
    margin: 0 0 12px;
    line-height: 1.55;
  }
  .modal p code {
    background: var(--bg);
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 11px;
  }
  .modal input {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 7px 9px;
    font-family: var(--mono);
    font-size: 11.5px;
    outline: none;
  }
  .modal input:focus {
    border-color: var(--border-strong);
  }
  .btn-row {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    justify-content: flex-end;
  }
  .modal button {
    border: none;
    padding: 6px 14px;
    border-radius: var(--radius);
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
  }
  .modal button.primary {
    background: var(--accent);
    color: #0a1714;
  }
  .modal button.secondary {
    background: var(--bg);
    color: var(--fg-dim);
    border: 1px solid var(--border);
  }
  .modal button:hover {
    opacity: 0.9;
  }
</style>
