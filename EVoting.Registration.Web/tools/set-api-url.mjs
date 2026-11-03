#!/usr/bin/env node
// Points this web app at an EVoting.Api server.
//
//   node tools/set-api-url.mjs https://api.eballotsacdeco.site     the API is on another address (CORS applies)
//   node tools/set-api-url.mjs ""                                  the API is on the same site as this page (/api/ is proxied)
//   node tools/set-api-url.mjs https://api.example.com --dir ./dist
//
// It changes three things and nothing else: apiBaseUrl in config.js, and connect-src in the Content-Security-Policy of index.html and
// of _headers. The policy is what lets the browser talk to the server, so the three must name the same address.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectSrcFor, originFor, replaceApiBaseUrl, replaceHeaderConnectSrc, replaceMetaConnectSrc } from './lib.mjs';

/** Applies the address to the three texts. Pure: returns the new texts (and throws a sentence when the address is not usable). */
export function applyApiUrl({ config, html, headers }, apiBaseUrl) {
  const clean = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  originFor(clean); // throws when it is not https (or localhost) / has a query / etc.
  const value = connectSrcFor(clean);
  return {
    apiBaseUrl: clean,
    connectSrc: value,
    config: replaceApiBaseUrl(config, clean),
    html: replaceMetaConnectSrc(html, value),
    headers: headers === null ? null : replaceHeaderConnectSrc(headers, value),
  };
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function run(argv, { log = console.log } = {}) {
  const args = argv.slice();
  let dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dirIndex = args.indexOf('--dir');
  if (dirIndex >= 0) {
    dir = path.resolve(args[dirIndex + 1] ?? '');
    args.splice(dirIndex, 2);
  }
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    log('Usage: node tools/set-api-url.mjs <https://api.example.com | "">  [--dir <folder>]');
    return 2;
  }

  const files = { config: path.join(dir, 'config.js'), html: path.join(dir, 'index.html'), headers: path.join(dir, '_headers') };
  const texts = { config: await readFile(files.config, 'utf8'), html: await readFile(files.html, 'utf8'), headers: await readOptional(files.headers) };

  let result;
  try {
    result = applyApiUrl(texts, args[0]);
  } catch (err) {
    log(`Not changed: ${err.message}`);
    return 1;
  }

  await writeFile(files.config, result.config);
  await writeFile(files.html, result.html);
  if (result.headers !== null) await writeFile(files.headers, result.headers);

  log(`apiBaseUrl is now ${result.apiBaseUrl === '' ? '"" (same site as the page)' : result.apiBaseUrl}`);
  log(`connect-src is now ${result.connectSrc}  (config.js, index.html${result.headers !== null ? ', _headers' : ''} updated in ${dir})`);
  if (result.apiBaseUrl === '') {
    log('Same-site mode: your web server must forward /api/ to the EVoting.Api server (see docs/WEB-DEPLOY.md).');
  } else {
    log(`Cross-site mode: on the server set EVOTING_ALLOWED_ORIGINS to include the address of THIS web page (not of the API), for example https://registration.example.com`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
