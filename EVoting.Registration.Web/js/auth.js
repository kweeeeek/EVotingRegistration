// The sign-in session of the person at the desk.
//
//  * The access token is kept in this closure only: not in localStorage/sessionStorage, not in a cookie, not in the URL.
//    Reloading the page or closing the tab ends the session - on a PC that other people use next, that is the point.
//  * "Lock" (manual, after idle time, or when the token expired/was refused) throws the token away and hides the screen; the
//    same user signs in again with the password to continue, and the session's records are still there. "Sign out" forgets everything.
//  * The password is only ever held while the sign-in request is being made.

export const AuthStatus = Object.freeze({
  SignedOut: 'signedOut',
  SignedIn: 'signedIn',
  Locked: 'locked',
});

export const LockReason = Object.freeze({
  Manual: 'manual',
  Idle: 'idle',
  /** The server refused the token (401) or it is about to run out. */
  Expired: 'expired',
});

const IDLE_CHECK_MS = 15000;
const EXPIRY_MARGIN_MS = 30000;

function base64UrlToText(segment) {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The name to greet the person with, read from the token's own claims. For DISPLAY only: the server decides what the token
 * may do, and a forged token would only change the greeting.
 */
export function displayNameFromToken(token, fallback = '') {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return fallback;
    const claims = JSON.parse(base64UrlToText(parts[1]));
    const candidates = [
      claims.fullName,
      claims.name,
      claims.unique_name,
      claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'],
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 80);
    }
  } catch {
    /* not a token we can read: no greeting name */
  }
  return fallback;
}

/**
 * @param {object} options
 * @param {{login: Function}} options.api
 * @param {number} options.idleMs                  0 turns the idle lock off
 * @param {() => number} [options.now]
 * @param {{set: Function, clear: Function}} [options.timers]  setInterval-style: set(fn, ms) / clear(id)
 * @param {(state: object) => void} [options.onChange]
 */
export function createAuth({ api, idleMs, now = () => Date.now(), timers, onChange }) {
  const t = timers ?? { set: (fn, ms) => setInterval(fn, ms), clear: (id) => clearInterval(id) };

  let token = null;
  let intervalId = null;
  const state = {
    status: AuthStatus.SignedOut,
    username: '',
    displayName: '',
    role: '',
    expiresAt: 0,
    lockReason: null,
    lastActivityAt: now(),
  };

  const snapshot = () => ({ ...state });
  const emit = () => {
    try {
      onChange?.(snapshot());
    } catch {
      /* a handler's failure must not break the session */
    }
  };

  function startWatch() {
    if (intervalId !== null) return;
    intervalId = t.set(check, IDLE_CHECK_MS);
  }
  function stopWatch() {
    if (intervalId === null) return;
    t.clear(intervalId);
    intervalId = null;
  }

  /** Locks the session when the person has been idle too long or the token has run out. Called by a timer and when the tab becomes visible. */
  function check() {
    if (state.status !== AuthStatus.SignedIn) return;
    const current = now();
    if (current >= state.expiresAt - EXPIRY_MARGIN_MS) {
      lock(LockReason.Expired);
      return;
    }
    if (idleMs > 0 && current - state.lastActivityAt >= idleMs) lock(LockReason.Idle);
  }

  function lock(reason = LockReason.Manual) {
    if (state.status !== AuthStatus.SignedIn) return false;
    token = null; // the token is gone: nothing on this page can call the server until the password is typed again
    state.status = AuthStatus.Locked;
    state.lockReason = reason;
    stopWatch();
    emit();
    return true;
  }

  async function authenticate(username, password) {
    const r = await api.login(username, password);
    if (!r.ok) return r;
    token = r.accessToken;
    state.status = AuthStatus.SignedIn;
    state.username = username;
    state.displayName = displayNameFromToken(r.accessToken, username);
    state.role = r.role;
    state.expiresAt = now() + r.expiresInSeconds * 1000;
    state.lockReason = null;
    state.lastActivityAt = now();
    startWatch();
    emit();
    return { ok: true };
  }

  return {
    get state() {
      return snapshot();
    },
    getToken: () => token,

    /** Signs in with a user name and password (registration-login). */
    async signIn(username, password) {
      const name = String(username ?? '').trim();
      if (!name || !password) {
        return { ok: false, message: 'Enter the user name and the password.' };
      }
      return authenticate(name, password);
    },

    /** Unlocks a locked session: the SAME user types the password again. */
    async unlock(password) {
      if (state.status !== AuthStatus.Locked) return { ok: false, message: 'The session is not locked.' };
      if (!password) return { ok: false, message: 'Enter the password.' };
      return authenticate(state.username, password);
    },

    lock,

    /** The server answered 401 to a call made with the token. */
    expire() {
      return lock(LockReason.Expired);
    },

    /** Ends the session and forgets who it was. */
    signOut() {
      token = null;
      stopWatch();
      state.status = AuthStatus.SignedOut;
      state.username = '';
      state.displayName = '';
      state.role = '';
      state.expiresAt = 0;
      state.lockReason = null;
      emit();
    },

    /** Any keystroke, click or touch on the page. */
    touch() {
      state.lastActivityAt = now();
    },

    check,
  };
}
