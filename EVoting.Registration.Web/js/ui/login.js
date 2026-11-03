// The sign-in screen: user name + password (registration-login). Nothing about the person is remembered by the browser page.

import { Reachability } from '../connectivity.js';
import { h, setText } from './dom.js';

/**
 * @param {object} options
 * @param {(username: string, password: string) => Promise<{ok: boolean, message?: string, cooldownSeconds?: number}>} options.onSignIn
 * @param {string} options.serverLabel   the host the page talks to, for the person to see
 */
export function createLoginView({ onSignIn, serverLabel }) {
  let userEl;
  let passEl;
  let errorEl;
  let submitBtn;
  let toggleBtn;
  let serverEl;
  let busy = false;
  let cooldownTimer = null;
  let cooldownUntil = 0;

  const el = h(
    'main',
    { class: 'login', id: 'main' },
    h(
      'div',
      { class: 'login-panel' },
      h('h1', { class: 'login-title' }, 'Registration desk'),
      h('p', { class: 'login-lead' }, 'Sign in with your user name and password to register members and issue their voting QR.'),
      h(
        'form',
        {
          class: 'login-form',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            if (busy || Date.now() < cooldownUntil) return;
            const username = userEl.value;
            const password = passEl.value;
            setBusy(true);
            setText(errorEl, '');
            let result;
            try {
              result = await onSignIn(username, password);
            } finally {
              setBusy(false);
            }
            if (result && result.ok) {
              // signed in: the password must not stay in the (now hidden) form
              passEl.value = '';
              userEl.value = '';
              showPassword(false);
            } else if (result) {
              setText(errorEl, result.message || 'Could not sign in.');
              passEl.value = '';
              if (result.cooldownSeconds) startCooldown(result.cooldownSeconds);
              (username.trim() ? passEl : userEl).focus();
            }
          },
        },
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'login-user' }, 'User name'),
          (userEl = h('input', {
            id: 'login-user',
            name: 'username',
            type: 'text',
            autocomplete: 'username',
            autocapitalize: 'off',
            spellcheck: 'false',
            required: true,
          })),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'login-password' }, 'Password'),
          h(
            'div',
            { class: 'password-row' },
            (passEl = h('input', { id: 'login-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
            (toggleBtn = h(
              'button',
              {
                type: 'button',
                class: 'btn btn-quiet btn-small',
                'aria-controls': 'login-password',
                'aria-pressed': 'false',
                onclick: () => {
                  showPassword(passEl.type !== 'text');
                  passEl.focus();
                },
              },
              'Show',
            )),
          ),
        ),
        (errorEl = h('p', { class: 'form-error', role: 'alert' })),
        (submitBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-wide' }, 'Sign in')),
      ),
      h(
        'p',
        { class: 'login-server', role: 'status' },
        h('span', { class: 'login-server-label' }, 'Server '),
        h('span', { class: 'login-server-host' }, serverLabel),
        ' ',
        (serverEl = h('span', { class: 'login-server-state' }, 'checking…')),
      ),
      h('p', { class: 'login-note' }, 'This browser version needs the internet. When it is down, use the Windows Registration station.'),
    ),
  );

  function showPassword(show) {
    passEl.type = show ? 'text' : 'password';
    toggleBtn.setAttribute('aria-pressed', String(show));
    setText(toggleBtn, show ? 'Hide' : 'Show');
  }

  function setBusy(value) {
    busy = value;
    submitBtn.disabled = value || Date.now() < cooldownUntil;
    setText(submitBtn, value ? 'Signing in…' : 'Sign in');
  }

  function startCooldown(seconds) {
    cooldownUntil = Date.now() + seconds * 1000;
    submitBtn.disabled = true;
    const tick = () => {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        submitBtn.disabled = busy;
        setText(submitBtn, 'Sign in');
        return;
      }
      setText(submitBtn, `Try again in ${left}s`);
    };
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(tick, 500);
    tick();
  }

  return {
    el,
    focus() {
      (userEl.value ? passEl : userEl).focus();
    },
    /** Shows whether the server answers, before anybody has typed a password. */
    setConnectivity(c) {
      const text =
        c.status === Reachability.Online ? 'reachable' : c.status === Reachability.Offline ? 'not reachable' : 'checking…';
      setText(serverEl, text);
      serverEl.dataset.state = c.status;
    },
    /** Forgets what was typed (the page is being left). */
    clear() {
      userEl.value = '';
      passEl.value = '';
      setText(errorEl, '');
    },
  };
}
