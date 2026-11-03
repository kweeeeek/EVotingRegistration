// The voter slip: an 80 mm wide strip laid out like the Windows station's slip (SlipVisual.cs): title, member, account code,
// branch, election, status, the QR with "scan this at the voting kiosk", the code again, a footer. The same element is shown on
// screen and handed to the printer, so what staff look at is what comes out.

import { formatSlipDateTime, parseServerUtc, qrPayload } from './format.js';
import { createQrSvg } from './qr.js';
import { h, setChildren } from './ui/dom.js';

/** What the slip says about a confirmed issuance. */
export function buildSlipModel(record, { reprint = false } = {}) {
  const issuedAt = parseServerUtc(record.issuedAtUtc) ?? new Date(record.startedAt);
  return {
    memberName: record.memberName,
    accountCode: record.accountCode,
    qrPayload: qrPayload(record.accountCode),
    branch: record.branch,
    electionTitle: record.eventTitle,
    statusLine: 'Eligible to vote',
    issuedAt,
    isReprint: reprint,
  };
}

function field(label, value, valueClass) {
  return [h('dt', { class: 'slip-label' }, label), h('dd', { class: ['slip-value', valueClass] }, value && String(value).trim() ? value : '-')];
}

/** The slip as DOM. Throws when the QR cannot be made (the slip is never shown without its QR). */
export function renderSlip(model) {
  const qr = createQrSvg(document, model.qrPayload, { label: `QR code for account ${model.accountCode}` });

  return h(
    'article',
    { class: 'slip', 'aria-label': 'Voter registration slip' },
    h('h3', { class: 'slip-title' }, 'E-VOTING VOTER REGISTRATION SLIP'),
    model.isReprint ? h('p', { class: 'slip-reprint' }, 'REPRINT') : null,
    h('hr', { class: 'slip-rule slip-rule-strong' }),
    h(
      'dl',
      { class: 'slip-fields' },
      field('Member Name:', model.memberName, 'slip-name'),
      field('Account Code:', model.accountCode, 'slip-code-field'),
      field('Branch:', model.branch),
      model.electionTitle && model.electionTitle.trim() ? field('Election:', model.electionTitle) : null,
      field('Status:', model.statusLine),
    ),
    h('hr', { class: 'slip-rule' }),
    h('p', { class: 'slip-scan' }, 'SCAN THIS QR CODE AT THE', h('br'), 'VOTING KIOSK'),
    h('div', { class: 'slip-qr' }, qr),
    h('p', { class: 'slip-code' }, model.accountCode),
    h('hr', { class: 'slip-rule' }),
    h('p', { class: 'slip-issued' }, `Issued: ${formatSlipDateTime(model.issuedAt)}`),
    h('p', { class: 'slip-keep' }, 'Keep this slip - one vote per member.'),
  );
}

/**
 * Puts the slip into the hidden print area and opens the browser's print. With Chrome/Edge started with --kiosk-printing
 * this goes straight to the default printer; otherwise the print dialog opens (choose the 80 mm receipt printer).
 * Returns { ok: true } or { ok: false, message }.
 */
export function printSlip(model, { printRoot = document.getElementById('print-root'), printFn = () => window.print() } = {}) {
  if (!printRoot) return { ok: false, message: 'There is no print area on this page.' };
  try {
    setChildren(printRoot, renderSlip(model));
    printFn();
    return { ok: true };
  } catch (err) {
    clearPrintArea(printRoot);
    return { ok: false, message: err && err.name ? err.name : 'error' };
  }
}

/** Removes the slip from the print area (it holds a member's name). */
export function clearPrintArea(printRoot = document.getElementById('print-root')) {
  if (printRoot) printRoot.replaceChildren();
}
