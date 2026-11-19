// The offline strip under the top bar and the dialog for importing a Registration package from a USB stick.
//
//   online, signed in   -> "Prepare for offline" (stores the open election's member list on this PC, encrypted with your password)
//                          and "Import USB package" (for an election that is not open yet)
//   offline, signed in  -> OFFLINE MODE: what the desk works from, and how many QR issuances wait to be sent

import { formatDateTime, plural } from '../format.js';
import { h, setChildren, setText } from './dom.js';

/** The words of the strip (also used by the tests). */
export function describeOffline({ offlineSession, info, waiting, canPrepare, online }) {
  const wait = waiting > 0 ? ` ${plural(waiting, 'QR issuance waits', 'QR issuances wait')} to be sent to the server.` : '';
  if (offlineSession) {
    const from = info ? `"${info.eventTitle}", ${plural(info.memberCount, 'member')}, prepared ${formatDateTime(new Date(info.preparedAt))}` : 'the member list prepared on this PC';
    return {
      kind: 'offline',
      title: 'OFFLINE MODE',
      detail: `Working without the server, from ${from}. Slips are printed now; the server gets the issuances when this desk is online and you sign in again.${wait}`,
    };
  }
  if (info && !info.expired) {
    return {
      kind: 'ready',
      title: 'Ready for offline',
      detail: `"${info.eventTitle}", ${plural(info.memberCount, 'member')}, prepared ${formatDateTime(new Date(info.preparedAt))}; usable offline until ${formatDateTime(new Date(info.expiresAt))}.${wait}`,
    };
  }
  const why = info && info.expired ? 'The offline preparation on this PC has expired.' : 'This PC is not prepared for offline work.';
  const how = !online ? '' : canPrepare ? ' Press "Prepare for offline" before going to a venue with no signal.' : ' Open the election, or import a Registration package from USB.';
  return { kind: 'none', title: 'Not ready for offline', detail: `${why}${how}${wait}` };
}

export function createOfflineBar({ onPrepare, onImport }) {
  let titleEl;
  let detailEl;
  let prepareBtn;
  let importBtn;
  const el = h(
    'section',
    { class: 'offline-bar', role: 'status', dataset: { kind: 'none' } },
    h('div', { class: 'offline-bar-text' }, (titleEl = h('p', { class: 'offline-bar-title' })), (detailEl = h('p', { class: 'offline-bar-detail' }))),
    h(
      'div',
      { class: 'offline-bar-actions' },
      (prepareBtn = h('button', { type: 'button', class: 'btn btn-small', onclick: () => onPrepare() }, 'Prepare for offline')),
      (importBtn = h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => onImport() }, 'Import USB package…')),
    ),
  );
  return {
    el,
    update(view) {
      const d = describeOffline(view);
      el.dataset.kind = d.kind;
      setText(titleEl, d.title);
      setText(detailEl, d.detail);
      prepareBtn.hidden = view.offlineSession;
      prepareBtn.disabled = !view.canPrepare || view.busy;
      prepareBtn.title = view.canPrepare ? 'Store the member list of the open election on this PC (encrypted with your password)' : 'Needs the server and an open election';
      // both need this user's key, which is made from the password just after signing in (a moment: PBKDF2 is slow on purpose)
      importBtn.disabled = !!view.busy || !view.canImport;
      importBtn.title = view.canImport ? 'Import a Registration package (.evreg) made in the Admin app' : 'Getting ready… (a moment after signing in)';
    },
  };
}

/** Asks for a .evreg file and its passphrase. ask() resolves to { text, passphrase } or null. */
export function createImportDialog({ describe }) {
  let pending = null;
  let fileEl;
  let infoEl;
  let passEl;
  let errorEl;
  let okBtn;
  let text = null;

  const dialog = h(
    'dialog',
    { class: 'dialog dialog-confirm', 'aria-labelledby': 'import-title' },
    h(
      'form',
      { class: 'dialog-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('h2', { id: 'import-title', class: 'dialog-title' }, 'Import a Registration package'),
      h(
        'div',
        { class: 'dialog-body' },
        h('p', null, 'Choose the .evreg file from the USB stick, then type the passphrase the Admin app showed for it.'),
        h('label', { class: 'field-label', for: 'import-file' }, 'Registration package'),
        (fileEl = h('input', { id: 'import-file', type: 'file', accept: '.evreg', onchange: () => readFile() })),
        (infoEl = h('p', { class: 'field-hint' })),
        h('label', { class: 'field-label', for: 'import-pass' }, 'Passphrase'),
        (passEl = h('input', { id: 'import-pass', type: 'password', autocomplete: 'off', spellcheck: 'false' })),
        (errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true })),
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => settle(null) }, 'Cancel'),
        (okBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Import')),
      ),
    ),
  );

  function showError(message) {
    errorEl.hidden = !message;
    setText(errorEl, message || '');
  }

  async function readFile() {
    text = null;
    showError('');
    setText(infoEl, '');
    const file = fileEl.files && fileEl.files[0];
    if (!file) return;
    try {
      text = await file.text();
      const d = describe(text);
      setText(infoEl, `"${d.eventTitle}" - ${plural(d.memberCount, 'member')}, made ${formatDateTime(new Date(d.createdAtUtc))}.`);
    } catch (err) {
      text = null;
      showError(err && err.message ? err.message : 'The file could not be read.');
    }
  }

  function submit() {
    if (!text) return showError('Choose the Registration package file first.');
    if (!passEl.value) return showError('Type the passphrase.');
    settle({ text, passphrase: passEl.value });
  }

  function settle(value) {
    const p = pending;
    pending = null;
    passEl.value = '';
    if (dialog.open) dialog.close();
    if (p) p(value);
  }

  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    settle(null);
  });

  return {
    el: dialog,
    ask() {
      if (pending) settle(null);
      text = null;
      fileEl.value = '';
      setChildren(infoEl);
      showError('');
      return new Promise((resolve) => {
        pending = resolve;
        if (!dialog.open) dialog.showModal();
        fileEl.focus();
      });
    },
    showError,
    setBusy(b) {
      okBtn.disabled = b;
    },
  };
}
