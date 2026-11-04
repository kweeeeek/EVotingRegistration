#!/usr/bin/env node
// Browser tests: the real page in real Chromium against a stand-in for the API, under the real Content-Security-Policy.
//   node tests/e2e/run.mjs                 everything
//   node tests/e2e/run.mjs --only issue    only tests whose name contains "issue"
//   node tests/e2e/run.mjs --keep-going    do not stop printing after the first failure (default: all tests always run)
// A failing test leaves a screenshot in tests/e2e/out/.

import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLab } from './harness.mjs';
import { registry } from './framework.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1].toLowerCase() : null;
const TIMEOUT_MS = 90_000;

for (const file of (await readdir(path.join(here, 'scenarios'))).filter((f) => f.endsWith('.mjs')).sort()) {
  await import(pathToFileURL(path.join(here, 'scenarios', file)).href);
}

const out = path.join(here, 'out');
await mkdir(out, { recursive: true });

const lab = await createLab();
const selected = registry.filter((t) => !only || t.name.toLowerCase().includes(only));
const failures = [];
const started = Date.now();
let n = 0;

for (const t of selected) {
  n++;
  const t0 = Date.now();
  let session;
  let timer;
  try {
    session = await lab.open(t.options);
    await Promise.race([
      t.fn(session, lab),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`test took longer than ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
      }),
    ]);
    console.log(`  ok   ${String(n).padStart(3)}/${selected.length}  ${t.name}  (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push({ name: t.name, err });
    console.log(`  FAIL ${String(n).padStart(3)}/${selected.length}  ${t.name}\n         ${String(err?.stack ?? err).split('\n').slice(0, 12).join('\n         ')}`);
    if (session) {
      const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      await session.page.screenshot({ path: path.join(out, `${slug}.png`) }).catch(() => {});
      if (session.seen.console.length || session.seen.csp.length || session.seen.pageErrors.length) {
        console.log(`         browser said: ${JSON.stringify({ console: session.seen.console.slice(0, 5), csp: session.seen.csp.slice(0, 5), pageErrors: session.seen.pageErrors.slice(0, 5) })}`);
      }
    }
  } finally {
    clearTimeout(timer); // a time-out that is still waiting would keep this process alive for up to TIMEOUT_MS after the summary
    if (session) await session.close();
  }
}

await lab.close();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${selected.length - failures.length} passed, ${failures.length} failed, ${selected.length} run in ${seconds} s.`);
process.exitCode = failures.length ? 1 : 0;
