#!/usr/bin/env node
// Is tests/deploy/check-nginx.mjs any good? This breaks the nginx example on purpose, one line at a time, in a COPY of this folder, and runs
// the deployment test on the copy. CAUGHT = the test failed (good).
//
//   node tests/mutation/run-nginx-mutations.mjs                 all breakages (about 3 minutes; needs nginx)
//   node tests/mutation/run-nginx-mutations.mjs D02,D10         some of them
//   node tests/mutation/run-nginx-mutations.mjs --list

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE = 'docs/samples/nginx-evoting-registration.conf';

export const NGINX_MUTATIONS = [
  ['D01', 'proxy_pass with a path: /api/ is cut off the request', 'proxy_pass $evoting_api;', 'proxy_pass $evoting_api/;'],
  ['D02', 'the security headers are not sent on error pages (no "always" on the policy)', "trusted-types 'none'\" always;", "trusted-types 'none'\";"],
  ['D03', 'no Cache-Control for the page (expires -1 removed)', '    expires -1;\n', ''],
  ['D04', 'no compression (gzip off)', 'gzip on;', 'gzip off;'],
  ['D05', 'the style sheet is kept for a year (a new design would not reach the desks)', '    location / {\n        try_files $uri $uri/ =404;\n    }\n', '    location / {\n        try_files $uri $uri/ =404;\n    }\n\n    location /css/ {\n        expires 1y;\n    }\n'],
  ['D06', 'the policy of the host lets the page talk to another server', "connect-src 'self';", "connect-src 'self' https://evil.test;"],
  ['D07', 'http:// is redirected to the front page: path and query are lost', 'return 301 https://$host$request_uri;', 'return 301 https://$host/;'],
  ['D08', "the API's name is not sent in the TLS handshake (proxy_ssl_server_name removed)", '        proxy_ssl_server_name on;\n', ''],
  ['D09', 'Host is not set: the platform would route by the wrong name', '        proxy_set_header Host api.eballotsacdeco.site;', '        # proxy_set_header Host api.eballotsacdeco.site;'],
  ['D10', "the API's certificate is not checked (proxy_ssl_verify off)", '        proxy_ssl_verify on;', '        proxy_ssl_verify off;'],
  ['D11', "no resolver: the API's name cannot be looked up", '        resolver 1.1.1.1 8.8.8.8 valid=60s;', '        # resolver 1.1.1.1 8.8.8.8 valid=60s;'],
  ['D12', "the client's own X-Forwarded-For is passed on", 'proxy_set_header X-Forwarded-For $remote_addr;', 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'],
  ['D13', 'X-Frame-Options is not sent', '    add_header X-Frame-Options "DENY" always;\n', ''],
  ['D14', 'a missing file is answered with the front page (single-page fallback)', 'try_files $uri $uri/ =404;', 'try_files $uri /index.html;'],
  ['D15', 'the API is not forwarded at all (location /api/ points to a wrong path)', 'location /api/ {', 'location /apx/ {'],
  ['D16', 'the wrong Referrer-Policy', 'Referrer-Policy "no-referrer"', 'Referrer-Policy "origin"'],
  ['D17', 'the search text is written to the log (the log line contains the whole request)', "log_format evoting '$remote_addr [$time_local] \"$request_method $uri\" $status", "log_format evoting '$remote_addr [$time_local] \"$request\" $status"],
];

if (process.argv.includes('--list')) {
  for (const [id, what] of NGINX_MUTATIONS) console.log(`${id}  ${what}`);
  process.exit(0);
}
const wanted = process.argv.slice(2).find((a) => !a.startsWith('-'));
const only = wanted ? new Set(wanted.split(',')) : null;

function run(cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', ['tests/deploy/check-nginx.mjs'], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const work = await mkdtemp(path.join(os.tmpdir(), 'evoting-nginx-mutation-'));
let caught = 0;
let total = 0;
try {
  for (const [id, what, find, replace] of NGINX_MUTATIONS) {
    if (only && !only.has(id)) continue;
    const dir = path.join(work, id);
    await mkdir(dir, { recursive: true });
    await cp(WEB, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}tests${path.sep}e2e${path.sep}out`) });
    await symlink(path.join(WEB, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const file = path.join(dir, SAMPLE);
    const text = await readFile(file, 'utf8');
    const found = text.split(find).length - 1;
    if (found !== 1) {
      console.log(`ERROR    ${id}  ${what}\n           the text to change was found ${found} times: the example has changed, update this list`);
      process.exitCode = 2;
      continue;
    }
    await writeFile(file, text.replace(find, replace));
    const t0 = Date.now();
    const { code, out } = await run(dir);
    if (/SKIPPED/.test(out)) {
      console.log(out.trim());
      process.exitCode = 0;
      break;
    }
    const failed = [...out.matchAll(/^\s+FAIL\s+(.*)$/gm)].map((x) => x[1].trim());
    total++;
    if (code !== 0) caught++;
    console.log(`${code !== 0 ? 'CAUGHT  ' : 'SURVIVED'} ${id}  ${what}\n           ${code !== 0 ? `failed ${failed.length}: ${failed.slice(0, 3).join(' | ')}` : 'all passed'}   [${Math.round((Date.now() - t0) / 1000)} s]`);
    await rm(dir, { recursive: true, force: true });
  }
  if (total) console.log(`\n${total} breakages: ${caught} caught, ${total - caught} survived.`);
  if (total && caught < total) process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
