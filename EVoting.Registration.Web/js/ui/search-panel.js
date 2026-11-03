// Search box + result list. The input drives the list like a combobox: typing searches, Up/Down move the selection, Enter issues
// (see main.js for the rules), Esc clears. Rows are options of a listbox and contain no buttons of their own: every action
// (Issue QR, Print again) lives in the detail panel, so the whole flow works from the keyboard without leaving the box.

import {
  EligibilityKind,
  describeSearch,
  fold,
  matchRanges,
  qrText,
  splitByRanges,
} from '../format.js';
import { h, markedText, setChildren, setHidden, setText } from './dom.js';

const BADGE = {
  [EligibilityKind.Eligible]: { icon: '✔', text: 'Eligible' },
  [EligibilityKind.NotEligible]: { icon: '✗', text: 'Not eligible' },
  [EligibilityKind.Inactive]: { icon: '!', text: 'Inactive' },
  [EligibilityKind.BranchNotInElection]: { icon: '!', text: 'Other branch' },
};

export const optionId = (memberId) => `opt-${memberId}`;

/**
 * @param {object} options
 * @param {(text: string) => void} options.onInput
 * @param {() => void} options.onEnter
 * @param {(delta: number) => void} options.onMove     Up/Down: -1 / +1
 * @param {(memberId: number) => void} options.onSelect  a row was clicked
 * @param {() => void} options.onClear
 * @param {() => void} options.onRetry
 */
export function createSearchPanel({ onInput, onEnter, onMove, onSelect, onClear, onRetry }) {
  let inputEl;
  let clearBtn;
  let statusEl;
  let retryBtn;
  let listEl;
  let lastKey = '';

  const el = h(
    'section',
    { class: 'search', 'aria-labelledby': 'search-label' },
    h('label', { id: 'search-label', class: 'search-label', for: 'search-input' }, 'Find a member'),
    h(
      'div',
      { class: 'search-row' },
      (inputEl = h('input', {
        id: 'search-input',
        class: 'search-input',
        type: 'text',
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-controls': 'results',
        'aria-describedby': 'search-hint search-status',
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        enterkeyhint: 'search',
        placeholder: 'Name or account code',
        oninput: () => {
          setHidden(clearBtn, inputEl.value.length === 0);
          onInput(inputEl.value);
        },
        onkeydown: (e) => {
          if (e.isComposing) return; // an input method is still building a character
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onMove(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            onMove(-1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClear();
          }
        },
      })),
      (clearBtn = h('button', { type: 'button', class: 'btn btn-quiet', hidden: true, onclick: () => onClear() }, 'Clear')),
    ),
    h('p', { id: 'search-hint', class: 'search-hint' }, 'Eligible and not eligible members are both listed. Enter issues the QR when only one member matches.'),
    h(
      'div',
      { class: 'search-status-row' },
      (statusEl = h('p', { id: 'search-status', class: 'search-status', role: 'status' })),
      (retryBtn = h('button', { type: 'button', class: 'btn btn-small', hidden: true, onclick: () => onRetry() }, 'Search again')),
    ),
    (listEl = h('ul', {
      id: 'results',
      class: 'results',
      role: 'listbox',
      'aria-label': 'Members found',
      // Clicking a row must not take the focus out of the search box (the next keystroke belongs there).
      onmousedown: (e) => e.preventDefault(),
      onclick: (e) => {
        const li = e.target.closest?.('li[data-member-id]');
        if (li) onSelect(Number(li.dataset.memberId));
      },
    })),
  );

  function renderRow(m, foldedQuery, selected) {
    const badge = BADGE[m.kind] ?? BADGE[EligibilityKind.Inactive];
    const nameParts = splitByRanges(m.memberName, matchRanges(m.memberName, foldedQuery));
    const codeParts = splitByRanges(m.accountCode, matchRanges(m.accountCode, foldedQuery));
    return h(
      'li',
      {
        id: optionId(m.memberId),
        class: ['result', selected && 'is-selected'],
        role: 'option',
        'aria-selected': selected ? 'true' : 'false',
        dataset: { memberId: m.memberId, kind: m.kind },
      },
      h(
        'div',
        { class: 'result-main' },
        h('span', { class: 'result-name' }, markedText(nameParts)),
        h('span', { class: 'result-meta' }, h('span', { class: 'result-code' }, markedText(codeParts)), h('span', { class: 'result-branch' }, m.branch || '—')),
      ),
      h(
        'div',
        { class: 'result-side' },
        h('span', { class: 'badge', dataset: { kind: m.kind } }, h('span', { 'aria-hidden': 'true' }, badge.icon), ` ${badge.text}`),
        m.qrIssuedAt ? h('span', { class: 'result-qr' }, qrText(m.qrIssuedAt)) : null,
      ),
    );
  }

  return {
    el,
    input: inputEl,
    focus: () => inputEl.focus(),
    get value() {
      return inputEl.value;
    },
    setValue(text) {
      inputEl.value = text;
      setHidden(clearBtn, text.length === 0);
    },
    /** @param {{search: object, selectedId: (number|null)}} view */
    update({ search, selectedId }) {
      // Unchanged answer and selection (a heartbeat or a clock tick redrew the page): leave the list alone, so a row being
      // pointed at or scrolled to is not rebuilt underneath the person.
      const key = `${search.sequence}|${selectedId}`;
      if (search.sequence !== undefined && key === lastKey) return;
      lastKey = key;

      const rows = search.members ?? [];
      const folded = search.foldedQuery || fold(search.query);
      const pending = search.phase === 'loading';

      setChildren(
        listEl,
        rows.map((m) => renderRow(m, folded, m.memberId === selectedId)),
      );
      listEl.classList.toggle('is-pending', pending);
      listEl.setAttribute('aria-busy', String(pending));
      const open = rows.length > 0;
      inputEl.setAttribute('aria-expanded', String(open));
      if (selectedId != null && rows.some((m) => m.memberId === selectedId)) inputEl.setAttribute('aria-activedescendant', optionId(selectedId));
      else inputEl.removeAttribute('aria-activedescendant');

      setText(statusEl, describeSearch({ ...search, members: rows }));
      statusEl.classList.toggle('is-error', search.phase === 'error');
      setHidden(retryBtn, search.phase !== 'error');

      if (selectedId != null) {
        const li = listEl.querySelector(`#${optionId(selectedId)}`);
        li?.scrollIntoView({ block: 'nearest' });
      }
    },
  };
}
