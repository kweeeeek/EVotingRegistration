// tools/check-site.mjs looks at the web HOST from outside. Here the host is a stand-in (a table of files, headers and types that a
// test may spoil one entry of) and the tool must say what is wrong - and be silent when nothing is. A few tests use real sockets.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { checkSite, httpRequest, run } from '../../tools/check-site.mjs';
import { readHeaderBlock } from '../../tools/lib.mjs';
import { run as setApiUrl } from '../../tools/set-api-url.mjs';
import { makeCertificate } from '../e2e/site.mjs';
import { withBundleCopy } from './bundle-fixture.mjs';

const PAGE = 'https://registration.example.org';
const API = 'https://api.example.com';
const quiet = () => {};

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, next)));
    else out.push(next);
  }
  return out;
}

/**
 * A web host that serves a copy of the folder correctly. `host` can be spoiled by a test: files, headers, types, the API.
 * @param {string} dir      a scratch copy of the web folder
 * @param {object} [options]
 * @param {string} [options.api]   apiBaseUrl to put into the folder ('' = same address)
 */
async function makeHost(dir, { api = '' } = {}) {
  assert.equal(await setApiUrl([api, '--dir', dir], { log: quiet }), 0);
  const files = new Map();
  for (const rel of ['index.html', 'favicon.svg', 'config.js', ...(await listFiles(dir, 'css')), ...(await listFiles(dir, 'js')), ...(await listFiles(dir, 'vendor'))]) {
    files.set(`/${rel}`, await readFile(path.join(dir, rel)));
  }
  files.set('/', files.get('/index.html'));
  const host = {
    files,
    headers: new Map(Object.entries(readHeaderBlock(await readFile(path.join(dir, '_headers'), 'utf8'), '/*'))),
    typeOf: (p) => (p === '/' ? TYPES['.html'] : (TYPES[path.extname(p)] ?? 'application/octet-stream')),
    proxy: true, // /api/ on the page's own address reaches the server
    plainHttp: { error: 'connect ECONNREFUSED' }, // what http://host/ does
    api: { health: 200, allowOrigin: PAGE, reachable: true },
    requests: [],
    async request(url, { method = 'GET', headers = {} } = {}) {
      const u = new URL(url);
      host.requests.push(`${method} ${url}`);
      if (u.protocol === 'http:' && u.origin !== new URL(API).origin) return host.plainHttp;
      if (u.origin === PAGE) {
        if (u.pathname === '/api/v1/health/live') return host.proxy ? { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"status":"Healthy"}') } : { status: 404, headers: {}, body: Buffer.from('not found') };
        const body = host.files.get(u.pathname);
        if (!body) return { status: 404, headers: Object.fromEntries(host.headers), body: Buffer.from('not found') };
        return { status: 200, headers: { ...Object.fromEntries(host.headers), 'content-type': host.typeOf(u.pathname) }, body };
      }
      if (u.origin === API) {
        if (!host.api.reachable) return { error: 'getaddrinfo ENOTFOUND api.example.com' };
        if (method === 'OPTIONS') {
          assert.equal(headers.Origin, PAGE, 'the pre-flight must name the page as its origin');
          return { status: 204, headers: host.api.allowOrigin === undefined ? {} : { 'access-control-allow-origin': host.api.allowOrigin }, body: Buffer.alloc(0) };
        }
        if (u.pathname === '/api/v1/health/live') return { status: host.api.health, headers: {}, body: Buffer.from('{}') };
      }
      return { error: `nothing at ${url}` };
    },
  };
  return host;
}

async function inspect(dir, host, options = {}) {
  return checkSite(PAGE, { root: dir, request: host.request, ...options });
}

const has = (list, pattern) => list.some((x) => pattern.test(x));

describe('a host that is set up right', () => {
  test('on the same address as the API: no problem, every file compared, the proxy noticed', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      const r = await inspect(copy.dir, host);
      assert.deepEqual(r.problems, []);
      assert.ok(has(r.notes, /^\d+ files compared with the host\.$/), r.notes.join('|'));
      assert.ok(Number(/\d+/.exec(r.notes.find((n) => /files compared/.test(n)))[0]) >= 20);
      assert.ok(has(r.notes, /reverse proxy works/));
      assert.ok(has(r.notes, /Port 80 is closed/));
    });
  });

  test('with the API on its own address: reachable, and its CORS names this page', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir, { api: API });
      const r = await inspect(copy.dir, host);
      assert.deepEqual(r.problems, []);
      assert.ok(has(r.notes, /The API at https:\/\/api\.example\.com answers\./));
      assert.ok(has(r.notes, /lists this page \(https:\/\/registration\.example\.org\)/));
    });
  });

  test('it only reads: nothing but GET, and one OPTIONS pre-flight, ever leaves the tool', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir, { api: API });
      await inspect(copy.dir, host);
      assert.ok(host.requests.every((line) => /^(GET|OPTIONS) /.test(line)), host.requests.join('\n'));
      assert.equal(host.requests.filter((l) => l.startsWith('OPTIONS')).length, 1);
    });
  });
});

describe('the headers', () => {
  test('a header the host does not send is named, with where to add it', async () => {
    for (const name of ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'content-security-policy']) {
      await withBundleCopy(async (copy) => {
        const host = await makeHost(copy.dir);
        host.headers.delete(name);
        const r = await inspect(copy.dir, host);
        assert.ok(has(r.problems, new RegExp(`^The host does not send the header ${name} \\(expected: .*docs/WEB-DEPLOY\\.md`)), `${name}: ${r.problems.join('\n')}`);
      });
    }
  });

  test('a header with another value is shown with both values', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.headers.set('referrer-policy', 'origin');
      const r = await inspect(copy.dir, host);
      assert.ok(has(r.problems, /^The header referrer-policy is "origin" on the host, but this folder has "no-referrer"\.$/), r.problems.join('\n'));
    });
  });

  test('a weakened policy names the directive; a missing directive says "(missing)"; an extra one says "(none)"', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.headers.set('content-security-policy', host.headers.get('content-security-policy').replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(" frame-ancestors 'none';", '') + "; img-src 'self' data:");
      const r = await inspect(copy.dir, host);
      assert.ok(has(r.problems, /^Content-Security-Policy: script-src is "'self' 'unsafe-inline'" on the host, but this folder has "'self'"\.$/), r.problems.join('\n'));
      assert.ok(has(r.problems, /^Content-Security-Policy: frame-ancestors is "\(missing\)" on the host, but this folder has "'none'"\.$/), r.problems.join('\n'));
      assert.ok(has(r.problems, /^Content-Security-Policy: img-src is "'self' data:" on the host/), r.problems.join('\n'));
    });
  });

  test('a policy that names another server than config.js does is caught (the folder was changed, the host was not)', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.headers.set('content-security-policy', host.headers.get('content-security-policy').replace("connect-src 'self'", "connect-src 'self' https://elsewhere.example"));
      const r = await inspect(copy.dir, host);
      assert.ok(has(r.problems, /connect-src is "'self' https:\/\/elsewhere\.example" on the host, but this folder has "'self'"/), r.problems.join('\n'));
    });
  });

  test('the page must be re-checked at every load: a long cache time is a problem, "no-cache" is not', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.headers.set('cache-control', 'public, max-age=3600');
      assert.ok(has((await inspect(copy.dir, host)).problems, /^cache-control of the page is "public, max-age=3600"/));
      host.headers.set('cache-control', 'no-cache');
      assert.deepEqual((await inspect(copy.dir, host)).problems, []);
    });
  });

  test('scripts, style sheets and pictures must be served with nosniff', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      const request = host.request;
      host.request = async (url, o) => {
        const r = await request(url, o);
        if (url.endsWith('/js/api.js')) delete r.headers['x-content-type-options'];
        return r;
      };
      const r = await checkSite(PAGE, { root: copy.dir, request: host.request });
      assert.deepEqual(r.problems, ['js/api.js: no "X-Content-Type-Options: nosniff".']);
    });
  });
});

describe('the files', () => {
  test('a script served with a type a browser will not run as a module', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.typeOf = (p) => (p.endsWith('/vendor/qrcode.js') ? 'application/octet-stream' : TYPES[path.extname(p)] ?? 'text/plain');
      const r = await inspect(copy.dir, host);
      assert.deepEqual(r.problems, ['vendor/qrcode.js: served as "application/octet-stream", but a browser needs JavaScript (it refuses to run a script with another type). Add the type to the host\'s MIME table.']);
    });
  });

  test('a style sheet with the wrong type', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.typeOf = (p) => (p.endsWith('.css') ? 'text/plain' : (TYPES[path.extname(p)] ?? 'text/plain'));
      const r = await inspect(copy.dir, host);
      assert.ok(has(r.problems, /^css\/app\.css: served as "text\/plain", but a browser needs text\/css\./), r.problems.join('\n'));
    });
  });

  test('a file that was not uploaded', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.files.delete('/js/slip.js');
      const r = await inspect(copy.dir, host);
      assert.deepEqual(r.problems, ['js/slip.js: the host answers HTTP 404 - the file was not uploaded, or is not served.']);
    });
  });

  test('a file that is an older copy (or was rewritten by the host) is shown with both sizes and fingerprints', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.files.set('/config.js', Buffer.from(`${host.files.get('/config.js').toString()}\n`));
      const r = await inspect(copy.dir, host);
      assert.equal(r.problems.length, 1, r.problems.join('\n'));
      assert.match(r.problems[0], /^config\.js: the host has different content \(\d+ bytes, sha256 [0-9a-f]{12}\.\.\.\) than this folder \(\d+ bytes, [0-9a-f]{12}\.\.\.\)\./);
    });
  });

  test('/ that is not this index.html (the host\'s default page)', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.files.set('/', Buffer.from('<h1>Welcome to nginx!</h1>'));
      assert.deepEqual((await inspect(copy.dir, host)).problems, ['/ is not the index.html of this folder.']);
    });
  });
});

describe('the address and the connection', () => {
  test('a host that cannot be reached ends the check at once, with the reason', async () => {
    await withBundleCopy(async (copy) => {
      const r = await checkSite(PAGE, { root: copy.dir, request: async () => ({ error: 'getaddrinfo ENOTFOUND registration.example.org' }) });
      assert.deepEqual(r.problems, ['https://registration.example.org/ cannot be reached: getaddrinfo ENOTFOUND registration.example.org']);
    });
  });

  test('plain http is a problem, except on this PC', async () => {
    await withBundleCopy(async (copy) => {
      assert.ok(has((await checkSite('http://registration.example.org', { root: copy.dir, request: async () => ({ error: 'x' }) })).problems, /^The address must start with https:\/\//));
      assert.ok(!has((await checkSite('http://127.0.0.1:8080', { root: copy.dir, request: async () => ({ error: 'x' }) })).problems, /must start with https/));
      assert.deepEqual((await checkSite('not an address', { root: copy.dir })).problems, ['"not an address" is not a web address.']);
    });
  });

  test('port 80: a redirect to https is good, a page served there is a problem, a closed port is fine', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.plainHttp = { status: 301, headers: { location: 'https://registration.example.org/' }, body: Buffer.alloc(0) };
      const redirected = await inspect(copy.dir, host);
      assert.deepEqual(redirected.problems, []);
      assert.ok(has(redirected.notes, /redirected to https/));
      host.plainHttp = { status: 200, headers: {}, body: Buffer.from('hello') };
      assert.ok(has((await inspect(copy.dir, host)).problems, /^The page is also served over plain http/));
    });
  });
});

describe('the API', () => {
  test('on the same address but nobody forwards /api/: the page would load and every call would fail', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir);
      host.proxy = false;
      const r = await inspect(copy.dir, host);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /^apiBaseUrl is "" \(the API is expected on this same address\), but \/api\/v1\/health\/live answers HTTP 404\. The reverse proxy for \/api\/ is missing/);
    });
  });

  test('at its own address but the server does not list this page: the exact fix is named', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir, { api: API });
      host.api.allowOrigin = 'https://somebody-else.example';
      const r = await inspect(copy.dir, host);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /The API does not allow this page: the pre-flight for Origin https:\/\/registration\.example\.org was answered with Access-Control-Allow-Origin "https:\/\/somebody-else\.example"\. Add https:\/\/registration\.example\.org to EVOTING_ALLOWED_ORIGINS on the server \(comma-separated, no spaces, no trailing slash\)/);
      host.api.allowOrigin = undefined;
      assert.match((await inspect(copy.dir, host)).problems[0], /Access-Control-Allow-Origin \(none\)/);
    });
  });

  test('a server that allows every origin works, and the note says that listing the page is safer', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir, { api: API });
      host.api.allowOrigin = '*';
      const r = await inspect(copy.dir, host);
      assert.deepEqual(r.problems, []);
      assert.ok(has(r.notes, /allows every origin \(EVOTING_ALLOWED_ORIGINS is not set on the server\)\. It works; listing https:\/\/registration\.example\.org there is safer\./));
    });
  });

  test('a server that is down or unhealthy', async () => {
    await withBundleCopy(async (copy) => {
      const host = await makeHost(copy.dir, { api: API });
      host.api.reachable = false;
      const r = await inspect(copy.dir, host);
      assert.ok(has(r.problems, /^The API at https:\/\/api\.example\.com cannot be reached: getaddrinfo ENOTFOUND/), r.problems.join('\n'));
      host.api = { health: 503, allowOrigin: PAGE, reachable: true };
      assert.deepEqual((await inspect(copy.dir, host)).problems, ['https://api.example.com/api/v1/health/live answers HTTP 503.']);
    });
  });
});

describe('real sockets', () => {
  const servers = [];
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); }));
  after(() => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); }))));

  test('httpRequest reads status, headers (lower case) and body', async () => {
    const port = await listen(http.createServer((req, res) => res.writeHead(201, { 'X-Thing': 'Yes', 'Set-Cookie': ['a=1', 'b=2'] }).end(`you asked for ${req.method} ${req.url}`)));
    const r = await httpRequest(`http://127.0.0.1:${port}/x?y=1`, { method: 'POST' });
    assert.equal(r.status, 201);
    assert.equal(r.headers['x-thing'], 'Yes');
    assert.equal(r.headers['set-cookie'], 'a=1, b=2');
    assert.equal(r.body.toString(), 'you asked for POST /x?y=1');
  });

  test('httpRequest does not throw: a closed port, a nonsense address and a silent server all give { error }', async () => {
    const closed = await listen(http.createServer());
    await new Promise((resolve) => servers.pop().close(resolve));
    assert.match((await httpRequest(`http://127.0.0.1:${closed}/`)).error, /ECONNREFUSED/);
    assert.deepEqual(await httpRequest('not an address'), { error: '"not an address" is not an address.' });
    const silent = await listen(http.createServer(() => {}));
    assert.match((await httpRequest(`http://127.0.0.1:${silent}/`, { timeoutMs: 150 })).error, /no answer within 0\.15 seconds/);
  });

  test('a certificate that is not trusted is refused, with the hint; --insecure accepts it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'evoting-cert-'));
    try {
      const { keyPath, certPath } = makeCertificate(dir);
      const port = await listen(https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => res.end('hello')));
      const refused = await httpRequest(`https://localhost:${port}/`);
      assert.match(refused.error, /use --insecure/);
      const accepted = await httpRequest(`https://localhost:${port}/`, { insecure: true });
      assert.equal(accepted.body.toString(), 'hello');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the command: wrong use gives the usage and 2; a host that is not there gives 1 and says so', async () => {
    const lines = [];
    const log = (l) => lines.push(l);
    for (const args of [[], ['--help'], ['a', 'b'], ['--dir']]) {
      lines.length = 0;
      assert.equal(await run(args, { log }), 2, args.join(' '));
      assert.match(lines[0], /^Usage: node tools\/check-site\.mjs <https:\/\/address-of-the-page>/);
    }
    const closed = await listen(http.createServer());
    await new Promise((resolve) => servers.pop().close(resolve));
    lines.length = 0;
    assert.equal(await run([`http://127.0.0.1:${closed}`], { log }), 1);
    assert.match(lines[0], /^PROBLEM  http:\/\/127\.0\.0\.1:\d+\/ cannot be reached: /);
    assert.equal(lines.at(-1), '1 problem to fix.');
  });

  test('the command, end to end over a real socket: a host serving this folder correctly is OK (exit 0)', async () => {
    await withBundleCopy(async (copy) => {
      assert.equal(await setApiUrl(['', '--dir', copy.dir], { log: quiet }), 0);
      const headers = readHeaderBlock(await readFile(path.join(copy.dir, '_headers'), 'utf8'), '/*');
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/api/v1/health/live') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        try {
          const body = await readFile(path.join(copy.dir, rel));
          res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream' }).end(body);
        } catch {
          res.writeHead(404, headers).end('not found');
        }
      });
      const port = await listen(server);
      const lines = [];
      const code = await run([`http://127.0.0.1:${port}`, '--dir', copy.dir], { log: (l) => lines.push(l) });
      assert.equal(code, 0, lines.join('\n'));
      assert.equal(lines.at(-1), 'OK - the host serves this folder, with the headers it should have, and the API can be reached the way config.js says.');
    });
  });
});
