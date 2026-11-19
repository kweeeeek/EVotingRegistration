// Opens a Registration package (.evreg) made in the Admin app (Results > Kiosk USB Package > "Make Registration package"):
// the member list of a General Assembly election and the election itself, for a desk prepared while that election is not open yet.
//
// The file is protected with the one-time passphrase the Admin app showed: PBKDF2-SHA256 -> AES-256-GCM, the readable header bound
// as additional data. SAME FORMAT as EVoting.Api/Security/RegistrationPackageFile.cs - change both together.

import { deriveKey, fromBase64 } from './crypto.js';

export const PACKAGE_FORMAT = 'EVOTING-REGISTRATION-PACKAGE';
export const PACKAGE_VERSION = 1;

export class PackageError extends Error {}

/** The passphrase as it was made: letters and digits only, upper case (dashes and spaces may be typed or left out). */
export const normalizePassphrase = (text) => String(text ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();

function header(text) {
  let h;
  try {
    h = JSON.parse(String(text));
  } catch {
    throw new PackageError('This is not a Registration package (the file is not readable).');
  }
  if (!h || typeof h !== 'object' || h.format !== PACKAGE_FORMAT) throw new PackageError('This is not a Registration package (.evreg).');
  if (h.version !== PACKAGE_VERSION) throw new PackageError(`This Registration package has format version ${h.version}; this page reads version ${PACKAGE_VERSION}. Update the page or the Admin app.`);
  for (const f of ['eventId', 'memberCount', 'iterations']) if (!Number.isInteger(h[f])) throw new PackageError('The Registration package is damaged.');
  for (const f of ['exportId', 'createdAtUtc', 'salt', 'nonce', 'data']) if (typeof h[f] !== 'string' || !h[f]) throw new PackageError('The Registration package is damaged.');
  if (h.kdf !== 'PBKDF2-SHA256') throw new PackageError('The Registration package uses an unknown protection.');
  return h;
}

/** What the file says about itself, before the passphrase is typed (nothing about members). */
export function describePackage(text) {
  const h = header(text);
  return { eventId: h.eventId, eventTitle: typeof h.eventTitle === 'string' ? h.eventTitle : '', memberCount: h.memberCount, createdAtUtc: h.createdAtUtc, exportId: h.exportId };
}

/**
 * Decrypts the package. { event, members, exportId, createdAtUtc } with event and members exactly as the server publishes them
 * (events/current and registration/members/roster). Throws PackageError with a message for the desk.
 */
export async function openPackage(text, passphrase, options) {
  const h = header(text);
  const pass = normalizePassphrase(passphrase);
  if (pass.length < 8) throw new PackageError('Type the passphrase that the Admin app showed for this package.');

  const aad = [PACKAGE_FORMAT, PACKAGE_VERSION, h.eventId, h.exportId, h.createdAtUtc, h.memberCount, h.iterations, h.salt].join('|');
  const subtle = options?.subtle ?? globalThis.crypto.subtle;
  let plain;
  try {
    const key = await deriveKey(pass, fromBase64(h.salt), { iterations: h.iterations, ...options });
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(h.nonce), additionalData: new TextEncoder().encode(aad), tagLength: 128 }, key, fromBase64(h.data));
  } catch {
    throw new PackageError('The passphrase is wrong, or the file was changed or damaged. Nothing was imported.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new PackageError('The Registration package is damaged.');
  }
  const members = Array.isArray(payload?.members) ? payload.members : null;
  const event = payload?.event && typeof payload.event === 'object' ? payload.event : null;
  if (!event || !members || members.length !== h.memberCount || Number(event.eventId) !== h.eventId) throw new PackageError('The Registration package is damaged (its contents do not match its label).');
  if (event.eventType && event.eventType !== 'GENERAL_ASSEMBLY') throw new PackageError('This package is not for a General Assembly election.');
  return { event, members, exportId: h.exportId, createdAtUtc: h.createdAtUtc };
}
