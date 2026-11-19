// Offline mode (venue with no signal): js/offline/*, sw.js, js/ui/offline-ui.js.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { deriveKey, openJson, randomBytes, sealJson } from '../../js/offline/crypto.js';
import { OFFLINE_VALID_DAYS, UnlockFailure, createMemoryBackend, createOfflineDesk } from '../../js/offline/desk.js';
import { createOfflineApi, flushOutbox } from '../../js/offline/local-api.js';
import { PackageError, describePackage, normalizePassphrase, openPackage } from '../../js/offline/package.js';
import { describeOffline } from '../../js/ui/offline-ui.js';
import { ROOT } from './bundle-fixture.mjs';

const DAY = 24 * 60 * 60 * 1000;
const FAST = 1000; // PBKDF2 rounds in these tests (the page uses 310 000)

const event = {
  eventId: 77,
  title: 'Test General Assembly',
  venue: 'Test Hall',
  scheduleFrom: '2026-12-03T08:00:00',
  scheduleTo: '2026-12-03T17:00:00',
  status: 'Opened',
  branches: [{ branchId: 5, branchName: 'Test Branch' }, { branchId: 6, branchName: 'Other' }],
};
const m = (id, name, branchId = 5, extra = {}) => ({ memberId: id, accountCode: `00500000${String(id).padStart(2, '0')}`, memberName: name, branchId, branch: 'Test Branch', isEligibleToVote: true, isActive: true, ...extra });
const members = [m(1, 'DELA CRUZ, JUAN'), m(2, 'SANTOS, MARÍA'), m(3, 'Reyes, Ana', 6), m(4, 'ABAD, PEDRO', 9), m(5, 'Cruz, Inactive', 5, { isActive: false })];

function clock(start = Date.UTC(2026, 11, 3, 1, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}
const newDesk = (c = clock()) => ({ c, desk: createOfflineDesk({ backend: createMemoryBackend(), now: c.now, iterations: FAST }) });

describe('crypto: AES-GCM with a key from a password', () => {
  test('what is sealed opens with the same key and the same label', async () => {
    const key = await deriveKey('pass', randomBytes(16), { iterations: FAST });
    const sealed = await sealJson(key, { a: 1, name: 'Ñandú' }, 'label');
    assert.deepEqual(await openJson(key, sealed, 'label'), { a: 1, name: 'Ñandú' });
  });
  test('another password, another label or a changed byte cannot open it', async () => {
    const salt = randomBytes(16);
    const key = await deriveKey('pass', salt, { iterations: FAST });
    const sealed = await sealJson(key, { a: 1 }, 'label');
    await assert.rejects(openJson(await deriveKey('other', salt, { iterations: FAST }), sealed, 'label'));
    await assert.rejects(openJson(key, sealed, 'other label'));
    const bad = { ...sealed, data: sealed.data.slice(0, 5) + (sealed.data[5] === 'A' ? 'B' : 'A') + sealed.data.slice(6) };
    await assert.rejects(openJson(key, bad, 'label'));
  });
});

describe('the offline desk: prepare online, sign in offline with the same password', () => {
  test('prepared data opens with the password; the stored record holds no readable member data', async () => {
    const backend = createMemoryBackend();
    const c = clock();
    const desk = createOfflineDesk({ backend, now: c.now, iterations: FAST });
    const s = await desk.startSession('Desk1', 'secret-pw', 'Desk One');
    const info = await desk.prepare(s, { event, members, source: 'online' });
    assert.equal(info.memberCount, members.length);
    assert.equal(info.eventTitle, event.title);
    assert.equal(info.expiresAt, c.now() + OFFLINE_VALID_DAYS * DAY);

    const stored = JSON.stringify(await backend.all('users'));
    for (const x of members) {
      assert.ok(!stored.includes(x.memberName), 'a name is readable on the PC');
      assert.ok(!stored.includes(x.accountCode), 'an account code is readable on the PC');
    }
    const u = await desk.unlock('desk1', 'secret-pw'); // user names are not case-sensitive
    assert.equal(u.ok, true);
    assert.deepEqual(u.members, members);
    assert.deepEqual(u.event, event);
    assert.equal(u.session.displayName, 'Desk One');
  });

  test('a wrong password, an unknown user and an expired preparation are refused', async () => {
    const { c, desk } = newDesk();
    const s = await desk.startSession('desk1', 'secret-pw');
    await desk.prepare(s, { event, members, source: 'online' });
    assert.equal((await desk.unlock('desk1', 'wrong')).reason, UnlockFailure.WrongPassword);
    assert.equal((await desk.unlock('nobody', 'secret-pw')).reason, UnlockFailure.NotPrepared);
    c.advance(OFFLINE_VALID_DAYS * DAY - 1);
    assert.equal((await desk.unlock('desk1', 'secret-pw')).ok, true, 'still valid just before 3 days');
    c.advance(2);
    const late = await desk.unlock('desk1', 'secret-pw');
    assert.equal(late.reason, UnlockFailure.Expired);
    assert.equal(late.info.expired, true);
  });

  test('a user who only signed in (never prepared) cannot sign in offline', async () => {
    const { desk } = newDesk();
    await desk.startSession('desk1', 'secret-pw');
    assert.equal((await desk.unlock('desk1', 'secret-pw')).reason, UnlockFailure.NotPrepared);
  });

  test('a changed password starts afresh: the old data no longer opens, preparing again replaces it', async () => {
    const { desk } = newDesk();
    await desk.prepare(await desk.startSession('desk1', 'old-pw'), { event, members, source: 'online' });
    const s2 = await desk.startSession('desk1', 'new-pw');
    assert.equal(s2.fresh, true);
    assert.equal((await desk.unlock('desk1', 'new-pw')).reason, UnlockFailure.WrongPassword);
    await desk.prepare(s2, { event, members: members.slice(0, 2), source: 'online' });
    const u = await desk.unlock('desk1', 'new-pw');
    assert.equal(u.ok, true);
    assert.equal(u.members.length, 2);
    assert.equal((await desk.unlock('desk1', 'old-pw')).ok, false);
  });

  test('the outbox keeps ids, desk and times only, per user, oldest first, until the server has them', async () => {
    const { c, desk } = newDesk();
    await desk.queue({ id: 'a', username: 'Desk1', memberId: 1, eventId: 77, deskNo: 4, issuedAtUtc: '2026-12-03T01:00:00.000Z' });
    c.advance(1000);
    await desk.queue({ id: 'b', username: 'desk2', memberId: 2, eventId: 77, issuedAtUtc: '2026-12-03T01:00:01.000Z' });
    assert.deepEqual((await desk.pending()).map((x) => x.id), ['a', 'b']);
    assert.deepEqual((await desk.pending('DESK1')).map((x) => x.id), ['a']);
    assert.deepEqual(Object.keys((await desk.pending())[0]).sort(), ['deskNo', 'eventId', 'id', 'issuedAtUtc', 'memberId', 'queuedAt', 'user']);
    assert.equal((await desk.pending())[0].deskNo, 4);
    assert.equal((await desk.pending())[1].deskNo, null, 'no desk given: null');
    await desk.markSent(['a']);
    assert.deepEqual((await desk.pending()).map((x) => x.id), ['b']);
    await desk.forget('desk2');
    assert.equal((await desk.pending()).length, 1, 'forgetting a user never throws away what the server has not got');
  });
});

describe('the Registration package (.evreg) made by EVoting.Api', () => {
  const fixture = () => readFile(path.join(ROOT, 'tests/unit/fixtures/sample.evreg'), 'utf8');

  test('opens with the passphrase, typed with or without dashes, in any case (file made by the API\'s own C# code)', async () => {
    const text = await fixture();
    const d = describePackage(text);
    assert.equal(d.eventTitle, 'Test General Assembly');
    assert.equal(d.memberCount, 2);
    const p = await openPackage(text, 'test pass phra se23 4567 89ab');
    assert.equal(p.event.eventId, 77);
    assert.deepEqual(p.members.map((x) => x.memberName), ['DELA CRUZ, JUAN', 'SANTOS, MARÍA']);
    assert.equal(p.members[1].votingRemarks, 'Share capital below the minimum');
    assert.equal(normalizePassphrase('ab-cd ef'), 'ABCDEF');
  });

  test('a wrong passphrase, a changed label, a changed byte or another kind of file is refused', async () => {
    const text = await fixture();
    await assert.rejects(openPackage(text, 'WRON-GPAS-SPHR-ASE2-3456-789A'), PackageError);
    const h = JSON.parse(text);
    await assert.rejects(openPackage(JSON.stringify({ ...h, memberCount: 3 }), 'TEST-PASS-PHRA-SE23-4567-89AB'), PackageError);
    await assert.rejects(openPackage(JSON.stringify({ ...h, eventId: 78 }), 'TEST-PASS-PHRA-SE23-4567-89AB'), PackageError);
    const d = h.data;
    await assert.rejects(openPackage(JSON.stringify({ ...h, data: d.slice(0, 40) + (d[40] === 'A' ? 'B' : 'A') + d.slice(41) }), 'TEST-PASS-PHRA-SE23-4567-89AB'), PackageError);
    assert.throws(() => describePackage('{"format":"EVOTING-KIOSK-PACKAGE","version":1}'), PackageError);
    assert.throws(() => describePackage('not json'), PackageError);
  });
});

describe('working offline: the same answers as the server, from the prepared list', () => {
  const at = (iso) => () => new Date(iso).getTime();

  test('search follows the server: active members of the given branches, name or code, accents ignored, ordered by name', async () => {
    const desk = newDesk().desk;
    const api = createOfflineApi({ event, members, desk, username: 'desk1', now: at('2026-12-03T10:00:00') });
    const names = async (q, b = [5, 6]) => (await api.searchMembers(q, b)).members.map((x) => x.memberName);
    assert.deepEqual(await names('maria'), ['SANTOS, MARÍA']);
    assert.deepEqual(await names('cruz'), ['DELA CRUZ, JUAN'], 'inactive members are not listed');
    assert.deepEqual(await names('PEDRO'), [], 'branch 9 is not in the election');
    assert.deepEqual(await names('00500000'), ['DELA CRUZ, JUAN', 'Reyes, Ana', 'SANTOS, MARÍA']);
    assert.deepEqual(await names('a'), [], 'at least two characters');
    assert.deepEqual(await names('ana', [5]), [], 'only the branches asked for');
  });

  test('at most 200 rows, like the server', async () => {
    const many = Array.from({ length: 450 }, (_, i) => m(i + 1, `MEMBER ${String(i).padStart(3, '0')}`));
    const api = createOfflineApi({ event, members: many, desk: newDesk().desk, username: 'u', now: at('2026-12-03T10:00:00') });
    assert.equal((await api.searchMembers('member', [5])).members.length, 200);
  });

  test('the election is open only while the PC clock is inside its schedule', async () => {
    const desk = newDesk().desk;
    const ask = async (iso) => (await createOfflineApi({ event, members, desk, username: 'u', now: at(iso) }).getCurrentEvent()).event?.eventId ?? null;
    assert.equal(await ask('2026-12-03T07:59:59'), null);
    assert.equal(await ask('2026-12-03T08:00:00'), 77);
    assert.equal(await ask('2026-12-03T16:59:59'), 77);
    assert.equal(await ask('2026-12-03T17:00:00'), null);
  });

  test('issuing queues the issuance with the PC time, marks the member as issued, and is sent later in one call', async () => {
    const desk = newDesk().desk;
    const api = createOfflineApi({ event, members, desk, username: 'desk1', getDeskNo: () => 6, now: at('2026-12-03T10:00:00'), newId: (() => { let i = 0; return () => `r${++i}`; })() });
    const r = await api.markQrIssued(1);
    assert.equal(r.ok, true);
    assert.equal(r.offline, true);
    assert.equal(r.qrIssuedAt, new Date('2026-12-03T10:00:00').toISOString());
    assert.equal((await api.searchMembers('juan', [5])).members[0].qrIssuedAt, r.qrIssuedAt);
    assert.equal((await api.markQrIssued(999)).ok, false, 'a member not in the list cannot be issued');
    await api.markQrIssued(2);

    const calls = [];
    const server = { markQrIssuedBulk: async (items) => (calls.push(items), { ok: true, succeededMemberIds: [1], failedMemberIds: [2] }) };
    const sent = await flushOutbox({ desk, api: server });
    // each slip goes with its election, the desk chosen at sign-in and the user who issued it
    assert.deepEqual(calls[0], [
      { memberId: 1, issuedAtUtc: r.qrIssuedAt, eventId: 77, deskNo: 6, issuedBy: 'desk1' },
      { memberId: 2, issuedAtUtc: new Date('2026-12-03T10:00:00').toISOString(), eventId: 77, deskNo: 6, issuedBy: 'desk1' },
    ]);
    assert.equal(api.memberById(1).memberName, members[0].memberName ?? api.memberById(1).memberName);
    assert.equal(sent.sent, 1);
    assert.deepEqual(sent.unknown, [2]);
    assert.equal((await desk.pending()).length, 0, 'answered either way: nothing left to send');
  });

  test('when the catch-up call fails nothing is lost', async () => {
    const desk = newDesk().desk;
    const api = createOfflineApi({ event, members, desk, username: 'u', now: at('2026-12-03T10:00:00') });
    await api.markQrIssued(1);
    const r = await flushOutbox({ desk, api: { markQrIssuedBulk: async () => ({ ok: false, failure: { message: 'no answer' } }) } });
    assert.equal(r.ok, false);
    assert.equal((await desk.pending()).length, 1);
  });
});

describe('the offline strip says what the desk can do', () => {
  const info = { eventTitle: 'GA', memberCount: 12, preparedAt: Date.UTC(2026, 11, 2), expiresAt: Date.UTC(2026, 11, 5), expired: false };
  test('offline, ready, not ready, expired', () => {
    assert.match(describeOffline({ offlineSession: true, info, waiting: 2, canPrepare: false, online: false }).detail, /2 QR issuances wait/);
    assert.equal(describeOffline({ offlineSession: true, info, waiting: 0 }).title, 'OFFLINE MODE');
    assert.equal(describeOffline({ offlineSession: false, info, waiting: 0, online: true }).kind, 'ready');
    assert.match(describeOffline({ offlineSession: false, info: null, waiting: 0, canPrepare: true, online: true }).detail, /Prepare for offline/);
    assert.match(describeOffline({ offlineSession: false, info: { ...info, expired: true }, waiting: 0, online: true }).detail, /expired/);
  });
});

describe('the service worker keeps every file of the page, and only those', () => {
  test('PAGE_FILES lists exactly the page files in the folder', async () => {
    const source = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
    const listed = new Set([...source.matchAll(/'\.\/([^']+)'/g)].map((x) => x[1]));
    const want = new Set(['index.html', 'config.js', 'favicon.svg']);
    const walk = async (dir) => {
      for (const e of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) await walk(rel);
        else if (/\.(js|css)$/.test(e.name)) want.add(rel);
      }
    };
    for (const d of ['js', 'css', 'vendor']) await walk(d);
    assert.deepEqual([...want].filter((f) => !listed.has(f)), [], 'files missing from sw.js PAGE_FILES');
    assert.deepEqual([...listed].filter((f) => f !== 'sw.js' && !want.has(f)), [], 'sw.js lists files that do not exist');
  });

  test('the service worker never handles the API (another origin) and never caches a request that is not a page file', async () => {
    const source = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
    assert.match(source, /if \(url\.origin !== scope\.origin\) return;/);
    assert.match(source, /if \(!isPage\) return;/);
    assert.match(source, /if \(req\.method !== 'GET'\) return;/);
  });
});
