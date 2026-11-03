// Helpers shared by tools/set-api-url.mjs, tools/check-bundle.mjs and the tests. No dependencies.
//
// The page may only talk to the addresses its Content-Security-Policy lists (connect-src), so the server address exists in THREE
// places that must always agree: config.js (apiBaseUrl), the policy in index.html and the policy in _headers.

import { validateApiBaseUrl } from '../js/api.js';

const META_CSP = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i;
const HEADER_CSP = /^(\s*Content-Security-Policy:\s*)(.+)$/im;
const API_BASE_URL = /(apiBaseUrl\s*:\s*)(['"])([^'"]*)\2/;

export const readMetaCsp = (html) => META_CSP.exec(html)?.[2] ?? null;
export const readHeaderCsp = (headers) => HEADER_CSP.exec(headers)?.[2].trim() ?? null;

/** The headers of one block of a _headers file as { 'x-frame-options': 'DENY', ... } (names in lower case); {} when there is no such block. */
export function readHeaderBlock(headers, pattern = '/*') {
  const result = {};
  let inBlock = false;
  for (const raw of String(headers).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inBlock = raw.trim() === pattern;
      continue;
    }
    const colon = raw.indexOf(':');
    if (inBlock && colon > 0) result[raw.slice(0, colon).trim().toLowerCase()] = raw.slice(colon + 1).trim();
  }
  return result;
}

/** { 'default-src': "'none'", 'connect-src': "'self' https://api...", ... } */
export function parseCsp(csp) {
  const result = {};
  for (const part of String(csp ?? '').split(';')) {
    const text = part.trim();
    if (!text) continue;
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    result[name] = space < 0 ? '' : text.slice(space).trim().replace(/\s+/g, ' ');
  }
  return result;
}

/** The policy without directives a <meta> tag cannot carry, so index.html and _headers can be compared. */
export function cspForMeta(csp) {
  return String(csp)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(frame-ancestors|report-uri|sandbox)\b/i.test(s))
    .join('; ');
}

/** '' for "same site as the page", otherwise the origin of the configured address. Throws a sentence when the address is not usable. */
export function originFor(apiBaseUrl) {
  const raw = String(apiBaseUrl ?? '').trim();
  const problem = validateApiBaseUrl(raw);
  if (problem) throw new Error(problem);
  return raw === '' ? '' : new URL(raw).origin;
}

/** What connect-src must say for a given apiBaseUrl. */
export const connectSrcFor = (apiBaseUrl) => {
  const origin = originFor(apiBaseUrl);
  return origin ? `'self' ${origin}` : "'self'";
};

export function readApiBaseUrl(configText) {
  const m = API_BASE_URL.exec(configText);
  return m ? m[3] : null;
}

export function replaceApiBaseUrl(configText, apiBaseUrl) {
  if (!API_BASE_URL.test(configText)) throw new Error('config.js has no apiBaseUrl line to change.');
  return configText.replace(API_BASE_URL, (_all, head, quote) => `${head}${quote}${apiBaseUrl}${quote}`);
}

function withConnectSrc(csp, value) {
  const parts = csp.split(';').map((s) => s.trim());
  let found = false;
  const next = parts.map((p) => {
    if (/^connect-src(\s|$)/i.test(p)) {
      found = true;
      return `connect-src ${value}`;
    }
    return p;
  });
  if (!found) throw new Error('The Content-Security-Policy has no connect-src directive.');
  return next.filter(Boolean).join('; ');
}

export function replaceMetaConnectSrc(html, value) {
  if (!META_CSP.test(html)) throw new Error('index.html has no Content-Security-Policy <meta> tag.');
  return html.replace(META_CSP, (_all, a, csp, b) => `${a}${withConnectSrc(csp, value)}${b}`);
}

export function replaceHeaderConnectSrc(headers, value) {
  if (!HEADER_CSP.test(headers)) throw new Error('_headers has no Content-Security-Policy line.');
  return headers.replace(HEADER_CSP, (_all, a, csp) => `${a}${withConnectSrc(csp.trim(), value)}`);
}
