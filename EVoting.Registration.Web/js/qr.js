// The voting QR. Its content is ONLY the member's account code (trimmed, upper case) - exactly what the Windows station
// prints and what the kiosk's scanner reads (QrCodeGenerator.cs: ECC level M, quiet zone drawn, black on white).
//
// The picture is built as an SVG out of DOM nodes (never from a string), so nothing here needs innerHTML.

import qrcode from '../vendor/qrcode.js';

export const ECC_LEVEL = 'M';
export const QUIET_ZONE_MODULES = 4;

// The vendored library's default byte encoder keeps only the low 8 bits of every character, which would corrupt anything
// outside Latin-1. Account codes are digits/letters, for which this is identical; for anything else UTF-8 is the safe choice.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;

/**
 * The densest mode that can hold the payload - what the Windows station's QR library (QRCoder) does as well:
 * digits only -> Numeric, capitals/digits/space/$%*+-./: -> Alphanumeric, anything else -> Byte.
 * (The scanned text is the same in every mode; a denser mode just gives bigger, easier-to-scan squares.)
 */
export function pickMode(payload) {
  if (/^[0-9]+$/.test(payload)) return 'Numeric';
  if (ALPHANUMERIC.test(payload)) return 'Alphanumeric';
  return 'Byte';
}

/** The QR as a square of dark/light modules (no quiet zone). Throws when the payload is empty or too long for any QR version. */
export function createQrMatrix(payload) {
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('There is nothing to encode in the QR code.');

  const mode = pickMode(payload);
  const qr = qrcode(0, ECC_LEVEL); // version 0 = the smallest that fits
  qr.addData(payload, mode);
  qr.make();

  const size = qr.getModuleCount();
  const modules = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) modules[r * size + c] = qr.isDark(r, c) ? 1 : 0;
  }
  return {
    payload,
    mode,
    size,
    version: (size - 17) / 4,
    modules,
    isDark: (row, col) => modules[row * size + col] === 1,
  };
}

/** SVG path data for the dark modules: one rectangle per horizontal run, offset by the quiet zone. */
export function svgPathData(matrix, margin = QUIET_ZONE_MODULES) {
  const { size } = matrix;
  const parts = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!matrix.isDark(r, c)) {
        c++;
        continue;
      }
      let end = c;
      while (end < size && matrix.isDark(r, end)) end++;
      const len = end - c;
      parts.push(`M${c + margin} ${r + margin}h${len}v1h-${len}z`);
      c = end;
    }
  }
  return parts.join('');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The QR as an <svg> element: white background, black modules, quiet zone included, crisp edges at any size.
 * The element scales to its container (CSS sets its width); it has no fixed pixel size.
 */
export function createQrSvg(doc, payload, { margin = QUIET_ZONE_MODULES, label = 'QR code' } = {}) {
  const matrix = createQrMatrix(payload);
  const total = matrix.size + 2 * margin;

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('class', 'qr');
  svg.dataset.modules = String(matrix.size);

  const background = doc.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(total));
  background.setAttribute('height', String(total));
  background.setAttribute('fill', '#ffffff');
  svg.appendChild(background);

  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', svgPathData(matrix, margin));
  path.setAttribute('fill', '#000000');
  svg.appendChild(path);

  return svg;
}
