// The only file an administrator edits to point this page at a server. After changing apiBaseUrl run
//     node tools/set-api-url.mjs https://api.example.com
// instead of editing by hand: it also updates the Content-Security-Policy in index.html and _headers, which must name the same address
// (a page may only talk to the addresses its policy lists).
//
// apiBaseUrl
//   ""                                  the API is on the same site as this page (a reverse proxy forwards /api/ to the server).
//                                       Fastest: the browser needs no CORS pre-flight round trip before each request.
//   "https://api.eballotsacdeco.site"   the API is elsewhere. The server must list this page's address in EVOTING_ALLOWED_ORIGINS.
//
// Times are in minutes / seconds / milliseconds as named. Everything else is a switch for how the desk behaves.

export default Object.freeze({
  apiBaseUrl: 'https://api.eballotsacdeco.site',

  /** Lock the screen after this many minutes without a key or a click (0 = never). The same person types the password to continue. */
  idleLockMinutes: 10,

  /** Wait this long after the last keystroke before searching. */
  searchDebounceMs: 150,

  /** Give up on a request after this long. */
  requestTimeoutMs: 15000,
  /** Give up on "issue QR" after this long (it is then listed in Review records as not confirmed). */
  issueTimeoutMs: 20000,

  /** How often to check that the server answers while nothing else is happening. */
  heartbeatSeconds: 30,
  /** How often to ask which election is open. */
  eventRefreshSeconds: 60,

  /** Enter in the search box issues the QR when exactly one member matches (otherwise it only selects). */
  quickIssue: true,
  /** Open the print dialog as soon as the server has recorded the QR. With Chrome/Edge started with --kiosk-printing it goes straight to the printer. */
  autoPrint: true,
  /** After a QR is issued, empty the search box and put the cursor back in it for the next member. */
  clearAfterIssue: true,
});
