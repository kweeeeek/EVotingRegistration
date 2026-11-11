import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { eventually, signedIn, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

// The CSS colour "forestgreen", #228B22, as the browser reports a computed colour.
const FOREST = 'rgb(34, 139, 34)';
const WHITE = 'rgb(255, 255, 255)';
const CLEAR = 'rgba(0, 0, 0, 0)';

/** The computed values of some CSS properties of the first element a locator finds. */
const paint = (locator, ...properties) =>
  locator.first().evaluate((el, names) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, properties);

/** The same for a pseudo-element ('::before'). */
const paintPseudo = (locator, pseudo, ...properties) =>
  locator.first().evaluate(
    (el, [which, names]) => {
      const style = getComputedStyle(el, which);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
    },
    [pseudo, properties],
  );

/** Every piece of visible text on the page that sits directly on plain forest green, apart from the label of a main button. */
const textOnPlainForest = (page) =>
  page.evaluate((forest) => {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el.checkVisibility() || el.closest('.btn-primary')) continue;
      for (let up = el; up; up = up.parentElement) {
        const bg = getComputedStyle(up).backgroundColor;
        if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
        if (bg === forest) found.push(text.slice(0, 40));
        break;
      }
    }
    return found;
  }, FOREST);

test('theme: the colour of the desk is literally forest green (#228B22) - the line across the top, the main buttons, the mark, the chosen row', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  await page.mouse.move(0, 0);

  // sign-in screen: the thin line across the top, the main button, the colour of the browser's own bar on a phone
  const line = await paint(page.locator('#app'), 'border-top-color', 'border-top-width', 'border-top-style');
  assert.deepEqual(line, { 'border-top-color': FOREST, 'border-top-width': '3px', 'border-top-style': 'solid' });
  const signInButton = await paint(page.getByRole('button', { name: 'Sign in' }), 'background-color', 'color', 'font-weight');
  assert.equal(signInButton['background-color'], FOREST);
  assert.equal(signInButton.color, WHITE);
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#228b22');
  assert.deepEqual(await textOnPlainForest(page), [], 'text sits directly on plain forest green (4.39:1 is only for the main button)');

  // the desk: a white top bar, not a green bar (the green tile with the tick that used to sit in it was taken out of the top bar on 5-6 Nov 2026)
  await signedIn(page);
  await page.mouse.move(0, 0);
  const bar = await paint(page.locator('.topbar'), 'background-color', 'color');
  assert.equal(bar['background-color'], WHITE);
  assert.equal(await page.locator('.topbar-brand').count(), 0, 'the brand tile is no longer part of the top bar');

  // the chosen row and the main button
  await typeInSearch(page, 'A0001');
  await waitForResults(page, (rows) => rows.length === 1);
  const row = page.locator('#results > li.is-selected');
  await eventually(async () => (await row.count()) === 1, { message: 'the only match to be the chosen row' });
  assert.equal((await paint(row, 'border-left-color'))['border-left-color'], FOREST);
  await page.mouse.move(0, 0);
  const issue = page.locator('#issue-button');
  assert.equal(await issue.isEnabled(), true);
  const issueButton = await paint(issue, 'background-color', 'color', 'font-weight');
  assert.equal(issueButton['background-color'], FOREST);
  assert.equal(issueButton.color, WHITE);
  assert.equal(issueButton['font-weight'], '600');
  assert.deepEqual(await textOnPlainForest(page), [], 'text sits directly on plain forest green on the desk');

  // after issuing: the slip and the notice
  await issue.click();
  await waitForNotice(page, /^QR issued for Juan Dela Cruz/);
  assert.deepEqual(await textOnPlainForest(page), [], 'text sits directly on plain forest green after issuing');
});

test('theme: the sign-in has nothing above its title - no tile, no tick', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  const title = page.locator('.login-title');
  for (const pseudo of ['::before', '::after']) assert.equal((await paintPseudo(title, pseudo, 'content')).content, 'none', `${pseudo} of the title`);
  // the title is the first thing in the panel
  assert.equal(await page.locator('.login-panel').evaluate((panel) => panel.firstElementChild.className), 'login-title');
});

test('type: Segoe UI, regular and semibold only, 14 px at the desk, nothing above 24 px, no font downloaded', async (session) => {
  const { page } = session;
  await page.locator('#login-user').waitFor();

  /** Every piece of visible text and every text box: its face, weight and size. */
  const measure = () =>
    page.evaluate(() => {
      const found = [];
      const add = (el, label) => {
        const style = getComputedStyle(el);
        found.push({
          label,
          family: style.fontFamily,
          weight: style.fontWeight,
          size: Number.parseFloat(style.fontSize),
          slip: Boolean(el.closest('.slip, #print-root')),
        });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || !node.parentElement.checkVisibility()) continue;
        add(node.parentElement, node.textContent.trim().slice(0, 30));
      }
      for (const input of document.querySelectorAll('input[type="text"], input[type="password"]')) if (input.checkVisibility()) add(input, `[${input.id}]`);
      return found;
    });

  const all = [];
  all.push(...(await measure())); // sign-in
  await signedIn(page);
  all.push(...(await measure())); // the desk
  await typeInSearch(page, 'dela');
  await waitForResults(page, (rows) => rows.length === 3);
  all.push(...(await measure())); // the list
  await typeInSearch(page, 'A0001');
  await waitForResults(page, (rows) => rows.length === 1);
  await page.keyboard.press('Enter');
  await waitForNotice(page, /^QR issued for Juan Dela Cruz/);
  all.push(...(await measure())); // the notice and the slip
  await page.getByRole('button', { name: /^Review records/ }).click();
  await page.getByRole('dialog', { name: 'Review records' }).waitFor();
  all.push(...(await measure())); // the records
  assert.ok(all.length > 100, `only ${all.length} pieces of text were measured`);

  const isCode = (piece) => piece.family.startsWith('Consolas, ');
  for (const piece of all) {
    const where = `"${piece.label}" (${piece.family} ${piece.weight} ${piece.size}px)`;
    // everything is Segoe UI, except account codes (A0001, ...), which are in the fixed-width face so that 0/O and 1/l/I cannot be mixed up
    if (isCode(piece)) assert.match(piece.label, /^[A-Z0-9]+$/, `${where} is in the code face but is not an account code`);
    else assert.ok(piece.family.startsWith('"Segoe UI", '), `the face of ${where}`);
    assert.ok(piece.weight === '400' || piece.weight === '600', `the weight of ${where}`);
    assert.ok(piece.size <= 24, `${where} is large`);
    if (!piece.slip) assert.ok(piece.size >= 12, `${where} is small`); // (the slip is set in points for the printer)
  }
  assert.ok(all.some((p) => p.weight === '600') && all.some((p) => p.weight === '400'), 'both weights are in use');
  assert.ok(all.some(isCode), 'account codes were measured');

  // the base size, the title of the sign-in, and the search box
  const sizes = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontSize,
    weight: getComputedStyle(document.body).fontWeight,
    title: getComputedStyle(document.querySelector('.election-title')).fontSize,
    search: getComputedStyle(document.querySelector('#search-input')).fontSize,
  }));
  assert.deepEqual(sizes, { body: '14px', weight: '400', title: '16px', search: '14px' });

  // nothing was fetched to draw the letters: no font file, no @font-face, and no stylesheet but the page's own
  assert.deepEqual(session.seen.requests.filter((r) => /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(r.url)), [], 'a font file was requested');
  assert.equal(await page.evaluate(() => document.fonts.size), 0, 'the page declares a font of its own');
  assert.deepEqual(session.seen.csp, []);
});

test('focus: a text box in focus has one thin forest-green edge - no heavy ring, no glow - also with the pointer over it', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  const box = page.locator('#login-user');
  const look = () => paint(box, 'border-top-width', 'border-top-color', 'outline-color', 'outline-style', 'box-shadow');

  // not in focus: the grey edge
  await page.locator('#login-password').click();
  const idle = await look();
  assert.equal(idle['border-top-width'], '1px');
  assert.notEqual(idle['border-top-color'], FOREST);
  assert.equal(idle['box-shadow'], 'none');

  // in focus, and the pointer is over it (a click leaves it there): green edge, nothing else
  await box.click();
  const focused = await look();
  assert.equal(focused['border-top-width'], '1px', 'the edge got thicker');
  assert.equal(focused['border-top-color'], FOREST);
  assert.equal(focused['box-shadow'], 'none', 'a glow around the box');
  assert.equal(focused['outline-color'], CLEAR, 'a visible ring around the box');

  // the search box too
  await signedIn(page);
  const search = page.locator('#search-input');
  await search.click();
  const found = await paint(search, 'border-top-width', 'border-top-color', 'outline-color', 'box-shadow');
  assert.deepEqual(found, { 'border-top-width': '1px', 'border-top-color': FOREST, 'outline-color': CLEAR, 'box-shadow': 'none' });
});

test('focus: a high-contrast display still shows where the focus is (the outline that is invisible elsewhere)', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('#login-user').click();
  const ring = await paint(page.locator('#login-user'), 'outline-width', 'outline-style', 'outline-color');
  assert.equal(ring['outline-style'], 'solid');
  assert.equal(ring['outline-width'], '2px');
  assert.notEqual(ring['outline-color'], CLEAR, 'in forced-colours mode the focus is invisible');
});

test('focus: a button reached with the keyboard gets the ring, a mouse click does not', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  await page.locator('#login-password').click();
  await page.keyboard.press('Tab'); // Show
  await page.keyboard.press('Tab'); // Sign in
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Sign in');
  const ring = await paint(page.getByRole('button', { name: 'Sign in' }), 'outline-width', 'outline-style', 'outline-color', 'outline-offset');
  assert.deepEqual(ring, { 'outline-width': '2px', 'outline-style': 'solid', 'outline-color': FOREST, 'outline-offset': '2px' });
  const toggle = page.locator('button[aria-controls="login-password"]'); // "Show", then "Hide"
  await toggle.click();
  assert.equal((await paint(toggle, 'outline-style'))['outline-style'], 'none', 'a mouse click leaves a ring on the button');
});

test('size: text boxes are slim (32 px, 13 px type), the search box 36 px with 14 px type, rows of results about 45 px', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  const box = async (selector) => {
    const b = await page.locator(selector).boundingBox();
    const size = await paint(page.locator(selector), 'font-size');
    return { height: Math.round(b.height), fontSize: size['font-size'] };
  };
  assert.deepEqual(await box('#login-user'), { height: 32, fontSize: '13px' });
  assert.deepEqual(await box('#login-password'), { height: 32, fontSize: '13px' });
  assert.equal(Math.round((await page.getByRole('button', { name: 'Show' }).boundingBox()).height), 32, 'Show is as slim as the box beside it');

  await signedIn(page);
  assert.deepEqual(await box('#search-input'), { height: 36, fontSize: '14px' });

  await typeInSearch(page, 'dela');
  await waitForResults(page, (rows) => rows.length === 3);
  const rows = await page.locator('#results > li').evaluateAll((items) =>
    items.map((li) => ({
      height: li.getBoundingClientRect().height,
      name: getComputedStyle(li.querySelector('.result-name')).fontSize,
      nameWeight: getComputedStyle(li.querySelector('.result-name')).fontWeight,
      meta: getComputedStyle(li.querySelector('.result-meta')).fontSize,
    })),
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.height >= 40 && row.height <= 48, `a result row is ${row.height} px high`);
    assert.deepEqual({ name: row.name, nameWeight: row.nameWeight, meta: row.meta }, { name: '13px', nameWeight: '600', meta: '12px' });
  }
});
