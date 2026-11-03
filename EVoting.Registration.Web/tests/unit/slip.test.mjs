// The element builder (js/ui/dom.js) and the slip (js/slip.js), run against a strict fake DOM (fake-dom.mjs).
// Proves: text is only ever put in as text, the slip says what a slip must say, its QR reads as the account code,
// and the print area never keeps a member's name when something goes wrong.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { formatSlipDateTime, parseServerUtc } from '../../js/format.js';
import { buildSlipModel, clearPrintArea, printSlip, renderSlip } from '../../js/slip.js';
import { h, markedText, setChildren, setHidden, setText, svg, uniqueId } from '../../js/ui/dom.js';
import { byClass, byTag, elementsOf, installFakeDom, textNodesOf } from './fake-dom.mjs';
import { readQrFromPath } from './helpers.mjs';

let dom;
before(() => {
  dom = installFakeDom();
});
after(() => dom.restore());

const record = (extra = {}) => ({
  id: 'r1',
  memberId: 1,
  memberName: 'Juan Dela Cruz',
  accountCode: 'A0001',
  branchId: 1,
  branch: 'Main Branch',
  eventId: 7,
  eventTitle: '2026 Annual General Assembly',
  state: 'confirmed',
  startedAt: Date.UTC(2026, 10, 3, 2, 0, 0),
  issuedAtUtc: '2026-11-03T02:00:05.000',
  ...extra,
});

/** { 'Member Name:': 'Juan Dela Cruz', ... } from the <dl> of a slip. */
function fieldsOf(slip) {
  const [dl] = byTag(slip, 'dl');
  const fields = {};
  for (let i = 0; i < dl.children.length; i += 2) fields[dl.children[i].textContent] = dl.children[i + 1].textContent;
  return fields;
}

describe('building elements (js/ui/dom.js)', () => {
  test('class may be a list; false and empty entries are left out', () => {
    assert.equal(h('div', { class: ['a', false, '', 'b'] }).getAttribute('class'), 'a b');
    assert.equal(h('div', { class: 'x y' }).getAttribute('class'), 'x y');
  });

  test('attributes: true is a bare attribute, false / null / undefined are not there at all', () => {
    const el = h('input', { disabled: true, hidden: false, title: null, name: undefined, type: 'text', maxlength: 5 });
    assert.equal(el.getAttribute('disabled'), '');
    assert.equal(el.getAttribute('type'), 'text');
    assert.equal(el.getAttribute('maxlength'), '5');
    for (const absent of ['hidden', 'title', 'name']) assert.equal(el.hasAttribute(absent), false, absent);
  });

  test('dataset, ref and text', () => {
    let seen = null;
    const el = h('p', { dataset: { state: 'sending', n: 3, skip: null }, ref: (e) => (seen = e), text: 'hello' });
    assert.equal(el.dataset.state, 'sending');
    assert.equal(el.dataset.n, '3');
    assert.equal('skip' in el.dataset, false);
    assert.equal(seen, el);
    assert.equal(el.textContent, 'hello');
  });

  test('on... properties add event listeners and must be functions', () => {
    const click = () => {};
    const el = h('button', { onclick: click });
    assert.deepEqual(el.listeners, [{ type: 'click', listener: click }]);
    assert.throws(() => h('button', { onclick: 'alert(1)' }), /must be a function/);
  });

  test('style, srcdoc, innerHTML and outerHTML cannot be set as attributes, in any spelling', () => {
    for (const name of ['style', 'STYLE', 'srcdoc', 'innerHTML', 'innerhtml', 'outerHTML']) {
      assert.throws(() => h('div', { [name]: 'x' }), /not allowed/, name);
    }
  });

  test('children: text and numbers become text nodes, nothing becomes nothing, lists are flattened, nodes are added', () => {
    const inner = h('b', null, 'bold');
    const el = h('p', null, 'a', 7, null, undefined, false, ['b', ['c']], inner);
    assert.equal(el.textContent, 'a7bcbold');
    assert.equal(el.children.length, 1);
    assert.equal(el.childNodes.length, 5);
  });

  test('a string that looks like markup is only text: no element is made from it', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const el = h('div', { title: hostile, 'aria-label': hostile }, hostile, h('span', null, hostile));
    assert.deepEqual(elementsOf(el).map((e) => e.tagName), ['div', 'span']);
    assert.equal(el.textContent, hostile + hostile);
    assert.equal(el.getAttribute('title'), hostile);
  });

  test('svg() makes elements in the SVG namespace', () => {
    assert.equal(svg('path', { d: 'M0 0' }).namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(h('p').namespaceURI, 'http://www.w3.org/1999/xhtml');
  });

  test('setChildren replaces what was there', () => {
    const el = h('ul', null, h('li', null, 'old'));
    setChildren(el, [h('li', null, 'one'), h('li', null, 'two')]);
    assert.equal(el.textContent, 'onetwo');
    setChildren(el);
    assert.equal(el.childNodes.length, 0);
  });

  test('setText writes only when the text changed (a screen reader must not re-announce the same sentence)', () => {
    const el = h('p');
    setText(el, 'Searching…');
    setText(el, 'Searching…');
    setText(el, 'Searching…');
    assert.equal(el.textWrites, 1);
    setText(el, '3 members found');
    assert.equal(el.textWrites, 2);
    setText(el, null);
    assert.equal(el.textContent, '');
    assert.equal(el.textWrites, 3);
  });

  test('setHidden and markedText and uniqueId', () => {
    const el = h('p');
    setHidden(el, true);
    assert.equal(el.getAttribute('hidden'), '');
    setHidden(el, false);
    assert.equal(el.hasAttribute('hidden'), false);

    const parts = markedText([{ text: 'Juan ', match: false }, { text: 'Dela', match: true }]);
    assert.equal(parts[0], 'Juan ');
    assert.equal(parts[1].tagName, 'mark');
    assert.equal(parts[1].textContent, 'Dela');

    const a = uniqueId('opt');
    const b = uniqueId('opt');
    assert.notEqual(a, b);
    assert.match(a, /^opt-\d+$/);
  });
});

describe('what the slip says', () => {
  test('the model: the member, the election, the status, the time the server recorded, and the QR content', () => {
    const model = buildSlipModel(record({ accountCode: ' a0001 ' }));
    assert.equal(model.memberName, 'Juan Dela Cruz');
    assert.equal(model.accountCode, ' a0001 ');
    assert.equal(model.qrPayload, 'A0001', 'the QR holds the trimmed, upper-case code');
    assert.equal(model.branch, 'Main Branch');
    assert.equal(model.electionTitle, '2026 Annual General Assembly');
    assert.equal(model.statusLine, 'Eligible to vote');
    assert.equal(model.issuedAt.toISOString(), '2026-11-03T02:00:05.000Z');
    assert.equal(model.isReprint, false);
    assert.equal(buildSlipModel(record(), { reprint: true }).isReprint, true);
  });

  test('without a server time the slip uses when the record was started', () => {
    const model = buildSlipModel(record({ issuedAtUtc: null }));
    assert.equal(model.issuedAt.getTime(), Date.UTC(2026, 10, 3, 2, 0, 0));
  });

  test('every line of the slip', () => {
    const slip = renderSlip(buildSlipModel(record()));
    assert.equal(slip.tagName, 'article');
    assert.equal(slip.getAttribute('aria-label'), 'Voter registration slip');
    assert.equal(byClass(slip, 'slip-title')[0].textContent, 'E-VOTING VOTER REGISTRATION SLIP');
    assert.deepEqual(fieldsOf(slip), {
      'Member Name:': 'Juan Dela Cruz',
      'Account Code:': 'A0001',
      'Branch:': 'Main Branch',
      'Election:': '2026 Annual General Assembly',
      'Status:': 'Eligible to vote',
    });
    assert.equal(byClass(slip, 'slip-scan')[0].textContent, 'SCAN THIS QR CODE AT THEVOTING KIOSK');
    assert.equal(byClass(slip, 'slip-code')[0].textContent, 'A0001');
    assert.equal(byClass(slip, 'slip-issued')[0].textContent, `Issued: ${formatSlipDateTime(parseServerUtc('2026-11-03T02:00:05.000'))}`);
    assert.equal(byClass(slip, 'slip-keep')[0].textContent, 'Keep this slip - one vote per member.');
    assert.equal(byClass(slip, 'slip-reprint').length, 0);
  });

  test('a reprint says REPRINT', () => {
    const slip = renderSlip(buildSlipModel(record(), { reprint: true }));
    assert.equal(byClass(slip, 'slip-reprint')[0].textContent, 'REPRINT');
  });

  test('a blank branch is a dash; a blank election line is left out', () => {
    const slip = renderSlip(buildSlipModel(record({ branch: '  ', eventTitle: '   ' })));
    const fields = fieldsOf(slip);
    assert.equal(fields['Branch:'], '-');
    assert.equal('Election:' in fields, false);
  });

  test('the QR on the slip reads as the account code', () => {
    const slip = renderSlip(buildSlipModel(record({ accountCode: ' ab-12/3 ' })));
    const [qr] = byTag(slip, 'svg');
    assert.equal(qr.getAttribute('aria-label'), 'QR code for account  ab-12/3 ');
    const modules = Number(qr.dataset.modules);
    const path = byTag(qr, 'path')[0];
    assert.equal(readQrFromPath(path.getAttribute('d'), modules + 8)?.data, 'AB-12/3');
  });

  test('a hostile name or branch is printed as text - no element, no attribute, nothing runs', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const slip = renderSlip(buildSlipModel(record({ memberName: hostile, branch: '"><script>alert(1)</script>', eventTitle: hostile })));
    const tags = new Set(elementsOf(slip).map((e) => e.tagName));
    for (const bad of ['img', 'script', 'iframe']) assert.equal(tags.has(bad), false, bad);
    for (const e of elementsOf(slip)) for (const name of e.attributes.keys()) assert.ok(!/^on/i.test(name) && name !== 'style' && name !== 'srcdoc', `${e.tagName} has attribute ${name}`);
    assert.ok(textNodesOf(slip).some((t) => t.data === hostile));
    assert.equal(fieldsOf(slip)['Member Name:'], hostile);
  });

  test('the slip is never made without a QR', () => {
    assert.throws(() => renderSlip({ ...buildSlipModel(record()), qrPayload: '' }), /nothing to encode/);
  });
});

describe('the print area', () => {
  const printRootWith = (...children) => {
    const root = h('div', { id: 'print-root' }, ...children);
    return root;
  };

  test('the slip is put into the print area first, then the print is asked for - once', () => {
    const root = printRootWith(h('p', null, 'an older slip'));
    const seen = [];
    const result = printSlip(buildSlipModel(record()), {
      printRoot: root,
      printFn: () => seen.push(byClass(root, 'slip').length),
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(seen, [1], 'the slip was already in place when printing started');
    assert.equal(root.children.length, 1, 'only this slip is there');
    assert.equal(root.textContent.includes('an older slip'), false);
  });

  test('no print area on the page: nothing is printed and the person is told', () => {
    let printed = 0;
    const result = printSlip(buildSlipModel(record()), { printRoot: null, printFn: () => printed++ });
    assert.deepEqual(result, { ok: false, message: 'There is no print area on this page.' });
    assert.equal(printed, 0);
  });

  test('the default print area is the element with the id print-root', () => {
    const root = dom.document.register('print-root', h('div'));
    const result = printSlip(buildSlipModel(record()), { printFn: () => {} });
    assert.deepEqual(result, { ok: true });
    assert.equal(byClass(root, 'slip').length, 1);
    clearPrintArea();
    assert.equal(root.childNodes.length, 0);
  });

  test('if printing fails, the print area is emptied - a member\'s name must not stay behind', () => {
    const root = printRootWith();
    const result = printSlip(buildSlipModel(record()), {
      printRoot: root,
      printFn: () => {
        throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
      },
    });
    assert.deepEqual(result, { ok: false, message: 'SecurityError' });
    assert.equal(root.childNodes.length, 0);
  });

  test('if the slip cannot be made (no QR), the earlier slip is not left in the print area either, and nothing is printed', () => {
    const root = printRootWith(h('article', { class: 'slip' }, 'Previous member'));
    let printed = 0;
    const result = printSlip({ ...buildSlipModel(record()), qrPayload: '' }, { printRoot: root, printFn: () => printed++ });
    assert.equal(result.ok, false);
    assert.equal(printed, 0);
    assert.equal(root.childNodes.length, 0);
  });

  test('clearPrintArea empties it, and does nothing when there is none', () => {
    const root = printRootWith(h('p', null, 'x'), h('p', null, 'y'));
    clearPrintArea(root);
    assert.equal(root.childNodes.length, 0);
    assert.doesNotThrow(() => clearPrintArea(null));
  });
});
