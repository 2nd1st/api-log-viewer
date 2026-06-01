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
  import { t } from '../lib/i18n.svelte';

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
    <h2 id="auth-modal-title">{t('auth.title')}</h2>
    <p>{t('auth.body')}</p>
    <input
      bind:this={inputEl}
      bind:value={tokenValue}
      type="password"
      placeholder={t('auth.placeholder')}
      autocomplete="off"
      onkeydown={onKeydown}
    />
    <div class="btn-row">
      <button type="button" class="secondary" onclick={cancel}>{t('auth.cancel')}</button>
      <button type="button" class="primary" onclick={save}>{t('auth.save')}</button>
    </div>
  </div>
</div>

<style>
  /* Modal panel: surface, 1px border, radius-md, max-width 360px,
     padding space-6. Backdrop: bg at 80% (var(--bg-overlay)). NO drop
     shadow. Title 13px sans var(--fg). Save button outline style. */

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
    padding: var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: 360px;
    max-width: 90vw;
    box-shadow: none;
  }
  .modal h2 {
    margin: 0 0 var(--space-2);
    font-family: var(--font-sans);
    font-size: var(--size-input);
    color: var(--fg);
    font-weight: 500;
  }
  .modal p {
    color: var(--fg-muted);
    font-size: var(--size-meta);
    margin: 0 0 var(--space-3);
    line-height: 1.55;
  }
  .modal input {
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
  .modal input:focus {
    border-color: var(--accent);
  }
  .btn-row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-3);
    justify-content: flex-end;
  }
  .modal button {
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border-strong);
    padding: 6px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: var(--size-body);
    box-shadow: none;
  }
  .modal button:hover {
    color: var(--fg);
    border-color: var(--fg);
  }
  .modal button.primary,
  .modal button.secondary {
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border-strong);
  }
  .modal button.primary:hover,
  .modal button.secondary:hover {
    color: var(--fg);
    border-color: var(--fg);
  }
</style>
