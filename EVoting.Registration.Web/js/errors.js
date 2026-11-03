// What went wrong with a call to EVoting.Api, in terms the screen can act on.
//
// The one rule this file exists to enforce (same as ApiFailureClassifier in the Windows station):
// "the server could not be reached" (network, timeout, CORS) is a DIFFERENT thing from "the server
// answered and said no" (401, 403, 404, 409, 400, 429) and from "the server answered but is unhealthy"
// (5xx). Nothing outside this file decides what a status code means.

export const FailureKind = Object.freeze({
  None: 'none',
  /** No HTTP response at all: DNS failure, connection refused/reset, TLS failure, network down. */
  Network: 'network',
  /** The browser refused the connection because the API does not list this site's origin (CORS). The server IS reachable. */
  Cors: 'cors',
  /** This page's own Content-Security-Policy does not allow the API address. A deployment mistake. */
  Csp: 'csp',
  /** The request ran out of time before a response arrived (client timer or HTTP 408). */
  Timeout: 'timeout',
  /** 401 - missing, expired or invalid token / wrong password. */
  Unauthorized: 'unauthorized',
  /** 403 - signed in, but this account may not do this. */
  Forbidden: 'forbidden',
  /** 404 - the thing (or the endpoint) does not exist. */
  NotFound: 'notFound',
  /** 409 - the request conflicts with the server's current state. */
  Conflict: 'conflict',
  /** 400 / 413 / 415 / 422 - the server refused the content of the request. */
  Validation: 'validation',
  /** 429 - too many requests. */
  RateLimited: 'rateLimited',
  /** 5xx - the server (or a proxy in front of it) answered but could not do the work. May pass later. */
  Server: 'server',
  /** The answer was not something this client understands (unexpected status, unreadable body). */
  Protocol: 'protocol',
  /** The caller cancelled the operation. Not an error. */
  Cancelled: 'cancelled',
});

const MAX_MESSAGE_LENGTH = 240;

/** An immutable description of one failed API call. Never contains a token or a password. */
export class ApiFailure {
  constructor(kind, message, { status = null, code = null, retryAfterSeconds = null } = {}) {
    this.kind = kind;
    this.message = typeof message === 'string' && message.trim() ? message : String(kind);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    Object.freeze(this);
  }

  /** True only when nothing came back from the server at all. This - and only this - means "offline". */
  get noResponseFromServer() {
    return this.kind === FailureKind.Network || this.kind === FailureKind.Timeout;
  }

  /** Worth trying again later without anyone changing anything. */
  get isTransient() {
    return this.noResponseFromServer || this.kind === FailureKind.Server || this.kind === FailureKind.RateLimited;
  }

  /** Needs a person (or the server's configuration) to change before retrying can help. */
  get isAuthorizationProblem() {
    return this.kind === FailureKind.Unauthorized || this.kind === FailureKind.Forbidden;
  }

  /** The server cannot be used from this page until somebody changes a setting (CORS list, CSP, address). */
  get isConfigurationProblem() {
    return this.kind === FailureKind.Cors || this.kind === FailureKind.Csp;
  }

  toString() {
    return `${this.kind}${this.status != null ? ` (${this.status})` : ''}${this.code ? ` [${this.code}]` : ''}: ${this.message}`;
  }
}

/** One line, bounded: this ends up on screen. */
function clip(s, max = MAX_MESSAGE_LENGTH) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (!t) return null;
  t = t.replace(/[\r\n]+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

function readString(obj, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lower && typeof obj[key] === 'string') return obj[key];
  }
  return null;
}

/**
 * Reads the API's error envelope {"error":"...","detail":"...","code":"..."} (ApiError). Anything else (an HTML error
 * page from a proxy, an empty body, ProblemDetails) yields no message and no code.
 */
export function parseErrorBody(body) {
  if (typeof body !== 'string' || !body.trim() || body.trimStart()[0] !== '{') return { message: null, code: null };
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return { message: null, code: null };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { message: null, code: null };

  let message = readString(doc, 'error');
  const detail = readString(doc, 'detail');
  const code = readString(doc, 'code');

  if (!message || !message.trim()) message = detail;
  else if (detail && detail.trim()) message = `${message} ${detail}`;

  return { message: clip(message), code: clip(code, 64) };
}

/** True when the body is the API's own error envelope (so a 404 really came from EVoting.Api, not from a proxy). */
export function isApiErrorEnvelope(body) {
  if (typeof body !== 'string' || !body.trim() || body.trimStart()[0] !== '{') return false;
  try {
    const doc = JSON.parse(body);
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) && typeof readString(doc, 'error') === 'string';
  } catch {
    return false;
  }
}

const pick = (serverMessage, fallback) => (serverMessage && serverMessage.trim() ? serverMessage : fallback);

/** Classifies an HTTP response that was NOT a success (not 2xx). */
export function classifyStatus(status, body, retryAfterSeconds = null) {
  const { message, code } = parseErrorBody(body);
  const extra = { status, code };

  switch (status) {
    case 401:
      return new ApiFailure(FailureKind.Unauthorized, pick(message, 'You are not signed in, or the session has expired.'), extra);
    case 403:
      return new ApiFailure(FailureKind.Forbidden, pick(message, 'The server does not allow this account to do that.'), extra);
    case 404:
      return new ApiFailure(FailureKind.NotFound, pick(message, 'The server could not find what was asked for.'), extra);
    case 408:
      return new ApiFailure(FailureKind.Timeout, 'The server timed out waiting for the request.', extra);
    case 409:
      return new ApiFailure(FailureKind.Conflict, pick(message, "The request conflicts with the server's current state."), extra);
    case 400:
    case 413:
    case 415:
    case 422:
      return new ApiFailure(FailureKind.Validation, pick(message, 'The server rejected the request.'), extra);
    case 429:
      return new ApiFailure(
        FailureKind.RateLimited,
        'The server is limiting how fast requests may be sent. Wait a moment, then try again.',
        { ...extra, retryAfterSeconds },
      );
    default:
      break;
  }

  if (status >= 500 && status <= 599) {
    return new ApiFailure(FailureKind.Server, pick(message, `The server could not complete the request (HTTP ${status}).`), {
      ...extra,
      retryAfterSeconds,
    });
  }
  return new ApiFailure(FailureKind.Protocol, `The server answered with an unexpected status (HTTP ${status}).`, extra);
}

/**
 * Classifies an exception thrown by fetch() / reading the body.
 *  - callerAborted: the caller's own AbortSignal fired (a newer search replaced this one)
 *  - timedOut: this client's timer fired
 */
export function classifyException(err, { callerAborted = false, timedOut = false } = {}) {
  const name = err && typeof err === 'object' ? err.name : '';

  if (callerAborted) return new ApiFailure(FailureKind.Cancelled, 'The operation was cancelled.');
  if (timedOut) return new ApiFailure(FailureKind.Timeout, 'The server did not answer in time.');
  if (name === 'AbortError') return new ApiFailure(FailureKind.Cancelled, 'The operation was cancelled.');
  // fetch() rejects with a TypeError for every failure to get a response: DNS, refused, TLS, offline, CORS, CSP, mixed content.
  // The caller refines it (api.js diagnoseNoResponse) to Cors / Csp when it can tell.
  if (name === 'TypeError') return new ApiFailure(FailureKind.Network, 'The server could not be reached.');
  if (name === 'SyntaxError') return new ApiFailure(FailureKind.Protocol, "The server's answer could not be understood.");
  return new ApiFailure(FailureKind.Protocol, `Unexpected error talking to the server${name ? ` (${name})` : ''}.`);
}
