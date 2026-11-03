import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '../framework.mjs';
import { assertNoCspTrouble, eventually, pillText, signedIn, typeInSearch, waitForResults } from '../ui.mjs';

const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'shots');

test('smoke: the page starts, shows the sign-in screen and reaches the server', async ({ page, seen }) => {
  await mkdir(shots, { recursive: true });
  await page.locator('#login-user').waitFor();
  await eventually(async () => /reachable/.test(await page.locator('.login-server-state').textContent()) && !/not reachable/.test(await page.locator('.login-server-state').textContent()), { message: 'the server to be reachable' });
  await page.screenshot({ path: path.join(shots, '01-login.png') });
  assertNoCspTrouble({ seen });
  assert.deepEqual(seen.console, []);
});

test('smoke: sign in, search, select', async (session) => {
  const { page, seen } = session;
  await mkdir(shots, { recursive: true });
  await signedIn(page);
  await page.screenshot({ path: path.join(shots, '02-desk-empty.png') });
  assert.match(await pillText(page), /Online/);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (rows) => rows.length >= 2);
  await page.screenshot({ path: path.join(shots, '03-results.png') });
  await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: path.join(shots, '04-selected.png') });
  assertNoCspTrouble(session);
  assert.deepEqual(seen.console, []);
});
