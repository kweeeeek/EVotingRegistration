#!/usr/bin/env node
// Is the page, as the web host really serves it, the page this folder describes?
//
//   node tools/check-site.mjs https://registration.example.org [--insecure] [--dir <folder>]
//
// check-bundle.mjs looks at the FOLDER before it is uploaded. This looks at the HOST afterwards, from outside, the way a browser would:
//   * every file of the upload set is there, with the same content, and scripts are served as JavaScript (a host whose MIME table lacks
//     a file type makes the browser refuse to run it);
//   * the page comes with the security headers of _headers, and the Content-Security-Policy is the one in this folder;
//   * the API can be reached the way config.js says: through /api/ on this same address (apiBaseUrl ""), or at its own address with
//     CORS that lists this page (EVOTING_ALLOWED_ORIGINS on the server).
// It sends no sign-in and changes nothing on the server: it only reads. --insecure accepts a certificate that is not trusted (a test host).
// Exit code: 0 = all good, 1 = something to fix, 2 = wrong use.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsp, readApiBaseUrl, readHeaderBlock } from './lib.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UPLOAD_FILES = ['index.html', 'favicon.svg', 'config.js'];
export const UPLOAD_FOLDERS = ['css', 'js', 'fonts', 'vendor'];
const HEALTH_PATH = '/api/v1/health/live';

/** What a browser needs the Content-Type of each kind of file to be. */
const MIME = [
  [/\.js$/, /^(text|application)\/(x-)?(java|ecma)script\b/i, 'JavaScript'],
  [/\.css$/, /^text\/css\b/i, 'text/css'],
  [/\.html$/, /^text\/html\b/i, 'text/html'],
  [/\.svg$/, /^image\/svg\+xml\b/i, 'image/svg+xml'],
  [/\.woff2$/, /^(font\/woff2|application\/(x-)?font-woff2)\b/i, 'font/woff2'],
];

/** One request, answered or not: { status, headers, body } - or { error }. Never throws. */
export function httpRequest(url, { method = 'GET', headers = {}, insecure = false, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ error: `"${url}" is not an address.` });
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, { method, headers: { 'User-Agent': 'evoting-check-site', ...headers }, rejectUnauthorized: !insecure, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)])), body: Buffer.concat(chunks) }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} seconds`)));
    req.on('error', (e) => resolve({ error: e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /certificate/i.test(e.message) ? `${e.message} (a test host with its own certificate? use --insecure)` : e.message || e.code || String(e) }));
    req.end();
  });
}

async function* walk(dir, rel = '') {
  for (const entry of (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(dir, next);
    else yield next;
  }
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 12);

/**
 * @param {string} base      the address of the page, e.g. https://registration.example.org
 * @param {object} [options]
 * @param {string} [options.root]       the folder that was uploaded (default: the folder this tool is in)
 * @param {boolean} [options.insecure]  accept an untrusted certificate
 * @param {typeof httpRequest} [options.request]
 * @returns {Promise<{problems: string[], notes: string[]}>}
 */
export async function checkSite(base, { root = DEFAULT_ROOT, insecure = false, request = httpRequest } = {}) {
  const problems = [];
  const notes = [];
  const bad = (text) => problems.push(text);
  const get = (relative, opts = {}) => request(new URL(relative, base).href, { insecure, ...opts });

  let site;
  try {
    site = new URL(base);
  } catch {
    return { problems: [`"${base}" is not a web address.`], notes };
  }
  if (site.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(site.hostname)) bad('The address must start with https:// - a sign-in sent over plain http can be read on the way.');
  const origin = site.origin;

  // ── the page itself and the headers ───────────────────────────────────────────────────────────────
  const page = await get('/');
  if (page.error) {
    bad(`${origin}/ cannot be reached: ${page.error}`);
    return { problems, notes };
  }
  if (page.status !== 200) bad(`/ answered HTTP ${page.status}, not 200.`);

  let expected = {};
  try {
    expected = readHeaderBlock(await readFile(path.join(root, '_headers'), 'utf8'), '/*');
  } catch {
    notes.push('_headers is not in this folder: the response headers were not compared.');
  }
  for (const [name, want] of Object.entries(expected)) {
    const got = page.headers?.[name];
    if (got === undefined) {
      bad(`The host does not send the header ${name} (expected: ${want.length > 90 ? `${want.slice(0, 87)}...` : want}). Add it to the host's configuration - docs/WEB-DEPLOY.md.`);
    } else if (name === 'content-security-policy') {
      const wantDirectives = parseCsp(want);
      const gotDirectives = parseCsp(got);
      for (const directive of new Set([...Object.keys(wantDirectives), ...Object.keys(gotDirectives)])) {
        if (wantDirectives[directive] !== gotDirectives[directive]) bad(`Content-Security-Policy: ${directive} is "${gotDirectives[directive] ?? '(missing)'}" on the host, but this folder has "${wantDirectives[directive] ?? '(none)'}".`);
      }
    } else if (name === 'cache-control') {
      if (!/no-cache|no-store|max-age=0/i.test(got)) bad(`cache-control of the page is "${got}": a changed page would not be picked up until it expires. Use "no-cache".`);
    } else if (got.replace(/\s+/g, ' ').toLowerCase() !== want.replace(/\s+/g, ' ').toLowerCase()) {
      bad(`The header ${name} is "${got}" on the host, but this folder has "${want}".`);
    }
  }

  // ── every file of the upload set ──────────────────────────────────────────────────────────────────
  const files = [...UPLOAD_FILES];
  for (const folder of UPLOAD_FOLDERS) for await (const file of walk(root, folder)) files.push(file);
  let compared = 0;
  for (const file of files) {
    let local;
    try {
      local = await readFile(path.join(root, file));
    } catch {
      continue; // a file this folder does not have
    }
    const r = await get(file === 'index.html' ? '/index.html' : `/${file}`);
    if (r.error) {
      bad(`${file}: ${r.error}`);
      continue;
    }
    if (r.status !== 200) {
      bad(`${file}: the host answers HTTP ${r.status} - the file was not uploaded, or is not served.`);
      continue;
    }
    const type = r.headers['content-type'] ?? '';
    const rule = MIME.find(([ext]) => ext.test(file));
    if (rule && !rule[1].test(type)) bad(`${file}: served as "${type || 'no type'}", but a browser needs ${rule[2]}${file.endsWith('.js') ? ' (it refuses to run a script with another type)' : ''}. Add the type to the host's MIME table.`);
    if (/\.(js|css|svg)$/.test(file) && r.headers['x-content-type-options']?.toLowerCase() !== 'nosniff') bad(`${file}: no "X-Content-Type-Options: nosniff".`);
    if (!r.body.equals(local)) bad(`${file}: the host has different content (${r.body.length} bytes, sha256 ${sha(r.body)}...) than this folder (${local.length} bytes, ${sha(local)}...). Upload it again; a host that "optimises" files (minify, rewrite) must be told to leave these alone.`);
    compared++;
  }
  notes.push(`${compared} files compared with the host.`);
  if (page.status === 200) {
    const local = await readFile(path.join(root, 'index.html'));
    if (!page.body.equals(local)) bad('/ is not the index.html of this folder.');
  }

  // ── plain http ────────────────────────────────────────────────────────────────────────────────────
  if (site.protocol === 'https:' && (site.port === '' || site.port === '443')) {
    const plain = await request(`http://${site.hostname}/`, { insecure, timeoutMs: 5000 });
    if (plain.error) notes.push('Port 80 is closed or unreachable (fine: the page is only offered over https).');
    else if ([301, 302, 307, 308].includes(plain.status) && /^https:\/\//i.test(plain.headers.location ?? '')) notes.push('http:// is redirected to https:// (good).');
    else if (plain.status === 200) bad('The page is also served over plain http:// - a sign-in typed there travels in the clear. Redirect http:// to https://.');
  }

  // ── the API, the way config.js says ───────────────────────────────────────────────────────────────
  let apiBaseUrl = null;
  try {
    apiBaseUrl = readApiBaseUrl(await readFile(path.join(root, 'config.js'), 'utf8'));
  } catch {
    bad('config.js cannot be read in this folder.');
  }
  if (apiBaseUrl === null) {
    bad('config.js has no apiBaseUrl.');
  } else if (apiBaseUrl === '') {
    const r = await get(HEALTH_PATH);
    if (r.error) bad(`${HEALTH_PATH} on this address cannot be reached: ${r.error}`);
    else if (r.status === 200) notes.push(`apiBaseUrl is "" and ${HEALTH_PATH} answers through this address (the reverse proxy works).`);
    else bad(`apiBaseUrl is "" (the API is expected on this same address), but ${HEALTH_PATH} answers HTTP ${r.status}. The reverse proxy for /api/ is missing or points to the wrong server.`);
  } else {
    const live = await request(new URL(HEALTH_PATH, apiBaseUrl).href, { insecure });
    if (live.error) bad(`The API at ${apiBaseUrl} cannot be reached: ${live.error}`);
    else if (live.status !== 200) bad(`${apiBaseUrl}${HEALTH_PATH} answers HTTP ${live.status}.`);
    else notes.push(`The API at ${apiBaseUrl} answers.`);
    const preflight = await request(new URL('/api/v1/auth/registration-login', apiBaseUrl).href, {
      method: 'OPTIONS',
      insecure,
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    if (preflight.error) bad(`The API's answer to the browser's pre-flight check could not be read: ${preflight.error}`);
    else {
      const allow = preflight.headers['access-control-allow-origin'];
      if (allow === origin) notes.push(`The API lists this page (${origin}) as an allowed origin.`);
      else if (allow === '*') notes.push(`The API allows every origin (EVOTING_ALLOWED_ORIGINS is not set on the server). It works; listing ${origin} there is safer.`);
      else bad(`The API does not allow this page: the pre-flight for Origin ${origin} was answered with Access-Control-Allow-Origin ${allow === undefined ? '(none)' : `"${allow}"`}. Add ${origin} to EVOTING_ALLOWED_ORIGINS on the server (comma-separated, no spaces, no trailing slash), or use the same-address setup.`);
    }
  }

  return { problems, notes };
}

export async function run(argv, { log = console.log } = {}) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const value = args[i + 1];
    args.splice(i, flag === '--insecure' ? 1 : 2);
    return flag === '--insecure' ? true : value;
  };
  const insecure = take('--insecure') === true;
  const root = take('--dir') ?? DEFAULT_ROOT;
  if (args.length !== 1 || args[0].startsWith('-')) {
    log('Usage: node tools/check-site.mjs <https://address-of-the-page> [--insecure] [--dir <folder>]');
    return 2;
  }
  const { problems, notes } = await checkSite(args[0].replace(/\/+$/, ''), { root: path.resolve(root), insecure });
  for (const n of notes) log(`  ${n}`);
  if (problems.length === 0) {
    log('OK - the host serves this folder, with the headers it should have, and the API can be reached the way config.js says.');
    return 0;
  }
  for (const p of problems) log(`PROBLEM  ${p}`);
  log(`${problems.length} problem${problems.length === 1 ? '' : 's'} to fix.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run(process.argv.slice(2));
