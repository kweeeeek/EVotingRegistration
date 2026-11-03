// A small safety net, run by tools/check-bundle.mjs and by tests/unit/security.test.mjs: the application code (not vendor/) must not use
// the browser features that would let a hostile string become markup or script, keep a member's data on the PC, or send it elsewhere.
// It reads the real syntax tree (acorn), so words in comments or strings never trigger it.

/** Property / identifier names that must never appear in application code, with the reason. */
export const FORBIDDEN_NAMES = Object.freeze({
  innerHTML: 'turns a string into markup (cross-site scripting)',
  outerHTML: 'turns a string into markup (cross-site scripting)',
  insertAdjacentHTML: 'turns a string into markup (cross-site scripting)',
  srcdoc: 'turns a string into a page (cross-site scripting)',
  createContextualFragment: 'turns a string into markup (cross-site scripting)',
  DOMParser: 'turns a string into markup (cross-site scripting)',
  eval: 'runs a string as code',
  Function: 'runs a string as code',
  execCommand: 'obsolete document editing API',
  localStorage: 'keeps data on the PC after the session',
  sessionStorage: 'keeps data on the PC after the session',
  indexedDB: 'keeps data on the PC after the session',
  caches: 'keeps data on the PC after the session',
  cookie: 'cookies are not used (the API is bearer-token only)',
  serviceWorker: 'a service worker could keep responses (member data) on the PC',
  XMLHttpRequest: 'all network calls go through js/api.js (fetch)',
  WebSocket: 'no other network channel is allowed',
  EventSource: 'no other network channel is allowed',
  sendBeacon: 'no other network channel is allowed',
  importScripts: 'no workers are used',
  Worker: 'no workers are used',
  SharedWorker: 'no workers are used',
  postMessage: 'no cross-window messaging is used',
  console: 'a log line could leak a member name or a token',
});

/** Files allowed to use a name that is forbidden elsewhere. */
export const ALLOWED_IN = Object.freeze({
  fetch: ['js/api.js'],
});

const FORBIDDEN_ATTRIBUTE_NAMES = /^(style|srcdoc|on[a-z]+)$/i;

/** The text of a string literal, or of a template literal without any ${...} in it; null for anything computed. */
function staticText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked;
  return null;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walk(c, visit, node);
    else if (child && typeof child.type === 'string') walk(child, visit, node);
  }
}

/**
 * @param {typeof import('acorn')} acorn
 * @param {string} source
 * @param {string} file   path relative to the web root, with forward slashes
 * @returns {{file: string, line: number, name: string, why: string}[]}
 */
export function lintSource(acorn, source, file) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const found = [];
  const report = (node, name, why) => found.push({ file, line: node.loc.start.line, name, why });

  walk(ast, (node, parent) => {
    // a forbidden name used as a value, a function, or a member (document.cookie, window.localStorage) - but not as the key of an
    // object literal or the name of a class member, which only label something
    if (node.type === 'Identifier') {
      const isObjectKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      const isClassMember = parent && (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed;
      if (!isObjectKey && !isClassMember) {
        if (Object.hasOwn(FORBIDDEN_NAMES, node.name)) report(node, node.name, FORBIDDEN_NAMES[node.name]);
        else if (node.name === 'fetch' && !ALLOWED_IN.fetch.includes(file)) report(node, 'fetch', 'all network calls go through js/api.js');
      }
    }

    // the same names spelled as text: el['innerHTML'] = x, window["localStorage"], window[`fetch`]
    if (node.type === 'MemberExpression' && node.computed) {
      const spelled = staticText(node.property);
      if (spelled !== null) {
        if (Object.hasOwn(FORBIDDEN_NAMES, spelled)) report(node, spelled, FORBIDDEN_NAMES[spelled]);
        else if (spelled === 'fetch' && !ALLOWED_IN.fetch.includes(file)) report(node, 'fetch', 'all network calls go through js/api.js');
      }
    }

    // document.write(...) / document.writeln(...)
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && /^write(ln)?$/.test(node.property.name) && node.object.type === 'Identifier' && node.object.name === 'document') {
      report(node, `document.${node.property.name}`, 'writes markup into the page');
    }

    // string forms of setTimeout/setInterval
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && /^(setTimeout|setInterval)$/.test(node.callee.name) && node.arguments[0] && (node.arguments[0].type === 'Literal' || node.arguments[0].type === 'TemplateLiteral')) {
      report(node, node.callee.name, 'runs a string as code');
    }

    // el.setAttribute('style' | 'srcdoc' | 'onclick', ...)
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'setAttribute') {
      const first = node.arguments[0];
      if (first && first.type === 'Literal' && typeof first.value === 'string' && FORBIDDEN_ATTRIBUTE_NAMES.test(first.value)) {
        report(node, `setAttribute('${first.value}')`, 'inline style / script attributes are blocked by the Content-Security-Policy');
      }
    }

    // javascript: URLs
    if (node.type === 'Literal' && typeof node.value === 'string' && /^\s*javascript:/i.test(node.value)) {
      report(node, 'javascript: URL', 'runs script from a link');
    }

    // window.open
    if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'open' && node.object.type === 'Identifier' && (node.object.name === 'window' || node.object.name === 'globalThis')) {
      report(node, 'window.open', 'a new window would carry the page away');
    }

    // el.style.something = ...  (inline style by script is allowed by CSP, but all styling belongs in css/app.css)
    if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'style' && parent && parent.type === 'MemberExpression' && parent.object === node) {
      report(node, '.style.', 'all styling belongs in css/app.css');
    }
  });

  return found;
}

export async function loadAcorn() {
  try {
    return await import('acorn');
  } catch {
    return null;
  }
}
