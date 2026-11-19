import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, signIn, signedIn, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

/** Issues a QR to the one member that matches the text. */
async function issue(page, text, name) {
  await typeInSearch(page, text);
  await waitForResults(page, (rows) => rows.length === 1);
  await page.keyboard.press('Enter');
  await waitForNotice(page, new RegExp(`^QR issued for ${name}\. Confirmed by the server\.$`));
}

const deskRows = (page) => page.locator('.dialog-records[aria-labelledby="desk-list-title"] tbody tr').evaluateAll((rows) => rows.map((r) => r.querySelector('strong').textContent));
const deskSummary = (page) => page.locator('.dialog-records[aria-labelledby="desk-list-title"] .review-summary').textContent();

async function openDeskList(page) {
  await page.getByRole('button', { name: 'Issued at this desk' }).click();
  await page.locator('#desk-list-title').waitFor({ state: 'visible' });
}

test('desk: the desk chosen at sign-in goes with every slip, and the list of the desk comes from the server', async ({ page, stub }) => {
  await signedIn(page); // desk 3
  assert.match(await page.locator('.topbar-user').textContent(), /Desk 3/);
  await issue(page, 'A0001', 'Juan Dela Cruz');
  assert.deepEqual(stub.issues().at(-1).body, { eventId: stub.state.event.eventId, deskNo: 3 });

  await openDeskList(page);
  await eventually(async () => (await deskRows(page)).length === 1, { message: 'the desk list' });
  assert.deepEqual(await deskRows(page), ['Juan Dela Cruz']);
  assert.match(await deskSummary(page), /^Desk 3, ".+": 1 member received a QR here\.$/);
  await page.getByRole('button', { name: 'Close' }).last().click();

  // a new page (reload) and a new sign-in at the same desk: the list is still there
  await page.reload();
  await signIn(page);
  await page.locator('#search-input').waitFor({ state: 'visible' });
  await openDeskList(page);
  await eventually(async () => (await deskRows(page)).length === 1, { message: 'the desk list after a reload' });
});

test('desk: another desk does not see it; signing in without a desk is refused', async ({ page, stub }) => {
  stub.state.issuances.push({ eventId: stub.state.event.eventId, memberId: 4, deskNo: 5, issuedAtUtc: new Date().toISOString(), issuedBy: 'other', offline: false });
  await page.locator('#login-user').fill('clerk');
  await page.locator('#login-password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await eventually(async () => (await page.locator('.login .form-error').textContent()).trim() === 'Choose your registration desk.', { message: 'the desk prompt' });
  assert.equal(stub.state.logins, 0, 'nothing was sent');

  await signIn(page, undefined, undefined, '4');
  await page.locator('#search-input').waitFor({ state: 'visible' });
  await openDeskList(page);
  await eventually(async () => /^Desk 4, ".+": 0 members received a QR here\.$/.test(await deskSummary(page)), { message: 'empty desk 4' });
  assert.deepEqual(await deskRows(page), []);
});

test('desk: a QR of an earlier election does not count as "already issued" in the new one', async ({ page, stub }) => {
  await signedIn(page);
  await issue(page, 'A0001', 'Juan Dela Cruz');
  // the Representative Assembly closes, the General Assembly opens
  stub.state.event = { ...stub.state.event, eventId: stub.state.event.eventId + 1, title: 'General Assembly' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await eventually(async () => (await page.locator('.election-title').textContent()) === 'General Assembly', { message: 'the new election' });
  const before = stub.issues().length;
  await issue(page, 'A0001', 'Juan Dela Cruz'); // no "QR already issued" question
  assert.equal(stub.issues().length, before + 1);
  assert.equal(stub.issues().at(-1).body.eventId, stub.state.event.eventId);
});
