import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { PASSWORD, USER } from '../harness.mjs';
import { assertNoCspTrouble, bannerTitles, eventually, pillText, signIn, signedIn } from '../ui.mjs';

const serverState = (page) => page.locator('.login-server-state');

test('login: right user name and password open the desk; nothing stays in the form', async (session) => {
  const { page } = session;
  await signedIn(page);
  assert.match(await page.locator('.topbar-user').textContent(), /Ana Reyes/); // the name comes from the token, for display only
  assert.equal(await page.locator('#login-password').inputValue(), '');
  assert.equal(await page.locator('#login-user').inputValue(), '');
  assert.equal(await page.locator('.login').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input', 'the cursor is ready in the search box');
  assert.equal(new URL(page.url()).search, '', 'no credentials or token in the address');
  assert.equal(session.stub.state.logins, 1);
  assertNoCspTrouble(session);
  assert.deepEqual(session.seen.console, []);
});

test('login: Enter in the password box signs in', async ({ page }) => {
  await page.locator('#login-user').fill(USER);
  await page.locator('#login-password').fill(PASSWORD);
  await page.locator('#login-password').press('Enter');
  await page.locator('#search-input').waitFor({ state: 'visible' });
});

test('login: wrong password says so, empties the password and keeps the user name', async (session) => {
  const { page } = session;
  await signIn(page, USER, 'not the password');
  await eventually(async () => (await page.locator('.login .form-error').textContent()).trim() === 'Wrong user name or password.', { message: 'the error message' });
  assert.equal(await page.locator('#login-password').inputValue(), '');
  assert.equal(await page.locator('#login-user').inputValue(), USER);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'login-password');
  assert.equal(await page.locator('.topbar').isVisible(), false, 'still signed out');
});

test('login: empty fields ask for both', async ({ page, stub }) => {
  await page.getByRole('button', { name: 'Sign in' }).click();
  await eventually(async () => /Enter the user name and the password/.test(await page.locator('.login .form-error').textContent()), { message: 'a prompt' });
  assert.equal(stub.state.logins, 0, 'nothing was sent');
});

test('login: too many attempts shows a cooldown instead of hammering the server', async ({ page, stub }) => {
  stub.state.loginLimit = { max: 1, windowMs: 60000 };
  await signIn(page, USER, 'wrong');
  await eventually(async () => /Wrong user name/.test(await page.locator('.login .form-error').textContent()), { message: 'first answer' });
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await eventually(async () => /Too many sign-in attempts/.test(await page.locator('.login .form-error').textContent()), { message: 'the 429 message' });
  const button = page.locator('.login-form button[type=submit]');
  assert.equal(await button.isDisabled(), true);
  assert.match(await button.textContent(), /Try again in \d+s/);
  const before = stub.state.logins;
  await page.locator('#login-password').fill(PASSWORD);
  await page.locator('#login-password').press('Enter');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(stub.state.logins, before, 'a press of Enter during the cooldown sends nothing');
});

test('login: the password can be shown and hidden', async ({ page }) => {
  const field = page.locator('#login-password');
  assert.equal(await field.getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Show' }).click();
  assert.equal(await field.getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide' }).click();
  assert.equal(await field.getAttribute('type'), 'password');
});

test('login: before anybody types, the page says whether the server answers', async ({ page }) => {
  await eventually(async () => (await serverState(page).textContent()).trim() === 'reachable', { message: 'the server to be reachable' });
});

test('login: server switched off - the screen says not reachable and sign-in explains it', async ({ page, stub }) => {
  await stub.close();
  await page.reload();
  await eventually(async () => (await serverState(page).textContent()).trim() === 'not reachable', { message: 'not reachable' });
  assert.ok((await bannerTitles(page)).some((t) => /Offline/.test(t)), 'an Offline notice');
  await signIn(page);
  await eventually(async () => /could not be reached/.test(await page.locator('.login .form-error').textContent()), { message: 'a reachability message' });
});

test('login: server that does not list this site (CORS) is diagnosed, not reported as "offline"', async (session) => {
  const { page, site } = session;
  await eventually(async () => (await serverState(page).textContent()).trim() === 'not reachable', { message: 'blocked' });
  const titles = await bannerTitles(page);
  assert.ok(titles.some((t) => /browser is blocking the connection/.test(t)), `titles: ${titles}`);
  const detail = await page.locator('.banner-critical .banner-detail').first().textContent();
  assert.ok(detail.includes('EVOTING_ALLOWED_ORIGINS'), 'names the setting to change');
  assert.ok(detail.includes(site.origin), 'names the address of this page, which is what the server must list');
  assert.ok(!titles.some((t) => /^Offline/.test(t)), 'not shown as a plain offline');
  await signIn(page);
  await eventually(async () => /does not list this site/.test(await page.locator('.login .form-error').textContent()), { message: 'the CORS explanation' });
}, { allowedOrigins: ['https://some-other-site.example'] });

test('login: a server that answers 500 is shown as a server problem, not as offline', async ({ page, stub }) => {
  stub.inject({ method: 'POST', path: /registration-login/, type: 'status', status: 503, body: { error: 'Database unavailable.' } });
  await signIn(page);
  await eventually(async () => /Database unavailable/.test(await page.locator('.login .form-error').textContent()), { message: 'the server message' });
  await eventually(async () => /server problem/i.test(await pillText(page).catch(() => '')) || (await bannerTitles(page)).some((t) => /server answered with a problem/.test(t)), { message: 'a server-problem notice' });
});

test('login: a page configured with plain http:// to a real host refuses to start', async ({ page }) => {
  await page.locator('h1').waitFor();
  assert.match(await page.locator('h1').textContent(), /not set up correctly/);
  assert.match(await page.locator('.form-error').textContent(), /must start with https/);
  assert.equal(await page.locator('#login-user').count(), 0, 'no sign-in form that could send a password in clear text');
}, {
  tweak: async (dir) => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const p = `${dir}/config.js`;
    await writeFile(p, (await readFile(p, 'utf8')).replace(/apiBaseUrl: '[^']*'/, "apiBaseUrl: 'http://api.example.com'"));
  },
});
