// The desk's API while it works OFFLINE: the same calls as js/api.js (getCurrentEvent, searchMembers, markQrIssued), answered from
// the member list prepared on this PC instead of the server. js/main.js switches to it after an offline sign-in, so the search, the
// eligibility rules (format.js / issue.js) and the slip are exactly the online ones.
//
//   search   - the server's rule (RegistrationController.SearchMembers): active members of the given branches whose name or account
//              code contains the text (case and accents ignored), ordered by name, at most 200
//   issue    - recorded in the outbox (desk.js) with the time of THIS PC; sent with qr-issued-bulk when the desk is online again
//   election - open while the PC's clock is inside the election's schedule (the kiosks follow the same rule offline)

import { normalizeEvent, normalizeMember } from '../api.js';
import { SERVER_ROW_CAP, fold, memberMatches } from '../format.js';

export function createOfflineApi({ event: rawEvent, members: rawMembers, desk, username, now = () => Date.now(), newId = () => globalThis.crypto.randomUUID() }) {
  const event = normalizeEvent(rawEvent);
  const members = (rawMembers ?? []).map(normalizeMember).filter(Boolean);
  const byName = [...members].sort((a, b) => a.memberName.localeCompare(b.memberName, 'en', { sensitivity: 'base' }) || a.memberId - b.memberId);
  const issued = new Map(); // memberId -> ISO time of an offline issue made in this session

  const withIssued = (m) => (issued.has(m.memberId) ? { ...m, qrIssuedAt: issued.get(m.memberId) } : m);

  return {
    offline: true,
    event,
    memberCount: members.length,

    /** Open when the PC's clock is inside the schedule; otherwise no election (same as the server's 404). */
    async getCurrentEvent() {
      if (!event) return { ok: true, event: null };
      const t = now();
      const from = event.scheduleFrom ? event.scheduleFrom.getTime() : -Infinity;
      const to = event.scheduleTo ? event.scheduleTo.getTime() : Infinity;
      return { ok: true, event: t >= from && t < to ? event : null, outsideSchedule: !(t >= from && t < to) };
    },

    async searchMembers(query, branchIds) {
      if (!Array.isArray(branchIds) || branchIds.length === 0) return { ok: true, members: [] };
      const q = fold(query);
      if (q.length < 2) return { ok: true, members: [] };
      const allowed = new Set(branchIds);
      const found = [];
      for (const m of byName) {
        if (!m.isActive || !allowed.has(m.branchId) || !memberMatches(m, q)) continue;
        found.push(withIssued(m));
        if (found.length >= SERVER_ROW_CAP) break;
      }
      return { ok: true, members: found };
    },

    /** Recorded on this PC; the server gets it later. Never fails for a member of the prepared list. */
    async markQrIssued(memberId) {
      const member = members.find((m) => m.memberId === memberId);
      if (!member) return { ok: false, failure: { kind: 'notFound', message: 'This member is not in the member list prepared on this PC.' } };
      const at = new Date(now()).toISOString();
      await desk.queue({ id: newId(), username, memberId, eventId: event ? event.eventId : 0, issuedAtUtc: at });
      issued.set(memberId, at);
      return { ok: true, memberId, qrIssuedAt: at, offline: true };
    },
  };
}

/**
 * Sends the outbox of this PC (every user's) with POST qr-issued-bulk. { sent, unknown, failed } where unknown are members the server
 * no longer knows (removed from the outbox: retrying cannot help) and failed means nothing was sent (kept for the next try).
 */
export async function flushOutbox({ desk, api }) {
  const items = await desk.pending();
  if (items.length === 0) return { ok: true, sent: 0, unknown: [], ids: [] };
  const r = await api.markQrIssuedBulk(items.map((i) => ({ memberId: i.memberId, issuedAtUtc: i.issuedAtUtc })));
  if (!r.ok) return { ok: false, sent: 0, unknown: [], ids: [], failure: r.failure, waiting: items.length };
  const done = new Set([...r.succeededMemberIds, ...r.failedMemberIds]);
  const finished = items.filter((i) => done.has(i.memberId));
  await desk.markSent(finished.map((i) => i.id));
  return { ok: true, sent: finished.filter((i) => r.succeededMemberIds.includes(i.memberId)).length, unknown: r.failedMemberIds, ids: finished.map((i) => i.id), waiting: items.length - finished.length };
}
