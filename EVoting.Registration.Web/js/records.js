// The QR issuances made in THIS browser session, one by one: what "Review records" shows.
//
// In the Windows station a QR may be handed out while the server has not heard of it yet (it is queued on the PC). The
// browser version is online-only and never does that: a slip is printed only after the server has confirmed the record, so
// every record here is either confirmed, still being sent, or one of three kinds of "not recorded" that a person must look at.
//
// Records live in memory only. Closing the tab, signing out or reloading the page discards them (they hold member names, and
// this page may run on a PC that somebody else uses next). The server keeps the real record (QrIssuedAt of the member).

import { parseServerUtc, plural } from './format.js';

export const RecordState = Object.freeze({
  /** The request is on its way to the server. */
  Sending: 'sending',
  /** The server recorded it. The only state in which a slip may be handed out. */
  Confirmed: 'confirmed',
  /** The server answered with an error or the session ended: it was NOT recorded. Trying again is safe. */
  Failed: 'failed',
  /** The server did not answer: the request may or may not have been recorded. "Check with server" or try again. */
  Unknown: 'unknown',
  /** The server refused it for good (it does not know the member). */
  Rejected: 'rejected',
});

export const MAX_RECORDS = 500;

export function stateTitle(state) {
  switch (state) {
    case RecordState.Confirmed:
      return 'Confirmed by server';
    case RecordState.Sending:
      return 'Sending to server…';
    case RecordState.Failed:
      return 'Not recorded - no slip was printed';
    case RecordState.Unknown:
      return 'Not confirmed - the server did not answer';
    case RecordState.Rejected:
      return 'Rejected by server';
    default:
      return String(state);
  }
}

/** A record somebody has to look at: it did not simply succeed. */
export function isProblem(record) {
  return record.state === RecordState.Failed || record.state === RecordState.Unknown || record.state === RecordState.Rejected;
}

/** One line for staff, for example "Not recorded - no slip was printed: The server could not complete the request (HTTP 502)." */
export function describeRecord(record) {
  const title = stateTitle(record.state);
  if (isProblem(record) && record.message) return `${title}: ${record.message}`;
  return title;
}

export const canTryAgain = (record) => record.state === RecordState.Failed || record.state === RecordState.Unknown;
export const canCheckWithServer = (record) => record.state === RecordState.Unknown;
export const canAcknowledge = (record) => isProblem(record) && !record.acknowledged;
export const canReprint = (record) => record.state === RecordState.Confirmed;
export const attemptText = (record) => (record.attempts === 0 ? 'not tried yet' : plural(record.attempts, 'attempt'));

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function createRecords({ now = () => Date.now(), newId = defaultId } = {}) {
  /** newest first */
  let list = [];
  const listeners = new Set();

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* a listener must not break the others */
      }
    }
  };
  const copy = (r) => (r ? { ...r } : null);

  return {
    /** Starts a record in the Sending state. */
    add({ memberId, memberName, accountCode, branchId = 0, branch = '', eventId = 0, eventTitle = '', qrIssuedAtBefore = null }) {
      const record = {
        id: newId(),
        memberId,
        memberName: memberName || '(name not recorded)',
        accountCode: accountCode || '',
        branchId,
        branch,
        eventId,
        eventTitle,
        state: RecordState.Sending,
        startedAt: now(),
        issuedAtUtc: null,
        qrIssuedAtBefore,
        attempts: 0,
        message: '',
        failureKind: null,
        acknowledged: false,
        acknowledgedAt: null,
        slipsPrinted: 0,
      };
      list = [record, ...list].slice(0, MAX_RECORDS);
      emit();
      return copy(record);
    },

    update(id, patch) {
      const index = list.findIndex((r) => r.id === id);
      if (index < 0) return null;
      list = list.map((r, i) => (i === index ? { ...r, ...patch } : r));
      emit();
      return copy(list[index]);
    },

    get: (id) => copy(list.find((r) => r.id === id)),

    /** mode 'attention': records that need a decision (newest first); mode 'recent': everything. */
    list({ mode = 'recent', includeAcknowledged = false, limit = MAX_RECORDS } = {}) {
      let rows = list;
      if (mode === 'attention') rows = rows.filter((r) => isProblem(r) && (includeAcknowledged || !r.acknowledged));
      return rows.slice(0, limit).map(copy);
    },

    counts() {
      let sending = 0;
      let confirmed = 0;
      let problems = 0;
      let unacknowledged = 0;
      for (const r of list) {
        if (r.state === RecordState.Sending) sending++;
        else if (r.state === RecordState.Confirmed) confirmed++;
        else if (isProblem(r)) {
          problems++;
          if (!r.acknowledged) unacknowledged++;
        }
      }
      return { total: list.length, sending, confirmed, problems, unacknowledged };
    },

    /** Marks a problem record as seen. The record stays. */
    acknowledge(id) {
      const r = list.find((x) => x.id === id);
      if (!r || !isProblem(r)) return null;
      return this.update(id, { acknowledged: true, acknowledgedAt: now() });
    },

    sendingFor: (memberId) => copy(list.find((r) => r.memberId === memberId && r.state === RecordState.Sending)),

    /** The most recent confirmed issuance for the member, or null. */
    latestConfirmedFor(memberId) {
      let best = null;
      let bestTime = -Infinity;
      for (const r of list) {
        if (r.memberId !== memberId || r.state !== RecordState.Confirmed) continue;
        const t = (parseServerUtc(r.issuedAtUtc) ?? new Date(r.startedAt)).getTime();
        if (t > bestTime) {
          best = r;
          bestTime = t;
        }
      }
      return copy(best);
    },

    /** The most recent record of any state for the member. */
    lastFor: (memberId) => copy(list.find((r) => r.memberId === memberId)),

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Forgets everything (sign out). */
    clear() {
      list = [];
      emit();
    },
  };
}
