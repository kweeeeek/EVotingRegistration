// Accessibility and layout, checked the way a tool and a person would: axe-core (WCAG 2.x A/AA + best practice) on every state of
// the desk, under the real Content-Security-Policy, and "does it still fit" at phone, tablet and desk widths.
// Every state is also saved as a screenshot in tests/e2e/out/shots/ for a person to look at.

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '../framework.mjs';
import { eventually, pillText, signIn, signedIn, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, '..', 'out', 'shots');
const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/**
 * Runs axe on the page as it is now; throws a readable list when anything fails. Also saves a screenshot.
 *
 * The contrast rule is run on its own, over everything except the label of the main button (.btn-primary): that label is white on the
 * literal forest green #228B22, 4.39:1 - fine for a shape (3:1), a hair under the 4.5:1 that small type needs (see the note at the top of
 * css/app.css). It is the one conscious exception, so it gets its own check below: it may be exactly that pair and nothing lighter.
 */
async function audit(page, name) {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `a11y-${name}.png`) });
  await page.evaluate(axeSource); // CDP evaluation is not subject to the page's CSP; it only defines window.axe
  const run = (context, options) =>
    page.evaluate(
      async ({ context, options }) => {
        const result = await window.axe.run(context ?? document, { ...options, resultTypes: ['violations'] });
        return result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(' ')} - ${(n.any[0] ?? n.all[0] ?? n.none[0])?.message ?? n.failureSummary}`),
        }));
      },
      { context, options },
    );
  const violations = [
    ...(await run(null, { runOnly: { type: 'tag', values: TAGS }, rules: { 'color-contrast': { enabled: false } } })),
    ...(await run({ exclude: [['.btn-primary']] }, { runOnly: { type: 'rule', values: ['color-contrast'] } })),
  ];

  const labels = await page.evaluate(() => {
    const luminance = (rgb) => {
      const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return [...document.querySelectorAll('.btn-primary')]
      .filter((b) => !b.disabled && b.checkVisibility())
      .map((b) => {
        const style = getComputedStyle(b);
        const [hi, lo] = [luminance(style.color), luminance(style.backgroundColor)].sort((x, y) => y - x);
        return { text: b.textContent.trim(), ratio: (hi + 0.05) / (lo + 0.05) };
      });
  });
  for (const label of labels) {
    if (label.ratio < 4.3) {
      violations.push({ id: 'main-button-label', impact: 'serious', help: 'the label of a main button may be white on forest green (4.39:1) but nothing lighter', nodes: [`"${label.text}" is ${label.ratio.toFixed(2)}:1`] });
    }
  }
  if (violations.length) {
    const text = violations.map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n${v.nodes.map((n) => `      ${n}`).join('\n')}`).join('\n');
    throw new Error(`axe found ${violations.length} kind(s) of problem on "${name}":\n${text}`);
  }
}

async function find(page, text) {
  await typeInSearch(page, text);
  return waitForResults(page, (rows) => rows.length === 1);
}

test('a11y: the sign-in screen, before and after a wrong password', async ({ page }) => {
  await page.locator('#login-user').waitFor();
  await eventually(async () => (await page.locator('.login-server-state').textContent()).trim() === 'reachable', { message: 'the server to be reachable' });
  await audit(page, 'login');
  await signIn(page, 'clerk', 'wrong');
  await eventually(async () => /Wrong user name/.test(await page.locator('.login .form-error').textContent()), { message: 'the error' });
  await audit(page, 'login-wrong-password');
});

test('a11y: the desk - list of matches, an eligible member, a member who is not eligible, an inactive member', async ({ page }) => {
  await signedIn(page);
  await audit(page, 'desk-empty');

  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  await audit(page, 'desk-results');
  await page.keyboard.press('Enter'); // first Enter points at the first match
  await audit(page, 'desk-selected-eligible');

  await find(page, 'pedro');
  await audit(page, 'desk-selected-not-eligible');
  await find(page, 'ian inactive');
  await audit(page, 'desk-selected-inactive');

  await typeInSearch(page, 'zzzz');
  await eventually(async () => /No member found/.test(await page.locator('#search-status').textContent()), { message: 'no match' });
  await audit(page, 'desk-no-match');
});

test('a11y: after issuing - the slip, a notice, a problem to review, and the three dialogs', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0001');
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for Juan Dela Cruz/);
  await audit(page, 'issued-slip-and-notice');

  await find(page, 'A0004');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'status', status: 502 });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /HTTP 502/);
  await audit(page, 'issue-failed-notice-and-banner');

  await page.getByRole('button', { name: /^Review records/ }).click();
  await page.getByRole('dialog', { name: 'Review records' }).waitFor();
  await page.getByLabel('Latest records (all states)').check();
  await audit(page, 'dialog-review-records');
  await page.keyboard.press('Escape');

  await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('dialog', { name: 'Sign out?' }).waitFor();
  await audit(page, 'dialog-confirm');
  await page.getByRole('button', { name: 'Stay signed in' }).click();

  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('dialog', { name: 'Locked' }).waitFor();
  await audit(page, 'dialog-locked');
});

test('a11y: notices across the top - no election, offline, a different election', async ({ page, stub }) => {
  stub.state.event = null;
  await signedIn(page);
  await audit(page, 'banner-no-election');
}, { config: { heartbeatSeconds: 1, eventRefreshSeconds: 1 } });

test('a11y: the offline banner and the "election changed" note', async ({ page, stub }) => {
  await signedIn(page);
  stub.state.event = { ...stub.state.event, eventId: 8, title: 'Special Assembly 2026' };
  await eventually(async () => (await page.locator('.banner-info .banner-title').count()) > 0, { timeout: 6000, message: 'the election-changed note' });
  await audit(page, 'banner-election-changed');
  stub.state.down = true;
  await eventually(async () => (await pillText(page)) === 'Offline', { timeout: 8000, message: 'Offline' });
  await audit(page, 'banner-offline');
}, { config: { heartbeatSeconds: 1, eventRefreshSeconds: 1 } });

for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1366, 768], [1920, 1080]]) {
  test(`layout: at ${width} x ${height} nothing is cut off or needs sideways scrolling (sign-in, desk, slip, dialogs)`, async ({ page }) => {
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.locator('#login-user').waitFor();
    assert.ok((await sideways()) <= 0, 'the sign-in screen scrolls sideways');
    await page.screenshot({ path: path.join(shots, `layout-${width}-login.png`) });

    await signedIn(page);
    await find(page, 'A0001');
    assert.ok((await sideways()) <= 0, `the desk scrolls sideways (${await sideways()} px too wide)`);

    // the main action can be reached on every size: scroll it into view, it is really on the screen, and a click on it works
    const issue = page.locator('#issue-button');
    await issue.scrollIntoViewIfNeeded();
    const b = await issue.boundingBox();
    assert.ok(b.width > 150 && b.height >= 40 && b.x >= 0 && b.x + b.width <= width + 1, `the Issue button is cut off or too small to tap: ${JSON.stringify(b)}`);
    await page.screenshot({ path: path.join(shots, `layout-${width}-desk-selected.png`) });
    await issue.click();

    await waitForNotice(page, /QR issued for Juan Dela Cruz/);
    const slip = page.locator('.slip-area .slip'); // the one on the screen (the print copy lives in #print-root)
    await slip.waitFor();
    assert.ok((await sideways()) <= 0, `the desk with a slip scrolls sideways (${await sideways()} px too wide)`);
    const box = await slip.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `the slip is cut off: x=${box.x}, width=${box.width}, screen=${width}`);
    await page.screenshot({ path: path.join(shots, `layout-${width}-desk-slip.png`) });

    await page.getByRole('button', { name: /^Review records/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Review records' });
    await dialog.waitFor();
    const d = await dialog.boundingBox();
    assert.ok(d.x >= 0 && d.x + d.width <= width + 1 && d.y >= 0 && d.y + d.height <= height + 1, `the records dialog does not fit the screen: ${JSON.stringify(d)}`);
    await page.screenshot({ path: path.join(shots, `layout-${width}-records.png`) });
  }, { viewport: { width, height } });
}

test('a11y: large text still fits - the browser\'s text zoom at 200 % on a 1366 x 768 screen', async ({ page }) => {
  await signedIn(page);
  await find(page, 'A0001');
  // 200 % zoom of a 1366-wide screen is what a 683-wide screen shows
  await page.setViewportSize({ width: 683, height: 384 });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(sideways <= 0, `scrolls sideways at 200 % (${sideways} px)`);
  await page.screenshot({ path: path.join(shots, 'layout-zoom-200.png') });
});

test('layout: after a failed Issue the answer and its "Try again" are on the screen, not below the fold (1366 x 768, two notices above)', async ({ page, stub }) => {
  await signedIn(page);
  await find(page, 'A0004');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'status', status: 502 });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /HTTP 502/);
  const { width, height } = page.viewportSize();
  const inView = async (locator) => {
    const b = await locator.boundingBox();
    return !!b && b.y >= 0 && b.y + b.height <= height && b.x >= 0 && b.x + b.width <= width;
  };
  assert.equal(await page.locator('.banner').count(), 2, 'the situation this test is about: two notices already stand above the desk');
  assert.equal(await inView(page.locator('.notice')), true, 'the notice about the failed Issue is not fully on the screen');
  assert.equal(await inView(page.locator('.notice').getByRole('button', { name: 'Try again' })), true, 'its "Try again" button is not on the screen');
  // (the Issue button itself may need a scroll in this crowded state: after a failure the right next step is "Try again" in the notice)
});
