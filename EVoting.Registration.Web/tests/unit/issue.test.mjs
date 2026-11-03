// Issuing a QR: the checks before, what is asked of the server, and - most important - when a slip may be handed out
// (only after the server has confirmed) and what is written down when it was not.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiFailure, FailureKind } from '../../js/errors.js';
import { DUPLICATE_WINDOW_MS, IssueRefusal, checkIssue, createIssuer } from '../../js/issue.js';
import { RecordState, createRecords } from '../../js/records.js';
import { EVENT, createClock, deferred, flush, member } from './helpers.mjs';

const SERVER_TIME = '2026-11-03T02:00:05.000';

function setup({ event = EVENT } = {}) {
  const clock = createClock();
  let n = 0;
  const records = createRecords({ now: clock.now, newId: () => `r${++n}` });
  const calls = { issue: [], search: [] };
  const state = {
    event,
    markQrIssued: async (memberId) => ({ ok: true, memberId, qrIssuedAt: SERVER_TIME }),
    searchMembers: async () => ({ ok: true, members: [] }),
  };
  const api = {
    markQrIssued: (memberId, options) => {
      calls.issue.push({ memberId, options });
      return state.markQrIssued(memberId, options);
    },
    searchMembers: (query, branchIds, options) => {
      calls.search.push({ query, branchIds, options });
      return state.searchMembers(query, branchIds, options);
    },
  };
  const issuer = createIssuer({ api, records, getEvent: () => state.event, now: clock.now, issueTimeoutMs: 12345 });
  return { issuer, records, clock, calls, state };
}

const failing = (kind, message = `${kind} happened.`, status = null) => async () => ({ ok: false, failure: new ApiFailure(kind, message, { status }) });
const juan = member(1, 'A0001', 'Juan Dela Cruz', 1);

describe('the checks before asking the server', () => {
  test('a member who may be issued a QR passes', () => {
    assert.equal(checkIssue(juan, EVENT), null);
  });

  test('no election is open', () => {
    assert.deepEqual(checkIssue(juan, null), { refusal: IssueRefusal.NoElection, message: 'No election is open.' });
  });

  test('the member is not active', () => {
    assert.deepEqual(checkIssue({ ...juan, isActive: false }, EVENT), { refusal: IssueRefusal.MemberNotActive, message: 'This member is not active.' });
  });

  test('the member\'s branch is not in the election - the message names both', () => {
    const r = checkIssue(member(8, 'C0008', 'Zed', 9), EVENT);
    assert.equal(r.refusal, IssueRefusal.BranchNotInElection);
    assert.equal(r.message, "Branch 'Outside Branch' is not part of the '2026 Annual General Assembly' election.");
    assert.equal(checkIssue(juan, { ...EVENT, branchIds: undefined }).refusal, IssueRefusal.BranchNotInElection);
  });

  test('the server says not eligible - in its own words, trimmed', () => {
    assert.deepEqual(checkIssue({ ...juan, isEligibleToVote: false, votingRemarks: '  Share capital is below the minimum.  ' }, EVENT), {
      refusal: IssueRefusal.NotEligible,
      message: 'Share capital is below the minimum.',
    });
    assert.equal(checkIssue({ ...juan, isEligibleToVote: false, votingRemarks: '   ' }, EVENT).message, 'This member is not eligible to vote.');
    assert.equal(checkIssue({ ...juan, isEligibleToVote: false }, EVENT).message, 'This member is not eligible to vote.');
  });

  test('a QR was issued already - unless the person chose to issue another', () => {
    const issued = { ...juan, qrIssuedAt: '2026-11-03T01:00:00' };
    assert.deepEqual(checkIssue(issued, EVENT), { refusal: IssueRefusal.AlreadyIssued, message: 'A QR was already issued to this member.' });
    assert.equal(checkIssue(issued, EVENT, { allowReissue: true }), null);
  });

  test('when several things are wrong the most basic one is reported', () => {
    const everything = { ...juan, isActive: false, branchId: 9, isEligibleToVote: false, qrIssuedAt: '2026-11-03T01:00:00' };
    assert.equal(checkIssue(everything, null).refusal, IssueRefusal.NoElection);
    assert.equal(checkIssue(everything, EVENT).refusal, IssueRefusal.MemberNotActive);
    assert.equal(checkIssue({ ...everything, isActive: true }, EVENT).refusal, IssueRefusal.BranchNotInElection);
    assert.equal(checkIssue({ ...everything, isActive: true, branchId: 1 }, EVENT).refusal, IssueRefusal.NotEligible);
    assert.equal(checkIssue({ ...everything, isActive: true, branchId: 1, isEligibleToVote: true }, EVENT).refusal, IssueRefusal.AlreadyIssued);
  });
});

describe('issuing', () => {
  test('the server confirms: a slip may be printed, and the record says so', async () => {
    const { issuer, records, calls } = setup();
    const r = await issuer.issue(juan);
    assert.equal(r.issued, true);
    assert.equal(r.mayPrint, true);
    assert.equal(r.duplicate, false);
    assert.equal(r.refusal, IssueRefusal.None);
    assert.equal(r.message, 'QR issued. Confirmed by the server.');
    assert.equal(r.record.state, RecordState.Confirmed);
    assert.equal(r.record.issuedAtUtc, SERVER_TIME);
    assert.equal(r.record.attempts, 1);
    assert.equal(records.list().length, 1);
    assert.deepEqual(calls.issue, [{ memberId: 1, options: { timeoutMs: 12345 } }]);
  });

  test('the record keeps who, where and for which election - the slip is printed from it', async () => {
    const { issuer } = setup();
    const r = await issuer.issue({ ...juan, qrIssuedAt: null });
    assert.deepEqual(
      { id: r.record.memberId, name: r.record.memberName, code: r.record.accountCode, branchId: r.record.branchId, branch: r.record.branch, eventId: r.record.eventId, title: r.record.eventTitle },
      { id: 1, name: 'Juan Dela Cruz', code: 'A0001', branchId: 1, branch: 'Main Branch', eventId: 7, title: '2026 Annual General Assembly' },
    );
  });

  test('if the server confirms without a time, the PC\'s clock is used', async () => {
    const { issuer, state, clock } = setup();
    state.markQrIssued = async (memberId) => ({ ok: true, memberId, qrIssuedAt: null });
    const r = await issuer.issue(juan);
    assert.equal(r.record.issuedAtUtc, new Date(clock.now()).toISOString());
  });

  test('a refused member never reaches the server and leaves no record', async () => {
    const outsider = member(8, 'C0008', 'Zed', 9);
    const cases = [
      [juan, 'noElection', { event: null }],
      [{ ...juan, isActive: false }, 'memberNotActive'],
      [outsider, 'branchNotInElection'],
      [{ ...juan, isEligibleToVote: false }, 'notEligible'],
      [{ ...juan, qrIssuedAt: '2026-11-03T01:00:00' }, 'alreadyIssued'],
    ];
    for (const [m, refusal, extra] of cases) {
      const { issuer, records, calls, state } = setup();
      if (extra && 'event' in extra) state.event = extra.event;
      const r = await issuer.issue(m);
      assert.equal(r.issued, false, refusal);
      assert.equal(r.refusal, refusal);
      assert.equal(r.mayPrint, false, refusal);
      assert.equal(r.record, null, refusal);
      assert.equal(calls.issue.length, 0, refusal);
      assert.equal(records.list().length, 0, refusal);
    }
  });

  test('"issue another" overrides only the already-issued check', async () => {
    const { issuer, calls } = setup();
    const issued = { ...juan, qrIssuedAt: '2026-11-03T01:00:00' };
    assert.equal((await issuer.issue(issued)).refusal, IssueRefusal.AlreadyIssued);
    const r = await issuer.issue(issued, { allowReissue: true });
    assert.equal(r.issued, true);
    assert.equal(calls.issue.length, 1);
    const notEligible = await setup().issuer.issue({ ...juan, isEligibleToVote: false }, { allowReissue: true });
    assert.equal(notEligible.refusal, IssueRefusal.NotEligible, 'reissue never overrides the server\'s verdict');
  });

  test('what this session issued counts as "already issued" even before the next search shows it', async () => {
    const { issuer, clock, calls } = setup();
    await issuer.issue(juan);
    clock.advance(DUPLICATE_WINDOW_MS);
    const again = await issuer.issue(juan); // the screen still holds the old row, qrIssuedAt null
    assert.equal(again.refusal, IssueRefusal.AlreadyIssued);
    assert.equal(calls.issue.length, 1);
    const reissued = await issuer.issue(juan, { allowReissue: true });
    assert.equal(reissued.issued, true);
    assert.equal(calls.issue.length, 2);
  });

  test('the later of the server\'s time and this session\'s own is what counts', async () => {
    const { issuer } = setup();
    await issuer.issue(juan);
    assert.equal(issuer.effectiveQrIssuedAt(juan), SERVER_TIME);
    assert.equal(issuer.effectiveQrIssuedAt({ ...juan, qrIssuedAt: '2026-11-03T05:00:00' }), '2026-11-03T05:00:00');
    assert.equal(issuer.effectiveQrIssuedAt({ ...juan, qrIssuedAt: '2026-11-03T01:00:00' }), SERVER_TIME);
    assert.equal(issuer.effectiveQrIssuedAt(member(2, 'A0002', 'Maria', 1)), null);
  });
});

describe('a second press of the same key or button', () => {
  test('while the first is still on its way: refused as busy, the server is asked once', async () => {
    const { issuer, state, calls, records } = setup();
    const gate = deferred();
    state.markQrIssued = () => gate.promise;
    const first = issuer.issue(juan);
    const second = await issuer.issue(juan);
    assert.equal(second.issued, false);
    assert.equal(second.refusal, IssueRefusal.Busy);
    assert.equal(second.duplicate, true);
    assert.equal(second.mayPrint, false);
    assert.equal(second.message, 'A QR for this member is already being sent.');
    assert.equal(calls.issue.length, 1);
    assert.equal(records.list().length, 1);
    gate.resolve({ ok: true, memberId: 1, qrIssuedAt: SERVER_TIME });
    assert.equal((await first).issued, true);
  });

  test('a few seconds after it was confirmed: the same action, not a request for another QR - and no second slip', async () => {
    const { issuer, clock, calls, records } = setup();
    const first = await issuer.issue(juan);
    clock.advance(DUPLICATE_WINDOW_MS - 1);
    const second = await issuer.issue(juan);
    assert.equal(second.issued, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.mayPrint, false, 'a double click must not print two slips');
    assert.equal(second.refusal, IssueRefusal.None);
    assert.equal(second.message, 'A QR for this member was just issued.');
    assert.equal(second.record.id, first.record.id);
    assert.equal(calls.issue.length, 1);
    assert.equal(records.list().length, 1);
  });

  test('different members do not get in each other\'s way', async () => {
    const { issuer, state, calls } = setup();
    const gate = deferred();
    state.markQrIssued = (memberId) => (memberId === 1 ? gate.promise : Promise.resolve({ ok: true, memberId, qrIssuedAt: SERVER_TIME }));
    const first = issuer.issue(juan);
    const other = await issuer.issue(member(2, 'A0002', 'Maria Dela Cruz', 1));
    assert.equal(other.issued, true);
    assert.equal(calls.issue.length, 2);
    gate.resolve({ ok: true, memberId: 1, qrIssuedAt: SERVER_TIME });
    await first;
  });
});

describe('when the server does not confirm: what is written down, and that no slip may be printed', () => {
  const kinds = [
    [FailureKind.NotFound, RecordState.Rejected, /^The server does not know this member \(removed or deactivated\)\. Do not hand out a slip\.$/],
    [FailureKind.Network, RecordState.Unknown, /^network happened\. It may or may not have been recorded - use "Check with server" or "Try again"\. No slip was printed\.$/],
    [FailureKind.Timeout, RecordState.Unknown, /It may or may not have been recorded/],
    [FailureKind.Cors, RecordState.Unknown, /It may or may not have been recorded/],
    [FailureKind.Csp, RecordState.Unknown, /It may or may not have been recorded/],
    [FailureKind.Unauthorized, RecordState.Failed, /^Your session ended before the server recorded this\. Sign in again, then press "Try again"\. No slip was printed\.$/],
    [FailureKind.Server, RecordState.Failed, /^server happened\. No slip was printed\.$/],
    [FailureKind.Validation, RecordState.Failed, /^validation happened\. No slip was printed\.$/],
    [FailureKind.RateLimited, RecordState.Failed, /^rateLimited happened\. No slip was printed\.$/],
    [FailureKind.Forbidden, RecordState.Failed, /^forbidden happened\. No slip was printed\.$/],
    [FailureKind.Conflict, RecordState.Failed, /^conflict happened\. No slip was printed\.$/],
    [FailureKind.Protocol, RecordState.Failed, /^protocol happened\. No slip was printed\.$/],
  ];

  for (const [kind, state, message] of kinds) {
    test(`${kind} -> ${state}`, async () => {
      const { issuer, state: fake, records } = setup();
      fake.markQrIssued = failing(kind);
      const r = await issuer.issue(juan);
      assert.equal(r.issued, false);
      assert.equal(r.mayPrint, false);
      assert.equal(r.duplicate, false);
      assert.equal(r.record.state, state);
      assert.match(r.message, message);
      assert.equal(r.record.message, r.message, 'the record carries the same sentence the screen shows');
      assert.equal(r.record.failureKind, kind);
      assert.equal(r.failure.kind, kind);
      assert.equal(r.record.attempts, 1);
      assert.equal(records.counts().unacknowledged, 1, 'it needs attention');
    });
  }

  test('there is no kind of failure after which a slip may be printed', async () => {
    for (const kind of Object.values(FailureKind)) {
      const { issuer, state } = setup();
      state.markQrIssued = failing(kind);
      const r = await issuer.issue(juan);
      assert.equal(r.mayPrint, false, kind);
      assert.notEqual(r.record.state, RecordState.Confirmed, kind);
    }
  });
});

describe('trying again', () => {
  test('a record that was not recorded is sent again and can then be confirmed', async () => {
    const { issuer, state, calls, records } = setup();
    state.markQrIssued = failing(FailureKind.Server, 'Boom.', 502);
    const failed = await issuer.issue(juan);
    state.markQrIssued = async (memberId) => ({ ok: true, memberId, qrIssuedAt: SERVER_TIME });
    const r = await issuer.retry(failed.record.id);
    assert.equal(r.issued, true);
    assert.equal(r.mayPrint, true);
    assert.equal(r.record.state, RecordState.Confirmed);
    assert.equal(r.record.attempts, 2);
    assert.equal(r.record.message, '');
    assert.equal(r.record.failureKind, null);
    assert.equal(calls.issue.length, 2);
    assert.equal(records.list().length, 1, 'the same record, not a new one');
  });

  test('"not confirmed" can be tried again too; and may fail again', async () => {
    const { issuer, state } = setup();
    state.markQrIssued = failing(FailureKind.Timeout);
    const unknown = await issuer.issue(juan);
    state.markQrIssued = failing(FailureKind.Server);
    const again = await issuer.retry(unknown.record.id);
    assert.equal(again.issued, false);
    assert.equal(again.record.state, RecordState.Failed);
    assert.equal(again.record.attempts, 2);
  });

  test('a rejected record is not sent again - the server said it does not know the member', async () => {
    const { issuer, state, calls } = setup();
    state.markQrIssued = failing(FailureKind.NotFound);
    const rejected = await issuer.issue(juan);
    const r = await issuer.retry(rejected.record.id);
    assert.equal(r.issued, false);
    assert.equal(r.message, 'Only a record that was not recorded can be sent again.');
    assert.equal(calls.issue.length, 1);
  });

  test('a record that is already confirmed is not sent again (and is not an error)', async () => {
    const { issuer, calls } = setup();
    const done = await issuer.issue(juan);
    const r = await issuer.retry(done.record.id);
    assert.equal(r.issued, true);
    assert.equal(r.mayPrint, false);
    assert.equal(calls.issue.length, 1);
  });

  test('a record that does not exist', async () => {
    const { issuer } = setup();
    assert.deepEqual(await issuer.retry('nope'), { issued: false, refusal: IssueRefusal.None, message: 'That record no longer exists.', record: null, mayPrint: false, duplicate: false });
  });

  test('not while another QR for the same member is on its way', async () => {
    const { issuer, state, calls } = setup();
    state.markQrIssued = failing(FailureKind.Server);
    const failed = await issuer.issue(juan);
    const gate = deferred();
    state.markQrIssued = () => gate.promise;
    const second = issuer.issue(juan); // a new attempt for the same member is now on its way
    await flush();
    const r = await issuer.retry(failed.record.id);
    assert.equal(r.refusal, IssueRefusal.Busy);
    assert.equal(calls.issue.length, 2);
    gate.resolve({ ok: true, memberId: 1, qrIssuedAt: SERVER_TIME });
    await second;
  });
});

describe('"Check with server" - did a request whose answer never came take effect?', () => {
  async function unknownRecord(ctx, extraMember = {}) {
    ctx.state.markQrIssued = failing(FailureKind.Timeout);
    return (await ctx.issuer.issue({ ...juan, ...extraMember }, { allowReissue: true })).record; // (a member who already has an earlier QR is issued another one)
  }

  test('the server\'s time moved: it was recorded after all, and the record is confirmed with the server\'s time', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx);
    ctx.state.searchMembers = async () => ({ ok: true, members: [{ ...juan, qrIssuedAt: '2026-11-03T02:00:03.000' }] });
    const r = await ctx.issuer.verify(record.id);
    assert.equal(r.resolved, true);
    assert.equal(r.confirmed, true);
    assert.equal(r.message, 'The server has this issuance. It is confirmed.');
    assert.equal(r.record.state, RecordState.Confirmed);
    assert.equal(r.record.issuedAtUtc, '2026-11-03T02:00:03.000');
    assert.equal(r.record.message, '');
    assert.deepEqual(ctx.calls.search, [{ query: 'A0001', branchIds: EVENT.branchIds, options: undefined }]);
  });

  test('the server\'s time moved from an earlier issuance: also recorded', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx, { qrIssuedAt: '2026-11-03T01:00:00.000' });
    assert.equal(record.qrIssuedAtBefore, '2026-11-03T01:00:00.000');
    ctx.state.searchMembers = async () => ({ ok: true, members: [{ ...juan, qrIssuedAt: '2026-11-03T02:00:03.000' }] });
    assert.equal((await ctx.issuer.verify(record.id)).confirmed, true);
  });

  test('the server\'s time did not move: it was not recorded - and the page says so', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx, { qrIssuedAt: '2026-11-03T01:00:00.000' });
    ctx.state.searchMembers = async () => ({ ok: true, members: [{ ...juan, qrIssuedAt: '2026-11-03T01:00:00.000' }] });
    const r = await ctx.issuer.verify(record.id);
    assert.equal(r.resolved, true);
    assert.equal(r.confirmed, false);
    assert.equal(r.record.state, RecordState.Failed);
    assert.equal(r.message, 'The server has no record of this issuance. No slip was printed. Press "Try again" when the member is still waiting.');
  });

  test('the server never issued one to this member: not recorded', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx);
    ctx.state.searchMembers = async () => ({ ok: true, members: [{ ...juan, qrIssuedAt: null }] });
    const r = await ctx.issuer.verify(record.id);
    assert.equal(r.confirmed, false);
    assert.equal(r.record.state, RecordState.Failed);
  });

  test('if the server cannot be asked, nothing is decided and the record stays as it was', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx);
    ctx.state.searchMembers = failing(FailureKind.Network, 'The server could not be reached.');
    const r = await ctx.issuer.verify(record.id);
    assert.equal(r.resolved, false);
    assert.equal(r.message, 'The server could not be reached.');
    assert.equal(r.failure.kind, FailureKind.Network);
    assert.equal(ctx.records.get(record.id).state, RecordState.Unknown);
  });

  test('if the member is not in the answer, nothing is decided', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx);
    ctx.state.searchMembers = async () => ({ ok: true, members: [member(99, 'A0001', 'Someone else', 1)] });
    const r = await ctx.issuer.verify(record.id);
    assert.equal(r.resolved, false);
    assert.equal(r.message, 'The server no longer lists this member in the election.');
    assert.equal(ctx.records.get(record.id).state, RecordState.Unknown);
  });

  test('nothing to check without a record or without an election', async () => {
    const ctx = setup();
    const record = await unknownRecord(ctx);
    assert.deepEqual(await ctx.issuer.verify('nope'), { resolved: false, message: 'Nothing to check.', record: null });
    ctx.state.event = null;
    const r = await ctx.issuer.verify(record.id);
    assert.equal(r.resolved, false);
    assert.equal(r.message, 'Nothing to check.');
    assert.equal(ctx.calls.search.length, 0);
  });
});

describe('small helpers', () => {
  test('notePrinted counts slips per record', async () => {
    const { issuer, records } = setup();
    const { record } = await issuer.issue(juan);
    issuer.notePrinted(record.id);
    issuer.notePrinted(record.id);
    issuer.notePrinted('nope');
    assert.equal(records.get(record.id).slipsPrinted, 2);
  });

  test('the QR content is the trimmed, upper-case account code', () => {
    const { issuer } = setup();
    assert.equal(issuer.qrPayloadFor({ accountCode: ' a0001 ' }), 'A0001');
  });

  test('the issue time of a record: the server\'s, else when it was started', async () => {
    const { issuer, records, clock } = setup();
    const { record } = await issuer.issue(juan);
    assert.equal(issuer.issuedAtDate(record).toISOString(), '2026-11-03T02:00:05.000Z');
    const pending = records.add({ memberId: 2, memberName: 'x', accountCode: 'y' });
    assert.equal(issuer.issuedAtDate(pending).getTime(), clock.now());
  });
});
