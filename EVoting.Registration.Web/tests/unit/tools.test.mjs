// The administrator's tools: set-api-url (one address, three places that must agree) and check-bundle (is the folder ready to
// upload?). The checks are tried on scratch copies that are damaged on purpose, to prove each kind of damage is noticed.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { checkBundle } from '../../tools/check-bundle.mjs';
import {
  connectSrcFor,
  cspForMeta,
  originFor,
  parseCsp,
  readApiBaseUrl,
  readHeaderBlock,
  readHeaderCsp,
  readMetaCsp,
  replaceApiBaseUrl,
  replaceHeaderConnectSrc,
  replaceMetaConnectSrc,
} from '../../tools/lib.mjs';
import { applyApiUrl, run } from '../../tools/set-api-url.mjs';
import { ROOT, withBundleCopy } from './bundle-fixture.mjs';

const real = async () => ({
  config: await readFile(path.join(ROOT, 'config.js'), 'utf8'),
  html: await readFile(path.join(ROOT, 'index.html'), 'utf8'),
  headers: await readFile(path.join(ROOT, '_headers'), 'utf8'),
});

const withoutConnectSrc = (csp) => {
  const parsed = parseCsp(csp);
  delete parsed['connect-src'];
  return parsed;
};

describe('reading a Content-Security-Policy', () => {
  const CSP = "default-src 'none'; script-src   'self'; connect-src 'self' https://api.test;; frame-ancestors 'none'; report-uri /r; SANDBOX";

  test('parseCsp: directive names in lower case, spaces collapsed, empty parts ignored', () => {
    assert.deepEqual(parseCsp(CSP), {
      'default-src': "'none'",
      'script-src': "'self'",
      'connect-src': "'self' https://api.test",
      'frame-ancestors': "'none'",
      'report-uri': '/r',
      sandbox: '',
    });
    assert.deepEqual(parseCsp(''), {});
    assert.deepEqual(parseCsp(null), {});
  });

  test('cspForMeta drops what a <meta> tag cannot carry, so index.html and _headers can be compared', () => {
    assert.equal(cspForMeta(CSP), "default-src 'none'; script-src   'self'; connect-src 'self' https://api.test");
  });

  test('readHeaderBlock: the headers of one block of _headers, names in lower case; comments and blank lines ignored; {} for no such block', async () => {
    const text = '# a comment\n\n/*\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n\n  # another\n  Content-Security-Policy: default-src \'none\'; img-src \'self\'\n\n/static/*\n  Cache-Control: public, max-age=31536000, immutable\n';
    assert.deepEqual(readHeaderBlock(text, '/*'), { 'x-frame-options': 'DENY', 'cache-control': 'no-cache', 'content-security-policy': "default-src 'none'; img-src 'self'" });
    assert.deepEqual(readHeaderBlock(text, '/static/*'), { 'cache-control': 'public, max-age=31536000, immutable' });
    assert.deepEqual(readHeaderBlock(text, '/nothing/*'), {});
    assert.deepEqual(readHeaderBlock('', '/*'), {});
    assert.equal(readHeaderBlock((await real()).headers, '/*')['x-frame-options'], 'DENY');
  });

  test('the policy is found in index.html and in _headers; null when it is not there', async () => {
    const { html, headers } = await real();
    assert.match(readMetaCsp(html), /^default-src 'none'/);
    assert.match(readHeaderCsp(headers), /^default-src 'none'/);
    assert.equal(readMetaCsp('<html></html>'), null);
    assert.equal(readHeaderCsp('/*\n  X-Frame-Options: DENY\n'), null);
  });
});

describe('the server address, as a connect-src', () => {
  test('"" is this site only; an address adds exactly its origin', () => {
    assert.equal(connectSrcFor(''), "'self'");
    assert.equal(connectSrcFor('https://api.test'), "'self' https://api.test");
    assert.equal(connectSrcFor('  https://api.test/some/path/ '), "'self' https://api.test");
    assert.equal(connectSrcFor('https://api.test:8443'), "'self' https://api.test:8443");
    assert.equal(connectSrcFor('http://localhost:5000'), "'self' http://localhost:5000");
  });

  test('an address the page would refuse is refused here too, with the page\'s own sentence', () => {
    assert.throws(() => originFor('http://api.test'), /must start with https:\/\//);
    assert.throws(() => originFor('https://api.test/?a=1'), /must not contain a query or a fragment/);
    assert.throws(() => originFor('https://u:p@api.test'), /user name or password/);
    assert.throws(() => originFor('not a url'), /not a valid address/);
  });
});

describe('editing the three places', () => {
  test('apiBaseUrl is read and replaced in config.js, keeping the quotes the file uses', () => {
    assert.equal(readApiBaseUrl("export default { apiBaseUrl: 'https://a.test', x: 1 }"), 'https://a.test');
    assert.equal(readApiBaseUrl('export default { apiBaseUrl : "https://a.test" }'), 'https://a.test');
    assert.equal(readApiBaseUrl("export default { apiBaseUrl: '' }"), '');
    assert.equal(readApiBaseUrl('export default {}'), null);
    assert.equal(replaceApiBaseUrl("{ apiBaseUrl: 'https://a.test', x: 1 }", 'https://b.test'), "{ apiBaseUrl: 'https://b.test', x: 1 }");
    assert.equal(replaceApiBaseUrl('{ apiBaseUrl: "https://a.test" }', ''), '{ apiBaseUrl: "" }');
    assert.throws(() => replaceApiBaseUrl('{}', 'https://b.test'), /no apiBaseUrl line/);
  });

  test('only connect-src changes in the policy of index.html and of _headers', async () => {
    const { html, headers } = await real();
    const newHtml = replaceMetaConnectSrc(html, "'self' https://other.test");
    const newHeaders = replaceHeaderConnectSrc(headers, "'self' https://other.test");
    assert.equal(parseCsp(readMetaCsp(newHtml))['connect-src'], "'self' https://other.test");
    assert.equal(parseCsp(readHeaderCsp(newHeaders))['connect-src'], "'self' https://other.test");
    assert.deepEqual(withoutConnectSrc(readMetaCsp(newHtml)), withoutConnectSrc(readMetaCsp(html)));
    assert.deepEqual(withoutConnectSrc(readHeaderCsp(newHeaders)), withoutConnectSrc(readHeaderCsp(headers)));
    assert.equal(newHtml.replace('https://other.test', 'https://api.eballotsacdeco.site'), html, 'nothing else in index.html moved');
    assert.equal(newHeaders.replace('https://other.test', 'https://api.eballotsacdeco.site'), headers, 'nothing else in _headers moved');
  });

  test('a file without the policy, or a policy without connect-src, is an error - never a silent no-op', () => {
    assert.throws(() => replaceMetaConnectSrc('<html></html>', "'self'"), /no Content-Security-Policy <meta> tag/);
    assert.throws(() => replaceHeaderConnectSrc('/*\n  X-Frame-Options: DENY\n', "'self'"), /no Content-Security-Policy line/);
    assert.throws(() => replaceHeaderConnectSrc("/*\n  Content-Security-Policy: default-src 'none'\n", "'self'"), /no connect-src directive/);
    assert.throws(() => replaceMetaConnectSrc('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">', "'self'"), /no connect-src directive/);
  });
});

describe('set-api-url: applyApiUrl', () => {
  test('another site: the address in config.js and the connect-src of both policies', async () => {
    const texts = await real();
    const r = applyApiUrl(texts, 'https://api.example.com');
    assert.equal(r.apiBaseUrl, 'https://api.example.com');
    assert.equal(r.connectSrc, "'self' https://api.example.com");
    assert.equal(readApiBaseUrl(r.config), 'https://api.example.com');
    assert.equal(parseCsp(readMetaCsp(r.html))['connect-src'], r.connectSrc);
    assert.equal(parseCsp(readHeaderCsp(r.headers))['connect-src'], r.connectSrc);
  });

  test('a trailing slash is dropped', async () => {
    assert.equal(applyApiUrl(await real(), 'https://api.example.com///').apiBaseUrl, 'https://api.example.com');
  });

  test('"" means this site: config.js says "" and the policy lists only \'self\'', async () => {
    const r = applyApiUrl(await real(), '');
    assert.equal(readApiBaseUrl(r.config), '');
    assert.equal(r.connectSrc, "'self'");
    assert.equal(parseCsp(readMetaCsp(r.html))['connect-src'], "'self'");
    assert.equal(parseCsp(readHeaderCsp(r.headers))['connect-src'], "'self'");
  });

  test('changes exactly one line of config.js and leaves the rest of both policies alone', async () => {
    const texts = await real();
    const r = applyApiUrl(texts, 'https://api.example.com');
    const before = texts.config.split('\n');
    const after = r.config.split('\n');
    assert.equal(after.length, before.length);
    assert.equal(after.filter((line, i) => line !== before[i]).length, 1);
    assert.deepEqual(withoutConnectSrc(readMetaCsp(r.html)), withoutConnectSrc(readMetaCsp(texts.html)));
    assert.deepEqual(withoutConnectSrc(readHeaderCsp(r.headers)), withoutConnectSrc(readHeaderCsp(texts.headers)));
  });

  test('doing it twice is the same as doing it once', async () => {
    const once = applyApiUrl(await real(), 'https://api.example.com');
    const twice = applyApiUrl(once, 'https://api.example.com');
    assert.deepEqual(twice, once);
  });

  test('without a _headers file only the other two are changed', async () => {
    const { config, html } = await real();
    const r = applyApiUrl({ config, html, headers: null }, 'https://api.example.com');
    assert.equal(r.headers, null);
    assert.equal(readApiBaseUrl(r.config), 'https://api.example.com');
  });

  test('an address that is not allowed changes nothing and says why', async () => {
    const texts = await real();
    for (const bad of ['http://api.example.com', 'https://api.example.com/?x=1', 'ftp://x', 'nonsense', 'https://u:p@api.example.com']) {
      assert.throws(() => applyApiUrl(texts, bad), Error, bad);
    }
  });
});

describe('set-api-url: the command', () => {
  const logger = () => {
    const lines = [];
    return { lines, log: (line) => lines.push(line) };
  };

  test('another site: files rewritten, and it says the server must list THIS page in EVOTING_ALLOWED_ORIGINS', async () => {
    await withBundleCopy(async (copy) => {
      const { lines, log } = logger();
      assert.equal(await run(['https://api.example.com', '--dir', copy.dir], { log }), 0);
      assert.equal(readApiBaseUrl(await copy.read('config.js')), 'https://api.example.com');
      assert.equal(parseCsp(readMetaCsp(await copy.read('index.html')))['connect-src'], "'self' https://api.example.com");
      assert.equal(parseCsp(readHeaderCsp(await copy.read('_headers')))['connect-src'], "'self' https://api.example.com");
      assert.ok(lines.some((l) => l.includes('apiBaseUrl is now https://api.example.com')));
      assert.ok(lines.some((l) => l.includes('EVOTING_ALLOWED_ORIGINS')));
      const after = await checkBundle(copy.dir);
      assert.deepEqual(after.problems, [], 'the folder is consistent after the change');
    });
  });

  test('this site: tells the administrator to forward /api/', async () => {
    await withBundleCopy(async (copy) => {
      const { lines, log } = logger();
      assert.equal(await run(['', '--dir', copy.dir], { log }), 0);
      assert.equal(readApiBaseUrl(await copy.read('config.js')), '');
      assert.ok(lines.some((l) => l.includes('Same-site mode') && l.includes('/api/')));
      assert.deepEqual((await checkBundle(copy.dir)).problems, []);
    });
  });

  test('a bad address: exit code 1, "Not changed", and no file touched', async () => {
    await withBundleCopy(async (copy) => {
      const before = { config: await copy.read('config.js'), html: await copy.read('index.html'), headers: await copy.read('_headers') };
      const { lines, log } = logger();
      assert.equal(await run(['http://api.example.com', '--dir', copy.dir], { log }), 1);
      assert.ok(lines[0].startsWith('Not changed:'), lines[0]);
      assert.deepEqual({ config: await copy.read('config.js'), html: await copy.read('index.html'), headers: await copy.read('_headers') }, before);
    });
  });

  test('wrong use prints how to use it and exits with 2', async () => {
    for (const args of [[], ['--help'], ['-h'], ['a', 'b']]) {
      const { lines, log } = logger();
      assert.equal(await run(args, { log }), 2, args.join(' '));
      assert.match(lines[0], /^Usage: node tools\/set-api-url\.mjs/);
    }
  });

  test('without a _headers file the other two are still changed', async () => {
    await withBundleCopy(async (copy) => {
      await rm(copy.file('_headers'));
      const { lines, log } = logger();
      assert.equal(await run(['https://api.example.com', '--dir', copy.dir], { log }), 0);
      assert.ok(lines.some((l) => l.includes('config.js, index.html updated')) && !lines.some((l) => l.includes('_headers')));
    });
  });
});

describe('check-bundle: is the folder ready to upload?', () => {
  const has = (result, pattern) => result.problems.some((p) => pattern.test(p));

  test('the folder as delivered is ready, and the code scan looked at the code', async () => {
    const r = await checkBundle(ROOT);
    assert.deepEqual(r.problems, []);
    assert.ok(r.notes.some((n) => /^config\.js: apiBaseUrl = /.test(n)), r.notes.join('\n'));
    const scan = r.notes.find((n) => /^Code scan: \d+ files looked at\.$/.test(n));
    assert.ok(scan, `the code scan did not run: ${r.notes.join(' | ')}`);
    assert.ok(Number(/\d+/.exec(scan)[0]) >= 15, scan);
  });

  test('a copy is ready too', async () => {
    await withBundleCopy(async (copy) => assert.deepEqual((await checkBundle(copy.dir)).problems, []));
  });

  test('config.js pointing somewhere the policy does not allow is reported in both policies, with the fix', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('config.js', (t) => replaceApiBaseUrl(t, 'https://other.example.com'));
      const r = await checkBundle(copy.dir);
      assert.ok(has(r, /^index\.html: connect-src is .* but config\.js needs "'self' https:\/\/other\.example\.com"\. Run: node tools\/set-api-url\.mjs "https:\/\/other\.example\.com"/), r.problems.join('\n'));
      assert.ok(has(r, /^_headers: connect-src is /), r.problems.join('\n'));
    });
  });

  test('an address over plain http (not this PC) in config.js', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('config.js', (t) => replaceApiBaseUrl(t, 'http://api.example.com'));
      assert.ok(has(await checkBundle(copy.dir), /^config\.js: .*must start with https:\/\//));
    });
  });

  test('config.js without an apiBaseUrl line', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('config.js', (t) => t.replace(/apiBaseUrl(\s*):/, 'serverUrl$1:'));
      assert.ok(has(await checkBundle(copy.dir), /^config\.js: apiBaseUrl was not found\.$/));
    });
  });

  test('a weakened policy: unsafe-inline, a wildcard, a missing directive', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('index.html', (t) => t.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"));
      const r = await checkBundle(copy.dir);
      assert.ok(has(r, /^index\.html: script-src must be exactly 'self'/), r.problems.join('\n'));
      assert.ok(has(r, /^index\.html: .*unsafe-inline/), r.problems.join('\n'));
      assert.ok(has(r, /different Content-Security-Policy/), r.problems.join('\n'));
    });
    await withBundleCopy(async (copy) => {
      for (const name of ['index.html', '_headers']) await copy.edit(name, (t) => t.replace("img-src 'self'", 'img-src *'));
      assert.ok(has(await checkBundle(copy.dir), /wildcard/));
    });
    await withBundleCopy(async (copy) => {
      for (const name of ['index.html', '_headers']) await copy.edit(name, (t) => t.replace("base-uri 'none'; ", ''));
      const r = await checkBundle(copy.dir);
      assert.ok(has(r, /^index\.html: base-uri is missing\.$/) && has(r, /^_headers: base-uri is missing\.$/), r.problems.join('\n'));
    });
  });

  test('the two policies must be the same one', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('_headers', (t) => t.replace("font-src 'self'", "font-src 'self' https://fonts.example.com"));
      assert.ok(has(await checkBundle(copy.dir), /carry different Content-Security-Policy values/));
    });
  });

  test('the page must not be allowed to be framed; without a _headers file that is only a note', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('_headers', (t) => t.replace("frame-ancestors 'none'; ", ''));
      assert.ok(has(await checkBundle(copy.dir), /frame-ancestors 'none' is missing/));
    });
    await withBundleCopy(async (copy) => {
      await rm(copy.file('_headers'));
      const r = await checkBundle(copy.dir);
      assert.deepEqual(r.problems, []);
      assert.ok(r.notes.some((n) => n.startsWith('_headers: not present')));
    });
  });

  test('a missing policy', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('index.html', (t) => t.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''));
      assert.ok(has(await checkBundle(copy.dir), /^index\.html: the Content-Security-Policy <meta> tag is missing\.$/));
    });
    await withBundleCopy(async (copy) => {
      await copy.edit('_headers', (t) => t.replace(/^\s*Content-Security-Policy:.*$/m, ''));
      assert.ok(has(await checkBundle(copy.dir), /^_headers: the Content-Security-Policy line is missing\.$/));
    });
  });

  test('anything inline in index.html (the policy would block it, and it is how scripts get in)', async () => {
    const cases = [
      ['<script>alert(1)</script>', /inline <script>/],
      ['<style>body{}</style>', /inline <style>/],
      ['<img src="favicon.svg" onerror="alert(1)">', /inline event handler/],
      ['<p style="color:red">x</p>', /inline style/],
    ];
    for (const [markup, pattern] of cases) {
      await withBundleCopy(async (copy) => {
        await copy.edit('index.html', (t) => t.replace('</body>', `${markup}</body>`));
        assert.ok(has(await checkBundle(copy.dir), pattern), markup);
      });
    }
  });

  test('a file the page refers to is missing', async () => {
    await withBundleCopy(async (copy) => {
      await copy.edit('index.html', (t) => t.replace('href="css/app.css"', 'href="css/gone.css"'));
      assert.ok(has(await checkBundle(copy.dir), /^index\.html: "css\/gone\.css" does not exist\.$/));
    });
    await withBundleCopy(async (copy) => {
      await copy.append('js/format.js', "\nimport './nope.js';\n");
      assert.ok(has(await checkBundle(copy.dir), /^js\/format\.js: imports "\.\/nope\.js", which does not exist\.$/));
    });
    await withBundleCopy(async (copy) => {
      await copy.append('css/app.css', '\n.x { background: url(img/gone.png); }\n');
      assert.ok(has(await checkBundle(copy.dir), /^css\/app\.css: "img\/gone\.png" does not exist\.$/));
    });
  });

  test('a script whose name ends in .mjs (a web server with the usual MIME table would not serve it as JavaScript)', async () => {
    await withBundleCopy(async (copy) => {
      await copy.write('vendor/extra.mjs', 'export const x = 1;\n');
      assert.ok(has(await checkBundle(copy.dir), /^vendor\/extra\.mjs: a script file of the page must end in \.js/));
    });
  });

  test('a style sheet that loads something from another site', async () => {
    await withBundleCopy(async (copy) => {
      await copy.append('css/app.css', '\n.x { background: url(https://tracker.example/pixel.png); }\n');
      assert.ok(has(await checkBundle(copy.dir), /^css\/app\.css: loads "https:\/\/tracker\.example\/pixel\.png" from another site\.$/));
    });
  });

  test('the licence must travel with the QR library', async () => {
    for (const licence of ['vendor/LICENSE-qrcode-generator.txt']) {
      await withBundleCopy(async (copy) => {
        await rm(copy.file(licence));
        assert.ok(has(await checkBundle(copy.dir), new RegExp(`^${licence.replace(/[.]/g, '\\.')} is missing`)), licence);
      });
    }
  });

  test('forbidden browser features in the page\'s code are found, with file and line', async () => {
    const cases = [
      ['el.innerHTML = value;', /innerHTML/],
      ['localStorage.setItem("a", "b");', /localStorage/],
      ['document.cookie = "a=b";', /cookie/],
      ['console.log(member);', /console/],
      ['fetch("https://elsewhere.example");', /fetch - all network calls go through js\/api\.js/],
      ['eval("1");', /eval/],
      ['new WebSocket("wss://x");', /WebSocket/],
    ];
    for (const [code, pattern] of cases) {
      await withBundleCopy(async (copy) => {
        const lines = (await copy.read('js/format.js')).split('\n').length;
        await copy.append('js/format.js', `\nexport const added = () => { ${code} };\n`);
        const r = await checkBundle(copy.dir);
        const found = r.problems.find((p) => p.startsWith('js/format.js:') && pattern.test(p));
        assert.ok(found, `${code}\n${r.problems.join('\n')}`);
        assert.ok(new RegExp(`^js/format\\.js:${lines + 1}:`).test(found), `wrong line in: ${found}`);
      });
    }
  });

  test('the vendored QR library is not scanned (it is third-party code, with its licence)', async () => {
    await withBundleCopy(async (copy) => {
      await copy.append('vendor/qrcode.js', '\nexport const x = () => eval("1");\n');
      assert.deepEqual((await checkBundle(copy.dir)).problems, []);
    });
  });
});
