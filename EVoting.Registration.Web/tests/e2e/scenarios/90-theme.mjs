import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, signedIn, typeInSearch, waitForResults } from '../ui.mjs';

// The CSS colour "forestgreen", #228B22, as the browser reports a computed colour.
const FOREST = 'rgb(34, 139, 34)';
const WHITE = 'rgb(255, 255, 255)';

/** The computed values of some CSS properties of the first element a locator finds. */
const paint = (locator, ...properties) =>
  locator.first().evaluate((el, names) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, properties);

test('theme: the colour of the desk is literally forest green (#228B22) - sign-in, top bar, main buttons, the chosen row', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  await page.mouse.move(0, 0);

  // sign-in screen
  assert.equal((await paint(page.locator('.login-panel'), 'border-top-color'))['border-top-color'], FOREST);
  const signInButton = await paint(page.getByRole('button', { name: 'Sign in' }), 'background-color', 'color');
  assert.equal(signInButton['background-color'], FOREST);
  assert.equal(signInButton.color, WHITE);

  // the browser's own bar on a phone
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#228b22');

  // the desk
  await signedIn(page);
  await page.mouse.move(0, 0);
  const bar = await paint(page.locator('.topbar'), 'background-color', 'color');
  assert.equal(bar['background-color'], FOREST);
  assert.equal(bar.color, WHITE);

  // the election title is large bold type sitting straight on the green; everything small sits on a darker inset
  const title = await paint(page.locator('.election-title'), 'font-size', 'font-weight', 'color');
  assert.ok(Number.parseFloat(title['font-size']) >= 18.66, `the title is ${title['font-size']} - white on #228B22 (4.39:1) is for large type only`);
  assert.ok(Number(title['font-weight']) >= 700, `the title weighs ${title['font-weight']}`);
  assert.equal(title.color, WHITE);
  const smallOnBar = await page.locator('.topbar').evaluate((bar) => {
    const found = [];
    const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (el.closest('[hidden]')) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      const weight = Number(getComputedStyle(el).fontWeight);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      // the colour behind the text: the nearest ancestor (up to the bar) that paints a background
      let behind = null;
      for (let up = el; up; up = up.parentElement) {
        const bg = getComputedStyle(up).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          behind = bg;
          break;
        }
        if (up === bar) break;
      }
      found.push({ text: node.textContent.trim().slice(0, 40), large, behind });
    }
    return found;
  });
  assert.ok(smallOnBar.length >= 4, `only ${smallOnBar.length} pieces of text were found on the top bar`);
  const offenders = smallOnBar.filter((piece) => !piece.large && piece.behind === FOREST);
  assert.deepEqual(offenders, [], 'small type sits directly on the plain forest green (4.39:1 is not enough for it)');

  // the main button and the chosen row
  await typeInSearch(page, 'A0001');
  await waitForResults(page, (rows) => rows.length === 1);
  const row = page.locator('#results > li.is-selected');
  await eventually(async () => (await row.count()) === 1, { message: 'the only match to be the chosen row' });
  assert.equal((await paint(row, 'border-left-color'))['border-left-color'], FOREST);
  await page.mouse.move(0, 0);
  const issue = page.locator('#issue-button');
  assert.equal(await issue.isEnabled(), true);
  const issueButton = await paint(issue, 'background-color', 'color', 'font-weight', 'font-size');
  assert.equal(issueButton['background-color'], FOREST);
  assert.equal(issueButton.color, WHITE);
  assert.ok(Number(issueButton['font-weight']) >= 700 && Number.parseFloat(issueButton['font-size']) >= 18.66, 'the label of a button on plain forest green is large and bold');
});
