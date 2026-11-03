// The selected member, whether a QR can be issued, what happened to the last Issue, and the slip itself.

import {
  EligibilityKind,
  dash,
  eligibilityHeadline,
  eligibilityIcon,
  eligibilityReason,
  formatDateTime,
  loanStatusText,
  money,
  parseServerUtc,
  qrText,
} from '../format.js';
import { renderSlip } from '../slip.js';
import { h, setChildren, setHidden, setText } from './dom.js';

/** Why the Issue button is unavailable, in words (IssueHint of the Windows station). */
export function issueHint({ eventOpen, offline, member, qrIssuedAt, autoPrint }) {
  if (!eventOpen) return 'Registration is closed.';
  if (offline) return 'Offline - the server is not answering, so no QR can be issued right now.';
  if (!member) return 'Select a member to see whether a QR can be issued.';
  switch (member.kind) {
    case EligibilityKind.Eligible: {
      if (qrIssuedAt) {
        const when = parseServerUtc(qrIssuedAt);
        return `A QR was already issued (${when ? formatDateTime(when) : 'earlier'}). You will be asked to confirm before another is issued.`;
      }
      return autoPrint
        ? 'Press the button (or Enter). The server records the QR first, then the slip is printed.'
        : 'Press the button (or Enter). The server records the QR first, then the slip is shown.';
    }
    case EligibilityKind.NotEligible:
      return `No QR is issued to a member who is not eligible. ${eligibilityReason(member, null, member.kind)}`;
    default:
      return `No QR can be issued. ${eligibilityReason(member, null, member.kind)}`;
  }
}

export function createDetailPanel({ onIssue, onCheckConnection, onNoticeAction, onPrintAgain, onHideSlip }) {
  let emptyEl;
  let memberEl;
  let nameEl;
  let codeEl;
  let branchEl;
  let eligEl;
  let eligIconEl;
  let eligTextEl;
  let reasonEl;
  let qrStatusEl;
  let issueBtn;
  let hintEl;
  let checkBtn;
  let moreEl;
  let moreListEl;
  let noticeEl;
  let slipSection;
  let slipHostEl;
  let slipMessageEl;
  let printBtn;
  let renderedSlipKey = null;
  let shownNoticeKey = null;

  const el = h(
    'section',
    { class: 'detail', 'aria-label': 'Selected member' },
    // first, so that what happened to the last Issue (and the buttons to deal with it) is the first thing in view, never below the fold
    (noticeEl = h('div', { class: 'notice', role: 'status', hidden: true })),
    (emptyEl = h('p', { class: 'detail-empty' }, 'Select a member in the list to see the details and whether a QR can be issued.')),
    (memberEl = h(
      'div',
      { class: 'detail-member', hidden: true },
      (nameEl = h('h2', { class: 'detail-name' })),
      h('p', { class: 'detail-ids' }, (codeEl = h('span', { class: 'detail-code' })), (branchEl = h('span', { class: 'detail-branch' }))),
      (eligEl = h('div', { class: 'eligibility' }, (eligIconEl = h('span', { class: 'eligibility-icon', 'aria-hidden': 'true' })), (eligTextEl = h('strong', { class: 'eligibility-text' })))),
      (reasonEl = h('p', { class: 'eligibility-reason' })),
      (qrStatusEl = h('p', { class: 'detail-qr' })),
      h(
        'div',
        { class: 'issue' },
        (issueBtn = h('button', { type: 'button', class: 'btn btn-primary btn-large', id: 'issue-button', onclick: () => onIssue() }, 'Issue QR & print slip')),
        (hintEl = h('p', { class: 'issue-hint', id: 'issue-hint' })),
        (checkBtn = h('button', { type: 'button', class: 'btn btn-small', hidden: true, onclick: () => onCheckConnection() }, 'Check the connection now')),
      ),
      (moreEl = h('details', { class: 'more' }, h('summary', null, 'More details'), (moreListEl = h('dl', { class: 'more-list' })))),
    )),
    (slipSection = h(
      'section',
      { class: 'slip-area', 'aria-label': 'Slip', hidden: true },
      h('div', { class: 'slip-area-head' }, h('h2', { class: 'slip-area-title' }, 'Slip')),
      (slipMessageEl = h('p', { class: 'slip-message', role: 'status' })),
      (slipHostEl = h('div', { class: 'slip-paper' })),
      h(
        'div',
        { class: 'slip-actions' },
        (printBtn = h('button', { type: 'button', class: 'btn', onclick: () => onPrintAgain() }, 'Print again')),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => onHideSlip() }, 'Hide slip'),
      ),
    )),
  );

  function renderMore(m) {
    const rows = [
      ['Contact number', dash(m.memberContactNumber)],
      ['Address', dash(m.memberAddress)],
      ['Share capital', money(m.shareCapital)],
      ['Savings deposit', money(m.savingsDeposit)],
      ['Loan status', loanStatusText(m.loanStatus)],
    ];
    setChildren(
      moreListEl,
      rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    );
  }

  return {
    el,
    focusIssue: () => issueBtn.focus(),

    /**
     * @param {object} view
     * @param {object|null} view.member        the selected row (with kind), or null
     * @param {string|null} view.qrIssuedAt    what the screen says the member's QR time is (server's, or this session's later one)
     * @param {object|null} view.event
     * @param {boolean} view.offline
     * @param {boolean} view.issuing
     * @param {boolean} view.searchPending
     * @param {boolean} view.autoPrint
     * @param {object|null} view.notice        { kind: 'success'|'error'|'info', text, actions: [{key, label}] }
     * @param {object|null} view.slip          { key, model, message }
     */
    update(view) {
      const m = view.member;
      el.classList.toggle('has-slip', !!view.slip); // the slip comes out beside the member, not under it
      setHidden(emptyEl, !!m);
      setHidden(memberEl, !m);

      if (m) {
        setText(nameEl, m.memberName);
        setText(codeEl, m.accountCode);
        setText(branchEl, dash(m.branch));
        eligEl.dataset.kind = m.kind;
        setText(eligIconEl, eligibilityIcon(m.kind));
        setText(eligTextEl, eligibilityHeadline(m.kind));
        setText(reasonEl, eligibilityReason(m, view.event, m.kind));
        setText(qrStatusEl, qrText(view.qrIssuedAt));
        renderMore(m);

        const canIssue = !!view.event && !view.offline && m.kind === EligibilityKind.Eligible && !view.issuing && !view.searchPending;
        issueBtn.disabled = !canIssue;
        const label = view.issuing ? 'Issuing…' : view.qrIssuedAt ? 'Issue QR again…' : view.autoPrint ? 'Issue QR & print slip' : 'Issue QR';
        setText(issueBtn, label);
        issueBtn.setAttribute('aria-describedby', 'issue-hint');
        setText(hintEl, issueHint({ eventOpen: !!view.event, offline: view.offline, member: m, qrIssuedAt: view.qrIssuedAt, autoPrint: view.autoPrint }));
        setHidden(checkBtn, !view.offline);
      } else {
        moreEl.open = false;
      }

      // what happened to the last Issue
      if (view.notice) {
        noticeEl.dataset.kind = view.notice.kind;
        noticeEl.setAttribute('role', view.notice.kind === 'error' ? 'alert' : 'status');
        setChildren(
          noticeEl,
          h('p', { class: 'notice-text' }, view.notice.text),
          view.notice.actions?.length
            ? h(
                'div',
                { class: 'notice-actions' },
                view.notice.actions.map((a) => h('button', { type: 'button', class: 'btn btn-small', onclick: () => onNoticeAction(a.key) }, a.label)),
              )
            : null,
        );
        setHidden(noticeEl, false);
        const key = `${view.notice.kind}|${view.notice.text}`;
        if (key !== shownNoticeKey) {
          shownNoticeKey = key;
          noticeEl.scrollIntoView({ block: 'nearest' }); // a new answer is never left out of sight
        }
      } else {
        shownNoticeKey = null;
        setHidden(noticeEl, true);
        noticeEl.replaceChildren();
      }

      // the slip
      if (view.slip) {
        setHidden(slipSection, false);
        setText(slipMessageEl, view.slip.message || '');
        setHidden(slipMessageEl, !view.slip.message);
        if (renderedSlipKey !== view.slip.key) {
          renderedSlipKey = view.slip.key;
          let slipEl;
          try {
            slipEl = renderSlip(view.slip.model);
            slipEl.classList.add('slip-feed'); // a new slip feeds out of the printer once
          } catch {
            slipEl = h('p', { class: 'form-error' }, 'The QR code could not be drawn, so there is no slip to show.');
          }
          setChildren(slipHostEl, slipEl);
        }
        printBtn.disabled = view.issuing;
      } else {
        renderedSlipKey = null;
        setHidden(slipSection, true);
        slipHostEl.replaceChildren();
      }
    },
  };
}
