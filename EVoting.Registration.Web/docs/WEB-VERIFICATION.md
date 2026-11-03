# Verification of the Registration web page

What was run, what each number means, how the tests themselves were tested, and what was **not** verified. Written on 3 November 2026 for the folder as delivered.

> **In one paragraph.** The page's logic, its safety rules, its look, its printing and the whole desk flow were run in a Linux sandbox: 593 unit tests (also in seven time zones),
> 97 tests in a real Chromium 153.0.8010.12 against a stand-in for the API under the page's real Content-Security-Policy, and a deployment test that runs the nginx example for real.
> The tests were then tested by breaking the code on purpose 48 times: 47 breakages are noticed, one cannot be (explained below). What the sandbox could **not** do is in section 5: the real API
> and its database, a real web host, a real receipt printer, a kiosk scanner reading a printed slip, any browser but Chromium, IIS. Those are the rows RW-6, RW-7, RW-12 of `../docs/09-REMAINING-RISKS.md` and the rows TW-01 to TW-12 and TW-30 to TW-35 of
> `../docs/08-DEPLOYMENT-AND-MANUAL-TESTS.md` §14 - do them before the first real election.

## 1. Where it ran

| | |
|---|---|
| Machine | a Linux sandbox, 2 CPUs, 8 GB |
| Node.js | 22.23.4 for the runs in this document (the page needs none). `package.json` asks for 22 or newer. Also run on Node 24.22.2: the 593 unit tests, the 97 browser tests, the 27 nginx checks and `npm run check` (all passed). On Node 20.20.2 only the 593 unit tests were run, with the file list given on the command line (all passed): `npm test` itself fails on Node 20, because it hands a file pattern to `node --test`, which Node 20 does not expand (Node 22 and 24 do) |
| Browser | Chromium 153.0.8010.12 through Playwright 1.63.0, headless |
| Test tools (dev only, pinned) | acorn 8.19.0 (reads the page's code for the safety checks), axe-core 4.14.0 (accessibility), jsQR 1.4.0 (reads QR codes back from pixels), pngjs 7.0.0, poppler 24.02 `pdftoppm` (renders the print layout) |
| Web server | nginx 1.24.0 (Ubuntu), OpenSSL 3.0.13 |
| The "server" | `tests/e2e/stub-api.mjs`: a stand-in that answers like the five endpoints the page uses (`registration-login`, `events/current`, `members/search`, `qr-issued`, `health/live`) with the API's error envelope, its CORS behaviour (explicit origins, no `Max-Age`, nothing exposed) and an UTC time without zone. It can be slow, silent, drop the connection before or after doing the work, or answer with any status. It proves how the **page** behaves against those answers; it says nothing about the real server. |

## 2. What the tests are

### 2.1 Unit tests - `npm test` - 593 tests, about 12 seconds, no browser

| File | Tests | What it proves |
|---|---|---|
| `tests/unit/api.test.mjs` | 64 | the address rules (https only, `""` = this site, no user name or query in an address); the options of **every** request (no cookies, no redirects, no referrer, nothing cached, bearer header only where needed); how answers are read; time-outs and cancelling; how "no answer" is told apart as *policy*, *CORS* or *unreachable* - including an address that only looks like the server's |
| `tests/unit/auth.test.mjs` | 35 | the session: the token only in memory; the name for the top bar read from the token for display only; idle lock; locking shortly before expiry; what lock and sign-out throw away |
| `tests/unit/banners.test.mjs` | 19 | which notice is shown for which situation, and which are left out because they would repeat each other |
| `tests/unit/check-site.test.mjs` | 26 | the administrator's host check, against a fake host and a real local server: each kind of problem is reported in words, a good host passes |
| `tests/unit/config.test.mjs` | 6 | `config.js` as delivered; every setting has a default of the right kind |
| `tests/unit/connectivity.test.mjs` | 24 | the Online / Offline light, the check every 30 seconds, one timer only, "look again" |
| `tests/unit/docs.test.mjs` | 9 | the nginx and IIS examples carry exactly the headers of `_headers`; `docs/WEB-DEPLOY.md` shows them as the files are; the proxy lines that matter are there; every file and `npm` script the documents name exists |
| `tests/unit/errors.test.mjs` | 24 | classification of failures (no answer, CORS, policy, time-out, 400-409, 429, 5xx) and the server's error envelope |
| `tests/unit/format.test.mjs` | 44 | case, accent and space folding; marking what matched; the QR content (trimmed, capital letters); words for eligibility, times and names |
| `tests/unit/issue.test.mjs` | 46 | the rules before and after the server is asked; *recorded*, *not recorded*, *not confirmed*, *rejected*; *Check with server*; **no slip unless the server recorded the QR**; no double issue |
| `tests/unit/qr.test.mjs` | 25 | the QR encoder (the vendored `qrcode-generator` with the page's UTF-8 setting): mode, size, error-correction level M, quiet zone, determinism, and that jsQR **reads back** the account code from the picture |
| `tests/unit/records.test.mjs` | 28 | the session's list of issuances: states, transitions, what needs attention, wording |
| `tests/unit/search.test.mjs` | 35 | one search per pause in typing, an old answer never replaces a newer one, narrowing, the 200 cap, short and empty input |
| `tests/unit/security.test.mjs` | 98 | the page's **own code** is read (not run): forbidden constructs (`innerHTML`, `eval`, `document.write`, `fetch` outside `js/api.js`, and the same by computed names), imports, every address in a string, where the token may be named, the options of every request, the strictness of the policy in `index.html` and `_headers`, the print rules, `package.json` (no runtime dependencies, versions pinned) |
| `tests/unit/slip.test.mjs` | 25 | the DOM builder (a string never becomes markup) and the content of the slip |
| `tests/unit/theme.test.mjs` | 25 | the colour is literally forest green (`#228B22`); contrast of text on every surface; focus rings |
| `tests/unit/tools.test.mjs` | 37 | `set-api-url`, `check-bundle` and the code checker, with good and with damaged copies of the folder |
| `tests/unit/ui-text.test.mjs` | 23 | the words on screen for sign-in failures, the election line and the like |

**Time zones.** The whole unit suite was run with `TZ` set to seven zones, because times are shown in the PC's zone (RW-11):

| Zone (`TZ=`) | Offset on the day of the run | Tests | Passed | Failed |
|---|---|---|---|---|
| `UTC` | UTC+00:00 | 593 | 593 | 0 |
| `Asia/Manila` | UTC+08:00 | 593 | 593 | 0 |
| `America/Los_Angeles` | UTC-08:00 | 593 | 593 | 0 |
| `Europe/London` | UTC+00:00 | 593 | 593 | 0 |
| `Asia/Kolkata` | UTC+05:30 | 593 | 593 | 0 |
| `Pacific/Auckland` | UTC+13:00 | 593 | 593 | 0 |
| `Pacific/Kiritimati` | UTC+14:00 | 593 | 593 | 0 |

### 2.2 Browser tests - `npm run test:e2e` - 97 tests, about 2 minutes

Each test starts the page (a copy made with the shipped `tools/set-api-url.mjs`) on an https address of its own, with the headers of `_headers`, and the stand-in server; the browser maps the test names to this machine, accepts the
run's own certificate and uses no proxy. So the page is loaded as in production: https, the real Content-Security-Policy, the server on **another** address (or the same address through a proxy). The host serves files like a stock nginx or IIS:
anything that does not end in `.js` is not JavaScript (that found a real bug, section 4).

| File | Tests | What it proves |
|---|---|---|
| `00-smoke` | 2 | it starts, reaches the server, signs in, searches, selects |
| `10-login` | 11 | right and wrong passwords, the cool-down on *too many attempts*, show / hide password, the server not answering, CORS diagnosed, a server error, a page configured with plain `http://` refusing to start |
| `20-search` | 15 | two characters minimum; **one** search for a whole name typed at once; order; eligibility in words; case and accents; account code; branches outside the election never shown; the 200 cap; only the answer to the **latest** text is shown; keyboard use |
| `30-issue` | 17 | Enter on one match issues at once and the slip is printed **only after** the server recorded it; double Enter; *Issue again* asks first, default *Cancel*; not eligible / inactive / unknown member; no answer; answer lost but work done (*Check with server* finds it, prints once); 502; time-out; quick issue and auto-print off |
| `40-records` | 9 | the banner and *Review records*; *Mark as seen*; *Try again*; *Check with server*; reprint says REPRINT; leaving the page with unresolved records asks first |
| `50-session` | 11 | lock; idle lock after ten minutes; lock shortly before the token expires; a refused token (401) locks and the records survive; sign-out asks; *Offline* refuses Issue and recovers by itself; election changes while working |
| `60-print` | 7 | only the slip is on the paper; the QR **read back from the printed page** is the account code; the slip fits 80, 72 and 58 mm paper and the QR is not shrunk; long names wrap; accents; REPRINT; Ctrl+P on the desk prints a blank page, never the member list; the slip is removed from the print area after printing and on lock |
| `70-security` | 11 | the headers; the browser itself refuses inline script, `innerHTML`, other servers, beacons, sockets and form posts; no framing; nothing left in storage and no token on the page; **only two addresses are ever contacted**, the token goes only to the server, no cookie (also one planted for the server's address, and, on one address, for the page's own), no referrer, no secret in any address; redirects are not followed; text from the server is only ever text (names full of HTML and script); the password never in an address; the search box is not remembered; a wrong server address is explained as a policy problem; **no CORS pre-flight on one address** |
| `80-a11y` | 13 | axe-core (WCAG 2.x A and AA and best practice) on every state of the page; nothing cut off or scrolling sideways from 320 x 640 up to 1920 x 1080; text zoom at 200 %; the answer to a failed Issue is on the screen, not below it |
| `90-theme` | 1 | the computed colours are literally `rgb(34, 139, 34)` where the design says forest green, and small text never sits directly on it (4.39:1 is only enough for large bold type and shapes) |

What "fast" means here, and what was counted: on one address a search is **one** request and an issue is **one** request, with no pre-flight; across two addresses every distinct search is preceded by its own pre-flight (the test measures it:
two searches, two pre-flights). A whole name typed at once sends one search, for the final text. The only waiting left at the desk is the server's own answer. Real latency was **not** measured - the stand-in answers at once.

### 2.3 The nginx example run for real - `npm run test:deploy` - 27 checks, under 15 seconds

`tests/deploy/check-nginx.mjs` takes `docs/samples/nginx-evoting-registration.conf` and changes only the addresses and paths, then starts a **real nginx 1.24** with it in front of the stand-in server.
A small DNS server of the test stands in for the internet's, so the proxy looks the API's **name** up like a production server would (the first version of this test used an address of numbers, which skipped exactly that, and the certificate check below).

* `tools/check-site.mjs` against it finds nothing to fix, compares every file with the folder, and notices that `/api/` is forwarded;
* http goes to https with path and query; an error page carries the security headers; a missing file is a 404, not the front page; the page and scripts are `no-cache`, fonts are kept for a year; scripts are compressed;
* `/api/` reaches the server with the path unchanged, after a DNS lookup, **with the API's name in the TLS handshake (SNI)** and as `Host`, and with `X-Forwarded-For` / `X-Forwarded-Proto` set by nginx (a caller's own claim is not passed on);
* real Chromium through nginx: sign in, search, issue, **one** slip, the server recorded one issuance, the page talked to nobody but its own address, no policy violation, no error, no warning;
* the log of nginx holds the calls it forwarded and **not what was searched for**;
* an API that shows a certificate nginx does not trust is **refused** (502, and the log says why) instead of receiving the sign-in password;
* the usual mistake - an `add_header` inside a `location`, which silently drops all the security headers - is noticed by `check-site`.

Without nginx the test says it was skipped and exits 0. The IIS example is **not** run (no IIS here); only its header values are compared with `_headers` by a unit test.

## 3. How the tests themselves were tested

A test that can never fail proves nothing. So 48 small breakages were made on purpose, one at a time, in a copy of the folder - a safety rule switched off, a rule bent, a colour changed, a line removed - and the unit tests and the browser tests that should
notice were run on the copy. "Caught" means at least one test failed. The list is in `tests/mutation/mutations.mjs` and runs with `node tests/mutation/run-mutations.mjs` (about 20 minutes on a machine with 2 CPUs; it breaks only copies; see `tests/mutation/README.md`).

| ID | What was broken | Caught by |
|---|---|---|
| M01 | api.js: cookies are sent (credentials 'omit' -> 'include') | unit, browser |
| M02 | api.js: redirects are followed (redirect 'error' -> 'follow') | unit, browser |
| M03 | api.js: the page address is sent as Referer (referrerPolicy -> 'origin') | unit, browser |
| M04 | api.js: the browser may cache answers (cache 'no-store' -> 'default') | unit |
| M05 | api.js: a look-alike address is taken for the page's own (origin boundary removed) | unit |
| M06 | api.js: wrong authorization scheme (Bearer -> Token) | unit, browser |
| M07 | api.js: the token is also put in the address (?access_token=) | unit, browser |
| M08 | auth.js: the idle lock never happens | unit, browser |
| M09 | auth.js: the screen locks 30 s AFTER the token ran out, not before | unit, browser |
| M10 | auth.js: locking keeps the token in memory | unit |
| M11 | api.js: a 401 no longer locks the screen | unit, browser |
| M12 | qr.js: error correction level M -> L | unit |
| M13 | format.js: the QR content is no longer upper-cased | unit |
| M14 | format.js: the QR content is no longer trimmed | unit |
| M15 | qr.js: quiet zone 4 -> 1 module | unit, browser |
| M17 | issue.js: a slip may be printed when the server did NOT record the QR | unit |
| M18 | issue.js: a second QR is issued without asking | unit, browser |
| M19 | issue.js: a double Enter issues twice (busy guard removed) | unit |
| M20 | issue.js: a member the server does not know is "failed" instead of "rejected" | unit, browser |
| M21 | issue.js: "Check with server" takes any earlier QR time as proof of this issuance | unit |
| M22 | search.js: an older answer that arrives late replaces the newer one | unit |
| M23 | format.js: one character is enough to search (MIN_QUERY_LENGTH 2 -> 1) | unit, browser |
| M24 | search.js: no debounce - every keystroke is sent | unit, browser |
| M25 | connectivity.js: a "look again" asked while a look is on its way is lost | **not caught - equivalent, see below** |
| M25b | connectivity.js: a network hint that arrives while a check is on its way is lost | unit |
| M26 | connectivity.js: scheduling the next look does not drop the one waiting (two loops) | unit |
| M28 | dom.js: text is inserted as markup (insertAdjacentHTML) | unit, browser |
| M29 | auth.js: the token is also written to localStorage | unit, browser |
| M30 | app.css: while printing the desk is NOT hidden | unit, browser |
| M31 | app.css: the printed slip is a fixed 80 mm wide (QR is cut or shrunk on narrower paper) | unit, browser |
| M32 | app.css: @page declares a paper size | unit |
| M33 | app.css: the print area is visible on screen | unit |
| M34 | app.css: --forest is sea green, not forest green | unit, browser |
| M35 | app.css: the top bar is the dark green | browser |
| M36 | app.css: the main buttons are the dark green | browser |
| M37 | index.html: the browser bar colour is another green | unit, browser |
| M38 | app.css: the small brand tag sits directly on plain forest green (4.39:1) | browser |
| M39 | index.html: the policy allows inline script ('unsafe-inline') | unit |
| M40 | _headers: frame-ancestors 'none' removed (the page can be framed) | unit |
| M41 | _headers: X-Content-Type-Options removed | unit, browser |
| M42 | tools/set-api-url.mjs: _headers is not updated with the new address | unit |
| M43 | tools/lint.mjs: innerHTML is no longer on the forbidden list | unit |
| M44 | config.js: a setting the page has no default for | unit |
| M46 | main.js: a slip is shown/printed even when the issue was refused or not recorded | browser |
| M48 | main.js: the slip stays in the print area when the screen locks / signs out (clearSensitive) | browser |
| M49 | main.js: the print area is not cleared after printing (afterprint) | browser |
| M50 | api.js: with the page and the API on the same address, cookies of that address are sent ('omit' -> 'same-origin') | unit, browser |
| M51 | records-ui.js: "1 records need attention" (no singular) | browser |

**47 of 48 are caught** - 19 by the unit tests alone, 7 by the browser tests alone, 21 by both.

* **M25 is not caught and cannot be.** It removes `if (force) lookAgain = true;` from the top of `heartbeat()`. That line is a second lock for a case that cannot happen: the page keeps one timer, so `heartbeat()` is never entered while a check is on its
  way. The change has no visible effect (M25b, the same idea on the path that *can* happen, is caught). It is left in on purpose.
* **Two of the first run's results were findings**, both fixed and repeated: M22 *survived* (a late answer could be remembered as the base for narrowing the next search - no test looked there; a test now does), and M01 was caught by the unit tests but not by the
  browser test that was meant to catch it, because that test could never fail (a cookie that the browser would never send from another site anyway). The cookie is now one that is sent, and a second test covers the page's own address.
* The same method was applied to the nginx example: 17 breakages of the configuration (a path on `proxy_pass`, no `always` on a header, no `expires`, no `gzip`, no fonts rule, a wider policy, a redirect without the path, no SNI, no `Host`, no
  certificate check, no resolver, the client's own `X-Forwarded-For` passed on, a missing header, a front-page fallback, no `/api/` rule, a wrong `Referrer-Policy`), 17 noticed. Run with `node tests/mutation/run-nginx-mutations.mjs`.

**What this does not show.** The breakages are the ones the author thought of. They show that the tests look at the places they should; they do not show that no other fault exists. Some changes cannot be told from the original by any test (M25 is one). There is no code-coverage figure.

## 4. What the tests found while the page was being built

1. **An address that only looks like the server's** was taken for it when the page explained a blocked connection (`https://api.example.com.evil.test` for `https://api.example.com`): fixed in `js/api.js` (M05).
2. **Two timers could run the "is the server there?" check at once** after a network hint arrived during a check: fixed in `js/connectivity.js` with a single timer (M25b, M26).
3. **A page that would not start on a stock nginx or IIS.** The vendored QR library was a file ending in `.mjs`, which their MIME tables do not know as JavaScript; the browser then refuses to run it and the page stays blank. Found by making the test host as strict as nginx. The file is now `vendor/qrcode.js`, `check-bundle` refuses any `.mjs` script, and `check-site` checks the type of every file on the real host.
4. **A browser test that could not fail** (the cookie check, M01), and **a unit-test gap** (M22) - found by section 3, fixed.
5. **The nginx example first trusted whatever answered for the API** (nginx does not check an upstream certificate unless told to) and compressed scripts only on the nginx versions that call them `application/javascript`. It now verifies the API's certificate and handles both names. The deployment test first ran against an address of numbers, which could not have found either; it now uses a name, a DNS server and a stranger's certificate.

## 5. What was not verified

| What | Why it matters | Where it is picked up |
|---|---|---|
| The **real API** - its MySQL, its real rate limit and answers, its speed | the stand-in answers like the documented endpoints, nothing more | TW-01 to TW-12, `dotnet test EVoting.Api.Tests` (RW-12) |
| The **real web host**: certificate, headers, MIME table, proxy | the nginx example ran on nginx 1.24 only; IIS, Apache, Netlify and Cloudflare were not run | `node tools/check-site.mjs` on the real address (TW-01), RW-12 |
| A **real receipt printer** and its driver: paper size, margins, cut, `--kiosk-printing` | the sandbox renders the print layout to PDF and reads the QR from the pixels; it has no printer | TW-30 to TW-34 (RW-6) |
| A **kiosk scanner reading a printed slip** | a QR that decodes from a clean render is not a thermal print under a kiosk's camera | TW-32 (RW-6) |
| **Other browsers**: Edge, Firefox, Safari; other versions of Chrome | only Chromium 153.0.8010.12 ran; Trusted Types is Chromium-only | TW-02, TW-03 (RW-7) |
| **Real people**: the pace of a queue, the wording to a clerk, the keyboard habits | no one used it | a rehearsal day (`08` TE-08) with the page at the desks |
| The **speed** on the real network | nothing was timed against a real server | TW-06, TW-07 (note the times) |
| The **Windows programs** | untouched by this work; they were not rebuilt | `07` §7 |

## 6. Run it again

```bash
npm ci                         # the test tools only (the page itself has no dependencies)
npm test                       # unit tests, about 12 s
npm run test:e2e               # browser tests, about 2 min (needs Chromium from Playwright, openssl, poppler-utils)
npm run test:deploy            # the nginx example for real (needs nginx; skipped without it)
npm run check                  # is the folder ready to upload
TZ=Pacific/Kiritimati npm test # any time zone
node tests/mutation/run-mutations.mjs --list     # the breakages; without --list they are run (about 20 minutes)
```

Each command prints its own verdict and exits with 0 only when everything passed.
