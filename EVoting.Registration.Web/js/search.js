// Member search for the registration desk. Turns "the text box changed" into at most one search per pause in typing and
// guarantees the screen only ever shows the answer to the LATEST query:
//  * debounce      - each keystroke restarts a short wait, so typing "dela cruz" sends one search, not nine;
//  * cancel stale  - a newer query aborts the older request and discards its answer even if it arrives later;
//  * instant narrowing - while the answer is on its way, the rows of the previous COMPLETE answer that still match the longer
//    text stay on screen (a preview only: nothing can be issued from it until the server's answer replaces it);
//  * explicit states - idle / too short / loading / results / empty / error / no election.
// Same rules as MemberSearchCoordinator + MemberSearchService in the Windows station, minus the offline roster.

import { FailureKind } from './errors.js';
import { MIN_QUERY_LENGTH, SERVER_ROW_CAP, fold, kindOf, memberMatches, serverQuery } from './format.js';

export const DEFAULT_DEBOUNCE_MS = 150;

/** The rows of a previous answer that contain the (longer) folded query. Same rule the server applies. */
export function narrowMembers(members, foldedQuery) {
  return members.filter((m) => memberMatches(m, foldedQuery));
}

/** Words for a search that could not be completed. */
export function describeSearchFailure(failure) {
  switch (failure.kind) {
    case FailureKind.Network:
    case FailureKind.Timeout:
      return 'The server cannot be reached, so members cannot be searched right now. Check the internet connection; search again when it is back.';
    case FailureKind.Cors:
    case FailureKind.Csp:
      return failure.message;
    case FailureKind.Unauthorized:
      return 'Your session has ended. Sign in again to continue.';
    case FailureKind.Server:
    case FailureKind.RateLimited:
      return `${failure.message} Search again in a moment.`;
    default:
      return `The server did not accept the search: ${failure.message}`;
  }
}

/**
 * @param {object} options
 * @param {{searchMembers: Function}} options.api
 * @param {() => (object|null)} options.getEvent  the open election (with branchIds) at the moment each search starts
 * @param {(state: object) => void} options.onState
 * @param {number} [options.debounceMs]
 * @param {{set: Function, clear: Function}} [options.timers]
 */
export function createSearchCoordinator({ api, getEvent, onState, debounceMs = DEFAULT_DEBOUNCE_MS, timers }) {
  const t = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

  let version = 0;
  let published = 0;
  let timerId = null;
  let controller = null;
  let wake = null; // resolves the pending debounce wait early (cancel)
  /** The last COMPLETE answer, kept for instant narrowing. */
  let lastResults = null;
  let current = { phase: 'idle', query: '', foldedQuery: '', members: [], truncated: false, message: '', sequence: 0, preview: false, stale: false };

  function publish(v, state) {
    if (v !== version) return false; // superseded while it was being prepared
    current = { phase: 'idle', query: '', foldedQuery: '', members: [], truncated: false, message: '', preview: false, stale: false, ...state, sequence: ++published };
    try {
      onState(current);
    } catch {
      /* a handler's failure must not break the search */
    }
    return true;
  }

  function cancelCurrent() {
    if (timerId !== null) {
      t.clear(timerId);
      timerId = null;
    }
    if (wake) {
      const w = wake;
      wake = null;
      w(false);
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  const delay = (ms) =>
    new Promise((resolve) => {
      wake = resolve;
      timerId = t.set(() => {
        timerId = null;
        wake = null;
        resolve(true);
      }, ms);
    });

  /** Shapes server members for the screen: adds the eligibility kind computed from the server's own fields. */
  function toRows(members, event) {
    return members.map((m) => ({ ...m, kind: kindOf(m, event) }));
  }

  function start(text, debounce) {
    cancelCurrent();
    const v = ++version;
    const raw = text == null ? '' : String(text);
    const folded = fold(raw);

    // Cheap checks first: nothing to wait for or call.
    if (folded.length < MIN_QUERY_LENGTH) {
      lastResults = null;
      publish(
        v,
        folded.length === 0
          ? { phase: 'idle', query: raw }
          : { phase: 'tooShort', query: raw, message: `Type at least ${MIN_QUERY_LENGTH} characters.` },
      );
      return Promise.resolve();
    }

    const event = getEvent();
    if (!event || !event.branchIds || event.branchIds.length === 0) {
      lastResults = null;
      publish(v, { phase: 'noElection', query: raw, message: 'No election is open, so there is nothing to search.' });
      return Promise.resolve();
    }

    // What stays on screen while the answer is on its way.
    const previous = lastResults;
    let shown = previous ? previous.members : [];
    let preview = false;
    if (previous && !previous.truncated && previous.foldedQuery && folded.includes(previous.foldedQuery)) {
      shown = narrowMembers(previous.members, folded); // every match of the longer text is among the matches of the shorter one
      preview = true;
    }
    publish(v, { phase: 'loading', query: raw, foldedQuery: folded, members: shown, preview, stale: !preview && shown.length > 0 });

    return run(raw, folded, event, debounce, v);
  }

  async function run(raw, folded, event, debounce, v) {
    if (debounce) {
      const completed = await delay(debounceMs);
      if (!completed || v !== version) return;
    }

    const own = new AbortController();
    controller = own;
    let result;
    try {
      result = await api.searchMembers(serverQuery(raw), event.branchIds, { signal: own.signal });
    } catch {
      result = { ok: false, failure: { kind: FailureKind.Protocol, message: 'The search failed unexpectedly. Please try again.' } };
    }
    if (controller === own) controller = null;
    if (v !== version || own.signal.aborted) return; // a newer query started while this one was running: its answer must not appear

    if (!result.ok) {
      if (result.failure.kind === FailureKind.Cancelled) return;
      lastResults = null;
      publish(v, { phase: 'error', query: raw, foldedQuery: folded, message: describeSearchFailure(result.failure), failure: result.failure });
      return;
    }

    const members = toRows(result.members, event);
    const truncated = members.length >= SERVER_ROW_CAP;
    if (members.length === 0) {
      lastResults = { foldedQuery: folded, members, truncated };
      publish(v, { phase: 'empty', query: raw, foldedQuery: folded, message: `No member found for "${raw.trim()}" in the participating branches.` });
      return;
    }
    lastResults = { foldedQuery: folded, members, truncated };
    publish(v, { phase: 'results', query: raw, foldedQuery: folded, members, truncated });
  }

  return {
    /** The text box changed: search after the debounce interval, replacing any earlier pending or running search. */
    queryChanged(text) {
      return start(text, true);
    },
    /** Enter key / Search button / scanner: search now, no debounce, still replaces any earlier search. Resolves when this search has ended. */
    searchNow(text) {
      return start(text, false);
    },
    /** Cancel whatever is pending and show the idle state. */
    reset() {
      cancelCurrent();
      lastResults = null;
      const v = ++version;
      publish(v, { phase: 'idle' });
    },
    /** Replace one member in the rows on screen and in the kept answer (after a QR was issued: its "issued" time changed). */
    patchMember(memberId, patch) {
      const apply = (m) => (m.memberId === memberId ? { ...m, ...patch } : m);
      if (lastResults) lastResults = { ...lastResults, members: lastResults.members.map(apply) };
      if (current.members.some((m) => m.memberId === memberId)) {
        current = { ...current, members: current.members.map(apply), sequence: ++published };
        try {
          onState(current);
        } catch {
          /* see publish */
        }
      }
    },
    get state() {
      return current;
    },
    dispose() {
      cancelCurrent();
      version++;
    },
  };
}
