// The look of the desk, kept by tests: forest green is literally the CSS colour "forestgreen", #228B22; small type sits on white or on
// a pale tint and never on the green (except the label of the main button, see below); the face is Segoe UI in two weights; and
// nothing is big. (The browser test tests/e2e/scenarios/90-theme.mjs measures the same on the real, rendered page, and
// tests/e2e/scenarios/80-a11y.mjs lets axe-core judge the contrast of every screen.)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ROOT } from './bundle-fixture.mjs';

const read = (name) => readFile(path.join(ROOT, name), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stylesheet = async () => stripComments(await read('css/app.css'));

/** The custom properties of :root, with var(--x) resolved. */
async function tokens() {
  const css = await stylesheet();
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

/** Every rule of the style sheet as { selectors: [...], body } (also those inside @media). */
async function rules() {
  const css = await stylesheet();
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
    body,
  }));
}

/** The declarations of every rule whose selector list names `selector`, as { property: value } (later rules win, as in a browser). */
async function declarations(selector) {
  const found = (await rules()).filter((r) => r.selectors.includes(selector));
  assert.ok(found.length > 0, `css/app.css has no rule for ${selector}`);
  const out = {};
  for (const { body } of found) for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/gi)) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}
/** A length in rem as a number ('0.375rem' -> 0.375); refuses anything else, so that a change of unit is noticed. */
const rem = (value) => {
  assert.match(value, /^[\d.]+rem$/, `not a length in rem: ${value}`);
  return Number.parseFloat(value);
};

/** [top, bottom] of a `padding` shorthand, in rem (1, 2, 3 or 4 values, as CSS reads them). */
const verticalPadding = (shorthand) => {
  const v = shorthand.trim().split(/\s+/).map(rem);
  assert.ok(v.length >= 1 && v.length <= 4, `padding: ${shorthand}`);
  return [v[0], v.length === 3 || v.length === 4 ? v[2] : v[0]];
};

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

  test('the main buttons (--forest-button) are that forest green; the focus ring is too', async () => {
    const t = await tokens();
    assert.equal(t['--forest-button'], '#228b22');
    assert.equal(t['--focus'], '#228b22');
  });

  test("the browser's own colour (address bar on a phone) and the tab icon are the same green", async () => {
    assert.match(await read('index.html'), /<meta name="theme-color" content="#228b22">/);
    const favicon = await read('favicon.svg');
    assert.match(favicon, /<rect width="32" height="32" rx="6" fill="#228b22"\/>/);
  });

  test('white on plain forest green is 4.39:1: enough for shapes (3:1), a hair under what small type needs (4.5:1)', async () => {
    const ratio = contrast('#ffffff', (await tokens())['--forest']);
    assert.ok(ratio >= 4.3 && ratio < 4.5, `white on forest is ${ratio.toFixed(2)}:1`);
  });

  test('forest green is a background only for the main button and for marks that carry no text', async () => {
    // Anything else that gets a green background would put small type on a colour it is not readable enough on. (The label of the main
    // button is the one conscious exception: the colour was asked for literally. Its hover and pressed colours are darker, 5.5:1 and 7.2:1.)
    const found = new Set();
    for (const { selectors, body } of await rules()) {
      if (/background(-color)?\s*:\s*(var\(--forest(-button)?\)|#228b22)\s*[;}]?/i.test(`${body};`)) for (const s of selectors) found.add(s);
    }
    assert.deepEqual(
      [...found].sort(),
      [
        ".login-server-state[data-state='online']::before",
        ".pill[data-kind='online'] .pill-dot",
        '.btn-primary',
        '.topbar-brand::before',
      ].sort(),
    );
  });
});

describe('details of the desk that were asked for', () => {
  test('a text box in focus: its thin edge turns forest green - no second ring, no glow, and the pointer over it changes nothing', async () => {
    const hover = await declarations("input[type='text']:hover");
    const focus = await declarations("input[type='text']:focus-visible");
    assert.equal(focus['border-color'], 'var(--forest)');
    assert.ok(!('box-shadow' in focus), 'a glow (box-shadow) around the focused box');
    assert.ok(!('border' in focus) && !('border-width' in focus), 'the edge stays as thin as it is');
    // forced-colours displays draw this outline in their own colour; everywhere else it cannot be seen
    assert.match(focus.outline, /^\d+px solid transparent$/, `outline: ${focus.outline}`);
    // the rule is as specific as the hover rule and comes after it, so it wins while the pointer is over the box
    const css = await stylesheet();
    assert.ok(css.indexOf("input[type='text']:focus-visible") > css.indexOf("input[type='text']:hover"), 'the focus rule must follow the hover rule');
    assert.equal(hover['border-color'], 'var(--ink-faint)');
    for (const selector of ["input[type='text']:focus-visible", "input[type='password']:focus-visible"]) {
      assert.ok((await rules()).some((r) => r.selectors.includes(selector)), selector);
    }
  });

  test('text boxes are slim: 32 px high with 13 px type; the search box, typed in all day, 36 px with 14 px type', async () => {
    const box = await declarations("input[type='text']");
    assert.ok(rem(box['min-height']) <= 2, `a text box is ${box['min-height']} high`);
    assert.equal(box['font-size'], 'var(--text-sm)');
    const [top, bottom] = verticalPadding(box.padding);
    assert.ok(top <= 0.25 && bottom <= 0.25, `padding: ${box.padding}`);
    const search = await declarations('.search-row .search-input');
    assert.ok(rem(search['min-height']) <= 2.25, `the search box is ${search['min-height']} high`);
    assert.equal(search['font-size'], 'var(--text-md)');
    assert.ok(rem((await declarations('.password-row .btn'))['min-height']) <= 2, 'the Show button is as slim as the box beside it');
  });

  test('the sign-in has no tile or tick above its title, and the style sheet has nothing for an address of the server', async () => {
    const css = await stylesheet();
    assert.ok(!/\.login-title\s*::?(before|after)/.test(css), 'a mark above the title of the sign-in');
    assert.ok(!css.includes('login-server-host'), 'a place for the address of the server');
  });

  test('search results are slim rows: names in 13 px, the code and branch in 12 px, 5 px above and below', async () => {
    const name = await declarations('.result-name');
    assert.equal(name['font-size'], 'var(--text-sm)');
    assert.equal(name['font-weight'], '600');
    assert.equal((await declarations('.result-meta'))['font-size'], 'var(--text-xs)');
    const row = await declarations('.result');
    const [top, bottom] = verticalPadding(row.padding);
    assert.ok(top <= 0.3125 && bottom <= 0.3125, `a row has ${row.padding} of padding`);
    // two lines of 13 and 12 px at these line heights, plus the padding and the rule below, is a row of about 45 px (it was 62)
    const lineHeights = [name['line-height'], (await declarations('.result-meta'))['line-height']].map(Number);
    assert.ok(lineHeights.every((n) => n > 0 && n <= 1.4), `line heights ${lineHeights}`);
  });
});

describe('type on the surfaces, and the other pairs that carry small type', () => {
  // [text, background, smallest acceptable ratio]. 4.5 is WCAG AA for small type; the most-read pairs are held to 7 (AAA).
  const PAIRS = [
    ['#ffffff', '--forest-hover', 4.5, 'main button when pointed at'],
    ['#ffffff', '--forest-press', 7, 'main button while pressed'],
    ['--forest-ink', '--surface', 7, 'green text on white (brand name, "More details")'],
    ['--forest-ink', '--canvas', 7, 'green text on the desk'],
    ['--forest-ink', '--forest-tint', 7, 'green text on the light green of a chosen row'],
    ['--ink', '--surface', 7, 'body text'],
    ['--ink', '--canvas', 7, 'text on the desk'],
    ['--ink', '--hover', 7, 'text in a row that is pointed at'],
    ['--ink', '--forest-tint', 7, 'text in a chosen row'],
    ['--ink', '--info-tint', 7, 'text in a note'],
    ['--ink', '--ok-tint', 7, 'text in a confirmation'],
    ['--ink', '--bad-tint', 7, 'text in a warning'],
    ['--ink', '--warn-tint', 7, 'text in a caution'],
    ['--ink', '--mark', 7, 'the part of a name that matched the search'],
    ['--ink-soft', '--surface', 7, 'secondary text'],
    ['--ink-soft', '--canvas', 7, 'secondary text on the desk'],
    ['--ink-soft', '--hover', 4.5, 'secondary text in a row that is pointed at'],
    ['--ink-soft', '--forest-tint', 4.5, 'secondary text in a chosen row'],
    ['--ink-soft', '--bad-tint', 4.5, 'secondary text of a record that needs attention'],
    ['--ink-faint', '--surface', 4.5, 'hints and the empty search box'],
    ['--ink-faint', '--canvas', 4.5, 'hints on the desk'],
    ['--ink-faint', '--forest-tint', 4.5, 'hints in a chosen row'],
    ['--ok', '--ok-tint', 4.5, 'a confirmed record, an eligible member'],
    ['--bad', '--bad-tint', 4.5, 'a rejected or failed record'],
    ['--warn', '--warn-tint', 4.5, 'a member or record that is not quite fine'],
    ['--info', '--info-tint', 4.5, 'a note'],
    ['--ok', '--surface', 4.5, 'a confirmed record on white'],
    ['--bad', '--surface', 4.5, 'an error on white'],
    ['#ffffff', '--ok', 4.5, 'the tick in the circle of an eligible member'],
    ['#ffffff', '--bad', 4.5, 'the cross in the circle, the count of records, the danger button'],
    ['#ffffff', '--warn', 4.5, 'the mark in the circle of an inactive member'],
  ];

  for (const [text, background, minimum, used] of PAIRS) {
    test(`${text} on ${background} is at least ${minimum}:1 (${used})`, async () => {
      const t = await tokens();
      const ratio = contrast(text.startsWith('--') ? t[text] : text, background.startsWith('--') ? t[background] : background);
      assert.ok(ratio >= minimum, `${text} on ${background} is only ${ratio.toFixed(2)}:1`);
    });
  }

  test('the lines that mark a control (--line-strong) reach 3:1 against white (WCAG asks that of the edge of a control)', async () => {
    assert.ok(contrast((await tokens())['--line-strong'], '#ffffff') >= 3);
  });

  test('the focus ring (forest green) shows on every ground it can fall on: 3:1 at least', async () => {
    const t = await tokens();
    for (const ground of ['--surface', '--canvas', '--hover', '--forest-tint', '--info-tint', '--ok-tint', '--bad-tint', '--warn-tint']) {
      assert.ok(contrast(t['--focus'], t[ground]) >= 3, `the ring on ${ground} is ${contrast(t['--focus'], t[ground]).toFixed(2)}:1`);
    }
  });
});

describe('type: Segoe UI, two weights, nothing big', () => {
  test('the face is Segoe UI first; the style sheet loads no font (Segoe UI is the visitor\'s own, it cannot be bundled)', async () => {
    const t = await tokens();
    assert.match(t['--font'], /^'segoe ui', /, `--font is ${t['--font']}`);
    assert.match(await stylesheet(), /body\s*\{[^}]*font-family:\s*var\(--font\)/);
    assert.ok(!/@font-face/i.test(await stylesheet()), 'a downloadable font has crept in');
    assert.ok(!/url\(/i.test(await stylesheet()), 'the style sheet fetches nothing at all');
  });

  test('account codes alone are in a fixed-width face (Consolas first), and it is one token', async () => {
    const t = await tokens();
    assert.match(t['--font-code'], /^consolas, /);
    const css = await stylesheet();
    for (const selector of ['.detail-code', '.result-code', '.recent-code', '.slip-code']) assert.ok(css.includes(selector), selector);
    // (the lookahead also refuses whitespace, or the pattern could back up into the space after the colon and pass anything)
    assert.ok(!/font-family:\s*(?!\s|var\(--font(-code)?\))/i.test(css.replace(/--font(-code)?:[^;]+;/g, '')), 'a font is named outside the two tokens');
  });

  test('only two weights: regular (400) and semibold (600); the browser\'s own bold is turned down too', async () => {
    const css = await stylesheet();
    const weights = [...css.matchAll(/font-weight\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    assert.ok(weights.length > 20, `only ${weights.length} weights are set`);
    for (const w of weights) assert.ok(w === '400' || w === '600', `font-weight: ${w}`);
    assert.ok(weights.includes('600') && weights.includes('400'));
    for (const m of css.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)) assert.equal(m[1].trim(), 'inherit', `font: ${m[1]} (the shorthand would set a weight)`);
    assert.match(css, /h1,\s*h2,\s*h3,\s*strong,\s*b,\s*th,\s*summary\s*\{\s*font-weight:\s*600;/, 'headings, strong, th and summary would be bold (700) by default');
  });

  test('the base is 14 px (at the browser\'s own size), the search box 16 px, nothing on screen is above 24 px', async () => {
    const t = await tokens();
    const rem = (name) => {
      assert.match(t[name], /^[\d.]+rem$/, `${name} = ${t[name]}`);
      return Number.parseFloat(t[name]);
    };
    assert.equal(rem('--text-md'), 0.875, 'the base type');
    assert.equal(rem('--text-lg'), 1);
    assert.ok(rem('--text-2xl') <= 1.5, 'the largest type (the title of the sign-in)');
    for (const name of Object.keys(t).filter((n) => n.startsWith('--text-'))) assert.ok(rem(name) <= 1.5, `${name} is ${t[name]}`);
    const css = await stylesheet();
    assert.match(css, /html\s*\{[^}]*font-size:\s*100%/, 'the page follows the size the person set in the browser');
    assert.match(css, /body\s*\{[^}]*font-size:\s*var\(--text-md\)/);
    for (const m of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      const tokenOk = /^var\(--text-(xs|sm|md|lg|xl|2xl)\)$/.test(value);
      const printed = /^(\d+(\.\d+)?)pt$/.exec(value); // the slip is sized in points for the printer: 13 pt at most
      assert.ok(tokenOk || value === '100%' || value === 'inherit' || (printed && Number(printed[1]) <= 13), `font-size: ${value}`);
    }
  });
});
