# E-Voting Registration - in the browser

The Registration desk as a web page. Staff sign in with a **user name and password**, find a member, press **Enter**, and the slip with the member's QR comes
out of the receipt printer. The page talks to the eVoting API (`https://api.eballotsacdeco.site`) and to nothing else. Its colour is forest green
(the CSS colour `forestgreen`, `#228B22`) and its letters are Segoe UI.

**Online-only.** When the server cannot be reached the desk says so and refuses to issue: a QR is never issued, and a slip is never printed, unless the
server has recorded it. (The Windows program `EVoting.Registration` keeps its offline outbox for places with an unreliable network; the two can be used side by
side, and a QR issued by either is the same QR to the kiosk.)

**Not in this version:** ID scanning (camera and text recognition), the saved roster and the outbox. **Kept:** *Review records*, the list of what was issued in
the session and what needs attention.

> **What was and was not verified.** The page's logic, its safety rules and the whole desk flow were tested in a Linux sandbox: 614 unit tests (also run in seven time zones),
> 105 tests in a real Chromium 153 against a stand-in for the API, under the real Content-Security-Policy, and the nginx example of the deployment guide was run on a real nginx 1.24
> (27 checks). The tests themselves were tested by breaking the page on purpose 62 times: 61 were noticed, one change cannot be seen by anybody. `docs/WEB-VERIFICATION.md` has the numbers and what
> each test proves. What the sandbox could **not** do: talk to the real server at `api.eballotsacdeco.site` and its MySQL database, run on the real web host with its real headers, print on a real
> receipt printer or read the printed QR with the kiosk's scanner, or run in any browser other than Chromium. Those are rows TW-xx of the rehearsal checklist
> (`../docs/08-DEPLOYMENT-AND-MANUAL-TESTS.md` §14) - do them before the first real election.

---

## At the desk

1. **Sign in** with your user name and password. Any active user of the eVoting system whose password the server accepts can sign in; the server decides.
2. **Type in the search box** - a name, part of a name, or the account code. At least two characters. Case and accents do not matter. Results appear while you
   type, ordered by name, with the part that matched marked and the **eligibility in words** (*Eligible*, *Not eligible - the reason*, *Inactive*). Only members of
   the branches that take part in the open election are shown, at most 200 (it says when there are more: narrow the search).
3. **Press Enter.** If exactly one member matches, the QR is issued at once. If several match, Enter points at the first one and a second Enter issues - or use
   the arrow keys, or click a row, and press **Issue QR & print slip**. A member who already has a QR is asked about first (*Issue again* / *Cancel*; the
   default is *Cancel*), and a member who is not eligible cannot be issued one - the reason is on the screen.
4. **The slip.** The server records the issuance *first*; only then the slip is shown and the print dialog opens (or the slip goes straight to the printer, see
   *Printing*). The search box is emptied and ready for the next member. *Print again* reprints it (marked REPRINT); *Hide slip* removes it.
5. **When something goes wrong** the screen says what, in words, and offers the next step. A request that got no answer is *not confirmed*: **no slip is printed**;
   *Check with server* asks whether the server did record it, and *Try again* sends it again (safe: the server only stamps the member's latest issue time). A
   member the server no longer knows is *rejected*: no slip, listed for review.
6. **Review records** (button at the top, or the banner that appears when something needs attention) lists the session's issuances, newest first, or only those
   that need attention. *Mark as seen* keeps a record but stops it raising the banner.
7. **Lock** hides everything about the members and the person; the same user types the password again to continue, and the records are kept. The screen also
   locks by itself after **10 minutes** without a key or a click, shortly before the sign-in expires, and whenever the server refuses the sign-in. **Sign out**
   asks first when records still need attention, then starts a fresh page.

| Key | What it does |
|---|---|
| **Enter** in the search box | issue (one match) / point at the first match (several) |
| **Up / Down** | move through the matches |
| **Esc** | clear the search box / close a list or question |
| **/** | back to the search box (when you are not typing somewhere) |
| **F5** | ask the server again which election is open - the page is *not* reloaded, the session stays |

The strip under the desk shows the latest records with their state in words (*Confirmed*, *Sending…*, *Not recorded*, *Not confirmed*, *Rejected*). Closing the tab or
reloading while records still need attention makes the browser ask first: the list lives in the page's memory only.

**The connection** is shown at the top: *Connecting…*, *Online*, *Online - server problem* (the server answered with an error) or *Offline*. While it is *Offline* the
Issue button is off and says why; the page checks every 30 seconds and recovers by itself.

## The look

* **Letters:** Segoe UI - the font Windows itself uses - at 14 px, in two weights only: regular, and semibold for names, titles and the main button. A PC that is not a Windows PC (a Mac, a phone) shows its own system font instead and the page works the same. Nothing is downloaded, so there is no font to upload.
* **Colour:** white cards on a soft grey-green desk; forest green (`#228B22`) marks what is the brand (the mark and the thin line across the top), what can be pressed (the main button) and what is chosen (the selected row).
* **One conscious exception.** White on `#228B22` is 4.39:1: fine for shapes, a hair under the 4.5:1 that small type needs. Forest green is therefore a background for exactly one kind of text, the label of a main button (for example *Sign in*, *Issue QR & print slip*, *Unlock*); every other text is near-black or deep green on white or a pale tint, and tests fail if that changes. For a stricter reading, `--forest-button` in `css/app.css` is the one line to darken (for example to `#1c7a1c`, 5.5:1).
* **Slim fields and rows:** text boxes are 32 px high with 13 px type (the search box, typed in all day, 36 px with 14 px type), and a box in focus only turns its thin edge forest green - no heavy ring, no glow; the rows of the search results are about 45 px high with the name in 13 px.
* **The sign-in** is the name of the desk, two boxes and the button, and under them one line that says whether the server answers (*Server ● reachable*). It never shows the address of the server; the sentence about using the Windows Registration station instead appears only when the server does not answer.
* **Account codes** are set in Consolas (the fixed-width font of Windows, with a slashed zero) so that 0/O and 1/l/I cannot be mistaken when a code is read out across a desk; `--font-code` in `css/app.css` is the one line to change that.

## Setting it up (the administrator)

You need: a web address with https for this page, a browser (Chrome or Edge, current), and the address of the API. Details, with examples for nginx and IIS, are in
**`docs/WEB-DEPLOY.md`**; in short:

```bash
node tools/set-api-url.mjs ""                                  # the page and the API share one address (a reverse proxy forwards /api/) - the recommended way
node tools/set-api-url.mjs https://api.eballotsacdeco.site     # or: the API is at its own address (then the API must allow this page, see WEB-DEPLOY.md)
node tools/check-bundle.mjs                                    # says "OK - the folder is ready to upload", or what is wrong
```

Then upload **exactly** `index.html`, `config.js`, `_headers`, `favicon.svg`, `css/`, `js/` and `vendor/`. Do **not** upload `tests/`, `tools/`, `docs/`,
`node_modules/` or `package*.json`. Then look at the host from outside:

```bash
node tools/check-site.mjs https://registration.example.org     # the address of the page; says in words what to fix, or that the host is as this folder describes
```

It reads the real address the way a browser does - every file and its type, the security headers, the `/api/` line - signs in nowhere and changes nothing. An nginx example
(run for real) and an IIS example (written, not run) are in `docs/samples/`; `docs/WEB-DEPLOY.md` explains them.

`set-api-url` changes three places that must name the same address - `config.js`, and the `Content-Security-Policy` in `index.html` and in `_headers` - because a page may
only talk to the addresses its policy lists. `check-bundle` fails when they differ, when a file the page refers to is missing, when anything inline or forbidden crept
in, or when a licence file is missing.

### `config.js` - the only file an administrator edits

| Setting | Default | Meaning |
|---|---|---|
| `apiBaseUrl` | `https://api.eballotsacdeco.site` | `""` = the API is on this page's own address (reverse proxy); otherwise the API's `https://` address. Use `set-api-url`, not a hand edit. |
| `idleLockMinutes` | `10` | lock the screen after this many minutes without a key or a click (`0` = never) |
| `searchDebounceMs` | `150` | wait this long after the last keystroke before searching |
| `requestTimeoutMs` | `15000` | give up on a request after this long |
| `issueTimeoutMs` | `20000` | give up on *Issue QR* after this long (it is then listed as *not confirmed*) |
| `heartbeatSeconds` | `30` | how often to check that the server answers while nothing else happens |
| `eventRefreshSeconds` | `60` | how often to ask which election is open |
| `quickIssue` | `true` | Enter issues when exactly one member matches (otherwise Enter only selects) |
| `autoPrint` | `true` | open the print dialog as soon as the server has recorded the QR |
| `clearAfterIssue` | `true` | empty the search box and return to it after an issuance |

## Printing the slip

The page prints only the slip: while printing, everything else is hidden. **The paper size belongs to the printer**, not to the page (Chrome and Edge ignore
`@page { size: 80mm auto }`; this was measured, and a fixed height would feed blank paper), so:

1. In the printer's own settings (Windows *Printing preferences*), choose the **80 mm roll / receipt** paper and the cut-after-page option, and make the receipt
   printer the **default printer** of the Windows user who runs the desk.
2. In the print dialog (if it opens): *Scale 100 %*, *Margins: none or default* (the page sets its margin to 0), **Headers and footers off**.
3. For printing **without a dialog**, start the browser for the desk like this (Windows; the default printer is used):

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app=https://registration.example.org/
   msedge.exe --kiosk-printing --app=https://registration.example.org/
   ```

The slip is as wide as the paper up to 80 mm, and the QR is 50 mm wide, or smaller - never cut off - on narrower paper. The QR carries the same content and settings as the
Windows station's (`QrCodeGenerator`): the account code in capital letters, error-correction level M, a 4-module quiet zone. A short account code (5 characters) makes a QR of 21
modules, about 1.7 mm each at 50 mm; a longer code makes a denser QR with smaller modules.

*What this does not prove:* how a real receipt printer and its driver treat the paper, the margins and the cut, and whether the kiosk's scanner reads a QR printed this
way. Rows TW-30 to TW-35 check both on the real printer and a real kiosk.

## What the page keeps - and does not

* The sign-in token lives in the page's memory only: not in `localStorage` or `sessionStorage`, not in a cookie, not in an address. Locking, signing out or closing the
  tab throws it away. Reloading the page signs you out.
* The members found, the records of the session and the slip live in memory too, and are removed when the screen locks or you sign out. The print area is emptied after
  printing and whenever the screen locks.
* Requests carry no cookies, follow no redirects, tell the server no referring page, and are not cached by the browser. The search text travels in the address of the
  request (`.../members/search?query=...`) - the server's access log may therefore contain what was searched.
* Text that comes from the server (names, remarks, addresses) is only ever put on the page as text. The policy forbids inline script and style, other servers, forms, frames and
  string-to-markup conversion (Trusted Types); the page cannot be shown inside another site.

## Tests

```bash
npm ci                 # once: the test tools only (acorn, axe-core, jsqr, playwright, pngjs) - the page itself has no dependencies
npm test               # 614 unit tests, about 7 seconds, no browser
npm run test:e2e       # 105 tests in Chromium against a stand-in API, about 2 minutes (needs openssl, poppler-utils for the print tests)
npm run test:deploy    # the nginx example of docs/WEB-DEPLOY.md on a real nginx in front of the stand-in API, under 15 seconds (needs nginx; without it the test says "skipped")
npm run check          # is this folder ready to upload
```

`docs/WEB-VERIFICATION.md` says what each suite proves, how the tests themselves were tested (breaking the code on purpose to see them fail: `node tests/mutation/run-mutations.mjs`,
about 20 minutes, not part of `npm test`), and what is not covered. The numbers above are those of the last full run; they change when tests are added.

## The folder

```
index.html     the page: policy, #app, #print-root
config.js      the only file an administrator edits
_headers       response headers for hosts that read such a file (Netlify, Cloudflare Pages); the model for nginx / IIS
favicon.svg
css/app.css    all styling: the tokens (forest green, Segoe UI, the type scale) at the top, the print rules at the end
js/            the page's code: api.js (the only code that uses the network), auth.js, connectivity.js, search.js, issue.js, records.js,
               banners.js, slip.js, qr.js, format.js, errors.js, main.js; ui/ (the screens)
vendor/        qrcode.js = qrcode-generator (MIT) with its licence - a .js file on purpose: stock web servers do not know .mjs as JavaScript
tools/         set-api-url.mjs, check-bundle.mjs, check-site.mjs, lint.mjs, lib.mjs   (Node; for the administrator, not uploaded)
tests/         unit/ (node:test), e2e/ (Playwright), deploy/ (the nginx example on a real nginx), mutation/ (breaking the page on purpose)
docs/          WEB-DEPLOY.md, WEB-VERIFICATION.md, samples/ (nginx-evoting-registration.conf, web.config)
```

## Things to know

* **Sign-ins are limited by the server:** all interactive sign-ins (this page and the admin program) share **10 per minute**. If more than ten clerks sign in within the same
  minute, the others see *Too many sign-in attempts right now* with a count-down and must wait. Raise `RateLimit:AdminLoginPerMinute` on the server or stagger the start.
* **The sign-in lasts 8 hours** (the server's `Jwt:AdminTokenExpiryMinutes`); the screen locks shortly before it runs out.
* **The server's `qr-issued` call only checks that the member exists** - it does not look at eligibility or at whether the member is active. This page applies those rules
  before it asks (as the Windows station does); the vote itself is checked again by the server when the QR is used.
* **Times on screen are in the PC's time zone** (the server's are UTC), and the 10-minute lock uses the PC's clock: keep the desk PCs on the right zone and synchronised (RW-11).
* Tested in Chromium 153 only: Edge is built on the same engine but was not run, Firefox and Safari were not run (RW-7). `file://` is not supported: open the page from its web address.
* The full list of limits, with what is in place and what is recommended, is `../docs/09-REMAINING-RISKS.md` §4a (RW-1 to RW-12).
