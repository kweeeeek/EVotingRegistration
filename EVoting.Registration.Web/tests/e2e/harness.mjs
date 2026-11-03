// One browser for the whole run; a fresh server stand-in, site copy and browser context for every test.
// The browser maps registration.test / api.test to this machine (--host-resolver-rules), does not use any proxy, and accepts the
// run's own self-signed certificate - so the page is loaded exactly as in production: https page, https API on ANOTHER origin
// (or the same origin through a reverse proxy), under the real Content-Security-Policy from _headers.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStub } from './stub-api.mjs';
import { makeCertificate, startSite } from './site.mjs';

export const USER = 'clerk';
export const PASSWORD = 'correct horse';

const PRINT_CAPTURE = () => {
  // The test stands in for the print dialog: it records what the page put in the print area at the moment window.print() was
  // called, and leaves it there (a real print dialog would too, until it closes) so the test can render it with page.pdf().
  window.__prints = [];
  window.print = () => {
    const root = document.getElementById('print-root');
    window.__prints.push({ text: root ? root.textContent : '', slips: root ? root.querySelectorAll('.slip').length : 0 });
  };
};

export async function createLab() {
  const certDir = await mkdtemp(path.join(os.tmpdir(), 'evoting-cert-'));
  const { keyPath, certPath } = makeCertificate(certDir);
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  // The test hosts only exist on this machine: the browser must not send them to a proxy that the shell environment may configure
  // (the headless shell ignores --no-proxy-server and reads https_proxy). Only the browser process loses the variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name)));
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP registration.test 127.0.0.1, MAP api.test 127.0.0.1', '--no-proxy-server'],
    env,
  });

  return {
    browser,
    tls,

    /**
     * @param {object} [options]
     * @param {'cross'|'same'} [options.mode]
     * @param {object} [options.config]       overrides for config.js numbers / switches
     * @param {{width: number, height: number}} [options.viewport]
     * @param {boolean} [options.reducedMotion]
     * @param {boolean} [options.clock]       install Playwright's fake clock (idle-lock tests)
     * @param {string[]|null} [options.allowedOrigins]  override the stub's CORS list (default: only the page's origin)
     * @param {boolean} [options.open]        go to the page (default true)
     */
    async open(options = {}) {
      const { mode = 'cross', config = {}, viewport = { width: 1366, height: 768 }, reducedMotion = true, clock = false, open = true } = options;

      const stub = createStub({ key: tls.key, cert: tls.cert });
      const apiPort = await stub.listen();
      const site = await startSite({ tls, apiPort, mode, config, tweak: options.tweak ?? null });
      stub.state.allowedOrigins = 'allowedOrigins' in options ? options.allowedOrigins : mode === 'cross' ? [site.origin] : null;

      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport,
        timezoneId: 'Asia/Manila',
        locale: 'en-PH',
        reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
        serviceWorkers: 'allow',
      });
      await context.addInitScript(PRINT_CAPTURE);
      const page = await context.newPage();

      const seen = { console: [], csp: [], pageErrors: [], requests: [] };
      page.on('console', (msg) => {
        const text = msg.text();
        if (/Content Security Policy|Content-Security-Policy|Refused to|Trusted ?Type/i.test(text)) seen.csp.push(text);
        else if (msg.type() === 'error' || msg.type() === 'warning') seen.console.push(`${msg.type()}: ${text}`);
      });
      page.on('pageerror', (err) => seen.pageErrors.push(String(err)));
      page.on('request', (req) => seen.requests.push({ url: req.url(), method: req.method(), headers: req.headers() }));

      if (clock) await page.clock.install({ time: new Date('2026-11-03T02:00:00Z') });
      if (open) await page.goto(site.url);

      return {
        page,
        context,
        stub,
        site,
        seen,
        mode,
        async close() {
          await context.close().catch(() => {});
          await site.close().catch(() => {});
          await stub.close().catch(() => {});
        },
      };
    },

    async close() {
      await browser.close();
      await rm(certDir, { recursive: true, force: true });
    },
  };
}
