// "Review records": what the page remembers about each QR issuance of this session, and what a person may do with each one.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_RECORDS,
  RecordState,
  attemptText,
  canAcknowledge,
  canCheckWithServer,
  canReprint,
  canTryAgain,
  createRecords,
  describeRecord,
  isProblem,
  stateTitle,
} from '../../js/records.js';
import { createClock } from './helpers.mjs';

function setup() {
  const clock = createClock();
  let n = 0;
  const records = createRecords({ now: clock.now, newId: () => `r${++n}` });
  const add = (memberId, extra = {}) => records.add({ memberId, memberName: `Member ${memberId}`, accountCode: `A${memberId}`, ...extra });
  return { records, clock, add };
}

const withState = (state, extra = {}) => ({ state, message: '', acknowledged: false, attempts: 0, ...extra });

describe('what each state allows', () => {
  // [state, isProblem, canTryAgain, canCheckWithServer, canAcknowledge, canReprint]
  const table = [
    [RecordState.Sending, false, false, false, false, false],
    [RecordState.Confirmed, false, false, false, false, true],
    [RecordState.Failed, true, true, false, true, false],
    [RecordState.Unknown, true, true, true, true, false],
    [RecordState.Rejected, true, false, false, true, false],
  ];

  test('one row per state (a new state must be added here)', () => {
    assert.equal(table.length, Object.keys(RecordState).length);
  });

  for (const [state, problem, again, check, acknowledge, reprint] of table) {
    test(`${state}`, () => {
      const r = withState(state);
      assert.equal(isProblem(r), problem, 'isProblem');
      assert.equal(canTryAgain(r), again, 'canTryAgain');
      assert.equal(canCheckWithServer(r), check, 'canCheckWithServer');
      assert.equal(canAcknowledge(r), acknowledge, 'canAcknowledge');
      assert.equal(canReprint(r), reprint, 'canReprint');
    });
  }

  test('a problem that was marked as seen cannot be marked again, but can still be tried again', () => {
    const r = withState(RecordState.Failed, { acknowledged: true });
    assert.equal(canAcknowledge(r), false);
    assert.equal(canTryAgain(r), true);
  });

  test('a slip can be printed again only for what the server recorded', () => {
    for (const state of Object.values(RecordState)) assert.equal(canReprint(withState(state)), state === RecordState.Confirmed, state);
  });
});

describe('wording', () => {
  test('a title for every state', () => {
    assert.equal(stateTitle(RecordState.Confirmed), 'Confirmed by server');
    assert.equal(stateTitle(RecordState.Sending), 'Sending to server…');
    assert.equal(stateTitle(RecordState.Failed), 'Not recorded - no slip was printed');
    assert.equal(stateTitle(RecordState.Unknown), 'Not confirmed - the server did not answer');
    assert.equal(stateTitle(RecordState.Rejected), 'Rejected by server');
    assert.equal(stateTitle('odd'), 'odd');
  });

  test('the one-line description adds the reason only for a problem', () => {
    assert.equal(describeRecord(withState(RecordState.Failed, { message: 'The server could not complete the request (HTTP 502).' })), 'Not recorded - no slip was printed: The server could not complete the request (HTTP 502).');
    assert.equal(describeRecord(withState(RecordState.Failed)), 'Not recorded - no slip was printed');
    assert.equal(describeRecord(withState(RecordState.Confirmed, { message: 'left over' })), 'Confirmed by server');
    assert.equal(describeRecord(withState(RecordState.Sending, { message: 'left over' })), 'Sending to server…');
  });

  test('attempts', () => {
    assert.equal(attemptText({ attempts: 0 }), 'not tried yet');
    assert.equal(attemptText({ attempts: 1 }), '1 attempt');
    assert.equal(attemptText({ attempts: 3 }), '3 attempts');
  });
});

describe('the list of records', () => {
  test('a new record starts as "sending", newest first, with the member\'s details', () => {
    const { records, add, clock } = setup();
    const a = add(1, { branchId: 2, branch: 'East', eventId: 7, eventTitle: 'GA', qrIssuedAtBefore: '2026-11-03T01:00:00' });
    add(2);
    assert.equal(a.state, RecordState.Sending);
    assert.equal(a.startedAt, clock.now());
    assert.equal(a.attempts, 0);
    assert.equal(a.acknowledged, false);
    assert.equal(a.slipsPrinted, 0);
    assert.equal(a.issuedAtUtc, null);
    assert.equal(a.qrIssuedAtBefore, '2026-11-03T01:00:00');
    assert.deepEqual([a.branchId, a.branch, a.eventId, a.eventTitle], [2, 'East', 7, 'GA']);
    assert.deepEqual(records.list().map((r) => r.memberId), [2, 1]);
  });

  test('a record without a name is still listed, and says so', () => {
    const { records } = setup();
    records.add({ memberId: 5, memberName: '', accountCode: undefined });
    const [r] = records.list();
    assert.equal(r.memberName, '(name not recorded)');
    assert.equal(r.accountCode, '');
  });

  test('what is handed out is a copy - a screen cannot change a record by accident', () => {
    const { records, add } = setup();
    const added = add(1);
    added.state = RecordState.Confirmed;
    records.list()[0].message = 'changed';
    assert.equal(records.get(added.id).state, RecordState.Sending);
    assert.equal(records.get(added.id).message, '');
  });

  test('update changes only what it is given, and tells the listeners', () => {
    const { records, add } = setup();
    const a = add(1);
    let heard = 0;
    records.subscribe(() => heard++);
    const updated = records.update(a.id, { state: RecordState.Confirmed, issuedAtUtc: '2026-11-03T02:00:00' });
    assert.equal(updated.state, RecordState.Confirmed);
    assert.equal(updated.memberName, 'Member 1');
    assert.equal(records.get(a.id).issuedAtUtc, '2026-11-03T02:00:00');
    assert.equal(heard, 1);
  });

  test('updating a record that does not exist is null and silent', () => {
    const { records } = setup();
    let heard = 0;
    records.subscribe(() => heard++);
    assert.equal(records.update('nope', { state: RecordState.Failed }), null);
    assert.equal(records.get('nope'), null);
    assert.equal(heard, 0);
  });

  test('only the newest 500 are kept', () => {
    const { records, add } = setup();
    assert.equal(MAX_RECORDS, 500);
    for (let i = 1; i <= MAX_RECORDS + 5; i++) add(i);
    const all = records.list();
    assert.equal(all.length, MAX_RECORDS);
    assert.equal(all[0].memberId, MAX_RECORDS + 5);
    assert.equal(all.at(-1).memberId, 6);
    assert.equal(records.counts().total, MAX_RECORDS);
  });

  test('"recent" lists everything (up to a limit); "attention" only the problems nobody has looked at', () => {
    const { records, add } = setup();
    const ids = [1, 2, 3, 4, 5].map((m) => add(m).id);
    records.update(ids[0], { state: RecordState.Confirmed });
    records.update(ids[1], { state: RecordState.Failed });
    records.update(ids[2], { state: RecordState.Unknown });
    records.update(ids[3], { state: RecordState.Rejected });
    // ids[4] is still sending
    assert.deepEqual(records.list({ mode: 'recent' }).map((r) => r.memberId), [5, 4, 3, 2, 1]);
    assert.deepEqual(records.list({ mode: 'recent', limit: 2 }).map((r) => r.memberId), [5, 4]);
    assert.deepEqual(records.list({ mode: 'attention' }).map((r) => r.memberId), [4, 3, 2]);
    records.acknowledge(ids[2]);
    assert.deepEqual(records.list({ mode: 'attention' }).map((r) => r.memberId), [4, 2]);
    assert.deepEqual(records.list({ mode: 'attention', includeAcknowledged: true }).map((r) => r.memberId), [4, 3, 2]);
  });

  test('counts', () => {
    const { records, add } = setup();
    const ids = [1, 2, 3, 4, 5, 6].map((m) => add(m).id);
    records.update(ids[0], { state: RecordState.Confirmed });
    records.update(ids[1], { state: RecordState.Confirmed });
    records.update(ids[2], { state: RecordState.Failed });
    records.update(ids[3], { state: RecordState.Unknown });
    records.update(ids[4], { state: RecordState.Rejected });
    records.acknowledge(ids[4]);
    assert.deepEqual(records.counts(), { total: 6, sending: 1, confirmed: 2, problems: 3, unacknowledged: 2 });
  });

  test('marking as seen keeps the record, and only works on a problem', () => {
    const { records, add, clock } = setup();
    const bad = add(1);
    const good = add(2);
    records.update(bad.id, { state: RecordState.Failed });
    records.update(good.id, { state: RecordState.Confirmed });
    assert.equal(records.acknowledge(good.id), null, 'nothing to mark on a good record');
    assert.equal(records.acknowledge('nope'), null);
    clock.advance(5000);
    const seen = records.acknowledge(bad.id);
    assert.equal(seen.acknowledged, true);
    assert.equal(seen.acknowledgedAt, clock.now());
    assert.equal(records.list().length, 2, 'nothing is deleted');
    assert.equal(records.counts().unacknowledged, 0);
    assert.equal(records.counts().problems, 1, 'it is still a problem, just a seen one');
  });

  test('a record that is tried again and fails again needs attention again only if it was not seen', () => {
    const { records, add } = setup();
    const a = add(1);
    records.update(a.id, { state: RecordState.Failed });
    records.acknowledge(a.id);
    records.update(a.id, { state: RecordState.Sending });
    records.update(a.id, { state: RecordState.Failed });
    assert.equal(records.get(a.id).acknowledged, true, 'the mark stays with the record');
  });
});

describe('looking things up', () => {
  test('sendingFor: the record of that member that is on its way', () => {
    const { records, add } = setup();
    const a = add(1);
    assert.equal(records.sendingFor(1).id, a.id);
    assert.equal(records.sendingFor(2), null);
    records.update(a.id, { state: RecordState.Confirmed });
    assert.equal(records.sendingFor(1), null);
  });

  test('lastFor: the newest record of the member, whatever happened to it', () => {
    const { records, add } = setup();
    const first = add(1);
    const second = add(1);
    records.update(first.id, { state: RecordState.Confirmed });
    records.update(second.id, { state: RecordState.Failed });
    assert.equal(records.lastFor(1).id, second.id);
    assert.equal(records.lastFor(99), null);
  });

  test('latestConfirmedFor: the most recent CONFIRMED issuance, by the server\'s time', () => {
    const { records, add } = setup();
    const early = add(1);
    const late = add(1);
    const failed = add(1);
    records.update(early.id, { state: RecordState.Confirmed, issuedAtUtc: '2026-11-03T02:10:00' });
    records.update(late.id, { state: RecordState.Confirmed, issuedAtUtc: '2026-11-03T02:30:00' });
    records.update(failed.id, { state: RecordState.Failed });
    assert.equal(records.latestConfirmedFor(1).id, late.id);
    // the newest in the list is not necessarily the latest in time
    assert.equal(records.list()[0].id, failed.id);
  });

  test('latestConfirmedFor falls back to when the record was started', () => {
    const { records, add, clock } = setup();
    const a = add(1);
    clock.advance(1000);
    const b = add(1);
    records.update(a.id, { state: RecordState.Confirmed });
    records.update(b.id, { state: RecordState.Confirmed });
    assert.equal(records.latestConfirmedFor(1).id, b.id);
    assert.equal(records.latestConfirmedFor(2), null);
  });
});

describe('listening and forgetting', () => {
  test('listeners hear about every change; a listener that throws does not stop the others; unsubscribing works', () => {
    const { records, add } = setup();
    const seen = [];
    records.subscribe(() => {
      throw new Error('listener bug');
    });
    const off = records.subscribe(() => seen.push('x'));
    add(1);
    assert.equal(seen.length, 1);
    off();
    add(2);
    assert.equal(seen.length, 1);
  });

  test('clear forgets everything (sign-out) and says so', () => {
    const { records, add } = setup();
    add(1);
    add(2);
    let heard = 0;
    records.subscribe(() => heard++);
    records.clear();
    assert.deepEqual(records.list(), []);
    assert.deepEqual(records.counts(), { total: 0, sending: 0, confirmed: 0, problems: 0, unacknowledged: 0 });
    assert.equal(records.sendingFor(1), null);
    assert.equal(heard, 1);
  });

  test('without an id source, ids are still unique', () => {
    const records = createRecords();
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add(records.add({ memberId: i, memberName: 'x', accountCode: 'y' }).id);
    assert.equal(ids.size, 50);
  });
});
