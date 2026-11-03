// The only place that talks to EVoting.Api. Every call returns { ok: true, ... } or { ok: false, failure } - it never throws
// for an HTTP or network problem, so a caller cannot forget that something may have gone wrong.
//
// Browser-specific rules kept here:
//  * the access token lives in memory only (the caller supplies it through getToken) and goes ONLY in the Authorization header;
//  * credentials: 'omit' (the API is bearer-only: no cookies are sent, so there is no ambient authority for another site to ride on),
//    redirect: 'error' (a redirect must never carry the token somewhere else), cache: 'no-store', referrer: none;
//  * a fetch() that fails without a response is diagnosed (CORS / CSP / unreachable) instead of being reported as a bare "network error".

import { ApiFailure, FailureKind, classifyException, classifyStatus, isApiErrorEnvelope } from './errors.js';
import { parseLocalWallClock } from './format.js';

export const LOGIN_PATH = 'api/v1/auth/registration-login';
export const CURRENT_EVENT_PATH = 'api/v1/events/current';
export const SEARCH_PATH = 'api/v1/registration/members/search';
export const HEALTH_PATH = 'api/v1/health/live';
export const qrIssuedPath = (memberId) => `api/v1/registration/members/${encodeURIComponent(String(memberId))}/qr-issued`;

/** '' means "the same site as this page" (a reverse proxy forwards /api/ to the server). */
export function normalizeBase(apiBaseUrl, pageOrigin) {
  const raw = (apiBaseUrl ?? '').trim();
  if (raw === '') return { base: `${pageOrigin}/`, sameOrigin: true, origin: pageOrigin };
  const url = new URL(raw);
  const base = url.href.endsWith('/') ? url.href : `${url.href}/`;
  return { base, sameOrigin: url.origin === pageOrigin, origin: url.origin };
}

/**
 * Checks the configured address before anything is sent: https only (a password and a token must never cross the network in clear
 * text), except for a server on this same PC while developing. Returns null when fine, otherwise a sentence for the screen.
 */
export function validateApiBaseUrl(apiBaseUrl) {
  const raw = (apiBaseUrl ?? '').trim();
  if (raw === '') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `The server address "${raw}" in config.js is not a valid address.`;
  }
  if (url.username || url.password) return 'The server address in config.js must not contain a user name or password.';
  if (url.search || url.hash) return 'The server address in config.js must not contain a query or a fragment.';
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && local) return null;
  return 'The server address in config.js must start with https:// (a password and a token must not cross the network in clear text).';
}

function buildUrl(base, path, query) {
  const url = new URL(path, base);
  if (query) {
    for (const [key, value] of query) url.searchParams.append(key, String(value));
  }
  return url;
}

const asInt = (v) => (Number.isInteger(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : 0);
const asString = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);

/** One member as EVoting.Api publishes it (RegistrationMemberResponse), with safe defaults for anything missing. */
export function normalizeMember(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const memberId = asInt(raw.memberId);
  if (memberId <= 0) return null;
  return {
    memberId,
    accountCode: asString(raw.accountCode),
    memberName: asString(raw.memberName),
    memberContactNumber: raw.memberContactNumber == null ? null : asString(raw.memberContactNumber),
    memberAddress: raw.memberAddress == null ? null : asString(raw.memberAddress),
    branchId: asInt(raw.branchId),
    branch: asString(raw.branch),
    shareCapital: asNumber(raw.shareCapital),
    savingsDeposit: asNumber(raw.savingsDeposit),
    loanStatus: asInt(raw.loanStatus),
    isEligibleToVote: raw.isEligibleToVote === true,
    votingRemarks: raw.votingRemarks == null ? null : asString(raw.votingRemarks),
    qrIssuedAt: typeof raw.qrIssuedAt === 'string' && raw.qrIssuedAt.trim() ? raw.qrIssuedAt : null,
    isActive: raw.isActive === true,
  };
}

/** The open election, as far as the desk needs it (EventResponse). Null when it has no usable id. */
export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const eventId = asInt(raw.eventId);
  if (eventId <= 0) return null;
  const branchIds = [];
  if (Array.isArray(raw.branches)) {
    for (const b of raw.branches) {
      const id = b && typeof b === 'object' ? asInt(b.branchId) : 0;
      if (id > 0 && !branchIds.includes(id)) branchIds.push(id);
    }
  }
  return {
    eventId,
    title: asString(raw.title),
    venue: asString(raw.venue),
    scheduleFrom: parseLocalWallClock(raw.scheduleFrom),
    scheduleTo: parseLocalWallClock(raw.scheduleTo),
    status: asString(raw.status),
    branchIds,
  };
}

/**
 * @param {object} options
 * @param {string} options.base           normalised base address (ends with '/')
 * @param {boolean} options.sameOrigin    true when the API is on this page's own origin
 * @param {() => (string|null)} options.getToken
 * @param {typeof fetch} [options.fetchFn]
 * @param {number} [options.timeoutMs]
 * @param {(info: {status: number|null, failure: ApiFailure|null}) => void} [options.onOutcome]  every finished call, for the connection indicator
 * @param {() => void} [options.onUnauthorized]  an authorised call came back 401
 * @param {() => (object|null)} [options.getCspViolation]  the most recent CSP violation seen by the page, if any
 */
export function createApi({ base, sameOrigin, getToken, fetchFn, timeoutMs = 15000, onOutcome, onUnauthorized, getCspViolation }) {
  const doFetch = fetchFn ?? ((...args) => globalThis.fetch(...args));

  let hadReadableResponse = false; // CORS settings do not change mid-session: once an answer was readable, a later failure is not CORS

  /** fetch() failed without a response. Is it CORS, this page's CSP, or is the server really unreachable? */
  async function diagnoseNoResponse() {
    const blocked = getCspViolation?.()?.blockedURI;
    if (typeof blocked === 'string') {
      // "https://api.example.com" must not claim a block of "https://api.example.com.evil.test/..." (only the same origin counts)
      const origin = new URL(base).origin;
      if (blocked === origin || blocked.startsWith(`${origin}/`)) {
        return new ApiFailure(
          FailureKind.Csp,
          "This page's security policy (Content-Security-Policy) does not allow connecting to the server address. The web page was set up with a different address than config.js. Ask the administrator to run tools/set-api-url.mjs again.",
        );
      }
    }
    if (!sameOrigin && !hadReadableResponse) {
      // A no-cors request is allowed to succeed (as an opaque response) even when CORS forbids reading the answer: if it
      // gets through, the server is up and it is the CORS list that does not name this site.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          await doFetch(new URL(HEALTH_PATH, base).href, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        return new ApiFailure(
          FailureKind.Cors,
          `The server is reachable, but the browser blocked the connection (CORS): the server does not list this site (${globalThis.location?.origin ?? 'this address'}) as an allowed origin. Ask the administrator to add it to EVOTING_ALLOWED_ORIGINS on the server.`,
        );
      } catch {
        // not reachable at all
      }
    }
    return new ApiFailure(FailureKind.Network, 'The server could not be reached. Check the internet connection of this PC.');
  }

  /**
   * @returns {Promise<{ok: true, status: number, data: any, text: string} | {ok: false, failure: ApiFailure, status?: number, text?: string}>}
   */
  async function send(method, path, { query, body, auth = true, signal, timeoutMs: perCallTimeout } = {}) {
    let url;
    try {
      url = buildUrl(base, path, query);
    } catch {
      return finish({ ok: false, failure: new ApiFailure(FailureKind.Protocol, 'The server address is not valid.') }, { local: true });
    }

    const headers = { Accept: 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) {
        return finish({ ok: false, failure: new ApiFailure(FailureKind.Unauthorized, 'You are not signed in.') }, { local: true, unauthorized: true });
      }
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    if (signal?.aborted) return { ok: false, failure: new ApiFailure(FailureKind.Cancelled, 'The operation was cancelled.') };

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, perCallTimeout ?? timeoutMs);
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const response = await doFetch(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      const text = await response.text();
      const retryHeader = response.headers?.get?.('Retry-After');
      const retryAfter = retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : null;

      if (response.status >= 200 && response.status < 300) {
        let data = null;
        if (text.trim()) {
          try {
            data = JSON.parse(text);
          } catch {
            return finish({ ok: false, failure: new ApiFailure(FailureKind.Protocol, "The server's answer could not be understood.", { status: response.status }) }, { status: response.status });
          }
        }
        hadReadableResponse = true;
        return finish({ ok: true, status: response.status, data, text }, { status: response.status });
      }

      const failure = classifyStatus(response.status, text, retryAfter);
      hadReadableResponse = true;
      return finish({ ok: false, failure, status: response.status, text }, { status: response.status, unauthorized: auth && failure.kind === FailureKind.Unauthorized });
    } catch (err) {
      let failure = classifyException(err, { callerAborted, timedOut });
      if (failure.kind === FailureKind.Network) failure = await diagnoseNoResponse();
      return finish({ ok: false, failure }, {});
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Reports the outcome to the connection indicator, and a 401 to the session. `local` = decided here, nothing was sent. */
  function finish(result, { status = null, unauthorized = false, local = false } = {}) {
    if (!result.ok && result.failure.kind === FailureKind.Cancelled) return result; // not an outcome: nothing was learned about the server
    if (!local) onOutcome?.({ status, failure: result.ok ? null : result.failure });
    if (unauthorized) onUnauthorized?.();
    return result;
  }

  return {
    base,
    sameOrigin,

    /** POST registration-login. On success: { ok, accessToken, expiresInSeconds, role }. */
    async login(username, password, { signal } = {}) {
      const r = await send('POST', LOGIN_PATH, { auth: false, body: { username, password }, signal });
      if (!r.ok) return r;
      const d = r.data;
      const token = d && typeof d.accessToken === 'string' ? d.accessToken : '';
      const expiresIn = d ? asInt(d.expiresIn) : 0;
      if (!token || expiresIn <= 0) {
        return { ok: false, failure: new ApiFailure(FailureKind.Protocol, 'The sign-in answer was incomplete.') };
      }
      return { ok: true, accessToken: token, expiresInSeconds: expiresIn, role: asString(d.role) };
    },

    /** GET events/current. { ok, event } where event is null when no election is open. */
    async getCurrentEvent({ signal } = {}) {
      const r = await send('GET', CURRENT_EVENT_PATH, { signal });
      if (!r.ok) {
        if (r.failure.kind === FailureKind.NotFound) {
          // Only the API's own "no election is open" answer is a 404 with its error envelope; a 404 from a proxy is a wrong address.
          if (isApiErrorEnvelope(r.text)) return { ok: true, event: null };
          return { ok: false, failure: new ApiFailure(FailureKind.NotFound, 'The server did not recognise the current-election address. Check the server address and version.', { status: 404 }) };
        }
        return r;
      }
      const event = normalizeEvent(r.data);
      if (!event) return { ok: false, failure: new ApiFailure(FailureKind.Protocol, 'The current-election answer was not usable.') };
      return { ok: true, event };
    },

    /** GET registration/members/search. { ok, members } - eligible AND ineligible members; at most 200 rows. */
    async searchMembers(query, branchIds, { signal } = {}) {
      if (!Array.isArray(branchIds) || branchIds.length === 0) return { ok: true, members: [] };
      const params = [['query', query]];
      for (const id of branchIds) params.push(['branchIds', id]);
      const r = await send('GET', SEARCH_PATH, { query: params, signal });
      if (!r.ok) return r;
      if (!Array.isArray(r.data)) return { ok: false, failure: new ApiFailure(FailureKind.Protocol, 'The member list was empty or malformed.') };
      return { ok: true, members: r.data.map(normalizeMember).filter(Boolean) };
    },

    /** POST registration/members/{id}/qr-issued. { ok, memberId, qrIssuedAt } - the server stamps the time itself. */
    async markQrIssued(memberId, { signal, timeoutMs: t } = {}) {
      const r = await send('POST', qrIssuedPath(memberId), { signal, timeoutMs: t });
      if (!r.ok) return r;
      const d = r.data;
      if (!d || typeof d !== 'object') return { ok: false, failure: new ApiFailure(FailureKind.Protocol, 'The QR-issuance answer could not be understood.') };
      if (d.memberId != null && asInt(d.memberId) !== memberId) {
        return { ok: false, failure: new ApiFailure(FailureKind.Protocol, 'The server confirmed a different member than the one asked for.') };
      }
      return { ok: true, memberId, qrIssuedAt: typeof d.qrIssuedAt === 'string' && d.qrIssuedAt.trim() ? d.qrIssuedAt : null };
    },

    /** GET health/live (anonymous). { ok } when the API process answers. */
    async ping({ signal } = {}) {
      const r = await send('GET', HEALTH_PATH, { auth: false, signal, timeoutMs: Math.min(timeoutMs, 8000) });
      return r.ok ? { ok: true } : r;
    },
  };
}
