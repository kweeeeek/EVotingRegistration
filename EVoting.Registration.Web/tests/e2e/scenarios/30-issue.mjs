import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, noticeText, prints, resultRows, searchBox, signedIn, sleep, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

/** Types a code that matches exactly one member and waits until that member is on screen. */
async function find(page, text) {
  await typeInSearch(page, text);
  return waitForResults(page, (rows) => rows.length === 1);
}

const noticeButtons = (page) => page.locator('.notice .notice-actions button').allTextContents();

test('issue: Enter on a single match issues at once - the slip is printed only AFTER the server has recorded it', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await find(page, 'A0001');
  stub.state.latencyMs = 700;
  await page.keyboard.press('Enter');
  await sleep(250);
  assert.equal((await prints(page)).length, 0, 'nothing is printed while the server has not answered');
  assert.match(await page.locator('#issue-button').textContent(), /Issuing/);
  await waitForNotice(page, /^QR issued for Juan Dela Cruz\. Confirmed by the server\.$/);

  const printed = await prints(page);
  assert.equal(printed.length, 1);
  assert.ok(printed[0].text.includes('Juan Dela Cruz') && printed[0].text.includes('A0001'));
  assert.equal(printed[0].slips, 1);

  assert.equal(stub.issues().length, 1);
  assert.equal(stub.issues()[0].path, '/api/v1/registration/members/1/qr-issued');
  assert.ok(stub.member(1).qrIssuedAt, 'the server has the issuance');

  // ready for the next member
  assert.equal(await searchBox(page).inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input');
  assert.equal((await resultRows(page)).length, 0);

  // what staff see afterwards
  assert.match(await page.locator('.slip-paper .slip').textContent(), /Juan Dela Cruz/);
  const recent = page.locator('.recent-item');
  assert.equal(await recent.count(), 1);
  assert.match(await recent.first().textContent(), /Juan Dela Cruz.*A0001.*Confirmed/);
  assert.deepEqual(session.seen.csp, []);
  assert.deepEqual(session.seen.pageErrors, []);
});

test('issue: choosing from a list and pressing the button works the same', async ({ page, stub }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  await page.keyboard.press('ArrowDown');
  await page.locator('#issue-button').click();
  await waitForNotice(page, /QR issued for Dela Rosa, Ramon/);
  assert.equal(stub.issues().length, 1);
  assert.equal(stub.issues()[0].path, '/api/v1/registration/members/7/qr-issued');
  assert.equal((await prints(page)).length, 1);
});

test('issue: a double Enter and a second Enter right after do not issue twice', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  stub.state.latencyMs = 500;
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  assert.equal(stub.issues().length, 1, 'one request for one member');
  assert.equal((await prints(page)).length, 1);

  // the same member again within a few seconds is the same action, not a request for a second QR
  stub.state.latencyMs = 0;
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /A QR for Juan Dela Cruz was just issued/);
  assert.equal(stub.issues().length, 1);
  assert.equal((await prints(page)).length, 1);
});

test('issue: a member who already has a QR is asked about first - the default answer is Cancel', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0002');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'QR already issued' });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /Maria Dela Cruz-Santos was already issued a QR \(03 Nov 2026 09:30\)/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'a stray Enter must not confirm');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await noticeText(page), 'No new QR was issued.');
  assert.equal(stub.issues().length, 0);
  assert.equal((await prints(page)).length, 0);
});

test('issue: "Issue again" after the question issues and prints a new slip', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0002');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Issue again' }).click();
  await waitForNotice(page, /QR issued for Maria Dela Cruz-Santos/);
  assert.equal(stub.issues().length, 1);
  assert.equal((await prints(page)).length, 1);
});

test('issue: a member who is not eligible cannot be issued a QR - button off, reason shown, Enter explains', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0003');
  assert.equal(await page.locator('#issue-button').isDisabled(), true);
  assert.match(await page.locator('#issue-hint').textContent(), /No QR is issued to a member who is not eligible\. Share capital is below the minimum\./);
  await page.keyboard.press('Enter');
  assert.match(await noticeText(page), /Not eligible to vote\. Share capital is below the minimum\. No QR is issued\./);
  assert.equal(stub.issues().length, 0);
});

test('issue: an inactive member cannot be issued a QR', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0005');
  assert.equal(await page.locator('#issue-button').isDisabled(), true);
  assert.match(await page.locator('.eligibility-text').textContent(), /Member is not active/);
  await page.keyboard.press('Enter');
  assert.equal(stub.issues().length, 0);
});

test('issue: a member the server no longer knows is REJECTED - no slip, listed for review', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'B0006');
  stub.state.members = stub.state.members.filter((m) => m.memberId !== 6); // deleted on the server after the search
  await page.keyboard.press('Enter');
  await waitForNotice(page, /Ligaya Reyes: The server does not know this member/);
  assert.equal((await prints(page)).length, 0);
  assert.deepEqual(await noticeButtons(page), [], 'nothing to retry: the server refused for good');
  assert.equal(await page.locator('.recent-item').first().getAttribute('data-state'), 'rejected');
  assert.ok((await page.locator('.banner-critical .banner-title').allTextContents()).some((t) => /1 QR issuance record needs attention/.test(t)));
});

test('issue: no answer from the server - NOT confirmed, no slip; "Try again" then issues and prints once', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'drop-before' });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /Juan Dela Cruz: The server could not be reached.*may or may not have been recorded.*No slip was printed\./);
  assert.deepEqual(await noticeButtons(page), ['Check with server', 'Try again']);
  assert.equal((await prints(page)).length, 0);
  assert.equal(await page.locator('.recent-item').first().getAttribute('data-state'), 'unknown');

  await page.getByRole('button', { name: 'Try again' }).click();
  await waitForNotice(page, /^QR issued for Juan Dela Cruz\. Confirmed by the server\.$/);
  assert.equal((await prints(page)).length, 1);
  assert.equal(stub.issues().length, 2, 'the first request never arrived; the second did');
  assert.equal(await page.locator('.recent-item').first().getAttribute('data-state'), 'confirmed');
  assert.equal(await page.locator('.banner-critical').count(), 0, 'nothing is left to look at');
});

test('issue: the server recorded it but the ANSWER was lost - "Check with server" finds it, prints once, and never issues twice', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'drop-after' });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /Juan Dela Cruz: The server could not be reached/);
  assert.ok(stub.member(1).qrIssuedAt, 'the server did record it');
  assert.equal((await prints(page)).length, 0, 'but the desk could not know, so it printed nothing');

  await page.getByRole('button', { name: 'Check with server' }).click();
  await waitForNotice(page, /^QR issued for Juan Dela Cruz\. Confirmed by the server\.$/);
  assert.equal((await prints(page)).length, 1);
  assert.equal(stub.issues().length, 1, 'checking is a search, not a second issue');
  assert.equal(await page.locator('.recent-item').first().getAttribute('data-state'), 'confirmed');
});

test('issue: "Check with server" when the server has nothing says so and offers Try again', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'drop-before' });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /could not be reached/);
  await page.getByRole('button', { name: 'Check with server' }).click();
  await waitForNotice(page, /The server has no record of this issuance\. No slip was printed\./);
  assert.deepEqual(await noticeButtons(page), ['Try again']);
  assert.equal((await prints(page)).length, 0);
  assert.equal(await page.locator('.recent-item').first().getAttribute('data-state'), 'failed');
});

test('issue: a server error (502) means "not recorded" - no slip - and only Try again is offered', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'status', status: 502 });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /Juan Dela Cruz: The server could not complete the request \(HTTP 502\)\. No slip was printed\./);
  assert.deepEqual(await noticeButtons(page), ['Try again']);
  assert.equal((await prints(page)).length, 0);
  assert.equal(stub.member(1).qrIssuedAt, null);
});

test('issue: a server that does not answer in time is listed as not confirmed', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'hang' });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /did not answer in time.*may or may not have been recorded/, 4000);
  assert.equal((await prints(page)).length, 0);
  assert.deepEqual(await noticeButtons(page), ['Check with server', 'Try again']);
}, { config: { issueTimeoutMs: 700 } });

test('issue: with quick issue off, the first Enter confirms the choice and the second issues', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await sleep(250);
  assert.equal(stub.issues().length, 0);
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  assert.equal(stub.issues().length, 1);
}, { config: { quickIssue: false } });

test('issue: with auto-print off, the slip is shown and printed only when asked', async ({ page }) => {
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  assert.equal((await prints(page)).length, 0);
  assert.equal(await page.locator('.slip-paper .slip').count(), 1);
  await page.getByRole('button', { name: 'Print again' }).click();
  await eventually(async () => (await prints(page)).length === 1, { message: 'one print' });
}, { config: { autoPrint: false } });

test('issue: the member list shows the new "Issued" time and the next search sees it', async ({ page }) => {
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  await sleep(5200); // past the "same action" window
  await typeInSearch(page, 'A0001');
  const rows = await waitForResults(page, (r) => r.length === 1);
  assert.match(await page.locator('#results .result-qr').textContent(), /^Issued 03 Nov 2026 \d\d:\d\d$/);
  assert.equal(rows[0].selected, true);
  assert.match(await page.locator('#issue-button').textContent(), /Issue QR again/);
});

test('issue: a slip that was shown goes away when another member is chosen (and comes back with Reprint)', async ({ page }) => {
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  assert.equal(await page.locator('.slip-paper .slip').count(), 1);
  await find(page, 'B0006');
  assert.equal(await page.locator('.slip-paper .slip').count(), 0);
  await page.locator('.recent-item').first().getByRole('button', { name: 'Reprint' }).click();
  await eventually(async () => (await prints(page)).length === 2, { message: 'the reprint' });
  assert.match((await prints(page))[1].text, /REPRINT/);
});
