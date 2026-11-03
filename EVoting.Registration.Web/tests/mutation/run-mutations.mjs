#!/usr/bin/env node
// Are the tests any good? This breaks the page on purpose, one promise at a time, in a COPY of this folder, and runs the tests that should notice.
//
//   node tests/mutation/run-mutations.mjs                  all breakages (about 20 minutes)
//   node tests/mutation/run-mutations.mjs --only M05,M12   some of them
//   node tests/mutation/run-mutations.mjs --list           what they are
//   node tests/mutation/run-mutations.mjs --no-baseline    do not first check that the unbroken copy passes
//
// CAUGHT = a test failed (good). SURVIVED = nothing failed: a hole in the tests, or a change that cannot be seen (an "equivalent" change).
// ERROR = the text to change was not found: the code has changed, update mutations.mjs. Nothing in this folder is modified.
// Needs the same things as the browser tests (Chromium of Playwright, openssl, poppler-utils for the print tests).

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './mutations.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(5)} ${m.what}`);
  process.exit(0);
}
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(',')) : null;

function run(cmd, argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BAIL_ON_FAILURE: '1' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const work = await mkdtemp(path.join(os.tmpdir(), 'evoting-mutation-'));

async function makeCopy(id) {
  const dir = path.join(work, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(WEB, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}tests${path.sep}e2e${path.sep}out`),
  });
  await symlink(path.join(WEB, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  // only in the copy: a broken page makes a test wait for its time-out, so make that short, and stop at the first failure
  const runner = path.join(dir, 'tests', 'e2e', 'run.mjs');
  let text = await readFile(runner, 'utf8');
  if (!text.includes('const TIMEOUT_MS = 90_000;') || !text.includes('if (session) await session.close();')) throw new Error('tests/e2e/run.mjs has changed: update the runner in tests/mutation');
  text = text.replace('const TIMEOUT_MS = 90_000;', 'const TIMEOUT_MS = 15_000;').replace('if (session) await session.close();', 'if (session) await session.close();\n    if (process.env.BAIL_ON_FAILURE && failures.length) break;');
  await writeFile(runner, text);
  return dir;
}

async function applyMutation(dir, m) {
  for (const edit of m.edits ?? []) {
    const file = path.join(dir, edit.file);
    const before = await readFile(file, 'utf8');
    const count = before.split(edit.find).length - 1;
    const expected = edit.count ?? 1;
    if (count !== expected) throw new Error(`${m.id}: expected ${expected} x ${JSON.stringify(edit.find.slice(0, 80))} in ${edit.file}, found ${count}`);
    await writeFile(file, before.split(edit.find).join(edit.replace));
  }
}

const tapFailures = (out) => [...new Set([...out.matchAll(/^\s*not ok \d+ - (.*?)(?: #.*)?$/gm)].map((x) => x[1]))];
const e2eFailures = (out) => [...out.matchAll(/^\s+FAIL\s+\d+\/\d+\s+(.*)$/gm)].map((x) => x[1].trim());
const unitFiles = async (dir) => (await readdir(path.join(dir, 'tests', 'unit'))).filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/unit/${f}`);

try {
  if (!args.includes('--no-baseline')) {
    const dir = await makeCopy('baseline');
    const r = await run('node', ['--test', '--test-reporter=tap', ...(await unitFiles(dir))], dir, 240000);
    if (r.code !== 0) {
      console.log(`The unbroken copy does not pass its own unit tests (${tapFailures(r.out).slice(0, 3).join(' | ')}): fix that first, otherwise every breakage would look "caught".`);
      process.exitCode = 2;
      throw new Error('baseline');
    }
    console.log('The unbroken copy passes its unit tests.\n');
  }

  const results = [];
  for (const m of MUTATIONS.filter((x) => !only || only.has(x.id))) {
    const t0 = Date.now();
    const row = { id: m.id, what: m.what, unit: null, e2e: null };
    let dir;
    try {
      dir = await makeCopy(m.id);
      await applyMutation(dir, m);
      const u = await run('node', ['--test', '--test-reporter=tap', ...(await unitFiles(dir))], dir, 240000);
      row.unit = { code: u.code, failed: tapFailures(u.out) };
      if (m.e2e) {
        const e = await run('node', ['tests/e2e/run.mjs', '--only', m.e2e], dir, 300000);
        row.e2e = { code: e.code, failed: e2eFailures(e.out), summary: /(\d+) passed, (\d+) failed, (\d+) run/.exec(e.out)?.[0] ?? e.out.slice(-300) };
      }
    } catch (err) {
      row.error = String(err?.message ?? err);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    const caughtUnit = row.unit && row.unit.code !== 0;
    const caughtE2e = row.e2e && row.e2e.code !== 0;
    row.verdict = row.error ? 'ERROR' : caughtUnit || caughtE2e ? 'CAUGHT' : 'SURVIVED';
    results.push(row);
    console.log(
      `${row.verdict.padEnd(8)} ${m.id.padEnd(5)} ${m.what}\n` +
        `           unit   : ${row.unit ? (caughtUnit ? `failed ${row.unit.failed.length}: ${row.unit.failed.slice(0, 2).join(' | ')}` : 'all passed') : 'not run'}\n` +
        `           browser: ${row.e2e ? (caughtE2e ? `failed: ${row.e2e.failed.slice(0, 2).join(' | ') || row.e2e.summary}` : `all passed (${row.e2e.summary})`) : 'not run'}` +
        (row.error ? `\n           ERROR: ${row.error}` : '') +
        `   [${Math.round((Date.now() - t0) / 1000)} s]`,
    );
  }

  const count = (verdict) => results.filter((r) => r.verdict === verdict).length;
  console.log(`\n${results.length} breakages: ${count('CAUGHT')} caught, ${count('SURVIVED')} survived, ${count('ERROR')} errors.`);
  const survived = results.filter((r) => r.verdict === 'SURVIVED');
  if (survived.length) console.log(`Survived: ${survived.map((r) => r.id).join(', ')} - a hole in the tests, or a change nobody could see (docs/WEB-VERIFICATION.md explains M25).`);
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  process.exitCode = count('ERROR') > 0 ? 2 : 0;
} catch (err) {
  if (err?.message !== 'baseline') throw err;
} finally {
  await rm(work, { recursive: true, force: true });
}
