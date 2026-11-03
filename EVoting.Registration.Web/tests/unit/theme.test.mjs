// The colour of the desk is forest green - literally: the CSS colour "forestgreen", #228B22. These checks keep it that way and keep
// the type readable on it. (The browser test tests/e2e/scenarios/90-theme.mjs measures the same on the real, rendered page, and
// tests/e2e/scenarios/80-a11y.mjs lets axe-core judge the contrast of every screen.)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ROOT } from './bundle-fixture.mjs';

const read = (name) => readFile(path.join(ROOT, name), 'utf8');

/** The custom properties of :root, with var(--x) resolved. */
async function tokens() {
  const css = (await read('css/app.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(root, 'css/app.css has no :root block');
  const raw = new Map([...root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(([, name, value]) => [name, value.trim()]));
  const resolve = (value, depth = 0) => {
    assert.ok(depth < 5, `token loop at ${value}`);
    const reference = /^var\((--[a-z0-9-]+)\)$/i.exec(value);
    return reference ? resolve(raw.get(reference[1]), depth + 1) : value.toLowerCase();
  };
  return Object.fromEntries([...raw].map(([name, value]) => [name, resolve(value)]));
}

const rgb = (hex) => {
  assert.match(hex, /^#[0-9a-f]{6}$/, `not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** WCAG 2 contrast ratio between two #rrggbb colours. */
const contrast = (a, b) => {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('forest green', () => {
  test('--forest is the CSS colour "forestgreen" itself: #228B22 = rgb(34, 139, 34)', async () => {
    const t = await tokens();
    assert.equal(t['--forest'], '#228b22');
    assert.deepEqual(rgb(t['--forest']), [34, 139, 34]);
  });

  test('the main colour of the desk (--brand) is that forest green', async () => {
    assert.equal((await tokens())['--brand'], '#228b22');
  });

  test('the browser\'s own colour (address bar on a phone) and the tab icon are the same green', async () => {
    assert.match(await read('index.html'), /<meta name="theme-color" content="#228b22">/);
    const favicon = await read('favicon.svg');
    assert.match(favicon, /<rect width="32" height="32" rx="6" fill="#228b22"\/>/);
  });

  test('white on plain forest green is 4.39:1: enough for big bold type and for shapes (3:1), not for small type', async () => {
    const ratio = contrast('#ffffff', (await tokens())['--forest']);
    assert.ok(ratio >= 4.3 && ratio < 4.5, `white on forest is ${ratio.toFixed(2)}:1`);
  });
});

describe('type on the greens, and the other pairs that carry small type', () => {
  // [text, background, smallest acceptable ratio]. 4.5 is WCAG AA for small type; the most-read pairs are held to 7 (AAA).
  const PAIRS = [
    ['#ffffff', '--forest-inset', 7, 'brand tag, venue and dates, who is signed in, connection, top bar buttons'],
    ['#ffffff', '--forest-inset-hover', 7, 'top bar buttons when pointed at'],
    ['#ffffff', '--forest-dark', 4.5, 'small buttons and hover of the main buttons'],
    ['--forest-dark', '--panel', 4.5, 'links and headings in green on white'],
    ['--forest-dark', '--forest-tint', 4.5, 'green text on the light green of a chosen row'],
    ['--ink', '--panel', 7, 'body text'],
    ['--ink', '--desk', 7, 'text on the desk'],
    ['--ink', '--forest-tint', 7, 'text in a chosen row'],
    ['--ink-soft', '--panel', 7, 'secondary text'],
    ['--ink-soft', '--desk', 4.5, 'secondary text on the desk'],
    ['--ink-faint', '--panel', 4.5, 'hints'],
    ['--ink-faint', '--desk', 4.5, 'hints on the desk'],
    ['--ink-faint', '--forest-tint', 4.5, 'hints in a chosen row'],
    ['--ok', '--ok-tint', 4.5, 'a confirmed record'],
    ['--bad', '--bad-tint', 4.5, 'a rejected or failed record'],
    ['--warn', '--warn-tint', 4.5, 'a record that was not confirmed'],
    ['#ffffff', '--info-bar', 4.5, 'the grey note bar'],
    ['--ink', '--info-tint', 7, 'text in a note'],
    ['--ink', '--mark', 7, 'the part of a name that matched the search'],
  ];

  for (const [text, background, minimum, used] of PAIRS) {
    test(`${text} on ${background} is at least ${minimum}:1 (${used})`, async () => {
      const t = await tokens();
      const ratio = contrast(text.startsWith('--') ? t[text] : text, background.startsWith('--') ? t[background] : background);
      assert.ok(ratio >= minimum, `${text} on ${background} is only ${ratio.toFixed(2)}:1`);
    });
  }

  test('the lines that mark a control (--rule-strong) reach 3:1 against white (WCAG asks that of the edge of a control)', async () => {
    assert.ok(contrast((await tokens())['--rule-strong'], '#ffffff') >= 3);
  });

  test('the focus ring shows everywhere: dark on white, on the desk and on tinted rows, white on the green bar', async () => {
    const t = await tokens();
    for (const ground of ['--panel', '--desk', '--forest-tint', '--info-tint']) assert.ok(contrast(t['--ink'], t[ground]) >= 3, `dark ring on ${ground}`);
    assert.ok(contrast('#ffffff', t['--forest']) >= 3, 'white ring on the green bar');
    assert.ok(contrast(t['--focus'], t['--ink']) >= 3, 'the amber half against the dark half');
    const css = (await read('css/app.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.topbar :focus-visible\s*\{\s*outline-color:\s*#ffffff;?\s*\}/, 'the ring on the top bar is white');
  });
});
