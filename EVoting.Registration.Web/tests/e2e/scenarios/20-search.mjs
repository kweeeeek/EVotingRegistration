import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, resultRows, searchBox, searchStatus, signedIn, sleep, typeInSearch, waitForResults } from '../ui.mjs';

test('search: fewer than two characters sends nothing and says why', async ({ page, stub }) => {
  await signedIn(page);
  await typeInSearch(page, 'a');
  await eventually(async () => /at least 2 characters/.test(await searchStatus(page)), { message: 'the hint' });
  await sleep(400);
  assert.equal(stub.searches().length, 0);
});

test('search: typing a whole name in one go sends ONE search, for the final text, limited to the open election\'s branches', async ({ page, stub }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela cruz', { delay: 20 });
  const rows = await waitForResults(page, (r) => r.length === 2);
  assert.deepEqual(rows.map((r) => r.name), ['Juan Dela Cruz', 'Maria Dela Cruz-Santos']);
  await sleep(300);
  const searches = stub.searches();
  assert.equal(searches.length, 1, `searches sent: ${searches.map((s) => s.params.get('query'))}`);
  assert.equal(searches[0].params.get('query'), 'dela cruz');
  assert.deepEqual(searches[0].params.getAll('branchIds'), ['1', '2', '3']);
});

test('search: results are ordered by name, show eligibility in words and highlight what matched', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  const rows = await waitForResults(page, (r) => r.length === 3);
  assert.deepEqual(rows.map((r) => r.name), ['Dela Rosa, Ramon', 'Juan Dela Cruz', 'Maria Dela Cruz-Santos']);
  assert.ok(rows.every((r) => /Eligible/.test(r.badge)));
  assert.match(await searchStatus(page), /^3 members found: 3 eligible, 0 not eligible\.$/);
  const marked = await page.locator('#results mark').allTextContents();
  assert.ok(marked.length >= 3 && marked.every((m) => m.toLowerCase() === 'dela'), `marked: ${marked}`);
  assert.equal(await page.locator('#results li[aria-selected=true]').count(), 0, 'nothing is chosen until the person chooses');
});

test('search: not-eligible and inactive members are listed too, each with its reason', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'pedro');
  let rows = await waitForResults(page, (r) => r.length === 1);
  assert.match(rows[0].badge, /Not eligible/);
  assert.equal(rows[0].selected, true, 'a single match is selected for the person');
  assert.match(await page.locator('.eligibility-reason').textContent(), /Share capital is below the minimum/);
  await typeInSearch(page, 'ian inactive');
  rows = await waitForResults(page, (r) => r.length === 1 && r[0].id === 5);
  assert.match(rows[0].badge, /Inactive/);
});

test('search: capital letters and accents do not matter', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'JOSEFA PENA');
  const rows = await waitForResults(page, (r) => r.length === 1);
  assert.equal(rows[0].name, 'Josefa Peña');
});

test('search: an account code finds the member', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'b0006');
  const rows = await waitForResults(page, (r) => r.length === 1);
  assert.equal(rows[0].name, 'Ligaya Reyes');
});

test('search: a member of a branch outside the election is never shown', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'outsider');
  await eventually(async () => /No member found/.test(await searchStatus(page)), { message: 'no match message' });
  assert.equal((await resultRows(page)).length, 0);
});

test('search: more than 200 matches shows 200 and says to narrow the search', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'test member');
  const rows = await waitForResults(page, (r) => r.length === 200);
  assert.equal(rows.length, 200);
  assert.match(await searchStatus(page), /Only the first 200 are shown - type more of the name to narrow the list\./);
});

test('search: no match says so, with the text that was searched', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'zzzz');
  await eventually(async () => (await searchStatus(page)) === 'No member found for "zzzz" in the participating branches.', { message: 'no match message' });
});

test('search: only the answer to the LATEST text is ever shown, even when an older answer arrives later', async ({ page, stub }) => {
  await signedIn(page);
  stub.state.delayFor = (req) => (req.params.get('query') === 'ma' ? 900 : 0);
  await typeInSearch(page, 'ma', { delay: 10 });
  await sleep(320); // the request for "ma" is now on its way and will take 900 ms
  await page.keyboard.type('ria', { delay: 10 });
  const rows = await waitForResults(page, (r) => r.length === 1);
  assert.equal(rows[0].name, 'Maria Dela Cruz-Santos');
  await sleep(1100); // the slow answer for "ma" (many more rows) has arrived by now
  assert.deepEqual((await resultRows(page)).map((r) => r.name), ['Maria Dela Cruz-Santos'], 'the stale answer must not replace it');
  assert.equal(await searchBox(page).inputValue(), 'maria');
});

test('search: while the server answers, rows that still match the longer text stay (and nothing can be issued from them yet)', async ({ page, stub }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  stub.state.latencyMs = 900;
  await page.keyboard.type(' c', { delay: 10 });
  await eventually(async () => (await page.locator('#results').getAttribute('aria-busy')) === 'true', { message: 'a search in progress' });
  assert.deepEqual((await resultRows(page)).map((r) => r.name), ['Juan Dela Cruz', 'Maria Dela Cruz-Santos'], 'narrowed instantly from the earlier answer');
  assert.equal(await page.locator('#results').evaluate((el) => el.classList.contains('is-pending')), true);
  // Enter while the answer is pending waits for the server instead of issuing from the preview
  await page.keyboard.press('Enter');
  await waitForResults(page, (r) => r.length === 2);
  assert.equal(stub.issues().length, 0);
});

test('search: a server error is explained and "Search again" tries again', async ({ page, stub }) => {
  await signedIn(page);
  stub.inject({ method: 'GET', path: /members\/search/, type: 'status', status: 500, body: { error: 'Something broke.' } });
  await typeInSearch(page, 'dela');
  await eventually(async () => /Something broke/.test(await searchStatus(page)), { message: 'the error' });
  assert.equal(await page.locator('#search-status').evaluate((el) => el.classList.contains('is-error')), true);
  await page.getByRole('button', { name: 'Search again' }).click();
  await waitForResults(page, (r) => r.length === 3);
});

test('search: keyboard - Enter with several matches only points at the first; arrows move; Esc clears; "/" comes back to the box', async ({ page, stub }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);

  await page.keyboard.press('Enter');
  let rows = await resultRows(page);
  assert.equal(rows.filter((r) => r.selected).length, 1);
  assert.equal(rows[0].selected, true, 'the first one is pointed at');
  assert.equal(stub.issues().length, 0, 'the first Enter issues nothing');

  await page.keyboard.press('ArrowDown');
  rows = await resultRows(page);
  assert.equal(rows[1].selected, true);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp'); // wraps to the last
  rows = await resultRows(page);
  assert.equal(rows[2].selected, true);
  assert.equal(await searchBox(page).getAttribute('aria-activedescendant'), `opt-${rows[2].id}`);

  await page.keyboard.press('Escape');
  assert.equal(await searchBox(page).inputValue(), '');
  assert.equal((await resultRows(page)).length, 0);

  await page.locator('.topbar-brand').click();
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input');
});

test('search: clicking a row selects it and the cursor stays in the search box', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  await page.locator('#results li').nth(1).click();
  const rows = await resultRows(page);
  assert.equal(rows[1].selected, true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input');
  assert.match(await page.locator('.detail-name').textContent(), /Juan Dela Cruz/);
});

test('search: no election open - the box explains instead of searching', async ({ page, stub }) => {
  stub.state.event = null;
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await eventually(async () => /No election is open, so there is nothing to search/.test(await searchStatus(page)), { message: 'the explanation' });
  assert.equal(stub.searches().length, 0);
  assert.ok((await page.locator('.banner .banner-title').allTextContents()).some((t) => /No election is open/.test(t)));
});
