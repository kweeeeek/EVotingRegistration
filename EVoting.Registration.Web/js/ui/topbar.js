// The strip across the top of the desk (election, connection, who is signed in, Lock / Sign out) and the notices under it.

import { Reachability } from '../connectivity.js';
import { formatDateTime, formatTime, plural } from '../format.js';
import { Severity } from '../banners.js';
import { h, setChildren, setText } from './dom.js';

/** "Venue", "03 Nov 2026 08:00 - 17:00", "12 participating branches" - as separate pieces, not one long line. */
export function describeElection(event) {
  if (!event) return [];
  const parts = [];
  if (event.venue && event.venue.trim()) parts.push(event.venue.trim());
  if (event.scheduleFrom && event.scheduleTo) {
    const sameDay = event.scheduleFrom.toDateString() === event.scheduleTo.toDateString();
    parts.push(`${formatDateTime(event.scheduleFrom)} - ${sameDay ? formatTime(event.scheduleTo) : formatDateTime(event.scheduleTo)}`);
  }
  parts.push(plural(event.branchIds?.length ?? 0, 'participating branch', 'participating branches'));
  return parts;
}

/** Text and detail of the connection pill (the same words as the Windows station's status pill). */
export function describeConnection(c) {
  if (c.status === Reachability.Offline) {
    return { kind: 'offline', text: 'Offline', detail: c.offlineSince ? `The server has not answered since ${formatTime(new Date(c.offlineSince))}.` : 'The server is not answering.' };
  }
  if (c.status === Reachability.Online) {
    if (c.lastProblem) return { kind: 'problem', text: 'Online - server problem', detail: c.lastProblem.message };
    return { kind: 'online', text: 'Online', detail: c.lastContactAt ? `Last answer from the server at ${formatTime(new Date(c.lastContactAt))}.` : '' };
  }
  return { kind: 'connecting', text: 'Connecting…', detail: '' };
}

export function createTopbar({ onRefresh, onLock, onSignOut }) {
  let titleEl;
  let detailEl;
  let pillEl;
  let pillText;
  let userEl;

  const el = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-election' },
      h('h1', { class: 'topbar-brand' }, ''),
      (titleEl = h('p', { class: 'election-title' }, 'No election is open')),
      (detailEl = h('p', { class: 'election-detail' })),
    ),
    h(
      'div',
      { class: 'topbar-tools' },
      (pillEl = h('p', { class: 'pill', role: 'status', 'data-kind': 'connecting' }, h('span', { class: 'pill-dot', 'aria-hidden': 'true' }), (pillText = h('span', null, 'Connecting…')))),
      h('p', { class: 'topbar-user' }, 'Signed in as ', (userEl = h('strong', null, ''))),
      h(
        'div',
        { class: 'topbar-buttons' },
        h('button', { type: 'button', class: 'btn btn-quiet btn-small', title: 'Look at the election again (F5)', onclick: () => onRefresh() }, 'Refresh'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-small', title: 'Hide the member list until you sign in again', onclick: () => onLock() }, 'Lock'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => onSignOut() }, 'Sign out'),
      ),
    ),
  );

  return {
    el,
    update({ event, eventStatus, connectivity, displayName }) {
      setText(titleEl, event ? event.title : eventStatus === 'none' ? 'No election is open' : eventStatus === 'error' ? 'Election unknown' : 'Looking for the open election…');
      const parts = describeElection(event);
      setChildren(
        detailEl,
        parts.map((p) => h('span', null, p)),
      );
      const c = describeConnection(connectivity);
      pillEl.dataset.kind = c.kind;
      pillEl.title = c.detail;
      setText(pillText, c.text);
      setText(userEl, displayName);
    },
  };
}

/** The notices. Critical ones are announced at once (role=alert), the rest politely. */
export function createBannerList({ onAction, onDismiss }) {
  const el = h('div', { class: 'banners', id: 'banners' });
  return {
    el,
    update(banners) {
      setChildren(
        el,
        banners.map((b) =>
          h(
            'section',
            { class: `banner banner-${b.severity === Severity.Critical ? 'critical' : b.severity === Severity.Warning ? 'warning' : 'info'}`, role: b.severity === Severity.Critical ? 'alert' : 'status', dataset: { key: b.key } },
            h('div', { class: 'banner-text' }, h('p', { class: 'banner-title' }, b.title), h('p', { class: 'banner-detail' }, b.detail)),
            h(
              'div',
              { class: 'banner-actions' },
              b.actionKey ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => onAction(b.actionKey) }, b.actionText) : null,
              b.canDismiss ? h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => onDismiss(b.key) }, 'Dismiss') : null,
            ),
          ),
        ),
      );
    },
  };
}
