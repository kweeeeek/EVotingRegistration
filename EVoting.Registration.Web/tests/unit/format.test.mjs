// Every sentence and every rule about text and times that staff see: folding for search, highlighting, the QR content,
// server times, eligibility wording, and the line above the result list.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EligibilityKind,
  MIN_QUERY_LENGTH,
  SERVER_ROW_CAP,
  dash,
  describeSearch,
  eligibilityHeadline,
  eligibilityIcon,
  eligibilityReason,
  fold,
  foldWithMap,
  formatDateTime,
  formatSlipDateTime,
  formatTime,
  isSearchable,
  kindOf,
  laterOf,
  loanStatusText,
  matchRanges,
  memberMatches,
  money,
  parseLocalWallClock,
  parseServerUtc,
  plural,
  qrPayload,
  qrText,
  serverQuery,
  splitByRanges,
} from '../../js/format.js';
import { EVENT, member } from './helpers.mjs';

describe('folding (case, accents and spaces are ignored, like the server\'s database)', () => {
  test('upper and lower case are the same', () => {
    assert.equal(fold('JUAN Dela CRUZ'), 'juan dela cruz');
  });

  test('accents are removed: Peña matches pena, Ñandú matches nandu', () => {
    assert.equal(fold('Josefa Peña'), 'josefa pena');
    assert.equal(fold('Ñandú'), 'nandu');
    assert.equal(fold('ŁÓDŹ'), 'lodz');
  });

  test('letters that become two letters: ß -> ss, Æ -> ae, Œ -> oe', () => {
    assert.equal(fold('Straße'), 'strasse');
    assert.equal(fold('Æsop'), 'aesop');
    assert.equal(fold('Œuvre'), 'oeuvre');
  });

  test('any run of spaces, tabs and line breaks becomes one space, and the ends are trimmed', () => {
    assert.equal(fold('  dela \t\n  cruz\u0085x  '), 'dela cruz x');
    assert.equal(fold('   '), '');
  });

  test('digits and punctuation of an account code are untouched', () => {
    assert.equal(fold('A-12/3'), 'a-12/3');
  });

  test('nothing in, nothing out - never null', () => {
    assert.equal(fold(null), '');
    assert.equal(fold(undefined), '');
    assert.equal(fold(''), '');
    assert.equal(fold(42), '42');
  });

  test('foldWithMap says where every folded letter came from in the original text', () => {
    assert.deepEqual(foldWithMap('Ñandú'), { text: 'nandu', starts: [0, 1, 2, 3, 4], ends: [1, 2, 3, 4, 5] });
    // one original letter that folds to two: both point at it
    assert.deepEqual(foldWithMap('Æ'), { text: 'ae', starts: [0, 0], ends: [1, 1] });
    // a run of spaces is one folded space that covers the whole run
    assert.deepEqual(foldWithMap('a   b'), { text: 'a b', starts: [0, 1, 4], ends: [1, 4, 5] });
    // leading and trailing spaces disappear
    assert.deepEqual(foldWithMap('  a  '), { text: 'a', starts: [2], ends: [3] });
  });
});

describe('what may be searched', () => {
  test('at least two characters after folding', () => {
    assert.equal(MIN_QUERY_LENGTH, 2);
    assert.equal(isSearchable(''), false);
    assert.equal(isSearchable('a'), false);
    assert.equal(isSearchable('  a  '), false);
    assert.equal(isSearchable('ñ'), false);
    assert.equal(isSearchable('ab'), true);
    assert.equal(isSearchable(' a b '), true);
  });

  test('the server is sent the text as typed, trimmed and single-spaced - accents included', () => {
    assert.equal(serverQuery('  dela   cruz '), 'dela cruz');
    assert.equal(serverQuery(' Peña '), 'Peña');
    assert.equal(serverQuery('a\t\nb'), 'a b');
    assert.equal(serverQuery(null), '');
    assert.equal(serverQuery(undefined), '');
  });
});

describe('highlighting what matched', () => {
  test('finds the typed text in the name as written', () => {
    assert.deepEqual(matchRanges('Juan Dela Cruz', 'dela'), [{ start: 5, end: 9 }]);
  });

  test('is blind to accents but the range covers the letters as written (Peña)', () => {
    const ranges = matchRanges('Josefa Peña', 'pena');
    assert.deepEqual(ranges, [{ start: 7, end: 11 }]);
    assert.equal('Josefa Peña'.slice(ranges[0].start, ranges[0].end), 'Peña');
  });

  test('marks every occurrence, never overlapping', () => {
    assert.deepEqual(matchRanges('Dela dela', 'dela'), [{ start: 0, end: 4 }, { start: 5, end: 9 }]);
    assert.deepEqual(matchRanges('aaa', 'aa'), [{ start: 0, end: 2 }]);
    assert.deepEqual(matchRanges('aaaa', 'aa'), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  test('a run of spaces in the original is covered whole', () => {
    assert.deepEqual(matchRanges('Dela   Cruz', 'dela cruz'), [{ start: 0, end: 11 }]);
  });

  test('a match that ends inside an expanded letter covers that whole letter (ß)', () => {
    const ranges = matchRanges('Straße', 'sse');
    assert.deepEqual(ranges, [{ start: 4, end: 6 }]);
    assert.equal('Straße'.slice(4, 6), 'ße');
  });

  test('no query, or no match, marks nothing', () => {
    assert.deepEqual(matchRanges('Juan', ''), []);
    assert.deepEqual(matchRanges('Juan', undefined), []);
    assert.deepEqual(matchRanges('Juan', 'zz'), []);
    assert.deepEqual(matchRanges(null, 'a'), []);
  });

  test('splitByRanges cuts the original into plain and marked pieces that join back to the original', () => {
    const original = 'Juan Dela Cruz';
    const parts = splitByRanges(original, [{ start: 5, end: 9 }]);
    assert.deepEqual(parts, [
      { text: 'Juan ', match: false },
      { text: 'Dela', match: true },
      { text: ' Cruz', match: false },
    ]);
    assert.equal(parts.map((p) => p.text).join(''), original);
    assert.deepEqual(splitByRanges('abc', []), [{ text: 'abc', match: false }]);
    assert.deepEqual(splitByRanges('', []), []);
    assert.deepEqual(splitByRanges(null, []), []);
  });

  test('memberMatches: the folded query is inside the name or inside the account code', () => {
    const m = { memberName: 'Josefa Peña', accountCode: 'A0004' };
    assert.equal(memberMatches(m, 'pena'), true);
    assert.equal(memberMatches(m, 'josefa pena'), true);
    assert.equal(memberMatches(m, 'a0004'), true);
    assert.equal(memberMatches(m, '0004'), true);
    assert.equal(memberMatches(m, 'cruz'), false);
    assert.equal(memberMatches(m, ''), false);
  });
});

describe('the content of the voting QR', () => {
  test('is only the account code, trimmed, in capitals - what the kiosk\'s scanner expects', () => {
    assert.equal(qrPayload('A0001'), 'A0001');
    assert.equal(qrPayload('  a0001 '), 'A0001');
    assert.equal(qrPayload(' ab-12/3 '), 'AB-12/3');
    assert.equal(qrPayload('ñ1'), 'Ñ1');
  });

  test('a letter whose capital is longer stays as it is (ß), like ToUpperInvariant on the Windows side', () => {
    assert.equal(qrPayload('straße'), 'STRAßE');
  });

  test('nothing in, nothing out', () => {
    assert.equal(qrPayload(null), '');
    assert.equal(qrPayload(undefined), '');
    assert.equal(qrPayload('   '), '');
  });
});

describe('plural, money, dash, loan status', () => {
  test('plural', () => {
    assert.equal(plural(0, 'member'), '0 members');
    assert.equal(plural(1, 'member'), '1 member');
    assert.equal(plural(2, 'member'), '2 members');
    assert.equal(plural(1, 'entry', 'entries'), '1 entry');
    assert.equal(plural(2, 'entry', 'entries'), '2 entries');
  });

  test('money is pesos with two decimals and thousands separators; rubbish is zero', () => {
    assert.equal(money(12500), '₱12,500.00');
    assert.equal(money(4300.5), '₱4,300.50');
    assert.equal(money('1250.456'), '₱1,250.46');
    assert.equal(money('abc'), '₱0.00');
    assert.equal(money(undefined), '₱0.00');
  });

  test('dash shows a long dash for nothing', () => {
    assert.equal(dash(null), '—');
    assert.equal(dash(undefined), '—');
    assert.equal(dash('   '), '—');
    assert.equal(dash(' x '), 'x');
    assert.equal(dash(0), '0');
  });

  test('loan status words; an unknown code is shown, not hidden', () => {
    assert.deepEqual([0, 1, 2, 3].map(loanStatusText), ['None', 'Active', 'Past due', 'Paid']);
    assert.equal(loanStatusText(9), 'Unknown (9)');
  });
});

describe('times', () => {
  test('a server time without a zone is UTC - whatever time zone this PC is set to', () => {
    assert.equal(parseServerUtc('2026-11-03T01:30:00.000').toISOString(), '2026-11-03T01:30:00.000Z');
    assert.equal(parseServerUtc('2026-11-03T01:30:00').toISOString(), '2026-11-03T01:30:00.000Z');
    assert.equal(parseServerUtc('  2026-11-03T01:30:00  ').toISOString(), '2026-11-03T01:30:00.000Z');
  });

  test('.NET writes seven fractional digits: only the milliseconds are kept', () => {
    assert.equal(parseServerUtc('2026-11-03T01:30:00.1234567').toISOString(), '2026-11-03T01:30:00.123Z');
  });

  test('a time that names its zone keeps it', () => {
    assert.equal(parseServerUtc('2026-11-03T01:30:00Z').toISOString(), '2026-11-03T01:30:00.000Z');
    assert.equal(parseServerUtc('2026-11-03T09:30:00+08:00').toISOString(), '2026-11-03T01:30:00.000Z');
    assert.equal(parseServerUtc('2026-11-03T09:30:00+0800').toISOString(), '2026-11-03T01:30:00.000Z');
  });

  test('something that is not a time is null, never an invalid Date', () => {
    for (const bad of ['', '   ', 'yesterday', null, undefined, 5, {}, new Date('x')]) assert.equal(parseServerUtc(bad), null, String(bad));
    const d = new Date(0);
    assert.equal(parseServerUtc(d), d);
  });

  test('an election schedule is a wall-clock time on this PC: 08:00 stays 08:00', () => {
    const from = parseLocalWallClock('2026-11-03T08:00:00');
    assert.equal(from.getFullYear(), 2026);
    assert.equal(from.getMonth(), 10);
    assert.equal(from.getDate(), 3);
    assert.equal(from.getHours(), 8);
    assert.equal(from.getMinutes(), 0);
    assert.equal(parseLocalWallClock('2026-11-03T08:00:00.1234567').getMilliseconds(), 123);
    for (const bad of ['', 'soon', null, undefined, 7]) assert.equal(parseLocalWallClock(bad), null, String(bad));
  });

  test('how times are written on screen and on the slip (local time of the PC)', () => {
    const d = new Date(2026, 10, 3, 9, 5);
    assert.equal(formatDateTime(d), '03 Nov 2026 09:05');
    assert.equal(formatTime(d), '09:05');
    assert.equal(formatSlipDateTime(d), 'Nov 03, 2026 09:05');
    assert.equal(formatDateTime(new Date(2026, 11, 25, 23, 59)), '25 Dec 2026 23:59');
  });

  test('a time that cannot be shown is a dash, not "Invalid Date"', () => {
    const bad = new Date('x');
    assert.equal(formatDateTime(bad), '—');
    assert.equal(formatTime(bad), '—');
    assert.equal(formatSlipDateTime(bad), '-');
    assert.equal(formatDateTime(null), '—');
    assert.equal(formatSlipDateTime('2026-11-03'), '-');
  });

  test('qrText: "Issued <local time>" or "Not issued"', () => {
    const issued = '2026-11-03T01:30:00.000';
    assert.equal(qrText(issued), `Issued ${formatDateTime(new Date(Date.UTC(2026, 10, 3, 1, 30)))}`);
    assert.equal(qrText(null), 'Not issued');
    assert.equal(qrText(''), 'Not issued');
    assert.equal(qrText('garbage'), 'Not issued');
  });

  test('laterOf picks the later server time, whichever is missing, and compares zones correctly', () => {
    assert.equal(laterOf('2026-11-03T01:00:00', '2026-11-03T02:00:00'), '2026-11-03T02:00:00');
    assert.equal(laterOf('2026-11-03T02:00:00', '2026-11-03T01:00:00'), '2026-11-03T02:00:00');
    assert.equal(laterOf('2026-11-03T02:00:00', '2026-11-03T01:59:59Z'), '2026-11-03T02:00:00');
    assert.equal(laterOf(null, '2026-11-03T01:00:00'), '2026-11-03T01:00:00');
    assert.equal(laterOf('2026-11-03T01:00:00', null), '2026-11-03T01:00:00');
    assert.equal(laterOf('garbage', '2026-11-03T01:00:00'), '2026-11-03T01:00:00');
    assert.equal(laterOf(null, null), null);
    assert.equal(laterOf('2026-11-03T01:00:00', '2026-11-03T01:00:00'), '2026-11-03T01:00:00');
  });
});

describe('eligibility - always the server\'s verdict, only worded here', () => {
  const eligible = member(1, 'A0001', 'Juan Dela Cruz', 1);

  test('kindOf: inactive beats everything, then a branch outside the election, then the server\'s flag', () => {
    assert.equal(kindOf(eligible, EVENT), EligibilityKind.Eligible);
    assert.equal(kindOf({ ...eligible, isEligibleToVote: false }, EVENT), EligibilityKind.NotEligible);
    assert.equal(kindOf({ ...eligible, branchId: 9 }, EVENT), EligibilityKind.BranchNotInElection);
    assert.equal(kindOf({ ...eligible, isActive: false, branchId: 9, isEligibleToVote: false }, EVENT), EligibilityKind.Inactive);
  });

  test('without an election there is no branch to be outside of', () => {
    assert.equal(kindOf({ ...eligible, branchId: 9 }, null), EligibilityKind.Eligible);
    assert.equal(kindOf({ ...eligible, branchId: 9 }, { branchIds: undefined }), EligibilityKind.Eligible);
  });

  test('icons and headlines', () => {
    assert.equal(eligibilityIcon(EligibilityKind.Eligible), '✔');
    assert.equal(eligibilityIcon(EligibilityKind.NotEligible), '✗');
    assert.equal(eligibilityIcon(EligibilityKind.Inactive), '!');
    assert.equal(eligibilityIcon(EligibilityKind.BranchNotInElection), '!');
    assert.equal(eligibilityHeadline(EligibilityKind.Eligible), 'Eligible to vote');
    assert.equal(eligibilityHeadline(EligibilityKind.NotEligible), 'Not eligible to vote');
    assert.equal(eligibilityHeadline(EligibilityKind.BranchNotInElection), 'Branch not in this election');
    assert.equal(eligibilityHeadline(EligibilityKind.Inactive), 'Member is not active');
  });

  test('the reason is the server\'s own words when it gave some', () => {
    const remarks = '  Share capital is below the minimum.  ';
    assert.equal(eligibilityReason({ ...eligible, votingRemarks: remarks }, EVENT, EligibilityKind.NotEligible), 'Share capital is below the minimum.');
    assert.equal(eligibilityReason({ ...eligible, votingRemarks: 'Good standing' }, EVENT, EligibilityKind.Eligible), 'Good standing');
  });

  test('and a plain sentence when it gave none', () => {
    assert.equal(eligibilityReason(eligible, EVENT, EligibilityKind.Eligible), 'The server lists this member as eligible.');
    assert.equal(eligibilityReason({ ...eligible, votingRemarks: '   ' }, EVENT, EligibilityKind.NotEligible), 'The server lists this member as not eligible (no reason was given).');
    assert.equal(eligibilityReason(eligible, EVENT, EligibilityKind.Inactive), 'This member is marked inactive, so no QR can be issued.');
  });

  test('a branch outside the election names the branch and the election', () => {
    const outsider = member(8, 'C0008', 'Zed Outsider', 9);
    assert.equal(eligibilityReason(outsider, EVENT, EligibilityKind.BranchNotInElection), "Branch 'Outside Branch' is not included in the '2026 Annual General Assembly' election.");
    assert.equal(eligibilityReason({ ...outsider, branch: ' ' }, null, EligibilityKind.BranchNotInElection), "Branch '?' is not included in the 'current' election.");
  });
});

describe('the line above the result list', () => {
  const rows = (...kinds) => kinds.map((kind) => ({ kind }));

  test('before and while searching', () => {
    assert.equal(describeSearch({ phase: 'idle' }), 'Type a name or an account code to search.');
    assert.equal(describeSearch({ phase: 'tooShort' }), 'Type at least 2 characters.');
    assert.equal(describeSearch({ phase: 'loading' }), 'Searching…');
  });

  test('when the search cannot run or finds nothing, the coordinator\'s sentence is used (with a fallback)', () => {
    assert.equal(describeSearch({ phase: 'noElection', message: 'No election is open, so there is nothing to search.' }), 'No election is open, so there is nothing to search.');
    assert.equal(describeSearch({ phase: 'noElection' }), 'No election is open, so there is nothing to search.');
    assert.equal(describeSearch({ phase: 'error', message: 'The server cannot be reached.' }), 'The server cannot be reached.');
    assert.equal(describeSearch({ phase: 'error' }), 'The search could not be completed.');
    assert.equal(describeSearch({ phase: 'empty', message: 'No member found for "zz" in the participating branches.' }), 'No member found for "zz" in the participating branches.');
    assert.equal(describeSearch({ phase: 'empty' }), 'No member found.');
  });

  test('results count the eligible and the others', () => {
    const k = EligibilityKind;
    assert.equal(describeSearch({ phase: 'results', members: rows(k.Eligible, k.NotEligible, k.Inactive) }), '3 members found: 1 eligible, 2 not eligible.');
    assert.equal(describeSearch({ phase: 'results', members: rows(k.Eligible) }), '1 member found: 1 eligible, 0 not eligible.');
    assert.equal(describeSearch({ phase: 'results', members: rows(k.NotEligible) }), '1 member found: 0 eligible, 1 not eligible.');
  });

  test('a cut-off list tells staff to type more', () => {
    assert.equal(SERVER_ROW_CAP, 200);
    const text = describeSearch({ phase: 'results', members: rows(EligibilityKind.Eligible), truncated: true });
    assert.equal(text, '1 member found: 1 eligible, 0 not eligible. Only the first 200 are shown - type more of the name to narrow the list.');
  });

  test('an unknown phase says nothing', () => {
    assert.equal(describeSearch({ phase: 'whatever' }), '');
  });
});
