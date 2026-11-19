// QR slips per election and per registration desk: what is sent to the server, how the desk's list is read, and its words.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DESK_ISSUANCES_PATH, ROSTER_PATH, SEARCH_PATH, createApi, qrIssuedPath } from '../../js/api.js';
import { createRecords, RecordState } from '../../js/records.js';
import { bulkItem } from '../../js/offline/local-api.js';
import { describeDeskList, filterDeskRows } from '../../js/ui/desk-list.js';
import { jsonResponse } from './helpers.mjs';

const API = 'https://api.test/';

function setup(answer = () => jsonResponse(200, {})) {
  const calls = [];
  const api = createApi({
    base: API,
    sameOrigin: false,
    getToken: () => 'a.b.c',
    fetchFn: async (url, init = {}) => {
      const call = { url: new URL(String(url)), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) };
      calls.push(call);
      return answer(call);
    },
  });
  return { api, calls };
}

describe('the election and the desk go to the server', () => {
  test('issuing sends the election on screen and the desk chosen at sign-in', async () => {
    const { api, calls } = setup(() => jsonResponse(200, { memberId: 7, qrIssuedAt: '2026-12-03T01:00:00Z', eventId: 77, deskNo: 4 }));
    const r = await api.markQrIssued(7, { eventId: 77, deskNo: 4 });
    assert.equal(r.ok, true);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url.pathname, '/' + qrIssuedPath(7));
    assert.deepEqual(calls[0].body, { eventId: 77, deskNo: 4 });
  });

  test('without an election or a desk nothing extra is sent (an older server takes no body)', async () => {
    const { api, calls } = setup(() => jsonResponse(200, { memberId: 7 }));
    await api.markQrIssued(7);
    assert.equal(calls[0].body, undefined);
  });

  test('the search and the roster ask for the QR of THIS election', async () => {
    const { api, calls } = setup(() => jsonResponse(200, []));
    await api.searchMembers('juan', [5, 6], { eventId: 77 });
    await api.getRoster([5], { eventId: 77 });
    await api.searchMembers('juan', [5]);
    assert.equal(calls[0].url.pathname, '/' + SEARCH_PATH);
    assert.equal(calls[0].url.searchParams.get('eventId'), '77');
    assert.deepEqual(calls[0].url.searchParams.getAll('branchIds'), ['5', '6']);
    assert.equal(calls[1].url.pathname, '/' + ROSTER_PATH);
    assert.equal(calls[1].url.searchParams.get('eventId'), '77');
    assert.equal(calls[2].url.searchParams.has('eventId'), false, 'no election: the old answer (last QR of any election)');
  });

  test("the desk's list: one election, one desk, read as the server sends it", async () => {
    const { api, calls } = setup(() =>
      jsonResponse(200, {
        eventId: 77,
        deskNo: 4,
        total: 3,
        memberCount: 2,
        items: [
          { memberId: 1, accountCode: '0050000001', memberName: 'DELA CRUZ, JUAN', branch: 'Main', issuedAtUtc: '2026-12-03T02:00:00Z', issuedBy: 'reg1', offline: false },
          { memberId: 2, accountCode: '0050000002', memberName: 'SANTOS, MARIA', branch: 'Main', issuedAtUtc: '2026-12-03T01:30:00Z', issuedBy: 'reg2', offline: true },
          { memberId: 0, memberName: 'broken row' },
        ],
      }),
    );
    const r = await api.getDeskIssuances(77, 4);
    assert.equal(calls[0].url.pathname, '/' + DESK_ISSUANCES_PATH);
    assert.equal(calls[0].url.searchParams.get('eventId'), '77');
    assert.equal(calls[0].url.searchParams.get('deskNo'), '4');
    assert.equal(r.ok, true);
    assert.equal(r.total, 3);
    assert.equal(r.memberCount, 2);
    assert.deepEqual(r.items.map((i) => [i.memberId, i.issuedBy, i.offline]), [[1, 'reg1', false], [2, 'reg2', true]]);
  });

  test('a list that is not a list is a protocol problem, not an empty desk', async () => {
    const { api } = setup(() => jsonResponse(200, { items: 'nope' }));
    const r = await api.getDeskIssuances(77, 4);
    assert.equal(r.ok, false);
  });
});

describe('slips issued offline keep their election, desk and user', () => {
  test('a full outbox entry', () => {
    assert.deepEqual(bulkItem({ memberId: 3, issuedAtUtc: 't', eventId: 77, deskNo: 9, user: 'reg1' }), { memberId: 3, issuedAtUtc: 't', eventId: 77, deskNo: 9, issuedBy: 'reg1' });
  });
  test('an entry queued by an older page (no desk, election 0) sends only what it has', () => {
    assert.deepEqual(bulkItem({ memberId: 3, issuedAtUtc: 't', eventId: 0, user: '' }), { memberId: 3, issuedAtUtc: 't' });
  });
});

describe('"already issued" is per election', () => {
  test("a slip of this session in another election does not count", () => {
    const records = createRecords();
    const r = records.add({ memberId: 5, memberName: 'A', accountCode: '1', eventId: 10, eventTitle: 'Representative' });
    records.update(r.id, { state: RecordState.Confirmed, issuedAtUtc: '2026-11-20T01:00:00Z' });
    assert.ok(records.latestConfirmedFor(5, 10));
    assert.equal(records.latestConfirmedFor(5, 11), null, 'General Assembly: not issued yet');
    assert.ok(records.latestConfirmedFor(5), 'without an election: any');
  });
});

describe("the words of the desk's list", () => {
  test('summary', () => {
    assert.equal(describeDeskList({ deskNo: null }), 'No desk was chosen at sign-in.');
    assert.equal(describeDeskList({ deskNo: 4, eventTitle: '' }), 'Desk 4: no election is open.');
    assert.equal(describeDeskList({ deskNo: 4, eventTitle: 'GA 2026', total: 1, memberCount: 1 }), 'Desk 4, "GA 2026": 1 member received a QR here.');
    assert.equal(
      describeDeskList({ deskNo: 4, eventTitle: 'GA 2026', total: 5, memberCount: 4, waiting: 2 }),
      'Desk 4, "GA 2026": 4 members received a QR here (5 slips with reprints). 2 slips issued offline wait to be sent to the server.',
    );
    assert.match(describeDeskList({ deskNo: 4, eventTitle: 'GA', total: 2, memberCount: 2, filter: 'cruz', shown: 1 }), /Showing 1 that match "cruz"\.$/);
  });
  test('filter by name or account code, case and spaces ignored', () => {
    const rows = [{ memberName: 'DELA CRUZ, JUAN', accountCode: '0050000001' }, { memberName: 'SANTOS, MARIA', accountCode: '0050000002' }];
    assert.equal(filterDeskRows(rows, '  dela   cruz ').length, 1);
    assert.equal(filterDeskRows(rows, '0002')[0].memberName, 'SANTOS, MARIA');
    assert.equal(filterDeskRows(rows, '').length, 2);
  });
});
