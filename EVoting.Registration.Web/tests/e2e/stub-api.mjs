// A stand-in for EVoting.Api that behaves like the real one where the web app can tell the difference:
//   * the endpoints and JSON the desk uses (registration-login, events/current, members/search, qr-issued, health/live);
//   * the same CORS policy shape ("LanAndWifi": explicit origins, any header, any method, credentials allowed, no max-age, no exposed headers);
//   * the error envelope {"error": "..."} on 401 (login) / 404 and an EMPTY 401 for a bad token (ASP.NET's default challenge);
//   * a UTC time without a zone for qrIssuedAt.
// Tests can make it slow, make it drop the connection before or after doing the work, answer with any status, forget tokens, ...
// It is a test double: it proves how the PAGE behaves against those answers, not how the real server behaves.

import https from 'node:https';
import { randomUUID } from 'node:crypto';

const strip = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export const EVENT = Object.freeze({
  eventId: 7,
  title: '2026 Annual General Assembly',
  venue: 'SACDECO Multi-Purpose Hall',
  scheduleFrom: '2026-11-03T08:00:00',
  scheduleTo: '2026-11-03T17:00:00',
  status: 'Active',
  branches: [{ branchId: 1 }, { branchId: 2 }, { branchId: 3 }],
});

function member(id, code, name, branchId, extra = {}) {
  return {
    memberId: id,
    accountCode: code,
    memberName: name,
    memberContactNumber: '0917 000 0000',
    memberAddress: 'Poblacion, Sample City',
    branchId,
    branch: { 1: 'Main Branch', 2: 'East Branch', 3: 'West Branch', 9: 'Outside Branch' }[branchId] ?? `Branch ${branchId}`,
    shareCapital: 12500,
    savingsDeposit: 4300.5,
    loanStatus: 0,
    isEligibleToVote: true,
    votingRemarks: null,
    qrIssuedAt: null,
    isActive: true,
    ...extra,
  };
}

/** The known members of the scenarios, plus 250 bulk members that all match "test member" (to pass the 200-row cap). */
export function defaultMembers() {
  const list = [
    member(1, 'A0001', 'Juan Dela Cruz', 1),
    member(2, 'A0002', 'Maria Dela Cruz-Santos', 1, { qrIssuedAt: '2026-11-03T01:30:00.000' }),
    member(3, 'A0003', 'Pedro Penduko', 2, { isEligibleToVote: false, votingRemarks: 'Share capital is below the minimum.' }),
    member(4, 'A0004', 'Josefa Peña', 2),
    member(5, 'A0005', 'Ian Inactive', 3, { isActive: false }),
    member(6, 'B0006', 'Ligaya Reyes', 3),
    member(7, 'A0007', 'Dela Rosa, Ramon', 1),
    member(8, 'C0008', 'Zed Outsider', 9),
  ];
  for (let i = 1; i <= 250; i++) {
    list.push(member(1000 + i, `T${String(i).padStart(4, '0')}`, `Test Member ${String(i).padStart(3, '0')}`, 1 + (i % 3)));
  }
  return list;
}

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function createStub({ key, cert, allowedOrigins = null, host = '127.0.0.1' } = {}) {
  const state = {
    users: { clerk: { password: 'correct horse', fullName: 'Ana Reyes' } },
    event: structuredClone(EVENT),
    members: defaultMembers(),
    tokens: new Map(), // token -> expiry (ms)
    allowedOrigins, // null = any origin (the server's behaviour when EVOTING_ALLOWED_ORIGINS is empty); [] of strings = only these
    latencyMs: 0,
    delayFor: null, // (req) => ms
    loginLimit: null, // { max, windowMs } -> answers 429 after max attempts inside the window
    loginAttempts: [],
    injections: [], // { method?, path: RegExp, type, status?, body?, delayMs?, times }
    log: [],
    logins: 0,
    down: false, // true: every connection is dropped at once
  };

  const original = new Map(state.members.map((m) => [m.memberId, { ...m }]));

  function issueToken(username) {
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ name: state.users[username].fullName, unique_name: username, role: 'Registration', exp: now + 28800, jti: randomUUID() })}.stub-signature`;
    state.tokens.set(token, Date.now() + 28800 * 1000);
    return token;
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const headers = { Vary: 'Origin' };
    if (!origin) return headers;
    const allowed = state.allowedOrigins === null || state.allowedOrigins.includes(origin);
    if (allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
      if (state.allowedOrigins !== null) headers['Access-Control-Allow-Credentials'] = 'true';
    }
    return headers;
  }

  function send(res, req, status, body, extra = {}) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    // One connection per request: Chromium silently repeats a request whose REUSED connection is reset before any answer, which
    // would hide the "answer lost" cases these tests are about (the repeat is harmless for qr-issued: the server only stamps the time).
    const headers = { ...corsHeaders(req), Connection: 'close', ...extra };
    if (text) headers['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
    res.writeHead(status, headers);
    res.end(text);
  }

  function authorized(req) {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) return false;
    const expiry = state.tokens.get(m[1]);
    return expiry !== undefined && expiry > Date.now();
  }

  function takeInjection(method, path) {
    const index = state.injections.findIndex((i) => (!i.method || i.method === method) && i.path.test(path) && i.times > 0);
    if (index < 0) return null;
    const inj = state.injections[index];
    inj.times -= 1;
    if (inj.times <= 0) state.injections.splice(index, 1);
    return inj;
  }

  async function handle(req, res) {
    if (state.down) {
      req.socket.destroy(); // the whole server is unreachable (power cut, cable out)
      return;
    }
    const url = new URL(req.url, 'https://stub.invalid');
    const path = url.pathname;
    const entry = {
      method: req.method,
      path,
      query: url.search,
      params: url.searchParams,
      origin: req.headers.origin ?? null,
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      referer: req.headers.referer ?? null,
      secFetchMode: req.headers['sec-fetch-mode'] ?? null,
      host: req.headers.host ?? null,
      sni: req.socket.servername || null, // the name the caller asked for in the TLS handshake (a reverse proxy must send it)
      forwardedFor: req.headers['x-forwarded-for'] ?? null,
      forwardedProto: req.headers['x-forwarded-proto'] ?? null,
      at: Date.now(),
    };
    state.log.push(entry);

    // CORS pre-flight
    if (req.method === 'OPTIONS') {
      const headers = corsHeaders(req);
      const origin = req.headers.origin;
      const allowed = origin && (state.allowedOrigins === null || state.allowedOrigins.includes(origin));
      if (allowed) {
        headers['Access-Control-Allow-Headers'] = req.headers['access-control-request-headers'] ?? '*';
        headers['Access-Control-Allow-Methods'] = req.headers['access-control-request-method'] ?? 'GET,POST';
      }
      headers.Connection = 'close';
      res.writeHead(204, headers);
      res.end();
      return;
    }

    // body
    let raw = '';
    for await (const chunk of req) raw += chunk;

    const inj = takeInjection(req.method, path);
    const delay = (inj?.delayMs ?? 0) + state.latencyMs + (state.delayFor ? state.delayFor(entry) : 0);
    if (inj?.type === 'drop-before') {
      req.socket.destroy();
      return;
    }
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (inj?.type === 'hang') return; // never answers
    if (inj?.type === 'status') {
      send(res, req, inj.status, inj.body, inj.headers ?? {});
      return;
    }

    const answer = (status, body, extra) => {
      if (inj?.type === 'drop-after') {
        req.socket.destroy(); // the work was done; the answer never arrives
        return;
      }
      send(res, req, status, body, extra);
    };

    // ── anonymous ──
    if (req.method === 'GET' && path === '/api/v1/health/live') {
      send(res, req, 200, { status: 'alive', utc: new Date().toISOString() });
      return;
    }
    if (req.method === 'POST' && path === '/api/v1/auth/registration-login') {
      state.logins += 1;
      if (state.loginLimit) {
        const now = Date.now();
        state.loginAttempts = state.loginAttempts.filter((t) => now - t < state.loginLimit.windowMs);
        state.loginAttempts.push(now);
        if (state.loginAttempts.length > state.loginLimit.max) {
          send(res, req, 429, undefined, state.loginLimit.retryAfter ? { 'Retry-After': String(state.loginLimit.retryAfter) } : {});
          return;
        }
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, req, 400, { error: 'Malformed request body.' });
        return;
      }
      const user = state.users[body.username];
      if (!user || user.password !== body.password) {
        send(res, req, 401, { error: 'Invalid username or password.' });
        return;
      }
      send(res, req, 200, { accessToken: issueToken(body.username), expiresIn: 28800, role: 'Registration' });
      return;
    }

    // ── bearer-only ──
    if (!authorized(req)) {
      send(res, req, 401, undefined, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/events/current') {
      if (!state.event) send(res, req, 404, { error: 'No active event.' });
      else send(res, req, 200, state.event);
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/registration/members/search') {
      const q = strip(url.searchParams.get('query') ?? '');
      if (q.length < 2) {
        send(res, req, 400, { error: 'Query must be at least 2 characters.' });
        return;
      }
      const branches = url.searchParams.getAll('branchIds').map(Number);
      const hits = state.members
        .filter((m) => branches.includes(m.branchId) && (strip(m.memberName).includes(q) || strip(m.accountCode).includes(q)))
        .sort((a, b) => strip(a.memberName).localeCompare(strip(b.memberName)))
        .slice(0, 200);
      answer(200, hits);
      return;
    }

    const issued = /^\/api\/v1\/registration\/members\/(\d+)\/qr-issued$/.exec(path);
    if (req.method === 'POST' && issued) {
      const m = state.members.find((x) => x.memberId === Number(issued[1]));
      if (!m) {
        answer(404, { error: 'Member not found.' });
        return;
      }
      m.qrIssuedAt = new Date().toISOString().replace('Z', '');
      entry.recorded = true;
      answer(200, { message: 'QR issuance recorded.', memberId: m.memberId, qrIssuedAt: m.qrIssuedAt });
      return;
    }

    send(res, req, 404, { error: 'Not found.' });
  }

  const server = https.createServer({ key, cert }, (req, res) => {
    handle(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        /* the test is over */
      }
    });
  });

  return {
    state,
    server,
    /** Starts listening on a free port; resolves with the port. */
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, host, () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),

    // ── helpers for scenarios ──
    inject: (spec) => state.injections.push({ times: 1, ...spec }),
    revokeTokens: () => state.tokens.clear(),
    member: (id) => state.members.find((m) => m.memberId === id),
    resetMember: (id) => Object.assign(state.members.find((m) => m.memberId === id), original.get(id)),
    requests: (matcher) => state.log.filter((e) => matcher(e)),
    count: (method, pathRe) => state.log.filter((e) => e.method === method && pathRe.test(e.path)).length,
    searches: () => state.log.filter((e) => e.method === 'GET' && e.path === '/api/v1/registration/members/search'),
    issues: () => state.log.filter((e) => e.method === 'POST' && /\/qr-issued$/.test(e.path)),
  };
}
