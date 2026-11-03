// Plain text for what the screen shows about a member, about times, and about the search box.
// Pure functions, no DOM, no state: every sentence staff can read is covered by a test.
// Nothing here recomputes eligibility: the verdict and its reason come from EVoting.Api
// (isEligibleToVote, votingRemarks). Ported from the Windows station (SearchNormalizer, MemberPresentation).

export const MIN_QUERY_LENGTH = 2;

// ── folding (same table as SearchNormalizer.cs) ──────────────────────────────────────────────────────

const FOLD_TABLE = (() => {
  const table = new Map();
  const add = (chars, to) => {
    for (const c of chars) table.set(c, to);
  };
  add('ÀÁÂÃÄÅĀĂĄàáâãäåāăą', 'a');
  add('Ææ', 'ae');
  add('ÇĆČçćč', 'c');
  add('ĎĐďđ', 'd');
  add('ÈÉÊËĒĖĘĚèéêëēėęě', 'e');
  add('Ğğ', 'g');
  add('ÌÍÎÏĪĮİìíîïīįı', 'i');
  add('Łł', 'l');
  add('ÑŃŇñńň', 'n');
  add('ÒÓÔÕÖØŌŐòóôõöøōő', 'o');
  add('Œœ', 'oe');
  add('Řř', 'r');
  add('ŚŠŞśšş', 's');
  add('ß', 'ss');
  add('Ťť', 't');
  add('ÙÚÛÜŪŮŰŲùúûüūůűų', 'u');
  add('ÝŸýÿ', 'y');
  add('ŹŻŽźżž', 'z');
  return table;
})();

const isWhitespace = (ch) => /[\s\u0085]/.test(ch);

function foldChar(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return ch.toLowerCase();
  return FOLD_TABLE.get(ch) ?? ch.toLowerCase();
}

/**
 * Folds text the way the server's database collation compares it (case-insensitive and accent-insensitive), collapses
 * whitespace and trims. Also returns, for every character of the folded text, where it came from in the original
 * (so a match can be highlighted in the text as it is written).
 */
export function foldWithMap(text) {
  const src = text == null ? '' : String(text);
  let out = '';
  const starts = [];
  const ends = [];
  let lastWasSpace = true; // swallows leading whitespace

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (isWhitespace(ch)) {
      if (!lastWasSpace) {
        out += ' ';
        starts.push(i);
        ends.push(i + 1);
        lastWasSpace = true;
      } else if (out.length > 0) {
        ends[ends.length - 1] = i + 1; // the collapsed run of spaces covers every space of the run
      }
      continue;
    }
    const folded = foldChar(ch);
    for (let k = 0; k < folded.length; k++) {
      out += folded[k];
      starts.push(i);
      ends.push(i + 1);
    }
    lastWasSpace = false;
  }

  if (out.length > 0 && out[out.length - 1] === ' ') {
    out = out.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text: out, starts, ends };
}

/** Fold + collapse whitespace + trim. Never returns null. */
export function fold(text) {
  return foldWithMap(text).text;
}

/** True when a query is long enough to search for (after trimming). */
export function isSearchable(rawQuery) {
  return fold(rawQuery).length >= MIN_QUERY_LENGTH;
}

/** The server gets the text as typed (trimmed, single-spaced); only the folded form is used on this side. */
export function serverQuery(rawQuery) {
  return (rawQuery == null ? '' : String(rawQuery)).split(/[\s\u0085]+/).filter(Boolean).join(' ');
}

/**
 * Where a folded query occurs in `original`, as ranges of the ORIGINAL text (for highlighting).
 * Non-overlapping, in order. Empty when the query is empty or does not occur.
 */
export function matchRanges(original, foldedQuery) {
  const q = foldedQuery || '';
  if (!q) return [];
  const { text, starts, ends } = foldWithMap(original);
  const ranges = [];
  let from = 0;
  while (from <= text.length - q.length) {
    const at = text.indexOf(q, from);
    if (at < 0) break;
    const start = starts[at];
    const end = ends[at + q.length - 1];
    const last = ranges[ranges.length - 1];
    if (last && start < last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
    from = at + q.length;
  }
  return ranges;
}

/** Splits `original` into [{text, match}] pieces for the ranges. */
export function splitByRanges(original, ranges) {
  const text = original == null ? '' : String(original);
  const parts = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) parts.push({ text: text.slice(pos, r.start), match: false });
    parts.push({ text: text.slice(r.start, r.end), match: true });
    pos = r.end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), match: false });
  return parts;
}

/** The member's name or account code contains the folded query (the server's rule, applied to rows already received). */
export function memberMatches(member, foldedQuery) {
  if (!foldedQuery) return false;
  return fold(member.memberName).includes(foldedQuery) || fold(member.accountCode).includes(foldedQuery);
}

// ── the QR payload ───────────────────────────────────────────────────────────────────────────────────

/**
 * What goes into the QR code: the member's account code, trimmed and in capitals - exactly what the kiosk's scanner expects
 * (QrCodeGenerator.cs: accountCode.Trim().ToUpper()). Characters whose capital form is longer (ß -> SS) stay as they are,
 * like ToUpperInvariant does.
 */
export function qrPayload(accountCode) {
  const trimmed = (accountCode == null ? '' : String(accountCode)).trim();
  let out = '';
  for (const ch of trimmed) {
    const up = ch.toUpperCase();
    out += up.length === ch.length ? up : ch;
  }
  return out;
}

// ── plural, money, dash ──────────────────────────────────────────────────────────────────────────────

export function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm ?? `${singular}s`}`;
}

export function money(amount) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  return '₱' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function dash(value) {
  return value == null || String(value).trim() === '' ? '—' : String(value).trim();
}

export function loanStatusText(loanStatus) {
  switch (loanStatus) {
    case 0:
      return 'None';
    case 1:
      return 'Active';
    case 2:
      return 'Past due';
    case 3:
      return 'Paid';
    default:
      return `Unknown (${loanStatus})`;
  }
}

// ── times ────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The server sends UTC times without a zone ("2026-11-03T02:15:00"). JavaScript would read that as LOCAL time, so a missing
 * zone is read as UTC here (exactly how the Windows station treats an unspecified time from the server).
 */
export function parseServerUtc(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  s = s.replace(/(\.\d{3})\d+/, '$1'); // .NET writes up to 7 fractional digits; keep milliseconds
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Election schedules are local wall-clock times without a zone, as stored by the server; read them as local times. */
export function parseLocalWallClock(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "03 Nov 2026 10:15" (local time of this PC). */
export function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "10:15" */
export function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "Nov 03, 2026 10:15" - the format printed on the slip (SlipVisual.cs). */
export function formatSlipDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '-';
  return `${MONTHS[date.getMonth()]} ${pad2(date.getDate())}, ${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "Issued 03 Nov 2026 10:15" or "Not issued". */
export function qrText(qrIssuedAt) {
  const d = parseServerUtc(qrIssuedAt);
  return d ? `Issued ${formatDateTime(d)}` : 'Not issued';
}

/** The later of two server timestamps (either may be missing), as the ISO string of the later one. */
export function laterOf(a, b) {
  const da = parseServerUtc(a);
  const db = parseServerUtc(b);
  if (da && db) return db.getTime() > da.getTime() ? b : a;
  return da ? a : db ? b : null;
}

// ── eligibility ──────────────────────────────────────────────────────────────────────────────────────

export const EligibilityKind = Object.freeze({
  Eligible: 'eligible',
  /** The server marked the member not eligible; the reason is the server's own text. */
  NotEligible: 'notEligible',
  /** The member's branch is not part of the open election (a safety net: the search already filters by branch). */
  BranchNotInElection: 'branchNotInElection',
  /** The member is not active. */
  Inactive: 'inactive',
});

export function kindOf(member, event) {
  if (!member.isActive) return EligibilityKind.Inactive;
  if (event && Array.isArray(event.branchIds) && !event.branchIds.includes(member.branchId)) return EligibilityKind.BranchNotInElection;
  return member.isEligibleToVote ? EligibilityKind.Eligible : EligibilityKind.NotEligible;
}

export function eligibilityIcon(kind) {
  switch (kind) {
    case EligibilityKind.Eligible:
      return '✔';
    case EligibilityKind.NotEligible:
      return '✗';
    default:
      return '!';
  }
}

export function eligibilityHeadline(kind) {
  switch (kind) {
    case EligibilityKind.Eligible:
      return 'Eligible to vote';
    case EligibilityKind.NotEligible:
      return 'Not eligible to vote';
    case EligibilityKind.BranchNotInElection:
      return 'Branch not in this election';
    case EligibilityKind.Inactive:
      return 'Member is not active';
    default:
      return String(kind);
  }
}

/** The reason, in the server's words when it gave one. */
export function eligibilityReason(member, event, kind) {
  const remarks = member.votingRemarks && member.votingRemarks.trim() ? member.votingRemarks.trim() : '';
  switch (kind) {
    case EligibilityKind.Eligible:
      return remarks || 'The server lists this member as eligible.';
    case EligibilityKind.NotEligible:
      return remarks || 'The server lists this member as not eligible (no reason was given).';
    case EligibilityKind.BranchNotInElection:
      return `Branch '${member.branch && member.branch.trim() ? member.branch : '?'}' is not included in the '${event?.title ?? 'current'}' election.`;
    case EligibilityKind.Inactive:
      return 'This member is marked inactive, so no QR can be issued.';
    default:
      return '';
  }
}

// ── the line above the result list (SearchStatus.cs) ─────────────────────────────────────────────────

export const SERVER_ROW_CAP = 200;

export function describeSearch(state) {
  switch (state.phase) {
    case 'idle':
      return 'Type a name or an account code to search.';
    case 'tooShort':
      return `Type at least ${MIN_QUERY_LENGTH} characters.`;
    case 'loading':
      return 'Searching…';
    case 'noElection':
      return state.message || 'No election is open, so there is nothing to search.';
    case 'error':
      return state.message || 'The search could not be completed.';
    case 'empty':
      return state.message || 'No member found.';
    case 'results': {
      const total = state.members.length;
      const eligible = state.members.filter((m) => m.kind === EligibilityKind.Eligible).length;
      let text = `${plural(total, 'member')} found: ${eligible} eligible, ${total - eligible} not eligible.`;
      if (state.truncated) text += ` Only the first ${SERVER_ROW_CAP} are shown - type more of the name to narrow the list.`;
      return text;
    }
    default:
      return '';
  }
}
