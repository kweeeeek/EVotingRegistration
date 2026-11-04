// The breakages for run-mutations.mjs. Each one breaks exactly ONE promise of the page: `edits` replace a text in a file of the COPY (the text must
// occur exactly `count` times, default 1 - otherwise the code has changed and the entry must be updated; the runner reports that as ERROR), and
// `e2e` is the `--only` text of the browser tests that should notice (without it only the unit tests run). A breakage nobody notices is a hole in
// the tests - or an equivalent change that no test could ever see (M25: see docs/WEB-VERIFICATION.md).

const A = 'js/api.js';

export const MUTATIONS = [
  // ── how requests leave the page ─────────────────────────────────────────────────────────────────────
  { id: 'M01', what: "api.js: cookies are sent (credentials 'omit' -> 'include')", edits: [{ file: A, find: "        credentials: 'omit',\n        redirect: 'error',", replace: "        credentials: 'include',\n        redirect: 'error'," }], e2e: 'security:' },
  { id: 'M02', what: "api.js: redirects are followed (redirect 'error' -> 'follow')", edits: [{ file: A, find: "redirect: 'error',", replace: "redirect: 'follow'," }], e2e: 'a redirect from the server' },
  { id: 'M03', what: "api.js: the page address is sent as Referer (referrerPolicy -> 'origin')", edits: [{ file: A, find: "referrerPolicy: 'no-referrer'", replace: "referrerPolicy: 'origin'", count: 2 }], e2e: 'security: only this site' },
  { id: 'M04', what: "api.js: the browser may cache answers (cache 'no-store' -> 'default')", edits: [{ file: A, find: "cache: 'no-store'", replace: "cache: 'default'", count: 3 }] },
  { id: 'M05', what: 'api.js: a look-alike address is taken for the page\'s own (origin boundary removed)', edits: [{ file: A, find: 'if (blocked === origin || blocked.startsWith(`${origin}/`)) {', replace: 'if (blocked.startsWith(origin)) {' }] },
  { id: 'M06', what: 'api.js: wrong authorization scheme (Bearer -> Token)', edits: [{ file: A, find: 'headers.Authorization = `Bearer ${token}`;', replace: 'headers.Authorization = `Token ${token}`;' }], e2e: 'smoke: sign in' },
  { id: 'M07', what: 'api.js: the token is also put in the address (?access_token=)', edits: [{ file: A, find: 'headers.Authorization = `Bearer ${token}`;', replace: "headers.Authorization = `Bearer ${token}`;\n      url.searchParams.set('access_token', token);" }], e2e: 'security: only this site' },
  { id: 'M11', what: 'api.js: a 401 no longer locks the screen', edits: [{ file: A, find: 'if (unauthorized) onUnauthorized?.();', replace: 'if (unauthorized) { /* ignored */ }' }], e2e: 'when the server refuses the token' },

  // ── session ─────────────────────────────────────────────────────────────────────────────────────────
  { id: 'M08', what: 'auth.js: the idle lock never happens', edits: [{ file: 'js/auth.js', find: 'if (idleMs > 0 && current - state.lastActivityAt >= idleMs) lock(LockReason.Idle);', replace: '/* idle lock removed */' }], e2e: 'ten minutes without a key' },
  { id: 'M09', what: 'auth.js: the screen locks 30 s AFTER the token ran out, not before', edits: [{ file: 'js/auth.js', find: 'if (current >= state.expiresAt - EXPIRY_MARGIN_MS) {', replace: 'if (current >= state.expiresAt + EXPIRY_MARGIN_MS) {' }], e2e: 'about to run out' },
  { id: 'M10', what: 'auth.js: locking keeps the token in memory', edits: [{ file: 'js/auth.js', find: 'token = null; // the token is gone: nothing on this page can call the server until the password is typed again', replace: '/* token kept */' }], e2e: 'session: Lock hides' },
  { id: 'M29', what: 'auth.js: the token is also written to localStorage', edits: [{ file: 'js/auth.js', find: 'token = r.accessToken;', replace: "token = r.accessToken;\n    localStorage.setItem('t', token);" }], e2e: 'nothing about the person' },

  // ── QR and slip ─────────────────────────────────────────────────────────────────────────────────────
  { id: 'M12', what: "qr.js: error correction level M -> L", edits: [{ file: 'js/qr.js', find: "export const ECC_LEVEL = 'M';", replace: "export const ECC_LEVEL = 'L';" }], e2e: 'issue: Enter on a single match' },
  { id: 'M13', what: 'format.js: the QR content is no longer upper-cased', edits: [{ file: 'js/format.js', find: 'const up = ch.toUpperCase();', replace: 'const up = ch;' }] },
  { id: 'M14', what: 'format.js: the QR content is no longer trimmed', edits: [{ file: 'js/format.js', find: "const trimmed = (accountCode == null ? '' : String(accountCode)).trim();", replace: "const trimmed = (accountCode == null ? '' : String(accountCode));" }] },
  { id: 'M15', what: 'qr.js: quiet zone 4 -> 1 module', edits: [{ file: 'js/qr.js', find: 'export const QUIET_ZONE_MODULES = 4;', replace: 'export const QUIET_ZONE_MODULES = 1;' }], e2e: 'print:' },

  // ── issuing ─────────────────────────────────────────────────────────────────────────────────────────
  { id: 'M17', what: 'issue.js: a slip may be printed when the server did NOT record the QR', edits: [{ file: 'js/issue.js', find: 'return { issued: false, refusal: IssueRefusal.None, message, record: updated, mayPrint: false, duplicate: false, failure: f };', replace: 'return { issued: false, refusal: IssueRefusal.None, message, record: updated, mayPrint: true, duplicate: false, failure: f };' }], e2e: 'issue: no answer from the server' },
  { id: 'M18', what: 'issue.js: a second QR is issued without asking', edits: [{ file: 'js/issue.js', find: 'if (member.qrIssuedAt && !allowReissue) return {', replace: 'if (false) return {' }], e2e: 'already has a QR is asked' },
  { id: 'M19', what: 'issue.js: a double Enter issues twice (busy guard removed)', edits: [{ file: 'js/issue.js', find: 'if (sending) {', replace: 'if (false) {' }], e2e: 'a double Enter' },
  { id: 'M20', what: 'issue.js: a member the server does not know is "failed" instead of "rejected"', edits: [{ file: 'js/issue.js', find: 'state = RecordState.Rejected;', replace: 'state = RecordState.Failed;' }], e2e: 'a member the server no longer knows' },
  { id: 'M21', what: 'issue.js: "Check with server" takes any earlier QR time as proof of this issuance', edits: [{ file: 'js/issue.js', find: 'const changed = member.qrIssuedAt && member.qrIssuedAt !== record.qrIssuedAtBefore;', replace: 'const changed = Boolean(member.qrIssuedAt);' }], e2e: 'when the server has nothing' },
  { id: 'M46', what: 'main.js: a slip is shown/printed even when the issue was refused or not recorded', edits: [{ file: 'js/main.js', find: 'if (res.issued && res.mayPrint) {', replace: 'if (res.mayPrint !== undefined) {', count: 2 }], e2e: 'issue:' },

  // ── search ──────────────────────────────────────────────────────────────────────────────────────────
  { id: 'M22', what: 'search.js: an older answer that arrives late replaces the newer one', edits: [{ file: 'js/search.js', find: 'if (v !== version || own.signal.aborted) return;', replace: 'if (false) return;' }], e2e: 'only the answer to the LATEST text' },
  { id: 'M23', what: 'format.js: one character is enough to search (MIN_QUERY_LENGTH 2 -> 1)', edits: [{ file: 'js/format.js', find: 'export const MIN_QUERY_LENGTH = 2;', replace: 'export const MIN_QUERY_LENGTH = 1;' }], e2e: 'fewer than two characters' },
  { id: 'M24', what: 'search.js: no debounce - every keystroke is sent', edits: [{ file: 'js/search.js', find: '    if (debounce) {\n      const completed', replace: '    if (false) {\n      const completed' }], e2e: 'typing a whole name in one go' },

  // ── connection ──────────────────────────────────────────────────────────────────────────────────────
  { id: 'M25', what: 'connectivity.js: a "look again" asked while a look is on its way is lost', edits: [{ file: 'js/connectivity.js', find: 'if (force) lookAgain = true;', replace: '/* lost */' }] },
  { id: 'M26', what: 'connectivity.js: scheduling the next look does not drop the one waiting (two loops)', edits: [{ file: 'js/connectivity.js', find: 'function schedule(ms, fn) {\n    if (timerId !== null) t.clear(timerId);', replace: 'function schedule(ms, fn) {' }] },

  // ── nothing becomes markup ──────────────────────────────────────────────────────────────────────────
  { id: 'M28', what: 'dom.js: text is inserted as markup (insertAdjacentHTML)', edits: [{ file: 'js/ui/dom.js', find: "el.appendChild(el.ownerDocument.createTextNode(String(child)));", replace: "el.insertAdjacentHTML('beforeend', String(child));" }], e2e: 'text from the server is only ever text' },
  { id: 'M43', what: 'tools/lint.mjs: innerHTML is no longer on the forbidden list', edits: [{ file: 'tools/lint.mjs', find: "  innerHTML: 'turns a string into markup (cross-site scripting)',\n", replace: '' }] },

  // ── printing ────────────────────────────────────────────────────────────────────────────────────────
  { id: 'M30', what: 'app.css: while printing the desk is NOT hidden', edits: [{ file: 'css/app.css', find: '  #app {\n    display: none !important;\n  }\n', replace: '' }], e2e: 'print:' },
  { id: 'M31', what: 'app.css: the printed slip is a fixed 80 mm wide (QR is cut or shrunk on narrower paper)', edits: [{ file: 'css/app.css', find: '    width: 100%;\n    max-width: 80mm;\n    padding: 3mm 4mm 6mm;', replace: '    width: 80mm;\n    padding: 3mm 4mm 6mm;' }], e2e: 'print:' },
  { id: 'M32', what: 'app.css: @page declares a paper size', edits: [{ file: 'css/app.css', find: '@page {\n  margin: 0;\n}', replace: '@page {\n  size: 80mm auto;\n  margin: 0;\n}' }], e2e: 'print:' },
  { id: 'M33', what: 'app.css: the print area is visible on screen', edits: [{ file: 'css/app.css', find: '#print-root {\n  display: none;\n}', replace: '#print-root {\n  display: block;\n}' }], e2e: 'print:' },
  { id: 'M48', what: 'main.js: the slip stays in the print area when the screen locks / signs out (clearSensitive)', edits: [{ file: 'js/main.js', find: '    app.extraBanners = [];\n    clearPrintArea();\n    confirm.cancel();', replace: '    app.extraBanners = [];\n    confirm.cancel();' }], e2e: 'print:' },
  { id: 'M49', what: 'main.js: the print area is not cleared after printing (afterprint)', edits: [{ file: 'js/main.js', find: "window.addEventListener('afterprint', () => clearPrintArea());", replace: "window.addEventListener('afterprint', () => {});" }], e2e: 'print:' },

  // ── colour ──────────────────────────────────────────────────────────────────────────────────────────
  { id: 'M34', what: 'app.css: --forest is sea green, not forest green', edits: [{ file: 'css/app.css', find: '--forest: #228b22;', replace: '--forest: #2e8b57;' }], e2e: 'theme:' },
  { id: 'M35', what: 'app.css: the thin line across the top of every screen is the dark green', edits: [{ file: 'css/app.css', find: '  border-top: 3px solid var(--forest);', replace: '  border-top: 3px solid var(--forest-ink);' }], e2e: 'theme:' },
  { id: 'M36', what: 'app.css: the main buttons are the dark green', edits: [{ file: 'css/app.css', find: '.btn-primary {\n  background: var(--forest-button);\n  border-color: var(--forest-button);', replace: '.btn-primary {\n  background: var(--forest-press);\n  border-color: var(--forest-press);' }], e2e: 'theme:' },
  { id: 'M37', what: 'index.html: the browser bar colour is another green', edits: [{ file: 'index.html', find: '<meta name="theme-color" content="#228b22">', replace: '<meta name="theme-color" content="#2e8b57">' }], e2e: 'theme:' },
  { id: 'M38', what: 'app.css: the brand name in the top bar sits directly on plain forest green (4.39:1) in small white type', edits: [{ file: 'css/app.css', find: '  padding-left: 1.875rem;\n  color: var(--forest-ink);', replace: '  padding-left: 1.875rem;\n  background: var(--forest);\n  color: #ffffff;' }], e2e: 'theme:' },

  // ── type, focus and sizes of the new look ───────────────────────────────────────────────────────────
  { id: 'M52', what: 'app.css: headings, names and labels are bold (700) again', edits: [{ file: 'css/app.css', find: 'th,\nsummary {\n  font-weight: 600;\n}', replace: 'th,\nsummary {\n  font-weight: 700;\n}' }], e2e: 'type:' },
  { id: 'M53', what: 'app.css: the base type is 16 px again (it is 14 px)', edits: [{ file: 'css/app.css', find: '  --text-md: 0.875rem;', replace: '  --text-md: 1rem;' }], e2e: 'type:' },
  { id: 'M54', what: 'app.css: the face is not Segoe UI any more', edits: [{ file: 'css/app.css', find: "  --font: 'Segoe UI', system-ui,", replace: "  --font: 'Atkinson Hyperlegible', system-ui," }], e2e: 'type:' },
  { id: 'M55', what: 'app.css: a text box in focus gets the heavy green ring around it again', edits: [{ file: 'css/app.css', find: '  outline: 2px solid transparent;\n  outline-offset: 1px;', replace: '  outline: 2px solid var(--focus);\n  outline-offset: 1px;' }], e2e: 'focus: a text box' },
  { id: 'M56', what: 'app.css: a text box in focus gets a green glow around it again', edits: [{ file: 'css/app.css', find: "input[type='password']:focus-visible {\n  border-color: var(--forest);", replace: "input[type='password']:focus-visible {\n  border-color: var(--forest);\n  box-shadow: 0 0 0 3px var(--forest-wash);" }], e2e: 'focus: a text box' },
  { id: 'M57', what: 'app.css: the pointer over a text box in focus turns its green edge grey (the focus rule is less specific than the hover rule)', edits: [{ file: 'css/app.css', find: "input[type='text']:focus-visible,\ninput[type='password']:focus-visible {", replace: 'input:focus-visible {' }], e2e: 'focus: a text box' },
  { id: 'M58', what: 'login.js + main.js: the address of the server is shown on the sign-in screen again', edits: [{ file: 'js/ui/login.js', find: 'export function createLoginView({ onSignIn }) {', replace: 'export function createLoginView({ onSignIn, serverLabel }) {' }, { file: 'js/ui/login.js', find: "h('span', { class: 'login-server-label' }, 'Server'),", replace: "h('span', { class: 'login-server-label' }, `Server ${serverLabel}`)," }, { file: 'js/main.js', find: 'createLoginView({ onSignIn })', replace: 'createLoginView({ onSignIn, serverLabel: new URL(base).host })' }], e2e: 'the foot of the screen' },
  { id: 'M59', what: 'login.js: the "use the Windows Registration station" note is shown while the server answers', edits: [{ file: 'js/ui/login.js', find: '      setHidden(noteEl, c.status !== Reachability.Offline);', replace: '      setHidden(noteEl, false);' }], e2e: 'the foot of the screen' },
  { id: 'M60', what: 'app.css: the green tile with a tick is back above the title of the sign-in', edits: [{ file: 'css/app.css', find: '.login-lead {', replace: ".login-title::before {\n  content: '';\n  display: block;\n  width: 2.5rem;\n  height: 2.5rem;\n  background: var(--forest);\n}\n.login-lead {" }], e2e: 'the sign-in has nothing above' },
  { id: 'M61', what: 'app.css: the names in the search results are in 16 px again', edits: [{ file: 'css/app.css', find: '.result-name {\n  display: block;\n  font-size: var(--text-sm);', replace: '.result-name {\n  display: block;\n  font-size: var(--text-lg);' }], e2e: 'size:' },
  { id: 'M62', what: 'app.css: the rows of the search results are tall again (62 px instead of 45)', edits: [{ file: 'css/app.css', find: '  padding: 0.3125rem 0.875rem 0.3125rem 0.6875rem;', replace: '  padding: 0.625rem 1rem 0.625rem 0.8125rem;' }], e2e: 'size:' },
  { id: 'M63', what: 'app.css: the text boxes are 40 px high again (they are 32 px)', edits: [{ file: 'css/app.css', find: '  min-height: 2rem;\n  padding: 0.25rem 0.625rem;\n  font: inherit;', replace: '  min-height: 2.5rem;\n  padding: 0.5rem 0.75rem;\n  font: inherit;' }], e2e: 'size:' },
  { id: 'M64', what: 'app.css: the type in the search box is 16 px again (it is 14 px)', edits: [{ file: 'css/app.css', find: '  padding-left: 2.375rem;\n  font-size: var(--text-md);', replace: '  padding-left: 2.375rem;\n  font-size: var(--text-lg);' }], e2e: 'size:' },
  { id: 'M65', what: 'app.css: the label of the main button is pale green on forest green (the accessibility audit, which leaves the main button out of the contrast rule, must still object)', edits: [{ file: 'css/app.css', find: '  border-color: var(--forest-button);\n  color: #ffffff;', replace: '  border-color: var(--forest-button);\n  color: #cfe8cf;' }], e2e: 'a11y: the sign-in screen' },

  // ── policy, headers, tools ──────────────────────────────────────────────────────────────────────────
  { id: 'M39', what: "index.html: the policy allows inline script ('unsafe-inline')", edits: [{ file: 'index.html', find: "script-src 'self';", replace: "script-src 'self' 'unsafe-inline';" }] },
  { id: 'M40', what: "_headers: frame-ancestors 'none' removed (the page can be framed)", edits: [{ file: '_headers', find: " frame-ancestors 'none';", replace: '' }], e2e: 'cannot be shown inside another' },
  { id: 'M41', what: '_headers: X-Content-Type-Options removed', edits: [{ file: '_headers', find: '  X-Content-Type-Options: nosniff\n', replace: '' }], e2e: 'strict headers' },
  { id: 'M42', what: 'tools/set-api-url.mjs: _headers is not updated with the new address', edits: [{ file: 'tools/set-api-url.mjs', find: 'headers: headers === null ? null : replaceHeaderConnectSrc(headers, value),', replace: 'headers,' }] },
  { id: 'M44', what: 'config.js: a setting the page has no default for', edits: [{ file: 'config.js', find: '  clearAfterIssue: true,\n});', replace: '  clearAfterIssue: true,\n  newSetting: 5,\n});' }] },

  // ── added after the first run ─────────────────────────────────────────────────────────────────────────
  { id: 'M50', what: "api.js: with the page and the API on the same address, cookies of that address are sent ('omit' -> 'same-origin')", edits: [{ file: A, find: "        credentials: 'omit',\n        redirect: 'error',", replace: "        credentials: 'same-origin',\n        redirect: 'error'," }], e2e: 'security: with the page and /api/ on the same address' },
  { id: 'M25b', what: 'connectivity.js: a network hint that arrives while a look is on its way is lost', edits: [{ file: 'js/connectivity.js', find: '      if (pinging) {\n        lookAgain = true;\n        return;\n      }\n      schedule(0, () => heartbeat(true));', replace: '      if (pinging) return;\n      schedule(0, () => heartbeat(true));' }] },
  { id: 'M51', what: 'records-ui.js: "1 records need attention" (no singular)', edits: [{ file: 'js/ui/records-ui.js', find: "${n === 1 ? '1 record needs' : `${n} records need`}", replace: "${n} records need" }], e2e: 'sign out asks' },
];
