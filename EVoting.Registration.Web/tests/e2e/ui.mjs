// What a person does at the desk, as small helpers. Everything is found the way a person (or a screen reader) finds it:
// by role, label or visible text - not by position.

import assert from 'node:assert/strict';
import { PASSWORD, USER } from './harness.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn() returns something truthy (or a non-throwing value when `ok` is omitted); fails with the last problem. */
export async function eventually(fn, { timeout = 5000, interval = 40, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value !== false && value !== undefined && value !== null) return value;
      last = new Error(`${message}: got ${JSON.stringify(value)}`);
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}. Last: ${last?.message ?? last}`);
    await sleep(interval);
  }
}

export async function signIn(page, user = USER, password = PASSWORD) {
  await page.locator('#login-user').fill(user);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in and waits until the desk shows the open election and the search box has focus. */
export async function signedIn(page) {
  await signIn(page);
  await page.locator('#search-input').waitFor({ state: 'visible' });
  await eventually(async () => (await page.locator('.election-title').textContent()) !== 'Looking for the open election…', { message: 'the election title' });
}

export const searchBox = (page) => page.locator('#search-input');

/** Types like a person (one key at a time) so the debounce is what is tested. */
export async function typeInSearch(page, text, { delay = 15 } = {}) {
  const box = searchBox(page);
  await box.click();
  await box.fill('');
  await page.keyboard.type(text, { delay });
}

export async function resultRows(page) {
  return page.locator('#results > li').evaluateAll((rows) =>
    rows.map((li) => ({
      id: Number(li.dataset.memberId),
      kind: li.dataset.kind,
      selected: li.getAttribute('aria-selected') === 'true',
      name: li.querySelector('.result-name').textContent,
      code: li.querySelector('.result-code').textContent,
      badge: li.querySelector('.badge').textContent.replace(/\s+/g, ' ').trim(),
    })),
  );
}

export async function waitForResults(page, predicate = (rows) => rows.length > 0, message = 'search results') {
  return eventually(
    async () => {
      const phaseDone = await page.locator('#results').getAttribute('aria-busy');
      if (phaseDone === 'true') return false;
      const rows = await resultRows(page);
      return predicate(rows) ? rows : false;
    },
    { message },
  );
}

export async function searchStatus(page) {
  return (await page.locator('#search-status').textContent()).trim();
}

export async function noticeText(page) {
  const n = page.locator('.notice');
  return (await n.isVisible()) ? (await n.locator('.notice-text').textContent()).trim() : null;
}

export async function waitForNotice(page, pattern, timeout = 5000) {
  return eventually(
    async () => {
      const text = await noticeText(page);
      return text && pattern.test(text) ? text : false;
    },
    { timeout, message: `a notice matching ${pattern}` },
  );
}

export async function prints(page) {
  return page.evaluate(() => window.__prints.slice());
}

export async function bannerTitles(page) {
  return page.locator('.banner .banner-title').allTextContents();
}

export async function pillText(page) {
  return (await page.locator('.pill').textContent()).trim();
}

/** All page requests that went to a URL under `origin`. */
export const requestsTo = (session, origin) => session.seen.requests.filter((r) => r.url.startsWith(origin));

export function assertNoCspTrouble(session) {
  assert.deepEqual(session.seen.csp, [], 'the page broke its own Content-Security-Policy');
  assert.deepEqual(session.seen.pageErrors, [], 'uncaught script errors');
}
