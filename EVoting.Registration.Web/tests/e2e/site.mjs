// Serves a COPY of the web app the way a real static host would: over https, with the headers of the shipped _headers file
// (so the test runs under the real Content-Security-Policy), optionally forwarding /api/ to the server (same-site mode).
// The copy is made with the shipped tools/set-api-url.mjs, so that tool is exercised by every run.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyApiUrl } from '../../tools/set-api-url.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COPY = ['index.html', 'favicon.svg', 'config.js', '_headers', 'css', 'js', 'vendor'];

// Like a stock nginx or IIS: nothing is served as JavaScript unless it ends in .js (so a ".mjs" file would make a test fail, as it would on a real host).
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** A self-signed certificate valid for the test host names. Generated once per run. */
export function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=registration.test', '-addext', 'subjectAltName=DNS:registration.test,DNS:api.test,DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { keyPath: key, certPath: cert };
}

/** Parses a Netlify-style _headers file into [{ pattern, headers: {name: value} }]. */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(':');
      current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

const patternMatches = (pattern, urlPath) => (pattern.endsWith('/*') ? urlPath.startsWith(pattern.slice(0, -1)) || pattern === '/*' : pattern === urlPath);

/**
 * @param {object} options
 * @param {{key: Buffer, cert: Buffer}} options.tls
 * @param {number} options.apiPort         the stub's port
 * @param {'cross'|'same'} options.mode    cross: config.js names the API's own address; same: apiBaseUrl is "" and /api/ is forwarded
 * @param {object} [options.config]        overrides for the numbers in config.js (timeouts, idle lock, ...)
 */
export async function startSite({ tls, apiPort, mode = 'cross', config = {}, apiHost = 'api.test', tweak = null }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evoting-web-'));
  for (const name of COPY) await cp(path.join(WEB_ROOT, name), path.join(dir, name), { recursive: true });

  // 1. point the copy at the stub with the shipped tool
  const apiUrl = mode === 'same' ? '' : `https://${apiHost}:${apiPort}`;
  const applied = applyApiUrl(
    { config: await readFile(path.join(dir, 'config.js'), 'utf8'), html: await readFile(path.join(dir, 'index.html'), 'utf8'), headers: await readFile(path.join(dir, '_headers'), 'utf8') },
    apiUrl,
  );
  let configText = applied.config;
  // 2. test-sized numbers
  for (const [name, value] of Object.entries(config)) {
    const re = new RegExp(`(\\b${name}\\s*:\\s*)([^,\\n]+)(,?)`);
    if (!re.test(configText)) throw new Error(`config.js has no ${name}`);
    configText = configText.replace(re, (_a, head, _old, comma) => `${head}${typeof value === 'string' ? JSON.stringify(value) : value}${comma}`);
  }
  await writeFile(path.join(dir, 'config.js'), configText);
  await writeFile(path.join(dir, 'index.html'), applied.html);
  await writeFile(path.join(dir, '_headers'), applied.headers);
  if (tweak) await tweak(dir); // a test that needs a deliberately wrong deployment

  const rules = parseHeadersFile(applied.headers);
  const log = [];

  const server = https.createServer(tls, async (req, res) => {
    const url = new URL(req.url, 'https://site.invalid');
    log.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });

    if (mode === 'same' && url.pathname.startsWith('/api/')) {
      const upstream = https.request(
        { host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: { ...req.headers, host: `${apiHost}:${apiPort}` }, rejectUnauthorized: false },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => req.socket.destroy());
      req.pipe(upstream);
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const headers = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' };
      for (const rule of rules) if (patternMatches(rule.pattern, rel)) Object.assign(headers, rule.headers);
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    dir,
    port,
    origin: `https://registration.test:${port}`,
    url: `https://registration.test:${port}/`,
    apiUrl,
    log,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
