// "Issued at this desk": every QR slip THIS DESK (the number chosen at sign-in) handed out in the open election, read from the server.
// Because it comes from the server it is still there after a reload, a sign-out or a change of PC; only this desk's slips are shown
// (the Admin app lists every desk). While the desk works offline, the slips issued offline on this PC are listed from the outbox.

import { formatDateTime, parseServerUtc, plural } from '../format.js';
import { h, setChildren, setText } from './dom.js';

/** The line above the table. */
export function describeDeskList({ deskNo, eventTitle, total, memberCount, waiting = 0, filter = '', shown = 0 }) {
  if (!deskNo) return 'No desk was chosen at sign-in.';
  if (!eventTitle) return `Desk ${deskNo}: no election is open.`;
  const head = `Desk ${deskNo}, "${eventTitle}": ${plural(memberCount, 'member')} received a QR here`;
  const reprints = total > memberCount ? ` (${plural(total, 'slip')} with reprints)` : '';
  const wait = waiting > 0 ? ` ${plural(waiting, 'slip issued offline waits', 'slips issued offline wait')} to be sent to the server.` : '';
  const filtered = filter ? ` Showing ${shown} that match "${filter}".` : '';
  return `${head}${reprints}.${wait}${filtered}`;
}

/** Rows matching the filter text (name or account code, case and spaces ignored). */
export function filterDeskRows(rows, text) {
  const q = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return rows;
  return rows.filter((r) => `${r.memberName} ${r.accountCode}`.toLowerCase().replace(/\s+/g, ' ').includes(q));
}

export function createDeskListDialog({ onRefresh }) {
  let summaryEl;
  let statusEl;
  let tbodyEl;
  let tableEl;
  let filterEl;
  let data = { deskNo: null, eventTitle: '', items: [], total: 0, memberCount: 0, waiting: 0, loading: false, error: '' };

  const dialog = h(
    'dialog',
    { class: 'dialog dialog-records', 'aria-labelledby': 'desk-list-title' },
    h(
      'div',
      { class: 'dialog-form' },
      h(
        'div',
        { class: 'dialog-head' },
        h('h2', { id: 'desk-list-title', class: 'dialog-title' }, 'Issued at this desk'),
        h(
          'div',
          { class: 'dialog-head-buttons' },
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => onRefresh() }, 'Refresh'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => api.close() }, 'Close'),
        ),
      ),
      h('p', { class: 'dialog-lead' }, 'Every member this desk gave a QR slip to in the open election, newest first. It is kept by the server, so it is still here after a reload or on another PC.'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'desk-list-filter' }, 'Find in this list'),
        (filterEl = h('input', { id: 'desk-list-filter', type: 'search', autocomplete: 'off', spellcheck: 'false', oninput: () => render() })),
      ),
      (summaryEl = h('p', { class: 'review-summary', role: 'status' })),
      (statusEl = h('p', { class: 'review-notice', role: 'status' })),
      h(
        'div',
        { class: 'table-wrap' },
        (tableEl = h(
          'table',
          { class: 'desk-table' },
          h('caption', { class: 'visually-hidden' }, 'QR slips issued at this desk'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Member'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Issued'), h('th', { scope: 'col' }, 'By'))),
          (tbodyEl = h('tbody')),
        )),
      ),
    ),
  );

  function render() {
    const rows = filterDeskRows(data.items, filterEl.value);
    setText(summaryEl, describeDeskList({ ...data, filter: filterEl.value.trim(), shown: rows.length }));
    setText(statusEl, data.loading ? 'Asking the server…' : data.error);
    setChildren(
      tbodyEl,
      rows.map((r) =>
        h(
          'tr',
          { dataset: { memberId: r.memberId, offline: r.offline ? 'true' : 'false' } },
          h('td', { class: 'cell-member' }, h('strong', null, r.memberName), h('br'), h('span', { class: 'mono' }, r.accountCode)),
          h('td', null, r.branch),
          h('td', { class: 'cell-issued' }, formatDateTime(parseServerUtc(r.issuedAtUtc) ?? new Date(r.issuedAtUtc)), r.offline ? h('span', { class: 'state-detail' }, r.pending ? 'Issued offline - not sent yet' : 'Issued offline') : null),
          h('td', null, r.issuedBy),
        ),
      ),
    );
    tableEl.hidden = rows.length === 0;
  }

  const api = {
    el: dialog,
    open() {
      filterEl.value = '';
      render();
      if (!dialog.open) dialog.showModal();
      onRefresh();
    },
    close() {
      if (dialog.open) dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
    /** New contents (any subset of the fields). */
    set(next) {
      data = { ...data, ...next };
      if (dialog.open) render();
    },
    /** Forgets the member names (lock / sign-out). */
    clear() {
      data = { deskNo: data.deskNo, eventTitle: '', items: [], total: 0, memberCount: 0, waiting: 0, loading: false, error: '' };
      filterEl.value = '';
      if (dialog.open) dialog.close();
    },
  };
  return api;
}
