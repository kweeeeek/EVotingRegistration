// Encryption for the offline desk, with the browser's own WebCrypto (nothing is downloaded).
//
//   key  = PBKDF2-SHA256(secret, salt, iterations) -> AES-256-GCM key that cannot be exported from the page
//   data = AES-256-GCM(key, iv, JSON, additional data)   - additional data binds the readable labels to the encrypted part,
//                                                          so a changed label makes the whole record unreadable
//
// The same construction (PBKDF2-SHA256 + AES-256-GCM, ciphertext || 16-byte tag) is what EVoting.Api writes into a
// Registration package (Security/RegistrationPackageFile.cs), so a package made by the server opens here.

export const PBKDF2_ITERATIONS = 310000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The page's WebCrypto; tests pass their own (Node has the same API). */
function subtleOf(options) {
  const s = options?.subtle ?? globalThis.crypto?.subtle;
  if (!s) throw new Error('This browser cannot encrypt (WebCrypto is missing). Use a current Chrome or Edge.');
  return s;
}

export function randomBytes(n, options) {
  const c = options?.crypto ?? globalThis.crypto;
  return c.getRandomValues(new Uint8Array(n));
}

export function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function fromBase64(text) {
  const bin = atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** AES-256-GCM key from a password or passphrase. */
export async function deriveKey(secret, salt, { iterations = PBKDF2_ITERATIONS, ...options } = {}) {
  const subtle = subtleOf(options);
  const base = await subtle.importKey('raw', enc.encode(String(secret)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** { iv, data } (base64) of JSON.stringify(value). */
export async function sealJson(key, value, additionalData, options) {
  const subtle = subtleOf(options);
  const iv = randomBytes(12, options);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(additionalData)), tagLength: 128 }, key, enc.encode(JSON.stringify(value)));
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

/** The value sealed by sealJson, or throws when the key is wrong or anything was changed. */
export async function openJson(key, sealed, additionalData, options) {
  const subtle = subtleOf(options);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: enc.encode(String(additionalData)), tagLength: 128 },
    key,
    fromBase64(sealed.data),
  );
  return JSON.parse(dec.decode(plain));
}
