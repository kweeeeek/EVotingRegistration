import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, prints, signedIn, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

async function find(page, text) {
  await typeInSearch(page, text);
  return waitForResults(page, (rows) => rows.length === 1);
}

/**
 * Builds the three kinds of record a session can hold:
 *   Juan Dela Cruz  - confirmed
 *   Josefa Peña     - not confirmed (the answer never came)
 *   Ligaya Reyes    - rejected (the server no longer knows her)
 */
async function threeRecords({ page, stub }) {
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);

  await find(page, 'A0004');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'drop-before' });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /Josefa Peña: The server could not be reached/);

  await find(page, 'B0006');
  stub.state.members = stub.state.members.filter((m) => m.memberId !== 6);
  await page.keyboard.press('Enter');
  await waitForNotice(page, /Ligaya Reyes: The server does not know this member/);
}

const reviewDialog = (page) => page.getByRole('dialog', { name: 'Review records' });
const rowsOf = (page) => reviewDialog(page).locator('tbody tr');
const summary = async (page) => (await reviewDialog(page).locator('.review-summary').textContent()).trim();
const attentionBanner = (page) => page.locator('.banner-critical .banner-title');

test('records: problems raise a banner whose Review button opens the list "needs attention"', async (session) => {
  const { page } = session;
  await threeRecords(session);
  assert.ok((await attentionBanner(page).allTextContents()).some((t) => /^2 QR issuance records need attention$/.test(t)));
  await page.locator('.banner-critical').filter({ hasText: 'need attention' }).getByRole('button', { name: 'Review' }).click();
  await reviewDialog(page).waitFor();
  assert.equal(await summary(page), '2 records not recorded, rejected or waiting for a decision.');
  assert.equal(await rowsOf(page).count(), 2, 'the confirmed one is not a problem');
  const text = await reviewDialog(page).locator('tbody').textContent();
  assert.match(text, /Josefa Peña.*A0004.*Not confirmed - the server did not answer/);
  assert.match(text, /Ligaya Reyes.*B0006.*Rejected by server/);
  assert.equal(await reviewDialog(page).getByRole('button', { name: 'Try again' }).count(), 1, 'only the unconfirmed one can be tried again');
  assert.equal(await reviewDialog(page).getByRole('button', { name: 'Check with server' }).count(), 1);
});

test('records: "Mark as seen" keeps the record but stops it raising the banner', async (session) => {
  const { page } = session;
  await threeRecords(session);
  await page.getByRole('button', { name: /^Review records/ }).click();
  await reviewDialog(page).waitFor();
  const rejectedRow = rowsOf(page).filter({ hasText: 'Ligaya Reyes' });
  await rejectedRow.getByRole('button', { name: 'Mark as seen' }).click();
  assert.match(await reviewDialog(page).locator('.review-notice').textContent(), /Marked as seen: Ligaya Reyes\. The record stays on file\./);
  assert.equal(await rowsOf(page).count(), 1);

  await page.keyboard.press('Escape');
  await reviewDialog(page).waitFor({ state: 'hidden' });
  assert.ok((await attentionBanner(page).allTextContents()).some((t) => /^1 QR issuance record needs attention$/.test(t)));

  await page.getByRole('button', { name: /^Review records/ }).click();
  await reviewDialog(page).getByLabel('Include records already marked as seen').check();
  assert.equal(await rowsOf(page).count(), 2);
  assert.equal(await summary(page), '2 records not recorded, rejected or waiting for a decision (1 not yet marked as seen).');
  assert.match(await rowsOf(page).filter({ hasText: 'Ligaya Reyes' }).textContent(), /Marked as seen\./);

  await reviewDialog(page).getByLabel('Latest records (all states)').check();
  assert.equal(await rowsOf(page).count(), 3, 'nothing was deleted');
});

test('records: "Try again" from the list records it with the server, prints once and removes it from the list', async (session) => {
  const { page, stub } = session;
  await threeRecords(session);
  const before = (await prints(page)).length;
  await page.getByRole('button', { name: /^Review records/ }).click();
  await rowsOf(page).filter({ hasText: 'Josefa Peña' }).getByRole('button', { name: 'Try again' }).click();
  await eventually(async () => /Recorded by the server: Josefa Peña\. The slip was sent to the printer\./.test(await reviewDialog(page).locator('.review-notice').textContent()), { message: 'the result line' });
  assert.equal((await prints(page)).length, before + 1);
  assert.ok(stub.member(4).qrIssuedAt);
  assert.equal(await rowsOf(page).count(), 1, 'only the rejected one is left');
});

test('records: "Check with server" finds an issuance whose answer was lost', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0004');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'drop-after' });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /could not be reached/);
  await page.getByRole('button', { name: /^Review records/ }).click();
  await reviewDialog(page).getByRole('button', { name: 'Check with server' }).click();
  await eventually(async () => /The server has this issuance\. It is confirmed\. The slip was sent to the printer\./.test(await reviewDialog(page).locator('.review-notice').textContent()), { message: 'the confirmation' });
  assert.equal((await prints(page)).length, 1);
  assert.equal(stub.issues().length, 1);
  assert.equal(await summary(page), 'Nothing needs attention.');
});

test('records: a confirmed record can be reprinted, and the slip says REPRINT', async (session) => {
  const { page } = session;
  await threeRecords(session);
  const before = (await prints(page)).length;
  await page.getByRole('button', { name: /^Review records/ }).click();
  await reviewDialog(page).getByLabel('Latest records (all states)').check();
  await rowsOf(page).filter({ hasText: 'Juan Dela Cruz' }).getByRole('button', { name: 'Reprint slip' }).click();
  await eventually(async () => (await prints(page)).length === before + 1, { message: 'the reprint' });
  const last = (await prints(page)).at(-1);
  assert.match(last.text, /REPRINT/);
  assert.match(last.text, /Juan Dela Cruz/);
  assert.equal(await rowsOf(page).filter({ hasText: 'Josefa Peña' }).getByRole('button', { name: 'Reprint slip' }).count(), 0, 'a record the server did not confirm has no slip to reprint');
});

test('records: closing the list with Esc returns the cursor to the button that opened it', async ({ page }) => {
  await signedIn(page);
  const open = page.getByRole('button', { name: /^Review records/ });
  await open.focus();
  await open.press('Enter');
  await reviewDialog(page).waitFor();
  assert.equal(await summary(page), 'No QR issuances have been made in this session yet.', 'with nothing to decide, the list opens on the latest records');
  await page.keyboard.press('Escape');
  await reviewDialog(page).waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.startsWith('Review records')), true);
});

test('records: the strip under the desk lists the latest first, with the state in words', async (session) => {
  const { page } = session;
  await threeRecords(session);
  const items = page.locator('.recent-item');
  assert.equal(await items.count(), 3);
  const texts = await items.allTextContents();
  assert.match(texts[0], /Ligaya Reyes.*B0006.*Rejected/);
  assert.match(texts[1], /Josefa Peña.*A0004.*Not confirmed/);
  assert.match(texts[2], /Juan Dela Cruz.*A0001.*Confirmed.*Reprint/);
  assert.equal(await page.getByRole('button', { name: /^Review records, 2 records need attention$/ }).count(), 1, 'the button says how many need attention');
});

test('records: leaving the page with unresolved records asks first (the session\'s list would be lost)', async (session) => {
  const { page } = session;
  await threeRecords(session);
  const prevented = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, true);
});

test('records: leaving a clean page does not ask', async ({ page }) => {
  await signedIn(page);
  const prevented = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, false);
});
