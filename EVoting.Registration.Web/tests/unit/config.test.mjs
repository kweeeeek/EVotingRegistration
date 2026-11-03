// config.js is the only file an administrator edits. These tests make sure it is always usable, and that the page has a
// default for every setting in it (a setting added to config.js but not to the page would silently do nothing).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import config from '../../config.js';
import { validateApiBaseUrl } from '../../js/api.js';
import { ROOT } from './bundle-fixture.mjs';

describe('config.js as delivered', () => {
  test('cannot be changed while the page runs', () => {
    assert.equal(Object.isFrozen(config), true);
    assert.throws(() => {
      config.apiBaseUrl = 'https://evil.example';
    }, TypeError);
  });

  test('names a server address the page accepts (https, or this PC while developing)', () => {
    assert.equal(typeof config.apiBaseUrl, 'string');
    assert.equal(validateApiBaseUrl(config.apiBaseUrl), null);
  });

  test('times are positive numbers (the idle lock may be 0 = off)', () => {
    for (const key of ['searchDebounceMs', 'requestTimeoutMs', 'issueTimeoutMs', 'heartbeatSeconds', 'eventRefreshSeconds']) {
      assert.ok(Number.isFinite(config[key]) && config[key] > 0, `${key} = ${config[key]}`);
    }
    assert.ok(Number.isFinite(config.idleLockMinutes) && config.idleLockMinutes >= 0, `idleLockMinutes = ${config.idleLockMinutes}`);
  });

  test('the switches are true or false', () => {
    for (const key of ['quickIssue', 'autoPrint', 'clearAfterIssue']) assert.equal(typeof config[key], 'boolean', key);
  });
});

describe('the page\'s own defaults', () => {
  async function defaultsOfThePage() {
    const source = await readFile(path.join(ROOT, 'js', 'main.js'), 'utf8');
    const body = /const DEFAULTS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source)?.[1];
    assert.ok(body, 'js/main.js has no DEFAULTS block');
    return vm.runInNewContext(`({${body}})`);
  }

  test('has a value for every setting of config.js, of the same kind - and no setting config.js lacks', async () => {
    const defaults = await defaultsOfThePage();
    assert.deepEqual(Object.keys(defaults).sort(), Object.keys(config).sort());
    for (const key of Object.keys(config)) assert.equal(typeof defaults[key], typeof config[key], key);
  });

  test('without a server address in config.js the page talks to its own site (the reverse-proxy setup)', async () => {
    assert.equal((await defaultsOfThePage()).apiBaseUrl, '');
  });
});
