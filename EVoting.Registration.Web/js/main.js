// The Registration desk in a browser. This file wires the pieces together; the rules live in the modules it imports:
//   api.js (the server), auth.js (sign-in / lock), search.js (finding members), issue.js + records.js (issuing and the review list),
//   slip.js + qr.js (the slip), banners.js (the notices), ui/* (the screens).
//
// Online-only: every search and every Issue goes to the server at once; a slip is printed only after the server has recorded the QR.
// Nothing about a member or the person signed in is written to the browser's storage; the page keeps it in memory until it is locked,
// signed out or closed.

import defaultConfig from '../config.js';
import { FailureKind } from './errors.js';
import { createApi, normalizeBase, validateApiBaseUrl } from './api.js';
import { createConnectivity, Reachability } from './connectivity.js';
import { AuthStatus, createAuth } from './auth.js';
import { createSearchCoordinator } from './search.js';
import { createRecords, RecordState } from './records.js';
import { IssueRefusal, createIssuer } from './issue.js';
import { EligibilityKind, eligibilityHeadline, eligibilityReason, formatDateTime, parseServerUtc } from './format.js';
import { buildSlipModel, clearPrintArea, printSlip } from './slip.js';
import { BannerActions, composeBanners } from './banners.js';
import { h, setChildren } from './ui/dom.js';
import { createConfirmDialog, createLockDialog } from './ui/dialogs.js';
import { createLoginView } from './ui/login.js';
import { createBannerList, createTopbar } from './ui/topbar.js';
import { createSearchPanel } from './ui/search-panel.js';
import { createDetailPanel } from './ui/detail-panel.js';
import { createRecentBar, createRecordsDialog } from './ui/records-ui.js';

const DEFAULTS = Object.freeze({
  apiBaseUrl: '',
  idleLockMinutes: 10,
  searchDebounceMs: 150,
  requestTimeoutMs: 15000,
  issueTimeoutMs: 20000,
  heartbeatSeconds: 30,
  eventRefreshSeconds: 60,
  quickIssue: true,
  autoPrint: true,
  clearAfterIssue: true,
});

const IDLE_SEARCH = Object.freeze({ phase: 'idle', query: '', foldedQuery: '', members: [], truncated: false, message: '', sequence: 0, preview: false, stale: false });

/** Words for a failed sign-in. */
export function describeLoginFailure(failure) {
  switch (failure.kind) {
    case FailureKind.Unauthorized:
      return { message: 'Wrong user name or password.' };
    case FailureKind.RateLimited:
      return { message: 'Too many sign-in attempts right now. Wait about a minute, then try again.', cooldownSeconds: failure.retryAfterSeconds ?? 20 };
    case FailureKind.Server:
      return { message: `${failure.message} Try again in a moment.` };
    default:
      return { message: failure.message };
  }
}

function showFatal(root, text) {
  setChildren(
    root,
    h(
      'main',
      { class: 'login' },
      h('div', { class: 'login-panel' }, h('h1', { class: 'login-title' }, 'This page is not set up correctly'), h('p', { class: 'form-error', role: 'alert' }, text), h('p', { class: 'login-note' }, 'Ask the system administrator to fix config.js (see README.md).')),
    ),
  );
}

export function start({ config: override, root = document.getElementById('app') } = {}) {
  const cfg = { ...DEFAULTS, ...(override ?? defaultConfig) };

  const configProblem = validateApiBaseUrl(cfg.apiBaseUrl);
  if (configProblem) {
    showFatal(root, configProblem);
    return null;
  }

  const { base, sameOrigin } = normalizeBase(cfg.apiBaseUrl, window.location.origin);

  // ── the pieces ──────────────────────────────────────────────────────────────────────────────────────
  let lastViolation = null;
  document.addEventListener('securitypolicyviolation', (e) => {
    lastViolation = { blockedURI: e.blockedURI, directive: e.violatedDirective, at: Date.now() };
  });

  let api;
  const records = createRecords();
  const connectivity = createConnectivity({
    ping: () => api.ping(),
    intervalMs: cfg.heartbeatSeconds * 1000,
    isVisible: () => document.visibilityState === 'visible',
  });
  const auth = createAuth({
    api: { login: (u, p) => api.login(u, p) },
    idleMs: cfg.idleLockMinutes * 60 * 1000,
    onChange: onAuthChange,
  });
  api = createApi({
    base,
    sameOrigin,
    getToken: () => auth.getToken(),
    timeoutMs: cfg.requestTimeoutMs,
    onOutcome: (o) => connectivity.noteOutcome(o),
    onUnauthorized: () => auth.expire(),
    getCspViolation: () => (lastViolation && Date.now() - lastViolation.at < 10000 ? lastViolation : null),
  });
  const issuer = createIssuer({ api, records, getEvent: () => app.event, issueTimeoutMs: cfg.issueTimeoutMs });

  // ── what the screen shows ───────────────────────────────────────────────────────────────────────────
  const app = {
    event: null,
    eventStatus: 'unknown', // unknown | open | none | error
    eventMessage: '',
    search: IDLE_SEARCH,
    selectedId: null,
    userChose: false,
    issuing: false,
    notice: null,
    slip: null,
    dismissed: new Set(),
    extraBanners: [],
    printSeq: 0,
  };

  const search = createSearchCoordinator({
    api,
    getEvent: () => app.event,
    debounceMs: cfg.searchDebounceMs,
    onState: onSearchState,
  });

  const confirm = createConfirmDialog();
  const lockDialog = createLockDialog({ onUnlock: (password) => auth.unlock(password).then(describeUnlock), onSignOut: () => signOut() });
  const login = createLoginView({ onSignIn, serverLabel: sameOrigin ? 'this site' : new URL(base).host });
  const topbar = createTopbar({ onRefresh: () => refreshEvent({ manual: true }), onLock: () => auth.lock('manual'), onSignOut: () => signOut() });
  const banners = createBannerList({ onAction: onBannerAction, onDismiss: (key) => { app.dismissed.add(key); render(); } });
  const searchPanel = createSearchPanel({
    onInput,
    onEnter: () => onEnter(),
    onMove,
    onSelect,
    onClear,
    onRetry: () => search.searchNow(searchPanel.value),
  });
  const detail = createDetailPanel({
    onIssue: () => issueSelected(),
    onCheckConnection: () => connectivity.hint(),
    onNoticeAction,
    onPrintAgain: () => app.slip && printRecord(app.slip.recordId, { reprint: true }),
    onHideSlip: () => { app.slip = null; clearPrintArea(); render(); searchPanel.focus(); },
  });
  const recent = createRecentBar({ onReview: () => recordsDialog.open({ initialMode: records.counts().unacknowledged > 0 ? 'attention' : 'recent' }), onReprint: (id) => printRecord(id, { reprint: true }) });
  const recordsDialog = createRecordsDialog({
    getRecords: (q) => records.list(q),
    onTryAgain: (id) => retryRecord(id, { fromDialog: true }),
    onCheck: (id) => checkRecord(id, { fromDialog: true }),
    onAcknowledge: (id) => {
      const r = records.acknowledge(id);
      if (r) recordsDialog.notify(`Marked as seen: ${r.memberName}. The record stays on file.`);
    },
    onReprint: (id) => printRecord(id, { reprint: true }),
  });

  const desk = h('main', { class: 'desk', id: 'desk', hidden: true }, h('div', { class: 'desk-grid' }, searchPanel.el, detail.el), recent.el);
  setChildren(root, topbar.el, banners.el, login.el, desk, confirm.el, lockDialog.el, recordsDialog.el);
  topbar.el.hidden = true;

  // ── rendering ───────────────────────────────────────────────────────────────────────────────────────
  let renderQueued = false;
  function render() {
    renderQueued = false;
    const a = auth.state;
    const signedIn = a.status === AuthStatus.SignedIn;
    const c = connectivity.state;
    const counts = records.counts();
    const diagnosis = c.lastProblem && (c.lastProblem.kind === FailureKind.Cors || c.lastProblem.kind === FailureKind.Csp) ? c.lastProblem : null;

    login.setConnectivity(c);
    banners.update(
      composeBanners({
        connectivity: { ...c, lastProblem: diagnosis ? null : c.lastProblem },
        event: { status: app.eventStatus, message: app.eventMessage },
        configProblem: diagnosis,
        needAttention: counts.unacknowledged,
        signedIn: signedIn || a.status === AuthStatus.Locked,
        dismissed: app.dismissed,
        extra: app.extraBanners,
      }),
    );

    if (!signedIn) return; // while locked or signed out, no member data is drawn

    topbar.update({ event: app.event, eventStatus: app.eventStatus, connectivity: c, displayName: a.displayName || a.username });
    const rows = app.search.members;
    const selected = rows.find((m) => m.memberId === app.selectedId) ?? null;
    searchPanel.update({ search: app.search, selectedId: app.selectedId });
    detail.update({
      member: selected,
      qrIssuedAt: selected ? issuer.effectiveQrIssuedAt(selected) : null,
      event: app.event,
      offline: c.status === Reachability.Offline,
      issuing: app.issuing,
      searchPending: app.search.phase === 'loading',
      autoPrint: cfg.autoPrint,
      notice: app.notice,
      slip: app.slip,
    });
    recent.update({ records: records.list({ mode: 'recent', limit: 8 }), counts });
    recordsDialog.refresh();
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(render);
  }
  records.subscribe(scheduleRender);
  connectivity.subscribe(scheduleRender);

  // ── sign-in, lock, sign-out ─────────────────────────────────────────────────────────────────────────
  async function onSignIn(username, password) {
    const r = await auth.signIn(username, password);
    if (r.ok) return { ok: true };
    return { ok: false, ...(r.failure ? describeLoginFailure(r.failure) : { message: r.message }) };
  }

  const describeUnlock = (r) => {
    if (r.ok) return r;
    return { ok: false, ...(r.failure ? describeLoginFailure(r.failure) : { message: r.message }) };
  };

  let eventTimer = null;

  /** 'login' | 'desk' | 'locked' (nothing but the lock dialog). */
  function showScreen(which) {
    login.el.hidden = which !== 'login';
    desk.hidden = which !== 'desk';
    topbar.el.hidden = which !== 'desk';
  }

  /** Draws the desk with no member, no slip and no records in it (the screen is locked or the person signed out). */
  function blankDesk() {
    searchPanel.update({ search: IDLE_SEARCH, selectedId: null });
    detail.update({ member: null, qrIssuedAt: null, event: app.event, offline: false, issuing: false, searchPending: false, autoPrint: cfg.autoPrint, notice: null, slip: null });
    recent.update({ records: [], counts: records.counts() });
  }

  function clearSensitive() {
    search.reset();
    searchPanel.setValue('');
    app.selectedId = null;
    app.userChose = false;
    app.notice = null;
    app.slip = null;
    app.extraBanners = [];
    clearPrintArea();
    confirm.cancel();
    recordsDialog.close();
    blankDesk();
  }

  function onAuthChange(a) {
    if (a.status === AuthStatus.SignedIn) {
      lockDialog.hide();
      showScreen('desk');
      startEventTimer();
      refreshEvent();
      scheduleRender();
      queueMicrotask(() => searchPanel.focus());
    } else if (a.status === AuthStatus.Locked) {
      stopEventTimer();
      clearSensitive(); // no member data stays on the screen while it is locked
      showScreen('locked');
      lockDialog.show({ username: a.username, displayName: a.displayName, reason: a.lockReason, idleMinutes: cfg.idleLockMinutes });
      scheduleRender();
    } else {
      stopEventTimer();
      clearSensitive();
      showScreen('login');
    }
  }

  async function signOut() {
    const c = records.counts();
    if (c.unacknowledged > 0 || c.sending > 0) {
      const open = c.unacknowledged + c.sending;
      const sure = await confirm.ask({
        title: 'Sign out?',
        message: `${open === 1 ? 'One QR issuance record still needs' : `${open} QR issuance records still need`} attention. Signing out discards the records of this session (the server keeps what it recorded).\n\nSign out anyway?`,
        confirmText: 'Sign out',
        cancelText: 'Stay signed in',
        danger: true,
      });
      if (!sure) return;
    }
    auth.signOut();
    records.clear();
    login.clear();
    clearPrintArea();
    // a fresh page: nothing of this session stays in memory for the next person at this PC
    window.location.reload();
  }

  // ── the open election ───────────────────────────────────────────────────────────────────────────────
  function startEventTimer() {
    stopEventTimer();
    eventTimer = setInterval(() => refreshEvent(), cfg.eventRefreshSeconds * 1000);
  }
  function stopEventTimer() {
    if (eventTimer !== null) clearInterval(eventTimer);
    eventTimer = null;
  }

  let eventSeen = false;
  async function refreshEvent({ manual = false } = {}) {
    if (auth.state.status !== AuthStatus.SignedIn) return;
    if (manual) connectivity.hint(); // Refresh also looks at the connection again
    const r = await api.getCurrentEvent();
    if (auth.state.status !== AuthStatus.SignedIn) return;

    if (r.ok) {
      const previousId = app.event ? app.event.eventId : null;
      app.event = r.event;
      app.eventStatus = r.event ? 'open' : 'none';
      app.eventMessage = '';
      const nextId = r.event ? r.event.eventId : null;
      if (eventSeen && nextId !== previousId) onElectionChanged(r.event);
      eventSeen = true;
    } else if (r.failure.kind !== FailureKind.Cancelled) {
      // A blip (no answer, a 5xx, a rate limit) keeps the election that was open a moment ago; a refusal does not
      // (showing an old election after the server said no could mislead staff).
      const keep = r.failure.noResponseFromServer || r.failure.kind === FailureKind.Server || r.failure.kind === FailureKind.RateLimited || r.failure.isConfigurationProblem;
      if (!keep) app.event = null;
      app.eventStatus = keep && app.event ? app.eventStatus : 'error';
      app.eventMessage = r.failure.message;
    }
    scheduleRender();
  }

  function onElectionChanged(event) {
    search.reset();
    searchPanel.setValue('');
    app.selectedId = null;
    app.notice = null;
    app.slip = null;
    clearPrintArea();
    app.extraBanners = [
      {
        key: `election-${event ? event.eventId : 'none'}`,
        title: event ? `The open election is now "${event.title}"` : 'The election is closed',
        detail: 'The search was cleared. Records of this session still list the election they were made under.',
      },
    ];
  }

  // ── searching and choosing ─────────────────────────────────────────────────────────────────────────
  function onSearchState(state) {
    app.search = state;
    const rows = state.members;
    const has = (id) => rows.some((m) => m.memberId === id);

    if (state.phase === 'results' || state.phase === 'loading') {
      if (state.phase === 'results' && rows.length === 1) {
        if (app.selectedId !== rows[0].memberId) app.userChose = false;
        app.selectedId = rows[0].memberId; // one match: it is the member in front of the desk
      } else if (app.selectedId != null && !has(app.selectedId)) {
        app.selectedId = null;
        app.userChose = false;
      }
    } else {
      app.selectedId = null;
      app.userChose = false;
    }
    dropSlipForOtherMember();
    scheduleRender();
  }

  /** The slip on screen belongs to the member it was issued to; once another member is in front of the desk it goes away ("Reprint" brings it back). */
  function dropSlipForOtherMember() {
    if (app.slip && app.selectedId != null && app.slip.memberId !== app.selectedId) {
      app.slip = null;
      clearPrintArea();
    }
  }

  function onInput(text) {
    if (app.notice) app.notice = null;
    search.queryChanged(text);
    scheduleRender();
  }

  function select(memberId, { chose = true } = {}) {
    app.selectedId = memberId;
    app.userChose = chose;
    dropSlipForOtherMember();
    scheduleRender();
  }

  function onSelect(memberId) {
    if (app.search.phase !== 'results') return;
    select(memberId);
    searchPanel.focus();
  }

  function onMove(delta) {
    if (app.search.phase !== 'results' || app.search.members.length === 0) return;
    const rows = app.search.members;
    const index = rows.findIndex((m) => m.memberId === app.selectedId);
    const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : (index + delta + rows.length) % rows.length;
    select(rows[next].memberId);
  }

  function onClear() {
    if (searchPanel.value.length > 0) {
      searchPanel.setValue('');
      search.reset();
      app.notice = null;
    } else {
      app.selectedId = null;
      app.userChose = false;
      app.notice = null;
    }
    scheduleRender();
    searchPanel.focus();
  }

  /** Enter in the search box: search now, then select - and, when it is unambiguous, issue. */
  async function onEnter() {
    if (app.issuing) return;
    const value = searchPanel.value;
    let st = search.state;
    if (st.phase === 'loading' || st.query !== value) {
      await search.searchNow(value); // skips the pause and waits for the server's answer
      st = search.state;
    }
    if (st.phase !== 'results' || st.members.length === 0) return;

    const rows = st.members;
    if (rows.length > 1 && app.selectedId == null) {
      select(rows[0].memberId); // several matches: the first Enter only points at the first one
      return;
    }
    const row = rows.find((m) => m.memberId === app.selectedId) ?? rows[0];
    if (rows.length === 1 && app.selectedId == null) select(row.memberId, { chose: false });

    if (row.kind !== EligibilityKind.Eligible) {
      app.notice = { kind: 'info', text: `${eligibilityHeadline(row.kind)}. ${eligibilityReason(row, app.event, row.kind)} No QR is issued.` };
      scheduleRender();
      return;
    }
    if (rows.length === 1 && !cfg.quickIssue && !app.userChose) {
      app.userChose = true; // quick issue is off: the first Enter confirms the choice, the second issues
      scheduleRender();
      return;
    }
    await issueSelected();
  }

  // ── issuing ─────────────────────────────────────────────────────────────────────────────────────────
  function selectedRow() {
    return app.search.members.find((m) => m.memberId === app.selectedId) ?? null;
  }

  async function issueSelected() {
    const row = selectedRow();
    if (!row || app.issuing || app.search.phase !== 'results') return;

    app.issuing = true;
    app.notice = null;
    render();
    try {
      let res = await issuer.issue(row);
      if (res.refusal === IssueRefusal.AlreadyIssued) {
        const when = issuer.effectiveQrIssuedAt(row);
        const text = when ? formatDateTime(parseServerUtc(when)) : 'earlier';
        const again = await confirm.ask({
          title: 'QR already issued',
          message: `${row.memberName} was already issued a QR (${text}).\n\nIssue and print another one?`,
          confirmText: 'Issue again',
          cancelText: 'Cancel',
        });
        if (!again) {
          app.notice = { kind: 'info', text: 'No new QR was issued.' };
          return;
        }
        res = await issuer.issue(row, { allowReissue: true });
      }
      handleIssueResult(row, res);
    } finally {
      app.issuing = false;
      scheduleRender();
      if (auth.state.status === AuthStatus.SignedIn && !confirm.el.open) searchPanel.focus();
    }
  }

  /** What to show after an attempt to issue (or to send again). */
  function handleIssueResult(row, res) {
    const name = res.record ? res.record.memberName : row.memberName;

    if (res.duplicate && res.issued) {
      app.notice = { kind: 'info', text: `A QR for ${name} was just issued. Use "Print again" if the slip did not come out.` };
      return;
    }
    if (res.duplicate) {
      app.notice = { kind: 'info', text: res.message };
      return;
    }
    if (!res.record) {
      // refused before anything was sent (not eligible, not active, no election...)
      app.notice = { kind: 'error', text: res.message };
      return;
    }
    if (res.issued && res.mayPrint) {
      onRecorded(res.record);
      return;
    }
    app.notice = problemNotice(res.record, res.message);
  }

  /** The red note under the member after an attempt the server did not record, with the two things that can be done about it. */
  function problemNotice(record, message) {
    const actions = [];
    if (record && record.state === RecordState.Unknown) actions.push({ key: `check:${record.id}`, label: 'Check with server' });
    if (record && (record.state === RecordState.Failed || record.state === RecordState.Unknown)) actions.push({ key: `retry:${record.id}`, label: 'Try again' });
    return { kind: 'error', text: record ? `${record.memberName}: ${message}` : message, actions };
  }

  /** What the staff are told after a slip was sent to the printer (or only shown, when auto-print is off). */
  const slipWords = () => (cfg.autoPrint ? 'The slip was sent to the printer.' : 'The slip is shown - press "Print again" to print it.');

  /** The server has recorded the issuance: show it, print it, get ready for the next member. */
  function onRecorded(record) {
    const atTheDesk = app.selectedId === record.memberId; // false when a "Try again" for an earlier member succeeds while another is being served
    search.patchMember(record.memberId, { qrIssuedAt: record.issuedAtUtc });
    app.notice = { kind: 'success', text: `QR issued for ${record.memberName}. Confirmed by the server.` };
    printRecord(record.id, { reprint: false });
    if (cfg.clearAfterIssue && atTheDesk) {
      search.reset();
      searchPanel.setValue('');
      app.selectedId = null;
      app.userChose = false;
    }
  }

  function printRecord(recordId, { reprint }) {
    const record = records.get(recordId);
    if (!record || record.state !== RecordState.Confirmed) return;
    const model = buildSlipModel(record, { reprint });
    app.slip = { recordId, memberId: record.memberId, key: `${recordId}:${reprint ? 'reprint' : 'first'}:${++app.printSeq}`, model, message: '' };
    render(); // the slip must be drawn before the print dialog freezes the page

    if (!cfg.autoPrint && !reprint) return; // shown only: printed with "Print again"
    const r = printSlip(model);
    if (r.ok) issuer.notePrinted(recordId);
    else app.slip = { ...app.slip, message: `The slip could not be printed (${r.message}). The QR is recorded. Use "Print again" when the printer is ready.` };
    scheduleRender();
  }

  async function retryRecord(id, { fromDialog = false } = {}) {
    if (app.issuing) return;
    app.issuing = true;
    app.notice = null;
    render();
    try {
      const res = await issuer.retry(id);
      if (res.issued && res.mayPrint) {
        onRecorded(res.record);
        if (fromDialog) recordsDialog.notify(`Recorded by the server: ${res.record.memberName}. ${slipWords()}`);
      } else {
        app.notice = res.duplicate ? { kind: 'info', text: res.message } : problemNotice(res.record, res.message);
        if (fromDialog) recordsDialog.notify(res.message);
      }
    } finally {
      app.issuing = false;
      scheduleRender();
    }
  }

  /** "Check with server": did the request whose answer never came back take effect? */
  async function checkRecord(id, { fromDialog = false } = {}) {
    if (fromDialog) recordsDialog.notify('Asking the server…');
    const r = await issuer.verify(id);
    if (r.confirmed) {
      onRecorded(r.record);
      if (fromDialog) recordsDialog.notify(`${r.message} ${slipWords()}`);
    } else {
      if (fromDialog) recordsDialog.notify(r.message);
      else app.notice = problemNotice(records.get(id) ?? r.record, r.message);
    }
    scheduleRender();
  }

  function onNoticeAction(key) {
    const cut = key.indexOf(':');
    const action = key.slice(0, cut);
    const id = key.slice(cut + 1);
    if (action === 'retry') retryRecord(id);
    else if (action === 'check') checkRecord(id);
  }

  function onBannerAction(key) {
    if (key === BannerActions.ReviewRecords) recordsDialog.open({ initialMode: 'attention' });
    else if (key === BannerActions.Refresh) refreshEvent({ manual: true });
  }

  // ── the page itself ─────────────────────────────────────────────────────────────────────────────────
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(type, () => auth.touch(), { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    auth.check();
    connectivity.hint();
    if (auth.state.status === AuthStatus.SignedIn) refreshEvent();
  });
  window.addEventListener('online', () => connectivity.hint());
  window.addEventListener('offline', () => connectivity.hint());
  window.addEventListener('afterprint', () => clearPrintArea());
  window.addEventListener('beforeunload', (e) => {
    const c = records.counts();
    if (auth.state.status !== AuthStatus.SignedOut && (c.sending > 0 || c.unacknowledged > 0)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (auth.state.status !== AuthStatus.SignedIn) return;
    if (e.key === 'F5' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault(); // F5 asks the server about the election again; it must not throw away the session by reloading the page
      refreshEvent({ manual: true });
    } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      searchPanel.focus();
    }
  });

  showScreen('login');
  connectivity.start();
  queueMicrotask(() => login.focus());
  scheduleRender();

  return { app, auth, api, records, issuer, search, connectivity, render };
}

if (typeof document !== 'undefined' && document.getElementById('app')) start();
