// Offline mode (venue with no signal) in real Chromium, under the real Content-Security-Policy and Trusted Types:
// IndexedDB + WebCrypto (the member list encrypted with the password), the service worker, the outbox and the catch-up.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from '../framework.mjs';
import { PASSWORD } from '../harness.mjs';
import { EVENT } from '../stub-api.mjs';

/** Local wall-clock text, as the server sends a schedule. */
const wall = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
/** Offline, the election is open by the PC clock and its schedule: put "now" inside it. */
const openNow = (stub) => (stub.state.event = { ...EVENT, scheduleFrom: wall(Date.now() - 3600000), scheduleTo: wall(Date.now() + 8 * 3600000) });
import { eventually, prints, signIn, signedIn, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

const offlineBar = (page) => page.locator('.offline-bar');
const lockDialog = (page) => page.getByRole('dialog', { name: 'Locked' });

async function prepare(page) {
  await offlineBar(page).getByRole('button', { name: 'Prepare for offline' }).click();
  await waitForNotice(page, /^Ready for offline:/, 30000);
}

async function signOut(page) {
  await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#login-user').waitFor({ state: 'visible' });
}

/** Everything the page stored in IndexedDB, as text (to prove no member name or code is readable there). */
const storedText = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('evoting-registration-offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['users', 'outbox'], 'readonly');
          const all = [];
          for (const name of ['users', 'outbox']) {
            const r = tx.objectStore(name).getAll();
            r.onsuccess = () => all.push(...r.result);
          }
          tx.oncomplete = () => resolve(JSON.stringify(all));
        };
      }),
  );

test('offline: prepare online, sign in with the server down, issue (slip ISSUED OFFLINE), back online the server gets it with its time', async (session) => {
  const { page, stub } = session;
  openNow(stub);
  await signedIn(page);
  assert.match(await offlineBar(page).textContent(), /Not ready for offline/);
  await prepare(page);
  assert.match(await offlineBar(page).textContent(), /Ready for offline/);

  const stored = await storedText(page);
  for (const secret of ['Juan Dela Cruz', 'A0001', 'Dela Rosa', PASSWORD]) assert.ok(!stored.includes(secret), `"${secret}" is readable in the browser storage`);

  // the venue: no signal
  await signOut(page);
  stub.state.down = true;
  await signIn(page);
  await page.locator('#search-input').waitFor({ state: 'visible', timeout: 20000 });
  await eventually(async () => /OFFLINE MODE/.test(await offlineBar(page).textContent()), { message: 'the OFFLINE MODE strip' });
  const before = stub.issues().length;

  await typeInSearch(page, 'A0001');
  await waitForResults(page, (rows) => rows.length === 1);
  await page.keyboard.press('Enter');
  await waitForNotice(page, /OFFLINE\. Saved on this PC/, 15000);
  const printed = await prints(page);
  assert.equal(printed.length, 1, 'the slip is printed at once');
  assert.ok(printed[0].text.includes('ISSUED OFFLINE') && printed[0].text.includes('A0001'), printed[0].text);
  assert.equal(stub.issues().length, before, 'nothing reached the server');
  assert.equal(stub.member(1).qrIssuedAt, null, 'the server does not know yet');
  assert.match(await offlineBar(page).textContent(), /1 QR issuance waits to be sent/);

  // the server is back: Lock, type the password -> online again, and the issuance is sent with the time it was made
  stub.state.down = false;
  await page.getByRole('button', { name: 'Lock' }).click();
  await lockDialog(page).waitFor();
  await lockDialog(page).getByLabel('Password').fill(PASSWORD);
  await lockDialog(page).getByRole('button', { name: 'Unlock' }).click();
  await eventually(() => stub.member(1).qrIssuedAt, { timeout: 20000, message: 'the server receiving the offline issuance' });
  const bulk = stub.state.log.find((e) => e.method === 'POST' && e.path === '/api/v1/registration/members/qr-issued-bulk');
  assert.equal(bulk.bulk.length, 1);
  assert.equal(bulk.bulk[0].memberId, 1);
  assert.ok(Date.now() - Date.parse(bulk.bulk[0].issuedAtUtc) < 120000, 'the time of the issuance on the PC is sent');
  await eventually(async () => !/OFFLINE MODE/.test(await offlineBar(page).textContent()), { message: 'back to online' });
  await eventually(async () => !/wait(s)? to be sent/.test(await offlineBar(page).textContent()), { message: 'nothing left to send' });
}, { timeout: 120000 });

test('offline: a user who did not prepare this PC, and a wrong password, cannot sign in without the server', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  await prepare(page);
  await signOut(page);
  stub.state.down = true;

  await signIn(page, 'clerk', 'not the password');
  await eventually(async () => /Wrong password \(checked against the offline data/.test(await page.locator('.login .form-error').textContent()), { message: 'the wrong-password refusal', timeout: 20000 });

  await signIn(page, 'someone-else', 'whatever');
  await eventually(async () => /could not be reached[\s\S]*not prepared for offline work/.test(await page.locator('.login .form-error').textContent()), { message: 'the not-prepared refusal', timeout: 20000 });
  assert.equal(await page.locator('#desk').isVisible(), false);
}, { timeout: 120000 });

test('offline: the page itself opens with no web server at all (the service worker keeps the page files)', async (session) => {
  const { page, site } = session;
  await page.locator('#login-user').waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && !(await caches.keys()).length; i++) await new Promise((r) => setTimeout(r, 50));
  });
  await page.reload(); // the worker now controls the page
  await site.close(); // the web server too is gone
  await page.reload();
  await page.locator('#login-user').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.getByRole('button', { name: 'Sign in' }).isVisible(), true);
}, { timeout: 60000 });

test('offline: a Registration package from USB (made by EVoting.Api) is imported with its passphrase and used offline', async (session) => {
  const { page, stub } = session;
  await signedIn(page);
  const fixture = new URL('../../unit/fixtures/sample.evreg', import.meta.url);

  // a wrong passphrase imports nothing
  await offlineBar(page).getByRole('button', { name: 'Import USB package…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a Registration package' });
  await dialog.locator('#import-file').setInputFiles(fileURLToPath(fixture));
  await eventually(async () => /Test General Assembly/.test(await dialog.textContent()), { message: 'the package label' });
  await dialog.getByLabel('Passphrase').fill('WRON-GPAS-SPHR-ASE2-3456-789A');
  await dialog.getByRole('button', { name: 'Import' }).click();
  await waitForNotice(page, /passphrase is wrong/, 20000);
  assert.match(await offlineBar(page).textContent(), /Not ready for offline/);
  await eventually(async () => !(await dialog.isVisible()) && (await offlineBar(page).getByRole('button', { name: 'Import USB package…' }).isEnabled()), { message: 'the desk ready again' });

  await offlineBar(page).getByRole('button', { name: 'Import USB package…' }).click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('#import-file').setInputFiles(fileURLToPath(fixture));
  await dialog.getByLabel('Passphrase').fill('test-pass-phra-se23-4567-89ab');
  await dialog.getByRole('button', { name: 'Import' }).click();
  await waitForNotice(page, /^Imported: "Test General Assembly", 2 members/, 20000);

  // the venue: the desk signs in from the imported list
  await signOut(page);
  stub.state.down = true;
  await signIn(page);
  await page.locator('#search-input').waitFor({ state: 'visible', timeout: 20000 });
  await eventually(async () => /OFFLINE MODE[\s\S]*"Test General Assembly", 2 members/.test(await offlineBar(page).textContent()), { message: 'working from the imported package' });
}, { timeout: 120000 });
