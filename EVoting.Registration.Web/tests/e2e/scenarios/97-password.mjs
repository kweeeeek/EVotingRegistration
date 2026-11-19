import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, signIn } from '../ui.mjs';

const GIVEN = 'Sacdeco@2026';
const OWN = 'My-Own-Pass-7!';

function newClerk(stub) {
  stub.state.users.newclerk = { password: GIVEN, fullName: 'New Clerk', mustChangePassword: true };
}

test('password: a password the administrator gave must be changed before the desk opens', async ({ page, stub }) => {
  newClerk(stub);
  await signIn(page, 'newclerk', GIVEN);
  await page.locator('#login-new-password').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-input').isVisible(), false, 'the desk stays closed');
  assert.match(await page.locator('.login-change').textContent(), /newclerk: the password you used was given by the administrator/);

  // the page's own rules first: nothing is sent
  await page.locator('#login-new-password').fill('short');
  await page.locator('#login-confirm-password').fill('short');
  await page.getByRole('button', { name: 'Save the new password and open the desk' }).click();
  await eventually(async () => /8 to 128 characters/.test(await page.locator('.login-change .change-error').textContent()), { message: 'the rule' });
  await page.locator('#login-new-password').fill(OWN);
  await page.locator('#login-confirm-password').fill('Something-Else-1!');
  await page.getByRole('button', { name: 'Save the new password and open the desk' }).click();
  await eventually(async () => /not the same/.test(await page.locator('.login-change .change-error').textContent()), { message: 'mismatch' });
  await page.locator('#login-new-password').fill(GIVEN);
  await page.locator('#login-confirm-password').fill(GIVEN);
  await page.getByRole('button', { name: 'Save the new password and open the desk' }).click();
  await eventually(async () => /different from the one you were given/.test(await page.locator('.login-change .change-error').textContent()), { message: 'same as given' });
  assert.equal(stub.state.passwordChanges, 0);

  await page.locator('#login-new-password').fill(OWN);
  await page.locator('#login-confirm-password').fill(OWN);
  await page.getByRole('button', { name: 'Save the new password and open the desk' }).click();
  await page.locator('#search-input').waitFor({ state: 'visible' });
  assert.equal(stub.state.passwordChanges, 1);
  assert.equal(stub.state.users.newclerk.password, OWN);
  assert.match(await page.locator('.topbar-user').textContent(), /New Clerk.*Desk 3/);
  assert.equal(await page.locator('#login-new-password').inputValue(), '', 'nothing stays in the form');
});

test('password: "Back to sign-in" leaves the desk closed; the given password still asks again next time', async ({ page, stub }) => {
  newClerk(stub);
  await signIn(page, 'newclerk', GIVEN);
  await page.locator('#login-new-password').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Back to sign-in' }).click();
  await page.locator('#login-password').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-input').isVisible(), false);
  await signIn(page, 'newclerk', GIVEN);
  await page.locator('#login-new-password').waitFor({ state: 'visible' });
});

test('password: an account that is not flagged signs in as before', async ({ page, stub }) => {
  await signIn(page);
  await page.locator('#search-input').waitFor({ state: 'visible' });
  assert.equal(stub.state.passwordChanges, 0);
  assert.equal(await page.locator('#login-new-password').isVisible(), false);
});
