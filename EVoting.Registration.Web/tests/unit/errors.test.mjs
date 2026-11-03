// What an answer from the server means. The rule these tests guard: "the server could not be reached" is a different thing
// from "the server answered and said no" and from "the server answered but is unhealthy" - and only the first one is "offline".

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiFailure, FailureKind, classifyException, classifyStatus, isApiErrorEnvelope, parseErrorBody } from '../../js/errors.js';

describe('ApiFailure', () => {
  test('cannot be changed after it is made', () => {
    const f = new ApiFailure(FailureKind.Server, 'x', { status: 500 });
    assert.throws(() => {
      f.kind = FailureKind.None;
    }, TypeError);
    assert.throws(() => {
      f.message = 'y';
    }, TypeError);
  });

  test('a blank message falls back to the kind, so the screen never shows nothing', () => {
    assert.equal(new ApiFailure(FailureKind.Network, '').message, 'network');
    assert.equal(new ApiFailure(FailureKind.Network, '   ').message, 'network');
    assert.equal(new ApiFailure(FailureKind.Network, undefined).message, 'network');
  });

  test('carries status, code and retry time, with null when absent', () => {
    const a = new ApiFailure(FailureKind.RateLimited, 'slow down', { status: 429, code: 'RATE', retryAfterSeconds: 30 });
    assert.deepEqual([a.status, a.code, a.retryAfterSeconds], [429, 'RATE', 30]);
    const b = new ApiFailure(FailureKind.Network, 'x');
    assert.deepEqual([b.status, b.code, b.retryAfterSeconds], [null, null, null]);
  });

  test('toString is one readable line', () => {
    assert.equal(new ApiFailure(FailureKind.Conflict, 'busy', { status: 409, code: 'DUP' }).toString(), 'conflict (409) [DUP]: busy');
    assert.equal(new ApiFailure(FailureKind.Network, 'down').toString(), 'network: down');
  });

  test('the four questions the rest of the page asks, for every kind', () => {
    // [kind, noResponseFromServer, isTransient, isAuthorizationProblem, isConfigurationProblem]
    const table = [
      [FailureKind.None, false, false, false, false],
      [FailureKind.Network, true, true, false, false],
      [FailureKind.Timeout, true, true, false, false],
      [FailureKind.Cors, false, false, false, true],
      [FailureKind.Csp, false, false, false, true],
      [FailureKind.Unauthorized, false, false, true, false],
      [FailureKind.Forbidden, false, false, true, false],
      [FailureKind.NotFound, false, false, false, false],
      [FailureKind.Conflict, false, false, false, false],
      [FailureKind.Validation, false, false, false, false],
      [FailureKind.RateLimited, false, true, false, false],
      [FailureKind.Server, false, true, false, false],
      [FailureKind.Protocol, false, false, false, false],
      [FailureKind.Cancelled, false, false, false, false],
    ];
    assert.equal(table.length, Object.keys(FailureKind).length, 'a new kind was added: say what it means here');
    for (const [kind, noResponse, transient, authorization, configuration] of table) {
      const f = new ApiFailure(kind, 'x');
      assert.equal(f.noResponseFromServer, noResponse, `${kind}.noResponseFromServer`);
      assert.equal(f.isTransient, transient, `${kind}.isTransient`);
      assert.equal(f.isAuthorizationProblem, authorization, `${kind}.isAuthorizationProblem`);
      assert.equal(f.isConfigurationProblem, configuration, `${kind}.isConfigurationProblem`);
    }
  });
});

describe('the server\'s error envelope {"error", "detail", "code"}', () => {
  test('error, detail and code are read', () => {
    assert.deepEqual(parseErrorBody('{"error":"Bad name.","detail":"Use letters.","code":"NAME"}'), { message: 'Bad name. Use letters.', code: 'NAME' });
    assert.deepEqual(parseErrorBody('{"error":"Bad name."}'), { message: 'Bad name.', code: null });
  });

  test('detail alone is used when there is no error text', () => {
    assert.deepEqual(parseErrorBody('{"detail":"Only this."}'), { message: 'Only this.', code: null });
    assert.deepEqual(parseErrorBody('{"error":"  ","detail":"Only this."}'), { message: 'Only this.', code: null });
  });

  test('names are matched without regard to case (ASP.NET and the API differ in style)', () => {
    assert.deepEqual(parseErrorBody('{"Error":"E","Detail":"D","Code":"C"}'), { message: 'E D', code: 'C' });
  });

  test('anything that is not the envelope gives no message and no code', () => {
    const nothing = { message: null, code: null };
    for (const body of ['', '   ', null, undefined, 42, '<html><h1>502 Bad Gateway</h1></html>', 'plain text', '[1,2]', 'null', '{broken', '{"error":5}', '{"title":"Not Found","status":404}']) {
      assert.deepEqual(parseErrorBody(body), nothing, String(body));
    }
  });

  test('what ends up on screen is one line and not longer than 240 characters', () => {
    const long = parseErrorBody(JSON.stringify({ error: 'x'.repeat(500) }));
    assert.equal(long.message.length, 240);
    assert.ok(long.message.endsWith('…'));
    assert.equal(parseErrorBody('{"error":"line one\\r\\nline two"}').message, 'line one line two');
    assert.equal(parseErrorBody(JSON.stringify({ error: 'e', code: 'c'.repeat(200) })).code.length, 64);
  });

  test('isApiErrorEnvelope tells the API\'s own answer from a proxy\'s', () => {
    assert.equal(isApiErrorEnvelope('{"error":"No election is open."}'), true);
    assert.equal(isApiErrorEnvelope('{"Error":"No election is open."}'), true);
    assert.equal(isApiErrorEnvelope('{"error":""}'), true, 'an empty message is still the API speaking');
    for (const body of ['<html>404 Not Found</html>', '', null, undefined, '[]', '{}', '{"error":5}', '{"title":"Not Found"}', '{nope']) {
      assert.equal(isApiErrorEnvelope(body), false, String(body));
    }
  });
});

describe('classifyStatus - every HTTP status the page can meet', () => {
  const envelope = (text) => JSON.stringify({ error: text });

  test('kind for each status', () => {
    const table = {
      400: FailureKind.Validation,
      401: FailureKind.Unauthorized,
      403: FailureKind.Forbidden,
      404: FailureKind.NotFound,
      408: FailureKind.Timeout,
      409: FailureKind.Conflict,
      413: FailureKind.Validation,
      415: FailureKind.Validation,
      422: FailureKind.Validation,
      429: FailureKind.RateLimited,
      500: FailureKind.Server,
      502: FailureKind.Server,
      503: FailureKind.Server,
      504: FailureKind.Server,
      599: FailureKind.Server,
      // not something this client knows how to read
      301: FailureKind.Protocol,
      304: FailureKind.Protocol,
      402: FailureKind.Protocol,
      405: FailureKind.Protocol,
      418: FailureKind.Protocol,
      600: FailureKind.Protocol,
    };
    for (const [status, kind] of Object.entries(table)) {
      assert.equal(classifyStatus(Number(status), '').kind, kind, `HTTP ${status}`);
    }
  });

  test('only a timeout and a missing answer count as "no response" (never 4xx or 5xx)', () => {
    for (let status = 400; status <= 599; status++) {
      const f = classifyStatus(status, '');
      assert.equal(f.noResponseFromServer, status === 408, `HTTP ${status}`);
    }
  });

  test('the server\'s own sentence is shown for 400, 401, 403, 404, 409, 5xx', () => {
    for (const status of [400, 401, 403, 404, 409, 500, 503]) {
      assert.equal(classifyStatus(status, envelope('The server says no.')).message, 'The server says no.', `HTTP ${status}`);
    }
  });

  test('without one (an HTML page from a proxy, an empty body) there is a plain sentence', () => {
    assert.equal(classifyStatus(401, '').message, 'You are not signed in, or the session has expired.');
    assert.equal(classifyStatus(403, '<html>').message, 'The server does not allow this account to do that.');
    assert.equal(classifyStatus(404, '').message, 'The server could not find what was asked for.');
    assert.equal(classifyStatus(409, '').message, "The request conflicts with the server's current state.");
    assert.equal(classifyStatus(422, '').message, 'The server rejected the request.');
    assert.equal(classifyStatus(502, '<html>Bad Gateway</html>').message, 'The server could not complete the request (HTTP 502).');
    assert.equal(classifyStatus(418, '').message, 'The server answered with an unexpected status (HTTP 418).');
  });

  test('a 408 and a 429 use fixed sentences, not whatever a proxy wrote', () => {
    assert.equal(classifyStatus(408, envelope('x')).message, 'The server timed out waiting for the request.');
    assert.equal(classifyStatus(429, envelope('x')).message, 'The server is limiting how fast requests may be sent. Wait a moment, then try again.');
  });

  test('429 and 5xx carry Retry-After; the others do not', () => {
    assert.equal(classifyStatus(429, '', 30).retryAfterSeconds, 30);
    assert.equal(classifyStatus(503, '', 5).retryAfterSeconds, 5);
    assert.equal(classifyStatus(429, '').retryAfterSeconds, null);
    assert.equal(classifyStatus(401, '', 30).retryAfterSeconds, null);
  });

  test('status and the API\'s error code travel with the failure', () => {
    const f = classifyStatus(409, '{"error":"Duplicate.","code":"DUP"}');
    assert.equal(f.status, 409);
    assert.equal(f.code, 'DUP');
    assert.equal(classifyStatus(500, '').status, 500);
  });
});

describe('classifyException - fetch() threw', () => {
  const named = (name) => Object.assign(new Error('x'), { name });

  test('the caller\'s own cancel is "cancelled", whatever was thrown', () => {
    assert.equal(classifyException(new TypeError('x'), { callerAborted: true }).kind, FailureKind.Cancelled);
    assert.equal(classifyException(named('AbortError'), { callerAborted: true, timedOut: true }).kind, FailureKind.Cancelled);
  });

  test('our own timer is a timeout', () => {
    assert.equal(classifyException(named('AbortError'), { timedOut: true }).kind, FailureKind.Timeout);
    assert.equal(classifyException(new TypeError('x'), { timedOut: true }).kind, FailureKind.Timeout);
  });

  test('an abort nobody asked for is still a cancel', () => {
    assert.equal(classifyException(named('AbortError')).kind, FailureKind.Cancelled);
  });

  test('a TypeError is what the browser throws when there was no answer at all', () => {
    const f = classifyException(new TypeError('Failed to fetch'));
    assert.equal(f.kind, FailureKind.Network);
    assert.equal(f.noResponseFromServer, true);
  });

  test('a body that cannot be read is a protocol problem, and an unknown error names itself', () => {
    assert.equal(classifyException(new SyntaxError('x')).kind, FailureKind.Protocol);
    const f = classifyException(new RangeError('x'));
    assert.equal(f.kind, FailureKind.Protocol);
    assert.match(f.message, /\(RangeError\)/);
  });

  test('a thrown string or null does not crash the classifier', () => {
    assert.equal(classifyException('boom').kind, FailureKind.Protocol);
    assert.equal(classifyException('boom').message, 'Unexpected error talking to the server.');
    assert.equal(classifyException(null).kind, FailureKind.Protocol);
    assert.equal(classifyException(undefined).kind, FailureKind.Protocol);
  });
});
