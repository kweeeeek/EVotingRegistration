// The documents and the sample configurations for web hosts must say what the page and its tools do. Nothing here needs a web server: it
// compares text with text, so it also runs on a PC that has no nginx. (tests/deploy/check-nginx.mjs runs the nginx sample for real.)

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readHeaderBlock } from '../../tools/lib.mjs';
import { applyApiUrl } from '../../tools/set-api-url.mjs';
import { UPLOAD_FILES, UPLOAD_FOLDERS } from '../../tools/check-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const NGINX = 'docs/samples/nginx-evoting-registration.conf';
const IIS = 'docs/samples/web.config';

/** The headers of _headers as they must be on a host where the page and the API share one address (connect-src 'self'). */
function sameAddressHeaders() {
  const applied = applyApiUrl({ config: read('config.js'), html: read('index.html'), headers: read('_headers') }, '');
  return readHeaderBlock(applied.headers, '/*');
}

const SECURITY = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'];

/** { 'x-frame-options': 'DENY', ... } from the add_header lines of an nginx file. */
function nginxHeaders(text) {
  const found = {};
  for (const m of text.matchAll(/^\s*add_header\s+(\S+)\s+"([^"]*)"\s+always;/gm)) found[m[1].toLowerCase()] = m[2];
  return found;
}

/** The text between the braces of every `location` block of an nginx file. */
function nginxLocations(text) {
  const blocks = [];
  for (const m of text.matchAll(/^\s*location\s+[^{]+\{/gm)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      i++;
    }
    blocks.push({ head: m[0].trim(), body: text.slice(start, i - 1) });
  }
  return blocks;
}

test('the model for every host, _headers, carries the seven security headers and no-cache', () => {
  const model = readHeaderBlock(read('_headers'), '/*');
  for (const name of SECURITY) assert.ok(model[name], `_headers has no ${name}`);
  assert.equal(model['cache-control'], 'no-cache');
});

test('nginx example: its headers are those of _headers, word for word (page and API on one address)', () => {
  const model = sameAddressHeaders();
  const sample = nginxHeaders(read(NGINX));
  assert.deepEqual(Object.keys(sample).sort(), [...SECURITY].sort(), 'the example must carry exactly these headers');
  for (const name of SECURITY) assert.equal(sample[name], model[name], `${name} differs between the nginx example and _headers`);
  assert.match(model['content-security-policy'], /connect-src 'self';/, 'the model for the same-address setup connects to the page\'s own address only');
});

test('nginx example: every header is set once, at server level, and no location sets one (nginx would drop all the others there)', () => {
  const text = read(NGINX);
  for (const location of nginxLocations(text)) assert.ok(!/add_header/.test(location.body), `${location.head} contains add_header`);
  assert.ok(nginxLocations(text).length >= 2);
  assert.match(text, /^\s*expires -1;/m, 'no-cache for the page comes from "expires -1"');
  assert.ok(!/location \/fonts\//.test(text), 'the page has no fonts to keep: Segoe UI is the visitor\'s own');
});

test('nginx example: the proxy to the API keeps the path, names the API, and checks its certificate', () => {
  const text = read(NGINX);
  const api = nginxLocations(text).find((l) => /\/api\//.test(l.head));
  assert.ok(api, 'a location /api/');
  assert.match(api.body, /^\s*proxy_pass \$evoting_api;/m, 'proxy_pass with a variable and NO path after it (a path would cut /api/ off the request)');
  assert.match(api.body, /^\s*set \$evoting_api "https:\/\/[a-z0-9.-]+";/m, 'the variable holds only scheme and name');
  assert.match(api.body, /^\s*resolver\s+\S+/m, 'a variable in proxy_pass needs a resolver');
  assert.match(api.body, /^\s*proxy_ssl_server_name on;/m);
  assert.match(api.body, /^\s*proxy_ssl_verify on;/m);
  assert.match(api.body, /^\s*proxy_ssl_trusted_certificate\s+\S+;/m);
  assert.match(api.body, /^\s*proxy_set_header Host [a-z0-9.-]+;/m);
  assert.match(api.body, /^\s*proxy_set_header X-Forwarded-For \$remote_addr;/m, 'a caller\'s own X-Forwarded-For is not passed on');
  const host = /set \$evoting_api "https:\/\/([a-z0-9.-]+)"/.exec(api.body)[1];
  assert.match(api.body, new RegExp(`proxy_set_header Host ${host.replaceAll('.', '\\.')};`), 'Host is the name of the upstream');
  assert.equal(host, new URL(JSON.parse(JSON.stringify(read('_headers').match(/https:\/\/[a-z0-9.-]+/)[0]))).hostname, 'the example forwards to the server that _headers names');
});

test('nginx example: the access log has the path only (what the clerks search for travels in the query)', () => {
  const text = read(NGINX);
  const format = /^log_format evoting '([^']+)';/m.exec(text);
  assert.ok(format, 'a log_format named evoting');
  assert.ok(!/\$request\b|\$request_uri|\$args|\$query_string/.test(format[1]), 'the log format must not contain the query string');
  assert.match(text, /^\s*access_log\s+\S+\s+evoting;/m);
});

test('IIS example: its headers are those of _headers, word for word', () => {
  const text = read(IIS);
  const custom = /<customHeaders>([\s\S]*?)<\/customHeaders>/.exec(text)[1];
  const sample = {};
  for (const m of custom.matchAll(/<add\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) sample[m[1].toLowerCase()] = m[2];
  const model = sameAddressHeaders();
  assert.deepEqual(Object.keys(sample).sort(), [...SECURITY].sort());
  for (const name of SECURITY) assert.equal(sample[name], model[name], `${name} differs between the IIS example and _headers`);
  assert.match(text, /cacheControlMode="DisableCache"/, 'no-cache for the page');
  assert.ok(!/woff2/.test(text), 'the page has no fonts; do not map one');
  assert.match(text, /<match url="\^api\/\(\.\*\)\$" \/>\s*<action type="Rewrite" url="https:\/\/[a-z0-9.-]+\/api\/\{R:1\}" \/>/, 'the proxy rule keeps /api/ in the path');
  assert.ok(!/fileExtension="\.mjs"/.test(text), 'the page has no .mjs files; do not map one');
});

test('WEB-DEPLOY.md shows the two examples exactly as the files are', () => {
  const doc = read('docs/WEB-DEPLOY.md');
  assert.ok(doc.includes(read(NGINX)), 'the nginx example in WEB-DEPLOY.md is not the file docs/samples/nginx-evoting-registration.conf');
  assert.ok(doc.includes(read(IIS)), 'the IIS example in WEB-DEPLOY.md is not the file docs/samples/web.config');
});

test('the documents name the files to upload that the tools compare', () => {
  const wanted = [...UPLOAD_FILES, '_headers', ...UPLOAD_FOLDERS.map((f) => `${f}/`)];
  const readme = read('README.md').split('\n').find((line) => /^Then upload/.test(line));
  const deploy = read('docs/WEB-DEPLOY.md').split('\n').filter((line) => /^3\. \*\*Upload exactly\*\*/.test(line) || /^\s+\(`_headers` is read by/.test(line)).join(' ');
  assert.ok(readme && deploy, 'the sentences about the upload were not found');
  const mentions = (line, item) => line.includes(`\`${item}\``);
  for (const item of wanted) {
    assert.ok(mentions(readme, item), `README.md does not tell to upload ${item}`);
    assert.ok(mentions(deploy, item), `WEB-DEPLOY.md does not tell to upload ${item}`);
  }
});

test('every file the documents point to exists; every npm script they name exists', () => {
  const packageRoot = path.resolve(ROOT, '..');
  const inPackage = existsSync(path.join(packageRoot, 'docs')); // this folder is not always inside the whole package (a copy of it alone)
  const documents = ['README.md', ...readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  const scripts = JSON.parse(read('package.json')).scripts;
  const folders = new Set(['css/', 'js/', 'vendor/', 'tools/', 'tests/', 'docs/']);
  const problems = [];
  let checked = 0;
  for (const document of documents) {
    const text = read(document).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const reference = m[1].trim();
      const isFile = /^(\.\.\/)*[\w@-][\w.@-]*(\/[\w.@-]+)*$/.test(reference) && /\.(md|mjs|js|json|css|html|svg|conf|config|txt)$/.test(reference); // a bare extension such as .mjs is not a path
      if (!isFile && !folders.has(reference)) continue;
      const target = path.resolve(ROOT, reference); // the documents write every path from the web folder (the one with index.html), also the ones in docs/
      const outside = path.relative(ROOT, target).startsWith('..');
      if (outside && !inPackage) continue;
      checked++;
      if (!existsSync(target)) problems.push(`${document}: ${reference}`);
    }
    for (const m of text.matchAll(/\bnpm run ([\w:-]+)/g)) if (!scripts[m[1]]) problems.push(`${document}: npm run ${m[1]} (no such script)`);
  }
  assert.ok(checked >= 30, `only ${checked} references were found - did the check stop looking?`);
  assert.deepEqual(problems, []);
});
