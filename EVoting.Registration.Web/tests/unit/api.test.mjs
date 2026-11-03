// The only module that talks to the server. Run against a fetch that records what it was asked and answers as the test says.
// Proves: what is sent (and what is never sent), how every answer is read, and how "no answer at all" is told apart.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FailureKind } from '../../js/errors.js';
import {
  CURRENT_EVENT_PATH,
  HEALTH_PATH,
  LOGIN_PATH,
  SEARCH_PATH,
  createApi,
  normalizeBase,
  normalizeEvent,
  normalizeMember,
  qrIssuedPath,
  validateApiBaseUrl,
} from '../../js/api.js';
import { abortError, jsonResponse, networkError } from './helpers.mjs';

const API = 'https://api.test/';
const TOKEN = 'header.payload.SECRET-SIGNATURE';

function makeFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const call = { url: String(url), init, method: init.method ?? 'GET', headers: init.headers ?? {} };
    calls.push(call);
    return handler(call, calls.length);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/** A request that never gets an answer, until the page gives up on it. */
const hangs = (init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });

function setup({ handler = () => jsonResponse(200, {}), token = TOKEN, sameOrigin = false, ...options } = {}) {
  const ctx = { token, outcomes: [], unauthorized: 0 };
  ctx.fetchFn = makeFetch(handler);
  ctx.api = createApi({
    base: API,
    sameOrigin,
    getToken: () => ctx.token,
    fetchFn: ctx.fetchFn,
    onOutcome: (o) => ctx.outcomes.push(o),
    onUnauthorized: () => {
      ctx.unauthorized++;
    },
    ...options,
  });
  return ctx;
}

const loginAnswer = { accessToken: 'a.b.c', expiresIn: 28800, role: 'Registration' };

describe('the server address', () => {
  test('an empty address means "the same site as this page"', () => {
    assert.deepEqual(normalizeBase('', 'https://reg.test'), { base: 'https://reg.test/', sameOrigin: true, origin: 'https://reg.test' });
    assert.equal(normalizeBase(undefined, 'https://reg.test').sameOrigin, true);
    assert.equal(normalizeBase('   ', 'https://reg.test').sameOrigin, true);
  });

  test('another address is cross-site, and always ends with a slash', () => {
    assert.deepEqual(normalizeBase('https://api.test', 'https://reg.test'), { base: 'https://api.test/', sameOrigin: false, origin: 'https://api.test' });
    assert.equal(normalizeBase('https://api.test/', 'https://reg.test').base, 'https://api.test/');
    assert.equal(normalizeBase('https://reg.test/backend', 'https://reg.test').base, 'https://reg.test/backend/');
  });

  test('the page\'s own address, written out, is still the same site', () => {
    assert.equal(normalizeBase('https://reg.test', 'https://reg.test').sameOrigin, true);
    assert.equal(normalizeBase('https://reg.test:8443', 'https://reg.test').sameOrigin, false);
    assert.equal(normalizeBase('http://reg.test', 'https://reg.test').sameOrigin, false);
  });

  test('a rubbish address throws, so the page can say it is not set up correctly', () => {
    assert.throws(() => normalizeBase('not a url', 'https://reg.test'), TypeError);
  });

  test('https is required: a password and a token never cross the network in clear text', () => {
    for (const ok of ['', '  ', 'https://api.test', 'https://api.test:8443/base', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000', undefined, null]) {
      assert.equal(validateApiBaseUrl(ok), null, String(ok));
    }
    for (const bad of ['http://api.test', 'ftp://api.test', 'ws://api.test', 'file:///c:/x']) {
      assert.match(validateApiBaseUrl(bad), /must start with https:\/\//, bad);
    }
  });

  test('a host that only looks like localhost is not localhost', () => {
    assert.match(validateApiBaseUrl('http://localhost.evil.test'), /https:\/\//);
    assert.match(validateApiBaseUrl('http://127.0.0.1.evil.test'), /https:\/\//);
    assert.match(validateApiBaseUrl('http://evil.test/localhost'), /https:\/\//);
  });

  test('no user name, password, query or fragment in the address; and it must be an address', () => {
    assert.match(validateApiBaseUrl('https://user:pw@api.test'), /must not contain a user name or password/);
    assert.match(validateApiBaseUrl('https://user@api.test'), /must not contain a user name or password/);
    assert.match(validateApiBaseUrl('https://api.test/?a=1'), /must not contain a query or a fragment/);
    assert.match(validateApiBaseUrl('https://api.test/#x'), /must not contain a query or a fragment/);
    assert.match(validateApiBaseUrl('not a url'), /"not a url" in config\.js is not a valid address/);
  });

  test('the paths are the API\'s', () => {
    assert.equal(LOGIN_PATH, 'api/v1/auth/registration-login');
    assert.equal(CURRENT_EVENT_PATH, 'api/v1/events/current');
    assert.equal(SEARCH_PATH, 'api/v1/registration/members/search');
    assert.equal(HEALTH_PATH, 'api/v1/health/live');
    assert.equal(qrIssuedPath(42), 'api/v1/registration/members/42/qr-issued');
  });

  test('a member id can never change the path it is put into', () => {
    assert.equal(qrIssuedPath('1/../2'), 'api/v1/registration/members/1%2F..%2F2/qr-issued');
    assert.equal(qrIssuedPath('a?b#c'), 'api/v1/registration/members/a%3Fb%23c/qr-issued');
  });
});

describe('a member as the server sends it', () => {
  const wire = {
    memberId: 12,
    accountCode: 'A0012',
    memberName: 'Ana Reyes',
    memberContactNumber: '0917 000 0000',
    memberAddress: 'Poblacion',
    branchId: 2,
    branch: 'East Branch',
    shareCapital: 12500,
    savingsDeposit: 4300.5,
    loanStatus: 1,
    isEligibleToVote: true,
    votingRemarks: 'Good standing',
    qrIssuedAt: '2026-11-03T01:30:00.000',
    isActive: true,
  };

  test('a complete row is kept as it is', () => {
    assert.deepEqual(normalizeMember(wire), wire);
  });

  test('numbers sent as text are read as numbers', () => {
    const m = normalizeMember({ ...wire, memberId: '12', branchId: '2', loanStatus: '2', shareCapital: '100.5' });
    assert.deepEqual([m.memberId, m.branchId, m.loanStatus, m.shareCapital], [12, 2, 2, 100.5]);
  });

  test('a row without a usable id is dropped - nothing can be issued for it', () => {
    for (const bad of [{ ...wire, memberId: 0 }, { ...wire, memberId: -3 }, { ...wire, memberId: 'x' }, { ...wire, memberId: null }, { accountCode: 'A1' }, null, undefined, 'text', 7, []]) {
      assert.equal(normalizeMember(bad), null, JSON.stringify(bad));
    }
  });

  test('missing fields get safe values, and "eligible" is only ever an explicit true', () => {
    const m = normalizeMember({ memberId: 5 });
    assert.deepEqual(m, {
      memberId: 5,
      accountCode: '',
      memberName: '',
      memberContactNumber: null,
      memberAddress: null,
      branchId: 0,
      branch: '',
      shareCapital: 0,
      savingsDeposit: 0,
      loanStatus: 0,
      isEligibleToVote: false,
      votingRemarks: null,
      qrIssuedAt: null,
      isActive: false,
    });
    for (const notTrue of ['true', 1, 'yes', {}, [true]]) {
      assert.equal(normalizeMember({ memberId: 5, isEligibleToVote: notTrue, isActive: notTrue }).isEligibleToVote, false, String(notTrue));
      assert.equal(normalizeMember({ memberId: 5, isEligibleToVote: notTrue, isActive: notTrue }).isActive, false, String(notTrue));
    }
  });

  test('a blank QR time is "never issued"', () => {
    assert.equal(normalizeMember({ memberId: 5, qrIssuedAt: '' }).qrIssuedAt, null);
    assert.equal(normalizeMember({ memberId: 5, qrIssuedAt: '   ' }).qrIssuedAt, null);
    assert.equal(normalizeMember({ memberId: 5, qrIssuedAt: 12345 }).qrIssuedAt, null);
  });
});

describe('the open election as the server sends it', () => {
  test('id, title, branches and schedule', () => {
    const e = normalizeEvent({
      eventId: 7,
      title: 'General Assembly',
      venue: 'Hall',
      scheduleFrom: '2026-11-03T08:00:00',
      scheduleTo: '2026-11-03T17:00:00',
      status: 'Active',
      branches: [{ branchId: 1 }, { branchId: 2 }, { branchId: '3' }],
    });
    assert.equal(e.eventId, 7);
    assert.equal(e.title, 'General Assembly');
    assert.equal(e.venue, 'Hall');
    assert.equal(e.status, 'Active');
    assert.deepEqual(e.branchIds, [1, 2, 3]);
    assert.equal(e.scheduleFrom.getHours(), 8);
    assert.equal(e.scheduleTo.getHours(), 17);
  });

  test('branches are listed once, and entries that are not branches are skipped', () => {
    assert.deepEqual(normalizeEvent({ eventId: 1, branches: [{ branchId: 2 }, { branchId: 2 }, { branchId: 0 }, null, 'x', { name: 'no id' }, { branchId: -1 }] }).branchIds, [2]);
    assert.deepEqual(normalizeEvent({ eventId: 1 }).branchIds, []);
    assert.deepEqual(normalizeEvent({ eventId: 1, branches: 'all' }).branchIds, []);
  });

  test('without a usable id it is not an election', () => {
    for (const bad of [{}, { eventId: 0 }, { eventId: 'x' }, null, undefined, [], 'x', 5]) assert.equal(normalizeEvent(bad), null, JSON.stringify(bad));
  });

  test('missing text is empty text, a missing schedule is null', () => {
    const e = normalizeEvent({ eventId: 1 });
    assert.deepEqual([e.title, e.venue, e.status, e.scheduleFrom, e.scheduleTo], ['', '', '', null, null]);
  });
});

describe('what is sent', () => {
  test('every call: no cookies, no redirect followed, no referrer, no cache, cross-origin mode, JSON wanted', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, []) });
    await ctx.api.login('clerk', 'pw');
    await ctx.api.getCurrentEvent();
    await ctx.api.searchMembers('ab', [1]);
    await ctx.api.markQrIssued(5);
    await ctx.api.ping();
    assert.equal(ctx.fetchFn.calls.length, 5);
    for (const { url, init, headers } of ctx.fetchFn.calls) {
      assert.equal(init.credentials, 'omit', url);
      assert.equal(init.redirect, 'error', url);
      assert.equal(init.referrerPolicy, 'no-referrer', url);
      assert.equal(init.cache, 'no-store', url);
      assert.equal(init.mode, 'cors', url);
      assert.equal(headers.Accept, 'application/json', url);
      assert.ok(init.signal instanceof AbortSignal, url);
    }
  });

  test('the token goes in the Authorization header of the calls that need it - and nowhere else', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, []) });
    await ctx.api.login('clerk', 'pw');
    await ctx.api.getCurrentEvent();
    await ctx.api.searchMembers('ab', [1]);
    await ctx.api.markQrIssued(5);
    await ctx.api.ping();
    const [login, event, search, issue, ping] = ctx.fetchFn.calls;
    assert.equal(login.headers.Authorization, undefined, 'sign-in is anonymous');
    assert.equal(ping.headers.Authorization, undefined, 'the health check is anonymous');
    for (const call of [event, search, issue]) assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`, call.url);
    for (const call of ctx.fetchFn.calls) {
      assert.ok(!call.url.includes('SECRET'), `the token is in the address of ${call.url}`);
      assert.ok(!String(call.init.body ?? '').includes('SECRET'), `the token is in the body of ${call.url}`);
      assert.ok(!Object.entries(call.headers).some(([name, value]) => name !== 'Authorization' && String(value).includes('SECRET')), `the token is in another header of ${call.url}`);
    }
  });

  test('sign-in: POST, JSON body with exactly the user name and password, to the sign-in address', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, loginAnswer) });
    await ctx.api.login('clerk', 'correct horse');
    const [call] = ctx.fetchFn.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.test/api/v1/auth/registration-login');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(call.init.body), { username: 'clerk', password: 'correct horse' });
  });

  test('search: the typed text and every branch as query parameters, encoded', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, []) });
    await ctx.api.searchMembers('peña & co=1', [1, 2, 3]);
    const [call] = ctx.fetchFn.calls;
    const url = new URL(call.url);
    assert.equal(call.method, 'GET');
    assert.equal(url.origin + url.pathname, 'https://api.test/api/v1/registration/members/search');
    assert.equal(url.searchParams.get('query'), 'peña & co=1');
    assert.deepEqual(url.searchParams.getAll('branchIds'), ['1', '2', '3']);
    assert.equal(call.init.body, undefined);
    assert.equal(call.headers['Content-Type'], undefined, 'a GET has no body, so no content type');
  });

  test('search with no branch asks nothing and finds nothing', async () => {
    const ctx = setup();
    assert.deepEqual(await ctx.api.searchMembers('ab', []), { ok: true, members: [] });
    assert.deepEqual(await ctx.api.searchMembers('ab', undefined), { ok: true, members: [] });
    assert.equal(ctx.fetchFn.calls.length, 0);
  });

  test('issue: POST with no body to the member\'s qr-issued address', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, { memberId: 42, qrIssuedAt: '2026-11-03T02:00:00.000' }) });
    await ctx.api.markQrIssued(42);
    const [call] = ctx.fetchFn.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.test/api/v1/registration/members/42/qr-issued');
    assert.equal(call.init.body, undefined);
    assert.equal(call.headers['Content-Type'], undefined);
  });

  test('a base address with a path keeps the path', async () => {
    const ctx = setup({ base: 'https://reg.test/backend/', sameOrigin: true, handler: () => jsonResponse(200, {}) });
    await ctx.api.ping();
    assert.equal(ctx.fetchFn.calls[0].url, 'https://reg.test/backend/api/v1/health/live');
  });

  test('the real fetch is looked up when a call is made, so a test (or the browser) can replace it', async () => {
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return jsonResponse(200, {});
    };
    try {
      const api = createApi({ base: API, sameOrigin: false, getToken: () => null });
      assert.deepEqual(await api.ping(), { ok: true });
      assert.deepEqual(seen, ['https://api.test/api/v1/health/live']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('sign-in answers', () => {
  test('success gives the token, its lifetime and the role', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, loginAnswer) });
    assert.deepEqual(await ctx.api.login('clerk', 'pw'), { ok: true, accessToken: 'a.b.c', expiresInSeconds: 28800, role: 'Registration' });
  });

  test('a wrong password is the server\'s sentence, and it does NOT end an existing session', async () => {
    const ctx = setup({ handler: () => jsonResponse(401, { error: 'Invalid username or password.' }) });
    const r = await ctx.api.login('clerk', 'bad');
    assert.equal(r.ok, false);
    assert.equal(r.failure.kind, FailureKind.Unauthorized);
    assert.equal(r.failure.message, 'Invalid username or password.');
    assert.equal(ctx.unauthorized, 0, 'a refused password is not a lost session');
  });

  test('an answer without a token, or without a lifetime, is not a sign-in', async () => {
    for (const body of [{}, { accessToken: 'a.b.c' }, { accessToken: 'a.b.c', expiresIn: 0 }, { accessToken: '', expiresIn: 60 }, { accessToken: 7, expiresIn: 60 }, null]) {
      const ctx = setup({ handler: () => jsonResponse(200, body === null ? 'null' : body) });
      const r = await ctx.api.login('clerk', 'pw');
      assert.equal(r.ok, false, JSON.stringify(body));
      assert.equal(r.failure.kind, FailureKind.Protocol, JSON.stringify(body));
    }
  });

  test('the lifetime may arrive as text', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, { accessToken: 'a.b.c', expiresIn: '3600', role: 'Registration' }) });
    assert.equal((await ctx.api.login('clerk', 'pw')).expiresInSeconds, 3600);
  });

  test('too many attempts: the wait the server asked for is kept', async () => {
    const ctx = setup({ handler: () => jsonResponse(429, { error: 'Slow down.' }, { 'Retry-After': '30' }) });
    const r = await ctx.api.login('clerk', 'pw');
    assert.equal(r.failure.kind, FailureKind.RateLimited);
    assert.equal(r.failure.retryAfterSeconds, 30);
  });

  test('a Retry-After written as a date is ignored, not misread', async () => {
    const ctx = setup({ handler: () => jsonResponse(429, '', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }) });
    assert.equal((await ctx.api.login('clerk', 'pw')).failure.retryAfterSeconds, null);
  });
});

describe('the open election', () => {
  const wire = { eventId: 7, title: 'GA', venue: 'Hall', status: 'Active', scheduleFrom: '2026-11-03T08:00:00', scheduleTo: '2026-11-03T17:00:00', branches: [{ branchId: 1 }, { branchId: 2 }] };

  test('an election', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, wire) });
    const r = await ctx.api.getCurrentEvent();
    assert.equal(r.ok, true);
    assert.equal(r.event.eventId, 7);
    assert.deepEqual(r.event.branchIds, [1, 2]);
  });

  test('"no election is open" is the API\'s own 404 with its envelope - that is an answer, not an error', async () => {
    const ctx = setup({ handler: () => jsonResponse(404, { error: 'No active event.' }) });
    assert.deepEqual(await ctx.api.getCurrentEvent(), { ok: true, event: null });
  });

  test('a 404 from anything else (a proxy, a wrong address) is a wrong address, not "no election"', async () => {
    const ctx = setup({ handler: () => new Response('<html>404 Not Found</html>', { status: 404 }) });
    const r = await ctx.api.getCurrentEvent();
    assert.equal(r.ok, false);
    assert.equal(r.failure.kind, FailureKind.NotFound);
    assert.match(r.failure.message, /did not recognise the current-election address/);
  });

  test('an answer that is not an election is a protocol problem', async () => {
    for (const body of [{}, [], { eventId: 0 }]) {
      const ctx = setup({ handler: () => jsonResponse(200, body) });
      const r = await ctx.api.getCurrentEvent();
      assert.equal(r.ok, false, JSON.stringify(body));
      assert.equal(r.failure.kind, FailureKind.Protocol, JSON.stringify(body));
    }
  });

  test('other failures pass through unchanged', async () => {
    const ctx = setup({ handler: () => jsonResponse(500, { error: 'Boom.' }) });
    const r = await ctx.api.getCurrentEvent();
    assert.equal(r.failure.kind, FailureKind.Server);
    assert.equal(r.failure.message, 'Boom.');
  });
});

describe('search answers', () => {
  test('rows are normalised and rows without an id are dropped', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, [{ memberId: 1, accountCode: 'A1', memberName: 'Ana', isEligibleToVote: true, isActive: true }, { accountCode: 'no id' }, null, 'junk']) });
    const r = await ctx.api.searchMembers('an', [1]);
    assert.equal(r.ok, true);
    assert.equal(r.members.length, 1);
    assert.equal(r.members[0].memberId, 1);
    assert.equal(r.members[0].isEligibleToVote, true);
  });

  test('an empty list is a valid answer; anything that is not a list is not', async () => {
    assert.deepEqual(await setup({ handler: () => jsonResponse(200, []) }).api.searchMembers('zz', [1]), { ok: true, members: [] });
    for (const body of [{}, { members: [] }, 'null', '"text"', '5']) {
      const r = await setup({ handler: () => jsonResponse(200, body) }).api.searchMembers('zz', [1]);
      assert.equal(r.ok, false, JSON.stringify(body));
      assert.equal(r.failure.kind, FailureKind.Protocol, JSON.stringify(body));
    }
  });
});

describe('issue answers', () => {
  test('the server\'s time is returned', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, { memberId: 42, qrIssuedAt: '2026-11-03T02:00:00.123' }) });
    assert.deepEqual(await ctx.api.markQrIssued(42), { ok: true, memberId: 42, qrIssuedAt: '2026-11-03T02:00:00.123' });
  });

  test('an answer without a time is still a success (the page then uses its own clock)', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, { memberId: 42 }) });
    assert.deepEqual(await ctx.api.markQrIssued(42), { ok: true, memberId: 42, qrIssuedAt: null });
    const blank = setup({ handler: () => jsonResponse(200, { memberId: 42, qrIssuedAt: '  ' }) });
    assert.equal((await blank.api.markQrIssued(42)).qrIssuedAt, null);
  });

  test('an answer about a different member is refused - a slip must never be printed on the strength of it', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, { memberId: 43, qrIssuedAt: '2026-11-03T02:00:00' }) });
    const r = await ctx.api.markQrIssued(42);
    assert.equal(r.ok, false);
    assert.equal(r.failure.kind, FailureKind.Protocol);
    assert.match(r.failure.message, /different member/);
  });

  test('an answer that is not an object is refused', async () => {
    for (const body of ['null', '"ok"', '5', '']) {
      const r = await setup({ handler: () => (body === '' ? new Response(null, { status: 204 }) : new Response(body, { status: 200 })) }).api.markQrIssued(42);
      assert.equal(r.ok, false, body);
      assert.equal(r.failure.kind, FailureKind.Protocol, body);
    }
  });

  test('the server not knowing the member is "not found", with its words', async () => {
    const ctx = setup({ handler: () => jsonResponse(404, { error: 'Member not found.' }) });
    const r = await ctx.api.markQrIssued(42);
    assert.equal(r.failure.kind, FailureKind.NotFound);
    assert.equal(r.failure.message, 'Member not found.');
  });
});

describe('health check', () => {
  test('ok when the server answers', async () => {
    assert.deepEqual(await setup({ handler: () => jsonResponse(200, { status: 'Healthy' }) }).api.ping(), { ok: true });
  });

  test('an unhealthy server is a failure with its status', async () => {
    const r = await setup({ handler: () => jsonResponse(503, '') }).api.ping();
    assert.equal(r.ok, false);
    assert.equal(r.failure.kind, FailureKind.Server);
    assert.equal(r.failure.status, 503);
  });
});

describe('the session and the connection light are told about every answer', () => {
  test('a good answer is reported with its status', async () => {
    const ctx = setup({ handler: () => jsonResponse(200, []) });
    await ctx.api.searchMembers('ab', [1]);
    assert.deepEqual(ctx.outcomes, [{ status: 200, failure: null }]);
  });

  test('a refusal or an error is reported with its failure', async () => {
    const ctx = setup({ handler: () => jsonResponse(500, { error: 'Boom.' }) });
    await ctx.api.searchMembers('ab', [1]);
    assert.equal(ctx.outcomes.length, 1);
    assert.equal(ctx.outcomes[0].status, 500);
    assert.equal(ctx.outcomes[0].failure.kind, FailureKind.Server);
  });

  test('a 401 to a call made with the token tells the session once', async () => {
    const ctx = setup({ handler: () => new Response(null, { status: 401 }) });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Unauthorized);
    assert.equal(ctx.unauthorized, 1);
    assert.equal(ctx.outcomes.length, 1);
  });

  test('a call without a token is refused here, before anything is sent, and is not news about the server', async () => {
    const ctx = setup({ token: null });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.ok, false);
    assert.equal(r.failure.kind, FailureKind.Unauthorized);
    assert.equal(ctx.fetchFn.calls.length, 0);
    assert.equal(ctx.outcomes.length, 0);
    assert.equal(ctx.unauthorized, 1);
  });

  test('a successful answer whose JSON is broken is a protocol problem - the server did answer', async () => {
    const ctx = setup({ handler: () => new Response('<html>oops</html>', { status: 200 }) });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Protocol);
    assert.equal(ctx.outcomes[0].status, 200);
  });

  test('a base address that cannot be used is reported at once and nothing is sent', async () => {
    const ctx = setup({ base: 'nonsense', sameOrigin: true });
    const r = await ctx.api.ping();
    assert.equal(r.failure.kind, FailureKind.Protocol);
    assert.equal(r.failure.message, 'The server address is not valid.');
    assert.equal(ctx.fetchFn.calls.length, 0);
  });
});

describe('time limits and cancelling', () => {
  test('a server that never answers is a timeout after the limit', async () => {
    const ctx = setup({ timeoutMs: 20, handler: (c) => hangs(c.init) });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Timeout);
    assert.equal(r.failure.noResponseFromServer, true);
    assert.equal(ctx.outcomes[0].failure.kind, FailureKind.Timeout);
  });

  test('issue may be given its own, longer limit', async () => {
    const started = Date.now();
    const ctx = setup({ timeoutMs: 5000, handler: (c) => hangs(c.init) });
    const r = await ctx.api.markQrIssued(1, { timeoutMs: 20 });
    assert.equal(r.failure.kind, FailureKind.Timeout);
    assert.ok(Date.now() - started < 2000, 'the per-call limit was not used');
  });

  test('the health check never waits longer than 8 seconds', async () => {
    const ctx = setup({ timeoutMs: 20, handler: (c) => hangs(c.init) });
    assert.equal((await ctx.api.ping()).failure.kind, FailureKind.Timeout);
  });

  test('cancelling gives "cancelled", aborts the request, and is not news about the server', async () => {
    const ctx = setup({ handler: (c) => hangs(c.init) });
    const controller = new AbortController();
    const pending = ctx.api.searchMembers('ab', [1], { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const r = await pending;
    assert.equal(r.failure.kind, FailureKind.Cancelled);
    assert.equal(ctx.fetchFn.calls[0].init.signal.aborted, true);
    assert.equal(ctx.outcomes.length, 0, 'a cancel must not turn the connection light red');
  });

  test('a signal that is already cancelled sends nothing', async () => {
    const ctx = setup();
    const controller = new AbortController();
    controller.abort();
    const r = await ctx.api.searchMembers('ab', [1], { signal: controller.signal });
    assert.equal(r.failure.kind, FailureKind.Cancelled);
    assert.equal(ctx.fetchFn.calls.length, 0);
  });
});

describe('no answer at all: why?', () => {
  test('on the same site there is nothing to diagnose: the server cannot be reached', async () => {
    const ctx = setup({ sameOrigin: true, handler: () => {
      throw networkError();
    } });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Network);
    assert.equal(ctx.fetchFn.calls.length, 1, 'no extra probe on the same site');
    assert.equal(ctx.outcomes[0].failure.kind, FailureKind.Network);
  });

  test('another site that does not answer even a no-cors probe is simply unreachable', async () => {
    const ctx = setup({ handler: () => {
      throw networkError();
    } });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Network);
    assert.equal(ctx.fetchFn.calls.length, 2);
  });

  test('another site that answers a no-cors probe but not the real call: its CORS list does not name this site', async () => {
    const ctx = setup({ handler: (c) => {
      if (c.init.mode === 'no-cors') return new Response(null, { status: 200 });
      throw networkError();
    } });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Cors);
    assert.match(r.failure.message, /EVOTING_ALLOWED_ORIGINS/);
    assert.equal(r.failure.isConfigurationProblem, true);
    const probe = ctx.fetchFn.calls[1];
    assert.equal(probe.url, 'https://api.test/api/v1/health/live');
    assert.equal(probe.init.mode, 'no-cors');
    assert.equal(probe.init.credentials, 'omit');
    assert.equal(probe.headers.Authorization, undefined, 'the probe must not carry the token');
    assert.equal(ctx.outcomes[0].failure.kind, FailureKind.Cors);
  });

  test('once the server has been read, a later failure is not CORS (the settings do not change in the middle of a session)', async () => {
    let answer = true;
    const ctx = setup({ handler: () => {
      if (answer) return jsonResponse(200, []);
      throw networkError();
    } });
    assert.equal((await ctx.api.searchMembers('ab', [1])).ok, true);
    answer = false;
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Network);
    assert.equal(ctx.fetchFn.calls.length, 2, 'no probe after a readable answer');
  });

  test('a blocked-by-our-own-policy violation names the page\'s setup, not the server', async () => {
    const ctx = setup({ getCspViolation: () => ({ blockedURI: 'https://api.test/api/v1/registration/members/search?query=ab' }), handler: () => {
      throw networkError();
    } });
    const r = await ctx.api.searchMembers('ab', [1]);
    assert.equal(r.failure.kind, FailureKind.Csp);
    assert.match(r.failure.message, /set-api-url/);
    assert.equal(ctx.fetchFn.calls.length, 1);
  });

  test('a violation for some other address is not ours', async () => {
    for (const blockedURI of ['https://other.test/x', 'https://api.test.evil.example/x', 'inline', '']) {
      const ctx = setup({ getCspViolation: () => ({ blockedURI }), handler: () => {
        throw networkError();
      } });
      const r = await ctx.api.searchMembers('ab', [1]);
      assert.equal(r.failure.kind, FailureKind.Network, blockedURI);
    }
  });

  test('no violation, or a violation without an address, changes nothing', async () => {
    for (const getCspViolation of [() => null, () => ({}), () => ({ blockedURI: 5 }), undefined]) {
      const ctx = setup({ getCspViolation, handler: () => {
        throw networkError();
      } });
      assert.equal((await ctx.api.searchMembers('ab', [1])).failure.kind, FailureKind.Network);
    }
  });
});
