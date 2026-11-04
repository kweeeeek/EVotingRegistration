// The promises the page makes about safety, written as checks that fail the moment one is broken:
//   * the code never turns a string into markup or script, keeps nothing on the PC, and talks to the network in one place only;
//   * that one place sends no cookies, follows no redirects and tells nobody which page it came from;
//   * the Content-Security-Policy (in index.html and in _headers) allows nothing it does not have to, and the headers are the strict ones;
//   * printing shows the slip and nothing else.
// Every promise is also tried in a real browser by tests/e2e/scenarios/70-security.mjs and 60-print.mjs; these checks are the quick ones.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { cspForMeta, parseCsp, readHeaderCsp, readMetaCsp } from '../../tools/lib.mjs';
import { ALLOWED_IN, FORBIDDEN_NAMES, lintSource, loadAcorn } from '../../tools/lint.mjs';
import { ROOT } from './bundle-fixture.mjs';

const acorn = await loadAcorn();
const NEEDS_ACORN = acorn ? false : 'acorn is not installed - run "npm ci" first';

const read = (name) => readFile(path.join(ROOT, name), 'utf8');

/** config.js and every module of the page (not vendor/, which is third-party code with its own licence). */
async function pageFiles() {
  const files = ['config.js'];
  for (const dir of ['js', 'js/ui']) {
    for (const name of (await readdir(path.join(ROOT, dir))).sort()) if (name.endsWith('.js')) files.push(`${dir}/${name}`);
  }
  return files;
}

const parse = (source) => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walk(c, visit, node);
    else if (child && typeof child.type === 'string') walk(child, visit, node);
  }
}

const keyName = (property) => {
  if (property.computed) return null;
  return property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? String(property.key.value) : null;
};

/** The values given to a property called `name` anywhere in the source (a literal's value, or "<NodeType>" for anything computed). */
function valuesOfProperty(source, name) {
  const values = [];
  walk(parse(source), (node) => {
    if (node.type === 'Property' && keyName(node) === name) values.push(node.value.type === 'Literal' ? node.value.value : `<${node.value.type}>`);
  });
  return values;
}

// ── the code scanner itself ───────────────────────────────────────────────────────────────────────────

describe('the code scanner (tools/lint.mjs) notices what it must', { skip: NEEDS_ACORN }, () => {
  const lint = (source, file = 'js/example.js') => lintSource(acorn, source, file);
  const names = (source, file) => lint(source, file).map((f) => f.name);

  const CAUGHT = [
    ['el.innerHTML = value;', 'innerHTML'],
    ['el.outerHTML = value;', 'outerHTML'],
    ["el.insertAdjacentHTML('beforeend', value);", 'insertAdjacentHTML'],
    ['frame.srcdoc = value;', 'srcdoc'],
    ['range.createContextualFragment(value);', 'createContextualFragment'],
    ["new DOMParser().parseFromString(value, 'text/html');", 'DOMParser'],
    ['document.write(value);', 'document.write'],
    ['document.writeln(value);', 'document.writeln'],
    ["eval('1');", 'eval'],
    ["new Function('return 1');", 'Function'],
    ["document.execCommand('copy');", 'execCommand'],
    ["localStorage.setItem('a', 'b');", 'localStorage'],
    ["window.sessionStorage.getItem('a');", 'sessionStorage'],
    ["indexedDB.open('db');", 'indexedDB'],
    ["caches.open('c');", 'caches'],
    ["document.cookie = 'a=b';", 'cookie'],
    ["navigator.serviceWorker.register('/sw.js');", 'serviceWorker'],
    ['new XMLHttpRequest();', 'XMLHttpRequest'],
    ["new WebSocket('wss://x.example');", 'WebSocket'],
    ["new EventSource('/events');", 'EventSource'],
    ["navigator.sendBeacon('/x', value);", 'sendBeacon'],
    ["importScripts('x.js');", 'importScripts'],
    ["new Worker('w.js');", 'Worker'],
    ["new SharedWorker('w.js');", 'SharedWorker'],
    ["other.postMessage(value, '*');", 'postMessage'],
    ['console.log(value);', 'console'],
    ["setTimeout('go()', 10);", 'setTimeout'],
    ['setInterval(`go()`, 10);', 'setInterval'],
    ["el.setAttribute('onclick', 'go()');", "setAttribute('onclick')"],
    ["el.setAttribute('style', 'color: red');", "setAttribute('style')"],
    ["el.setAttribute('srcdoc', value);", "setAttribute('srcdoc')"],
    ["window.open('https://x.example');", 'window.open'],
    ["globalThis.open('https://x.example');", 'window.open'],
    ["el.style.color = 'red';", '.style.'],
    ["const link = 'javascript:alert(1)';", 'javascript: URL'],
    ["const link = '  JavaScript:alert(1)';", 'javascript: URL'],
    ["fetch('/api/v1/health/live');", 'fetch'],
    // the same names spelled as text
    ["el['innerHTML'] = value;", 'innerHTML'],
    ['el["outerHTML"] = value;', 'outerHTML'],
    ['window["localStorage"].clear();', 'localStorage'],
    ["window[`sessionStorage`].clear();", 'sessionStorage'],
    ["window[`fetch`]('/x');", 'fetch'],
    ["window['fetch']('/x');", 'fetch'],
  ];

  for (const [code, expected] of CAUGHT) {
    test(`finds: ${code}`, () => {
      assert.deepEqual(names(code), [expected]);
    });
  }

  test('says in which file and on which line, and why it matters', () => {
    const found = lint('const a = 1;\n\nel.innerHTML = a;\nconsole.log(a);\n', 'js/some-module.js');
    assert.deepEqual(found.map((f) => [f.file, f.line, f.name]), [
      ['js/some-module.js', 3, 'innerHTML'],
      ['js/some-module.js', 4, 'console'],
    ]);
    for (const f of found) assert.ok(f.why.length > 10, `no reason given for ${f.name}`);
  });

  test('a shorthand property is a use of the name (it is the variable that is read)', () => {
    assert.ok(names('const o = { console };').includes('console'));
  });

  test('a computed key is a use of the name', () => {
    assert.ok(names('const o = { [console]: 1 };').includes('console'));
  });

  const FINE = [
    ['names that only label something: object keys', 'const o = { innerHTML: 1, console: 2, fetch: 3, cookie: 4, eval: 5 };'],
    ['names that only label something: class members', 'class A { console() {} cookie = 1; fetch() {} static eval() {} }'],
    ['words in comments and in text', "// el.innerHTML = x\n/* eval('1') */\nconst s = 'document.cookie, localStorage and console.log';"],
    ['words in a template', 'const s = `innerHTML ${1 + 1} eval`;'],
    ['timers given a function', 'setTimeout(() => go(), 10); setInterval(go, 10);'],
    ['harmless attributes', "el.setAttribute('class', 'a'); el.setAttribute('aria-label', 'b'); el.setAttribute('data-x', 'c'); el.setAttribute('role', 'button');"],
    ['reading el.style without setting anything on it', 'const s = el.style;'],
    ['building the page safely', "el.textContent = value; document.createElement('div'); el.append(value); el.replaceChildren();"],
    ['a sentence that mentions javascript:', "const s = 'I like javascript: it is fun';"],
    ['window.opener is not window.open', 'const o = window.opener; const p = window.opened;'],
    ['names that only look similar', 'const consoleOutput = 1; const myfetch = 2; const evaluate = 3; const Functional = 4; const cookies = 5;'],
    ['a computed access with a variable (nothing to see)', 'const k = pick(); el[k] = 1;'],
  ];

  for (const [what, code] of FINE) {
    test(`leaves alone: ${what}`, () => {
      assert.deepEqual(lint(code), []);
    });
  }

  test('fetch is allowed in js/api.js and nowhere else', () => {
    assert.deepEqual(lint("const r = await fetch('/x');", 'js/api.js'), []);
    assert.deepEqual(lint("const r = await window['fetch']('/x');", 'js/api.js'), []);
    for (const file of ['js/main.js', 'js/search.js', 'js/ui/dom.js', 'config.js']) {
      assert.deepEqual(names("const r = await fetch('/x');", file), ['fetch'], file);
    }
  });

  test('the lists cannot be changed while the scanner runs, and the exception stays a single file', () => {
    assert.equal(Object.isFrozen(FORBIDDEN_NAMES), true);
    assert.equal(Object.isFrozen(ALLOWED_IN), true);
    assert.deepEqual(ALLOWED_IN, { fetch: ['js/api.js'] });
  });

  test('every forbidden name comes with a reason', () => {
    for (const [name, why] of Object.entries(FORBIDDEN_NAMES)) assert.ok(typeof why === 'string' && why.length > 10, name);
  });
});

// ── the page's own code ───────────────────────────────────────────────────────────────────────────────

describe('the code of the page', { skip: NEEDS_ACORN }, () => {
  test('is all looked at (a mistake in the file list must not make this pass for nothing)', async () => {
    const files = await pageFiles();
    assert.ok(files.length >= 20, `only ${files.length} files`);
    for (const must of ['config.js', 'js/api.js', 'js/auth.js', 'js/main.js', 'js/qr.js', 'js/slip.js', 'js/ui/dom.js', 'js/ui/detail-panel.js']) {
      assert.ok(files.includes(must), `${must} is not in the list`);
    }
  });

  test('uses none of the forbidden features (markup from strings, eval, storage, cookies, console, other network channels)', async () => {
    const problems = [];
    for (const file of await pageFiles()) {
      for (const f of lintSource(acorn, await read(file), file)) problems.push(`${f.file}:${f.line}: ${f.name} - ${f.why}`);
    }
    assert.deepEqual(problems, []);
  });

  test('imports only files of its own folder, by a relative name - no package, no address, no import() at run time', async () => {
    const problems = [];
    for (const file of await pageFiles()) {
      const dir = path.dirname(path.join(ROOT, file));
      walk(parse(await read(file)), (node) => {
        if (node.type === 'ImportExpression') problems.push(`${file}:${node.loc.start.line}: import() at run time`);
        const source = node.type === 'ImportDeclaration' || ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) ? node.source.value : null;
        if (source === null) return;
        // ".js" only: IIS and older nginx do not serve ".mjs" as JavaScript, and the browser then refuses to run the module
        const inside = /^\.{1,2}\//.test(source) && /\.js$/.test(source) && (path.resolve(dir, source) + path.sep).startsWith(ROOT + path.sep);
        if (!inside) problems.push(`${file}:${node.loc.start.line}: imports "${source}"`);
      });
    }
    assert.deepEqual(problems, []);
  });

  test('names no web address in its text except the server in config.js (and two XML names that are never fetched)', async () => {
    const xmlNames = new Set(['www.w3.org', 'schemas.xmlsoap.org']);
    const { default: config } = await import('../../config.js');
    const server = config.apiBaseUrl ? new URL(config.apiBaseUrl).host : null;
    const problems = [];
    for (const file of await pageFiles()) {
      walk(parse(await read(file)), (node) => {
        const texts = node.type === 'Literal' && typeof node.value === 'string' ? [node.value] : node.type === 'TemplateElement' ? [node.value.cooked ?? ''] : [];
        for (const text of texts) {
          for (const [, host] of text.matchAll(/\bhttps?:\/\/([^\s/'"`?#]+)/gi)) {
            if (host !== server && !xmlNames.has(host)) problems.push(`${file}:${node.loc.start.line}: ${host}`);
          }
        }
      });
    }
    assert.deepEqual(problems, []);
  });

  test('the token goes into a request in one place only (js/api.js)', async () => {
    const problems = [];
    for (const file of (await pageFiles()).filter((f) => f !== 'js/api.js')) {
      walk(parse(await read(file)), (node) => {
        if (node.type === 'Property' && /^authorization$/i.test(keyName(node) ?? '')) problems.push(`${file}:${node.loc.start.line}: an Authorization header`);
        const texts = node.type === 'Literal' && typeof node.value === 'string' ? [node.value] : node.type === 'TemplateElement' ? [node.value.cooked ?? ''] : [];
        if (texts.some((t) => /\bbearer\b/i.test(t))) problems.push(`${file}:${node.loc.start.line}: the word Bearer`);
      });
    }
    assert.deepEqual(problems, []);
  });
});

describe('how every request leaves the page (js/api.js)', { skip: NEEDS_ACORN }, () => {
  test('no cookies: every credentials setting is "omit" - there are no other values anywhere in the page', async () => {
    let found = 0;
    for (const file of await pageFiles()) {
      const values = valuesOfProperty(await read(file), 'credentials');
      for (const v of values) assert.equal(v, 'omit', `${file}: credentials is ${v}`);
      if (file === 'js/api.js') found = values.length;
    }
    assert.ok(found >= 2, `only ${found} credentials settings were found in js/api.js - both requests (the call and the reachability probe) must set it`);
  });

  test('a redirect is an error, so a token can never be handed on to another address', async () => {
    const values = valuesOfProperty(await read('js/api.js'), 'redirect');
    assert.deepEqual(values, ['error']);
    for (const file of (await pageFiles()).filter((f) => f !== 'js/api.js')) assert.deepEqual(valuesOfProperty(await read(file), 'redirect'), [], file);
  });

  test('the address of the page is never sent along (Referer) and nothing is stored by the browser cache', async () => {
    const source = await read('js/api.js');
    const policies = valuesOfProperty(source, 'referrerPolicy');
    assert.ok(policies.length >= 2 && policies.every((v) => v === 'no-referrer'), policies.join(', '));
    const caches = valuesOfProperty(source, 'cache');
    assert.ok(caches.length >= 2 && caches.every((v) => v === 'no-store'), caches.join(', '));
    for (const file of (await pageFiles()).filter((f) => f !== 'js/api.js')) assert.deepEqual(valuesOfProperty(await read(file), 'referrerPolicy'), [], file);
  });

  test('a request is either an ordinary CORS call or the one no-cors reachability probe', async () => {
    const modes = valuesOfProperty(await read('js/api.js'), 'mode').sort();
    assert.deepEqual(modes, ['cors', 'no-cors']);
  });

  test('the token is read from memory only (a getter given to the client), never from storage or a cookie', async () => {
    const source = await read('js/api.js');
    assert.match(source, /getToken/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  });
});

// ── the policies and the headers ──────────────────────────────────────────────────────────────────────

describe('the Content-Security-Policy', () => {
  async function policies() {
    const metaText = readMetaCsp(await read('index.html'));
    const headerText = readHeaderCsp(await read('_headers'));
    assert.ok(metaText, 'index.html has no policy');
    assert.ok(headerText, '_headers has no policy');
    return { meta: { text: metaText, directives: parseCsp(metaText) }, header: { text: headerText, directives: parseCsp(headerText) } };
  }

  for (const where of ['meta', 'header']) {
    describe(where === 'meta' ? 'in index.html' : 'in _headers', () => {
      test('nothing is allowed unless it is named: default-src none, and only this site for scripts, styles, fonts and images', async () => {
        const { directives } = (await policies())[where];
        assert.equal(directives['default-src'], "'none'");
        for (const name of ['script-src', 'style-src', 'font-src', 'img-src']) assert.equal(directives[name], "'self'", name);
      });

      test('the page may talk to this site and to the one server - nothing else', async () => {
        const tokens = (await policies())[where].directives['connect-src'].split(' ');
        assert.equal(tokens[0], "'self'");
        assert.ok(tokens.length <= 2, `connect-src names more than one server: ${tokens.join(' ')}`);
        for (const origin of tokens.slice(1)) {
          assert.match(origin, /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/, origin);
        }
      });

      test('no base address, no forms, no plug-ins', async () => {
        const { directives } = (await policies())[where];
        for (const name of ['base-uri', 'form-action', 'object-src']) assert.equal(directives[name], "'none'", name);
      });

      test('a string cannot become script or markup: Trusted Types are required and no policy may be created', async () => {
        const { directives } = (await policies())[where];
        assert.equal(directives['require-trusted-types-for'], "'script'");
        assert.equal(directives['trusted-types'], "'none'");
      });

      test('no unsafe keyword, no wildcard, no data:/blob: sources', async () => {
        assert.doesNotMatch((await policies())[where].text, /unsafe-|\*|\bdata:|\bblob:|\bfilesystem:|nonce-|sha\d{3}-/);
      });
    });
  }

  test('the headers also forbid being shown inside another page (a <meta> tag cannot carry frame-ancestors)', async () => {
    const { meta, header } = await policies();
    assert.equal(header.directives['frame-ancestors'], "'none'");
    assert.equal(meta.directives['frame-ancestors'], undefined);
  });

  test('the two are the same policy (apart from the one directive a <meta> tag cannot carry)', async () => {
    const { meta, header } = await policies();
    assert.deepEqual(meta.directives, parseCsp(cspForMeta(header.text)));
  });
});

describe('the other response headers (_headers)', () => {
  function blocksOf(text) {
    const blocks = new Map();
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') current = null;
      else if (/^\s*#/.test(raw)) continue;
      else if (!/^\s/.test(raw)) {
        current = new Map();
        blocks.set(raw.trim(), current);
      } else if (current) {
        const colon = raw.indexOf(':');
        current.set(raw.slice(0, colon).trim().toLowerCase(), raw.slice(colon + 1).trim());
      }
    }
    return blocks;
  }

  test('every page: no sniffing, no framing, no Referer, no camera or microphone or location, own origin only, always checked for a newer copy', async () => {
    const all = blocksOf(await read('_headers')).get('/*');
    assert.ok(all, 'there is no "/*" block');
    assert.equal(all.get('x-content-type-options'), 'nosniff');
    assert.equal(all.get('x-frame-options'), 'DENY');
    assert.equal(all.get('referrer-policy'), 'no-referrer');
    assert.equal(all.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(all.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(all.get('cache-control'), 'no-cache');
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) assert.ok(all.get('permissions-policy').includes(feature), feature);
  });

  test('nothing is kept for a long time (a changed script, page or style sheet is picked up at the next load)', async () => {
    const blocks = blocksOf(await read('_headers'));
    assert.deepEqual([...blocks.keys()], ['/*'], 'one block for every file: the page has no file that may be kept');
    for (const [route, headers] of blocks) assert.doesNotMatch(headers.get('cache-control') ?? '', /max-age=[1-9]/, route);
  });
});

describe('index.html', () => {
  test('is an English page that scales on a phone and asks not to be sent a Referer or listed by search engines', async () => {
    const html = await read('index.html');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  });

  test('has no script of its own: the only script is the module file', async () => {
    const html = await read('index.html');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][1], /\btype="module"/);
    assert.match(scripts[0][1], /\bsrc="js\/main\.js"/);
    assert.equal(scripts[0][2].trim(), '');
  });

  test('loads only files of its own folder', async () => {
    const html = await read('index.html');
    const references = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(references.length >= 3, references.join(', '));
    for (const reference of references) assert.match(reference, /^[a-z0-9][a-z0-9/_.-]*$/i, reference);
  });

  test('names no web address except the one in its policy', async () => {
    const html = await read('index.html').then((t) => t.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''));
    assert.doesNotMatch(html, /https?:\/\//);
  });

  test('the print area is empty, and hidden from screen readers (the slip is put there only while printing)', async () => {
    assert.match(await read('index.html'), /<div id="print-root" aria-hidden="true"><\/div>/);
  });

  test('says what it needs when the script cannot start', async () => {
    const html = await read('index.html');
    assert.match(html, /<noscript>[\s\S]*needs JavaScript[\s\S]*<\/noscript>/);
    assert.match(html, /Starting the registration desk/);
  });
});

describe('printing (css/app.css)', () => {
  /** The style sheet without its comments (they quote rules that are deliberately NOT used). */
  const stylesheet = async () => (await read('css/app.css')).replace(/\/\*[\s\S]*?\*\//g, '');

  /** The text between the braces that follow `marker`. */
  function blockAfter(text, marker) {
    const start = text.indexOf(marker);
    if (start < 0) return null;
    const open = text.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return { inner: text.slice(open + 1, i), from: start, to: i + 1 };
    }
    return null;
  }

  /** Selector -> declarations, for a block that has no blocks inside it. */
  function rulesOf(block) {
    const rules = new Map();
    for (const [, selector, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.set(selector.trim().replace(/\s+/g, ' '), body.replace(/\s+/g, ' ').trim());
    return rules;
  }

  test('the margin of the page is none (so there is no room for a header or footer with the address of this page)', async () => {
    const css = await stylesheet();
    const pageRules = [...css.matchAll(/@page\b[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(pageRules.length >= 1, 'no @page rule');
    for (const body of pageRules) assert.match(body, /margin:\s*0\s*;?/);
  });

  test('the paper size is NOT declared: "@page { size: 80mm auto }" is ignored by Chrome and Edge, and a fixed height feeds blank paper', async () => {
    const css = await stylesheet();
    for (const [, body] of css.matchAll(/@page\b[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(body, /\bsize\s*:/);
    assert.doesNotMatch(css, /@page[^{]*size/);
  });

  test('while printing, the desk is gone and only the slip shows', async () => {
    const css = await stylesheet();
    const print = blockAfter(css, '@media print');
    assert.ok(print, 'no @media print block');
    const rules = rulesOf(print.inner);
    assert.match(rules.get('#app') ?? '', /display:\s*none\s*!important/);
    assert.match(rules.get('#print-root') ?? '', /display:\s*block\s*!important/);
  });

  test('the slip is as wide as the paper, up to 80 mm, and the QR is 50 mm - or smaller, never cut off, when the paper is narrower', async () => {
    const css = await stylesheet();
    const rules = rulesOf(blockAfter(css, '@media print').inner);
    const slip = rules.get('#print-root .slip') ?? '';
    assert.match(slip, /width:\s*100%/);
    assert.match(slip, /max-width:\s*80mm/);
    assert.match(slip, /break-inside:\s*avoid/);
    assert.doesNotMatch(slip, /(^|[;\s])(height|min-height)\s*:/, 'a fixed height would feed blank paper');
    const qr = rules.get('#print-root .slip-qr svg') ?? '';
    assert.match(qr, /width:\s*min\(50mm,\s*100%\)/);
    assert.match(qr, /aspect-ratio:\s*1/);
  });

  test('on the screen the print area is hidden', async () => {
    const css = await stylesheet();
    const print = blockAfter(css, '@media print');
    const outside = css.slice(0, print.from) + css.slice(print.to);
    const rule = /(?:^|[}\s])#print-root\s*\{([^{}]*)\}/.exec(outside);
    assert.ok(rule, 'no #print-root rule outside @media print');
    assert.match(rule[1], /display:\s*none/);
  });
});

describe('the package', () => {
  test('has no runtime dependencies (everything the page runs is in this folder), and pins what the tests use', async () => {
    const pkg = JSON.parse(await read('package.json'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, 'module');
    for (const [name, version] of Object.entries(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is not pinned: ${version}`);
  });

  test('has the lock file that "npm ci" needs', async () => {
    const lock = JSON.parse(await read('package-lock.json'));
    assert.ok(lock.lockfileVersion >= 2);
  });
});
