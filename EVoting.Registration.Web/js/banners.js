// Decides which messages staff see across the top of the desk. A pure function of its inputs, so every situation - and the
// wording of each - is covered by a test (BannerComposer in the Windows station). The wording keeps the important distinctions:
// "offline" means the server did not answer at all; a refusal or a server error is reported as exactly that.

import { formatTime, plural } from './format.js';
import { Reachability } from './connectivity.js';

export const Severity = Object.freeze({
  Info: 0,
  Warning: 1,
  /** Something only a person can fix; work may be impossible until it is. */
  Critical: 2,
});

export const BannerActions = Object.freeze({
  ReviewRecords: 'reviewRecords',
  Refresh: 'refresh',
});

/**
 * @param {object} input
 * @param {{status: string, offlineSince: (number|null), lastProblem: (object|null)}} input.connectivity
 * @param {{status: 'unknown'|'open'|'none'|'error', message?: string}} input.event
 * @param {(object|null)} input.configProblem  an ApiFailure of kind Cors/Csp, when the page cannot use the server
 * @param {number} input.needAttention         records nobody has looked at yet that did not simply succeed
 * @param {boolean} input.signedIn
 * @param {Set<string>} [input.dismissed]
 */
export function composeBanners(input) {
  const list = [];
  const { connectivity, event, configProblem, needAttention, signedIn } = input;
  const dismissed = input.dismissed ?? new Set();

  // ── the page cannot use the server ────────────────────────────────────────────────────────────────
  if (configProblem) {
    list.push({
      key: 'config',
      severity: Severity.Critical,
      title: configProblem.kind === 'csp' ? 'This page is set up with the wrong server address' : 'The browser is blocking the connection to the server',
      detail: configProblem.message,
      canDismiss: false,
    });
  }

  // ── the election ──────────────────────────────────────────────────────────────────────────────────
  if (signedIn) {
    if (event.status === 'none') {
      list.push({
        key: 'event',
        severity: Severity.Warning,
        title: 'No election is open',
        detail: 'Registration is closed until an administrator opens one.',
        canDismiss: false,
        actionKey: BannerActions.Refresh,
        actionText: 'Check again',
      });
    } else if (event.status === 'error' && !configProblem) {
      list.push({
        key: 'event',
        severity: Severity.Warning,
        title: 'Could not find out which election is open',
        detail: event.message || 'The server did not give a usable answer.',
        canDismiss: false,
        actionKey: BannerActions.Refresh,
        actionText: 'Try again',
      });
    }
  }

  // ── offline ───────────────────────────────────────────────────────────────────────────────────────
  if (connectivity.status === Reachability.Offline && !configProblem) {
    const since = connectivity.offlineSince ? `The server has not answered since ${formatTime(new Date(connectivity.offlineSince))}. ` : 'The server is not answering. ';
    list.push({
      key: 'offline',
      severity: Severity.Warning,
      title: 'Offline - QR codes cannot be issued',
      detail: `${since}This web version works only while the server answers, so members cannot be searched or issued a QR until it is back. The Windows Registration station can keep working offline.`,
      canDismiss: false,
    });
  }

  // ── the server answered, but not well ─────────────────────────────────────────────────────────────
  if (connectivity.status === Reachability.Online && connectivity.lastProblem) {
    list.push({
      key: 'server-problem',
      severity: Severity.Warning,
      title: 'The server answered with a problem',
      detail: connectivity.lastProblem.message,
      canDismiss: false,
    });
  }

  // ── records nobody has looked at ──────────────────────────────────────────────────────────────────
  if (signedIn && needAttention > 0) {
    list.push({
      key: 'records',
      severity: Severity.Critical,
      title: `${plural(needAttention, 'QR issuance record')} need${needAttention === 1 ? 's' : ''} attention`,
      detail:
        needAttention === 1
          ? 'The server did not record it, or did not answer. No slip was printed for it. Open the review list and decide what to do.'
          : 'The server did not record them, or did not answer. No slip was printed for them. Open the review list and decide what to do with each one.',
      canDismiss: false,
      actionKey: BannerActions.ReviewRecords,
      actionText: 'Review',
    });
  }

  // ── notes the page itself wants to show once (for example "the election changed") ─────────────────
  for (const note of input.extra ?? []) list.push({ severity: Severity.Info, canDismiss: true, ...note });

  return list
    .filter((b) => !(b.canDismiss && dismissed.has(b.key)))
    .map((b, index) => ({ b, index }))
    .sort((x, y) => y.b.severity - x.b.severity || x.index - y.index)
    .map((x) => x.b);
}
