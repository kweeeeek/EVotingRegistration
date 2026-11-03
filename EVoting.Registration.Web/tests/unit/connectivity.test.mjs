// Is the server answering? "Offline" must mean exactly one thing: the server gave no answer at all.
// A refusal (401, 404, 400) is an answer; a server error is "online, with a problem"; a CORS/CSP block is shown as a setup problem.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Reachability, createConnectivity } from '../../js/connectivity.js';
import { ApiFailure, FailureKind } from '../../js/errors.js';
import { createClock, createTimers, deferred, flush } from './helpers.mjs';

const failure = (kind, message = kind, status = null) => new ApiFailure(kind, message, { status });

function setup({ ping, intervalMs = 30000, visible = () => true } = {}) {
  const clock = createClock();
  const timers = createTimers(clock);
  const pings = [];
  const heard = [];
  let nextPing = ping ?? (async () => ({ ok: true }));
  const connectivity = createConnectivity({
    ping: async () => {
      pings.push(clock.now());
      return nextPing();
    },
    intervalMs,
    now: clock.now,
    isVisible: visible,
    timers,
  });
  connectivity.subscribe((s) => heard.push(s));
  return {
    c: connectivity,
    clock,
    timers,
    pings,
    heard,
    answerWith(fn) {
      nextPing = fn;
    },
    /** Moves time and lets the page's async code finish. */
    async advance(ms) {
      timers.advance(ms);
      await flush();
    },
  };
}

describe('what each answer means for the indicator', () => {
  test('nothing tried yet: unknown', () => {
    const { c } = setup();
    assert.equal(c.state.status, Reachability.Unknown);
    assert.equal(c.state.offlineSince, null);
    assert.equal(c.state.lastContactAt, null);
    assert.equal(c.state.lastProblem, null);
  });

  test('a good answer: online', () => {
    const { c, clock } = setup();
    c.noteOutcome({ status: 200, failure: null });
    assert.equal(c.state.status, Reachability.Online);
    assert.equal(c.state.lastContactAt, clock.now());
  });

  test('no answer at all (network, timeout): offline, since when', () => {
    for (const kind of [FailureKind.Network, FailureKind.Timeout]) {
      const { c, clock } = setup();
      c.noteOutcome({ status: null, failure: failure(kind) });
      assert.equal(c.state.status, Reachability.Offline, kind);
      assert.equal(c.state.offlineSince, clock.now(), kind);
      assert.equal(c.state.lastProblem, null, `${kind}: offline is not a "problem" answer`);
    }
  });

  test('the answers of a server that IS there are never "offline": 400, 401, 403, 404, 409, 422, 429', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      const { c } = setup();
      const kinds = { 400: FailureKind.Validation, 401: FailureKind.Unauthorized, 403: FailureKind.Forbidden, 404: FailureKind.NotFound, 409: FailureKind.Conflict, 422: FailureKind.Validation, 429: FailureKind.RateLimited };
      c.noteOutcome({ status, failure: failure(kinds[status], 'no', status) });
      assert.equal(c.state.status, Reachability.Online, `HTTP ${status}`);
      assert.equal(c.state.lastProblem, null, `HTTP ${status}`);
    }
  });

  test('a server error is online with a problem to show', () => {
    const { c } = setup();
    const f = failure(FailureKind.Server, 'The server could not complete the request (HTTP 502).', 502);
    c.noteOutcome({ status: 502, failure: f });
    assert.equal(c.state.status, Reachability.Online);
    assert.equal(c.state.lastProblem, f);
    c.noteOutcome({ status: 200, failure: null });
    assert.equal(c.state.lastProblem, null, 'the next good answer clears it');
  });

  test('a CORS or CSP block is shown as offline, with the setup problem attached', () => {
    for (const kind of [FailureKind.Cors, FailureKind.Csp]) {
      const { c } = setup();
      const f = failure(kind, 'blocked');
      c.noteOutcome({ status: null, failure: f });
      assert.equal(c.state.status, Reachability.Offline, kind);
      assert.equal(c.state.lastProblem, f, kind);
    }
  });

  test('a cancelled call says nothing about the server', () => {
    const { c, heard } = setup();
    c.noteOutcome({ status: null, failure: failure(FailureKind.Cancelled) });
    assert.equal(c.state.status, Reachability.Unknown);
    assert.equal(heard.length, 0);
    c.noteOutcome({ status: 200, failure: null });
    c.noteOutcome({ status: null, failure: failure(FailureKind.Cancelled) });
    assert.equal(c.state.status, Reachability.Online);
  });

  test('"offline since" is when it STARTED, not when it was last noticed; coming back clears it', () => {
    const { c, clock } = setup();
    c.noteOutcome({ status: 200, failure: null });
    clock.advance(10_000);
    c.noteOutcome({ status: null, failure: failure(FailureKind.Network) });
    const since = c.state.offlineSince;
    assert.equal(since, clock.now());
    clock.advance(60_000);
    c.noteOutcome({ status: null, failure: failure(FailureKind.Timeout) });
    assert.equal(c.state.offlineSince, since);
    clock.advance(1000);
    c.noteOutcome({ status: 200, failure: null });
    assert.equal(c.state.status, Reachability.Online);
    assert.equal(c.state.offlineSince, null);
    assert.equal(c.state.lastContactAt, clock.now());
  });
});

describe('who is told', () => {
  test('listeners hear about a change once - not again for the same news', () => {
    const { c, heard } = setup();
    c.noteOutcome({ status: 200, failure: null });
    c.noteOutcome({ status: 200, failure: null });
    c.noteOutcome({ status: 200, failure: null });
    assert.equal(heard.length, 1);
    c.noteOutcome({ status: null, failure: failure(FailureKind.Network) });
    c.noteOutcome({ status: null, failure: failure(FailureKind.Network) });
    assert.equal(heard.length, 2);
    assert.deepEqual(heard.map((s) => s.status), [Reachability.Online, Reachability.Offline]);
  });

  test('a different server problem is news; the same one again is not', () => {
    const { c, heard } = setup();
    c.noteOutcome({ status: 500, failure: failure(FailureKind.Server, 'one', 500) });
    c.noteOutcome({ status: 500, failure: failure(FailureKind.Server, 'one', 500) });
    assert.equal(heard.length, 1);
    c.noteOutcome({ status: 500, failure: failure(FailureKind.Server, 'two', 500) });
    assert.equal(heard.length, 2);
  });

  test('what a listener gets is a copy', () => {
    const { c, heard } = setup();
    c.noteOutcome({ status: 200, failure: null });
    heard[0].status = Reachability.Offline;
    c.state.status = Reachability.Offline;
    assert.equal(c.state.status, Reachability.Online);
  });

  test('unsubscribing works, and a listener that throws does not stop the others', () => {
    const { c } = setup();
    const seen = [];
    c.subscribe(() => {
      throw new Error('listener bug');
    });
    const off = c.subscribe((s) => seen.push(s.status));
    c.noteOutcome({ status: 200, failure: null });
    assert.deepEqual(seen, [Reachability.Online]);
    off();
    c.noteOutcome({ status: null, failure: failure(FailureKind.Network) });
    assert.deepEqual(seen, [Reachability.Online]);
  });
});

describe('the light check (GET health/live)', () => {
  test('the first check is made at once, then one every 30 seconds', async () => {
    const { c, pings, advance } = setup();
    c.start();
    assert.equal(pings.length, 0, 'nothing happens inside start() itself');
    await advance(0);
    assert.equal(pings.length, 1);
    assert.equal(c.state.status, Reachability.Online);
    await advance(29_999);
    assert.equal(pings.length, 1);
    await advance(1);
    assert.equal(pings.length, 2);
    await advance(30_000);
    assert.equal(pings.length, 3);
  });

  test('a call that already reached the server counts: no need to ask again so soon', async () => {
    const { c, pings, advance } = setup();
    c.start();
    await advance(0);
    await advance(20_000);
    c.noteOutcome({ status: 200, failure: null }); // an ordinary search got through at +20 s
    await advance(10_000); // the check at +30 s sees a contact only 10 s old
    assert.equal(pings.length, 1);
    await advance(30_000); // at +60 s the last contact is 40 s old
    assert.equal(pings.length, 2);
  });

  test('a hidden page is not pinged, but the rhythm continues', async () => {
    let visible = false;
    const { c, pings, advance } = setup({ visible: () => visible });
    c.start();
    await advance(0);
    await advance(30_000);
    await advance(30_000);
    assert.equal(pings.length, 0);
    visible = true;
    await advance(30_000);
    assert.equal(pings.length, 1);
  });

  test('no answer: offline, and looked at again every 8 seconds until it comes back', async () => {
    const { c, pings, advance, answerWith, heard } = setup();
    answerWith(async () => ({ ok: false, failure: failure(FailureKind.Network) }));
    c.start();
    await advance(0);
    assert.equal(c.state.status, Reachability.Offline);
    await advance(7_999);
    assert.equal(pings.length, 1);
    await advance(1);
    assert.equal(pings.length, 2);
    await advance(8_000);
    assert.equal(pings.length, 3);

    answerWith(async () => ({ ok: true }));
    await advance(8_000);
    assert.equal(c.state.status, Reachability.Online);
    assert.equal(c.state.offlineSince, null);
    assert.deepEqual(heard.map((s) => s.status), [Reachability.Offline, Reachability.Online]);
    await advance(29_999);
    assert.equal(pings.length, 4, 'back to the normal 30-second rhythm');
    await advance(1);
    assert.equal(pings.length, 5);
  });

  test('a refusal from the server (not an outage) is not offline', async () => {
    const { c, advance, answerWith } = setup();
    answerWith(async () => ({ ok: false, failure: failure(FailureKind.Server, 'down for maintenance', 503), status: 503 }));
    c.start();
    await advance(0);
    assert.equal(c.state.status, Reachability.Online);
    assert.equal(c.state.lastProblem.message, 'down for maintenance');
  });

  test('a check that blows up does not stop the checking', async () => {
    const { c, pings, advance, answerWith } = setup();
    answerWith(async () => {
      throw new Error('bug in ping');
    });
    c.start();
    await advance(0);
    await advance(30_000);
    assert.equal(pings.length, 2);
  });

  test('start() twice is one loop; stop() ends it and leaves no timer behind; start() again works', async () => {
    const { c, timers, pings, advance } = setup();
    c.start();
    c.start();
    assert.equal(timers.pending, 1);
    await advance(0);
    c.stop();
    assert.equal(timers.pending, 0);
    await advance(120_000);
    assert.equal(pings.length, 1);
    c.start();
    await advance(0);
    assert.equal(pings.length, 2);
  });

  test('stopping while a check is on its way: its answer is taken, nothing more is scheduled', async () => {
    const gate = deferred();
    const { c, timers, advance } = setup({ ping: async () => gate.promise });
    c.start();
    await advance(0);
    c.stop();
    gate.resolve({ ok: true });
    await flush();
    assert.equal(timers.pending, 0);
  });

  test('the browser saying "network back" triggers a check at once, even if the server was heard from a moment ago', async () => {
    const { c, pings, advance } = setup();
    c.start();
    await advance(0);
    await advance(1_000);
    c.hint();
    await advance(0);
    assert.equal(pings.length, 2);
  });

  test('a hint to a stopped loop does nothing', async () => {
    const { c, timers, pings, advance } = setup();
    c.hint();
    await advance(0);
    assert.equal(timers.pending, 0);
    assert.equal(pings.length, 0);
  });

  test('a hint while a check is on its way is not lost, and never leaves two loops running', async () => {
    const gate = deferred();
    let first = true;
    const { c, timers, pings, advance } = setup({
      ping: async () => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return { ok: true };
      },
    });
    c.start();
    await advance(0); // check 1 is on its way
    c.hint(); // "the network came back" while it is
    gate.resolve({ ok: false, failure: failure(FailureKind.Network) }); // check 1 ends: it started before the change
    await flush();
    await advance(0);
    assert.equal(pings.length, 2, 'the hint must lead to a fresh check, not wait for the next round');
    assert.equal(c.state.status, Reachability.Online);
    assert.equal(timers.pending, 1, 'exactly one timer for the next round');
    await advance(30_000);
    assert.equal(pings.length, 3, 'one check per round');
  });

  test('many hints in a row are one loop, not many', async () => {
    const { c, timers, pings, advance } = setup();
    c.start();
    await advance(0);
    for (let i = 0; i < 5; i++) c.hint();
    assert.equal(timers.pending, 1);
    await advance(0);
    assert.equal(pings.length, 2);
    assert.equal(timers.pending, 1);
  });
});
