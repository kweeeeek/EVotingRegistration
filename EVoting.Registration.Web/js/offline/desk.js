// The offline desk: what this PC keeps so that a Registration desk keeps working at a venue with no signal.
//
//   * Only a user who signed in ONLINE on this PC and then pressed "Prepare for offline" (or imported a USB package) can sign in
//     offline, with the same password. The password is the key: the member list is encrypted with a key derived from it
//     (PBKDF2-SHA256 -> AES-256-GCM, see crypto.js), so nobody without the password can read the list from the PC.
//   * A preparation is valid for OFFLINE_VALID_DAYS (3) days; after that it is refused and must be done again online.
//   * The outbox holds the QR issuances made offline: ids and times only (no names), sent with POST qr-issued-bulk once the desk
//     is online and signed in again. It is kept until the server has it, even if the preparation expires.
//
// Storage goes through a small backend ({ get, put, delete, all } per store) - IndexedDB in the page (idb.js), a Map in the tests.

import { PBKDF2_ITERATIONS, deriveKey, fromBase64, openJson, randomBytes, sealJson, toBase64 } from './crypto.js';

export const OFFLINE_VALID_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export const Stores = Object.freeze({ Users: 'users', Outbox: 'outbox' });

export const UnlockFailure = Object.freeze({
  NotPrepared: 'notPrepared',
  Expired: 'expired',
  WrongPassword: 'wrongPassword',
});

/** The key a user is filed under: user names are not case-sensitive at sign-in. */
export const userKey = (username) => String(username ?? '').trim().toLowerCase();

const verifierAad = (key) => `evoting-registration-offline|verifier|${key}`;
const dataAad = (key, record) => `evoting-registration-offline|data|${key}|${record.dataAt}|${record.eventId}|${record.memberCount}`;

export function createOfflineDesk({ backend, now = () => Date.now(), validDays = OFFLINE_VALID_DAYS, iterations = PBKDF2_ITERATIONS, cryptoOptions } = {}) {
  const validMs = validDays * DAY_MS;
  const derive = (password, salt) => deriveKey(password, salt, { iterations, ...cryptoOptions });

  async function readRecord(username) {
    const key = userKey(username);
    if (!key) return null;
    return (await backend.get(Stores.Users, key)) ?? null;
  }

  function expiryOf(record) {
    const ends = [record.credentialAt + validMs];
    if (record.data) ends.push(record.dataAt + validMs);
    return Math.min(...ends);
  }

  return {
    validDays,

    /**
     * After an ONLINE sign-in: the key for this user's offline data, made from the password just typed. Nothing is written yet.
     * When the stored data was made with another password (changed since), a fresh key is made and the old data is replaced on the
     * next preparation.
     */
    async startSession(username, password, displayName = '') {
      const key = userKey(username);
      const record = await readRecord(username);
      if (record) {
        try {
          const k = await derive(password, fromBase64(record.salt));
          await openJson(k, record.verifier, verifierAad(key), cryptoOptions);
          return { key, username: String(username).trim(), displayName, cryptoKey: k, salt: record.salt, fresh: false };
        } catch {
          /* another password than the one the data was made with: start afresh below */
        }
      }
      const salt = toBase64(randomBytes(16, cryptoOptions));
      return { key, username: String(username).trim(), displayName, cryptoKey: await derive(password, fromBase64(salt)), salt, fresh: true };
    },

    /**
     * Stores (or replaces) this user's offline data: the election and its member list, encrypted. Also renews the offline sign-in.
     * event and members are kept exactly as the server publishes them (events/current, registration/members/roster).
     */
    async prepare(session, { event, members, source, exportId = null }) {
      const at = now();
      const record = {
        key: session.key,
        username: session.username,
        displayName: session.displayName,
        salt: session.salt,
        iterations,
        credentialAt: at,
        verifier: await sealJson(session.cryptoKey, { ok: true, username: session.username }, verifierAad(session.key), cryptoOptions),
        dataAt: at,
        source,
        exportId,
        eventId: Number(event?.eventId) || 0,
        eventTitle: String(event?.title ?? ''),
        memberCount: Array.isArray(members) ? members.length : 0,
        data: null,
      };
      record.data = await sealJson(session.cryptoKey, { event, members }, dataAad(session.key, record), cryptoOptions);
      await backend.put(Stores.Users, record);
      session.fresh = false;
      return this.describe(record);
    },

    /** What the sign-in screen and the top bar may show about this user's offline data (no member data). Null when there is none. */
    describe(record) {
      if (!record) return null;
      const expiresAt = expiryOf(record);
      return {
        username: record.username,
        displayName: record.displayName,
        eventId: record.eventId,
        eventTitle: record.eventTitle,
        memberCount: record.memberCount,
        source: record.source,
        preparedAt: record.dataAt,
        expiresAt,
        expired: now() >= expiresAt,
      };
    },

    async status(username) {
      return this.describe(await readRecord(username));
    },

    /**
     * Offline sign-in. { ok: true, session, event, members, info } or { ok: false, reason }.
     * The password is checked by decrypting: a wrong password cannot open the data, and nothing else is stored to compare it with.
     */
    async unlock(username, password) {
      const record = await readRecord(username);
      if (!record || !record.data) return { ok: false, reason: UnlockFailure.NotPrepared };
      if (now() >= expiryOf(record)) return { ok: false, reason: UnlockFailure.Expired, info: this.describe(record) };
      let cryptoKey;
      try {
        cryptoKey = await derive(password, fromBase64(record.salt));
        await openJson(cryptoKey, record.verifier, verifierAad(record.key), cryptoOptions);
      } catch {
        return { ok: false, reason: UnlockFailure.WrongPassword };
      }
      const { event, members } = await openJson(cryptoKey, record.data, dataAad(record.key, record), cryptoOptions);
      const session = { key: record.key, username: record.username, displayName: record.displayName, cryptoKey, salt: record.salt, fresh: false };
      return { ok: true, session, event, members, info: this.describe(record) };
    },

    /** Removes this user's offline data (not the outbox: issuances the server has not got yet are never thrown away). */
    async forget(username) {
      const key = userKey(username);
      if (key) await backend.delete(Stores.Users, key);
    },

    // ── outbox ──────────────────────────────────────────────────────────────────────────────────

    /** One QR issued while offline. Ids, desk and times only. */
    async queue({ id, username, memberId, eventId, deskNo = null, issuedAtUtc }) {
      const desk = Number.isInteger(deskNo) && deskNo > 0 ? deskNo : null;
      await backend.put(Stores.Outbox, { id: String(id), user: userKey(username), memberId: Number(memberId), eventId: Number(eventId), deskNo: desk, issuedAtUtc: String(issuedAtUtc), queuedAt: now() });
    },

    /** Issuances not yet received by the server, oldest first (all users of this PC when no user is given). */
    async pending(username) {
      const all = (await backend.all(Stores.Outbox)) ?? [];
      const u = username == null ? null : userKey(username);
      return all.filter((r) => u === null || r.user === u).sort((a, b) => a.queuedAt - b.queuedAt);
    },

    async markSent(ids) {
      for (const id of ids) await backend.delete(Stores.Outbox, String(id));
    },
  };
}

/** A backend kept in memory (tests, and a page where IndexedDB is not available). */
export function createMemoryBackend() {
  const stores = new Map([[Stores.Users, new Map()], [Stores.Outbox, new Map()]]);
  const keyOf = (store, value) => (store === Stores.Users ? value.key : value.id);
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(store, key) {
      return clone(stores.get(store).get(key));
    },
    async put(store, value) {
      stores.get(store).set(keyOf(store, value), clone(value));
    },
    async delete(store, key) {
      stores.get(store).delete(key);
    },
    async all(store) {
      return [...stores.get(store).values()].map(clone);
    },
  };
}
