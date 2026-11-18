// Registers sw.js, which keeps a copy of the page's own files so the desk opens with no signal (see sw.js).
//
// The page runs with Trusted Types (Content-Security-Policy require-trusted-types-for 'script'), and registering a service worker
// takes a script address, so one policy exists, named in the CSP ("trusted-types evoting-sw"), that accepts exactly one address:
// this page's own sw.js. Nothing else can be turned into a script address.

const SW_PATH = './sw.js';
export const SW_POLICY_NAME = 'evoting-sw';

/** True when the browser can keep the page for offline use (https or localhost, service workers available). */
export function canKeepPageOffline(nav = globalThis.navigator, loc = globalThis.location) {
  const secure = loc?.protocol === 'https:' || loc?.hostname === 'localhost' || loc?.hostname === '127.0.0.1';
  return !!(secure && nav && 'serviceWorker' in nav);
}

let policy = null;
function scriptUrl() {
  const tt = globalThis.trustedTypes;
  if (!tt) return SW_PATH;
  policy ??= tt.createPolicy(SW_POLICY_NAME, {
    createScriptURL: (url) => {
      if (url !== SW_PATH) throw new TypeError('Only the page\'s own sw.js may be registered.');
      return url;
    },
  });
  return policy.createScriptURL(SW_PATH);
}

/** Registers the service worker (best effort: the desk works online without it). Resolves to true when it is in place. */
export async function keepPageOffline(nav = globalThis.navigator) {
  if (!canKeepPageOffline(nav)) return false;
  try {
    await nav.serviceWorker.register(scriptUrl(), { scope: './' });
    return true;
  } catch {
    return false;
  }
}
