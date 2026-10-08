const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

// fresh data folder and config before the app loads
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-test-'));
process.env.BASE_URL = 'http://pad.test';
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.QUOTA_MB = '1';
process.env.MAX_FILE_MB = '1';
delete process.env.SMTP_HOST;
delete process.env.TURNSTILE_SECRET_KEY;

// without SMTP the app prints mail to the console; keep it so tests can follow the links
const mail = [];
const log = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail not configured]')) mail.push(s); else log(...a); };

const app = require('../src/server');
const { db } = require('../src/db');
const U = require('../src/util');

// every request gets its own client IP so the per-IP rate limits stay out of the way
let ipN = 0;
const ip = () => `10.0.${(ipN >> 8) & 255}.${ipN++ & 255}`;
const req = (method, url, host = 'pad.test') => request(app)[method](url).set('Host', host).set('X-Forwarded-For', ip());
const lastLink = (kind) => mail.join('\n').match(new RegExp(`${kind}\\?token=([\\w-]+)`, 'g')).pop().split('=')[1];

async function signup(username, email) {
  return req('post', '/signup').type('form').send({ username, email, password: 'longpassword1', agree: '1' });
}
async function member(username, email = `${username}@example.com`) {
  await signup(username, email);
  const res = await req('get', `/verify?token=${lastLink('verify')}`);
  assert.equal(res.status, 302);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  const dash = await req('get', '/dashboard').set('Cookie', cookie);
  const csrf = dash.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { cookie, csrf };
}
const upload = (m, name, content) => req('post', '/dashboard/upload').set('Cookie', m.cookie)
  .field('_csrf', m.csrf).field('dir', '').attach('files', Buffer.from(content), name);

test('site names: DNS-safe, not reserved', () => {
  for (const ok of ['bob', 'my-pad', 'a1b']) assert.ok(U.validUsername(ok), ok);
  for (const bad of ['ab', '-bob', 'bob-', 'b--b', 'Bob', 'admin', 'www', 'a'.repeat(31), 'bob.x']) assert.ok(!U.validUsername(bad), bad);
});

test('member paths cannot escape the site folder', () => {
  assert.equal(U.safeRel('pics/a.png'), 'pics/a.png');
  for (const bad of ['../x.html', 'a/../../x.html', '.env', 'x.php', '_hw/x.html', 'a/b/c/d/e/f/g.html', '']) assert.equal(U.safeRel(bad), null, bad);
});

test('phishing signals', () => {
  assert.deepEqual(U.phishSignals('<title>My dog</title><input type="text">'), []);
  assert.deepEqual(U.phishSignals('<input type="password">'), ['password field']);
  assert.deepEqual(U.phishSignals('<input autocomplete="cc-number">'), ['card field']);
  assert.deepEqual(U.phishSignals('<title>PayPal - Log in</title>'), ['"PayPal" in title']);
});

test('admin comes from a confirmed email in ADMIN_EMAILS, not from a site name', async () => {
  const boss = await member('boss', 'boss@example.com');
  assert.equal((await req('get', '/admin').set('Cookie', boss.cookie)).status, 200);
  const other = await member('notboss');
  assert.equal((await req('get', '/admin').set('Cookie', other.cookie)).status, 404);
});

test('state-changing forms need the CSRF token and our own Origin', async () => {
  const m = await member('csrf-check');
  const noToken = await req('post', '/dashboard/tagline').set('Cookie', m.cookie).type('form').send({ tagline: 'x' });
  assert.equal(noToken.status, 403);
  const crossSite = await req('post', '/dashboard/tagline').set('Cookie', m.cookie).set('Origin', 'http://evil.pad.test').type('form').send({ _csrf: m.csrf, tagline: 'x' });
  assert.equal(crossSite.status, 403);
  const ok = await req('post', '/dashboard/tagline').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, tagline: 'x' });
  assert.equal(ok.status, 302);
});

test('uploads are served on the member subdomain, with type and quota limits', async () => {
  const m = await member('uploader');
  assert.equal((await upload(m, 'hello.html', '<h1>hi</h1>')).status, 200);
  const page = await req('get', '/hello.html', 'uploader.pad.test');
  assert.equal(page.status, 200);
  assert.equal(page.text, '<h1>hi</h1>');

  const php = await upload(m, 'shell.php', '<?php');
  assert.match(php.text, /Skipped: shell\.php/);
  assert.equal((await req('get', '/shell.php', 'uploader.pad.test')).status, 404);

  // quota is 1 MB: the second 600 KB file does not fit
  await upload(m, 'a.txt', 'x'.repeat(600 * 1024));
  assert.match((await upload(m, 'b.txt', 'x'.repeat(600 * 1024))).text, /over your 1 MB limit/);
});

test('member sites refuse dotfiles and traversal', async () => {
  for (const p of ['/.env', '/%2e%2e/puppypad.db', '/..%2f..%2fpuppypad.db', '/x/../../puppypad.db']) {
    assert.equal((await req('get', p, 'uploader.pad.test')).status, 404, p);
  }
});

test('unknown and unconfirmed sites 404, banned sites 410', async () => {
  assert.equal((await req('get', '/', 'nobody-here.pad.test')).status, 404);
  await signup('unconfirmed', 'unconfirmed@example.com');
  assert.equal((await req('get', '/', 'unconfirmed.pad.test')).status, 404);

  await member('baddog');
  const boss = { cookie: (await req('post', '/login').type('form').send({ username: 'boss', password: 'longpassword1' })).headers['set-cookie'][0].split(';')[0] };
  boss.csrf = (await req('get', '/admin').set('Cookie', boss.cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await req('post', '/admin/ban').set('Cookie', boss.cookie).type('form').send({ _csrf: boss.csrf, site: 'baddog', action: 'ban', reason: 'test' });
  assert.equal((await req('get', '/', 'baddog.pad.test')).status, 410);
});

test('a deleted site name is held, a reserved one is refused', async () => {
  const m = await member('goner');
  const del = await req('post', '/dashboard/delete-account').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, password: 'longpassword1' });
  assert.match(del.text, /Account deleted/);
  assert.equal((await req('get', '/', 'goner.pad.test')).status, 404);
  assert.match((await signup('goner', 'someone-else@example.com')).text, /That site name is taken/);
  assert.match((await signup('admin', 'admin-wannabe@example.com')).text, /not available/);
});

test('pages that look like phishing are flagged once for review', async () => {
  const m = await member('fishy');
  const save = (content) => req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'login.html', content });
  await save('<title>Hello</title>');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE site = 'fishy'").get().n, 0);
  await save('<title>PayPal</title><input type="password">');
  await save('<title>PayPal</title><input type="password" name="pw">');
  const rows = db.prepare("SELECT * FROM reports WHERE site = 'fishy'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Auto-flag');
  assert.match(rows[0].details, /login\.html: password field, "PayPal" in title/);
  assert.equal((await req('get', '/login.html', 'fishy.pad.test')).status, 200); // flagged, not taken down
});

test('signup captcha: Turnstile verdict decides, and an unreachable Cloudflare refuses', async () => {
  const realFetch = globalThis.fetch;
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  const sent = [];
  const verdict = (success) => { globalThis.fetch = async (url, opts) => { sent.push([url, String(opts.body)]); return { json: async () => ({ success }) }; }; };
  try {
    const form = (username) => req('post', '/signup').type('form')
      .send({ username, email: `${username}@example.com`, password: 'longpassword1', agree: '1', 'cf-turnstile-response': 'tok123' });
    verdict(false);
    assert.match((await form('robot')).text, /human/);
    verdict(true);
    assert.match((await form('human')).text, /Check your email/);
    assert.equal(sent[1][0], 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.match(sent[1][1], /secret=test-secret&response=tok123/);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.match((await form('offline')).text, /human/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
});

const yazl = require('yazl');
function makeZip(entries) {
  const z = new yazl.ZipFile();
  for (const [name, content, opts] of entries) z.addBuffer(Buffer.from(content), name, opts);
  z.end();
  return new Promise((resolve) => { const parts = []; z.outputStream.on('data', (c) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts))); });
}
const importZip = (m, buf, dir = '') => req('post', '/dashboard/import').set('Cookie', m.cookie)
  .field('_csrf', m.csrf).field('dir', dir).attach('zip', buf, 'site.zip');

test('zip import unpacks a site, dropping its wrapping folder and OS junk', async () => {
  const m = await member('zipper');
  const res = await importZip(m, await makeZip([
    ['mysite/index.html', '<h1>moved in</h1>'],
    ['mysite/pics/dog.gif', 'GIF89a'],
    ['mysite/.DS_Store', 'junk'],
    ['__MACOSX/mysite/._index.html', 'junk'],
    ['mysite/shell.php', '<?php'],
  ]));
  assert.match(res.text, /Imported 2 files/);
  assert.match(res.text, /Skipped: shell\.php \(name or file type not allowed\)/);
  assert.doesNotMatch(res.text, /DS_Store|MACOSX/);
  assert.equal((await req('get', '/', 'zipper.pad.test')).text, '<h1>moved in</h1>');
  assert.equal((await req('get', '/pics/dog.gif', 'zipper.pad.test')).status, 200);

  await importZip(m, await makeZip([['about.html', 'old about']]), 'old');
  assert.equal((await req('get', '/old/about.html', 'zipper.pad.test')).text, 'old about');
});

test('zip import refuses traversal, links, oversized files and non-zips', async () => {
  const m = await member('zip-attack');
  // yazl won't write a ../ name, so write a same-length name and patch both copies of it in the archive
  const evil = Buffer.from((await makeZip([['xx/evil.html', 'pwned']])).toString('latin1').replaceAll('xx/evil.html', '../evil.html'), 'latin1');
  assert.match((await importZip(m, evil)).text, /could not be read.*Nothing was imported/);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'evil.html')), false);

  const res = await importZip(m, await makeZip([
    ['ok.html', 'fine'],
    ['link.html', '/etc/passwd', { mode: 0o120777 }],
    ['bomb.txt', Buffer.alloc(2 * 1048576)], // 2 MB of zeros squeezes to a few KB; the per-file limit here is 1 MB
  ]));
  assert.match(res.text, /Imported 1 file\b/);
  assert.match(res.text, /link\.html \(link\)/);
  assert.match(res.text, /bomb\.txt \(too big\)/);

  assert.match((await importZip(m, Buffer.from('not a zip at all'))).text, /could not be read/);
});
