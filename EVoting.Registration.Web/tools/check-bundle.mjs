#!/usr/bin/env node
// Checks that the folder is ready to be uploaded to a web server: node tools/check-bundle.mjs [folder]
//
//  * config.js, the policy in index.html and the policy in _headers all name the same server address;
//  * the policy is strict (no 'unsafe-inline', no 'unsafe-eval', nothing but this site and the API);
//  * index.html has no inline script, style or event handler (the policy would block them);
//  * every file the page, the style sheet and the scripts refer to exists;
//  * (when `npm install` has been run) the application code uses none of the browser features listed in tools/lint.mjs.
//
// Exit code 0 = ready, 1 = something to fix (each line says what).

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectSrcFor, cspForMeta, parseCsp, readApiBaseUrl, readHeaderCsp, readMetaCsp } from './lib.mjs';
import { lintSource, loadAcorn } from './lint.mjs';

const exists = async (file) => {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
};

async function listFiles(dir, accept) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...(await listFiles(full, accept)));
    } else if (accept(full)) out.push(full);
  }
  return out;
}

const posix = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** @returns {Promise<{problems: string[], notes: string[]}>} */
export async function checkBundle(root) {
  const problems = [];
  const notes = [];
  const bad = (text) => problems.push(text);

  const configText = await readFile(path.join(root, 'config.js'), 'utf8');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const headersFile = path.join(root, '_headers');
  const headers = (await exists(headersFile)) ? await readFile(headersFile, 'utf8') : null;

  // ── the server address ────────────────────────────────────────────────────────────────────────────
  const apiBaseUrl = readApiBaseUrl(configText);
  let expected = null;
  if (apiBaseUrl === null) bad('config.js: apiBaseUrl was not found.');
  else {
    try {
      expected = connectSrcFor(apiBaseUrl);
      notes.push(`config.js: apiBaseUrl = ${apiBaseUrl === '' ? '"" (same site as the page)' : apiBaseUrl}`);
    } catch (err) {
      bad(`config.js: ${err.message}`);
    }
  }

  // ── the policy ────────────────────────────────────────────────────────────────────────────────────
  const metaCsp = readMetaCsp(html);
  const headerCsp = headers === null ? null : readHeaderCsp(headers);
  if (!metaCsp) bad('index.html: the Content-Security-Policy <meta> tag is missing.');
  if (headers === null) notes.push('_headers: not present (the web server must send the same policy plus frame-ancestors).');
  else if (!headerCsp) bad('_headers: the Content-Security-Policy line is missing.');

  for (const [label, csp] of [['index.html', metaCsp], ['_headers', headerCsp]]) {
    if (!csp) continue;
    const d = parseCsp(csp);
    if (expected !== null && d['connect-src'] !== expected) bad(`${label}: connect-src is "${d['connect-src'] ?? '(missing)'}" but config.js needs "${expected}". Run: node tools/set-api-url.mjs "${apiBaseUrl}"`);
    if (d['default-src'] !== "'none'") bad(`${label}: default-src must be 'none'.`);
    if (d['script-src'] !== "'self'") bad(`${label}: script-src must be exactly 'self'.`);
    if (d['style-src'] !== "'self'") bad(`${label}: style-src must be exactly 'self'.`);
    if (/unsafe-inline|unsafe-eval|\*|https?:\/\/[^ ]*\*/.test(csp.replace(/connect-src[^;]*/i, ''))) bad(`${label}: the policy contains 'unsafe-inline', 'unsafe-eval' or a wildcard.`);
    for (const need of ['base-uri', 'form-action', 'object-src']) if (!(need in d)) bad(`${label}: ${need} is missing.`);
  }
  if (metaCsp && headerCsp && cspForMeta(metaCsp).replace(/\s+/g, ' ') !== cspForMeta(headerCsp).replace(/\s+/g, ' ')) {
    bad('index.html and _headers carry different Content-Security-Policy values (apart from frame-ancestors).');
  }
  if (headerCsp && !/frame-ancestors\s+'none'/.test(headerCsp)) bad("_headers: frame-ancestors 'none' is missing (the page must not be framed).");

  // ── the page itself ───────────────────────────────────────────────────────────────────────────────
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) bad('index.html: an inline <script> was found; the policy blocks it.');
  if (/<style[\s>]/i.test(html)) bad('index.html: an inline <style> was found; the policy blocks it.');
  if (/\son[a-z]+\s*=/i.test(html)) bad('index.html: an inline event handler (onclick=...) was found; the policy blocks it.');
  if (/\sstyle\s*=/i.test(html)) bad('index.html: an inline style="..." was found; the policy blocks it.');

  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"#?]+)[^"]*"/gi)].map((m) => m[1]).filter((r) => !/^(https?:|data:|mailto:)/i.test(r));
  for (const ref of refs) if (!(await exists(path.join(root, ref)))) bad(`index.html: "${ref}" does not exist.`);

  // ── style sheets and scripts ──────────────────────────────────────────────────────────────────────
  for (const css of await listFiles(root, (f) => f.endsWith('.css'))) {
    const text = await readFile(css, 'utf8');
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (/^(data:|https?:|#)/i.test(m[1])) {
        if (/^https?:/i.test(m[1])) bad(`${posix(root, css)}: loads "${m[1]}" from another site.`);
        continue;
      }
      if (!(await exists(path.resolve(path.dirname(css), m[1].split(/[?#]/)[0])))) bad(`${posix(root, css)}: "${m[1]}" does not exist.`);
    }
  }

  const scripts = await listFiles(root, (f) => /\.m?js$/.test(f) && !/[\\/](tests|tools)[\\/]/.test(f));
  for (const file of scripts) {
    if (file.endsWith('.mjs')) bad(`${posix(root, file)}: a script file of the page must end in .js - IIS and older nginx do not serve ".mjs" as JavaScript, and then the browser refuses to run it.`);
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      if (!(await exists(path.resolve(path.dirname(file), m[1])))) bad(`${posix(root, file)}: imports "${m[1]}", which does not exist.`);
    }
  }

  // ── fonts and licences ────────────────────────────────────────────────────────────────────────────
  for (const lic of ['fonts/LICENSE-OFL.txt', 'vendor/LICENSE-qrcode-generator.txt']) if (!(await exists(path.join(root, lic)))) bad(`${lic} is missing (the licence must travel with the files).`);

  // ── forbidden browser features ────────────────────────────────────────────────────────────────────
  const acorn = await loadAcorn();
  if (!acorn) notes.push('Code scan skipped: run "npm install" once to enable it.');
  else {
    let count = 0;
    for (const file of scripts) {
      const rel = posix(root, file);
      if (rel.startsWith('vendor/')) continue;
      count++;
      for (const f of lintSource(acorn, await readFile(file, 'utf8'), rel)) bad(`${f.file}:${f.line}: ${f.name} - ${f.why}.`);
    }
    notes.push(`Code scan: ${count} files looked at.`);
  }

  return { problems, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { problems, notes } = await checkBundle(root);
  for (const n of notes) console.log(`  ${n}`);
  if (problems.length === 0) {
    console.log('OK - the folder is ready to upload.');
  } else {
    for (const p of problems) console.log(`PROBLEM  ${p}`);
    console.log(`${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before uploading.`);
    process.exitCode = 1;
  }
}
