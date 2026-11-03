// Modal dialogs built on <dialog>: the browser traps the focus inside, makes the rest of the page inert, and Esc closes them.

import { h, setChildren, setText } from './dom.js';

/**
 * A yes/no question. Resolves true for the confirming button, false for Cancel / Esc / a newer question.
 * The focus starts on Cancel, so a stray Enter never confirms.
 */
export function createConfirmDialog() {
  let pending = null;
  let titleEl;
  let bodyEl;
  let okBtn;
  let cancelBtn;

  const dialog = h(
    'dialog',
    { class: 'dialog dialog-confirm', 'aria-labelledby': 'confirm-title' },
    h(
      'form',
      { method: 'dialog', class: 'dialog-form', onsubmit: (e) => e.preventDefault() },
      (titleEl = h('h2', { id: 'confirm-title', class: 'dialog-title' })),
      (bodyEl = h('div', { class: 'dialog-body' })),
      h(
        'div',
        { class: 'dialog-actions' },
        (cancelBtn = h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => settle(false) }, 'Cancel')),
        (okBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => settle(true) }, 'OK')),
      ),
    ),
  );

  function settle(value) {
    const p = pending;
    pending = null;
    if (dialog.open) dialog.close();
    if (p) p(value);
  }

  dialog.addEventListener('cancel', (e) => {
    e.preventDefault(); // we close it ourselves so the promise always settles
    settle(false);
  });

  return {
    el: dialog,
    ask({ title, message, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
      if (pending) settle(false);
      setText(titleEl, title);
      setChildren(
        bodyEl,
        String(message)
          .split(/\n{2,}/)
          .map((p) => h('p', null, p)),
      );
      setText(okBtn, confirmText);
      setText(cancelBtn, cancelText);
      okBtn.classList.toggle('btn-danger', danger);
      okBtn.classList.toggle('btn-primary', !danger);
      return new Promise((resolve) => {
        pending = resolve;
        if (!dialog.open) dialog.showModal();
        cancelBtn.focus();
      });
    },
    /** Closes without an answer (the session was locked): counts as "no". */
    cancel() {
      if (pending) settle(false);
    },
  };
}

/**
 * The lock screen. The same person types the password again to continue; the session's records are still there.
 * Esc does nothing: the only ways out are the password or signing out.
 */
export function createLockDialog({ onUnlock, onSignOut }) {
  let userEl;
  let reasonEl;
  let passEl;
  let errorEl;
  let submitBtn;
  let busy = false;

  const dialog = h(
    'dialog',
    { class: 'dialog dialog-lock', 'aria-labelledby': 'lock-title' },
    h(
      'form',
      {
        class: 'dialog-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          const password = passEl.value;
          setBusy(true);
          try {
            const r = await onUnlock(password);
            if (r && !r.ok) {
              setText(errorEl, r.message || 'Could not unlock.');
              passEl.value = '';
              passEl.focus();
            }
          } finally {
            setBusy(false);
          }
        },
      },
      h('h2', { id: 'lock-title', class: 'dialog-title' }, 'Locked'),
      (reasonEl = h('p', { class: 'dialog-lead' })),
      h('p', { class: 'lock-user' }, 'Signed in as ', (userEl = h('strong', null, ''))),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'lock-password' }, 'Password'),
        (passEl = h('input', { id: 'lock-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      ),
      (errorEl = h('p', { class: 'form-error', role: 'alert' })),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => onSignOut() }, 'Sign out'),
        (submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Unlock')),
      ),
    ),
  );

  dialog.addEventListener('cancel', (e) => e.preventDefault());

  function setBusy(value) {
    busy = value;
    submitBtn.disabled = value;
    setText(submitBtn, value ? 'Unlocking…' : 'Unlock');
  }

  return {
    el: dialog,
    show({ username, displayName, reason, idleMinutes }) {
      setText(userEl, displayName || username);
      setText(errorEl, '');
      passEl.value = '';
      const lead =
        reason === 'idle'
          ? `Locked after ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'} without activity. The member list is hidden until you sign in again.`
          : reason === 'expired'
            ? 'Your session ended. Sign in again to continue; the records of this session are kept.'
            : 'The screen is locked. The member list is hidden until you sign in again.';
      setText(reasonEl, lead);
      if (!dialog.open) dialog.showModal();
      passEl.focus();
    },
    hide() {
      if (dialog.open) dialog.close();
      passEl.value = '';
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
