// "Recently issued" at the bottom of the desk, and the "Review records" dialog (the Windows station's "Saved QR records" window):
// look at every QR issuance of this session, including the ones the server did not record, and decide what to do with each.
// Nothing here deletes a record: a person can mark one as seen (it stays on file), check it with the server, or send it again.

import { formatDateTime, formatTime, parseServerUtc, plural } from '../format.js';
import {
  RecordState,
  attemptText,
  canAcknowledge,
  canCheckWithServer,
  canReprint,
  canTryAgain,
  describeRecord,
  isProblem,
  stateTitle,
} from '../records.js';
import { h, setChildren, setText } from './dom.js';

export const RECENT_LIMIT = 8;
export const SHORT_STATE = {
  [RecordState.Confirmed]: 'Confirmed',
  [RecordState.Sending]: 'Sending…',
  [RecordState.Failed]: 'Not recorded',
  [RecordState.Unknown]: 'Not confirmed',
  [RecordState.Rejected]: 'Rejected',
};

/** The line above the review list (OutboxReviewViewModel.Describe). */
export function describeReview(mode, rows, includeAcknowledged) {
  if (mode === 'recent') {
    return rows.length === 0 ? 'No QR issuances have been made in this session yet.' : `The latest ${plural(rows.length, 'record')} of this session.`;
  }
  if (rows.length === 0) return includeAcknowledged ? 'No records that were rejected or not recorded.' : 'Nothing needs attention.';
  const open = rows.filter(canAcknowledge).length;
  const seen = !includeAcknowledged || open === rows.length ? '.' : open === 0 ? ' (all marked as seen).' : ` (${open} not yet marked as seen).`;
  return `${plural(rows.length, 'record')} not recorded, rejected or waiting for a decision${seen}`;
}

const issuedText = (record) => {
  const d = parseServerUtc(record.issuedAtUtc) ?? new Date(record.startedAt);
  return formatDateTime(d);
};

export function createRecentBar({ onReview, onReprint }) {
  let listEl;
  let reviewBtn;
  let reviewCount;
  let emptyEl;

  const el = h(
    'footer',
    { class: 'recent', 'aria-label': 'Recently issued' },
    h(
      'div',
      { class: 'recent-head' },
      h('h2', { class: 'recent-title' }, 'Recently issued in this session'),
      // the space matters: what is written on the button ("Review records 2") must be contained in its spoken name (WCAG 2.5.3)
      (reviewBtn = h('button', { type: 'button', class: 'btn btn-small', onclick: () => onReview() }, 'Review records', ' ', (reviewCount = h('span', { class: 'count', hidden: true })))),
    ),
    (emptyEl = h('p', { class: 'recent-empty' }, 'Nothing has been issued yet.')),
    (listEl = h('ul', { class: 'recent-list' })),
  );

  return {
    el,
    reviewButton: reviewBtn,
    update({ records, counts }) {
      const latest = records.slice(0, RECENT_LIMIT);
      emptyEl.hidden = latest.length > 0;
      listEl.hidden = latest.length === 0; // the two share one grid cell: never leave an empty list lying over the sentence
      setChildren(
        listEl,
        latest.map((r) =>
          h(
            'li',
            { class: 'recent-item', dataset: { state: r.state } },
            h('span', { class: 'recent-time' }, formatTime(parseServerUtc(r.issuedAtUtc) ?? new Date(r.startedAt))),
            h('span', { class: 'recent-name' }, r.memberName),
            h('span', { class: 'recent-code' }, r.accountCode),
            h('span', { class: 'recent-state', title: describeRecord(r) }, SHORT_STATE[r.state] ?? r.state),
            canReprint(r) ? h('button', { type: 'button', class: 'btn btn-quiet btn-small', 'aria-label': `Reprint slip for ${r.memberName}`, onclick: () => onReprint(r.id) }, 'Reprint') : null,
          ),
        ),
      );
      const n = counts.unacknowledged;
      reviewCount.hidden = n === 0;
      setText(reviewCount, String(n));
      reviewBtn.setAttribute('aria-label', n === 0 ? 'Review records' : `Review records, ${n === 1 ? '1 record needs' : `${n} records need`} attention`);
    },
  };
}

export function createRecordsDialog({ getRecords, onTryAgain, onCheck, onAcknowledge, onReprint }) {
  let mode = 'attention';
  let includeAcknowledged = false;
  let summaryEl;
  let noticeEl;
  let tbodyEl;
  let tableEl;
  let seenBox;
  let attentionRadio;
  let recentRadio;
  let opened = false;

  const dialog = h(
    'dialog',
    { class: 'dialog dialog-records', 'aria-labelledby': 'records-title' },
    h(
      'div',
      { class: 'dialog-form' },
      h(
        'div',
        { class: 'dialog-head' },
        h('h2', { id: 'records-title', class: 'dialog-title' }, 'Review records'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => api.close() }, 'Close'),
      ),
      h('p', { class: 'dialog-lead' }, 'Every QR issuance of this session. A slip is printed only after the server has recorded the issuance; anything else is listed here for you to decide. Nothing is deleted.'),
      h(
        'fieldset',
        { class: 'review-modes' },
        h('legend', { class: 'visually-hidden' }, 'Which records to show'),
        h('label', { class: 'choice' }, (attentionRadio = h('input', { type: 'radio', name: 'review-mode', value: 'attention', checked: true, onchange: () => setMode('attention') })), 'Needs attention'),
        h('label', { class: 'choice' }, (recentRadio = h('input', { type: 'radio', name: 'review-mode', value: 'recent', onchange: () => setMode('recent') })), 'Latest records (all states)'),
        h('label', { class: 'choice' }, (seenBox = h('input', { type: 'checkbox', onchange: () => { includeAcknowledged = seenBox.checked; render(); } })), 'Include records already marked as seen'),
      ),
      (summaryEl = h('p', { class: 'review-summary', role: 'status' })),
      (noticeEl = h('p', { class: 'review-notice', role: 'status' })),
      h(
        'div',
        { class: 'table-wrap' },
        (tableEl = h(
          'table',
          { class: 'records-table' },
          h('caption', { class: 'visually-hidden' }, 'QR issuance records of this session'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Member'), h('th', { scope: 'col' }, 'Issued'), h('th', { scope: 'col' }, 'What happened'), h('th', { scope: 'col' }, 'Tries'), h('th', { scope: 'col' }, 'Actions'))),
          (tbodyEl = h('tbody')),
        )),
      ),
    ),
  );

  function setMode(next) {
    mode = next;
    attentionRadio.checked = next === 'attention';
    recentRadio.checked = next === 'recent';
    seenBox.disabled = next !== 'attention';
    render();
  }

  function actionButton(label, run, extraClass = '') {
    return h('button', { type: 'button', class: `btn btn-small ${extraClass}`.trim(), onclick: run }, label);
  }

  function render() {
    if (!opened) return;
    const rows = getRecords({ mode, includeAcknowledged });
    setText(summaryEl, describeReview(mode, rows, includeAcknowledged));
    setChildren(
      tbodyEl,
      rows.map((r) =>
        h(
          'tr',
          { dataset: { state: r.state, recordId: r.id }, class: isProblem(r) ? 'is-problem' : '' },
          h('td', { class: 'cell-member' }, h('strong', null, r.memberName), h('br'), h('span', { class: 'mono' }, r.accountCode)),
          h('td', { class: 'cell-issued' }, issuedText(r)),
          h('td', { class: 'cell-what' }, h('span', { class: 'state-title', dataset: { state: r.state } }, stateTitle(r.state)), r.message ? h('span', { class: 'state-detail' }, r.message) : null, r.acknowledged ? h('span', { class: 'state-seen' }, 'Marked as seen.') : null),
          h('td', { class: 'cell-tries' }, attemptText(r)),
          h(
            'td',
            { class: 'cell-actions' },
            canTryAgain(r) ? actionButton('Try again', () => onTryAgain(r.id), 'btn-primary') : null,
            canCheckWithServer(r) ? actionButton('Check with server', () => onCheck(r.id)) : null,
            canAcknowledge(r) ? actionButton('Mark as seen', () => onAcknowledge(r.id)) : null,
            canReprint(r) ? actionButton('Reprint slip', () => onReprint(r.id)) : null,
          ),
        ),
      ),
    );
    tableEl.hidden = rows.length === 0;
  }

  const api = {
    el: dialog,
    open({ initialMode = 'attention' } = {}) {
      opened = true;
      includeAcknowledged = false;
      seenBox.checked = false;
      setText(noticeEl, '');
      setMode(initialMode);
      if (!dialog.open) dialog.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
    refresh: render,
    /** What the last action did ("Marked as seen.", "Sent again."). */
    notify(text) {
      setText(noticeEl, text);
    },
  };

  dialog.addEventListener('close', () => {
    opened = false;
    setText(noticeEl, '');
  });
  return api;
}
