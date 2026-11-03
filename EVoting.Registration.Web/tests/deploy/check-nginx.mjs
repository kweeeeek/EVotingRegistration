#!/usr/bin/env node
// Does the nginx example (docs/samples/nginx-evoting-registration.conf) really work? This starts a real nginx with it - with only the
// addresses and paths changed - in front of the stand-in API, and then
//   1. asks it what a host must answer, using the administrator's own tool (tools/check-site.mjs): headers, types, every file, the proxy;
//   2. asks it a few things the tool does not: http -> https, headers on an error page, caching, compression;
//   3. drives the real page in Chromium through it: sign in, search, issue a QR, print;
//   4. checks what the proxy does towards the API: it looks the API's NAME up (a small DNS server of this test stands in for the internet's), sends that name in the
//      TLS handshake and as Host, and refuses an API whose certificate it does not trust;
//   5. spoils the configuration the way people really do (an add_header inside a location) and checks that the tool notices.
//
//   node tests/deploy/check-nginx.mjs          (needs nginx; set NGINX=/path/to/nginx if it is not on the PATH. Without nginx: skipped, exit 0)
//
// Needs the same things as the browser tests (Chromium of Playwright, openssl). Exit code 0 = all good or skipped, 1 = something failed.

import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab } from '../e2e/harness.mjs';
import { makeCertificate } from '../e2e/site.mjs';
import { createStub } from '../e2e/stub-api.mjs';
import { eventually, prints, signedIn, typeInSearch, waitForNotice, waitForResults } from '../e2e/ui.mjs';
import { checkSite, httpRequest } from '../../tools/check-site.mjs';
import { applyApiUrl } from '../../tools/set-api-url.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE = path.join(WEB_ROOT, 'docs', 'samples', 'nginx-evoting-registration.conf');
const COPY = ['index.html', 'favicon.svg', 'config.js', '_headers', 'css', 'js', 'fonts', 'vendor'];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${String(detail).split('\n').join('\n          ')}`}`);
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * A DNS server that knows a few names (A records only; every other kind of question gets an empty answer). The sample asks the
 * resolver given by its "resolver" line for the API's name, like a production server asks the internet's; the test points that line here.
 */
function startDns(names) {
  const socket = dgram.createSocket('udp4');
  const asked = [];
  socket.on('message', (msg, remote) => {
    let pos = 12;
    const labels = [];
    while (msg[pos] !== 0) {
      labels.push(msg.toString('ascii', pos + 1, pos + 1 + msg[pos]));
      pos += msg[pos] + 1;
    }
    const type = msg.readUInt16BE(pos + 1);
    const question = msg.subarray(12, pos + 5);
    const name = labels.join('.').toLowerCase();
    asked.push({ name, type });
    const ip = names[name];
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // the same id
    header.writeUInt16BE(ip ? 0x8180 : 0x8183, 2); // an answer, recursion available; "no such name" for the names it does not know
    header.writeUInt16BE(1, 4); // one question
    if (type === 1 && ip) {
      header.writeUInt16BE(1, 6); // one answer
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0); // the name, as a pointer to the question
      record.writeUInt16BE(1, 2); // A
      record.writeUInt16BE(1, 4); // IN
      record.writeUInt32BE(60, 6); // for 60 seconds
      record.writeUInt16BE(4, 10);
      ip.split('.').forEach((part, i) => record.writeUInt8(Number(part), 12 + i));
      socket.send(Buffer.concat([header, question, record]), remote.port, remote.address);
    } else {
      socket.send(Buffer.concat([header, question]), remote.port, remote.address);
    }
  });
  return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve({ port: socket.address().port, asked, close: () => new Promise((r) => socket.close(r)) })));
}

function findNginx() {
  const candidate = process.env.NGINX || 'nginx';
  const r = spawnSync(candidate, ['-v'], { encoding: 'utf8' });
  return r.error ? null : { bin: candidate, version: (r.stderr || r.stdout).trim() };
}

const mimeTypesFile = () => ['/etc/nginx/mime.types', '/usr/local/etc/nginx/mime.types', '/opt/homebrew/etc/nginx/mime.types'].find((p) => existsSync(p));

const nginx = findNginx();
if (!nginx) {
  console.log('SKIPPED - nginx is not installed here (put it on the PATH, or set NGINX=/path/to/nginx).');
  process.exit(0);
}
const mimeTypes = mimeTypesFile();
if (!mimeTypes) {
  console.log('SKIPPED - the mime.types file of nginx was not found in the usual places.');
  process.exit(0);
}
console.log(`${nginx.version}\n`);

const work = await mkdtemp(path.join(os.tmpdir(), 'evoting-nginx-'));
const siteDir = path.join(work, 'site');
let lab;
let stub;
let dns;
let server = null;

/** The sample with only the addresses and paths changed, and a proof that every one of them was found. */
async function makeConfig({ httpPort, httpsPort, apiPort, dnsPort, certPath, keyPath, trustedPath = certPath, spoil = (text) => text }) {
  let text = await readFile(SAMPLE, 'utf8');
  const change = (from, to) => {
    if (!text.includes(from)) throw new Error(`The sample no longer contains "${from}" - update tests/deploy/check-nginx.mjs.`);
    text = text.split(from).join(to);
  };
  change('listen 80;', `listen 127.0.0.1:${httpPort};`);
  change('listen 443 ssl;', `listen 127.0.0.1:${httpsPort} ssl;`);
  change('server_name registration.example.org;', 'server_name registration.test localhost;');
  change('/etc/ssl/registration.example.org/fullchain.pem', certPath);
  change('/etc/ssl/registration.example.org/privkey.pem', keyPath);
  change('/var/www/evoting-registration', siteDir);
  change('resolver 1.1.1.1 8.8.8.8 valid=60s;', `resolver 127.0.0.1:${dnsPort} valid=60s;`);
  change('set $evoting_api "https://api.eballotsacdeco.site";', `set $evoting_api "https://api.test:${apiPort}";`);
  change('proxy_set_header Host api.eballotsacdeco.site;', 'proxy_set_header Host api.test;');
  change('/etc/ssl/certs/ca-certificates.crt', trustedPath);
  change('/var/log/nginx/evoting-registration.access.log', path.join(work, 'evoting.access.log'));
  return spoil(text);
}

function mainConfig() {
  return `daemon off;
worker_processes 1;
${process.getuid?.() === 0 ? 'user root;' : ''}
pid ${work}/nginx.pid;
error_log ${work}/error.log notice;
events { worker_connections 128; }
http {
  include ${mimeTypes};
  default_type application/octet-stream;
  access_log ${work}/access.log;
  client_body_temp_path ${work}/tmp/body;
  proxy_temp_path ${work}/tmp/proxy;
  fastcgi_temp_path ${work}/tmp/fcgi;
  uwsgi_temp_path ${work}/tmp/uwsgi;
  scgi_temp_path ${work}/tmp/scgi;
  include ${work}/server.conf;
}
`;
}

const nginxArgs = ['-p', `${work}/`, '-c', path.join(work, 'nginx.conf'), '-e', path.join(work, 'error.log')];

async function startNginx(port) {
  const test = spawnSync(nginx.bin, [...nginxArgs, '-t'], { encoding: 'utf8' });
  if (test.status !== 0) throw new Error(`nginx -t:\n${test.stderr || test.stdout}`);
  server = spawn(nginx.bin, nginxArgs, { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const open = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nginx did not start listening on ${port}:\n${await readFile(path.join(work, 'error.log'), 'utf8').catch(() => '')}`);
}

async function stopNginx() {
  if (!server) return;
  const done = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGQUIT'); // finish what is running, then leave
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  server.kill('SIGKILL');
  server = null;
}

const PRINT_CAPTURE = () => {
  window.__prints = [];
  window.print = () => {
    const root = document.getElementById('print-root');
    window.__prints.push({ text: root ? root.textContent : '', slips: root ? root.querySelectorAll('.slip').length : 0 });
  };
};

try {
  // the folder, as it would be uploaded: pointed at "this same address" with the shipped tool
  await mkdir(siteDir, { recursive: true });
  for (const name of COPY) await cp(path.join(WEB_ROOT, name), path.join(siteDir, name), { recursive: true });
  const applied = applyApiUrl(
    { config: await readFile(path.join(siteDir, 'config.js'), 'utf8'), html: await readFile(path.join(siteDir, 'index.html'), 'utf8'), headers: await readFile(path.join(siteDir, '_headers'), 'utf8') },
    '',
  );
  await writeFile(path.join(siteDir, 'config.js'), applied.config);
  await writeFile(path.join(siteDir, 'index.html'), applied.html);
  await writeFile(path.join(siteDir, '_headers'), applied.headers);
  await mkdir(path.join(work, 'tmp'), { recursive: true });

  lab = await createLab();
  const certPath = path.join(work, 'cert.pem');
  const keyPath = path.join(work, 'key.pem');
  await writeFile(certPath, lab.tls.cert);
  await writeFile(keyPath, lab.tls.key);
  stub = createStub({ key: lab.tls.key, cert: lab.tls.cert });
  const apiPort = await stub.listen();
  stub.state.allowedOrigins = null; // same address: there is no cross-site call to allow
  dns = await startDns({ 'api.test': '127.0.0.1' });
  const httpPort = await freePort();
  const httpsPort = await freePort();
  const ports = { httpPort, httpsPort, apiPort, dnsPort: dns.port, certPath, keyPath };

  await writeFile(path.join(work, 'nginx.conf'), mainConfig());
  await writeFile(path.join(work, 'server.conf'), await makeConfig(ports));
  await startNginx(httpsPort);
  console.log('nginx is running with the sample configuration.\n');

  // 1. the administrator's tool
  console.log('The administrator\'s tool, tools/check-site.mjs, against nginx:');
  const base = `https://localhost:${httpsPort}`;
  const verdict = await checkSite(base, { root: siteDir, insecure: true });
  check('check-site finds nothing to fix', verdict.problems.length === 0, verdict.problems.join('\n'));
  check('...and compared the files', verdict.notes.some((n) => /^\d+ files compared/.test(n)), verdict.notes.join('\n'));
  check('...and noticed that /api/ is forwarded', verdict.notes.some((n) => /reverse proxy works/.test(n)), verdict.notes.join('\n'));

  // 2. what the tool does not ask
  console.log('\nOther things nginx must do:');
  const redirect = await httpRequest(`http://127.0.0.1:${httpPort}/foo?x=1`, { headers: { Host: 'registration.test' } });
  check('http:// is sent to https:// with the path and query kept', redirect.status === 301 && redirect.headers.location === 'https://registration.test/foo?x=1', JSON.stringify(redirect.headers));
  const missing = await httpRequest(`${base}/no-such-file`, { insecure: true });
  check('a file that is not there is a 404, not the front page', missing.status === 404, `status ${missing.status}`);
  check('an error page has the security headers too', missing.headers['x-frame-options'] === 'DENY' && /default-src 'none'/.test(missing.headers['content-security-policy'] ?? ''), JSON.stringify(missing.headers));
  const page = await httpRequest(`${base}/`, { insecure: true });
  check('the page is "Cache-Control: no-cache"', page.headers['cache-control'] === 'no-cache', page.headers['cache-control']);
  const script = await httpRequest(`${base}/js/api.js`, { insecure: true });
  check('scripts too (an update is picked up at once)', script.headers['cache-control'] === 'no-cache', script.headers['cache-control']);
  const fontName = (await readFile(path.join(siteDir, 'css', 'app.css'), 'utf8')).match(/fonts\/([a-z0-9.-]+\.woff2)/)[1];
  const font = await httpRequest(`${base}/fonts/${fontName}`, { insecure: true });
  check('fonts may be kept for a year', font.status === 200 && font.headers['cache-control'] === 'max-age=31536000', JSON.stringify(font.headers));
  const zipped = await httpRequest(`${base}/js/api.js`, { insecure: true, headers: { 'Accept-Encoding': 'gzip' } });
  check('scripts are compressed when the browser accepts it', zipped.headers['content-encoding'] === 'gzip' && zipped.body.length < script.body.length, `${zipped.headers['content-encoding']} ${zipped.body.length} < ${script.body.length}`);
  const health = await httpRequest(`${base}/api/v1/health/live`, { insecure: true, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const reached = stub.state.log.filter((e) => e.path === '/api/v1/health/live').at(-1);
  check('/api/ reaches the server with the path unchanged', health.status === 200 && Boolean(reached), `status ${health.status}; the server saw: ${stub.state.log.map((e) => e.path).join(', ')}`);
  check('...after looking the API\'s name up with the resolver of the "resolver" line', dns.asked.some((q) => q.name === 'api.test' && q.type === 1), JSON.stringify(dns.asked));
  check('...asking for it by name in the TLS handshake (SNI), which hosting platforms need', reached?.sni === 'api.test', `SNI: ${reached?.sni}`);
  check('...with the API\'s name as Host', reached?.host === 'api.test', `Host: ${reached?.host}`);
  check('...saying that the client came over https, and from where (what the client claimed is not passed on)', reached?.forwardedProto === 'https' && reached?.forwardedFor === '127.0.0.1', `X-Forwarded-Proto: ${reached?.forwardedProto}, X-Forwarded-For: ${reached?.forwardedFor}`);

  // 3. the real page, through nginx
  console.log('\nThe page in Chromium, through nginx:');
  const context = await lab.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Manila', locale: 'en-PH', reducedMotion: 'reduce' });
  await context.addInitScript(PRINT_CAPTURE);
  const browserPage = await context.newPage();
  const seen = { console: [], csp: [], errors: [], requests: [] };
  browserPage.on('console', (m) => {
    if (/Content Security Policy|Content-Security-Policy|Refused to|Trusted ?Type/i.test(m.text())) seen.csp.push(m.text());
    else if (m.type() === 'error' || m.type() === 'warning') seen.console.push(m.text());
  });
  browserPage.on('pageerror', (e) => seen.errors.push(String(e)));
  browserPage.on('request', (r) => seen.requests.push(r.url()));
  await browserPage.goto(`https://registration.test:${httpsPort}/`);
  await signedIn(browserPage);
  check('sign in', true);
  await typeInSearch(browserPage, 'A0001');
  const rows = await waitForResults(browserPage, (r) => r.length === 1);
  check('search finds the member', rows[0].name === 'Juan Dela Cruz', JSON.stringify(rows));
  await browserPage.keyboard.press('Enter');
  await waitForNotice(browserPage, /^QR issued for Juan Dela Cruz\. Confirmed by the server\.$/);
  const printed = await prints(browserPage);
  check('the QR is issued, confirmed by the server, and one slip is printed', printed.length === 1 && printed[0].slips === 1 && printed[0].text.includes('A0001'), JSON.stringify(printed));
  check('the server recorded exactly one issuance, through /api/', stub.issues().length === 1 && stub.issues()[0].path === '/api/v1/registration/members/1/qr-issued', JSON.stringify(stub.issues()));
  const origins = [...new Set(seen.requests.map((u) => new URL(u).origin))];
  check('the page talked to nobody but its own address', origins.length === 1 && origins[0] === `https://registration.test:${httpsPort}`, origins.join(', '));
  check('the browser reported no policy violation, no error, no warning', seen.csp.length === 0 && seen.errors.length === 0 && seen.console.length === 0, JSON.stringify(seen));
  const log = await readFile(path.join(work, 'evoting.access.log'), 'utf8');
  check('nginx logged the calls it forwarded', /"POST \/api\/v1\/registration\/members\/1\/qr-issued" 200 /.test(log), log.split('\n').slice(-5).join('\n'));
  check('...and the search was logged without what was searched for', /"GET \/api\/v1\/registration\/members\/search" 200 /.test(log) && !/query=|A0001/i.test(log), log.split('\n').slice(-8).join('\n'));
  await context.close();

  // 4. an API whose certificate nginx does not trust
  console.log('\nAn API that presents a certificate nginx does not trust (somebody in the middle):');
  await stopNginx();
  const strangerDir = path.join(work, 'stranger');
  await mkdir(strangerDir);
  const stranger = makeCertificate(strangerDir);
  await writeFile(path.join(work, 'server.conf'), await makeConfig({ ...ports, trustedPath: stranger.certPath }));
  await startNginx(httpsPort);
  const refused = await httpRequest(`${base}/api/v1/health/live`, { insecure: true });
  const errorLog = await readFile(path.join(work, 'error.log'), 'utf8');
  check('/api/ answers 502 instead of passing the sign-in to it', refused.status === 502, `status ${refused.status}`);
  check('...and nginx says why', /upstream SSL certificate verify error/.test(errorLog), errorLog.split('\n').slice(-4).join('\n'));

  // 5. the mistake that is easy to make
  console.log('\nThe mistake that is easy to make - an add_header inside a location:');
  await stopNginx();
  await writeFile(path.join(work, 'server.conf'), await makeConfig({ ...ports, spoil: (text) => text.replace('location / {', 'location / {\n        add_header Cache-Control "no-cache";') }));
  await startNginx(httpsPort);
  const spoiled = await checkSite(base, { root: siteDir, insecure: true });
  check('check-site notices that nginx dropped the security headers of the page', spoiled.problems.some((p) => /^The host does not send the header content-security-policy/.test(p)) && spoiled.problems.some((p) => /^The host does not send the header x-frame-options/.test(p)), spoiled.problems.join('\n') || '(nothing reported)');
  check('...and that scripts lost "nosniff"', spoiled.problems.some((p) => /^js\/api\.js: no "X-Content-Type-Options: nosniff"\.$/.test(p)), spoiled.problems.join('\n') || '(nothing reported)');
} catch (error) {
  failures++;
  console.log(`  FAIL  ${error?.stack ?? error}`);
} finally {
  await stopNginx().catch(() => {});
  await stub?.close().catch(() => {});
  await dns?.close().catch(() => {});
  await lab?.close().catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nThe nginx example works.' : `\n${failures} check${failures === 1 ? '' : 's'} failed.`);
process.exitCode = failures === 0 ? 0 : 1;
