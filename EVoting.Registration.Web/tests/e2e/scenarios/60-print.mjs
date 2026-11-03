// What comes out of the printer. Chromium prints the page to PDF with the page's own print styles (the same code path as
// "Print" in Chrome and Edge); the PDF is then read back the way a person and a scanner would read the paper:
//   * its text (pdftotext)            - is ONLY the slip on it, or did the desk leak onto the paper?
//   * its picture (pdftoppm, 300 dpi) - is anything coloured, is anything cut off, and does the QR on the PAPER still read?
// Not tested here (and not testable without the printer): the receipt printer's driver and its real paper.
// Needs poppler-utils (pdfinfo, pdftotext, pdftoppm). Without them the tests say so and stop, they do not pretend.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from '../framework.mjs';
import { eventually, signedIn, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const which = process.platform === 'win32' ? 'where' : 'which';
const have = (cmd) => {
  try {
    execFileSync(which, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const POPPLER = have('pdfinfo') && have('pdftotext') && have('pdftoppm');

const DPI = 300;
const mm = (px) => (px / DPI) * 25.4;
/** A QR for a 5-character code is 21 modules inside 4 + 4 modules of quiet zone, drawn 50 mm wide. */
const EXPECTED_QR_BODY_MM = (50 / 29) * 21;

async function find(page, text) {
  await typeInSearch(page, text);
  return waitForResults(page, (rows) => rows.length === 1);
}

async function issue(page, text) {
  await find(page, text);
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for/);
}

/** The page clears the slip from the print area after every print (afterprint): print again so there is a slip on the paper. */
async function printAgain(page) {
  await page.getByRole('button', { name: 'Print again' }).click();
  await page.locator('#print-root .slip').waitFor({ state: 'attached' });
}

async function paper(page, name, pdfOptions) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evoting-print-'));
  try {
    const file = path.join(dir, `${name}.pdf`);
    await writeFile(file, await page.pdf(pdfOptions));
    const info = execFileSync('pdfinfo', [file]).toString();
    const pages = Number(/Pages:\s+(\d+)/.exec(info)[1]);
    const [, w, h] = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    const text = execFileSync('pdftotext', ['-layout', file, '-']).toString('utf8');
    execFileSync('pdftoppm', ['-r', String(DPI), '-png', '-f', '1', '-l', '1', '-singlefile', file, path.join(dir, name)]);
    const png = PNG.sync.read(await readFile(path.join(dir, `${name}.png`)));

    let minX = png.width;
    let maxX = -1;
    let minY = png.height;
    let maxY = -1;
    let coloured = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
        if (r < 160 || g < 160 || b < 160) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        if (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24) coloured++;
      }
    }
    const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    return {
      pages,
      widthMm: (Number(w) / 72) * 25.4,
      heightMm: (Number(h) / 72) * 25.4,
      text,
      flat: text.replace(/\s+/g, ''),
      coloured,
      blank: maxX < 0,
      ink: maxX < 0 ? null : { left: mm(minX), right: mm(maxX), top: mm(minY), bottom: mm(maxY) },
      qr: qr ? { text: qr.data, bodyMm: mm(qr.location.topRightCorner.x - qr.location.topLeftCorner.x) } : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs a poppler test, or says plainly that it could not. */
function printTest(name, fn, options) {
  test(
    name,
    async (session, lab) => {
      if (!POPPLER) {
        console.log('         (not run: poppler-utils - pdfinfo, pdftotext, pdftoppm - is not installed on this computer)');
        return;
      }
      await fn(session, lab);
    },
    options,
  );
}

printTest('print: only the slip is on the paper - nothing of the desk, nothing coloured - and the QR on the paper reads as the account code', async ({ page }) => {
  await signedIn(page);
  await issue(page, 'A0001');
  assert.equal((await page.evaluate(() => window.__prints.length)), 1, 'one print was asked for');

  const p = await paper(page, 'slip', { preferCSSPageSize: true });
  assert.equal(p.pages, 1, 'the slip fits one page');
  for (const line of ['E-VOTING VOTER REGISTRATION', 'Juan Dela Cruz', 'A0001', 'Main Branch', 'Eligible to vote', 'SCAN THIS QR CODE', 'Keep this slip']) {
    assert.ok(p.flat.includes(line.replace(/\s+/g, '')), `the paper does not say "${line}":\n${p.text}`);
  }
  for (const chrome of ['Find a member', 'Issue QR', 'Sign out', 'Signed in as', 'Review records', 'Refresh', 'Online', 'Recently issued']) {
    assert.ok(!p.flat.includes(chrome.replace(/\s+/g, '')), `the desk leaked onto the paper ("${chrome}")`);
  }
  assert.equal(p.coloured, 0, 'the paper has colour on it - the green of the desk must not print');
  assert.ok(p.qr, 'the QR on the paper could not be read');
  assert.equal(p.qr.text, 'A0001', 'the QR on the paper says something else than the account code');
  assert.ok(Math.abs(p.qr.bodyMm - EXPECTED_QR_BODY_MM) < 1.2, `the QR is ${p.qr.bodyMm.toFixed(1)} mm wide on paper, expected ${EXPECTED_QR_BODY_MM.toFixed(1)}`);
  assert.ok(p.ink.left >= 3 && p.ink.right <= 80.5, `the slip is wider than 80 mm or touches the edge: ${p.ink.left.toFixed(1)}..${p.ink.right.toFixed(1)} mm`);
}, { reducedMotion: false });

printTest('print: on 80, 72 and 58 mm paper the whole slip fits, nothing is cut, and the QR is NOT shrunk (a smaller QR scans worse)', async ({ page }) => {
  await signedIn(page);
  await issue(page, 'A0001');
  const results = {};
  for (const width of [80, 72, 58]) {
    await printAgain(page);
    const p = await paper(page, `roll-${width}`, { width: `${width}mm`, height: '260mm', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    results[width] = p;
    assert.equal(p.pages, 1, `${width} mm paper: more than one page`);
    assert.ok(Math.abs(p.widthMm - width) < 0.5, `the test paper is ${p.widthMm.toFixed(1)} mm wide, not ${width}`);
    assert.ok(p.ink.left >= 1.5 && p.ink.right <= width - 1.5, `${width} mm paper: ink at ${p.ink.left.toFixed(1)}..${p.ink.right.toFixed(1)} mm - cut off or touching the edge`);
    assert.ok(p.ink.bottom < 255, `${width} mm paper: the slip runs off the page`);
    assert.ok(p.qr, `${width} mm paper: the QR could not be read`);
    assert.equal(p.qr.text, 'A0001');
    assert.ok(Math.abs(p.qr.bodyMm - EXPECTED_QR_BODY_MM) < 1.2, `${width} mm paper: the QR was shrunk to ${p.qr.bodyMm.toFixed(1)} mm (expected ${EXPECTED_QR_BODY_MM.toFixed(1)})`);
    assert.equal(p.coloured, 0);
  }
  console.log(`         (slip height on paper: ${Object.entries(results).map(([w, r]) => `${w} mm paper ${r.ink.bottom.toFixed(0)} mm`).join(', ')})`);
});

printTest('print: a very long name wraps instead of being cut, and the QR holds the trimmed, upper-case account code', async ({ page, stub }) => {
  const longName = 'Maria Concepcion de los Santos-Villanueva y Fernandez de la Cruz III';
  stub.state.members.push({ ...stub.state.members[0], memberId: 9001, accountCode: ' ab-12/3 ', memberName: longName, branchId: 1 });
  await signedIn(page);
  await issue(page, 'Villanueva');
  await printAgain(page);
  const p = await paper(page, 'long', { width: '80mm', height: '260mm', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  assert.equal(p.pages, 1);
  assert.ok(p.flat.includes(longName.replace(/\s+/g, '')), `the whole name must be on the paper:\n${p.text}`);
  assert.ok(p.ink.left >= 1.5 && p.ink.right <= 78.5, `cut off or touching the edge: ${p.ink.left.toFixed(1)}..${p.ink.right.toFixed(1)} mm`);
  assert.ok(p.qr, 'the QR could not be read');
  assert.equal(p.qr.text, 'AB-12/3', 'the kiosk reads the trimmed, upper-case code');
});

printTest('print: a name with accents is printed as written (Peña)', async ({ page }) => {
  await signedIn(page);
  await issue(page, 'A0004');
  await printAgain(page);
  const p = await paper(page, 'accents', { preferCSSPageSize: true });
  assert.ok(p.text.includes('Josefa Peña'), `the accent was lost:\n${p.text}`);
});

printTest('print: a reprint says REPRINT on the paper', async ({ page }) => {
  await signedIn(page);
  await issue(page, 'A0001');
  await page.locator('.recent-item').first().getByRole('button', { name: /Reprint/ }).click();
  await page.locator('#print-root .slip-reprint').waitFor({ state: 'attached' });
  const p = await paper(page, 'reprint', { preferCSSPageSize: true });
  assert.ok(p.flat.includes('REPRINT'), `no REPRINT on the paper:\n${p.text}`);
  assert.equal(p.qr?.text, 'A0001');
});

printTest('print: pressing Ctrl+P on the desk (no slip) prints a blank page, never the list of members', async ({ page }) => {
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (rows) => rows.length === 3);
  await page.getByRole('button', { name: 'Review records' }).waitFor();
  const p = await paper(page, 'desk', { preferCSSPageSize: true });
  assert.equal(p.text.trim(), '', `something of the desk reached the paper:\n${p.text}`);
  assert.equal(p.blank, true);
});

test('print: after a print, and when the screen is locked, the slip (a member\'s name) is removed from the print area', async ({ page }) => {
  await signedIn(page);
  await issue(page, 'A0001');
  assert.equal(await page.locator('#print-root .slip').count(), 1, 'the slip waits in the print area while the print dialog is open');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await eventually(async () => (await page.locator('#print-root .slip').count()) === 0, { message: 'the print area to be emptied after printing' });

  await printAgain(page);
  assert.equal(await page.locator('#print-root .slip').count(), 1);
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('dialog', { name: 'Locked' }).waitFor();
  assert.equal(await page.locator('#print-root .slip').count(), 0, 'a locked screen leaves no member name in the print area');
  assert.equal((await page.locator('#print-root').textContent()).trim(), '');
});
