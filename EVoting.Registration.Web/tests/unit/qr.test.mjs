// The voting QR. The strongest check there is: draw the QR the way the page's SVG draws it, then read the picture with an
// independent QR reader (jsQR). If the reader says the account code, a kiosk scanner will too.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ECC_LEVEL, QUIET_ZONE_MODULES, createQrMatrix, createQrSvg, pickMode, svgPathData } from '../../js/qr.js';
import { readQrFromPath, rectsOf } from './helpers.mjs';

/** What an independent reader sees when it looks at this payload's QR as the page draws it. */
function scan(payload, options) {
  const matrix = createQrMatrix(payload);
  const margin = options?.margin ?? QUIET_ZONE_MODULES;
  return { matrix, found: readQrFromPath(svgPathData(matrix, margin), matrix.size + 2 * margin, options?.scale) };
}

/** A tiny stand-in for `document` that is enough for createQrSvg. */
function fakeDocument() {
  const make = (tag) => ({
    tag,
    attrs: {},
    children: [],
    dataset: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  return { createElementNS: (ns, tag) => Object.assign(make(tag), { ns }) };
}

describe('which QR mode is used', () => {
  test('digits only: numeric; capitals, digits and - . / space $ % * + :: alphanumeric; anything else: bytes', () => {
    assert.equal(pickMode('0123456789'), 'Numeric');
    assert.equal(pickMode('A0001'), 'Alphanumeric');
    assert.equal(pickMode('AB-12/3'), 'Alphanumeric');
    assert.equal(pickMode('A B$%*+-./:'), 'Alphanumeric');
    assert.equal(pickMode('a0001'), 'Byte');
    assert.equal(pickMode('Ñ1'), 'Byte');
    assert.equal(pickMode('A_1'), 'Byte');
  });

  test('the densest mode is really used: the size is the smallest that holds the text', () => {
    // capacities at error-correction level M: version 1 holds 34 digits, 20 capitals+digits, 14 bytes; version 2 holds 63, 38, 26
    assert.equal(createQrMatrix('1'.repeat(34)).version, 1);
    assert.equal(createQrMatrix('1'.repeat(35)).version, 2);
    assert.equal(createQrMatrix('A'.repeat(20)).version, 1);
    assert.equal(createQrMatrix('A'.repeat(21)).version, 2);
    assert.equal(createQrMatrix('a'.repeat(14)).version, 1);
    assert.equal(createQrMatrix('a'.repeat(15)).version, 2);
  });
});

describe('the matrix', () => {
  test('a typical account code is the smallest QR there is: 21 x 21 modules (version 1)', () => {
    const m = createQrMatrix('A0001');
    assert.equal(m.size, 21);
    assert.equal(m.version, 1);
    assert.equal(m.modules.length, 21 * 21);
    assert.equal(m.payload, 'A0001');
    assert.equal(m.mode, 'Alphanumeric');
  });

  test('the same text always gives the same picture; different text gives a different one', () => {
    assert.deepEqual(createQrMatrix('A0001').modules, createQrMatrix('A0001').modules);
    assert.notDeepEqual(createQrMatrix('A0001').modules, createQrMatrix('A0002').modules);
  });

  test('isDark agrees with the module list', () => {
    const m = createQrMatrix('A0001');
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) assert.equal(m.isDark(r, c), m.modules[r * m.size + c] === 1);
  });

  test('has the three corner squares every reader looks for', () => {
    const m = createQrMatrix('A0001');
    const finder = (r0, c0) => {
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          const edge = i === 0 || i === 6 || j === 0 || j === 6;
          const centre = i >= 2 && i <= 4 && j >= 2 && j <= 4;
          assert.equal(m.isDark(r0 + i, c0 + j), edge || centre, `module ${r0 + i},${c0 + j}`);
        }
      }
    };
    finder(0, 0);
    finder(0, m.size - 7);
    finder(m.size - 7, 0);
  });

  test('nothing to encode, or too much, is an error - never a blank QR', () => {
    for (const bad of ['', null, undefined, 42, {}, []]) assert.throws(() => createQrMatrix(bad), /nothing to encode/, String(bad));
    assert.throws(() => createQrMatrix('A'.repeat(5000)));
  });
});

describe('error correction level M (what the Windows station prints)', () => {
  test('the page asks for level M', () => {
    assert.equal(ECC_LEVEL, 'M');
  });

  /** The 15 format-information bits as ISO/IEC 18004 places them around the top-left corner, and the second copy. */
  function formatBits(m) {
    const n = m.size;
    const bit = (r, c) => (m.isDark(r, c) ? 1 : 0);
    const first = { 14: bit(8, 0), 13: bit(8, 1), 12: bit(8, 2), 11: bit(8, 3), 10: bit(8, 4), 9: bit(8, 5), 8: bit(8, 7), 7: bit(8, 8), 6: bit(7, 8), 5: bit(5, 8), 4: bit(4, 8), 3: bit(3, 8), 2: bit(2, 8), 1: bit(1, 8), 0: bit(0, 8) };
    const second = {};
    for (let i = 0; i < 8; i++) second[i] = bit(8, n - 1 - i);
    for (let i = 8; i < 15; i++) second[i] = bit(n - 15 + i, 8);
    const toNumber = (bits) => Object.entries(bits).reduce((sum, [i, b]) => sum | (b << Number(i)), 0);
    return { first: toNumber(first), second: toNumber(second) };
  }

  /** The 15-bit BCH(15,5) code word for 5 data bits, before the mask 101010000010010 is applied. */
  function bch(data5) {
    let rest = data5 << 10;
    for (let i = 14; i >= 10; i--) if (rest & (1 << i)) rest ^= 0x537 << (i - 10);
    return (data5 << 10) | rest;
  }

  for (const code of ['A0001', 'B7K4Q', '123456', 'ACCT-0042-X', 'A'.repeat(40)]) {
    test(`"${code.length > 12 ? `${code.slice(0, 6)}...` : code}" says level M in both copies of its format information`, () => {
      const m = createQrMatrix(code);
      const { first, second } = formatBits(m);
      assert.equal(first, second, 'the two copies of the format information differ');
      const unmasked = first ^ 0x5412;
      const data5 = unmasked >> 10;
      assert.equal(bch(data5), unmasked, 'the format information is damaged (error check fails)');
      const level = data5 >> 3; // L = 01, M = 00, Q = 11, H = 10
      assert.equal(level, 0b00, `error-correction level bits are ${level.toString(2).padStart(2, '0')}, not M (00)`);
    });
  }
});

describe('the picture (the SVG path) really contains the account code', () => {
  test('an independent reader reads "A0001" from it', () => {
    const { found, matrix } = scan('A0001');
    assert.ok(found, 'the reader found no QR');
    assert.equal(found.data, 'A0001');
    assert.equal(found.version, matrix.version);
  });

  test('every kind of text: digits, capitals, the allowed symbols, a long code', () => {
    for (const payload of ['0123456789', 'AB-12/3', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:', 'ACCT-000123-BRANCH-07-LONG-CODE', '9'.repeat(60)]) {
      const { found } = scan(payload);
      assert.ok(found, `no QR found for ${payload}`);
      assert.equal(found.data, payload);
    }
  });

  test('letters outside Latin-1 survive (UTF-8): the library\'s default would have corrupted them', () => {
    for (const payload of ['ŁÓDŹ-1', 'Ñ1', 'a€b', 'カナ']) {
      const { found } = scan(payload);
      assert.ok(found, `no QR found for ${payload}`);
      assert.equal(found.data, payload);
    }
  });

  test('lower case and other byte-mode text read back too (the page upper-cases before this, the QR does not care)', () => {
    for (const payload of ['a0001', 'user_1']) assert.equal(scan(payload).found?.data, payload);
  });

  test('200 account codes of every shape, all read back exactly', () => {
    let seed = 20261103;
    const next = (n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const DIGITS = '0123456789';
    for (let i = 0; i < 200; i++) {
      const length = 3 + next(18);
      const alphabet = [DIGITS, ALPHA + DIGITS, ALPHA + DIGITS + '-/.'][next(3)];
      let payload = '';
      for (let k = 0; k < length; k++) payload += alphabet[next(alphabet.length)];
      const { found } = scan(payload);
      assert.ok(found, `no QR found for ${payload}`);
      assert.equal(found.data, payload, `read "${found.data}" from the QR of "${payload}"`);
    }
  });

  test('the quiet border is 4 modules wide, as the QR standard asks, and the picture reads with it', () => {
    const matrix = createQrMatrix('A0001');
    assert.equal(QUIET_ZONE_MODULES, 4);
    assert.equal(readQrFromPath(svgPathData(matrix, 4), matrix.size + 8)?.data, 'A0001');
  });
});

describe('the SVG path', () => {
  const fake = { size: 3, isDark: (r, c) => [[1, 1, 0], [0, 1, 1], [1, 0, 1]][r][c] === 1 };

  test('one rectangle per run of dark modules, moved in by the quiet zone', () => {
    assert.equal(svgPathData(fake, 4), 'M4 4h2v1h-2zM5 5h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z');
    assert.equal(svgPathData(fake, 0), 'M0 0h2v1h-2zM1 1h2v1h-2zM0 2h1v1h-1zM2 2h1v1h-1z');
    assert.equal(svgPathData({ size: 2, isDark: () => false }, 4), '');
  });

  test('painting the rectangles gives back exactly the matrix, with nothing outside it', () => {
    const matrix = createQrMatrix('ACCT-0042-X');
    const margin = QUIET_ZONE_MODULES;
    const total = matrix.size + 2 * margin;
    const grid = Array.from({ length: total }, () => Array(total).fill(0));
    for (const { x, y, w } of rectsOf(svgPathData(matrix, margin))) for (let i = 0; i < w; i++) grid[y][x + i] += 1;
    for (let r = 0; r < total; r++) {
      for (let c = 0; c < total; c++) {
        const inside = r >= margin && r < margin + matrix.size && c >= margin && c < margin + matrix.size;
        const expected = inside && matrix.isDark(r - margin, c - margin) ? 1 : 0;
        assert.equal(grid[r][c], expected, `module ${r},${c} (a module drawn twice or not at all)`);
      }
    }
  });
});

describe('the SVG element', () => {
  test('white background, black modules, quiet zone included, crisp edges, labelled for screen readers', () => {
    const doc = fakeDocument();
    const svg = createQrSvg(doc, 'A0001', { label: 'QR code for account A0001' });
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.attrs.viewBox, '0 0 29 29', '21 modules + 4 + 4 of quiet zone');
    assert.equal(svg.attrs.xmlns, 'http://www.w3.org/2000/svg');
    assert.equal(svg.attrs['shape-rendering'], 'crispEdges');
    assert.equal(svg.attrs.role, 'img');
    assert.equal(svg.attrs['aria-label'], 'QR code for account A0001');
    assert.equal(svg.attrs.class, 'qr');
    assert.equal(svg.dataset.modules, '21');
    const [background, path] = svg.children;
    assert.deepEqual([background.tag, background.attrs.fill, background.attrs.width, background.attrs.height], ['rect', '#ffffff', '29', '29']);
    assert.deepEqual([path.tag, path.attrs.fill], ['path', '#000000']);
    assert.equal(path.attrs.d, svgPathData(createQrMatrix('A0001')));
    assert.equal(svg.attrs.width, undefined, 'no fixed size: it scales to what the page gives it');
  });

  test('a default label, and a bigger code makes a bigger viewBox', () => {
    const doc = fakeDocument();
    assert.equal(createQrSvg(doc, 'A0001').attrs['aria-label'], 'QR code');
    assert.equal(createQrSvg(doc, 'A'.repeat(21)).attrs.viewBox, '0 0 33 33');
    assert.equal(createQrSvg(doc, 'A0001', { margin: 0 }).attrs.viewBox, '0 0 21 21');
  });

  test('the path that is drawn is read back as the account code', () => {
    const svg = createQrSvg(fakeDocument(), 'B7K4Q');
    assert.equal(readQrFromPath(svg.children[1].attrs.d, 29)?.data, 'B7K4Q');
  });

  test('an empty payload makes no slip with a blank QR', () => {
    assert.throws(() => createQrSvg(fakeDocument(), ''), /nothing to encode/);
  });
});
