// Every part of the desk can be BUILT, and the top bar says what it should.
//
// js/main.js builds all of them before it shows anything. If one throws, the page stays on "Starting the registration desk..." for ever
// and nobody can sign in. That happened on 6 Nov 2026: the top bar was given an element where a tag name belongs
// (h(titleEl = h('p', ...)) instead of (titleEl = h('p', ...))), the browser threw InvalidCharacterError, and no unit test noticed
// because the fake DOM accepted any tag name. It refuses one now, as a browser does; this file builds every part of the desk with it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Reachability } from '../../js/connectivity.js';
import { createConfirmDialog, createLockDialog } from '../../js/ui/dialogs.js';
import { createDetailPanel } from '../../js/ui/detail-panel.js';
import { h, svg } from '../../js/ui/dom.js';
import { createLoginView } from '../../js/ui/login.js';
import { createRecentBar, createRecordsDialog } from '../../js/ui/records-ui.js';
import { createSearchPanel } from '../../js/ui/search-panel.js';
import { createBannerList, createTopbar } from '../../js/ui/topbar.js';
import { byClass, byTag, elementsOf, installFakeDom } from './fake-dom.mjs';

let dom;
before(() => {
  dom = installFakeDom();
});
after(() => dom.restore());

const noop = () => {};
/** Every callback a part of the desk can be given, as do-nothing functions. */
const callbacks = {
  onRefresh: noop,
  onLock: noop,
  onSignOut: noop,
  onAction: noop,
  onDismiss: noop,
  onIssue: noop,
  onCheckConnection: noop,
  onNoticeAction: noop,
  onPrintAgain: noop,
  onHideSlip: noop,
  onUnlock: noop,
  onSignIn: noop,
  onReview: noop,
  onReprint: noop,
  getRecords: () => [],
  onTryAgain: noop,
  onCheck: noop,
  onAcknowledge: noop,
  onInput: noop,
  onEnter: noop,
  onMove: noop,
  onSelect: noop,
  onClear: noop,
  onRetry: noop,
};

/** Runs the handlers that the page attached to `element` for `type` (the fake DOM has no events of its own). */
function fire(element, type) {
  for (const l of element.listeners) if (l.type === type) l.listener({ type, preventDefault: noop, stopPropagation: noop });
}

describe('the fake DOM refuses what a browser refuses', () => {
  test('a tag name that is not a name throws InvalidCharacterError - for example an element handed to h()', () => {
    const paragraph = h('p', null, 'x');
    assert.throws(() => h(paragraph), { name: 'InvalidCharacterError', message: /not a valid name/ });
    assert.throws(() => h('[object HTMLParagraphElement]'), { name: 'InvalidCharacterError' });
    assert.throws(() => h(''), { name: 'InvalidCharacterError' });
    assert.throws(() => h('two words'), { name: 'InvalidCharacterError' });
    assert.throws(() => svg(paragraph), { name: 'InvalidCharacterError' });
  });

  test('ordinary names are fine', () => {
    for (const name of ['div', 'p', 'h1', 'header', 'button', 'my-element']) assert.equal(h(name).tagName, name);
    for (const name of ['svg', 'rect', 'path', 'g']) assert.equal(svg(name).tagName, name);
  });
});

describe('every part of the desk builds (if one of these throws, the page never starts)', () => {
  const parts = {
    'the top bar': () => createTopbar(callbacks),
    'the notices under the top bar': () => createBannerList(callbacks),
    'the sign-in screen': () => createLoginView(callbacks),
    'the search panel': () => createSearchPanel(callbacks),
    'the detail panel': () => createDetailPanel(callbacks),
    'the line of recent issues': () => createRecentBar(callbacks),
    'the Review records window': () => createRecordsDialog(callbacks),
    'the lock window': () => createLockDialog(callbacks),
    'the confirmation window': () => createConfirmDialog(),
  };

  for (const [name, build] of Object.entries(parts)) {
    test(`${name} builds`, () => {
      const part = build();
      assert.equal(part.el.nodeType, 1, 'it has an element to put on the page');
      assert.ok(elementsOf(part.el).length >= 1);
    });
  }
});

describe('the top bar', () => {
  const buttonsOf = (bar) => byTag(bar.el, 'button');
  const textOf = (bar, cls) => byClass(bar.el, cls)[0]?.textContent;

  test('before anything is known it says so: no election, connecting, nobody signed in yet', () => {
    const bar = createTopbar(callbacks);
    assert.equal(bar.el.tagName, 'header');
    assert.equal(textOf(bar, 'election-title'), 'No election is open');
    assert.equal(byClass(bar.el, 'election-detail').length, 1);
    const [pill] = byClass(bar.el, 'pill');
    assert.equal(pill.getAttribute('role'), 'status');
    assert.equal(pill.getAttribute('data-kind'), 'connecting');
    assert.equal(pill.textContent, 'Connecting…');
    assert.equal(byClass(bar.el, 'topbar-user')[0].textContent, 'Signed in as ');
  });

  test('has the desk\'s one level-one heading, and it is not shown (no brand name or tile in the bar)', () => {
    const bar = createTopbar(callbacks);
    const headings = byTag(bar.el, 'h1');
    assert.equal(headings.length, 1);
    assert.equal(headings[0].textContent, 'E-Voting Registration');
    assert.equal(headings[0].getAttribute('class'), 'visually-hidden');
    assert.equal(byClass(bar.el, 'topbar-brand').length, 0);
  });

  test('has the three buttons - Refresh, Lock, Sign out - and each one calls its own handler once', () => {
    const calls = [];
    const bar = createTopbar({ onRefresh: () => calls.push('refresh'), onLock: () => calls.push('lock'), onSignOut: () => calls.push('signout') });
    const buttons = buttonsOf(bar);
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ['Refresh', 'Lock', 'Sign out'],
    );
    for (const b of buttons) assert.equal(b.getAttribute('type'), 'button', 'a button that is not a submit button');
    for (const b of buttons) fire(b, 'click');
    assert.deepEqual(calls, ['refresh', 'lock', 'signout']);
  });

  test('shows the election, its venue, dates and branches, the connection and who is signed in', () => {
    const bar = createTopbar(callbacks);
    bar.update({
      event: {
        title: '2026 Annual General Assembly',
        venue: 'SACDECO Multi-Purpose Hall',
        scheduleFrom: new Date(2026, 10, 3, 8, 0),
        scheduleTo: new Date(2026, 10, 3, 17, 0),
        branchIds: [1, 2, 3],
      },
      eventStatus: 'open',
      connectivity: { status: Reachability.Online, lastProblem: null, lastContactAt: Date.UTC(2026, 10, 3, 2, 0, 0), offlineSince: null },
      displayName: 'Maria Clerk',
    });
    assert.equal(textOf(bar, 'election-title'), '2026 Annual General Assembly');
    assert.deepEqual(
      byClass(bar.el, 'election-detail')[0].children.map((s) => s.textContent),
      ['SACDECO Multi-Purpose Hall', '03 Nov 2026 08:00 - 17:00', '3 participating branches'],
    );
    const [pill] = byClass(bar.el, 'pill');
    assert.equal(pill.dataset.kind, 'online');
    assert.equal(pill.textContent, 'Online');
    assert.equal(byClass(bar.el, 'topbar-user')[0].textContent, 'Signed in as Maria Clerk');
  });

  test('says what it does not know: no election open, the election could not be read, still looking', () => {
    const bar = createTopbar(callbacks);
    const state = (eventStatus) =>
      bar.update({ event: null, eventStatus, connectivity: { status: Reachability.Unknown, lastProblem: null, lastContactAt: null, offlineSince: null }, displayName: '' });
    state('none');
    assert.equal(textOf(bar, 'election-title'), 'No election is open');
    state('error');
    assert.equal(textOf(bar, 'election-title'), 'Election unknown');
    state('loading');
    assert.equal(textOf(bar, 'election-title'), 'Looking for the open election…');
    assert.equal(byClass(bar.el, 'election-detail')[0].children.length, 0, 'no venue or dates without an election');
  });

  test('turns the connection pill to Offline when the server does not answer', () => {
    const bar = createTopbar(callbacks);
    bar.update({
      event: null,
      eventStatus: 'none',
      connectivity: { status: Reachability.Offline, lastProblem: null, lastContactAt: null, offlineSince: Date.UTC(2026, 10, 3, 2, 0, 0) },
      displayName: 'Maria Clerk',
    });
    const [pill] = byClass(bar.el, 'pill');
    assert.equal(pill.dataset.kind, 'offline');
    assert.equal(pill.textContent, 'Offline');
  });
});
