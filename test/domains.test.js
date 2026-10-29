const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// fresh data folder before the db loads
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-domains-'));
const { db } = require('../src/db');
const { createLogins } = require('../src/logins');
const { createDomains, normalise } = require('../src/domains');

const DAY = 86400000;
const BASE = 'pad.test';

test('hostnames are trimmed, lowercased, lose one trailing dot and are stored as their A-label', () => {
  assert.equal(normalise(' WWW.Example.COM. ', BASE).host, 'www.example.com');
  assert.equal(normalise('example.com', BASE).host, 'example.com');
  assert.equal(normalise('bücher.example', BASE).host, 'xn--bcher-kva.example');
  assert.equal(normalise('xn--bcher-kva.example', BASE).host, 'xn--bcher-kva.example');
});

test('hostnames with a scheme, port, path or *, under the base domain, IPs, one label or too long are refused', () => {
  for (const bad of ['https://example.com', 'example.com:8080', 'example.com/page', '*.example.com', 'pad.test', 'www.pad.test', 'a.b.pad.test', 'PAD.TEST.',
    '192.0.2.1', '[2001:db8::1]', '2001:db8::1', 'localhost', 'example', '', '   ', 'example..com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(126)}com`, 'example.com..', '.example.com', 'exa mple.com']) {
    assert.ok(normalise(bad, BASE).err, `${bad} should be refused`);
  }
  assert.ok(normalise(`${'a'.repeat(63)}.com`, BASE).host);
  assert.match(normalise('blog.pad.test', BASE).err, /pad\.test/);
});
