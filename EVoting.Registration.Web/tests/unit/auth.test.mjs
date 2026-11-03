// The sign-in session of the person at the desk: when it locks, what is forgotten, and what is never kept.
// Time is moved by hand (helpers.mjs), so "10 minutes without a key" takes no time to test.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AuthStatus, LockReason, createAuth, displayNameFromToken } from '../../js/auth.js';
import { FailureKind, ApiFailure } from '../../js/errors.js';
import { createClock, createTimers, fakeToken } from './helpers.mjs';

const MINUTE = 60_000;

function setup({ idleMs = 10 * MINUTE, expiresInSeconds = 28800, claims, loginResult } = {}) {
  const clock = createClock();
  const timers = createTimers(clock, { repeat: true });
  const logins = [];
  const changes = [];
  const token = fakeToken(claims);
  const api = {
    async login(username, password) {
      logins.push({ username, password });
      if (loginResult) return loginResult(username, password);
      return { ok: true, accessToken: token, expiresInSeconds, role: 'Registration' };
    },
  };
  const auth = createAuth({ api, idleMs, now: clock.now, timers, onChange: (s) => changes.push(s) });
  return { auth, clock, timers, logins, changes, token };
}

describe('the name shown in the top bar', () => {
  const tokenFor = (claims) => fakeToken(claims);

  test('is read from the token, for display only', () => {
    assert.equal(displayNameFromToken(tokenFor({ name: 'Ana Reyes' })), 'Ana Reyes');
  });

  test('looks at fullName, then name, then unique_name, then the long Microsoft claim name', () => {
    const long = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
    assert.equal(displayNameFromToken(tokenFor({ fullName: 'A', name: 'B', unique_name: 'C', [long]: 'D' })), 'A');
    assert.equal(displayNameFromToken(tokenFor({ name: 'B', unique_name: 'C', [long]: 'D' })), 'B');
    assert.equal(displayNameFromToken(tokenFor({ unique_name: 'C', [long]: 'D' })), 'C');
    assert.equal(displayNameFromToken(tokenFor({ [long]: 'D' })), 'D');
  });

  test('blank or non-text claims are skipped', () => {
    assert.equal(displayNameFromToken(tokenFor({ fullName: '   ', name: 5, unique_name: 'clerk' })), 'clerk');
  });

  test('accents survive (the token is UTF-8)', () => {
    assert.equal(displayNameFromToken(tokenFor({ name: 'José Peña' })), 'José Peña');
  });

  test('is trimmed and never longer than 80 characters', () => {
    assert.equal(displayNameFromToken(tokenFor({ name: '  Ana  ' })), 'Ana');
    assert.equal(displayNameFromToken(tokenFor({ name: 'x'.repeat(200) })).length, 80);
  });

  test('anything that is not a readable token gives the fallback', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.!!!.c', `a.${Buffer.from('not json').toString('base64url')}.c`, null, undefined, 42, `a.${Buffer.from('"just text"').toString('base64url')}.c`]) {
      assert.equal(displayNameFromToken(bad, 'fallback'), 'fallback', String(bad));
    }
    assert.equal(displayNameFromToken('abc'), '');
  });

  test('a name that looks like markup is returned as plain text (the page only ever puts it in as text)', () => {
    assert.equal(displayNameFromToken(tokenFor({ name: '<img src=x onerror=alert(1)>' })), '<img src=x onerror=alert(1)>');
  });
});

describe('signing in', () => {
  test('starts signed out, with nothing', () => {
    const { auth } = setup();
    assert.equal(auth.state.status, AuthStatus.SignedOut);
    assert.equal(auth.getToken(), null);
    assert.equal(auth.state.username, '');
  });

  test('needs both a user name and a password, and asks the server only when it has both', async () => {
    const { auth, logins } = setup();
    for (const [u, p] of [['', 'pw'], ['   ', 'pw'], ['clerk', ''], [undefined, undefined], [null, 'pw']]) {
      const r = await auth.signIn(u, p);
      assert.deepEqual(r, { ok: false, message: 'Enter the user name and the password.' });
    }
    assert.equal(logins.length, 0);
  });

  test('the user name is trimmed, the password is sent exactly as typed', async () => {
    const { auth, logins } = setup();
    await auth.signIn('  clerk  ', '  pass word ');
    assert.deepEqual(logins, [{ username: 'clerk', password: '  pass word ' }]);
  });

  test('success: signed in, the token is held, the name comes from the token, expiry is counted from now', async () => {
    const { auth, clock, token } = setup({ claims: { name: 'Ana Reyes' }, expiresInSeconds: 3600 });
    const r = await auth.signIn('clerk', 'pw');
    assert.deepEqual(r, { ok: true });
    const s = auth.state;
    assert.equal(s.status, AuthStatus.SignedIn);
    assert.equal(s.username, 'clerk');
    assert.equal(s.displayName, 'Ana Reyes');
    assert.equal(s.role, 'Registration');
    assert.equal(s.expiresAt, clock.now() + 3600 * 1000);
    assert.equal(s.lockReason, null);
    assert.equal(auth.getToken(), token);
  });

  test('without a name in the token the user name is greeted', async () => {
    const { auth } = setup({ claims: { role: 'Registration' } });
    await auth.signIn('clerk', 'pw');
    assert.equal(auth.state.displayName, 'clerk');
  });

  test('a refusal changes nothing and is passed on as it came', async () => {
    const failure = new ApiFailure(FailureKind.Unauthorized, 'Wrong.');
    const { auth, changes } = setup({ loginResult: () => ({ ok: false, failure }) });
    const r = await auth.signIn('clerk', 'bad');
    assert.equal(r.ok, false);
    assert.equal(r.failure, failure);
    assert.equal(auth.state.status, AuthStatus.SignedOut);
    assert.equal(auth.getToken(), null);
    assert.equal(changes.length, 0);
  });

  test('the password is never kept: not in the state, not in anything that can be read back', async () => {
    const { auth } = setup();
    await auth.signIn('clerk', 'MY-SECRET-PASSWORD');
    assert.ok(!JSON.stringify(auth.state).includes('MY-SECRET-PASSWORD'));
    assert.ok(!Object.keys(auth.state).some((k) => /pass/i.test(k)));
    assert.ok(!JSON.stringify(Object.getOwnPropertyNames(auth)).match(/pass/i));
  });

  test('the state handed out is a copy: changing it changes nothing', async () => {
    const { auth } = setup();
    await auth.signIn('clerk', 'pw');
    const s = auth.state;
    s.status = AuthStatus.SignedOut;
    s.username = 'someone else';
    assert.equal(auth.state.status, AuthStatus.SignedIn);
    assert.equal(auth.state.username, 'clerk');
  });

  test('a handler that throws does not break the session', async () => {
    const clock = createClock();
    const auth = createAuth({
      api: { login: async () => ({ ok: true, accessToken: fakeToken(), expiresInSeconds: 60, role: 'Registration' }) },
      idleMs: 0,
      now: clock.now,
      timers: createTimers(clock, { repeat: true }),
      onChange: () => {
        throw new Error('handler bug');
      },
    });
    assert.deepEqual(await auth.signIn('clerk', 'pw'), { ok: true });
    assert.equal(auth.state.status, AuthStatus.SignedIn);
  });

  test('onChange hears about every change with a copy of the state', async () => {
    const { auth, changes } = setup();
    await auth.signIn('clerk', 'pw');
    auth.lock();
    auth.signOut();
    assert.deepEqual(changes.map((c) => c.status), [AuthStatus.SignedIn, AuthStatus.Locked, AuthStatus.SignedOut]);
  });
});

describe('locking', () => {
  test('lock throws the token away at once and remembers who it was', async () => {
    const { auth } = setup();
    await auth.signIn('clerk', 'pw');
    assert.equal(auth.lock(), true);
    assert.equal(auth.getToken(), null);
    assert.equal(auth.state.status, AuthStatus.Locked);
    assert.equal(auth.state.lockReason, LockReason.Manual);
    assert.equal(auth.state.username, 'clerk');
  });

  test('only a signed-in session can be locked', async () => {
    const { auth, changes } = setup();
    assert.equal(auth.lock(), false, 'signed out');
    await auth.signIn('clerk', 'pw');
    auth.lock();
    assert.equal(auth.lock(), false, 'already locked');
    assert.equal(auth.expire(), false, 'already locked');
    assert.equal(changes.length, 2);
  });

  test('the server refusing the token (401) locks with the reason "expired"', async () => {
    const { auth } = setup();
    await auth.signIn('clerk', 'pw');
    assert.equal(auth.expire(), true);
    assert.equal(auth.state.status, AuthStatus.Locked);
    assert.equal(auth.state.lockReason, LockReason.Expired);
    assert.equal(auth.getToken(), null);
  });

  test('unlocking asks the SAME user for the password again', async () => {
    const { auth, logins } = setup();
    await auth.signIn('clerk', 'pw');
    auth.lock();
    const r = await auth.unlock('pw2');
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(logins.at(-1), { username: 'clerk', password: 'pw2' });
    assert.equal(auth.state.status, AuthStatus.SignedIn);
    assert.equal(auth.state.lockReason, null);
    assert.notEqual(auth.getToken(), null);
  });

  test('a wrong password leaves it locked; an empty one is not even sent', async () => {
    const failure = new ApiFailure(FailureKind.Unauthorized, 'Wrong.');
    let wrong = true;
    const { auth, logins } = setup({ loginResult: () => (wrong ? { ok: false, failure } : { ok: true, accessToken: fakeToken(), expiresInSeconds: 600, role: 'Registration' }) });
    wrong = false;
    await auth.signIn('clerk', 'pw');
    auth.lock();
    const before = logins.length;
    assert.deepEqual(await auth.unlock(''), { ok: false, message: 'Enter the password.' });
    assert.equal(logins.length, before);
    wrong = true;
    const r = await auth.unlock('bad');
    assert.equal(r.ok, false);
    assert.equal(auth.state.status, AuthStatus.Locked);
    assert.equal(auth.getToken(), null);
  });

  test('there is nothing to unlock unless the session is locked', async () => {
    const { auth, logins } = setup();
    assert.deepEqual(await auth.unlock('pw'), { ok: false, message: 'The session is not locked.' });
    await auth.signIn('clerk', 'pw');
    assert.deepEqual(await auth.unlock('pw'), { ok: false, message: 'The session is not locked.' });
    assert.equal(logins.length, 1);
  });

  test('after unlocking the idle clock starts again - it does not lock at once', async () => {
    const { auth, clock, timers } = setup({ idleMs: 10 * MINUTE });
    await auth.signIn('clerk', 'pw');
    timers.advance(9 * MINUTE);
    auth.lock();
    clock.advance(30 * MINUTE); // locked for a long while
    await auth.unlock('pw');
    timers.advance(30_000);
    assert.equal(auth.state.status, AuthStatus.SignedIn);
  });
});

describe('locking by itself', () => {
  test('after 10 minutes without a key or click', async () => {
    const { auth, timers } = setup({ idleMs: 10 * MINUTE });
    await auth.signIn('clerk', 'pw');
    timers.advance(10 * MINUTE - 1);
    assert.equal(auth.state.status, AuthStatus.SignedIn);
    timers.advance(15_000); // the next look
    assert.equal(auth.state.status, AuthStatus.Locked);
    assert.equal(auth.state.lockReason, LockReason.Idle);
    assert.equal(auth.getToken(), null);
  });

  test('every key or click starts the 10 minutes again', async () => {
    const { auth, timers } = setup({ idleMs: 10 * MINUTE });
    await auth.signIn('clerk', 'pw');
    for (let i = 0; i < 6; i++) {
      timers.advance(9 * MINUTE);
      auth.touch();
    }
    assert.equal(auth.state.status, AuthStatus.SignedIn, 'a busy desk is never locked');
    timers.advance(10 * MINUTE + 15_000);
    assert.equal(auth.state.lockReason, LockReason.Idle);
  });

  test('an idle time of 0 switches the idle lock off', async () => {
    const { auth, timers } = setup({ idleMs: 0 });
    await auth.signIn('clerk', 'pw');
    timers.advance(5 * 60 * MINUTE);
    assert.equal(auth.state.status, AuthStatus.SignedIn);
  });

  test('when the token is about to run out (30 seconds before), however busy the desk is', async () => {
    const { auth, timers } = setup({ idleMs: 0, expiresInSeconds: 120 });
    await auth.signIn('clerk', 'pw');
    timers.advance(60_000);
    auth.touch();
    assert.equal(auth.state.status, AuthStatus.SignedIn);
    timers.advance(30_000); // 90 s = 120 s - 30 s
    assert.equal(auth.state.status, AuthStatus.Locked);
    assert.equal(auth.state.lockReason, LockReason.Expired);
    assert.equal(auth.getToken(), null);
  });

  test('a token that is already (almost) over locks at the first look', async () => {
    const { auth, timers } = setup({ idleMs: 0, expiresInSeconds: 10 });
    await auth.signIn('clerk', 'pw');
    timers.advance(15_000);
    assert.equal(auth.state.lockReason, LockReason.Expired);
  });

  test('expiry wins when both are due', async () => {
    const { auth, timers } = setup({ idleMs: 1 * MINUTE, expiresInSeconds: 60 });
    await auth.signIn('clerk', 'pw');
    timers.advance(MINUTE);
    assert.equal(auth.state.lockReason, LockReason.Expired);
  });

  test('check() is the same look, made on demand (when the tab comes back after the PC slept)', async () => {
    const { auth, clock } = setup({ idleMs: 10 * MINUTE });
    await auth.signIn('clerk', 'pw');
    clock.advance(3 * 60 * MINUTE); // no timers ran: the PC was asleep
    assert.equal(auth.state.status, AuthStatus.SignedIn);
    auth.check();
    assert.equal(auth.state.status, AuthStatus.Locked);
  });

  test('check() does nothing when nobody is signed in', () => {
    const { auth, changes } = setup();
    auth.check();
    assert.equal(changes.length, 0);
  });

  test('the watching stops when the session stops - no timer is left running', async () => {
    const { auth, timers } = setup();
    assert.equal(timers.pending, 0);
    await auth.signIn('clerk', 'pw');
    assert.equal(timers.pending, 1);
    auth.lock();
    assert.equal(timers.pending, 0, 'locked');
    await auth.unlock('pw');
    assert.equal(timers.pending, 1);
    auth.signOut();
    assert.equal(timers.pending, 0, 'signed out');
    await auth.signIn('clerk', 'pw');
    await auth.signIn('clerk', 'pw');
    assert.equal(timers.pending, 1, 'signing in twice must not start two watchers');
  });
});

describe('signing out', () => {
  test('forgets the token, the user and everything about them', async () => {
    const { auth } = setup();
    await auth.signIn('clerk', 'pw');
    auth.signOut();
    assert.equal(auth.getToken(), null);
    assert.deepEqual(
      { ...auth.state, lastActivityAt: 0 },
      { status: AuthStatus.SignedOut, username: '', displayName: '', role: '', expiresAt: 0, lockReason: null, lastActivityAt: 0 },
    );
  });

  test('works from a locked session too, and then nobody can unlock it', async () => {
    const { auth, logins } = setup();
    await auth.signIn('clerk', 'pw');
    auth.lock();
    auth.signOut();
    assert.equal(auth.state.status, AuthStatus.SignedOut);
    assert.deepEqual(await auth.unlock('pw'), { ok: false, message: 'The session is not locked.' });
    assert.equal(logins.length, 1);
  });
});
