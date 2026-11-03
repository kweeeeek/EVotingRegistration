import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { EVENT } from '../stub-api.mjs';
import { PASSWORD } from '../harness.mjs';
import { bannerTitles, eventually, pillText, resultRows, signedIn, sleep, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

async function find(page, text) {
  await typeInSearch(page, text);
  return waitForResults(page, (rows) => rows.length === 1);
}

const lockDialog = (page) => page.getByRole('dialog', { name: 'Locked' });

async function unlock(page, password = PASSWORD) {
  const dialog = lockDialog(page);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Unlock' }).click();
}

test('session: Lock hides everything about members until the password is typed again - the records stay', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);

  await page.getByRole('button', { name: 'Lock' }).click();
  await lockDialog(page).waitFor();
  assert.equal(await page.locator('#desk').isVisible(), false);
  assert.equal(await page.locator('#results > li').count(), 0, 'the list is emptied, not just hidden');
  assert.equal(await page.locator('.slip').count(), 0, 'no slip (a member\'s name) is left on the page');
  const visibleText = await page.locator('body').innerText();
  assert.ok(!/Dela Cruz|Dela Rosa|A0001|A0002/.test(visibleText), 'no member data visible while locked');

  // while locked the page cannot call the server with the old token
  const marker = session.seen.requests.length;
  await sleep(500);
  assert.ok(session.seen.requests.slice(marker).every((r) => !r.headers.authorization));

  await unlock(page, 'wrong');
  await eventually(async () => /Wrong user name or password/.test(await lockDialog(page).locator('.form-error').textContent()), { message: 'the refusal' });
  assert.equal(await lockDialog(page).isVisible(), true);

  await unlock(page);
  await lockDialog(page).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#desk').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input');
  assert.equal(await page.locator('.recent-item').count(), 1, 'the session\'s record is still there');
  assert.equal(stub.state.logins, 3, 'one sign-in, one refused unlock, one unlock');
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
});

test('session: ten minutes without a key or a click locks the screen', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  await page.clock.fastForward('09:00');
  assert.equal(await lockDialog(page).isVisible(), false, 'not yet');
  await page.keyboard.press('Shift'); // any key counts as being there
  await page.clock.fastForward('09:00');
  assert.equal(await lockDialog(page).isVisible(), false, 'nine minutes since the last key');
  await page.clock.fastForward('02:00');
  await lockDialog(page).waitFor();
  assert.match(await lockDialog(page).textContent(), /Locked after 10 minutes without activity\. The member list is hidden until you sign in again\./);
  assert.equal((await resultRows(page)).length, 0);
}, { clock: true });

test('session: a token that is about to run out locks the screen with "session ended"', async ({ page }) => {
  await signedIn(page);
  await page.clock.fastForward('07:59:50');
  await lockDialog(page).waitFor();
  assert.match(await lockDialog(page).textContent(), /Your session ended\. Sign in again to continue; the records of this session are kept\./);
}, { clock: true, config: { idleLockMinutes: 0 } });

test('session: when the server refuses the token (401) the screen locks, the records are kept, and unlocking carries on', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);

  stub.revokeTokens(); // the server forgets the token (restart, expiry)
  await typeInSearch(page, 'dela');
  await lockDialog(page).waitFor();
  assert.match(await lockDialog(page).textContent(), /Your session ended/);
  assert.equal((await resultRows(page)).length, 0, 'no answer from before the lock is shown');

  await unlock(page);
  await lockDialog(page).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.recent-item').count(), 1);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
});

test('session: a 401 while issuing leaves a "not recorded" record, no slip, and Try again works after unlocking', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await find(page, 'A0001');
  stub.revokeTokens();
  await page.keyboard.press('Enter');
  await lockDialog(page).waitFor();
  await unlock(page);
  await lockDialog(page).waitFor({ state: 'hidden' });
  const prints = () => page.evaluate(() => window.__prints.length);
  assert.equal(await prints(), 0, 'nothing was printed for a QR the server did not record');
  await page.getByRole('button', { name: /^Review records/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Review records' });
  assert.match(await dialog.locator('tbody').textContent(), /Juan Dela Cruz.*Not recorded - no slip was printed.*Your session ended before the server recorded this/);
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await eventually(async () => (await prints()) === 1, { message: 'the slip after Try again' });
  assert.ok(stub.member(1).qrIssuedAt);
});

test('session: Sign out asks when records need attention; "Stay signed in" stays; confirming returns to an empty sign-in page', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await find(page, 'A0001');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'status', status: 502 });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /HTTP 502/);
  assert.equal(await page.getByRole('button', { name: 'Review records, 1 record needs attention', exact: true }).count(), 1, 'one record: "1 record needs", not "1 records need"');

  await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign out?' });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /One QR issuance record still needs attention\. Signing out discards the records of this session/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Stay signed in');
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#desk').isVisible(), true);

  await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#login-user').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#login-user').inputValue(), '');
  assert.equal(await page.locator('#login-password').inputValue(), '');
  assert.equal(await page.locator('#desk').isVisible(), false);
  assert.equal(await page.locator('.recent-item').count(), 0, 'a fresh page: nothing of the session is left in memory');
});

test('session: Sign out with nothing to look at goes straight to a fresh sign-in page', async ({ page }) => {
  await signedIn(page);
  await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#login-user').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('dialog').count(), 0);
});

test('session: when the server stops answering the desk says Offline, refuses Issue, and recovers by itself', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await find(page, 'A0001');
  assert.equal(await page.locator('#issue-button').isDisabled(), false);

  stub.state.down = true;
  await eventually(async () => (await pillText(page)) === 'Offline', { timeout: 8000, message: 'the Offline pill' });
  assert.ok((await bannerTitles(page)).some((t) => /^Offline - QR codes cannot be issued$/.test(t)));
  assert.equal(await page.locator('#issue-button').isDisabled(), true);
  assert.match(await page.locator('#issue-hint').textContent(), /^Offline - the server is not answering, so no QR can be issued right now\.$/);
  assert.equal(await page.getByRole('button', { name: 'Check the connection now' }).isVisible(), true);

  stub.state.down = false;
  await page.getByRole('button', { name: 'Check the connection now' }).click();
  await eventually(async () => (await pillText(page)) === 'Online', { timeout: 8000, message: 'Online again' });
  assert.equal(await page.locator('#issue-button').isDisabled(), false);
  assert.ok(!(await bannerTitles(page)).some((t) => /Offline/.test(t)));
}, { config: { heartbeatSeconds: 1 } });

test('session: a different election opening while staff work clears the search and says so', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  stub.state.event = { ...EVENT, eventId: 8, title: 'Special Assembly 2026', branches: [{ branchId: 1 }] };
  await eventually(async () => (await bannerTitles(page)).some((t) => t === 'The open election is now "Special Assembly 2026"'), { timeout: 6000, message: 'the election-changed note' });
  assert.equal((await resultRows(page)).length, 0);
  assert.equal(await page.locator('#search-input').inputValue(), '');
  assert.equal(await page.locator('.election-title').textContent(), 'Special Assembly 2026');
  assert.match(await page.locator('.election-detail').textContent(), /1 participating branch$/);
  await page.locator('.banner-info').getByRole('button', { name: 'Dismiss' }).click();
  assert.equal(await page.locator('.banner-info').count(), 0);
}, { config: { eventRefreshSeconds: 1 } });

test('session: no election open - the banner offers "Check again", and F5 asks the server without reloading the page', async ({ page, stub }) => {
  stub.state.event = null;
  await signedIn(page);
  assert.ok((await bannerTitles(page)).some((t) => t === 'No election is open'));
  assert.equal(await page.locator('.election-title').textContent(), 'No election is open');

  stub.state.event = structuredClone(EVENT);
  await page.evaluate(() => { window.__sameDocument = true; });
  await page.keyboard.press('F5');
  await eventually(async () => !(await bannerTitles(page)).some((t) => t === 'No election is open'), { message: 'the banner to go' });
  assert.equal(await page.locator('.election-title').textContent(), EVENT.title);
  assert.equal(await page.evaluate(() => window.__sameDocument), true, 'F5 did not reload the page (that would end the session)');
});

test('session: the election banner\'s "Check again" button looks again', async ({ page, stub }) => {
  stub.state.event = null;
  await signedIn(page);
  stub.state.event = structuredClone(EVENT);
  await page.getByRole('button', { name: 'Check again' }).click();
  await eventually(async () => (await page.locator('.election-title').textContent()) === EVENT.title, { message: 'the election title' });
});
