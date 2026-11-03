// Issuing a voting QR for a member, as one explicit action: check, ask the server to record it, and only when the server has
// confirmed it say that a slip may be handed out. (The Windows station saves the record on the PC first and sends it later;
// the browser version has no durable store, so it never hands out a slip the server has not recorded.)
//
// The checks are the ones QrIssuanceService.Check makes: they are a convenience, not a decision. The server decides again when
// the member scans at the kiosk. Eligibility is only ever what the server said.

import { FailureKind } from './errors.js';
import { laterOf, parseServerUtc, qrPayload } from './format.js';
import { RecordState } from './records.js';

export const DUPLICATE_WINDOW_MS = 5000;

export const IssueRefusal = Object.freeze({
  None: 'none',
  NoElection: 'noElection',
  MemberNotActive: 'memberNotActive',
  BranchNotInElection: 'branchNotInElection',
  NotEligible: 'notEligible',
  /** A QR was already issued; the caller may repeat the request with allowReissue to print it again. */
  AlreadyIssued: 'alreadyIssued',
  /** The same member is being sent right now (double click / key repeat). */
  Busy: 'busy',
});

/** Why a QR may not be issued, or null when it may. */
export function checkIssue(member, event, { allowReissue = false } = {}) {
  if (!event) return { refusal: IssueRefusal.NoElection, message: 'No election is open.' };
  if (!member.isActive) return { refusal: IssueRefusal.MemberNotActive, message: 'This member is not active.' };
  if (!event.branchIds || !event.branchIds.includes(member.branchId)) {
    return { refusal: IssueRefusal.BranchNotInElection, message: `Branch '${member.branch}' is not part of the '${event.title}' election.` };
  }
  if (!member.isEligibleToVote) {
    return {
      refusal: IssueRefusal.NotEligible,
      message: member.votingRemarks && member.votingRemarks.trim() ? member.votingRemarks.trim() : 'This member is not eligible to vote.',
    };
  }
  if (member.qrIssuedAt && !allowReissue) return { refusal: IssueRefusal.AlreadyIssued, message: 'A QR was already issued to this member.' };
  return null;
}

/**
 * @param {object} options
 * @param {{markQrIssued: Function, searchMembers: Function}} options.api
 * @param {ReturnType<import('./records.js').createRecords>} options.records
 * @param {() => (object|null)} options.getEvent
 * @param {() => number} [options.now]
 * @param {number} [options.issueTimeoutMs]
 */
export function createIssuer({ api, records, getEvent, now = () => Date.now(), issueTimeoutMs = 20000 }) {
  /** What the screen should say a member's QR time is: the later of the server's and this session's own confirmed issuance. */
  function effectiveQrIssuedAt(member) {
    const mine = records.latestConfirmedFor(member.memberId);
    return laterOf(member.qrIssuedAt, mine ? mine.issuedAtUtc : null);
  }

  /** One attempt to have the server record the issuance for an existing record. */
  async function perform(record) {
    records.update(record.id, { state: RecordState.Sending, attempts: record.attempts + 1, message: '', failureKind: null });
    const r = await api.markQrIssued(record.memberId, { timeoutMs: issueTimeoutMs });

    if (r.ok) {
      const updated = records.update(record.id, {
        state: RecordState.Confirmed,
        issuedAtUtc: r.qrIssuedAt ?? new Date(now()).toISOString(),
        message: '',
        failureKind: null,
      });
      return { issued: true, refusal: IssueRefusal.None, message: 'QR issued. Confirmed by the server.', record: updated, mayPrint: true, duplicate: false };
    }

    const f = r.failure;
    let state;
    let message;
    switch (f.kind) {
      case FailureKind.NotFound:
        state = RecordState.Rejected;
        message = 'The server does not know this member (removed or deactivated). Do not hand out a slip.';
        break;
      case FailureKind.Network:
      case FailureKind.Timeout:
      case FailureKind.Cors:
      case FailureKind.Csp:
        state = RecordState.Unknown;
        message = `${f.message} It may or may not have been recorded - use "Check with server" or "Try again". No slip was printed.`;
        break;
      case FailureKind.Unauthorized:
        state = RecordState.Failed;
        message = 'Your session ended before the server recorded this. Sign in again, then press "Try again". No slip was printed.';
        break;
      default:
        state = RecordState.Failed;
        message = `${f.message} No slip was printed.`;
        break;
    }
    const updated = records.update(record.id, { state, message, failureKind: f.kind });
    return { issued: false, refusal: IssueRefusal.None, message, record: updated, mayPrint: false, duplicate: false, failure: f };
  }

  return {
    effectiveQrIssuedAt,

    /**
     * Issues a QR for a member shown in the search results. `member` carries the row as the server sent it; the later of its
     * QrIssuedAt and this session's own issuance counts as "already issued".
     */
    async issue(member, { allowReissue = false } = {}) {
      const event = getEvent();

      // Double-click / key-repeat guard: the same member inside a few seconds is the same action, not a request for a second QR.
      // (Checked before "already issued", or an accidental second Enter would ask whether to issue another one.)
      const sending = records.sendingFor(member.memberId);
      if (sending) {
        return { issued: false, refusal: IssueRefusal.Busy, message: 'A QR for this member is already being sent.', record: sending, mayPrint: false, duplicate: true };
      }
      const last = records.lastFor(member.memberId);
      if (last && last.state === RecordState.Confirmed && now() - last.startedAt >= 0 && now() - last.startedAt < DUPLICATE_WINDOW_MS) {
        return { issued: true, refusal: IssueRefusal.None, message: 'A QR for this member was just issued.', record: last, mayPrint: false, duplicate: true };
      }

      const effective = { ...member, qrIssuedAt: effectiveQrIssuedAt(member) };
      const refusal = checkIssue(effective, event, { allowReissue });
      if (refusal) return { issued: false, ...refusal, record: null, mayPrint: false, duplicate: false };

      const record = records.add({
        memberId: member.memberId,
        memberName: member.memberName,
        accountCode: member.accountCode,
        branchId: member.branchId,
        branch: member.branch,
        eventId: event.eventId,
        eventTitle: event.title,
        qrIssuedAtBefore: member.qrIssuedAt ?? null,
      });
      return perform(record);
    },

    /** "Try again": sends a record that was not recorded again. Safe: the server only stamps the member's latest issue time. */
    async retry(recordId) {
      const record = records.get(recordId);
      if (!record) return { issued: false, refusal: IssueRefusal.None, message: 'That record no longer exists.', record: null, mayPrint: false, duplicate: false };
      if (record.state !== RecordState.Failed && record.state !== RecordState.Unknown) {
        return { issued: record.state === RecordState.Confirmed, refusal: IssueRefusal.None, message: 'Only a record that was not recorded can be sent again.', record, mayPrint: false, duplicate: false };
      }
      if (records.sendingFor(record.memberId)) {
        return { issued: false, refusal: IssueRefusal.Busy, message: 'A QR for this member is already being sent.', record, mayPrint: false, duplicate: true };
      }
      return perform(record);
    },

    /**
     * "Check with server": did a request whose answer never arrived take effect? Looks the member up and compares the server's
     * QrIssuedAt with what it was before the attempt. (The PC's clock is not used: PCs are often minutes off.)
     */
    async verify(recordId) {
      const record = records.get(recordId);
      const event = getEvent();
      if (!record || !event) return { resolved: false, message: 'Nothing to check.', record };

      const r = await api.searchMembers(record.accountCode, event.branchIds);
      if (!r.ok) return { resolved: false, message: r.failure.message, record, failure: r.failure };

      const member = r.members.find((m) => m.memberId === record.memberId);
      if (!member) return { resolved: false, message: 'The server no longer lists this member in the election.', record };

      const changed = member.qrIssuedAt && member.qrIssuedAt !== record.qrIssuedAtBefore;
      if (changed) {
        const updated = records.update(record.id, {
          state: RecordState.Confirmed,
          issuedAtUtc: member.qrIssuedAt,
          message: '',
          failureKind: null,
        });
        return { resolved: true, confirmed: true, message: 'The server has this issuance. It is confirmed.', record: updated, member };
      }
      const updated = records.update(record.id, {
        state: RecordState.Failed,
        message: 'The server has no record of this issuance. No slip was printed. Press "Try again" when the member is still waiting.',
        failureKind: null,
      });
      return { resolved: true, confirmed: false, message: updated.message, record: updated, member };
    },

    /** Marks a slip as printed (for the "Reprint" bookkeeping). */
    notePrinted(recordId) {
      const r = records.get(recordId);
      if (r) records.update(recordId, { slipsPrinted: (r.slipsPrinted || 0) + 1 });
    },

    qrPayloadFor: (member) => qrPayload(member.accountCode),
    issuedAtDate: (record) => parseServerUtc(record.issuedAtUtc) ?? new Date(record.startedAt),
  };
}
