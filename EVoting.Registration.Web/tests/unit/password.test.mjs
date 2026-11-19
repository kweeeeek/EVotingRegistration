// A password the administrator gave must be replaced before the desk opens: the page's rule, the server answers, the session.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AuthStatus, createAuth, newPasswordProblem } from '../../js/auth.js';
import { CHANGE_PASSWORD_PATH, createApi } from '../../js/api.js';
import { createClock, createTimers, fakeToken, jsonResponse } from './helpers.mjs';

describe('the rule for a new password (same as the server)', () => {
  test('length and the four kinds of character', () => {
    assert.match(newPasswordProblem(''), /Type the new password/);
    assert.match(newPasswordProblem('Ab1!'), /8 to 128/);
    assert.match(newPasswordProblem('abcdefg1!'), /8 to 128/, 'no capital');
    assert.match(newPasswordProblem('ABCDEFG1!'), /8 to 128/, 'no small letter');
    assert.match(newPasswordProblem('Abcdefgh!'), /8 to 128/, 'no digit');
    assert.match(newPasswordProblem('Abcdefgh1'), /8 to 128/, 'no special');
    assert.equal(newPasswordProblem('Abcdefg1!'), '');
  });
  test('not the given one, not the user name, typed twice the same', () => {
    assert.match(newPasswordProblem('Sacdeco@2026', { current: 'Sacdeco@2026' }), /different/);
    assert.match(newPasswordProblem('Clerk01-2026!', { username: 'CLERK01' }), /user name/);
    assert.match(newPasswordProblem('Abcdefg1!', { confirm: 'Abcdefg1?' }), /not the same/);
    assert.equal(newPasswordProblem('Abcdefg1!', { current: 'x', username: 'zed', confirm: 'Abcdefg1!' }), '');
  });
});

describe('what the server answers', () => {
  test('a sign-in that must change the password does not open the desk', async () => {
    const api = createApi({
      base: 'https://api.test/',
      sameOrigin: false,
      getToken: () => null,
      fetchFn: async () => jsonResponse(200, { accessToken: 'short.token.x', expiresIn: 600, role: 'PasswordChange', mustChangePassword: true }),
    });
    const r = await api.login('clerk', 'given');
    assert.deepEqual(r, { ok: true, mustChangePassword: true, changeToken: 'short.token.x', expiresInSeconds: 600 });
  });

  test('the change goes with the short token, not a session token', async () => {
    const calls = [];
    const api = createApi({
      base: 'https://api.test/',
      sameOrigin: false,
      getToken: () => 'SESSION-TOKEN',
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, { accessToken: 'a.b.c', expiresIn: 28800, role: 'Registration' });
      },
    });
    const r = await api.changePassword('short.token.x', 'given', 'Own-Pass-1!');
    assert.equal(r.ok, true);
    assert.equal(r.accessToken, 'a.b.c');
    assert.equal(new URL(calls[0].url).pathname, '/' + CHANGE_PASSWORD_PATH);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer short.token.x');
    assert.deepEqual(JSON.parse(calls[0].init.body), { currentPassword: 'given', newPassword: 'Own-Pass-1!' });
  });
});

describe('the session', () => {
  function setup(loginAnswer) {
    const clock = createClock();
    const changes = [];
    const auth = createAuth({
      api: {
        login: async () => loginAnswer,
        changePassword: async (tok, cur, next) => {
          changes.push({ tok, cur, next });
          return { ok: true, accessToken: fakeToken({ fullName: 'New Clerk' }), expiresInSeconds: 28800, role: 'Registration' };
        },
      },
      idleMs: 0,
      now: clock.now,
      timers: createTimers(clock, { repeat: true }),
    });
    return { auth, changes };
  }

  test('signed out until the own password is saved; then signed in', async () => {
    const { auth, changes } = setup({ ok: true, mustChangePassword: true, changeToken: 'short', expiresInSeconds: 600 });
    const r = await auth.signIn('newclerk', 'Sacdeco@2026');
    assert.equal(r.ok, false);
    assert.equal(r.mustChangePassword, true);
    assert.equal(r.changeToken, 'short');
    assert.equal(auth.state.status, AuthStatus.SignedOut);
    assert.equal(auth.getToken(), null);
    const weak = await auth.setOwnCredential('newclerk', 'Sacdeco@2026', 'weak', 'short');
    assert.equal(weak.ok, false);
    assert.equal(changes.length, 0, 'a weak password is not even sent');
    const done = await auth.setOwnCredential('newclerk', 'Sacdeco@2026', 'Own-Pass-1!', 'short');
    assert.equal(done.ok, true);
    assert.equal(auth.state.status, AuthStatus.SignedIn);
    assert.equal(auth.state.displayName, 'New Clerk');
    assert.deepEqual(changes, [{ tok: 'short', cur: 'Sacdeco@2026', next: 'Own-Pass-1!' }]);
  });
});
