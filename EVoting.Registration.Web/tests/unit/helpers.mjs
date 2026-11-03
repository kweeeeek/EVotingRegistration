// Small things the unit tests share: a clock and timers that only move when a test moves them, a promise a test settles by
// hand, the sample member and election, a few response builders, and a QR reader. Nothing here is part of the page that is uploaded.

import { createRequire } from 'node:module';

const jsQR = createRequire(import.meta.url)('jsqr');

/** Lets every promise that is already waiting run (the page's own async code only waits on promises, never on real time). */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 2026-11-03 02:00:00 UTC, moved by hand. */
export function createClock(start = Date.UTC(2026, 10, 3, 2, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    set(value) {
      t = value;
    },
    advance(ms) {
      t += ms;
      return t;
    },
  };
}

/**
 * Timers that fire only when a test says so. `repeat: true` behaves like setInterval (auth.js), otherwise like setTimeout.
 * advance(ms) moves the clock forward and runs everything that falls due on the way, in time order, including timers that
 * those callbacks schedule inside the same span.
 */
export function createTimers(clock, { repeat = false } = {}) {
  let nextId = 1;
  const scheduled = new Map();
  return {
    set(fn, ms) {
      const id = nextId++;
      scheduled.set(id, { fn, at: clock.now() + ms, every: repeat ? Math.max(1, ms) : null });
      return id;
    },
    clear(id) {
      scheduled.delete(id);
    },
    /** How many timers are waiting. */
    get pending() {
      return scheduled.size;
    },
    advance(ms) {
      const end = clock.now() + ms;
      for (;;) {
        let dueId = null;
        let dueAt = Infinity;
        for (const [id, s] of scheduled) {
          if (s.at <= end && s.at < dueAt) {
            dueAt = s.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const s = scheduled.get(dueId);
        clock.set(Math.max(clock.now(), s.at));
        if (s.every) s.at += s.every;
        else scheduled.delete(dueId);
        s.fn();
      }
      clock.set(end);
    },
  };
}

/** A promise that a test settles later. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** The open election as the page holds it after api.js has normalised it. */
export const EVENT = Object.freeze({
  eventId: 7,
  title: '2026 Annual General Assembly',
  venue: 'SACDECO Multi-Purpose Hall',
  scheduleFrom: null,
  scheduleTo: null,
  status: 'Active',
  branchIds: Object.freeze([1, 2, 3]),
});

const BRANCHES = { 1: 'Main Branch', 2: 'East Branch', 3: 'West Branch', 9: 'Outside Branch' };

/** One member as api.js normalises it (every field present). */
export function member(memberId, accountCode, memberName, branchId = 1, extra = {}) {
  return {
    memberId,
    accountCode,
    memberName,
    memberContactNumber: null,
    memberAddress: null,
    branchId,
    branch: BRANCHES[branchId] ?? `Branch ${branchId}`,
    shareCapital: 0,
    savingsDeposit: 0,
    loanStatus: 0,
    isEligibleToVote: true,
    votingRemarks: null,
    qrIssuedAt: null,
    isActive: true,
    ...extra,
  };
}

const base64Url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token shaped like the API's (header.payload.signature). The page never checks the signature: the server does. */
export function fakeToken(claims = { name: 'Ana Reyes', unique_name: 'clerk', role: 'Registration' }) {
  return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url(claims)}.signature`;
}

/** A real fetch Response (Node has one), so api.js reads it exactly as it reads the browser's. */
export function jsonResponse(status, body, headers = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text === '' ? null : text, { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** The error object fetch() rejects with when it gets no answer at all. */
export const networkError = () => new TypeError('Failed to fetch');

/** The error fetch() rejects with when its AbortSignal fires. */
export const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** Every rectangle of an SVG path made by svgPathData: "M<x> <y>h<n>v1h-<n>z". */
export function rectsOf(pathData) {
  return [...pathData.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) }));
}

/**
 * Draws the SVG path onto a white bitmap the way a screen or a printer does (`scale` pixels per module) and reads it with
 * jsQR - a QR reader that shares no code with the page. Returns jsQR's answer ({ data, version, ... }) or null.
 */
export function readQrFromPath(pathData, totalModules, scale = 6) {
  const size = totalModules * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const { x, y, w } of rectsOf(pathData)) {
    for (let py = y * scale; py < (y + 1) * scale; py++) {
      for (let px = x * scale; px < (x + w) * scale; px++) {
        const i = (py * size + px) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return jsQR(data, size, size);
}
