// The search box: one search per pause in typing, never an old answer on screen, rows narrowed at once while the answer comes,
// and a plain sentence for every situation. Timers and the server are replaced by ones a test controls.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiFailure, FailureKind } from '../../js/errors.js';
import { EligibilityKind, SERVER_ROW_CAP, fold } from '../../js/format.js';
import { DEFAULT_DEBOUNCE_MS, createSearchCoordinator, describeSearchFailure, narrowMembers } from '../../js/search.js';
import { EVENT, createClock, createTimers, deferred, flush, member } from './helpers.mjs';

const JUAN = member(1, 'A0001', 'Juan Dela Cruz', 1);
const MARIA = member(2, 'A0002', 'Maria Dela Cruz-Santos', 1);
const ROSA = member(7, 'A0007', 'Dela Rosa, Ramon', 1);
const PEDRO = member(3, 'A0003', 'Pedro Penduko', 2, { isEligibleToVote: false, votingRemarks: 'Share capital is below the minimum.' });
const IAN = member(5, 'A0005', 'Ian Inactive', 3, { isActive: false });
const ZED = member(8, 'C0008', 'Zed Outsider', 9);

function setup({ event = EVENT, debounceMs = DEFAULT_DEBOUNCE_MS, onState } = {}) {
  const clock = createClock();
  const timers = createTimers(clock);
  const states = [];
  const calls = [];
  const ctx = { event, handler: null };
  const api = {
    searchMembers(query, branchIds, options) {
      const call = { query, branchIds, signal: options?.signal, answer: deferred() };
      calls.push(call);
      if (ctx.handler) return Promise.resolve().then(() => ctx.handler(call));
      return call.answer.promise;
    },
  };
  const search = createSearchCoordinator({
    api,
    getEvent: () => ctx.event,
    onState: (s) => {
      states.push(s);
      onState?.(s);
    },
    debounceMs,
    timers,
  });
  return {
    search,
    timers,
    states,
    calls,
    ctx,
    last: () => states.at(-1),
    ok: (members) => ({ ok: true, members }),
    async advance(ms) {
      timers.advance(ms);
      await flush();
    },
  };
}

const bulk = (n) => Array.from({ length: n }, (_, i) => member(1000 + i, `T${String(i).padStart(4, '0')}`, `Test Member ${i}`, 1));

describe('when there is nothing to search for', () => {
  test('an empty or blank box is the idle state and asks nothing', async () => {
    const t = setup();
    await t.search.searchNow('');
    assert.equal(t.last().phase, 'idle');
    assert.equal(t.last().query, '');
    await t.search.searchNow('   ');
    assert.equal(t.last().phase, 'idle');
    await t.search.searchNow(null);
    assert.equal(t.last().phase, 'idle');
    assert.equal(t.calls.length, 0);
  });

  test('one character is too short', async () => {
    const t = setup();
    await t.search.searchNow('a');
    assert.equal(t.last().phase, 'tooShort');
    assert.equal(t.last().message, 'Type at least 2 characters.');
    await t.search.searchNow(' ñ ');
    assert.equal(t.last().phase, 'tooShort', 'one letter after folding');
    assert.equal(t.calls.length, 0);
  });

  test('no election: nothing to search, and no question is sent', async () => {
    for (const event of [null, { ...EVENT, branchIds: [] }, { ...EVENT, branchIds: undefined }]) {
      const t = setup({ event });
      await t.search.searchNow('dela');
      assert.equal(t.last().phase, 'noElection');
      assert.equal(t.last().message, 'No election is open, so there is nothing to search.');
      assert.equal(t.calls.length, 0);
    }
  });
});

describe('typing', () => {
  test('one search per pause: every keystroke restarts the wait, only the last text is sent', async () => {
    const t = setup();
    t.search.queryChanged('de');
    await t.advance(100);
    t.search.queryChanged('del');
    await t.advance(100);
    t.search.queryChanged('dela');
    await t.advance(149);
    assert.equal(t.calls.length, 0, 'still waiting');
    await t.advance(1);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].query, 'dela');
    assert.equal(t.timers.pending, 0);
  });

  test('"Searching…" is shown at once, before the wait is over', async () => {
    const t = setup();
    t.search.queryChanged('dela');
    assert.equal(t.last().phase, 'loading');
    assert.equal(t.last().query, 'dela');
    assert.equal(t.calls.length, 0);
  });

  test('Enter / the Search button searches now, with no wait, and resolves when it has ended', async () => {
    const t = setup();
    const done = t.search.searchNow('dela');
    assert.equal(t.calls.length, 1, 'sent at once');
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await done;
    assert.equal(t.last().phase, 'results');
  });

  test('what is sent: the text as typed, single-spaced, the election\'s branches, and a way to cancel', async () => {
    const t = setup();
    t.search.searchNow('  Peña   Cruz ');
    assert.equal(t.calls[0].query, 'Peña Cruz');
    assert.deepEqual(t.calls[0].branchIds, [1, 2, 3]);
    assert.ok(t.calls[0].signal instanceof AbortSignal);
  });

  test('the wait can be changed', async () => {
    const t = setup({ debounceMs: 400 });
    t.search.queryChanged('dela');
    await t.advance(399);
    assert.equal(t.calls.length, 0);
    await t.advance(1);
    assert.equal(t.calls.length, 1);
  });

  test('text that becomes too short cancels the search that was waiting', async () => {
    const t = setup();
    t.search.queryChanged('dela');
    t.search.queryChanged('d');
    await t.advance(1000);
    assert.equal(t.calls.length, 0);
    assert.equal(t.last().phase, 'tooShort');
    assert.equal(t.timers.pending, 0);
  });
});

describe('answers', () => {
  test('rows come with the kind of eligibility worked out from the server\'s own fields', async () => {
    const t = setup();
    const done = t.search.searchNow('a0');
    t.calls[0].answer.resolve(t.ok([JUAN, PEDRO, IAN, ZED]));
    await done;
    const s = t.last();
    assert.equal(s.phase, 'results');
    assert.equal(s.query, 'a0');
    assert.equal(s.foldedQuery, 'a0');
    assert.equal(s.truncated, false);
    assert.deepEqual(s.members.map((m) => [m.memberId, m.kind]), [
      [1, EligibilityKind.Eligible],
      [3, EligibilityKind.NotEligible],
      [5, EligibilityKind.Inactive],
      [8, EligibilityKind.BranchNotInElection],
    ]);
    assert.equal(s.members[1].votingRemarks, 'Share capital is below the minimum.', 'the server\'s fields are kept');
  });

  test('exactly 200 rows means the list was cut off; 199 does not', async () => {
    const full = setup();
    const a = full.search.searchNow('test');
    full.calls[0].answer.resolve(full.ok(bulk(SERVER_ROW_CAP)));
    await a;
    assert.equal(full.last().truncated, true);

    const nearly = setup();
    const b = nearly.search.searchNow('test');
    nearly.calls[0].answer.resolve(nearly.ok(bulk(SERVER_ROW_CAP - 1)));
    await b;
    assert.equal(nearly.last().truncated, false);
  });

  test('no match is its own state, naming what was typed (trimmed)', async () => {
    const t = setup();
    const done = t.search.searchNow('  zzz ');
    t.calls[0].answer.resolve(t.ok([]));
    await done;
    assert.equal(t.last().phase, 'empty');
    assert.equal(t.last().message, 'No member found for "zzz" in the participating branches.');
    assert.deepEqual(t.last().members, []);
  });

  test('the sequence number of what is shown only ever goes up', async () => {
    const t = setup();
    t.search.queryChanged('de');
    await t.advance(150);
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await flush();
    await t.search.searchNow('a');
    t.search.reset();
    const sequences = t.states.map((s) => s.sequence);
    assert.equal(sequences.length, 4, 'loading, results, too short, idle');
    for (let i = 1; i < sequences.length; i++) assert.ok(sequences[i] > sequences[i - 1], `${sequences[i - 1]} then ${sequences[i]}`);
  });
});

describe('an old answer never replaces a newer one', () => {
  test('a newer search cancels the older request, and the older answer is ignored when it finally arrives', async () => {
    const t = setup();
    t.search.searchNow('dela');
    t.search.searchNow('dela c');
    assert.equal(t.calls[0].signal.aborted, true, 'the older request is cancelled');
    assert.equal(t.calls[1].signal.aborted, false);
    t.calls[1].answer.resolve(t.ok([JUAN, MARIA]));
    await flush();
    const shown = t.states.length;
    t.calls[0].answer.resolve(t.ok([JUAN, MARIA, ROSA])); // the slow one, now stale
    await flush();
    assert.equal(t.states.length, shown, 'nothing new was published');
    assert.equal(t.last().query, 'dela c');
    assert.deepEqual(t.last().members.map((m) => m.memberId), [1, 2]);
  });

  test('also when the older answer arrives FIRST', async () => {
    const t = setup();
    t.search.searchNow('dela');
    t.search.searchNow('dela c');
    t.calls[0].answer.resolve(t.ok([JUAN, MARIA, ROSA]));
    await flush();
    assert.equal(t.last().phase, 'loading', 'still waiting for the newer one');
    assert.equal(t.last().query, 'dela c');
    t.calls[1].answer.resolve(t.ok([JUAN, MARIA]));
    await flush();
    assert.deepEqual(t.last().members.map((m) => m.memberId), [1, 2]);
  });

  test('an old answer is not remembered either: it can never become the base for narrowing the next text', async () => {
    const t = setup();
    t.search.searchNow('dela'); // call 0
    t.search.searchNow('dela c'); // call 1 - call 0 is cancelled
    t.calls[0].answer.resolve(t.ok([JUAN, MARIA, ROSA])); // ... but its answer arrives anyway (the server had already sent it)
    await flush();
    t.search.queryChanged('dela cr'); // typing on: no answer to anything has been SHOWN yet, so there is nothing to narrow
    const s = t.last();
    assert.equal(s.phase, 'loading');
    assert.equal(s.preview, false, 'rows of a cancelled search must not come back as a preview');
    assert.deepEqual(s.members, []);
  });

  test('an old failure does not replace a newer answer either', async () => {
    const t = setup();
    t.search.searchNow('dela');
    t.search.searchNow('dela c');
    t.calls[1].answer.resolve(t.ok([JUAN]));
    await flush();
    t.calls[0].answer.resolve({ ok: false, failure: new ApiFailure(FailureKind.Network, 'down') });
    await flush();
    assert.equal(t.last().phase, 'results');
  });

  test('a search that is still waiting for its pause is dropped when a newer one starts', async () => {
    const t = setup();
    t.search.queryChanged('dela');
    t.search.searchNow('pedro');
    await t.advance(1000);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].query, 'pedro');
  });
});

describe('instant narrowing while the answer is on its way', () => {
  async function withResults(t, text, members) {
    const done = t.search.searchNow(text);
    t.calls.at(-1).answer.resolve(t.ok(members));
    await done;
  }

  test('typing more of the name keeps the rows that still match, marked as a preview', async () => {
    const t = setup();
    await withResults(t, 'dela', [JUAN, MARIA, ROSA]);
    t.search.queryChanged('dela c');
    const s = t.last();
    assert.equal(s.phase, 'loading');
    assert.equal(s.preview, true);
    assert.equal(s.stale, false);
    assert.deepEqual(s.members.map((m) => m.memberId), [1, 2]);
  });

  test('narrowing is accent- and case-blind, like the server', async () => {
    const t = setup();
    await withResults(t, 'jose', [member(4, 'A0004', 'Josefa Peña', 2), member(9, 'A0009', 'Jose Lopez', 1)]);
    t.search.queryChanged('josefa PEN');
    assert.deepEqual(t.last().members.map((m) => m.memberId), [4]);
    t.search.queryChanged('josefa pena');
    assert.deepEqual(t.last().members.map((m) => m.memberId), [4]);
  });

  test('a different text keeps the old rows on screen but says they are not the answer to it', async () => {
    const t = setup();
    await withResults(t, 'dela', [JUAN, MARIA]);
    t.search.queryChanged('pedro');
    const s = t.last();
    assert.equal(s.preview, false);
    assert.equal(s.stale, true);
    assert.deepEqual(s.members.map((m) => m.memberId), [1, 2]);
  });

  test('a list that was cut off cannot be narrowed (the match may not be among the rows)', async () => {
    const t = setup();
    await withResults(t, 'test', bulk(SERVER_ROW_CAP));
    t.search.queryChanged('test m');
    const s = t.last();
    assert.equal(s.preview, false);
    assert.equal(s.stale, true);
    assert.equal(s.members.length, SERVER_ROW_CAP);
  });

  test('after a failure or a too-short text nothing old is shown', async () => {
    const t = setup();
    await withResults(t, 'dela', [JUAN]);
    t.search.queryChanged('d');
    t.search.queryChanged('dela');
    assert.deepEqual(t.last().members, []);
    assert.equal(t.last().stale, false);

    const u = setup();
    const done = u.search.searchNow('dela');
    u.calls[0].answer.resolve({ ok: false, failure: new ApiFailure(FailureKind.Server, 'Boom.') });
    await done;
    u.search.queryChanged('dela c');
    assert.deepEqual(u.last().members, []);
  });

  test('an answer of "nobody" narrows to nobody', async () => {
    const t = setup();
    await withResults(t, 'zzz', []);
    t.search.queryChanged('zzzz');
    assert.equal(t.last().preview, true);
    assert.deepEqual(t.last().members, []);
  });

  test('narrowMembers: the folded text is inside the name or the account code', () => {
    assert.deepEqual(narrowMembers([JUAN, MARIA, PEDRO], 'dela').map((m) => m.memberId), [1, 2]);
    assert.deepEqual(narrowMembers([JUAN, MARIA, PEDRO], 'a0003').map((m) => m.memberId), [3]);
    assert.deepEqual(narrowMembers([JUAN], fold('zzz')), []);
  });
});

describe('when the search fails', () => {
  async function failWith(failure) {
    const t = setup();
    const done = t.search.searchNow('dela');
    t.calls[0].answer.resolve({ ok: false, failure });
    await done;
    return t;
  }

  test('the screen gets the reason in words, and the failure itself', async () => {
    const failure = new ApiFailure(FailureKind.Network, 'The server could not be reached.');
    const t = await failWith(failure);
    assert.equal(t.last().phase, 'error');
    assert.equal(t.last().message, describeSearchFailure(failure));
    assert.equal(t.last().failure, failure);
  });

  test('wording for every kind', () => {
    const f = (kind, message = 'MSG') => new ApiFailure(kind, message);
    assert.match(describeSearchFailure(f(FailureKind.Network)), /^The server cannot be reached, so members cannot be searched right now\./);
    assert.equal(describeSearchFailure(f(FailureKind.Timeout)), describeSearchFailure(f(FailureKind.Network)));
    assert.equal(describeSearchFailure(f(FailureKind.Cors, 'CORS words')), 'CORS words');
    assert.equal(describeSearchFailure(f(FailureKind.Csp, 'CSP words')), 'CSP words');
    assert.equal(describeSearchFailure(f(FailureKind.Unauthorized)), 'Your session has ended. Sign in again to continue.');
    assert.equal(describeSearchFailure(f(FailureKind.Server, 'Boom.')), 'Boom. Search again in a moment.');
    assert.equal(describeSearchFailure(f(FailureKind.RateLimited, 'Slow down.')), 'Slow down. Search again in a moment.');
    for (const kind of [FailureKind.Validation, FailureKind.NotFound, FailureKind.Forbidden, FailureKind.Conflict, FailureKind.Protocol]) {
      assert.equal(describeSearchFailure(f(kind, 'Odd.')), 'The server did not accept the search: Odd.', kind);
    }
  });

  test('a cancelled call is not a failure and shows nothing', async () => {
    const t = await failWith(new ApiFailure(FailureKind.Cancelled, 'cancelled'));
    assert.equal(t.last().phase, 'loading');
  });

  test('a call that throws is reported, not left spinning', async () => {
    const t = setup();
    t.ctx.handler = () => {
      throw new Error('bug');
    };
    await t.search.searchNow('dela');
    assert.equal(t.last().phase, 'error');
    assert.equal(t.last().message, 'The server did not accept the search: The search failed unexpectedly. Please try again.');
    assert.equal(t.last().failure.kind, FailureKind.Protocol);
  });
});

describe('reset, dispose, and patching a row', () => {
  test('reset shows the idle state, cancels the request on its way, and its answer never appears', async () => {
    const t = setup();
    t.search.searchNow('dela');
    t.search.reset();
    assert.equal(t.last().phase, 'idle');
    assert.equal(t.calls[0].signal.aborted, true);
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await flush();
    assert.equal(t.last().phase, 'idle');
  });

  test('reset also drops a search that was still waiting for its pause, and forgets old rows', async () => {
    const t = setup();
    const done = t.search.searchNow('dela');
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await done;
    t.search.queryChanged('dela c');
    t.search.reset();
    assert.equal(t.timers.pending, 0);
    t.search.queryChanged('dela');
    assert.deepEqual(t.last().members, []);
  });

  test('dispose: nothing is published afterwards', async () => {
    const t = setup();
    t.search.searchNow('dela');
    t.search.dispose();
    const shown = t.states.length;
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await flush();
    assert.equal(t.states.length, shown);
    assert.equal(t.calls[0].signal.aborted, true);
  });

  test('after a QR is issued the row on screen is updated, and a later narrowing starts from the updated row', async () => {
    const t = setup();
    const done = t.search.searchNow('dela');
    t.calls[0].answer.resolve(t.ok([JUAN, MARIA]));
    await done;
    const before = t.last().sequence;
    t.search.patchMember(1, { qrIssuedAt: '2026-11-03T02:00:05.000' });
    assert.ok(t.last().sequence > before);
    assert.equal(t.last().members.find((m) => m.memberId === 1).qrIssuedAt, '2026-11-03T02:00:05.000');
    assert.equal(t.last().members.find((m) => m.memberId === 2).qrIssuedAt, null);
    assert.equal(t.search.state.members.length, 2);

    t.search.queryChanged('dela c');
    assert.equal(t.last().members.find((m) => m.memberId === 1).qrIssuedAt, '2026-11-03T02:00:05.000');
  });

  test('patching a member who is not on screen says nothing', async () => {
    const t = setup();
    const done = t.search.searchNow('dela');
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await done;
    const shown = t.states.length;
    t.search.patchMember(999, { qrIssuedAt: 'x' });
    assert.equal(t.states.length, shown);
  });

  test('a screen that throws while being updated does not stop the search', async () => {
    let first = true;
    const t = setup({
      onState: () => {
        if (first) {
          first = false;
          throw new Error('screen bug');
        }
      },
    });
    const done = t.search.searchNow('dela');
    t.calls[0].answer.resolve(t.ok([JUAN]));
    await done;
    assert.equal(t.last().phase, 'results');
  });
});
