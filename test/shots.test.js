const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowed, isPublicIp } = require('../shots/worker');

// The screenshot worker runs member pages in a real browser; these rules are what keep a page from using it to reach inside.
test('shots worker: only normal public hostnames are fetched', () => {
  for (const ok of ['https://example.com/a.png', 'http://cdn.example.org/x.js', 'data:image/png;base64,AAAA', 'blob:https://example.com/1']) assert.equal(allowed(ok), true, ok);
  for (const bad of ['http://localhost/', 'http://app:3000/internal/shots/next', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/', 'http://printer.local/', 'http://metadata.google.internal/', 'file:///etc/passwd', 'ftp://example.com/', 'not a url']) assert.equal(allowed(bad), false, bad);
});

test('shots worker: private, loopback, link-local and reserved addresses are not public', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '2001:db8::1', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1', 'ff02::1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450::1']) assert.equal(isPublicIp(ip), true, ip);
});
