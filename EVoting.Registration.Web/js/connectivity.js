// Is the server answering? Fed by every API call (api.js onOutcome) and, while nothing else is happening, by a light
// anonymous ping (GET health/live) so that the indicator turns "Offline" BEFORE a member is standing at the desk, not after.
// "Offline" means the server did not answer at all; a refusal or a server error is reported as exactly that
// ("Online - server problem"), never as offline.

import { FailureKind } from './errors.js';

const OFFLINE_RECHECK_MS = 8000;

export const Reachability = Object.freeze({
  /** Nothing has been tried yet. */
  Unknown: 'unknown',
  Online: 'online',
  Offline: 'offline',
});

/**
 * @param {object} options
 * @param {() => Promise<{ok: boolean, failure?: import('./errors.js').ApiFailure}>} options.ping
 * @param {number} [options.intervalMs]      how often to ping when nothing else has talked to the server
 * @param {() => number} [options.now]
 * @param {() => boolean} [options.isVisible] pings are skipped while the page is hidden
 * @param {{set: Function, clear: Function}} [options.timers]
 */
export function createConnectivity({ ping, intervalMs = 30000, now = () => Date.now(), isVisible = () => true, timers }) {
  const t = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

  const state = {
    status: Reachability.Unknown,
    /** When the server stopped answering (ms since epoch), or null. */
    offlineSince: null,
    /** The last time the server answered anything (ms since epoch), or null. */
    lastContactAt: null,
    /** The last answer was a refusal or error from the server itself (never "no answer"). */
    lastProblem: null,
  };

  const listeners = new Set();
  let timerId = null;
  let running = false;
  let pinging = false;
  let lookAgain = false; // somebody asked for a fresh look while one was already on its way

  /** One timer at a time: whoever schedules the next look drops the one that was waiting, so two loops can never build up. */
  function schedule(ms, fn) {
    if (timerId !== null) t.clear(timerId);
    timerId = t.set(fn, ms);
  }

  const snapshot = () => ({ ...state });
  const emit = () => {
    const s = snapshot();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {
        /* a listener must not break the others */
      }
    }
  };

  function setStatus(next, problem) {
    const changed = state.status !== next || state.lastProblem?.kind !== problem?.kind || state.lastProblem?.message !== problem?.message;
    state.status = next;
    state.lastProblem = problem ?? null;
    if (next === Reachability.Online) {
      state.offlineSince = null;
      state.lastContactAt = now();
    } else if (next === Reachability.Offline && state.offlineSince === null) {
      state.offlineSince = now();
    }
    if (changed) emit();
  }

  /** Called with the outcome of every API call. */
  function noteOutcome({ status, failure }) {
    if (!failure) {
      setStatus(Reachability.Online, null);
      return;
    }
    if (failure.kind === FailureKind.Cancelled) return;
    if (failure.noResponseFromServer || failure.kind === FailureKind.Cors || failure.kind === FailureKind.Csp) {
      // CORS / CSP: the server may be fine, but it cannot be used from this page - for the desk that is the same as offline.
      setStatus(Reachability.Offline, failure.noResponseFromServer ? null : failure);
      return;
    }
    // The server answered. Only a server error is shown as a problem; 401/403/404/400 are answers about one request.
    setStatus(Reachability.Online, failure.kind === FailureKind.Server ? failure : null);
    if (status != null) state.lastContactAt = now();
  }

  async function heartbeat(force = false) {
    if (!running) return;
    if (pinging) {
      if (force) lookAgain = true;
      return;
    }
    pinging = true;
    try {
      const quiet = force || state.lastContactAt === null || now() - state.lastContactAt >= intervalMs * 0.8;
      if (isVisible() && quiet) {
        const r = await ping();
        if (r.ok) setStatus(Reachability.Online, null);
        else noteOutcome({ status: r.failure?.status ?? null, failure: r.failure });
      }
    } catch {
      /* ping never throws; if it does, the next beat tries again */
    } finally {
      pinging = false;
      if (running) {
        if (lookAgain) {
          // the look that just ended may have started before the network changed: look once more, now
          lookAgain = false;
          schedule(0, () => heartbeat(true));
        } else {
          // While the server is not answering, look again sooner so the indicator recovers quickly.
          schedule(state.status === Reachability.Offline ? Math.min(intervalMs, OFFLINE_RECHECK_MS) : intervalMs, heartbeat);
        }
      }
    }
  }

  return {
    get state() {
      return snapshot();
    },
    noteOutcome,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Starts the periodic ping (and the first one now). */
    start() {
      if (running) return;
      running = true;
      schedule(0, () => heartbeat(true));
    },
    stop() {
      running = false;
      lookAgain = false;
      if (timerId !== null) t.clear(timerId);
      timerId = null;
    },
    /** The browser said the network came or went. Only a hint: an immediate ping decides. */
    hint() {
      if (!running) return;
      if (pinging) {
        lookAgain = true;
        return;
      }
      schedule(0, () => heartbeat(true));
    },
  };
}
