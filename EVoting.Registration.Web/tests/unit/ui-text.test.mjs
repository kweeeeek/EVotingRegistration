// The sentences the screens build from what they know, without any screen: election line, connection pill, Issue hint,
// the line above "Review records", and the words for a failed sign-in. (js/main.js can be loaded here: it starts the page
// only when it finds <div id="app">, which plain Node does not have.)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Reachability } from '../../js/connectivity.js';
import { ApiFailure, FailureKind } from '../../js/errors.js';
import { EligibilityKind, formatDateTime, formatTime } from '../../js/format.js';
import * as main from '../../js/main.js';
import { RecordState } from '../../js/records.js';
import { issueHint } from '../../js/ui/detail-panel.js';
import { RECENT_LIMIT, SHORT_STATE, describeReview } from '../../js/ui/records-ui.js';
import { optionId } from '../../js/ui/search-panel.js';
import { describeConnection, describeElection } from '../../js/ui/topbar.js';
import { member } from './helpers.mjs';

describe('importing the page\'s main file', () => {
  test('does not start anything without a page to start on', () => {
    assert.equal(typeof main.start, 'function');
    assert.equal(typeof main.describeLoginFailure, 'function');
    assert.equal(typeof document, 'undefined');
  });
});

describe('words for a failed sign-in', () => {
  test('a wrong password says only that - it does not say which half was wrong', () => {
    assert.deepEqual(main.describeLoginFailure(new ApiFailure(FailureKind.Unauthorized, 'Invalid username or password.')), { message: 'Wrong user name or password.' });
  });

  test('too many tries: wait, with the wait the server asked for (20 seconds if it did not say)', () => {
    const asked = main.describeLoginFailure(new ApiFailure(FailureKind.RateLimited, 'x', { retryAfterSeconds: 45 }));
    assert.equal(asked.message, 'Too many sign-in attempts right now. Wait about a minute, then try again.');
    assert.equal(asked.cooldownSeconds, 45);
    assert.equal(main.describeLoginFailure(new ApiFailure(FailureKind.RateLimited, 'x')).cooldownSeconds, 20);
  });

  test('a server problem says to try again', () => {
    assert.deepEqual(main.describeLoginFailure(new ApiFailure(FailureKind.Server, 'The server could not complete the request (HTTP 502).')), { message: 'The server could not complete the request (HTTP 502). Try again in a moment.' });
  });

  test('anything else is the failure\'s own words', () => {
    for (const kind of [FailureKind.Network, FailureKind.Cors, FailureKind.Csp, FailureKind.Timeout, FailureKind.Protocol]) {
      assert.deepEqual(main.describeLoginFailure(new ApiFailure(kind, 'Own words.')), { message: 'Own words.' }, kind);
    }
  });
});

describe('the election line in the top bar', () => {
  const event = (extra = {}) => ({ venue: 'SACDECO Multi-Purpose Hall', scheduleFrom: new Date(2026, 10, 3, 8, 0), scheduleTo: new Date(2026, 10, 3, 17, 0), branchIds: [1, 2, 3], ...extra });

  test('venue, the time span, and the number of branches - as separate pieces', () => {
    assert.deepEqual(describeElection(event()), ['SACDECO Multi-Purpose Hall', '03 Nov 2026 08:00 - 17:00', '3 participating branches']);
  });

  test('an election over several days shows both ends in full', () => {
    assert.deepEqual(describeElection(event({ scheduleTo: new Date(2026, 10, 4, 17, 0) })), ['SACDECO Multi-Purpose Hall', '03 Nov 2026 08:00 - 04 Nov 2026 17:00', '3 participating branches']);
  });

  test('what is missing is left out; one branch is singular', () => {
    assert.deepEqual(describeElection(event({ venue: '  ', scheduleFrom: null, branchIds: [4] })), ['1 participating branch']);
    assert.deepEqual(describeElection(event({ venue: undefined, scheduleTo: null, branchIds: undefined })), ['0 participating branches']);
  });

  test('no election, no line', () => {
    assert.deepEqual(describeElection(null), []);
  });
});

describe('the connection pill', () => {
  test('connecting', () => {
    assert.deepEqual(describeConnection({ status: Reachability.Unknown }), { kind: 'connecting', text: 'Connecting…', detail: '' });
  });

  test('online, with the time of the last answer when there is one', () => {
    const at = new Date(2026, 10, 3, 9, 41).getTime();
    assert.deepEqual(describeConnection({ status: Reachability.Online, lastContactAt: at, lastProblem: null }), { kind: 'online', text: 'Online', detail: `Last answer from the server at ${formatTime(new Date(at))}.` });
    assert.deepEqual(describeConnection({ status: Reachability.Online, lastContactAt: null, lastProblem: null }), { kind: 'online', text: 'Online', detail: '' });
  });

  test('online with a server problem says so - it is not "offline"', () => {
    const problem = new ApiFailure(FailureKind.Server, 'The server could not complete the request (HTTP 502).');
    assert.deepEqual(describeConnection({ status: Reachability.Online, lastProblem: problem }), { kind: 'problem', text: 'Online - server problem', detail: problem.message });
  });

  test('offline, with since when', () => {
    const since = new Date(2026, 10, 3, 9, 41).getTime();
    assert.deepEqual(describeConnection({ status: Reachability.Offline, offlineSince: since }), { kind: 'offline', text: 'Offline', detail: `The server has not answered since ${formatTime(new Date(since))}.` });
    assert.equal(describeConnection({ status: Reachability.Offline, offlineSince: null }).detail, 'The server is not answering.');
  });
});

describe('why the Issue button is, or is not, available', () => {
  const eligible = { ...member(1, 'A0001', 'Juan', 1), kind: EligibilityKind.Eligible };
  const base = { eventOpen: true, offline: false, member: eligible, qrIssuedAt: null, autoPrint: true };

  test('closed, offline and nothing selected come first, in that order', () => {
    assert.equal(issueHint({ ...base, eventOpen: false, offline: true, member: null }), 'Registration is closed.');
    assert.equal(issueHint({ ...base, offline: true, member: null }), 'Offline - the server is not answering, so no QR can be issued right now.');
    assert.equal(issueHint({ ...base, member: null }), 'Select a member to see whether a QR can be issued.');
  });

  test('an eligible member: the server records first, then the slip is printed (or shown)', () => {
    assert.equal(issueHint(base), 'Press the button (or Enter). The server records the QR first, then the slip is printed.');
    assert.equal(issueHint({ ...base, autoPrint: false }), 'Press the button (or Enter). The server records the QR first, then the slip is shown.');
  });

  test('an eligible member who already has a QR: when, and that confirmation is asked', () => {
    const issued = '2026-11-03T01:30:00.000';
    const when = formatDateTime(new Date(Date.UTC(2026, 10, 3, 1, 30)));
    assert.equal(issueHint({ ...base, qrIssuedAt: issued }), `A QR was already issued (${when}). You will be asked to confirm before another is issued.`);
    assert.equal(issueHint({ ...base, qrIssuedAt: 'garbage' }), 'A QR was already issued (earlier). You will be asked to confirm before another is issued.');
  });

  test('a member who is not eligible: the server\'s reason', () => {
    const m = { ...member(3, 'A0003', 'Pedro', 2, { isEligibleToVote: false, votingRemarks: 'Share capital is below the minimum.' }), kind: EligibilityKind.NotEligible };
    assert.equal(issueHint({ ...base, member: m }), 'No QR is issued to a member who is not eligible. Share capital is below the minimum.');
    const noReason = { ...m, votingRemarks: null };
    assert.equal(issueHint({ ...base, member: noReason }), 'No QR is issued to a member who is not eligible. The server lists this member as not eligible (no reason was given).');
  });

  test('an inactive member or a branch outside the election', () => {
    const inactive = { ...member(5, 'A0005', 'Ian', 3, { isActive: false }), kind: EligibilityKind.Inactive };
    assert.equal(issueHint({ ...base, member: inactive }), 'No QR can be issued. This member is marked inactive, so no QR can be issued.');
    const outside = { ...member(8, 'C0008', 'Zed', 9), kind: EligibilityKind.BranchNotInElection };
    assert.match(issueHint({ ...base, member: outside }), /^No QR can be issued\. Branch 'Outside Branch' is not included in the 'current' election\.$/);
  });
});

describe('the line above the review list', () => {
  const row = (state, acknowledged = false) => ({ state, acknowledged });

  test('latest records', () => {
    assert.equal(describeReview('recent', [], false), 'No QR issuances have been made in this session yet.');
    assert.equal(describeReview('recent', [row(RecordState.Confirmed)], false), 'The latest 1 record of this session.');
    assert.equal(describeReview('recent', [row(RecordState.Confirmed), row(RecordState.Failed)], false), 'The latest 2 records of this session.');
  });

  test('needs attention: nothing', () => {
    assert.equal(describeReview('attention', [], false), 'Nothing needs attention.');
    assert.equal(describeReview('attention', [], true), 'No records that were rejected or not recorded.');
  });

  test('needs attention: how many, and how many were marked as seen', () => {
    const open = row(RecordState.Failed);
    const seen = row(RecordState.Unknown, true);
    assert.equal(describeReview('attention', [open], false), '1 record not recorded, rejected or waiting for a decision.');
    assert.equal(describeReview('attention', [open, open], false), '2 records not recorded, rejected or waiting for a decision.');
    assert.equal(describeReview('attention', [open, seen], true), '2 records not recorded, rejected or waiting for a decision (1 not yet marked as seen).');
    assert.equal(describeReview('attention', [seen, seen], true), '2 records not recorded, rejected or waiting for a decision (all marked as seen).');
    assert.equal(describeReview('attention', [open, open], true), '2 records not recorded, rejected or waiting for a decision.');
  });

  test('the strip at the bottom of the desk', () => {
    assert.equal(RECENT_LIMIT, 8);
    assert.deepEqual(SHORT_STATE, { confirmed: 'Confirmed', sending: 'Sending…', failed: 'Not recorded', unknown: 'Not confirmed', rejected: 'Rejected' });
    assert.equal(Object.keys(SHORT_STATE).length, Object.keys(RecordState).length, 'a new record state needs a short word');
  });

  test('each result row has its own id for the list box', () => {
    assert.equal(optionId(42), 'opt-42');
  });
});
