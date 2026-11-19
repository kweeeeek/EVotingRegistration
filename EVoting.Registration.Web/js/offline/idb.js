// IndexedDB storage for the offline desk (desk.js). This is the ONLY file of the page allowed to use indexedDB
// (tools/lint.mjs ALLOWED_IN). It stores exactly what desk.js hands it: the encrypted offline data per user and the outbox of
// QR issuances (ids and times). Nothing readable about a member is written here.

import { Stores } from './desk.js';

const DB_NAME = 'evoting-registration-offline';
const DB_VERSION = 1;

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('The browser storage refused the request.'));
  });
}

/**
 * True when this browser already holds the offline database. Asking does not create it: a desk that never used offline mode keeps
 * nothing in the browser. When the browser cannot tell (no indexedDB.databases()), the answer is true and opening decides.
 */
export async function idbExists(factory = globalThis.indexedDB) {
  if (!factory) return false;
  if (typeof factory.databases !== 'function') return true;
  try {
    return (await factory.databases()).some((d) => d.name === DB_NAME);
  } catch {
    return true;
  }
}

/** Opens (and on first use creates) the database. Rejects when the browser has no IndexedDB (private window, blocked storage). */
export async function openIdbBackend(factory = globalThis.indexedDB) {
  if (!factory) throw new Error('This browser cannot keep offline data (IndexedDB is not available - is this a private window?).');
  const open = factory.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(Stores.Users)) db.createObjectStore(Stores.Users, { keyPath: 'key' });
    if (!db.objectStoreNames.contains(Stores.Outbox)) db.createObjectStore(Stores.Outbox, { keyPath: 'id' });
  };
  const db = await request(open);

  const run = (store, mode, fn) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      request(fn(os)).then((r) => (result = r), reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('The browser storage refused the change.'));
      tx.onabort = () => reject(tx.error ?? new Error('The browser storage gave up the change (disk full?).'));
    });

  return {
    get: (store, key) => run(store, 'readonly', (os) => os.get(key)),
    put: (store, value) => run(store, 'readwrite', (os) => os.put(value)),
    delete: (store, key) => run(store, 'readwrite', (os) => os.delete(key)),
    all: (store) => run(store, 'readonly', (os) => os.getAll()),
  };
}
