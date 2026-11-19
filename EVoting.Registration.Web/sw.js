// Service worker of the Registration desk: keeps a copy of THE PAGE ITSELF (its own files below) so the desk still opens at a venue
// with no signal. It never touches the API: requests to the server (member data, sign-in) go straight to the network and are never
// stored. Member data for offline work is kept separately, encrypted with the user's password (js/offline/desk.js).
//
//   page files - network first (a new version reaches the desk as soon as it is online), the stored copy when there is no network
//   anything else - not handled here (the browser does what it always does)
//
// This file and js/offline/sw-register.js are the only files of the page allowed to use these browser features (tools/lint.mjs).
// When a file is added to the page, add it to PAGE_FILES (tests/unit/offline.test.mjs checks the list against the folder).

const CACHE = 'evoting-registration-page-v1';

const PAGE_FILES = [
  './',
  './index.html',
  './config.js',
  './favicon.svg',
  './css/app.css',
  './vendor/qrcode.js',
  './js/api.js',
  './js/auth.js',
  './js/banners.js',
  './js/connectivity.js',
  './js/errors.js',
  './js/format.js',
  './js/issue.js',
  './js/main.js',
  './js/qr.js',
  './js/records.js',
  './js/search.js',
  './js/slip.js',
  './js/offline/crypto.js',
  './js/offline/desk.js',
  './js/offline/idb.js',
  './js/offline/local-api.js',
  './js/offline/package.js',
  './js/offline/sw-register.js',
  './js/ui/detail-panel.js',
  './js/ui/dialogs.js',
  './js/ui/dom.js',
  './js/ui/login.js',
  './js/ui/offline-ui.js',
  './js/ui/records-ui.js',
  './js/ui/search-panel.js',
  './js/ui/topbar.js',
];

const scope = new URL(self.registration.scope);
const pageUrls = new Set(PAGE_FILES.map((f) => new URL(f, scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PAGE_FILES.map((f) => new Request(new URL(f, scope).href, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('evoting-registration-page-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin) return; // the API and anything else: never here
  const clean = url.origin + url.pathname;
  const isPage = req.mode === 'navigate' || pageUrls.has(clean);
  if (!isPage) return;
  const key = req.mode === 'navigate' ? new URL('./index.html', scope).href : clean;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
        }
        return res;
      })
      .catch(() => caches.open(CACHE).then((c) => c.match(key)).then((hit) => hit ?? Response.error())),
  );
});
