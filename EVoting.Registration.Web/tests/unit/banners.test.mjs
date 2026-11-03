// The notices across the top of the desk. A pure function of what is known, so every situation and its wording is checked here.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BannerActions, Severity, composeBanners } from '../../js/banners.js';
import { Reachability } from '../../js/connectivity.js';
import { ApiFailure, FailureKind } from '../../js/errors.js';
import { formatTime } from '../../js/format.js';

const fine = () => ({
  connectivity: { status: Reachability.Online, offlineSince: null, lastProblem: null },
  event: { status: 'open' },
  configProblem: null,
  needAttention: 0,
  signedIn: true,
});

const compose = (changes = {}) => composeBanners({ ...fine(), ...changes });
const keys = (banners) => banners.map((b) => b.key);

describe('nothing to say', () => {
  test('online, an election open, no records waiting: no notice', () => {
    assert.deepEqual(compose(), []);
  });

  test('before the first answer there is no notice either', () => {
    assert.deepEqual(compose({ connectivity: { status: Reachability.Unknown, offlineSince: null, lastProblem: null }, event: { status: 'unknown' } }), []);
  });
});

describe('the page cannot use the server', () => {
  test('a blocked address (CSP) says the page is set up with the wrong address', () => {
    const problem = new ApiFailure(FailureKind.Csp, 'Ask the administrator to run tools/set-api-url.mjs again.');
    const [b] = compose({ configProblem: problem });
    assert.equal(b.key, 'config');
    assert.equal(b.title, 'This page is set up with the wrong server address');
    assert.equal(b.detail, problem.message);
    assert.equal(b.severity, Severity.Critical);
    assert.equal(b.canDismiss, false);
  });

  test('a CORS block says the browser is blocking the connection', () => {
    const problem = new ApiFailure(FailureKind.Cors, 'The server does not list this site.');
    const [b] = compose({ configProblem: problem });
    assert.equal(b.title, 'The browser is blocking the connection to the server');
    assert.equal(b.detail, problem.message);
  });

  test('then "offline" and "could not find the election" would only repeat it, so they are left out', () => {
    const problem = new ApiFailure(FailureKind.Cors, 'x');
    const banners = compose({
      configProblem: problem,
      connectivity: { status: Reachability.Offline, offlineSince: Date.now(), lastProblem: problem },
      event: { status: 'error', message: 'x' },
    });
    assert.deepEqual(keys(banners), ['config']);
  });
});

describe('the election', () => {
  test('none open: a warning with a way to check again', () => {
    const [b] = compose({ event: { status: 'none' } });
    assert.deepEqual(
      { key: b.key, title: b.title, detail: b.detail, severity: b.severity, action: b.actionKey, actionText: b.actionText },
      { key: 'event', title: 'No election is open', detail: 'Registration is closed until an administrator opens one.', severity: Severity.Warning, action: BannerActions.Refresh, actionText: 'Check again' },
    );
  });

  test('could not find out: the server\'s reason, or a plain sentence', () => {
    const [withReason] = compose({ event: { status: 'error', message: 'The current-election answer was not usable.' } });
    assert.equal(withReason.title, 'Could not find out which election is open');
    assert.equal(withReason.detail, 'The current-election answer was not usable.');
    assert.equal(withReason.actionText, 'Try again');
    const [plain] = compose({ event: { status: 'error' } });
    assert.equal(plain.detail, 'The server did not give a usable answer.');
  });

  test('nothing about elections before sign-in', () => {
    assert.deepEqual(compose({ signedIn: false, event: { status: 'none' } }), []);
    assert.deepEqual(compose({ signedIn: false, event: { status: 'error', message: 'x' } }), []);
  });
});

describe('offline', () => {
  test('says since when, and that this web version needs the server', () => {
    const since = new Date(2026, 10, 3, 9, 41).getTime();
    const [b] = compose({ connectivity: { status: Reachability.Offline, offlineSince: since, lastProblem: null } });
    assert.equal(b.key, 'offline');
    assert.equal(b.title, 'Offline - QR codes cannot be issued');
    assert.ok(b.detail.startsWith(`The server has not answered since ${formatTime(new Date(since))}. `), b.detail);
    assert.match(b.detail, /works only while the server answers/);
    assert.match(b.detail, /Windows Registration station can keep working offline/);
    assert.equal(b.severity, Severity.Warning);
    assert.equal(b.canDismiss, false);
  });

  test('without a time it still says so', () => {
    const [b] = compose({ connectivity: { status: Reachability.Offline, offlineSince: null, lastProblem: null } });
    assert.ok(b.detail.startsWith('The server is not answering. '), b.detail);
  });

  test('is shown on the sign-in screen too', () => {
    const banners = compose({ signedIn: false, connectivity: { status: Reachability.Offline, offlineSince: null, lastProblem: null } });
    assert.deepEqual(keys(banners), ['offline']);
  });
});

describe('the server answered, but not well', () => {
  test('a server error is shown with its words - and is not called offline', () => {
    const problem = new ApiFailure(FailureKind.Server, 'The server could not complete the request (HTTP 502).', { status: 502 });
    const banners = compose({ connectivity: { status: Reachability.Online, offlineSince: null, lastProblem: problem } });
    assert.deepEqual(keys(banners), ['server-problem']);
    assert.equal(banners[0].title, 'The server answered with a problem');
    assert.equal(banners[0].detail, problem.message);
  });
});

describe('records that need a person', () => {
  test('one record: "needs"; several: "need"', () => {
    assert.equal(compose({ needAttention: 1 })[0].title, '1 QR issuance record needs attention');
    assert.equal(compose({ needAttention: 2 })[0].title, '2 QR issuance records need attention');
    assert.equal(compose({ needAttention: 40 })[0].title, '40 QR issuance records need attention');
    // the sentence under the title agrees with the number as well
    assert.match(compose({ needAttention: 1 })[0].detail, /did not record it, or did not answer\. No slip was printed for it\./);
    assert.match(compose({ needAttention: 2 })[0].detail, /did not record them, or did not answer\. No slip was printed for them\./);
  });

  test('critical, with a button that opens the review list', () => {
    const [b] = compose({ needAttention: 3 });
    assert.equal(b.key, 'records');
    assert.equal(b.severity, Severity.Critical);
    assert.equal(b.canDismiss, false);
    assert.equal(b.actionKey, BannerActions.ReviewRecords);
    assert.equal(b.actionText, 'Review');
    assert.match(b.detail, /No slip was printed for them/);
  });

  test('not before sign-in, and not when there are none', () => {
    assert.deepEqual(compose({ signedIn: false, needAttention: 3 }), []);
    assert.deepEqual(compose({ needAttention: 0 }), []);
  });
});

describe('order and notes', () => {
  test('the most serious first; otherwise in the order they were found', () => {
    const banners = compose({
      needAttention: 2,
      event: { status: 'none' },
      connectivity: { status: Reachability.Offline, offlineSince: null, lastProblem: null },
      extra: [{ key: 'note', title: 'Heads up' }],
    });
    assert.deepEqual(keys(banners), ['records', 'event', 'offline', 'note']);
    const severities = banners.map((b) => b.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => b - a));
  });

  test('a configuration problem is above everything', () => {
    const banners = compose({ needAttention: 1, configProblem: new ApiFailure(FailureKind.Csp, 'x') });
    assert.deepEqual(keys(banners), ['config', 'records']);
  });

  test('a note the page wants to show is informational and can be dismissed - unless it says otherwise', () => {
    const [note] = compose({ extra: [{ key: 'election-changed', title: 'The election changed' }] });
    assert.equal(note.severity, Severity.Info);
    assert.equal(note.canDismiss, true);
    const [sticky] = compose({ extra: [{ key: 'x', title: 'Stays', canDismiss: false, severity: Severity.Warning }] });
    assert.equal(sticky.canDismiss, false);
    assert.equal(sticky.severity, Severity.Warning);
  });

  test('a dismissed note is gone, but a serious notice can never be dismissed away', () => {
    const extra = [{ key: 'election-changed', title: 'The election changed' }];
    assert.deepEqual(compose({ extra, dismissed: new Set(['election-changed']) }), []);
    const banners = compose({ needAttention: 1, extra, dismissed: new Set(['records', 'election-changed']) });
    assert.deepEqual(keys(banners), ['records']);
  });
});
