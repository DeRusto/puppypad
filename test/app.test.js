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
process.env.SHOT_TOKEN = 'test-shot-token';
process.env.QUOTA_MB = '1';
process.env.MAX_FILE_MB = '1';
process.env.SUPPORTER_QUOTA_MB = '3';
process.env.SUPPORTER_MAX_FILE_MB = '2';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_PRICE_ID = 'price_test';
process.env.STRIPE_PRICE_ID_ANNUAL = 'price_test_year';
delete process.env.SMTP_HOST;
delete process.env.TURNSTILE_SECRET_KEY;

const Stripe = require('stripe');
// without SMTP the app prints mail to the console; keep it so tests can follow the links
const mail = [];
const log = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail not configured]')) mail.push(s); else log(...a); };

const app = require('../src/server');
// Stripe's API is never called: the app gets an in-memory Stripe, and webhooks are signed for real
const stripe = require('./fake-stripe').fakeStripe();
const { state: fake, calls: stripeCalls } = stripe;
app.setStripe(stripe);
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
  for (const bad of ['ab', '-bob', 'bob-', 'b--b', 'Bob', 'admin', 'www', 'mail', 'send', 'a'.repeat(31), 'bob.x']) assert.ok(!U.validUsername(bad), bad);
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
  // forms and titles built by script
  assert.deepEqual(U.phishSignals("const i = document.createElement('input'); i.type = 'password';"), ['password field']);
  assert.deepEqual(U.phishSignals('i.setAttribute("type", "password")'), ['password field']);
  assert.deepEqual(U.phishSignals("document.title = 'Netflix sign in'"), ['"Netflix" in title']);
  // Assembled at runtime: the literal miner embed tag trips antivirus scanners (Windows Defender quarantines this file).
  const miner = ['<script src="https://coin', 'hive.com/lib/coin', 'hive.min.js"></script>'].join('');
  assert.deepEqual(U.phishSignals(miner), ['crypto-miner script']);
  assert.deepEqual(U.phishSignals("const pw = 'type your password here';"), []);
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

test('members change their password from their profile page', async () => {
  const m = await member('pwdog');
  const other = { cookie: (await req('post', '/login').type('form').send({ username: 'pwdog', password: 'longpassword1' })).headers['set-cookie'][0].split(';')[0] };
  const page = await req('get', '/site/pwdog').set('Cookie', m.cookie);
  assert.match(page.text, /action="\/account\/password"/);
  assert.doesNotMatch((await req('get', '/site/pwdog')).text, /Change password/);
  const change = (body) => req('post', '/account/password').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...body });
  assert.match((await change({ password: 'wrongpassword', new_password: 'newpassword22', confirm_password: 'newpassword22' })).text, /current password is wrong/);
  assert.match((await change({ password: 'longpassword1', new_password: 'newpassword22', confirm_password: 'newpassword23' })).text, /do not match/);
  assert.match((await change({ password: 'longpassword1', new_password: 'short', confirm_password: 'short' })).text, /at least 10 characters/);
  assert.match((await change({ password: 'longpassword1', new_password: 'longpassword1', confirm_password: 'longpassword1' })).text, /has to be different/);
  assert.doesNotMatch((await req('get', '/site/pwdog?ok=Password%20changed.')).text, /Password changed/);
  const ok = await change({ password: 'longpassword1', new_password: 'newpassword22', confirm_password: 'newpassword22' });
  assert.equal(ok.status, 302);
  assert.match((await req('get', ok.headers.location).set('Cookie', m.cookie)).text, /Password changed/);
  assert.equal((await req('get', '/dashboard').set('Cookie', m.cookie)).status, 200); // this session stays
  assert.equal((await req('get', '/dashboard').set('Cookie', other.cookie)).status, 302); // the other one is logged out
  assert.equal((await req('post', '/login').type('form').send({ username: 'pwdog', password: 'longpassword1' })).status, 401);
  assert.equal((await req('post', '/login').type('form').send({ username: 'pwdog', password: 'newpassword22' })).status, 302);
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

test('scripts are scanned too', async () => {
  const m = await member('sneaky');
  await req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'app.js', content: "f.innerHTML = '<input type=\"password\">';" });
  const rows = db.prepare("SELECT * FROM reports WHERE site = 'sneaky'").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].details, /app\.js: password field/);
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

  // a refused file must not use up the unpacked-size budget meant for the files that get saved
  const fair = await importZip(m, await makeZip([['big.php', Buffer.alloc(1048576)], ['fair.html', 'still here']]));
  assert.match(fair.text, /Imported 1 file\b/);
  assert.match(fair.text, /big\.php \(name or file type not allowed\)/);

  // folders and junk count toward the entry limit too
  const z = new yazl.ZipFile();
  for (let i = 0; i <= 2000; i++) z.addEmptyDirectory(`d${i}/`);
  z.end();
  const many = await new Promise((resolve) => { const parts = []; z.outputStream.on('data', (c) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts))); });
  assert.match((await importZip(m, many)).text, /more than 2000 files/);
});

test('rules page carries the terms; /terms points at it', async () => {
  const res = await req('get', '/rules');
  assert.equal(res.status, 200);
  for (const s of ['Rules and terms', 'Copyright complaints', 'penalty of perjury', 'abuse@pad.test']) assert.ok(res.text.includes(s), s);
  assert.ok(!res.text.includes('Edit this page in src/views.js'));
  const t = await req('get', '/terms');
  assert.equal(t.status, 301);
  assert.equal(t.headers.location, '/rules');
});

test('signup offers starter layouts and writes the one picked', async () => {
  const form = await req('get', '/signup');
  for (const id of ['sky', 'shrine', 'notebook', 'arcade']) assert.match(form.text, new RegExp(`name="starter" value="${id}"`));
  assert.match(form.text, /value="sky" checked/);

  await req('post', '/signup').type('form').send({ username: 'diarist', email: 'diarist@example.com', password: 'longpassword1', agree: '1', starter: 'notebook' });
  const page = fs.readFileSync(path.join(process.env.DATA_DIR, 'sites', 'diarist', 'index.html'), 'utf8');
  assert.match(page, /diarist's Notebook/);
  assert.match(page, /webring\/next\?from=diarist/);
  assert.doesNotMatch(page, /\{\{/);

  // anything unknown falls back to the classic
  await req('post', '/signup').type('form').send({ username: 'oddball', email: 'oddball@example.com', password: 'longpassword1', agree: '1', starter: '../../etc/passwd' });
  assert.match(fs.readFileSync(path.join(process.env.DATA_DIR, 'sites', 'oddball', 'index.html'), 'utf8'), /oddball's Pad/);
});

test('starter previews render with stand-ins for the counter and guestbook', async () => {
  for (const id of ['sky', 'shrine', 'notebook', 'arcade']) {
    const res = await req('get', `/starters/${id}`);
    assert.equal(res.status, 200, id);
    assert.match(res.text, /yourname/);
    assert.doesNotMatch(res.text, /\/_hw\//);
    assert.doesNotMatch(res.text, /\{\{/);
  }
  assert.equal((await req('get', '/starters/nope')).status, 404);
  assert.equal((await req('get', '/starters/hasOwnProperty')).status, 404);
});

test('a missing front page is spotted, and any starter can bring one back', async () => {
  const m = await member('phoenix');
  const index = path.join(process.env.DATA_DIR, 'sites', 'phoenix', 'index.html');
  const pick = (starter, extra = {}) => req('post', '/dashboard/starter').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, starter, ...extra });
  let dash = await req('get', '/dashboard').set('Cookie', m.cookie);
  assert.doesNotMatch(dash.text, /no front page/);
  assert.match(dash.text, /Start over with a starter/);

  // an existing page is only replaced after a confirm
  fs.writeFileSync(index, 'my own page');
  let res = await pick('arcade');
  assert.equal(res.status, 200);
  assert.match(res.text, /Replace your front page\?/);
  assert.equal(fs.readFileSync(index, 'utf8'), 'my own page');
  res = await pick('arcade', { confirm: '1' });
  assert.equal(res.status, 302);
  assert.match(fs.readFileSync(index, 'utf8'), /phoenix/);
  assert.doesNotMatch(fs.readFileSync(index, 'utf8'), /my own page|\{\{/);

  // renamed away: the dashboard says so and offers every starter, and no confirm is needed
  fs.renameSync(index, path.join(path.dirname(index), 'home.html'));
  dash = await req('get', '/dashboard').set('Cookie', m.cookie);
  assert.match(dash.text, /no front page/);
  for (const id of ['sky', 'shrine', 'notebook', 'arcade']) assert.match(dash.text, new RegExp(`name="starter" value="${id}"`));
  res = await pick('notebook');
  assert.equal(res.status, 302);
  assert.match(fs.readFileSync(index, 'utf8'), /phoenix's Notebook/);
  assert.ok(fs.existsSync(path.join(path.dirname(index), 'home.html')));
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /no front page/);

  // a starter is not an edit, so it does not list a new site
  assert.equal(db.prepare("SELECT updates FROM users WHERE username = 'phoenix'").get().updates, 0);
  assert.equal((await pick('../../etc/passwd', { confirm: '1' })).status, 400);
  assert.equal((await req('post', '/dashboard/starter').set('Cookie', m.cookie).type('form').send({ starter: 'sky', confirm: '1' })).status, 403);
});

test('restoring a starter respects the file cap and the storage quota, and a refusal changes nothing', async () => {
  const m = await member('tightfit');
  const dir = path.join(process.env.DATA_DIR, 'sites', 'tightfit');
  const index = path.join(dir, 'index.html');
  const pick = (starter) => req('post', '/dashboard/starter').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, starter, confirm: '1' });
  // over quota: a big file leaves no room for a new front page, and none is written
  fs.unlinkSync(index);
  fs.writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(1048576 - 100));
  app.forgetUsage('tightfit');
  let res = await pick('sky');
  assert.equal(res.status, 400);
  assert.match(res.text, /over your 1 MB limit/);
  assert.ok(!fs.existsSync(index));
  // replacing a page near quota is refused too, and the old page stays as it was
  fs.writeFileSync(index, 'mine');
  app.forgetUsage('tightfit');
  res = await pick('arcade');
  assert.equal(res.status, 400);
  assert.equal(fs.readFileSync(index, 'utf8'), 'mine');
  fs.unlinkSync(path.join(dir, 'big.txt'));
  // at the file cap a missing front page can't be added, but a replacement still works
  fs.unlinkSync(index);
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
  app.forgetUsage('tightfit');
  res = await pick('sky');
  assert.equal(res.status, 400);
  assert.match(res.text, /2000 files/);
  assert.ok(!fs.existsSync(index));
  fs.renameSync(path.join(dir, 'f0.txt'), index);
  app.forgetUsage('tightfit');
  assert.equal((await pick('sky')).status, 302);
  assert.match(fs.readFileSync(index, 'utf8'), /tightfit's Pad/);
});

test('guestbook and report IPs are erased after 90 days', () => {
  const old = Date.now() - 91 * 86400000;
  const owner = db.prepare("INSERT INTO users (username, email, pw_hash, verified, created_at, updated_at) VALUES ('iptest', 'iptest@example.com', 'x', 1, ?, ?)").run(old, old).lastInsertRowid;
  const gbOld = db.prepare("INSERT INTO guestbook (user_id, name, message, ip, created_at) VALUES (?, 'a', 'hi', '10.0.0.1', ?)").run(owner, old).lastInsertRowid;
  const gbNew = db.prepare("INSERT INTO guestbook (user_id, name, message, ip, created_at) VALUES (?, 'b', 'hi', '10.0.0.2', ?)").run(owner, Date.now()).lastInsertRowid;
  const rpOld = db.prepare("INSERT INTO reports (site, reason, details, ip, created_at) VALUES ('iptest', 'Spam', 'x', '10.0.0.3', ?)").run(old).lastInsertRowid;
  app.housekeeping();
  assert.equal(db.prepare('SELECT ip FROM guestbook WHERE id = ?').get(gbOld).ip, null);
  assert.equal(db.prepare('SELECT ip FROM guestbook WHERE id = ?').get(gbNew).ip, '10.0.0.2');
  assert.equal(db.prepare('SELECT ip FROM reports WHERE id = ?').get(rpOld).ip, null);
});

test('clean URLs: /about serves about.html unless something called about exists', async () => {
  const m = await member('clean');
  await upload(m, 'about.html', 'about page');
  assert.equal((await req('get', '/about', 'clean.pad.test')).text, 'about page');
  assert.equal((await req('get', '/about.html', 'clean.pad.test')).text, 'about page');
  assert.equal((await req('get', '/about/', 'clean.pad.test')).status, 404);
  assert.equal((await req('get', '/nothing', 'clean.pad.test')).status, 404);
  assert.equal((await req('get', '/.env', 'clean.pad.test')).status, 404);
  // a folder of the same name wins, as it always did
  await importZip(m, await makeZip([['index.html', 'folder page']]), 'about');
  assert.equal((await req('get', '/about', 'clean.pad.test')).status, 301);
  assert.equal((await req('get', '/about/', 'clean.pad.test')).text, 'folder page');
});

test('members download their whole site as one zip', async () => {
  const m = await member('packer');
  await importZip(m, await makeZip([['index.html', '<h1>home</h1>'], ['pics/dog.gif', 'GIF89a']]));
  const res = await req('get', '/dashboard/download').set('Cookie', m.cookie).buffer(true).parse((r, cb) => {
    const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /attachment; filename="packer-\d{4}-\d{2}-\d{2}\.zip"/);
  const { readZip } = require('../src/zip');
  const { files } = await readZip(res.body, { maxFileBytes: 1e6, maxTotalBytes: 1e7 });
  assert.deepEqual(Object.fromEntries(files.map((f) => [f.name, f.data.toString()])), { 'index.html': '<h1>home</h1>', 'pics/dog.gif': 'GIF89a' });
  assert.equal((await req('get', '/dashboard/download')).status, 302); // logged out: to the login page
});

test('changing email waits for the new address to confirm, and tells the old one', async () => {
  const m = await member('mover', 'mover@example.com');
  const change = (body) => req('post', '/account/email').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...body });
  assert.match((await change({ email: 'new@example.com', password: 'wrongpassword' })).text, /password is wrong/);
  assert.match((await change({ email: 'boss@example.com', password: 'longpassword1' })).text, /already has a site/);
  assert.match((await change({ email: 'not-an-email', password: 'longpassword1' })).text, /does not look right/);

  const sent = mail.length;
  assert.equal((await change({ email: 'New@Example.com', password: 'longpassword1' })).status, 302);
  assert.ok(mail.slice(sent).some((s) => s.includes('to=mover@example.com') && s.includes('being changed')));
  assert.equal(db.prepare('SELECT email FROM users WHERE username = ?').get('mover').email, 'mover@example.com'); // not yet

  const token = lastLink('account/email/confirm');
  assert.match((await req('get', `/account/email/confirm?token=${token}`)).text, /Your email is now <b>new@example\.com<\/b>/);
  assert.equal(db.prepare('SELECT email, new_email FROM users WHERE username = ?').get('mover').email, 'new@example.com');
  assert.match((await req('get', `/account/email/confirm?token=${token}`)).text, /no longer valid/); // one use only
  // the new address now works for password reset
  await req('post', '/forgot').type('form').send({ email: 'new@example.com' });
  assert.ok(mail.at(-1).includes('to=new@example.com'));
});

test('an email taken while waiting for confirmation is not handed over', async () => {
  const m = await member('slowpoke');
  await req('post', '/account/email').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, email: 'race@example.com', password: 'longpassword1' });
  const token = lastLink('account/email/confirm');
  await member('quick', 'race@example.com');
  assert.match((await req('get', `/account/email/confirm?token=${token}`)).text, /Nothing was changed/);
});

test('new sites stay off the public lists until edited and a day old', async () => {
  const m = await member('newbie');
  const inLists = async () => {
    const browse = (await req('get', '/browse')).text;
    const home = (await req('get', '/')).text;
    return { browse: browse.includes('/site/newbie'), home: home.includes('/site/newbie') };
  };
  assert.deepEqual(await inLists(), { browse: false, home: false });
  assert.match((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /only after your first edit and once it is 24 hours old/);
  // its address and profile work from the start
  assert.equal((await req('get', '/', 'newbie.pad.test')).status, 200);
  assert.equal((await req('get', '/site/newbie')).status, 200);

  await upload(m, 'index.html', '<h1>mine now</h1>');
  assert.deepEqual(await inLists(), { browse: false, home: false }); // edited, but brand new

  db.prepare('UPDATE users SET created_at = ? WHERE username = ?').run(Date.now() - 25 * 3600000, 'newbie');
  assert.deepEqual(await inLists(), { browse: true, home: true });
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /only after your first edit/);

  // old but never edited: still off the lists, and the webring skips it
  await member('idle');
  db.prepare('UPDATE users SET created_at = ? WHERE username = ?').run(Date.now() - 25 * 3600000, 'idle');
  assert.equal((await req('get', '/browse')).text.includes('/site/idle'), false);
  for (let i = 0; i < 10; i++) assert.doesNotMatch((await req('get', '/webring/random')).headers.location, /idle|quick|slowpoke/);
  assert.equal((await req('get', '/webring/next?from=newbie')).headers.location.includes('idle'), false);
});

test('the drag-and-drop uploader gets JSON back', async () => {
  const m = await member('dropper');
  const res = await req('post', '/dashboard/upload').set('Cookie', m.cookie).set('Accept', 'application/json')
    .field('_csrf', m.csrf).field('dir', 'pics').attach('files', Buffer.from('GIF89a'), 'a.gif').attach('files', Buffer.from('<?php'), 'b.php');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { saved: 1, skipped: ['b.php (name or file type not allowed)'] });
  assert.equal((await req('get', '/pics/a.gif', 'dropper.pad.test')).status, 200);
  const bad = await req('post', '/dashboard/upload').set('Cookie', m.cookie).set('Accept', 'application/json')
    .field('_csrf', 'wrong').attach('files', Buffer.from('x'), 'c.txt');
  assert.equal(bad.status, 403);
  assert.ok(bad.body.error);
  // results come back through the dashboard's ?ok= and ?err=
  const dash = await req('get', '/dashboard?dir=pics&ok=Uploaded%201%20file.&err=Skipped%3A%20b.php.').set('Cookie', m.cookie);
  assert.match(dash.text, /Uploaded 1 file\./);
  assert.match(dash.text, /Skipped: b\.php\./);
});

// sends a multipart upload in two halves, running `between` once the server has started on it
async function slowUpload(m, url, field, name, content, between) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const b = 'slowboundary';
  const head = `--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${m.csrf}\r\n--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  // the first byte of the file goes with the headers: the parser opens the file only once it sees some of it
  const first = Buffer.concat([Buffer.from(head), content.subarray(0, 1)]);
  const tail = Buffer.concat([content.subarray(1), Buffer.from(`\r\n--${b}--\r\n`)]);
  try {
    return await new Promise((resolve, reject) => {
      const r = require('http').request({ port: server.address().port, host: '127.0.0.1', method: 'POST', path: url, headers: {
        Host: 'pad.test', Cookie: m.cookie, 'X-Forwarded-For': ip(), 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': first.length + tail.length,
      } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      r.on('error', reject);
      r.write(first);
      // multer only opens its temp file once auth has let the request through, so wait for that file
      // before pulling the rug: anything sooner would be turned away by auth, not by the check under test
      const tmp = path.join(process.env.DATA_DIR, 'tmp');
      const before = new Set(fs.readdirSync(tmp));
      const started = Date.now();
      const poll = setInterval(() => {
        if (!fs.readdirSync(tmp).some((f) => !before.has(f))) {
          if (Date.now() - started > 5000) { clearInterval(poll); r.destroy(new Error('the server never started on the upload')); }
          return;
        }
        clearInterval(poll);
        between();
        r.end(tail);
      }, 10);
    });
  } finally {
    server.close();
  }
}

test('an upload or import still arriving when the member is signed out writes nothing', async () => {
  const m = await member('latecomer');
  const signOut = () => db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'latecomer')").run();
  const up = await slowUpload(m, '/dashboard/upload', 'files', 'late.html', Buffer.from('late'), signOut);
  assert.equal(up.statusCode, 302);
  assert.equal(up.headers.location, '/login');
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'sites/latecomer/late.html')), false);

  const m2 = await member('latezip');
  const zip = await makeZip([['late.html', 'late']]);
  const del = () => db.prepare("DELETE FROM users WHERE username = 'latezip'").run();
  const im = await slowUpload(m2, '/dashboard/import', 'zip', 'site.zip', zip, del);
  assert.equal(im.statusCode, 302);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'sites/latezip/late.html')), false);
});

// a form post whose body arrives after `between` runs, once the server has read the session from the headers
async function slowForm(m, url, fields, between) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  let seen = null;
  server.once('request', (r) => { seen = r; });
  const body = Buffer.from(new URLSearchParams({ _csrf: m.csrf, ...fields }).toString());
  try {
    return await new Promise((resolve, reject) => {
      const r = require('http').request({ port: server.address().port, host: '127.0.0.1', method: 'POST', path: url, headers: {
        Host: 'pad.test', Cookie: m.cookie, 'X-Forwarded-For': ip(), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length,
      } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      r.on('error', reject);
      r.write(body.subarray(0, 1));
      // ending the session any sooner would be caught by auth, not by the check under test
      const started = Date.now();
      const poll = setInterval(() => {
        if (!seen?.ctx?.user) {
          if (Date.now() - started > 5000) { clearInterval(poll); r.destroy(new Error('the server never read the session')); }
          return;
        }
        clearInterval(poll);
        between();
        r.end(body.subarray(1));
      }, 10);
    });
  } finally {
    server.close();
  }
}

test('a dashboard form still arriving when the member is signed out or banned writes nothing', async () => {
  const m = await member('slowsave');
  const signOut = () => db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'slowsave')").run();
  const save = await slowForm(m, '/dashboard/save', { path: 'late.html', content: 'late' }, signOut);
  assert.equal(save.statusCode, 302);
  assert.equal(save.headers.location, '/login');
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'sites/slowsave/late.html')), false);

  // a ban ends every session of the login, so a delete still arriving is stopped the same way
  const m2 = await member('slowdel');
  assert.equal((await upload(m2, 'keep.html', 'keep')).status, 200);
  const ban = () => {
    db.prepare("UPDATE users SET banned = 1 WHERE username = 'slowdel'").run();
    db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'slowdel')").run();
  };
  const del = await slowForm(m2, '/dashboard/delete', { path: 'keep.html' }, ban);
  assert.equal(del.headers.location, '/login');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'sites/slowdel/keep.html')));
});

test('log in with the site name or the email address', async () => {
  await member('twoways', 'TwoWays@Example.com');
  const login = (username, password = 'longpassword1') => req('post', '/login').type('form').send({ username, password });
  assert.equal((await login('twoways')).status, 302);
  assert.equal((await login('twoways@example.com')).status, 302);
  assert.equal((await login(' TWOWAYS@example.com ')).status, 302);
  const wrong = await login('twoways@example.com', 'wrongpassword');
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /Wrong site name, email or password/);
  assert.equal((await login('nobody@example.com')).status, 401);
});

test('wrong passwords count against the account whether typed as site name or email', async () => {
  await member('guessme');
  // each request comes from a new IP, so only the per-account limit can stop the eleventh
  const login = (username) => req('post', '/login').type('form').send({ username, password: 'wrongpassword' });
  for (let i = 0; i < 10; i++) assert.equal((await login(i % 2 ? 'guessme' : 'guessme@example.com')).status, 401);
  assert.equal((await login('guessme')).status, 429);
  assert.equal((await login('guessme@example.com')).status, 429);
});

test('default 404 and 410 pages link to the report form', async () => {
  await member('reportme');
  const nf = await req('get', '/missing.html', 'reportme.pad.test');
  assert.equal(nf.status, 404);
  assert.match(nf.text, /href="http:\/\/pad\.test\/report\?site=reportme"/);
  db.prepare("UPDATE users SET banned = 1 WHERE username = 'reportme'").run();
  const gone = await req('get', '/', 'reportme.pad.test');
  assert.equal(gone.status, 410);
  assert.match(gone.text, /report\?site=reportme/);
});

test('/healthz checks the database and fails under 5% free disk', async () => {
  const realStatfs = fs.statfsSync;
  const disk = (bavail) => { fs.statfsSync = () => ({ bavail, blocks: 1000 }); };
  try {
    disk(50); // exactly 5% free
    let res = await req('get', '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, db: true, disk: true });
    // by any name that isn't a member site, e.g. localhost from inside the container
    assert.equal((await req('get', '/healthz', 'localhost')).status, 200);
    assert.equal((await req('get', '/', 'localhost')).status, 404);
    disk(49);
    res = await req('get', '/healthz');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, db: true, disk: false });
    fs.statfsSync = () => { throw new Error('EIO'); };
    assert.equal((await req('get', '/healthz')).body.disk, false);
  } finally {
    fs.statfsSync = realStatfs;
  }
});

test('admin actions land in the moderation log', async () => {
  // boss@example.com already has a site from the admin test above; log in as it
  const login = await req('post', '/login').type('form').send({ username: 'boss@example.com', password: 'longpassword1' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = (await req('get', '/admin').set('Cookie', cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  await member('logged');
  db.prepare("INSERT INTO reports (site, reason, details, created_at) VALUES ('logged', 'Spam', 'buy pills', ?)").run(Date.now());
  const rid = db.prepare("SELECT id FROM reports WHERE site = 'logged'").get().id;
  const post = (url, body) => req('post', url).set('Cookie', cookie).type('form').send({ _csrf: csrf, ...body });
  await post('/admin/report-close', { id: rid });
  await post('/admin/ban', { site: 'logged', action: 'ban', reason: 'spam pages' });
  await post('/admin/ban', { site: 'logged', action: 'unban' });
  await post('/admin/ban', { site: 'logged', action: 'delete', reason: 'repeat spam' });
  const rows = db.prepare("SELECT admin, action, detail FROM admin_log WHERE site = 'logged' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.admin, r.action]), [['boss', 'close report'], ['boss', 'take down'], ['boss', 'restore'], ['boss', 'delete']]);
  assert.equal(rows[0].detail, 'Spam: buy pills');
  assert.equal(rows[1].detail, 'spam pages');
  const page = await req('get', '/admin').set('Cookie', cookie);
  assert.match(page.text, /Moderation log/);
  assert.match(page.text, /repeat spam/);
});

test('admin finds members by name, email or signup IP, and shows signups per day', async () => {
  const login = await req('post', '/login').type('form').send({ username: 'boss@example.com', password: 'longpassword1' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  await member('findme');
  db.prepare("UPDATE users SET signup_ip = '203.0.113.9' WHERE username = 'findme'").run();
  const find = async (q) => (await req('get', `/admin?q=${encodeURIComponent(q)}`).set('Cookie', cookie)).text;
  for (const q of ['FINDM', 'findme@', '203.0.113.9']) assert.match(await find(q), />findme<\/a>/, q);
  assert.doesNotMatch(await find('203.0.113'), /203\.0\.113\.9/); // IPs match whole, not in part
  assert.match(await find('100%'), /No members found/);
  // 14 whole UTC days including today: a signup at midnight 13 days ago counts, one a millisecond earlier does not
  const start = new Date().setUTCHours(0, 0, 0, 0) - 13 * 86400000;
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const ins = db.prepare("INSERT INTO users (username, email, pw_hash, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)");
  ins.run('oldest', 'oldest@example.com', start, start);
  ins.run('tooold', 'tooold@example.com', start - 1, start - 1);
  const page = (await req('get', '/admin').set('Cookie', cookie)).text;
  assert.match(page, new RegExp(`<td>${day(Date.now())}</td><td class="num">\\d+</td>`));
  assert.match(page, new RegExp(`<td>${day(start)}</td><td class="num">1</td>`));
  assert.doesNotMatch(page, new RegExp(`<td>${day(start - 1)}</td>`));
});

test('rename and move files and folders', async () => {
  const m = await member('shuffler');
  const dir = path.join(process.env.DATA_DIR, 'sites', 'shuffler');
  const move = (from, to) => req('post', '/dashboard/move').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, from, to });
  fs.mkdirSync(path.join(dir, 'pics', 'old'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pics', 'cat.png'), 'png');
  fs.writeFileSync(path.join(dir, 'pics', 'old', 'dog.png'), 'png');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');

  assert.equal((await req('get', '/dashboard/move?path=pics').set('Cookie', m.cookie)).status, 200);
  // rename a file
  let res = await move('notes.txt', 'about/notes.md');
  assert.equal(res.status, 302);
  assert.equal(fs.readFileSync(path.join(dir, 'about', 'notes.md'), 'utf8'), 'hello');
  assert.ok(!fs.existsSync(path.join(dir, 'notes.txt')));
  // move a folder with everything in it
  res = await move('pics', 'media/pics');
  assert.equal(res.status, 302);
  assert.ok(fs.existsSync(path.join(dir, 'media', 'pics', 'old', 'dog.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'pics')));
  // a backslash path lands in its folder, and the dashboard opens there
  res = await move('about/notes.md', 'about\\notes2.md');
  assert.equal(res.headers.location, `/dashboard?dir=about&ok=${encodeURIComponent('Moved about/notes.md to about/notes2.md.')}`);
  await move('about/notes2.md', 'about/notes.md');
  // refusals
  assert.match((await move('media/pics', 'media/pics/inner')).text, /cannot go inside itself/);
  assert.match((await move('about/notes.md', 'index.html')).text, /already there/);
  assert.match((await move('about/notes.md', '../escape.md')).text, /Use a path like/);
  assert.match((await move('about/notes.md', 'notes.php')).text, /Use a path like/);
  assert.match((await move('media', 'a/b/c/d')).text, /more than 6 folders deep/);
  assert.equal((await move('', 'whole-site')).status, 302); // the site root itself never moves
  assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  // a text file renamed into a page gets the phishing check
  fs.writeFileSync(path.join(dir, 'login.txt'), '<form><input type="password"></form>');
  await move('login.txt', 'login.html');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE site = 'shuffler' AND reason = 'Auto-flag'").get().n, 1);
});

test('screenshot worker API needs its token, stores only JPEGs, and clears the dirty flag', async () => {
  const dog = await member('shotdog');
  // make shotdog the oldest dirty site so /internal/shots/next picks it
  db.prepare('UPDATE users SET shot_dirty = 1, updated_at = 1000 WHERE username = ?').run('shotdog');
  assert.equal((await req('get', '/internal/shots/next')).status, 403);
  assert.equal((await req('get', '/internal/shots/next').set('x-shot-token', 'wrong')).status, 403);
  const next = await req('get', '/internal/shots/next').set('x-shot-token', 'test-shot-token');
  assert.deepEqual(next.body, { name: 'shotdog', url: 'http://shotdog.pad.test/' });
  // a non-JPEG body clears the flag without storing a file
  const bad = await req('post', '/internal/shots/shotdog').set('x-shot-token', 'test-shot-token').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(200, 1));
  assert.equal(bad.status, 204);
  assert.equal(db.prepare('SELECT shot_dirty FROM users WHERE username = ?').get('shotdog').shot_dirty, 0);
  assert.equal((await req('get', '/shots/shotdog.jpg')).status, 404);
  // a real JPEG (magic bytes) is stored and served
  db.prepare('UPDATE users SET shot_dirty = 1, updated_at = 1000 WHERE username = ?').run('shotdog');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  assert.equal((await req('post', '/internal/shots/shotdog').set('x-shot-token', 'test-shot-token').set('Content-Type', 'application/octet-stream').send(jpg)).status, 204);
  assert.equal((await req('get', '/shots/shotdog.jpg')).status, 200);
  // link previews use the screenshot unless the page names its own image; the member's bytes are otherwise untouched
  await upload(dog, 'index.html', '<html><head lang="x"><title>caf\xe9</title></head></html>');
  await upload(dog, 'own.html', '<head><meta property="og:image" content="http://x/me.png"></head>');
  const home = await req('get', '/', 'shotdog.pad.test').buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
  assert.deepEqual(home.body, Buffer.from('<html><head lang="x"><meta property="og:image" content="http://pad.test/shots/shotdog.jpg"><title>caf\xe9</title></head></html>'));
  assert.equal((await req('get', '/', 'shotdog.pad.test').set('If-None-Match', home.headers.etag)).status, 304);
  assert.doesNotMatch((await req('get', '/own', 'shotdog.pad.test')).text, /shots/);
  await upload(dog, 'old.html', '<head><!-- <meta property="og:image" content="x.png"> --></head>');
  assert.match((await req('get', '/old', 'shotdog.pad.test')).text, /shots\/shotdog\.jpg/);
  // and sites without a favicon get ours
  const icon = await req('get', '/favicon.ico', 'shotdog.pad.test');
  assert.equal(icon.status, 200);
  assert.match(icon.headers['content-type'], /svg/);
});

test('two signups racing for one name: one wins, the other is told it is taken, and the app survives', async () => {
  const realFetch = globalThis.fetch;
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  // a slow verdict, like the real Cloudflare call, is what opens the race window
  globalThis.fetch = async () => { await new Promise((r) => setTimeout(r, 150)); return { json: async () => ({ success: true }) }; };
  try {
    const form = (email) => req('post', '/signup').type('form').send({ username: 'racer', email, password: 'longpassword1', agree: '1', 'cf-turnstile-response': 'tok' });
    const [a, b] = await Promise.all([form('racer-a@example.com'), form('racer-b@example.com')]);
    assert.equal([a.text, b.text].filter((t) => t.includes('Check your email')).length, 1);
    assert.equal([a.text, b.text].filter((t) => t.includes('That site name is taken')).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'racer'").get().n, 1);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
});

test('account deletion password guesses are rate limited', async () => {
  const m = await member('careful');
  const del = () => req('post', '/dashboard/delete-account').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, password: 'wrongpassword' });
  for (let i = 0; i < 5; i++) assert.match((await del()).text, /Wrong password/);
  const sixth = await del();
  assert.equal(sixth.status, 429);
  assert.match(sixth.text, /Too many attempts/);
  assert.ok(db.prepare("SELECT 1 FROM users WHERE username = 'careful'").get()); // still there
});

test('visitors can sign a guestbook and the entry shows', async () => {
  await member('hostdog');
  const post = await req('post', '/_hw/guestbook', 'hostdog.pad.test').type('form').send({ name: 'Visitor', message: 'nice pad!' });
  assert.equal(post.status, 302);
  const page = await req('get', '/_hw/guestbook', 'hostdog.pad.test');
  assert.match(page.text, /Visitor/);
  assert.match(page.text, /nice pad!/);
});

test('guestbook holds link entries and refuses blocked words', async () => {
  const m = await member('modpad');
  const owner = (path, body) => req('post', `/dashboard/guestbook/${path}`).set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...body });
  await owner('settings', { words: 'viagra' });
  const sign = (message) => req('post', '/_hw/guestbook', 'modpad.pad.test').type('form').send({ name: 'V', message });
  assert.equal((await sign('buy at http://spam.example')).status, 302);
  assert.equal((await sign('cheap VIAGRA')).status, 400);
  const page = await req('get', '/_hw/guestbook', 'modpad.pad.test');
  assert.doesNotMatch(page.text, /spam\.example/);
  const held = db.prepare("SELECT id, approved FROM guestbook WHERE message LIKE '%spam.example'").get();
  assert.equal(held.approved, 0);
  await owner('approve', { id: held.id });
  assert.match((await req('get', '/_hw/guestbook', 'modpad.pad.test')).text, /spam\.example/);
});

test('guestbook owner can block an entry\'s IP, unblock it, and cannot touch other owners\' entries', async () => {
  const m = await member('modown');
  const other = await member('modother');
  const sign = (site, message) => req('post', '/_hw/guestbook', `${site}.pad.test`).type('form').send({ name: 'V', message });
  const post = (who, path, body) => req('post', `/dashboard/guestbook/${path}`).set('Cookie', who.cookie).type('form').send({ _csrf: who.csrf, ...body });
  await sign('modown', 'hello');
  await sign('modother', 'see http://x.example');
  const mine = db.prepare("SELECT id FROM guestbook WHERE message = 'hello'").get().id;
  const theirs = db.prepare("SELECT id FROM guestbook WHERE message LIKE '%x.example'").get().id;
  await post(other, 'block-ip', { id: mine }); // not theirs: no effect
  assert.equal(db.prepare("SELECT gb_ips FROM users WHERE username = 'modother'").get().gb_ips, '');
  await post(m, 'approve', { id: theirs }); // not mine: no effect
  assert.equal(db.prepare('SELECT approved FROM guestbook WHERE id = ?').get(theirs).approved, 0);
  await post(m, 'block-ip', { id: mine });
  const ip = db.prepare("SELECT gb_ips FROM users WHERE username = 'modown'").get().gb_ips;
  assert.ok(ip);
  await req('post', '/_hw/guestbook', 'modown.pad.test').set('X-Forwarded-For', ip).type('form').send({ name: 'V', message: 'again' }); // req() gives each call a fresh IP
  assert.equal(db.prepare("SELECT COUNT(*) n FROM guestbook WHERE message = 'again'").get().n, 0);
  await post(m, 'unblock-ip', { ip });
  assert.equal(db.prepare("SELECT gb_ips FROM users WHERE username = 'modown'").get().gb_ips, '');
});

test('site file cap: new files stop at the cap, replacements still work, deletes free slots', async () => {
  const m = await member('filecap');
  const dir = path.join(process.env.DATA_DIR, 'sites', 'filecap');
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x'); // seed to the cap on disk; 2,000 real uploads would take all day
  app.forgetUsage('filecap'); // the app keeps each site's usage, and these files arrived without it seeing
  const res = await upload(m, 'one-more.txt', 'x');
  assert.match(res.text, /too many files: 2000 max/);
  const rep = await upload(m, 'f0.txt', 'y'); // overwriting a file that is already there is not a new file
  assert.doesNotMatch(rep.text, /too many files/);
  assert.equal(fs.readFileSync(path.join(dir, 'f0.txt'), 'utf8'), 'y');
  for (const f of ['f1.txt', 'f2.txt']) // the folder also holds the starter page, so free two slots
    await req('post', '/dashboard/delete').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: f });
  const again = await upload(m, 'one-more.txt', 'x');
  assert.doesNotMatch(again.text, /too many files/);
  assert.ok(fs.existsSync(path.join(dir, 'one-more.txt')));
});

test('a visitor reports a site: it lands in the queue, and bad reports are refused', async () => {
  await member('naughty');
  const sent = await req('post', '/report').type('form').send({ site: 'https://naughty.pad.test/page.html', reason: 'Spam', details: 'sells pills', email: 'me@example.com' });
  assert.match(sent.text, /Report sent/);
  const row = db.prepare("SELECT * FROM reports WHERE site = 'naughty' AND reason = 'Spam'").get();
  assert.equal(row.details, 'sells pills');
  assert.equal(row.status, 'open');
  assert.match(mail.at(-1), /report: naughty/); // the abuse inbox hears about it
  assert.equal((await req('post', '/report').type('form').send({ site: 'nobody-here', details: 'x' })).status, 400);
  assert.equal((await req('post', '/report').type('form').send({ site: 'naughty', details: '' })).status, 400);
  const before = db.prepare('SELECT COUNT(*) n FROM reports').get().n;
  await req('post', '/report').type('form').send({ site: 'naughty', details: 'bot', website: 'http://spam' }); // honeypot
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reports').get().n, before);
});

test('report submissions are rate limited per connection', async () => {
  await member('reportlimited');
  const send = () => request(app).post('/report').set('Host', 'pad.test').set('X-Forwarded-For', '10.9.9.9').type('form').send({ site: 'reportlimited', details: 'again' });
  for (let i = 0; i < 5; i++) assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
});

test('password reset: the emailed link sets a new password once, and logs out other sessions', async () => {
  const m = await member('forgetful');
  await req('post', '/forgot').type('form').send({ email: 'forgetful@example.com' });
  const token = lastLink('reset');
  assert.equal((await req('post', '/reset').type('form').send({ token, password: 'short' })).status, 400); // too short: token not spent
  const done = await req('post', '/reset').type('form').send({ token, password: 'brandnewpassword' });
  assert.equal(done.status, 302);
  assert.equal(done.headers.location, '/dashboard');
  assert.equal((await req('get', '/dashboard').set('Cookie', m.cookie)).status, 302); // the old session is gone
  assert.equal((await req('post', '/reset').type('form').send({ token, password: 'anotherpassword' })).status, 400); // single use
  assert.equal((await req('post', '/login').type('form').send({ username: 'forgetful', password: 'longpassword1' })).status, 401);
  assert.equal((await req('post', '/login').type('form').send({ username: 'forgetful', password: 'brandnewpassword' })).status, 302);
  const unknown = await req('post', '/forgot').type('form').send({ email: 'nobody@example.com' }); // same answer, so it can't probe for accounts
  assert.match(unknown.text, /If that address has a site here/);
});

test('logging out ends the session on the server, not just in the browser', async () => {
  const m = await member('leaver');
  const before = db.prepare("SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'leaver'").get().n;
  const out = await req('post', '/logout').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  assert.equal(out.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'leaver'").get().n, before - 1);
  assert.equal((await req('get', '/dashboard').set('Cookie', m.cookie)).status, 302); // a copied cookie no longer works
});

test('deleting a file removes it, tidies emptied folders, and stays inside the site', async () => {
  const m = await member('tidy');
  const site = path.join(process.env.DATA_DIR, 'sites', 'tidy');
  await req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'a/b/page.html', content: 'x' });
  assert.ok(fs.existsSync(path.join(site, 'a/b/page.html')));
  const del = await req('post', '/dashboard/delete').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'a/b/page.html' });
  assert.equal(del.status, 302);
  assert.equal(fs.existsSync(path.join(site, 'a')), false); // both emptied folders went with it
  assert.equal((await req('get', '/a/b/page.html', 'tidy.pad.test')).status, 404);
  await member('neighbour');
  await req('post', '/dashboard/delete').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: '../neighbour/index.html' });
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'neighbour', 'index.html')));
  assert.ok(fs.existsSync(path.join(site, 'index.html')));
});

test("a member's own not_found.html is their 404 page", async () => {
  const m = await member('custom404');
  assert.doesNotMatch((await req('get', '/nope', 'custom404.pad.test')).text, /lost puppy/);
  await req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'not_found.html', content: '<h1>lost puppy</h1>' });
  const res = await req('get', '/nope', 'custom404.pad.test');
  assert.equal(res.status, 404);
  assert.equal(res.text, '<h1>lost puppy</h1>');
});

test('the main site sends a Content-Security-Policy; member sites and the editor do not', async () => {
  const m = await member('cspdog');
  const home = await req('get', '/');
  assert.match(home.headers['content-security-policy'], /script-src 'self' 'nonce-[\w+/=]+'/);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  const dash = await req('get', '/dashboard').set('Cookie', m.cookie);
  const nonce = dash.headers['content-security-policy'].match(/'nonce-([\w+/=]+)'/)[1];
  assert.ok(dash.text.includes(`<script nonce="${nonce}">`)); // the uploader runs
  assert.notEqual(nonce, (await req('get', '/dashboard').set('Cookie', m.cookie)).headers['content-security-policy'].match(/'nonce-([\w+/=]+)'/)[1]);
  assert.equal((await req('get', '/', 'cspdog.pad.test')).headers['content-security-policy'], undefined); // members may run their own scripts
  for (const p of ['/dashboard/edit', '/dashboard/edit/', '/Dashboard/Edit']) { // every spelling the router accepts
    const ed = await req('get', `${p}?path=index.html`).set('Cookie', m.cookie);
    assert.equal(ed.status, 200, p);
    assert.equal(ed.headers['content-security-policy'], undefined, p);
  }
});

test('uploads and imports go through temp files on disk and leave none behind', async () => {
  const m = await member('tempdog');
  const tmp = path.join(process.env.DATA_DIR, 'tmp');
  const site = path.join(process.env.DATA_DIR, 'sites', 'tempdog');
  assert.equal((await upload(m, 'pic.gif', 'GIF89a-one')).status, 200);
  assert.equal(fs.readFileSync(path.join(site, 'pic.gif'), 'utf8'), 'GIF89a-one');
  await upload(m, 'bad.exe', 'MZ'); // refused type: its temp file still goes
  await upload(m, 'big.txt', 'x'.repeat(1048577)); // over MAX_FILE_MB: multer stops mid-file
  await importZip(m, await makeZip([['a.html', 'zipped a'], ['b/c.css', 'p{}'], ['huge.txt', 'x'.repeat(1048577)]]));
  assert.equal(fs.readFileSync(path.join(site, 'a.html'), 'utf8'), 'zipped a');
  assert.equal(fs.readFileSync(path.join(site, 'b/c.css'), 'utf8'), 'p{}');
  await importZip(m, Buffer.from('not a zip'));
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('an uploaded page is still checked for phishing', async () => {
  const m = await member('phishup');
  await upload(m, 'login.html', '<title>PayPal login</title><input type="password">');
  assert.ok(db.prepare("SELECT 1 FROM reports WHERE site = 'phishup' AND reason = 'Auto-flag'").get());
});

test('a zip that fails partway through unpacking leaves the site and the temp folder untouched', async () => {
  const m = await member('halfzip');
  const site = path.join(process.env.DATA_DIR, 'sites', 'halfzip');
  const zip = await makeZip([['first.html', 'fine'], ['second.html', 'x'.repeat(5000)]]);
  // claim the second entry inflates to 10 bytes: yauzl aborts mid-stream once more than that comes out
  const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(10, cd + 24);
  const res = await importZip(m, zip);
  assert.match(res.text, /could not be read/);
  assert.equal(fs.existsSync(path.join(site, 'first.html')), false); // the entry unpacked before the failure never moved in
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, 'tmp')), []);
});

test('uploads are turned away while the disk is too full to hold them', async () => {
  const m = await member('fulldisk');
  const real = fs.statfsSync;
  fs.statfsSync = (p) => ({ ...real(p), bavail: 10, blocks: 1000, bsize: 4096 }); // 1% free
  try {
    const res = await upload(m, 'a.txt', 'x');
    assert.equal(res.status, 503);
    const json = await req('post', '/dashboard/upload').set('Cookie', m.cookie).set('Accept', 'application/json')
      .field('_csrf', m.csrf).field('dir', '').attach('files', Buffer.from('x'), 'b.txt');
    assert.equal(json.status, 503);
    assert.match(json.body.error, /short on space/);
  } finally { fs.statfsSync = real; }
  assert.equal((await upload(m, 'a.txt', 'x')).status, 200); // and accepted again once there is room
});

test('the space-used line stays right through uploads, edits, replacements and deletes without rewalking the folder', async () => {
  const m = await member('tally');
  const dir = path.join(process.env.DATA_DIR, 'sites', 'tally');
  const shown = async () => (await req('get', '/dashboard').set('Cookie', m.cookie)).text.match(/Space used<\/div><div class="v">(.*?) <small>of .*? in (\d+) file/).slice(1).join(' / ');
  const realWalk = U.dirSize;
  let walks = 0;
  U.dirSize = (...a) => { walks++; return realWalk(...a); };
  const truth = () => { const s = realWalk(dir); return `${U.fmtBytes(s.total)} / ${s.count}`; };
  await shown(); // fills the cache
  walks = 0;
  await upload(m, 'a.txt', 'x'.repeat(3000));
  assert.equal(await shown(), truth());
  await upload(m, 'a.txt', 'x'.repeat(10)); // replacing shrinks it
  assert.equal(await shown(), truth());
  await req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'b.html', content: 'y'.repeat(5000) });
  assert.equal(await shown(), truth());
  assert.equal(walks, 0); // all of that without walking the folder again
  await req('post', '/dashboard/delete').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'b.html' });
  assert.equal(await shown(), truth());
  U.dirSize = realWalk;
});

test('disk totals come from the background refresh, not from walking folders on each request', async () => {
  const m = await member('outside');
  const shown = async () => (await req('get', '/dashboard').set('Cookie', m.cookie)).text.match(/in (\d+) file/)[1];
  const before = await shown();
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'sites', 'outside', 'restored.txt'), 'x'); // a restore, behind the app's back
  const realWalk = U.dirSize;
  let walks = 0;
  U.dirSize = (...a) => { walks++; return realWalk(...a); };
  try {
    assert.equal(await shown(), before);
    assert.equal(walks, 0);
    await app.refreshUsage();
    assert.equal(await shown(), String(Number(before) + 1));
    assert.equal(walks, 0); // the refresh walks off the main thread, not with the blocking walker

    // an upload that lands while the refresh is walking is not undone by the walk's older totals
    const realAsync = U.dirSizeAsync;
    let release;
    // only this site's walk is held, until the upload has landed
    U.dirSizeAsync = async (dir) => { const stale = await realAsync(dir); if (dir.endsWith('outside')) await new Promise((r) => { release = r; }); return stale; };
    try {
      const refreshing = app.refreshUsage();
      while (!release) await new Promise(setImmediate);
      await upload(m, 'during.txt', 'x');
      release();
      await refreshing;
    } finally { U.dirSizeAsync = realAsync; }
    assert.equal(await shown(), String(Number(before) + 2));

    // a move while the refresh walks may be counted twice or missed, so that walk's totals are dropped too
    release = null;
    U.dirSizeAsync = async (dir) => { if (dir.endsWith('outside')) await new Promise((r) => { release = r; }); return dir.endsWith('outside') ? { total: 0, count: 0 } : realAsync(dir); };
    try {
      const refreshing = app.refreshUsage();
      while (!release) await new Promise(setImmediate);
      await req('post', '/dashboard/move').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, from: 'during.txt', to: 'moved.txt' });
      release();
      await refreshing;
    } finally { U.dirSizeAsync = realAsync; }
    assert.equal(await shown(), String(Number(before) + 2));
  } finally { U.dirSize = realWalk; }
});

test('the style editor writes puppypad.css, reads it back, keeps hand-written CSS and links it into the front page once asked', async () => {
  const m = await member('stylish');
  const root = path.join(process.env.DATA_DIR, 'sites', 'stylish');
  const css = path.join(root, 'puppypad.css');
  const page = async (q = '') => (await req('get', `/dashboard/style${q}`).set('Cookie', m.cookie)).text;
  const save = (s) => req('post', '/dashboard/style').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...s });
  const style = require('../src/style');
  const night = { ...style.PRESETS.night };
  delete night.name;

  let text = await page();
  assert.match(text, /<option selected>Comic Sans<\/option>/); // the sky preset until something is saved
  assert.doesNotMatch(text, /Add it to index.html/);
  assert.match(await page('?preset=night'), /value="#14141f"/);

  assert.equal((await save(night)).status, 302);
  assert.deepEqual(style.parse(fs.readFileSync(css, 'utf8')), night);
  text = await page();
  assert.match(text, /<option selected>solid<\/option>/);
  assert.match(text, /Add it to index.html/);

  // hand-written CSS below the block survives a save
  fs.appendFileSync(css, '\nh1 { color: hotpink; }\n');
  app.forgetUsage('stylish');
  await save({ ...night, font: 'Georgia' });
  assert.match(fs.readFileSync(css, 'utf8'), /--font: Georgia.*\n[^]*h1 \{ color: hotpink; \}/);
  assert.equal(fs.readFileSync(css, 'utf8').match(/puppypad-style:/g).length, 2); // one block: its opening and closing comments

  // anything not on the form's lists is refused, and nothing is written
  const before = fs.readFileSync(css, 'utf8');
  for (const bad of [{ font: 'x;}</style>' }, { page: 'red' }, { width: '99999' }, { cursor: 'url(evil)' }]) {
    assert.match(decodeURIComponent((await save({ ...night, ...bad })).headers.location), /err=Pick each setting/);
  }
  assert.equal(fs.readFileSync(css, 'utf8'), before);

  await req('post', '/dashboard/style/link').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /<\/style>\n<link rel="stylesheet" href="\/puppypad.css">/);
  await req('post', '/dashboard/style/link').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), index); // only once
  assert.doesNotMatch(await page(), /Add it to index.html/);
});

test('a puppypad.css written by hand is kept whole below the new block', () => {
  const style = require('../src/style');
  const s = style.clean(style.PRESETS.pastel);
  const out = style.merge('body { margin: 0; }\n', s);
  assert.ok(out.startsWith('/* puppypad-style: '));
  assert.ok(out.endsWith('*/\nbody { margin: 0; }\n'));
  assert.deepEqual(style.parse(out), s);
  assert.equal(style.merge(out, s), out); // saving the same settings again changes nothing
  assert.equal(style.parse('/* puppypad-style: {"page":"red"} */'), null);
  assert.equal(style.tail(`${out}h1 { color: red; }`), '\nbody { margin: 0; }\nh1 { color: red; }'); // the preview puts it after the new block, as the saved file does
  // only a real, active <link> counts, and the new one goes after every style block
  assert.equal(style.hasLink('<a href="/puppypad.css">css</a><!-- <link rel="stylesheet" href="/puppypad.css"> -->'), false);
  assert.equal(style.hasLink('<link rel="stylesheet" href="puppypad.css">'), true);
  assert.equal(style.hasLink('<link rel="preload" href="/puppypad.css" as="style">'), false);
  assert.equal(style.hasLink('<link rel="stylesheet" href="/puppypad.css.bak">'), false);
  assert.equal(style.tail('body { margin: 0; }'), '\nbody { margin: 0; }'); // a file with no block previews whole, as it is saved
  assert.equal(style.clean({ ...s, page: [s.page] }), null); // a repeated field is refused, not thrown on
  assert.equal(style.link('<head><style>a{}</style><style>b{}</style></head>'), '<head><style>a{}</style><style>b{}</style><link rel="stylesheet" href="/puppypad.css">\n</head>');
});

test('a new page starts from the member\'s starter layout, linked to puppypad.css', async () => {
  await req('post', '/signup').type('form').send({ username: 'scribe', email: 'scribe@example.com', password: 'longpassword1', agree: '1', starter: 'notebook' });
  const res = await req('get', `/verify?token=${lastLink('verify')}`);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  const csrf = (await req('get', '/dashboard').set('Cookie', cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const fresh = async (p) => (await req('get', `/dashboard/edit?path=${p}`).set('Cookie', cookie)).text;
  let text = await fresh('about.html');
  assert.match(text, /--desk/); // the notebook layout
  assert.match(text, /&lt;\/style&gt;\n&lt;link rel=&quot;stylesheet&quot; href=&quot;\/puppypad.css&quot;&gt;/);
  assert.doesNotMatch(await fresh('notes.txt'), /--desk/); // only pages get a layout
  await req('post', '/dashboard/starter').set('Cookie', cookie).type('form').send({ _csrf: csrf, starter: 'arcade', confirm: '1' });
  text = await fresh('more.html');
  assert.match(text, /--tile-min/); // follows the starter picked since
  assert.doesNotMatch(await fresh('index.html'), /puppypad\.css/); // an existing page opens as it is
});

test('password hashing does not block: hashes are made and checked asynchronously', async () => {
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const hash = await U.hashPw('longpassword1');
  assert.ok(yielded, 'other work ran while the hash was computed'); // scryptSync wrapped in an async function would not let it
  yielded = false;
  setImmediate(() => { yielded = true; });
  await U.checkPw('longpassword1', hash);
  assert.ok(yielded);
  assert.equal(await U.checkPw('longpassword1', hash), true);
  assert.equal(await U.checkPw('wrongpassword', hash), false);
  assert.equal(await U.checkPw('anything', 'not-a-hash'), false);
});

test('a reset link that does not work is refused before any hashing', async () => {
  const real = U.hashPw;
  let hashed = 0;
  U.hashPw = (...a) => { hashed++; return real(...a); };
  try {
    const res = await req('post', '/reset').type('form').send({ token: 'made-up', password: 'longpassword1' });
    assert.equal(res.status, 400);
    assert.equal(hashed, 0);
  } finally { U.hashPw = real; }
});

test('a password change that finishes after a reset logged everyone out changes nothing', async () => {
  const m = await member('raced');
  const realHash = U.hashPw;
  // the reset lands while the change is hashing its new password
  U.hashPw = async (pw) => {
    const h = await realHash(pw);
    if (pw === 'changedpassword') {
      db.prepare("UPDATE users SET pw_hash = ? WHERE username = 'raced'").run(await realHash('resetpassword1'));
      db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'raced')").run();
    }
    return h;
  };
  try {
    const res = await req('post', '/account/password').set('Cookie', m.cookie).type('form')
      .send({ _csrf: m.csrf, password: 'longpassword1', new_password: 'changedpassword', confirm_password: 'changedpassword' });
    assert.equal(res.headers.location, '/login');
  } finally { U.hashPw = realHash; }
  assert.equal((await req('post', '/login').type('form').send({ username: 'raced', password: 'resetpassword1' })).status, 302); // the reset's password stands
});

test('an error thrown inside an async handler is a 500, not a crashed process', async () => {
  const realCheck = U.checkPw;
  U.checkPw = () => { throw new Error('boom'); }; // /login is async; under Express 4 this rejection took the process down
  const realError = console.error;
  console.error = () => {};
  try {
    await signup('throwdog', 'throwdog@example.com');
    const res = await req('post', '/login').type('form').send({ username: 'throwdog', password: 'longpassword1' });
    assert.equal(res.status, 500);
    assert.match(res.text, /Something broke/);
  } finally {
    U.checkPw = realCheck;
    console.error = realError;
  }
  assert.equal((await req('get', '/healthz')).status, 200); // still serving
});

test('a POST that is not a form gets the normal answer, not a crash', async () => {
  const res = await req('post', '/login').set('Content-Type', 'application/json').send('{"username":"x"}');
  assert.equal(res.status, 401);
});

test('webring next and prev go the right way, with or without a trailing slash', async () => {
  const a = await member('ringa');
  const b = await member('ringb');
  for (const [m, n] of [[a, 'ringa'], [b, 'ringb']]) {
    await req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'x.html', content: 'x' });
    await req('post', '/dashboard/webring').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, webring: '1' });
    db.prepare('UPDATE users SET created_at = 0 WHERE username = ?').run(n); // past the new-site wait
  }
  for (const slash of ['', '/']) {
    assert.match((await req('get', `/webring/next${slash}?from=ringa`)).headers.location, /ringb\./);
    assert.match((await req('get', `/webring/prev${slash}?from=ringb`)).headers.location, /ringa\./);
  }
});

test('release tags compare as numbers', () => {
  const { newer } = require('../src/upgrade');
  assert.ok(newer('v0.10.0', 'v0.9.9'));
  assert.ok(newer('v1.0.0', 'v0.99.99'));
  assert.ok(!newer('v0.2.0', 'v0.2.0'));
  assert.ok(!newer('v0.2.0', 'v0.3.0'));
});

test('admin upgrade button only asks the host watcher for the release it showed', async () => {
  const login = await req('post', '/login').type('form').send({ username: 'boss@example.com', password: 'longpassword1' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = () => req('get', '/admin').set('Cookie', cookie);
  const csrf = (await page()).text.match(/name="_csrf" value="([^"]+)"/)[1];
  // answers redirect back to /admin, so a reload never re-sends the form; this returns the message they carry
  const post = async (body) => decodeURIComponent((await req('post', '/admin/upgrade').set('Cookie', cookie).type('form').send({ _csrf: csrf, ...body })).headers.location);
  const dir = path.join(process.env.DATA_DIR, 'upgrade');
  const request = path.join(dir, 'request');

  assert.match((await page()).text, /upgrade watcher is not running/);
  assert.match(await post({ action: 'check' }), /^\/admin\?err=.*not running/);
  assert.ok(!fs.existsSync(request));

  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, 'state'), `status=idle\ncurrent=v0.9.0\nlatest=v0.10.0\nurl=https://github.com/DeRusto/puppypad/releases/tag/v0.10.0\npublished_at=${now}\nseen_at=${now}\n`);
  fs.writeFileSync(path.join(dir, 'notes'), 'Add <b>things</b>\n');
  const shown = (await page()).text;
  assert.match(shown, /Running <code>v0\.9\.0<\/code>/);
  assert.match(shown, /Add &lt;b&gt;things&lt;\/b&gt;/);
  assert.match(shown, /upgrade to v0\.10\.0/);

  assert.match(await post({ action: 'upgrade', target: 'v0.11.0' }), /no longer the newest/);
  assert.match(await post({ action: 'upgrade', target: 'v0.10.0; rm -rf /' }), /no longer the newest/);
  assert.ok(!fs.existsSync(request));
  assert.match(await post({ action: 'upgrade', target: 'v0.10.0' }), /^\/admin\?ok=Upgrade queued/);
  assert.equal(fs.readFileSync(request, 'utf8'), 'upgrade v0.10.0\n');
  const following = (await req('get', '/admin?ok=Upgrade%20queued').set('Cookie', cookie)).text;
  assert.match(following, /Upgrade queued/);
  assert.match(following, /refreshes itself[\s\S]*<script data-follow/);
  assert.match(await post({ action: 'check' }), /already under way/);
  assert.equal(db.prepare("SELECT detail FROM admin_log WHERE action = 'upgrade'").get().detail, 'v0.9.0 -> v0.10.0');

  const other = await member('upgrade-nosy');
  assert.equal((await req('post', '/admin/upgrade').set('Cookie', other.cookie).type('form').send({ _csrf: other.csrf, action: 'check' })).status, 404);
});

test('pages link the stylesheet by a URL that carries its hash, so it can be cached for a year', async () => {
  const href = (await req('get', '/')).text.match(/<link rel="stylesheet" href="(\/site\.css\?v=[0-9a-f]{12})">/)[1];
  const css = await req('get', href);
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.headers['cache-control'], /max-age=31536000, immutable/);
  assert.match(css.text, /--pee:#ffe14d/);
});

test('SEO: robots, sitemap, favicon, and page meta', async () => {
  const robots = await req('get', '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers['content-type'], /text\/plain/);
  assert.match(robots.text, /Disallow: \/dashboard/);
  assert.match(robots.text, /Sitemap: http:\/\/pad\.test\/sitemap\.xml/);
  // public noindex pages stay crawlable, or crawlers never see the tag
  for (const pub of ['/login', '/signup', '/forgot', '/reset', '/feed']) assert.ok(!robots.text.includes(`Disallow: ${pub}`), pub);

  // a listed site (old enough, has an update) appears in the sitemap; a fresh one does not
  const old = Date.now() - 48 * 3600000;
  db.prepare("INSERT INTO users (username, email, pw_hash, verified, created_at, updated_at, updates) VALUES ('oldtimer', 'oldtimer@example.com', 'x', 1, ?, ?, 1)").run(old, old);
  // verified and updated, but too new to be listed (NEW_SITE_HOURS), so it must stay out of the sitemap
  const fresh = Date.now();
  db.prepare("INSERT INTO users (username, email, pw_hash, verified, created_at, updated_at, updates) VALUES ('newpuppy', 'newpuppy@example.com', 'x', 1, ?, ?, 1)").run(fresh, fresh);
  const sitemap = await req('get', '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.text, /<loc>http:\/\/pad\.test\/<\/loc>/);
  assert.match(sitemap.text, /<loc>http:\/\/pad\.test\/site\/oldtimer<\/loc><lastmod>/);
  assert.ok(!sitemap.text.includes('/site/newpuppy'));
  assert.ok(!sitemap.text.includes('/dashboard'));

  // browse canonicals are self-referential: a sorted/paged listing is not a copy of page one
  assert.match((await req('get', '/browse')).text, /<link rel="canonical" href="http:\/\/pad\.test\/browse">/);
  assert.match((await req('get', '/browse?sort=hits')).text, /<link rel="canonical" href="http:\/\/pad\.test\/browse\?sort=hits&amp;page=1">/);

  assert.equal((await req('get', '/favicon.ico')).status, 200);
  assert.equal((await req('get', '/og.svg')).status, 200);
  assert.equal((await req('get', '/og.png')).status, 200);

  const home = await req('get', '/');
  assert.match(home.text, /<meta name="description" content="[^"]*free homepage host/);
  assert.match(home.text, /<link rel="canonical" href="http:\/\/pad\.test\/">/);
  assert.match(home.text, /property="og:title"/);
  assert.match(home.text, /property="og:image" content="http:\/\/pad\.test\/og\.png"/);
  assert.match(home.text, /application\/ld\+json/);
  assert.ok(!home.text.includes('noindex'));

  const dash = await req('get', '/login');
  assert.match(dash.text, /<meta name="robots" content="noindex">/);

  const profile = await req('get', '/site/oldtimer');
  assert.match(profile.text, /<link rel="canonical" href="http:\/\/pad\.test\/site\/oldtimer">/);
});

test('the webring holds only sites that joined it', async () => {
  const a = await member('ringer');
  await member('loner');
  for (const n of ['ringer', 'loner']) db.prepare('UPDATE users SET created_at = ?, updates = 1 WHERE username = ?').run(Date.now() - 25 * 3600000, n);
  assert.match((await req('get', '/dashboard/widgets').set('Cookie', a.cookie)).text, /Join the webring/);
  await req('post', '/dashboard/webring').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, webring: '1' });
  assert.match((await req('get', '/dashboard/widgets').set('Cookie', a.cookie)).text, /Leave the webring/);
  for (let i = 0; i < 10; i++) {
    const to = (await req('get', '/webring/random')).headers.location;
    assert.notEqual(to, '/'); // lands on a joined site
    assert.doesNotMatch(to, /loner/);
  }
  assert.match((await req('get', '/webring/prev?from=loner')).headers.location, /ringer\./); // loner is not in the ring, so its neighbour is
  await req('post', '/dashboard/webring').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, webring: '0' });
  assert.equal((await req('get', '/webring/random')).headers.location.includes('ringer'), false);
});

test('a hidden site stays off listings, feeds and the ring, and asks not to be indexed', async () => {
  const a = await member('shyone');
  const f = await member('fanone');
  db.prepare('UPDATE users SET created_at = ?, updates = 1, webring = 1 WHERE username = ?').run(Date.now() - 25 * 3600000, 'shyone');
  await req('post', '/follow').set('Cookie', f.cookie).type('form').send({ _csrf: f.csrf, site: 'shyone' });
  await req('post', '/dashboard/save').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, path: 'index.html', content: 'hi' });
  assert.match((await req('get', '/browse')).text, /shyone/);
  assert.match((await req('get', '/feed').set('Cookie', f.cookie)).text, /shyone/);
  await req('post', '/dashboard/hidden').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, hidden: '1' });
  assert.match((await req('get', '/dashboard').set('Cookie', a.cookie)).text, /Show my site again/);
  assert.doesNotMatch((await req('get', '/browse')).text, /shyone/);
  assert.doesNotMatch((await req('get', '/sitemap.xml')).text, /shyone/);
  assert.doesNotMatch((await req('get', '/feed').set('Cookie', f.cookie)).text, /shyone/);
  for (let i = 0; i < 5; i++) assert.doesNotMatch((await req('get', '/webring/random')).headers.location, /shyone/);
  const page = await req('get', '/', 'shyone.pad.test');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-robots-tag'], 'noindex');
  const profile = await req('get', '/site/shyone');
  assert.equal(profile.status, 200);
  assert.equal(profile.headers['x-robots-tag'], 'noindex');
  await req('post', '/dashboard/hidden').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, hidden: '0' });
  assert.match((await req('get', '/browse')).text, /shyone/);
  assert.equal((await req('get', '/', 'shyone.pad.test')).headers['x-robots-tag'], undefined);
});

test('bandwidth guard: daily cap per site, hotlinked media throttled, usage on dashboard and admin', async () => {
  const m = await member('bigpad');
  await upload(m, 'index.html', '<p>hi</p>');
  await upload(m, 'dog.png', 'png');
  const host = 'bigpad.pad.test';
  const bw = () => db.prepare("SELECT bw_day, bw_bytes FROM users WHERE username = 'bigpad'").get();
  assert.equal((await req('get', '/', host)).status, 200);
  assert.equal(bw().bw_bytes, 9);
  assert.equal(bw().bw_day, new Date().toISOString().slice(0, 10));
  assert.match((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /Bandwidth today<\/div><div class="v">9 B <small>of 1024 MB/);
  const login = await req('post', '/login').type('form').send({ username: 'boss@example.com', password: 'longpassword1' });
  const admin = (await req('get', '/admin?q=bigpad').set('Cookie', login.headers['set-cookie'][0].split(';')[0])).text;
  assert.match(admin, /<td class="num">9 B<\/td><td><a href="\/admin\?site=bigpad&amp;q=bigpad#act">act<\/a><\/td><\/tr>/);

  // over the cap: files rest until midnight UTC; yesterday's bytes do not count
  db.prepare("UPDATE users SET bw_bytes = ? WHERE username = 'bigpad'").run(1024 * 1048576);
  const res = await req('get', '/', host);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers['retry-after']) <= 86400);
  db.prepare("UPDATE users SET bw_day = '2000-01-01' WHERE username = 'bigpad'").run();
  assert.equal((await req('get', '/', host)).status, 200);

  // media embedded by another domain is throttled; member sites and pages are not
  const get = (file, referer) => req('get', file, host).set('Referer', referer);
  for (let i = 0; i < 60; i++) assert.equal((await get('/dog.png', 'https://elsewhere.example/page')).status, 200);
  assert.equal((await get('/dog.png', 'https://elsewhere.example/page')).status, 429);
  assert.equal((await get('/dog.pn%67', 'https://elsewhere.example/page')).status, 429); // encoded name is the same file
  assert.equal((await get('/dog.png', 'http://friend.pad.test/')).status, 200);
  assert.equal((await get('/', 'https://elsewhere.example/page')).status, 200);
  assert.equal((await req('get', '/dog.png', host)).status, 200);
});

test('a member keeps a larger quota after QUOTA_MB is lowered', async () => {
  const m = await member('roomy');
  assert.equal(db.prepare("SELECT quota_mb FROM users WHERE username = 'roomy'").get().quota_mb, 1); // signup records the current quota
  db.prepare("UPDATE users SET quota_mb = 2 WHERE username = 'roomy'").run(); // as if QUOTA_MB was 2 before it dropped to 1
  await upload(m, 'a.txt', 'x'.repeat(600 * 1024));
  assert.doesNotMatch((await upload(m, 'b.txt', 'x'.repeat(600 * 1024))).text, /over your/);
  assert.match((await upload(m, 'c.txt', 'x'.repeat(900 * 1024))).text, /over your 2 MB limit/);
  assert.match((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /of 2 MB/);
  // a zip import unpacks up to the member's own quota, not the lower default
  db.prepare("UPDATE users SET quota_mb = 3 WHERE username = 'roomy'").run();
  const res = await importZip(m, await makeZip([['d.txt', 'x'.repeat(600 * 1024)], ['e.txt', 'x'.repeat(600 * 1024)]]));
  assert.doesNotMatch(res.text, /over your/);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'roomy', 'e.txt')));
});

test('restarting with a higher QUOTA_MB raises existing members; a lower one leaves them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-quota-'));
  // each run is a fresh process on the same database, like a restart after editing .env
  const start = (quota) => Number(require('child_process').execFileSync(process.execPath, ['-e', `
    const { db } = require('./src/db');
    db.prepare("INSERT OR IGNORE INTO users (username, email, pw_hash, signup_ip, created_at, updated_at) VALUES ('old', 'o@x', 'h', '1', 0, 0)").run();
    require('./src/server');
    process.stdout.write(String(db.prepare('SELECT quota_mb FROM users').get().quota_mb));
    process.exit(0);`], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, QUOTA_MB: String(quota) } }));
  assert.equal(start(50), 50);
  assert.equal(start(500), 500);
  assert.equal(start(100), 500);
});

test('members tag their site, and the dog park finds sites by name or tag', async () => {
  const m = await member('tagdog');
  const old = Date.now() - 25 * 3600000;
  db.prepare('UPDATE users SET created_at = ?, updates = 1 WHERE username = ?').run(old, 'tagdog');
  await req('post', '/dashboard/tags').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, tags: 'Pixel-Art, cats #cats <b> retro x y z' });
  assert.equal(db.prepare('SELECT tags FROM users WHERE username = ?').get('tagdog').tags, 'pixel-art cats retro x y');
  assert.match((await req('get', '/site/tagdog')).text, /href="\/browse\?q=pixel-art">#pixel-art</);
  const search = async (q) => (await req('get', `/browse?q=${encodeURIComponent(q)}`)).text;
  assert.match(await search('pixel'), /\/site\/tagdog/);
  assert.match(await search('TAGD'), /\/site\/tagdog/);
  const none = await search('nomatch%_');
  assert.doesNotMatch(none, /\/site\/tagdog/);
  assert.match(none, /No sites match/);
  assert.match(none, /name="robots" content="noindex"/);
  assert.match(await search('cats'), /sort=newest&amp;q=cats/); // sort links keep the search
  // hidden sites stay out of search too
  db.prepare('UPDATE users SET hidden = 1 WHERE username = ?').run('tagdog');
  assert.doesNotMatch(await search('pixel'), /\/site\/tagdog/);
});

test('every /browse card carries the six Card parts, with or without a screenshot', async () => {
  for (const name of ['partshot', 'partnone']) {
    const m = await member(name);
    await upload(m, 'index.html', '<h1>parts</h1>');
    db.prepare("UPDATE users SET created_at = ?, tagline = 'hi', tags = 'parts' WHERE username = ?").run(Date.now() - 25 * 3600000, name);
  }
  db.prepare('UPDATE users SET shot_dirty = 1 WHERE username = ?').run('partshot');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  assert.equal((await req('post', '/internal/shots/partshot').set('x-shot-token', 'test-shot-token').set('Content-Type', 'application/octet-stream').send(jpg)).status, 204);
  // a bare site with no tagline and no tags still gets every hook
  const bare = await member('partbare');
  await upload(bare, 'index.html', '<h1>bare</h1>');
  db.prepare('UPDATE users SET created_at = ? WHERE username = ?').run(Date.now() - 25 * 3600000, 'partbare');
  const page = (await req('get', '/browse?q=part')).text;
  assert.match(page, /<div data-part="tagline" class="t"><\/div><div data-part="tags" class="t"><\/div>/);
  for (const name of ['partshot', 'partnone', 'partbare']) {
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    // the scope class sits on the outer card, so the scoped selector `.cs-<id> [data-part=card]` reaches the inner root
    const card = page.match(new RegExp(`<li class="card cs-${id}[^"]*"><div data-part="card">[^]*?/site/${name}[^]*?</li>`));
    assert.ok(card, `${name} has an outer card keyed by its id around the inner card root`);
    for (const part of ['shot', 'name', 'tagline', 'tags', 'stats']) assert.match(card[0], new RegExp(`data-part="${part}"`), `${name} has ${part}`);
    assert.match(card[0], new RegExp(`<a data-part="name" href="[^"]*${name}[^"]*"><b>`));
  }
  assert.match(page, /<a data-part="shot" href="[^"]*"><img class="shot"/);
  assert.match(page, /<a data-part="shot" class="shot none"/);
  // other card surfaces keep the stock markup
  assert.doesNotMatch((await req('get', '/')).text, /data-part/);
});

// a member whose site is old and edited, so its card shows on /browse
async function listedMember(name) {
  const m = await member(name);
  await upload(m, 'index.html', '<h1>card</h1>');
  db.prepare('UPDATE users SET created_at = ? WHERE username = ?').run(Date.now() - 25 * 3600000, name);
  m.id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
  return m;
}
const saveCard = (m, css) => req('post', '/dashboard/card').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, css });
// the member <style> on /browse, or null when the page sends none
const memberCss = async (q) => (await req('get', `/browse?q=${q}`)).text.match(/<head>[^]*<\/head>/)[0].match(/<style>([^]*?)<\/style>/)?.[1] ?? null;

test('a card style saved on /dashboard/card shows on /browse, scoped to that card', async () => {
  const m = await listedMember('cardsave');
  assert.equal(await memberCss('cardsave'), null);
  const dash = (await req('get', '/dashboard').set('Cookie', m.cookie)).text;
  assert.match(dash, /href="\/dashboard\/card"/);

  const css = '[data-part=card] { transform: rotate(2deg) }';
  const res = await saveCard(m, css);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/dashboard\/card\?ok=/);
  assert.equal(await memberCss('cardsave'), `.cs-${m.id} [data-part=card]{transform:rotate(2deg)}`);
  // the page shows the source exactly as typed
  assert.match((await req('get', '/dashboard/card').set('Cookie', m.cookie)).text, /<textarea[^>]*>\[data-part=card\] \{ transform: rotate\(2deg\) \}<\/textarea>/);
  // the inline style comes after site.css, and /browse is never cached
  const page = await req('get', '/browse?q=cardsave');
  assert.match(page.text, /<link rel="stylesheet" href="\/site\.css[^"]*">[^]*<style>/);
  assert.doesNotMatch(page.headers['cache-control'] || '', /public|max-age=[1-9]/);
  assert.match(page.headers['cache-control'], /no-store/);
});

test('a rejected card style save keeps the typed text and the old style; an empty save is the stock card again', async () => {
  const m = await listedMember('cardreject');
  const stock = (await req('get', '/browse?q=cardreject')).text;
  await saveCard(m, '[data-part=name] { color: red }');
  const live = await memberCss('cardreject');

  const bad = await saveCard(m, '.foo { color: <b>blue</b> }');
  assert.equal(bad.status, 400); // the page again, no redirect
  assert.match(bad.text, /<p class="err" role="alert">Not saved: [^<]*<\/p>[^]*<textarea[^>]*>\.foo \{ color: &lt;b&gt;blue&lt;\/b&gt; \}<\/textarea>/);
  const big = await saveCard(m, `[data-part=name] { color: red } /*${'x'.repeat(4096)}*/`);
  assert.match(big.text, /Not saved: Card style is over 4096 bytes\./);
  assert.equal(await memberCss('cardreject'), live);

  assert.match((await saveCard(m, '  \n')).headers.location, /^\/dashboard\/card\?ok=/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM card_styles WHERE user_id = ?').get(m.id).n, 0);
  assert.equal(await memberCss('cardreject'), null);
  assert.match((await req('get', '/dashboard/card').set('Cookie', m.cookie)).text, /<textarea[^>]*><\/textarea>/);
  assert.equal((await req('get', '/browse?q=cardreject')).text.replace(/_csrf" value="[^"]*"/g, ''), stock.replace(/_csrf" value="[^"]*"/g, ''));
});

test('a sanitizer version bump rebuilds stale card styles; one it rejects shows the stock card and says so until fixed', async () => {
  const { VERSION } = require('../src/cardstyle');
  const ok = await listedMember('cardstale');
  const bad = await listedMember('cardnowbad');
  await saveCard(ok, '[data-part=card] { color: red }');
  await saveCard(bad, '[data-part=card] { color: blue }');
  // as if both were saved under an older sanitizer: stale copies, and a source the current one rejects
  db.prepare("UPDATE card_styles SET version = ?, css = '.stale{}' WHERE user_id IN (?, ?)").run(VERSION - 1, ok.id, bad.id);
  const rejected = '[data-part=card] { position: fixed }';
  db.prepare('UPDATE card_styles SET source = ? WHERE user_id = ?').run(rejected, bad.id);
  // a stale copy is never served, even before the rebuild
  assert.equal(await memberCss('cardstale'), null);

  app.rebuildCardStyles();
  assert.equal(await memberCss('cardstale'), `.cs-${ok.id} [data-part=card]{color:red}`);
  assert.equal(await memberCss('cardnowbad'), null);
  const page = (await req('get', '/dashboard/card').set('Cookie', bad.cookie)).text;
  assert.match(page, /<p class="err" role="alert">[^<]*stock card: Position[^<]*<\/p>[^]*<textarea[^>]*>\[data-part=card\] \{ position: fixed \}<\/textarea>/);
  const line = /<p class="err">Your card style no longer passes our checks, so your card shows the stock card\. <a href="\/dashboard\/card">Fix it\.<\/a><\/p>/g;
  assert.equal((await req('get', '/dashboard').set('Cookie', bad.cookie)).text.match(line)?.length, 1);
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', ok.cookie)).text, line);
  assert.doesNotMatch((await req('get', '/dashboard/card').set('Cookie', ok.cookie)).text, /class="err"/);

  await saveCard(bad, '[data-part=card] { color: green }');
  assert.doesNotMatch((await req('get', '/dashboard/card').set('Cookie', bad.cookie)).text, /class="err"/);
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', bad.cookie)).text, line);
  assert.equal(await memberCss('cardnowbad'), `.cs-${bad.id} [data-part=card]{color:green}`);
});

test('card style goes with its Site or Login, and only the current Site\'s owner can save it', async () => {
  const a = await listedMember('cardowner');
  const b = await listedMember('cardother');
  // the form saves for the current Site only; nothing in it names another
  await req('post', '/dashboard/card').set('Cookie', b.cookie).type('form').send({ _csrf: b.csrf, css: '[data-part=card] { color: red }', site: 'cardowner', user_id: a.id });
  assert.equal(await memberCss('cardowner'), null);
  assert.match(await memberCss('cardother'), new RegExp(`^\\.cs-${b.id} `));
  // someone else's session token can't save it
  assert.equal((await req('post', '/dashboard/card').set('Cookie', a.cookie).type('form').send({ _csrf: b.csrf, css: '[data-part=card] { color: blue }' })).status, 403);
  assert.equal((await req('post', '/dashboard/card').type('form').send({ css: '[data-part=card] { color: blue }' })).headers.location, '/login');

  // a banned Site can't open or post the page, and its link is hidden
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(b.id);
  assert.equal((await req('get', '/dashboard/card').set('Cookie', b.cookie)).headers.location, '/dashboard');
  assert.equal((await saveCard(b, '[data-part=card] { color: blue }')).headers.location, '/dashboard');
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', b.cookie)).text, /\/dashboard\/card/);

  // deleting the Site (here, its Login) deletes the row
  await saveCard(a, '[data-part=card] { color: red }');
  const count = (id) => db.prepare('SELECT COUNT(*) n FROM card_styles WHERE user_id = ?').get(id).n;
  assert.equal(count(a.id), 1);
  await req('post', '/dashboard/delete-account').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, password: 'longpassword1' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(a.id).n, 0);
  assert.equal(count(a.id), 0);
  db.prepare('DELETE FROM users WHERE id = ?').run(b.id);
  assert.equal(count(b.id), 0);
});

// card art goes straight onto disk, as any route that writes Site files would leave it
const { siteDir } = require('../src/sitefiles');
const PNG = (n = 100) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n - 8, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 2)]);
const artFile = (site, rel, data) => {
  const full = path.join(siteDir(site), rel);
  fs.rmSync(full, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (data === 'folder') fs.mkdirSync(full); else if (data) fs.writeFileSync(full, data);
  return full;
};
const vOf = (full) => { const s = fs.statSync(full); return `${Math.floor(s.mtimeMs)}-${s.size}`; };

test('card art: own-Site images on cards, and the stock card when any art file fails', async () => {
  const m = await listedMember('artpad');
  const res = await saveCard(m, '[data-part=card] { background: url("art/it\'s here.png") } [data-part=name]::after { content: ""; background: image-set("b.gif" 1x) }');
  // a style with missing art still saves; the page lists each failing file with its reason
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /^\/dashboard\/card\?ok=Saved your card style\./);
  const artList = async () => (await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.replace(/&#39;/g, "'");
  const ok = await artList();
  assert.match(ok, /art\/it's here\.png<\/code>: missing/);
  assert.match(ok, /b\.gif<\/code>: missing/);
  assert.equal(await memberCss('artpad'), null); // the stock card, with no CSS
  assert.equal((await req('get', '/card-art/artpad/b.gif')).status, 404);

  const png = artFile('artpad', "art/it's here.png", PNG());
  const gif = artFile('artpad', 'b.gif', GIF);
  // a path with a space and a quote comes out quoted and percent-encoded
  const url = `/card-art/artpad/art/it's%20here.png?v=${vOf(png)}`;
  assert.equal(await memberCss('artpad'), `.cs-${m.id} [data-part=card]{background:url("${url}")}.cs-${m.id} [data-part=name]::after{content:"";background:image-set("/card-art/artpad/b.gif?v=${vOf(gif)}"1x)}`);

  const bw = () => db.prepare('SELECT bw_bytes FROM users WHERE id = ?').get(m.id).bw_bytes;
  const before = bw();
  const art = await req('get', url).buffer(true);
  assert.equal(art.status, 200);
  assert.deepEqual(art.body, PNG());
  assert.equal(art.headers['content-type'], 'image/png');
  assert.equal(art.headers['content-security-policy'], 'sandbox');
  assert.equal(art.headers['x-content-type-options'], 'nosniff');
  assert.equal(art.headers['cache-control'], 'public, max-age=86400');
  assert.equal((await req('get', '/card-art/artpad/b.gif')).headers['content-type'], 'image/gif');
  assert.equal(bw(), before); // card art doesn't count toward bandwidth
  // hotlinked or not, the hotlink limiter doesn't apply
  for (let i = 0; i < 70; i++) assert.equal((await req('get', url).set('Referer', 'https://elsewhere.example/')).status, 200);

  // replacing a file changes its v; an old v still gets the current file
  artFile('artpad', "art/it's here.png", PNG(200));
  assert.match(await memberCss('artpad'), new RegExp(`v=${vOf(png)}"`));
  assert.equal((await req('get', url).buffer(true)).body.length, 200);

  // /browse and /card-art agree: 512 KB passes, one byte over doesn't; nor does a fake PNG, a folder or a deleted file
  artFile('artpad', "art/it's here.png", PNG(512 * 1024));
  assert.notEqual(await memberCss('artpad'), null);
  assert.equal((await req('get', url)).status, 200);
  for (const data of [PNG(512 * 1024 + 1), Buffer.from('not a png at all, really'), 'folder', null]) {
    artFile('artpad', "art/it's here.png", data);
    assert.equal(await memberCss('artpad'), null, String(data).slice(0, 20));
    const r = await req('get', url);
    assert.equal(r.status, 404);
    assert.equal(r.headers['content-security-policy'], 'sandbox');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  await saveCard(m, '[data-part=card] { background: url("art/it\'s here.png"), url(b.gif) }');
  const saved = await artList();
  assert.match(saved, /art\/it's here\.png<\/code>: missing/);
  assert.doesNotMatch(saved, /b\.gif<\/code>:/); // only failing files are listed
  artFile('artpad', "art/it's here.png", Buffer.from('not a png at all, really'));
  await saveCard(m, '[data-part=card] { background: url("art/it\'s here.png") }');
  assert.match(await artList(), /not a real PNG/);
  artFile('artpad', "art/it's here.png", PNG());

  // 404 for a file the style doesn't use, an svg, traversal, and Sites /browse leaves out
  artFile('artpad', 'other.png', PNG());
  artFile('artpad', 'x.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const p of ['other.png', 'x.svg', '%2e%2e/artpad/b.gif', 'art/%2e%2e/b.gif', 'art/..%2fb.gif']) assert.equal((await req('get', `/card-art/artpad/${p}`)).status, 404, p);
  assert.equal((await req('get', url)).status, 200);
  for (const [col, val] of [['hidden', 1], ['banned', 1], ['verified', 0], ['updates', 0]]) {
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, m.id);
    assert.equal((await req('get', url)).status, 404, col);
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val ? 0 : 1, m.id);
  }
  assert.equal((await req('get', url)).status, 200);
});

// one side of a page: the card with this scope class and the member <style> in the head, or null for each
const cardSide = (html, id) => ({ li: html.match(new RegExp(`<li class="card cs-${id}[ "][^]*?</li>`))?.[0] ?? null, css: html.match(/<head>[^]*<\/head>/)[0].match(/<style>([^]*?)<\/style>/)?.[1] ?? null });

test('/dashboard/card shows the saved card as /browse does, next to the stock card, and says why', async () => {
  const m = await listedMember('cardcheck');
  const page = async () => (await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.replace(/&#39;/g, "'");
  const browse = async () => cardSide((await req('get', '/browse?q=cardcheck')).text, m.id);
  let p = await page();
  assert.match(p, /Your card shows the stock card because: you haven't saved a card style\./);
  // the reference: all six parts and the rules
  for (const part of ['card', 'shot', 'name', 'tagline', 'tags', 'stats']) assert.ok(p.includes(`<code>[data-part="${part}"]</code>`), part);
  for (const rule of ['4 KB', 'at most 8 art files', 'PNG, JPEG, GIF, WebP or AVIF', '<code>position: fixed</code>', '<code>sticky</code>', '<code>@keyframes</code>']) assert.ok(p.includes(rule), rule);
  assert.doesNotMatch(p, /isn't in the dog park/);

  await saveCard(m, '[data-part=card] { transform: rotate(2deg) }');
  p = await page();
  assert.match(p, /Your card shows your style\./);
  assert.doesNotMatch(p, /because:/);
  assert.ok(cardSide(p, m.id).css);
  assert.deepEqual(cardSide(p, m.id), await browse());
  // beside it, the stock card: the same card without the scope class, so no member CSS reaches it
  const all = p.match(/<li class="card[ "][^]*?<\/li>/g);
  assert.equal(all.length, 2);
  assert.doesNotMatch(all[1], /cs-\d/);
  assert.equal(all[1].replace(/<li class="[^"]*">/, ''), all[0].replace(/<li class="[^"]*">/, ''));

  // failing art saves; the result and the page list only the failing files, with reasons
  artFile('cardcheck', 'ok.png', PNG());
  const res = await saveCard(m, '[data-part=card] { background: url(ok.png), url(gone.gif) }');
  assert.equal(decodeURIComponent(res.headers.location), '/dashboard/card?ok=Saved your card style.');
  p = await page();
  assert.match(p, /Your card shows the stock card because: some of its art files don't work\./);
  assert.match(p, /<li><code>gone\.gif<\/code>: missing<\/li>/);
  assert.doesNotMatch(p, /<code>ok\.png<\/code>:/);
  assert.equal(cardSide(p, m.id).css, null);
  assert.deepEqual(cardSide(p, m.id), await browse());

  // a style the sanitizer now rejects
  db.prepare("UPDATE card_styles SET css = NULL, error = 'Position fixed is not allowed.' WHERE user_id = ?").run(m.id);
  p = await page();
  assert.match(p, /Your card shows the stock card because: Position fixed is not allowed\./);
  assert.doesNotMatch(p, /gone\.gif<\/code>:/);
  assert.deepEqual(cardSide(p, m.id), await browse());

  // a hidden Site sees the note and can still save
  await req('post', '/dashboard/hidden').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, hidden: '1' });
  assert.match((await saveCard(m, '[data-part=name] { color: red }')).headers.location, /^\/dashboard\/card\?ok=/);
  p = await page();
  assert.match(p, /Your site isn't in the dog park right now, so nobody sees this card yet\./);
  assert.match(p, /Your card shows your style\./);
  assert.match(cardSide(p, m.id).css, /color:red/);
});

test('card art: a hidden or new Site sees its own art in the /dashboard/card preview; nobody else does', async () => {
  const m = await listedMember('arthide');
  const other = await member('artpeek');
  const png = artFile('arthide', 'pup.png', PNG());
  await saveCard(m, '[data-part=card] { background: url(pup.png) }');
  const url = `/card-art/arthide/pup.png?v=${vOf(png)}`;
  await req('post', '/dashboard/hidden').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, hidden: '1' });
  for (const setup of [() => {}, () => db.prepare('UPDATE users SET hidden = 0, created_at = ? WHERE id = ?').run(Date.now(), m.id)]) {
    setup();
    assert.ok((await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.includes(url.replace(/'/g, '&#39;')));
    assert.equal((await req('get', url)).status, 404);
    assert.equal((await req('get', url).set('Cookie', other.cookie)).status, 404);
    const own = await req('get', url).set('Cookie', m.cookie).buffer(true);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body, PNG());
    assert.equal(own.headers['cache-control'], 'private, no-store'); // never cached for others while the Site is unlisted
    assert.equal(own.headers['content-security-policy'], 'sandbox');
  }
  // every other check still applies
  artFile('arthide', 'pup.png', Buffer.from('not a png at all, really'));
  assert.equal((await req('get', url).set('Cookie', m.cookie)).status, 404);
  artFile('arthide', 'other.png', PNG());
  assert.equal((await req('get', '/card-art/arthide/other.png').set('Cookie', m.cookie)).status, 404);
  artFile('arthide', 'pup.png', PNG());
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(m.id);
  assert.equal((await req('get', url).set('Cookie', m.cookie)).status, 404);
});

test('card art: after a Site rename, art points at the new name with no re-save; the old name is a 404', async () => {
  const m = await listedMember('artold');
  artFile('artold', 'pup.png', PNG());
  await saveCard(m, '[data-part=card] { background: url(pup.png) }');
  assert.match(await memberCss('artold'), /url\("\/card-art\/artold\/pup\.png\?v=/);
  const r = await req('post', '/dashboard/rename').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, username: 'artnew', password: 'longpassword1' });
  assert.equal(r.status, 302);
  assert.match(await memberCss('artnew'), new RegExp(`^\\.cs-${m.id} \\[data-part=card\\]\\{background:url\\("/card-art/artnew/pup\\.png\\?v=`));
  assert.equal((await req('get', '/card-art/artnew/pup.png')).status, 200);
  assert.equal((await req('get', '/card-art/artold/pup.png')).status, 404);
});

test('feed updates name the files they changed, folded into one event per hour', async () => {
  const a = await member('filedog');
  const f = await member('filefan');
  await req('post', '/follow').set('Cookie', f.cookie).type('form').send({ _csrf: f.csrf, site: 'filedog' });
  await upload(a, 'kitty.png', 'png');
  await req('post', '/dashboard/save').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, path: 'about.html', content: 'hi' });
  for (const n of ['a', 'b', 'c', 'd']) await upload(a, `${n}.txt`, n);
  const events = db.prepare("SELECT files FROM events WHERE user_id = (SELECT id FROM users WHERE username = 'filedog') AND kind = 'update'").all();
  assert.equal(events.length, 1);
  assert.equal(events[0].files, 'd.txt\nc.txt\nb.txt\na.txt\nabout.html\nkitty.png');
  const feed = (await req('get', '/feed').set('Cookie', f.cookie)).text;
  assert.match(feed, /updated <a href="http:\/\/filedog\.pad\.test\/d\.txt">d\.txt<\/a>, .*about\.html<\/a> and 1 more/);
  assert.match((await req('get', '/site/filedog')).text, /href="http:\/\/filedog\.pad\.test\/about\.html"/);
});

test('Atom feeds: one per site, and recently updated without hidden or new sites', async () => {
  const a = await member('atomdog');
  await req('post', '/dashboard/save').set('Cookie', a.cookie).type('form').send({ _csrf: a.csrf, path: 'index.html', content: 'hi' });
  const site = await req('get', '/site/atomdog/feed.xml');
  assert.equal(site.status, 200);
  assert.match(site.headers['content-type'], /application\/atom\+xml/);
  assert.match(site.text, /<title>atomdog updated index\.html<\/title>/);
  assert.match(site.text, /<title>atomdog joined<\/title>/);
  assert.match(site.text, /&lt;a href=&quot;http:\/\/atomdog\.pad\.test\/index\.html&quot;&gt;/);
  assert.match((await req('get', '/site/atomdog')).text, /rel="alternate" type="application\/atom\+xml"[^>]*href="\/site\/atomdog\/feed\.xml"/);
  assert.equal((await req('get', '/site/nobody-here/feed.xml')).status, 404);
  // brand new: not in the global feed yet
  assert.doesNotMatch((await req('get', '/feed.xml')).text, /atomdog/);
  db.prepare('UPDATE users SET created_at = ? WHERE username = ?').run(Date.now() - 25 * 3600000, 'atomdog');
  const global = (await req('get', '/feed.xml')).text;
  assert.match(global, /<title>atomdog updated index\.html<\/title>/);
  assert.doesNotMatch(global, /atomdog joined/);
  db.prepare('UPDATE users SET hidden = 1 WHERE username = ?').run('atomdog');
  assert.doesNotMatch((await req('get', '/feed.xml')).text, /atomdog/);
  assert.equal((await req('get', '/site/atomdog/feed.xml')).headers['x-robots-tag'], 'noindex');
});

test('guestbook emails: instant, a daily digest, or off; held entries say so', async () => {
  const m = await member('mailpad');
  const sign = (message) => req('post', '/_hw/guestbook', 'mailpad.pad.test').type('form').send({ name: 'Vee', message });
  const notify = (v) => req('post', '/dashboard/guestbook/notify').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, notify: v });
  const mailsTo = () => mail.filter((s) => s.includes('to=mailpad@example.com') && s.includes('guestbook')).length;
  assert.equal(db.prepare('SELECT gb_notify FROM users WHERE username = ?').get('mailpad').gb_notify, 'daily');

  await notify('instant');
  await sign('lovely pad');
  await sign('see http://spam.example');
  assert.equal(mailsTo(), 2);
  assert.match(mail.at(-1), /spam\.example\n\(This entry has a link, so it waits for your approval\.\)/);

  await notify('off');
  await sign('quiet one');
  app.housekeeping();
  assert.equal(mailsTo(), 2);

  await notify('daily');
  await sign('digest one');
  app.housekeeping();
  assert.equal(mailsTo(), 2); // the digest waits a day after switching
  // a day passes
  db.prepare('UPDATE users SET gb_digest_at = gb_digest_at - 86401000 WHERE username = ?').run('mailpad');
  db.prepare("UPDATE guestbook SET created_at = created_at - 86401000 WHERE user_id = (SELECT id FROM users WHERE username = 'mailpad')").run();
  await notify('daily'); // saving the same setting keeps what waits for the digest
  app.housekeeping();
  await new Promise(setImmediate); // the cutoff moves once the mail is handed over
  assert.equal(mailsTo(), 3);
  assert.match(mail.at(-1), /1 new guestbook entry on mailpad\.pad\.test/);
  assert.match(mail.at(-1), /digest one/);
  assert.doesNotMatch(mail.at(-1), /lovely pad|quiet one/);
  app.housekeeping();
  assert.equal(mailsTo(), 3); // once a day at most
  await notify('bogus');
  assert.equal(db.prepare('SELECT gb_notify FROM users WHERE username = ?').get('mailpad').gb_notify, 'daily');
});

// the cases live in test/sitefiles.test.js; this shows the page lists them
test('the link checker lists links and images that point at missing files of the site', async () => {
  const m = await member('linkcheck');
  await upload(m, 'about.html', '<p>about</p>');
  await upload(m, 'index.html', '<a href="/about">clean</a> <img src=\'gone.png\'> <a href="/nope/">dir</a>');
  const res = await req('get', '/dashboard/links').set('Cookie', m.cookie);
  assert.equal(res.status, 200);
  const listed = [...res.text.matchAll(/<code>([^<]*)<\/code>/g)].map((x) => x[1]);
  assert.deepEqual(listed, ['gone.png', '/nope/']);
  await upload(m, 'index.html', '<a href="about.html">ok</a>');
  assert.match((await req('get', '/dashboard/links').set('Cookie', m.cookie)).text, /No broken links/);
});

test('the editor offers the site images to insert into a page, and the uploader offers to shrink photos', async () => {
  const m = await member('imgpick');
  await upload(m, 'cat.png', 'png');
  await upload(m, 'notes.txt', 'hi');
  const page = await req('get', '/dashboard/edit?path=index.html').set('Cookie', m.cookie);
  assert.match(page.text, /<select id="imgpick">.*<option>cat\.png<\/option>/);
  assert.doesNotMatch(page.text, /<option>notes\.txt/);
  assert.doesNotMatch((await req('get', '/dashboard/edit?path=notes.txt').set('Cookie', m.cookie)).text, /id="imgpick"/);
  const dash = (await req('get', '/dashboard').set('Cookie', m.cookie)).text;
  assert.match(dash, /id="shrink"/);
  // the page scripts at least parse
  for (const s of [...page.text.matchAll(/<script[^>]*>([^]*?)<\/script>/g), ...dash.matchAll(/<script[^>]*>([^]*?)<\/script>/g)]) new Function(s[1]); // eslint-disable-line no-new-func
});

test('visitor stats count page views and referring sites per day without cookies, for 30 days', async () => {
  const m = await member('stats-pad');
  await upload(m, 'about.html', '<p>about</p>');
  await upload(m, 'cat.png', 'png');
  const host = 'stats-pad.pad.test';
  await req('get', '/', host).set('Referer', 'https://friend.example/links');
  await req('get', '/about', host).set('Referer', 'http://stats-pad.pad.test/');
  await req('get', '/about', host);
  await req('get', '/cat.png', host).set('Referer', 'https://friend.example/');
  await req('get', '/missing.html', host);
  await req('get', '/', host).set('User-Agent', 'Googlebot/2.1');
  const res = await req('get', '/dashboard/stats').set('Cookie', m.cookie);
  assert.equal(res.status, 200);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get('stats-pad').id;
  assert.deepEqual(db.prepare('SELECT path, views FROM page_views WHERE user_id = ? ORDER BY path').all(id), [{ path: '/', views: 1 }, { path: '/about', views: 2 }]);
  assert.deepEqual(db.prepare('SELECT host, views FROM referrers WHERE user_id = ?').all(id), [{ host: 'friend.example', views: 1 }]);
  assert.match(res.text, /friend\.example/);
  db.prepare("UPDATE page_views SET day = '2000-01-01' WHERE user_id = ? AND path = '/'").run(id);
  app.housekeeping();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM page_views WHERE user_id = ?').get(id).n, 1);
});

test('a member renames their site: everything follows, the old name redirects and is held, and renames wait RENAME_DAYS', async () => {
  const m = await member('old-name');
  await upload(m, 'about.html', '<p>about</p>');
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get('old-name').id;
  const fan = await member('rename-fan');
  await req('post', '/follow').set('Cookie', fan.cookie).type('form').send({ _csrf: fan.csrf, site: 'old-name' });
  const rename = (username, password = 'longpassword1') => req('post', '/dashboard/rename').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, username, password });

  assert.match((await rename('new-name', 'wrongpassword')).text, /Wrong password/);
  assert.match((await rename('rename-fan')).text, /That site name is taken/);
  assert.match((await rename('admin')).text, /not available/);
  const ok = await rename('new-name');
  assert.equal(ok.status, 302);
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(id).username, 'new-name');
  assert.equal((await req('get', '/about', 'new-name.pad.test')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM follows WHERE followed_id = ?').get(id).n, 1);

  const old = await req('get', '/about?x=1', 'old-name.pad.test');
  assert.equal(old.status, 301);
  assert.equal(old.headers.location, 'http://new-name.pad.test/about?x=1');
  assert.equal((await req('get', '/site/old-name')).headers.location, '/site/new-name');
  assert.equal((await req('get', '/site/old-name/feed.xml')).headers.location, '/site/new-name/feed.xml');
  assert.match((await signup('old-name', 'squatter@example.com')).text, /That site name is taken/);

  // too soon for another rename, but once the wait is over the member may take their old name back
  assert.match((await rename('third-name')).text, /rename your site again in 30 days/);
  db.prepare('UPDATE users SET renamed_at = 0 WHERE id = ?').run(id);
  assert.equal((await rename('old-name')).status, 302);
  assert.equal((await req('get', '/about', 'old-name.pad.test')).status, 200);
  assert.equal((await req('get', '/', 'new-name.pad.test')).headers.location, 'http://old-name.pad.test/');

  // once the site is gone, its old names stop redirecting
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.equal((await req('get', '/', 'new-name.pad.test')).status, 404);
});

test('uploads can shrink big photos on the server, keeping name and type and dropping camera details', async () => {
  const sharp = require('sharp');
  const m = await member('shrinker');
  const photo = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#3a6' } }).jpeg({ quality: 100 }).withMetadata({ exif: { IFD0: { Make: 'PupCam' } } }).toBuffer();
  const send = (name, data, shrink) => {
    const r = req('post', '/dashboard/upload').set('Cookie', m.cookie).field('_csrf', m.csrf).field('dir', '');
    if (shrink) r.field('shrink', '1');
    return r.attach('files', data, name);
  };
  await send('big.jpg', photo, true);
  await send('kept.jpg', photo, false);
  await send('broken.jpg', Buffer.from('not really a jpeg'), true);
  const dir = path.join(process.env.DATA_DIR, 'sites', 'shrinker');
  const big = await sharp(path.join(dir, 'big.jpg')).metadata();
  assert.deepEqual([big.format, big.width, big.height, big.exif], ['jpeg', 1600, 800, undefined]);
  assert.ok(fs.statSync(path.join(dir, 'big.jpg')).size < photo.length);
  assert.equal((await sharp(path.join(dir, 'kept.jpg')).metadata()).width, 2400);
  assert.equal(fs.readFileSync(path.join(dir, 'broken.jpg'), 'utf8'), 'not really a jpeg');
  // the stored disk total matches what is really there
  const onDisk = U.dirSize(dir).total;
  assert.ok((await req('get', '/dashboard').set('Cookie', m.cookie)).text.includes(U.fmtBytes(onDisk)));
});

const bossLogin = async () => {
  const cookie = (await req('post', '/login').type('form').send({ username: 'boss@example.com', password: 'longpassword1' })).headers['set-cookie'][0].split(';')[0];
  return { cookie, csrf: (await req('get', '/admin').set('Cookie', cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1] };
};
const post = (m, url, body) => req('post', url).set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...body });
const eventOf = (name) => db.prepare('SELECT e.id FROM events e JOIN users u ON u.id = e.user_id WHERE u.username = ? ORDER BY e.id DESC').get(name).id;

test('"act" on /admin fills every site box with that name, escaped', async () => {
  const boss = await bossLogin();
  const page = (await req('get', '/admin?site=picked').set('Cookie', boss.cookie)).text;
  for (const id of ['bsite', 'ssite', 'fsite', 'csite']) assert.match(page, new RegExp(`id="${id}" name="site" value="picked"`), id);
  assert.match(page, /Acting on <b>picked<\/b>/);
  const evil = (await req('get', `/admin?site=${encodeURIComponent('"><script>x</script>')}`).set('Cookie', boss.cookie)).text;
  assert.ok(!evil.includes('<script>x'));
  assert.match(evil, /value="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
});

test('staff picks and the site of the week are set from /admin and shown on the home page while listed', async () => {
  const boss = await bossLogin();
  const m = await member('picked');
  await upload(m, 'index.html', '<h1>pick me</h1>');
  await member('weekly');
  db.prepare("UPDATE users SET created_at = ?, updates = 1 WHERE username IN ('picked', 'weekly')").run(Date.now() - 25 * 3600000);
  await post(boss, '/admin/feature', { site: 'picked', action: 'pick' });
  await post(boss, '/admin/feature', { site: 'weekly', action: 'sotw' });
  let home = (await req('get', '/')).text;
  assert.match(home, /Site of the week<\/h2><div class="sotw">[^]*?weekly/);
  assert.match(home, /Staff picks<\/h2><ul class="grid"><li class="card">[^]*?picked/);
  assert.match((await req('get', '/admin').set('Cookie', boss.cookie)).text, /Site of the week: <a href="\/site\/weekly">/);
  // one site of the week at a time
  await post(boss, '/admin/feature', { site: 'picked', action: 'sotw' });
  assert.deepEqual(db.prepare('SELECT username FROM users WHERE sotw_at > 0').all().map((r) => r.username), ['picked']);
  // hidden sites stay off the home page; unpicking and clearing take them off
  db.prepare("UPDATE users SET hidden = 1 WHERE username = 'picked'").run();
  assert.doesNotMatch((await req('get', '/')).text, /Site of the week|Staff picks/);
  db.prepare("UPDATE users SET hidden = 0 WHERE username = 'picked'").run();
  // a taken-down site can still lose its pick
  db.prepare("UPDATE users SET banned = 1 WHERE username = 'picked'").run();
  await post(boss, '/admin/feature', { site: 'picked', action: 'unpick' });
  db.prepare("UPDATE users SET banned = 0 WHERE username = 'picked'").run();
  assert.equal(db.prepare("SELECT staff_pick FROM users WHERE username = 'picked'").get().staff_pick, 0);
  await post(boss, '/admin/feature', { action: 'unsotw' });
  assert.ok(db.prepare("SELECT 1 FROM admin_log WHERE action = 'clear site of the week' AND site = 'picked'").get());
  home = (await req('get', '/')).text;
  assert.doesNotMatch(home, /Site of the week|Staff picks/);
  assert.deepEqual(db.prepare("SELECT action FROM admin_log WHERE action IN ('staff pick', 'site of the week', 'remove staff pick') AND site = 'picked' ORDER BY id").all().map((r) => r.action), ['staff pick', 'site of the week', 'remove staff pick']);
  // members can't do it
  assert.equal((await post(m, '/admin/feature', { site: 'picked', action: 'pick' })).status, 404);
});

// one admin login for the card clearing tests, so they don't use up the login rate limit later tests need
let cardBossLogin;
const cardBoss = () => (cardBossLogin ??= bossLogin());

test('an admin clears a card style from /admin: the stock card again, one log row with the reason', async () => {
  const boss = await cardBoss();
  const m = await listedMember('cardclear');
  await saveCard(m, '[data-part=card] { transform: rotate(9deg) }');
  assert.ok(await memberCss('cardclear'));
  assert.match((await req('get', '/admin?site=cardclear').set('Cookie', boss.cookie)).text, /<summary>Card style<\/summary>[^]*action="\/admin\/card-clear"[^]*id="csite" name="site" value="cardclear"[^]*<button>Clear card style<\/button>/);

  const res = await post(boss, '/admin/card-clear', { site: 'cardclear', reason: `  ${'r'.repeat(250)}` });
  assert.match(res.text, /<p class="ok" role="status">Cleared the card style of cardclear\.<\/p>/);
  assert.equal(await memberCss('cardclear'), null);
  assert.equal((await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.match(/<textarea[^>]*>([^<]*)</)[1], '');
  const rows = db.prepare("SELECT admin, action, detail FROM admin_log WHERE site = 'cardclear'").all();
  assert.deepEqual(rows, [{ admin: 'boss', action: 'clear card style', detail: 'r'.repeat(200) }]);
});

test('the member sees why their card style was cleared until their next passing save', async () => {
  const boss = await cardBoss();
  const m = await listedMember('cardnoted');
  await saveCard(m, '[data-part=card] { color: red }');
  await post(boss, '/admin/card-clear', { site: 'cardnoted', reason: 'rude <words>' });
  const notice = 'An admin removed your card style: rude &lt;words&gt;';
  assert.ok((await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.includes(notice));
  const errLines = (await req('get', '/dashboard').set('Cookie', m.cookie)).text.match(/<p class="err"[^]*?<\/p>/g) || [];
  assert.equal(errLines.filter((l) => l.includes('href="/dashboard/card"')).length, 1);
  // a rejected save keeps the note; a passing one, even empty, removes it
  await saveCard(m, '.foo { color: <b>blue</b> }');
  assert.ok((await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.includes(notice));
  await saveCard(m, '');
  assert.ok(!(await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.includes('An admin removed'));
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /<p class="err"[^<]*<a href="\/dashboard\/card"/);
  // the member may save again at once
  await saveCard(m, '[data-part=card] { color: blue }');
  assert.ok(await memberCss('cardnoted'));
});

test('clearing a card style: nothing to clear writes nothing, takedown leaves it alone, members are refused', async () => {
  const boss = await cardBoss();
  const m = await listedMember('cardkept');
  const logRows = () => db.prepare("SELECT COUNT(*) n FROM admin_log WHERE action = 'clear card style'").get().n;
  const before = logRows();
  assert.match((await post(boss, '/admin/card-clear', { site: 'nosuchcardsite', reason: 'x' })).text, /No site with that name\./);
  assert.match((await post(boss, '/admin/card-clear', { site: 'cardkept', reason: 'x' })).text, /No card style on that site\./);
  assert.equal(logRows(), before);
  assert.ok(!(await req('get', '/dashboard/card').set('Cookie', m.cookie)).text.includes('An admin removed'));

  await saveCard(m, '[data-part=card] { color: red }');
  // a member can't clear one
  assert.equal((await post(m, '/admin/card-clear', { site: 'cardkept', reason: 'x' })).status, 404);
  assert.ok(await memberCss('cardkept'));

  const live = db.prepare('SELECT source, css FROM card_styles WHERE user_id = ?').get(m.id);
  await post(boss, '/admin/ban', { site: 'cardkept', action: 'ban', reason: 'spam' });
  assert.deepEqual(db.prepare('SELECT source, css FROM card_styles WHERE user_id = ?').get(m.id), live);
  await post(boss, '/admin/ban', { site: 'cardkept', action: 'unban' });
  assert.deepEqual(db.prepare('SELECT source, css FROM card_styles WHERE user_id = ?').get(m.id), live);

  // a taken-down Site can still be cleared
  await post(boss, '/admin/ban', { site: 'cardkept', action: 'ban', reason: 'spam' });
  assert.match((await post(boss, '/admin/card-clear', { site: 'cardkept', reason: 'x' })).text, /Cleared the card style of cardkept\./);
  assert.equal(logRows(), before + 1);
});

test('profile comments: members comment, bots and floods are stopped, and only the owner deletes', async () => {
  const owner = await member('commented');
  const fan = await member('chatty');
  assert.match((await req('get', '/site/commented')).text, /Log in<\/a> to leave a comment/);
  await post(fan, '/comment', { site: 'commented', body: 'nice <b>pad</b>', back: '/site/commented' });
  await post(fan, '/comment', { site: 'commented', body: 'buy pills', website: 'http://spam', back: '/site/commented' }); // honeypot
  let page = (await req('get', '/site/commented')).text;
  assert.match(page, /nice &lt;b&gt;pad&lt;\/b&gt;/);
  assert.doesNotMatch(page, /buy pills/);
  const id = db.prepare("SELECT id FROM comments WHERE body LIKE 'nice%'").get().id;
  await post(fan, '/comment/delete', { id }); // not the owner: nothing happens
  assert.ok(db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id));
  await post(owner, '/comment/delete', { id });
  assert.equal(db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id), undefined);
  // the guestbook's limit: three in ten minutes from one connection
  const from = (body) => req('post', '/comment').set('Cookie', fan.cookie).set('X-Forwarded-For', '10.9.9.9').type('form').send({ _csrf: fan.csrf, site: 'commented', body });
  for (const n of [1, 2, 3]) assert.equal((await from(`hi ${n}`)).status, 302);
  assert.equal((await from('hi 4')).status, 429);
});

test('feed updates take likes and comments', async () => {
  const site = await member('liked');
  await upload(site, 'index.html', '<h1>new</h1>');
  const fan = await member('liker');
  await post(fan, '/follow', { site: 'liked' });
  const ev = eventOf('liked');
  await post(fan, '/like', { event: ev, back: '/feed' });
  await post(fan, '/like', { event: ev, back: '/feed' }); // twice is still one
  await post(fan, '/comment', { event: ev, body: 'love the update', back: '/feed' });
  const feed = (await req('get', '/feed').set('Cookie', fan.cookie)).text;
  assert.match(feed, /1 like <form[^]*?value="unlike"/);
  assert.match(feed, /love the update/);
  // the owner sees both under the update on their profile, and can delete the comment
  const prof = (await req('get', '/site/liked').set('Cookie', site.cookie)).text;
  assert.match(prof, /Recent activity[^]*1 like[^]*action="\/comment\/delete"[^]*love the update/);
  assert.equal((await post(fan, '/like', { event: ev, action: 'unlike', back: '/feed' })).headers.location, '/feed');
  assert.match((await req('get', '/feed').set('Cookie', fan.cookie)).text, /0 likes/);
});

test('blocking a member hides their comments and likes, ends follows, and stops new ones', async () => {
  const me = await member('blocker');
  await upload(me, 'index.html', '<h1>mine</h1>');
  const pest = await member('pest');
  await post(pest, '/follow', { site: 'blocker' });
  await post(me, '/follow', { site: 'pest' });
  await post(pest, '/comment', { site: 'blocker', body: 'old comment' });
  await post(pest, '/like', { event: eventOf('blocker') });
  await post(me, '/block', { site: 'pest' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM follows f JOIN users a ON a.id = f.follower_id JOIN users b ON b.id = f.followed_id WHERE a.username IN (\'pest\', \'blocker\') AND b.username IN (\'pest\', \'blocker\')').get().n, 0);
  // hidden on my profile for every visitor
  const page = (await req('get', '/site/blocker')).text;
  assert.doesNotMatch(page, /old comment/);
  assert.match(page, /0 likes/);
  // new comments, likes and follows go nowhere
  await post(pest, '/comment', { site: 'blocker', body: 'new comment' });
  await post(pest, '/follow', { site: 'blocker' });
  await post(pest, '/like', { event: eventOf('blocker'), action: 'like' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comments WHERE body = 'new comment'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM follows WHERE follower_id = (SELECT id FROM users WHERE username = 'pest')").get().n, 0);
  assert.match((await req('get', '/site/pest').set('Cookie', me.cookie)).text, /value="unblock">Unblock/);
  // unblocking brings the old comment back
  await post(me, '/block', { site: 'pest', action: 'unblock' });
  assert.match((await req('get', '/site/blocker')).text, /old comment/);
});

test('notifications list new followers, comments and likes, email the kinds asked for, and respect blocks', async () => {
  const me = await member('noticed');
  await upload(me, 'index.html', '<h1>hi</h1>');
  const a = await member('fan-a');
  const b = await member('fan-b');
  await post(me, '/notifications/settings', { comment: '1' });
  const mailed = mail.length;
  await post(a, '/follow', { site: 'noticed' });
  await post(a, '/like', { event: eventOf('noticed') });
  await post(b, '/comment', { site: 'noticed', body: 'hello there' });
  const sent = mail.slice(mailed).join('\n');
  assert.match(sent, /to=noticed@example.com subject="fan-b commented on your site/);
  assert.doesNotMatch(sent, /started following|liked your update/); // not asked for
  assert.match((await req('get', '/dashboard').set('Cookie', me.cookie)).text, /Notifications \(3\)/);
  const list = (await req('get', '/notifications').set('Cookie', me.cookie)).text;
  assert.match(list, /fan-b<\/a> commented on your site: "hello there"[^]*fan-a<\/a> liked your update[^]*fan-a<\/a> started following you/);
  assert.equal((list.match(/class="new"/g) || []).length, 3);
  assert.doesNotMatch((await req('get', '/dashboard').set('Cookie', me.cookie)).text, /Notifications \(/);
  // the owner can delete a comment from here, even on an update too old to show on the profile
  const cid = db.prepare("SELECT id FROM comments WHERE body = 'hello there'").get().id;
  assert.match(list, new RegExp(`name="id" value="${cid}"><input type="hidden" name="back" value="\/notifications">`));
  await post(me, '/block', { site: 'fan-b' });
  assert.doesNotMatch((await req('get', '/notifications').set('Cookie', me.cookie)).text, /fan-b/);
  assert.equal((await post(me, '/comment/delete', { id: cid, back: '/notifications' })).headers.location, '/notifications');
  assert.equal(db.prepare('SELECT 1 FROM comments WHERE id = ?').get(cid), undefined);
});

test('the weekly digest emails updates from followed sites to members who opted in, once a week', async () => {
  const reader = await member('reader');
  const writer = await member('writer');
  await post(reader, '/follow', { site: 'writer' });
  await post(reader, '/notifications/settings', { digest: '1' });
  await upload(writer, 'poem.html', '<p>roses</p>');
  const before = mail.length;
  app.housekeeping();
  assert.equal(mail.slice(before).some((m) => m.includes('to=reader@')), false); // a week hasn't passed
  db.prepare("UPDATE users SET digest_at = digest_at - ? WHERE username = 'reader'").run(8 * 86400000);
  db.prepare("UPDATE events SET created_at = created_at - ? WHERE user_id = (SELECT id FROM users WHERE username = 'writer')").run(86400000);
  app.housekeeping();
  const digest = mail.slice(before).find((m) => m.includes('to=reader@'));
  assert.match(digest, /This week on PuppyPad: 1 update from sites you follow[^]*writer updated poem\.html\nhttp:\/\/writer\.pad\.test\//);
  await new Promise((r) => setImmediate(r)); // the sent digest moves the cutoff
  const again = mail.length;
  db.prepare("UPDATE users SET digest_at = digest_at - ? WHERE username = 'reader'").run(60000);
  app.housekeeping();
  assert.equal(mail.slice(again).some((m) => m.includes('to=reader@')), false);
});

test('long lists page: notifications, profile comments, and every comment on an update', async () => {
  const me = await member('popular');
  await upload(me, 'index.html', '<h1>hi</h1>');
  const fan = await member('talker');
  const ev = eventOf('popular');
  const ids = db.prepare("SELECT id FROM users WHERE username IN ('popular', 'talker') ORDER BY username").all().map((r) => r.id); // [popular, talker]
  const add = db.prepare('INSERT INTO comments (user_id, author_id, event_id, body, created_at) VALUES (?,?,?,?,?)');
  const t = Date.now() - 60000;
  for (let i = 1; i <= 60; i++) add.run(ids[0], ids[1], null, `profile note ${i}`, t + i);
  for (let i = 1; i <= 55; i++) add.run(ids[0], ids[1], ev, `update note ${i}`, t + 100 + i);
  // profile: newest 50, then the rest on page 2
  let prof = (await req('get', '/site/popular')).text;
  assert.match(prof, /profile note 60</);
  assert.doesNotMatch(prof, /profile note 10</);
  assert.match(prof, /page 1 of 2 <a href="\/site\/popular\?cpage=2#comments">Older/);
  prof = (await req('get', '/site/popular?cpage=2')).text;
  assert.match(prof, /profile note 10</);
  assert.doesNotMatch(prof, /profile note 60</);
  // feed and profile preview the newest five under the update, with a link to the rest
  await post(fan, '/follow', { site: 'popular' });
  const feed = (await req('get', '/feed').set('Cookie', fan.cookie)).text;
  assert.match(feed, new RegExp(`<a href="/site/popular/update/${ev}">See all 55 comments</a>`));
  assert.match(feed, /update note 55</);
  assert.doesNotMatch(feed, /update note 50</);
  let page = (await req('get', `/site/popular/update/${ev}`)).text;
  assert.match(page, /update note 55</);
  assert.doesNotMatch(page, /update note 5</);
  page = (await req('get', `/site/popular/update/${ev}?page=2`)).text;
  assert.match(page, /update note 5</);
  assert.equal((await req('get', `/site/talker/update/${ev}`)).status, 404); // not talker's update
  // notifications: 50 a page, and page 2 still marks what was new on arrival
  const first = (await req('get', '/notifications').set('Cookie', me.cookie)).text;
  assert.equal((first.match(/<li class="new">/g) || []).length, 50);
  const since = first.match(/\/notifications\?page=2&amp;since=(\d+)/)[1];
  const second = (await req('get', `/notifications?page=2&since=${since}`).set('Cookie', me.cookie)).text;
  assert.match(second, /<li class="new">/);
  assert.doesNotMatch((await req('get', '/notifications').set('Cookie', me.cookie)).text, /<li class="new">/);
  // followers and following: everyone reachable, 50 a page
  const fanIns = db.prepare("INSERT INTO users (username, email, pw_hash, verified, created_at, updated_at) VALUES (?, ?, 'x', 1, ?, ?)");
  const follow = db.prepare('INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?,?,?)');
  for (let i = 1; i <= 55; i++) {
    const id = fanIns.run(`fan${i}`, `fan${i}@example.com`, t, t).lastInsertRowid;
    follow.run(id, ids[0], t + i);
    follow.run(ids[0], id, t + i);
  }
  prof = (await req('get', '/site/popular')).text;
  assert.match(prof, />fan55</);
  assert.doesNotMatch(prof, />fan2</);
  assert.match(prof, /page 1 of 2 <a href="\/site\/popular\?fpage=2#followers">Older/);
  assert.match(prof, /page 1 of 2 <a href="\/site\/popular\?gpage=2#following">Older/);
  prof = (await req('get', '/site/popular?fpage=2&gpage=2')).text;
  assert.match(prof, />fan2</);
  assert.doesNotMatch(prof, />fan55</);
  // a form's way back never leads off the site
  assert.equal((await post(fan, '/comment', { site: 'popular', body: 'x', back: '//evil.example' })).headers.location, '/site/popular');
});

test('the widgets page hands out snippets, keeps a status line, and the new /_hw/ badges draw from the site', async () => {
  const m = await member('widgety');
  const page = (await req('get', '/dashboard/widgets').set('Cookie', m.cookie)).text;
  for (const s of ['/_hw/counter.svg', '/_hw/guestbook?theme=night', '/_hw/updated.svg', '/_hw/status.svg', '/webring/next?from=widgety', '/assets/buttons/made-with.svg', '/snow.js']) assert.ok(page.includes(U.esc(s)), s);
  assert.match(page, /<option value="index.html">/); // "Add to a page" suggests the member's pages

  const save = await req('post', '/dashboard/widgets/status').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, status: ' eating <b>snacks</b>\u0007 ' + 'x'.repeat(80) });
  assert.match(decodeURIComponent(save.headers.location), /Status saved/);
  const svg = async (url) => { const r = await req('get', url, 'widgety.pad.test').buffer(true); return { type: r.headers['content-type'], text: String(r.body) }; };
  const status = await svg('/_hw/status.svg');
  assert.equal(status.type, 'image/svg+xml; charset=utf-8');
  assert.match(status.text, />eating &lt;b&gt;snacks&lt;\/b&gt; x+</); // escaped, one line, cut to 60 characters
  assert.equal(db.prepare('SELECT status FROM users WHERE username = ?').get('widgety').status.length, 60);

  db.prepare('UPDATE users SET updated_at = ? WHERE username = ?').run(Date.parse('2026-03-04T10:00:00Z'), 'widgety');
  assert.match((await svg('/_hw/updated.svg')).text, /updated 2026-03-04/);
});

test('guestbook themes come from a fixed list and stay on after signing', async () => {
  await member('gbthemes');
  const night = await req('get', '/_hw/guestbook?theme=night', 'gbthemes.pad.test');
  assert.match(night.text, /background:#14141f/);
  assert.match(night.text, /action="\/_hw\/guestbook\?theme=night"/);
  const odd = await req('get', '/_hw/guestbook?theme=%3C/style%3E', 'gbthemes.pad.test');
  assert.match(odd.text, /action="\/_hw\/guestbook"/); // unknown: the classic look
  assert.doesNotMatch(odd.text, /<\/style><\/style>/);
  const sign = await req('post', '/_hw/guestbook?theme=night', 'gbthemes.pad.test').type('form').send({ name: 'V', message: 'hi' });
  assert.equal(sign.headers.location, '/_hw/guestbook?theme=night');
});

test('"Add to a page" offers the snippet in the editor without touching the page', async () => {
  const m = await member('addwidget');
  const before = fs.readFileSync(path.join(process.env.DATA_DIR, 'sites', 'addwidget', 'index.html'), 'utf8');
  const ed = await req('get', '/dashboard/edit?path=index.html&widget=stamp-tea').set('Cookie', m.cookie);
  assert.match(ed.text, /Insert the Fuelled by tea at the cursor/);
  assert.match(ed.text, /snip="\\u003ca href=\\"http:\/\/pad.test\\">\\u003cimg src=\\"http:\/\/pad.test\/assets\/buttons\/stamp-tea.svg\\"/);
  assert.doesNotMatch((await req('get', '/dashboard/edit?path=index.html&widget=nope').set('Cookie', m.cookie)).text, /id="insert"/);
  assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR, 'sites', 'addwidget', 'index.html'), 'utf8'), before);
});

test('effects are copied into the site once, through the save checks', async () => {
  const m = await member('sparkly');
  const copy = (fx) => req('post', '/dashboard/widgets/copy').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, fx });
  assert.match(decodeURIComponent((await copy('sparkle')).headers.location), /ok=Copied sparkle.js/);
  const file = path.join(process.env.DATA_DIR, 'sites', 'sparkly', 'sparkle.js');
  assert.match(fs.readFileSync(file, 'utf8'), /prefers-reduced-motion/);
  fs.writeFileSync(file, '// mine');
  assert.match(decodeURIComponent((await copy('sparkle')).headers.location), /err=You already have sparkle.js/);
  assert.equal(fs.readFileSync(file, 'utf8'), '// mine');
  assert.match(decodeURIComponent((await copy('../x')).headers.location), /err=Pick one of the effects/);
});

test('gallery files are served with long cache headers, and nothing else under /assets', async () => {
  const bg = await req('get', '/assets/bg/stars.svg');
  assert.equal(bg.status, 200);
  assert.match(bg.headers['cache-control'], /max-age=2592000/);
  assert.equal((await req('get', '/assets/fx/snow.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  for (const bad of ['/assets/bg/CREDITS.md', '/assets/bg/..%2F..%2Fserver.js', '/assets/og.png/x']) assert.equal((await req('get', bad)).status, 404, bad);
});

test('the style editor sets a gallery or own background picture', async () => {
  const m = await member('bgpicker');
  const style = require('../src/style');
  const css = path.join(process.env.DATA_DIR, 'sites', 'bgpicker', 'puppypad.css');
  const night = { ...style.PRESETS.night };
  delete night.name;
  const save = (s) => req('post', '/dashboard/style').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...night, ...s });
  await upload(m, 'sky.png', 'png');
  assert.match((await req('get', '/dashboard/style').set('Cookie', m.cookie)).text, /<option value="\/sky.png">sky.png<\/option>/);

  await save({ bg: 'stars', bgmode: 'fixed' });
  assert.match(fs.readFileSync(css, 'utf8'), /body \{ background-image: url\("http:\/\/pad.test\/assets\/bg\/stars.svg"\); background-repeat: repeat; background-attachment: fixed; \}/);
  assert.deepEqual(style.parse(fs.readFileSync(css, 'utf8')), { ...night, bg: 'stars', bgmode: 'fixed' });
  assert.match((await req('get', '/dashboard/style').set('Cookie', m.cookie)).text, /value="stars" checked/);

  await save({ bg: 'own', ownbg: '/sky.png', bgmode: 'cover' });
  assert.match(fs.readFileSync(css, 'utf8'), /url\("\/sky.png"\); background-size: cover/);
  assert.match((await req('get', '/dashboard/style').set('Cookie', m.cookie)).text, /value="own" checked/);

  await save({ bg: '' });
  assert.doesNotMatch(fs.readFileSync(css, 'utf8'), /background-image/);
  for (const bad of [{ bg: 'own', ownbg: '/x.html' }, { bg: 'own', ownbg: '/a"); } body { x: url("b.png' }, { bg: 'nope' }, { bg: 'stars', bgmode: 'wobble' }]) {
    assert.match(decodeURIComponent((await save(bad)).headers.location), /err=Pick each setting/);
  }
});

test('the HTTP API: a per-member key uploads, lists, deletes and reads site info through the dashboard checks', async () => {
  const m = await member('apidog');
  const call = (method, url, key) => req(method, url).set('Authorization', `Bearer ${key}`);
  assert.equal((await req('get', '/api/site')).status, 401);
  assert.equal((await req('get', '/api/site').set('Cookie', m.cookie)).status, 401); // the login cookie is not a key

  const make = (password) => req('post', '/dashboard/api').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, action: 'new', password });
  assert.match((await make('wrongpassword')).text, /Wrong password/);
  const page = (await make('longpassword1')).text;
  const key = page.match(/<pre>(pp_[\w-]+)<\/pre>/)[1];
  assert.match(page, /npx @puppypad\/cli login --url http:\/\/pad\.test/);
  assert.match(page, /api_key: \$\{\{ secrets\.PUPPYPAD_API_KEY \}\}/); // GitHub's syntax, not a template slot
  assert.equal(db.prepare('SELECT api_key FROM users WHERE username = ?').get('apidog').api_key, U.sha(key)); // only its hash is kept

  const site = await call('get', '/api/site', key);
  assert.equal(site.body.name, 'apidog');
  assert.equal(site.body.url, 'http://apidog.pad.test/');
  assert.equal(site.body.quota_bytes, 1048576);

  const up = await call('post', '/api/upload', key).field('dir', 'pics')
    .attach('files', Buffer.from('<p>hi</p>'), 'about.html').attach('files', Buffer.from('gif'), { filepath: 'old/cat.gif' })
    .attach('files', Buffer.from('x'), 'evil.php').attach('files', Buffer.from('x'), { filepath: '../../escape.html' });
  assert.equal(up.status, 200);
  assert.deepEqual(up.body.saved, ['pics/about.html', 'pics/old/cat.gif']);
  assert.equal(up.body.skipped.length, 2);
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'escape.html')));

  const phish = await call('post', '/api/upload', key).attach('files', Buffer.from('<title>PayPal login</title>'), 'login.html');
  assert.deepEqual(phish.body.saved, ['login.html']);
  assert.ok(db.prepare("SELECT 1 FROM reports WHERE site = 'apidog' AND reason = 'Auto-flag'").get()); // the same phishing check

  const big = await call('post', '/api/upload', key).attach('files', Buffer.alloc(1048576 + 1), 'big.png');
  assert.equal(big.status, 400);

  const listing = (await call('get', '/api/files', key)).body.files;
  assert.deepEqual(listing.map((f) => f.path), ['index.html', 'login.html', 'pics/about.html', 'pics/old/cat.gif']);
  assert.equal(listing[2].sha256, U.sha('<p>hi</p>')); // the CLI skips files whose hash matches

  // a file's bytes come back as a download, never as a page on this origin
  const got = await call('get', '/api/file?path=pics/about.html', key).buffer(true);
  assert.equal(got.body.toString(), '<p>hi</p>');
  assert.equal(got.headers['content-type'], 'application/octet-stream');
  assert.equal(got.headers['content-disposition'], 'attachment');
  for (const bad of ['nope.html', '../apidog/index.html', '']) assert.equal((await call('get', `/api/file?path=${bad}`, key)).status, 404, bad);

  // many paths at once, as JSON or as a repeated form field
  await call('post', '/api/upload', key).attach('files', Buffer.from('a'), 'a.txt').attach('files', Buffer.from('b'), 'b.txt');
  assert.deepEqual((await call('post', '/api/delete', key).send({ paths: ['a.txt', 'gone.txt'] })).body, { deleted: ['a.txt'], missing: ['gone.txt'] });
  assert.deepEqual((await call('post', '/api/delete', key).type('form').send('paths=b.txt')).body, { deleted: ['b.txt'], missing: [] });
  assert.equal((await call('post', '/api/delete', key).send({ paths: ['../x.html'] })).status, 400);
  assert.equal((await call('post', '/api/delete', key).send({ paths: Array(101).fill('x.txt') })).status, 400);

  assert.deepEqual((await call('post', '/api/delete', key).send({ path: 'pics/old/cat.gif' })).body, { deleted: 'pics/old/cat.gif' });
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'apidog', 'pics', 'old'))); // the empty folder goes too
  assert.equal((await call('post', '/api/delete', key).type('form').send({ path: 'nope.html' })).status, 404);
  assert.equal((await call('get', '/api/nothing', key)).status, 404);
  const junk = await call('post', '/api/delete', key).set('Content-Type', 'application/json').send('{oops');
  assert.equal(junk.status, 400);
  assert.match(junk.body.error, /could not be read/);

  // a moderator take-down stops it; a restore brings it back
  db.prepare('UPDATE users SET banned = 1 WHERE username = ?').run('apidog');
  assert.equal((await call('get', '/api/site', key)).status, 403);
  db.prepare('UPDATE users SET banned = 0 WHERE username = ?').run('apidog');

  // switching it off, or changing the password, ends the key
  await req('post', '/dashboard/api').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, action: 'revoke' });
  assert.equal((await call('get', '/api/site', key)).status, 401);
  const key2 = (await make('longpassword1')).text.match(/<pre>(pp_[\w-]+)<\/pre>/)[1];
  assert.equal((await call('get', '/api/site', key2)).status, 200);
  await req('post', '/account/password').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, password: 'longpassword1', new_password: 'longpassword2', confirm_password: 'longpassword2' });
  assert.equal((await call('get', '/api/site', key2)).status, 401);
});

test('the CLI pushes only changed files, deletes only with --delete, and pulls the site back', async () => {
  const m = await member('clidog');
  const key = (await req('post', '/dashboard/api').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, action: 'new', password: 'longpassword1' }))
    .text.match(/<pre>(pp_[\w-]+)<\/pre>/)[1];
  // the app picks the site by Host, and fetch can't set that header, so a tiny front door sets it
  const server = require('http').createServer((rq, rs) => { rq.headers.host = 'pad.test'; app(rq, rs); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-cli-'));
  Object.assign(process.env, { PUPPYPAD_API_KEY: key, PUPPYPAD_URL: `http://127.0.0.1:${server.address().port}`, XDG_CONFIG_HOME: tmp });
  const out = [];
  const write = process.stdout.write;
  const cli = async (...args) => {
    out.length = 0;
    process.stdout.write = (s) => out.push(s);
    try { await require('../cli/puppypad').main(args); } finally { process.stdout.write = write; }
    return out.join('');
  };
  const live = path.join(process.env.DATA_DIR, 'sites', 'clidog');
  const src = path.join(tmp, 'site');
  try {
    fs.mkdirSync(path.join(src, 'pics'), { recursive: true });
    fs.mkdirSync(path.join(src, '.git'));
    fs.writeFileSync(path.join(src, 'index.html'), '<h1>mine</h1>');
    fs.writeFileSync(path.join(src, 'pics', 'cat.gif'), 'gif');
    fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(src, 'run.php'), 'x');

    assert.match(await cli('push', src, '--dry-run'), /would upload {2}index\.html/);
    assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8') === '<h1>mine</h1>', false);
    const first = await cli('push', src);
    assert.match(first, /Not uploading 1 file .*run\.php/);
    assert.match(first, /Uploaded 2\./);
    assert.equal(fs.readFileSync(path.join(live, 'pics', 'cat.gif'), 'utf8'), 'gif');
    assert.ok(!fs.existsSync(path.join(live, '.git')));
    assert.match(await cli('push', src), /is up to date/);

    fs.writeFileSync(path.join(live, 'extra.html'), 'made on the dashboard');
    fs.writeFileSync(path.join(src, 'index.html'), '<h1>changed</h1>');
    assert.match(await cli('push', src), /^upload {2}index\.html\nUploaded 1\./m); // extra.html stays without --delete
    assert.ok(fs.existsSync(path.join(live, 'extra.html')));
    // a failed upload stops --delete, since what it would remove may be what the failed file replaces
    fs.writeFileSync(path.join(src, 'huge.png'), Buffer.alloc(1048576 + 1));
    await assert.rejects(cli('push', src, '--delete'), /huge\.png \(too big\).*Nothing was deleted/);
    assert.ok(fs.existsSync(path.join(live, 'extra.html')));
    fs.rmSync(path.join(src, 'huge.png'));
    assert.match(await cli('push', src, '--delete'), /delete {2}extra\.html/);
    assert.ok(!fs.existsSync(path.join(live, 'extra.html')));

    // the server turns spaces into underscores; the CLI compares by that name so nothing is re-sent or deleted
    fs.writeFileSync(path.join(src, 'my page.html'), 'spaced');
    assert.match(await cli('push', src, '--delete'), /upload {2}my_page\.html\nUploaded 1, deleted 0\./);
    assert.match(await cli('push', src, '--delete'), /is up to date/);
    fs.writeFileSync(path.join(src, 'my  page.html'), 'clash');
    await assert.rejects(cli('push', src), /would both be stored as my_page\.html/);
    fs.rmSync(path.join(src, 'my  page.html'));
    await cli('delete', 'my_page.html');
    fs.rmSync(path.join(src, 'my page.html'));

    const back = path.join(tmp, 'back');
    assert.match(await cli('pull', back), /Downloaded 2 of 2/);
    assert.equal(fs.readFileSync(path.join(back, 'index.html'), 'utf8'), '<h1>changed</h1>');
    assert.match(await cli('pull', back), /already here/);
    const trap = path.join(tmp, 'trap');
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.mkdirSync(trap);
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(trap, 'pics'));
    await assert.rejects(cli('pull', trap), /symlink/);
    assert.ok(!fs.existsSync(path.join(tmp, 'elsewhere', 'cat.gif')));
    assert.match(await cli('delete', 'pics/cat.gif', 'nope.gif'), /deleted {2}pics\/cat\.gif\nnot found {2}nope\.gif/);
    assert.match(await cli('info'), /clidog {2}http:\/\/clidog\.pad\.test\//);
    assert.match(await cli('list'), /index\.html/);

    await cli('login'); // takes the key from PUPPYPAD_API_KEY and saves it privately
    const saved = path.join(tmp, 'puppypad', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).key, key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    await cli('logout');
    assert.ok(!fs.existsSync(saved));

    process.env.PUPPYPAD_API_KEY = 'pp_wrong';
    await assert.rejects(cli('info'), /unknown API key/);
  } finally {
    for (const k of ['PUPPYPAD_API_KEY', 'PUPPYPAD_URL', 'XDG_CONFIG_HOME']) delete process.env[k];
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOTP codes match RFC 6238', () => {
  const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(U.totp(s, 1), '287082');
  assert.equal(U.totp(s, Math.floor(1111111109 / 30)), '081804');
  assert.equal(U.totpStep(s, '287082', 59000), 1);
  assert.equal(U.totpStep(s, '287082', 200000), 0);
  assert.match(U.newTotpSecret(), /^[A-Z2-7]{32}$/);
});

test('two-factor login: turning it on, logging in with a code or a recovery code, resets, turning it off, and logging out everywhere', async () => {
  const m = await member('twofa');
  const step = () => Math.floor(Date.now() / 30000);
  const setup = await req('get', '/account/2fa').set('Cookie', m.cookie);
  assert.equal(setup.headers['cache-control'], 'no-store');
  assert.match(setup.text, /aria-label="QR code for your two-factor key"[^>]*><svg [^]*<\/svg>/);
  const secret = setup.text.match(/name="secret" value="([A-Z2-7]{32})"/)[1];
  const on = (code, password = 'longpassword1') => post(m, '/account/2fa/on', { secret, code, password });
  assert.equal((await on(U.totp(secret, step() + 5))).status, 400);
  assert.equal((await on(U.totp(secret, step()), 'wrongpassword')).status, 400);
  const onStep = step();
  const shown = await on(U.totp(secret, onStep));
  const codes = shown.text.match(/<pre>([^<]+)<\/pre>/)[1].split('\n');
  assert.equal(codes.length, 10);
  assert.match((await req('get', '/site/twofa').set('Cookie', m.cookie)).text, /Recovery codes left: 10\./);

  const login = async () => (await req('post', '/login').type('form').send({ username: 'twofa', password: 'longpassword1' })).text.match(/name="token" value="([^"]+)"/)[1];
  const second = (token, code) => req('post', '/login/2fa').type('form').send({ token, code });
  let token = await login();
  assert.equal((await second(token, U.totp(secret, onStep))).status, 401); // the code that turned it on works once
  assert.equal((await second('nope', U.totp(secret, onStep + 1))).status, 400);
  const ok = await second(token, U.totp(secret, onStep + 1));
  assert.equal(ok.headers.location, '/dashboard');
  const other = { cookie: ok.headers['set-cookie'][0].split(';')[0] };
  token = await login();
  assert.equal((await second(token, codes[0].toUpperCase())).status, 302); // recovery code, any case
  token = await login();
  assert.equal((await second(token, codes[0])).status, 401); // each works once

  // an old signup link doesn't skip the code either
  db.prepare("INSERT INTO tokens (token_hash, user_id, kind, expires) VALUES (?, (SELECT id FROM users WHERE username = 'twofa'), 'verify', ?)").run(U.sha('oldlink'), Date.now() + 60000);
  const verify = await req('get', '/verify?token=oldlink');
  assert.equal(verify.headers.location, '/login');
  assert.equal(verify.headers['set-cookie'], undefined);

  // a reset link proves the email, not the phone, and ends logins waiting on their code
  const pending = await login();
  await req('post', '/forgot').type('form').send({ email: 'twofa@example.com' });
  const reset = await req('post', '/reset').type('form').send({ token: lastLink('reset'), password: 'longpassword1' });
  assert.equal(reset.status, 200);
  assert.equal(reset.headers['set-cookie'], undefined);
  assert.equal((await req('get', '/dashboard').set('Cookie', other.cookie)).status, 302);
  assert.equal((await second(pending, codes[3])).status, 400);

  // log back in, turn it off with a recovery code, then log out everywhere
  token = await login();
  const back = await second(token, codes[1]);
  const me = { cookie: back.headers['set-cookie'][0].split(';')[0] };
  me.csrf = (await req('get', '/dashboard').set('Cookie', me.cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await post(me, '/account/2fa/off', { code: codes[1], password: 'longpassword1' })).status, 400); // already used
  assert.equal((await post(me, '/account/2fa/off', { code: codes[2], password: 'longpassword1' })).status, 302);
  const plain = await req('post', '/login').type('form').send({ username: 'twofa', password: 'longpassword1' });
  assert.equal(plain.headers.location, '/dashboard');
  assert.equal((await post(me, '/account/logout-all', {})).status, 200);
  for (const c of [me.cookie, plain.headers['set-cookie'][0].split(';')[0]]) assert.equal((await req('get', '/dashboard').set('Cookie', c)).status, 302);
});

test('the editor loads CodeMirror and its addons from our own server, cached for good', async () => {
  const m = await member('cmhost');
  const page = (await req('get', '/dashboard/edit?path=index.html').set('Cookie', m.cookie)).text;
  const files = [...page.matchAll(/(?:src|href)="(\/cm\/[^"]+)"/g)].map((x) => x[1]);
  assert.ok(files.some((f) => f.endsWith('/addon/search/search.js')) && files.some((f) => f.endsWith('/addon/edit/closetag.js')));
  assert.doesNotMatch(page, /cdnjs/);
  for (const f of files) {
    const res = await req('get', f);
    assert.equal(res.status, 200, f);
    assert.match(res.headers['cache-control'], /immutable/);
  }
});

test('supporters run several sites under one login; free members cannot', async () => {
  const free = await member('freebie');
  const add = (m, username) => req('post', '/dashboard/sites/new').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, username });
  const pick = (m, id) => req('post', '/dashboard/sites/switch').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, id });
  const dash = async () => (await req('get', '/dashboard').set('Cookie', free.cookie)).text;
  assert.match((await add(free, 'freebie-two')).headers.location, /err=/);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE username = ?').get('freebie-two'), undefined);
  db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() + 86400000, 'freebie');
  assert.match((await add(free, 'freebie-two')).headers.location, /ok=/);
  const second = db.prepare('SELECT * FROM users WHERE username = ?').get('freebie-two');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'freebie-two', 'index.html')));
  // the extra site is not a login of its own
  assert.equal((await req('post', '/login').type('form').send({ username: 'freebie-two', password: 'longpassword1' })).status, 401);
  await pick(free, second.id);
  assert.match(await dash(), /<b>freebie-two<\/b>/);
  // a lapsed supporter keeps the sites but cannot add more
  db.prepare('UPDATE users SET supporter_until = 1 WHERE username = ?').run('freebie');
  assert.match((await add(free, 'freebie-three')).headers.location, /err=/);
  db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() + 86400000, 'freebie');
  for (const username of ['freebie-three', 'freebie-four', 'freebie-five']) {
    assert.match((await add(free, username)).headers.location, /ok=/);
  }
  assert.match((await add(free, 'freebie-six')).headers.location, /err=/);
  db.prepare('UPDATE users SET supporter_until = 1 WHERE username = ?').run('freebie');
  // someone else's site is not switchable
  await member('stranger');
  await pick(free, db.prepare('SELECT id FROM users WHERE username = ?').get('stranger').id);
  assert.match(await dash(), /<b>freebie-two<\/b>/);
  // "log out everywhere" reaches a session that is switched to an extra site
  await req('post', '/account/logout-all').set('Cookie', free.cookie).type('form').send({ _csrf: free.csrf });
  assert.equal((await req('get', '/dashboard').set('Cookie', free.cookie)).status, 302);
});

test('two-factor login shows its real state on an extra site', async () => {
  const m = await member('twofaextra');
  db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() + 86400000, 'twofaextra');
  assert.match((await post(m, '/dashboard/sites/new', { username: 'twofaextra-two' })).headers.location, /ok=/);
  const child = db.prepare('SELECT id FROM users WHERE username = ?').get('twofaextra-two');
  assert.equal((await post(m, '/dashboard/sites/switch', { id: child.id })).status, 302);
  const setup = await req('get', '/account/2fa').set('Cookie', m.cookie);
  assert.equal(setup.status, 200);
  const secret = setup.text.match(/name="secret" value="([A-Z2-7]{32})"/)[1];
  const shown = await post(m, '/account/2fa/on', { secret, code: U.totp(secret, Math.floor(Date.now() / 30000)), password: 'longpassword1' });
  assert.equal(shown.status, 200);
  assert.equal(shown.text.match(/<pre>([^<]+)<\/pre>/)[1].split('\n').length, 10);
  assert.ok(db.prepare('SELECT totp_secret FROM users WHERE username = ?').get('twofaextra').totp_secret);
  assert.equal(db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(child.id).totp_secret, '');
  const profile = await req('get', '/site/twofaextra-two').set('Cookie', m.cookie);
  assert.match(profile.text, /Recovery codes left: 10\./);
  assert.doesNotMatch(profile.text, /Turn on two-factor login/);
  const enabled = await req('get', '/account/2fa').set('Cookie', m.cookie);
  assert.equal(enabled.status, 302);
  assert.equal(enabled.headers.location, '/site/twofaextra-two#security');
});

test('extra sites follow their login for admin rights, bans, API keys and deletion', async () => {
  const boss = { cookie: (await req('post', '/login').type('form').send({ username: 'boss', password: 'longpassword1' })).headers['set-cookie'][0].split(';')[0] };
  boss.csrf = (await req('get', '/dashboard').set('Cookie', boss.cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  // an admin switched to an extra site is still an admin
  assert.match((await post(boss, '/dashboard/sites/new', { username: 'boss-two' })).headers.location, /ok=/);
  await post(boss, '/dashboard/sites/switch', { id: db.prepare('SELECT id FROM users WHERE username = ?').get('boss-two').id });
  assert.equal((await req('get', '/admin').set('Cookie', boss.cookie)).status, 200);

  const m = await member('multi');
  db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() + 86400000, 'multi');
  for (const username of ['multi-two', 'multi-three']) assert.match((await post(m, '/dashboard/sites/new', { username })).headers.location, /ok=/);
  const id = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
  // a password change switches off the API keys of every site
  db.prepare("UPDATE users SET api_key = 'k' || id WHERE username LIKE 'multi%'").run();
  await post(m, '/account/password', { password: 'longpassword1', new_password: 'longpassword2', confirm_password: 'longpassword2' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username LIKE 'multi%' AND api_key != ''").get().n, 0);
  // deleting while on an extra site removes only that site and keeps the login signed in
  await post(m, '/dashboard/sites/switch', { id: id('multi-three') });
  assert.match((await post(m, '/dashboard/delete-account', { password: 'longpassword2' })).headers.location, /ok=/);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE username = ?').get('multi-three'), undefined);
  assert.ok(id('multi'));
  assert.equal((await req('get', '/dashboard').set('Cookie', m.cookie)).status, 200);
  // taking down the login takes down its extra sites and ends its sessions; restore brings them back
  await post(m, '/dashboard/sites/switch', { id: id('multi-two') });
  await post(boss, '/admin/ban', { site: 'multi', action: 'ban', reason: 'test' });
  assert.equal((await req('get', '/', 'multi-two.pad.test')).status, 410);
  assert.equal((await req('get', '/dashboard').set('Cookie', m.cookie)).status, 302);
  await post(boss, '/admin/ban', { site: 'multi', action: 'unban' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username LIKE 'multi%' AND banned = 1").get().n, 0);
  // an extra site taken down on its own stays down through a ban and restore of its login
  await post(boss, '/admin/ban', { site: 'multi-two', action: 'ban', reason: 'phishing' });
  await post(boss, '/admin/ban', { site: 'multi', action: 'ban', reason: 'spam' });
  await post(boss, '/admin/ban', { site: 'multi', action: 'unban' });
  assert.equal((await req('get', '/', 'multi.pad.test')).status, 200);
  assert.equal((await req('get', '/', 'multi-two.pad.test')).status, 410);
  assert.equal(db.prepare('SELECT ban_reason FROM users WHERE username = ?').get('multi-two').ban_reason, 'phishing');
});

test('only the editor takes big forms; a huge one anywhere else is refused, not held in memory', async () => {
  const big = 'a'.repeat(200 * 1024);
  const login = await req('post', '/login').type('form').send({ username: big, password: 'x' });
  assert.equal(login.status, 413);
  assert.equal((await req('post', '/signup').type('form').send({ username: 'x', email: big })).status, 413);
  const m = await member('bigform');
  const save = await req('post', '/dashboard/save').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'big.html', content: 'b'.repeat(500 * 1024) });
  assert.equal(save.status, 200);
  assert.equal(fs.statSync(path.join(process.env.DATA_DIR, 'sites', 'bigform', 'big.html')).size, 500 * 1024);
});

test('guestbooks and the report queue page through every entry, so none is out of reach', async () => {
  const m = await member('busybook');
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get('busybook').id;
  const add = db.prepare('INSERT INTO guestbook (user_id, name, message, approved, created_at) VALUES (?,?,?,?,?)');
  const held = add.run(id, 'oldest', 'see www.example.com', 0, 1).lastInsertRowid;
  for (let i = 0; i < 520; i++) add.run(id, `n${i}`, `entry ${i}`, 1, 2 + i);
  // visitors: 50 a page, newest first, older pages keep the theme
  const first = await req('get', '/_hw/guestbook?theme=night', 'busybook.pad.test');
  assert.match(first.text, /entry 519/);
  assert.doesNotMatch(first.text, /entry 469\b/);
  assert.match(first.text, /href="\/_hw\/guestbook\?theme=night&amp;page=2"/);
  const last = await req('get', '/_hw/guestbook?page=11', 'busybook.pad.test');
  assert.match(last.text, /entry 0\b/);
  assert.doesNotMatch(last.text, /oldest/); // held entries never show to visitors
  // the owner reaches a held entry older than the newest 500, approves it and lands back on its page
  const page11 = await req('get', '/dashboard/guestbook?page=11').set('Cookie', m.cookie);
  assert.match(page11.text, /approve \(held/);
  const back = await post(m, '/dashboard/guestbook/approve', { id: held, page: 11 });
  assert.equal(back.headers.location, '/dashboard/guestbook?page=11');
  assert.equal(db.prepare('SELECT approved FROM guestbook WHERE id = ?').get(held).approved, 1);
  // the admin queue pages too
  const boss = { cookie: (await req('post', '/login').type('form').send({ username: 'boss', password: 'longpassword1' })).headers['set-cookie'][0].split(';')[0] };
  boss.csrf = (await req('get', '/dashboard').set('Cookie', boss.cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  db.prepare("UPDATE reports SET status = 'closed'").run();
  const rep = db.prepare("INSERT INTO reports (site, reason, details, created_at) VALUES ('busybook', 'Spam', ?, ?)");
  for (let i = 0; i < 60; i++) rep.run(`report ${i}`, i);
  const queue = await req('get', '/admin?rpage=2').set('Cookie', boss.cookie);
  assert.match(queue.text, /report 0\b/);
  assert.doesNotMatch(queue.text, /report 59\b/);
});

test('file history keeps each save of a text file, puts old versions back and brings deleted files back', async () => {
  const m = await member('historian');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get('historian');
  const tree = path.join(process.env.DATA_DIR, 'sites', 'historian');
  const H = require('../src/history');
  // commits run in the background after each save; wait until the page shows what is expected
  const until = async (url, re) => {
    for (let i = 0; i < 100; i++) {
      const res = await req('get', url).set('Cookie', m.cookie);
      if (re.test(res.text)) return res;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`${url} never matched ${re}`);
  };
  const save = (content) => post(m, '/dashboard/save', { path: 'a.html', content });
  await save('<p>first</p>');
  await until('/dashboard/history/file?path=a.html', /current version/);
  await save('<p>second</p>');
  const page = await until('/dashboard/history/file?path=a.html', /put this version back/);
  const old = page.text.match(/name="v" value="([0-9a-f]{40})"/)[1];
  const view = await req('get', `/dashboard/history/view?path=a.html&v=${old}`).set('Cookie', m.cookie);
  assert.equal(view.text, '<p>first</p>');
  assert.match(view.headers['content-type'], /text\/plain/);
  const back = await post(m, '/dashboard/history/restore', { path: 'a.html', v: old });
  assert.match(back.headers.location, /ok=Restored/);
  assert.equal(fs.readFileSync(path.join(tree, 'a.html'), 'utf8'), '<p>first</p>');
  // the signup's starter page was kept before any edit
  assert.ok((await H.versions(user.id, tree, 'index.html')).length >= 1);
  // deleted files are listed and come back
  await until('/dashboard/history/file?path=a.html', /current version/);
  await post(m, '/dashboard/delete', { path: 'a.html' });
  const gone = await until('/dashboard/history', /<td>a\.html<\/td>/);
  const before = gone.text.match(/name="v" value="([0-9a-f]{40})"/)[1];
  // the file's own page lists only versions that hold it, each one viewable
  for (const v of await H.versions(user.id, tree, 'a.html')) assert.ok(await H.show(user.id, tree, v.sha, 'a.html'));
  await post(m, '/dashboard/history/restore', { path: 'a.html', v: before });
  assert.equal(fs.readFileSync(path.join(tree, 'a.html'), 'utf8'), '<p>first</p>');
  // pictures are not kept, and nobody reads another site's versions or a made-up one
  await upload(m, 'cat.png', 'png');
  assert.equal((await req('get', '/dashboard/history/file?path=cat.png').set('Cookie', m.cookie)).status, 400);
  assert.equal((await req('get', '/dashboard/history/view?path=a.html&v=HEAD').set('Cookie', m.cookie)).status, 404);
  // trimming forgets versions older than the cutoff but always keeps the newest, and keeps the repository small
  await until('/dashboard/history/file?path=a.html', /current version/);
  await H.trim(user.id, tree, { since: Date.now() + 1000, maxBytes: 1 << 20 });
  const left = await H.versions(user.id, tree, 'a.html');
  assert.equal(left.length, 1);
  assert.equal((await H.show(user.id, tree, left[0].sha, 'a.html')).toString(), '<p>first</p>');
  assert.equal((await H.versions(user.id, tree, 'cat.png')).length, 0);
  // a removal waits for a commit still running instead of failing under it, and nothing comes back after
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-scratch-'));
  fs.writeFileSync(path.join(scratch, 'a.html'), 'x');
  try {
    const saving = H.record(999999, scratch, 'late save');
    await H.remove(999999);
    await saving;
    assert.ok(!H.exists(999999));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  // a restore whose session ends while it waits on the history queue writes nothing
  await save('<p>third</p>');
  const login = await req('post', '/login').type('form').send({ username: 'historian', password: 'longpassword1' });
  const other = { cookie: login.headers['set-cookie'][0].split(';')[0] };
  other.csrf = (await req('get', '/dashboard').set('Cookie', other.cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const show = H.show;
  H.show = (...a) => { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(U.sha(other.cookie.split('=')[1])); return show(...a); };
  try {
    const late = await post(other, '/dashboard/history/restore', { path: 'a.html', v: left[0].sha });
    assert.equal(late.headers.location, '/login');
  } finally { H.show = show; }
  assert.equal(fs.readFileSync(path.join(tree, 'a.html'), 'utf8'), '<p>third</p>');
  // deleting the account deletes its history, in the background
  await post(m, '/dashboard/delete-account', { password: 'longpassword1' });
  for (let i = 0; i < 100 && H.exists(user.id); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!H.exists(user.id));
});

test('supporters get bigger limits and any file type; when support lapses nothing is deleted', async () => {
  const m = await member('bigdog');
  const big = Buffer.alloc(1.5 * 1048576, 65);
  const api = (path) => req('get', path);
  assert.match((await upload(m, 'tool.exe', 'MZ')).text, /tool\.exe \(name or file type not allowed\)/);
  assert.equal((await upload(m, 'big.png', big)).status, 400); // over the free 1 MB file limit
  db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() + 86400000, 'bigdog');
  assert.match((await upload(m, 'tool.exe', 'MZ')).text, /Uploaded 1 file/);
  assert.match((await upload(m, 'big.png', big)).text, /Uploaded 1 file/);
  const dash = (await req('get', '/dashboard').set('Cookie', m.cookie)).text;
  assert.match(dash, /of 3 MB/);
  assert.match(dash, /data-max="2097152"/); // the drag-and-drop uploader checks sizes against the supporter limit too
  // a supporter's rarer page types are still checked for phishing
  await upload(m, 'login.xhtml', '<form action="https://evil.example/steal"><input type="password" name="pw"> verify your account</form>');
  assert.match(db.prepare("SELECT details FROM reports WHERE site = 'bigdog' AND reason = 'Auto-flag'").get().details, /^login\.xhtml:/);
  // the CLI reads its limits from the API
  const key = (await req('post', '/dashboard/api').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, action: 'new', password: 'longpassword1' })).text.match(/<pre>([^<]+)<\/pre>/)[1];
  const site = (await api('/api/site').set('Authorization', `Bearer ${key}`)).body;
  assert.equal(site.any_type, true);
  assert.equal(site.quota_bytes, 3 * 1048576);
  assert.equal(site.max_file_bytes, 2 * 1048576);
  // lapsed: the files stay, but nothing new goes in while the site is over the free quota
  db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() - 1000, 'bigdog');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'bigdog', 'big.png')));
  assert.equal((await req('get', '/big.png', 'bigdog.pad.test')).status, 200);
  assert.match((await upload(m, 'note.txt', 'hi')).text, /note\.txt \(over your 1 MB limit\)/);
  assert.equal((await api('/api/site').set('Authorization', `Bearer ${key}`)).body.any_type, false);
  // and any file that is there can still be deleted
  await req('post', '/dashboard/delete').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, path: 'tool.exe' });
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'sites', 'bigdog', 'tool.exe')));
});

test('supporting through Stripe: checkout, webhook, flair, billing portal and lapse', async () => {
  const m = await member('goodboy');
  const signer = new Stripe('sk_test_fake').webhooks;
  const hook = (type, object, secret = 'whsec_test') => {
    const payload = JSON.stringify({ id: `evt_${type}`, object: 'event', type, data: { object } });
    return req('post', '/stripe/webhook').set('Content-Type', 'application/json')
      .set('Stripe-Signature', signer.generateTestHeaderString({ payload, secret })).send(payload);
  };
  // Stripe now holds sub as it is, and sends an event about it
  const subHook = (type, sub) => { fake.subs = fake.subs.filter((o) => o.id !== sub.id).concat(sub); return hook(type, sub); };
  const row = () => db.prepare('SELECT * FROM users WHERE username = ?').get('goodboy');
  const page = await req('get', '/dashboard/support').set('Cookie', m.cookie);
  assert.match(page.text, /Become a supporter/);
  assert.match(page.headers['content-security-policy'], /form-action 'self' https:\/\/checkout\.stripe\.com/);
  assert.match((await req('get', '/dashboard').set('Cookie', m.cookie)).text, /href="\/dashboard\/support"/);
  const go = await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  assert.equal(go.status, 303);
  assert.equal(go.headers.location, 'https://checkout.stripe.com/c/pay/test');
  const call = stripeCalls.at(-1);
  const cus = row().stripe_customer_id;
  assert.match(cus, /^cus_test/); // made before checkout, so every try finds the same customer
  assert.equal(call.client_reference_id, String(row().id));
  assert.equal(call.customer, cus);
  assert.deepEqual(call.line_items, [{ price: 'price_test', quantity: 1 }]);
  assert.deepEqual(call.subscription_data.billing_mode, { type: 'flexible' });
  // a second try before paying reopens the same checkout instead of starting a second subscription
  fake.open.push({ id: 'cs_open', customer: cus, url: 'https://checkout.stripe.com/c/pay/open', line_items: { data: [{ price: { id: 'price_test' } }] } });
  const again = await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  assert.equal(again.headers.location, 'https://checkout.stripe.com/c/pay/open');
  fake.open = [];
  // paid, but the webhook hasn't arrived: no second checkout either
  fake.subs.push({ id: 'sub_1', customer: cus, status: 'active' });
  assert.equal((await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf })).status, 409);

  // forged or unsigned webhooks change nothing
  const before = row().supporter_until;
  assert.equal((await hook('customer.subscription.created', { id: 'sub_1', customer: cus, status: 'active', metadata: {}, items: { data: [{ current_period_end: 2e9 }] } }, 'whsec_wrong')).status, 400);
  assert.equal(row().supporter_until, before);
  assert.equal((await hook('checkout.session.completed', { customer: cus, client_reference_id: String(row().id) })).status, 200);
  assert.equal(row().stripe_customer_id, cus);
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const live = { id: 'sub_1', customer: cus, status: 'active', metadata: {}, items: { data: [{ current_period_end: end }] } };
  await subHook('customer.subscription.created', live);
  assert.ok(row().supporter_until > end * 1000);

  // flair wherever the name shows, and the count on the home page
  assert.match((await req('get', '/site/goodboy')).text, /class="pic supporter"/);
  assert.match((await req('get', '/site/goodboy')).text, /alt="PuppyPad supporter"/);
  assert.match((await req('get', '/')).text, /kept running by \d+ supporters?/);
  assert.equal((await req('get', '/img/supporter.svg')).status, 200);
  assert.match((await req('get', '/dashboard/support').set('Cookie', m.cookie)).text, /You are a supporter until/);
  // already supporting: no second subscription, but the billing portal
  assert.equal((await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf })).status, 409);
  const portal = await req('post', '/dashboard/support/portal').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  assert.equal(portal.headers.location, 'https://billing.stripe.com/p/session/test');
  assert.equal(stripeCalls.at(-1).customer, cus);

  // a failed renewal: Stripe moves the period on anyway, but the perks only last the grace days past the paid one
  const renewed = Math.floor(Date.now() / 1000) - 5 * 86400;
  await subHook('customer.subscription.updated', { ...live, status: 'past_due', items: { data: [{ current_period_start: renewed, current_period_end: renewed + 30 * 86400 }] } });
  assert.equal(row().supporter_until, (renewed + 3 * 86400) * 1000);
  await subHook('customer.subscription.updated', live); // the retry went through
  assert.ok(row().supporter_until > end * 1000);

  // cancelled: the perks and the flair stop at once
  await subHook('customer.subscription.deleted', { ...live, status: 'canceled' });
  assert.ok(row().supporter_until <= Date.now());
  // an older event arriving late can't bring the perks back: what Stripe holds now wins
  await hook('customer.subscription.updated', live);
  assert.ok(row().supporter_until <= Date.now());
  assert.doesNotMatch((await req('get', '/site/goodboy')).text, /alt="PuppyPad supporter"/);
  assert.match((await req('get', '/dashboard/support').set('Cookie', m.cookie)).text, /Your support ended/);
  // a subscription carries its member in metadata, so it lands even before checkout's event links the customer
  await member('latepup');
  const pupId = db.prepare('SELECT id FROM users WHERE username = ?').get('latepup').id;
  await subHook('customer.subscription.created', { id: 'sub_2', customer: 'cus_2', status: 'active', metadata: { user_id: String(pupId) }, items: { data: [{ current_period_end: end }] } });
  assert.ok(db.prepare('SELECT supporter_until FROM users WHERE id = ?').get(pupId).supporter_until > Date.now());

  // deleting the login cancels its live subscription first (one the webhooks haven't reported yet too), and keeps the account if Stripe can't be reached
  fake.subs.push({ id: 'sub_3', customer: cus, status: 'active' });
  const del = () => req('post', '/dashboard/delete-account').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, password: 'longpassword1' });
  fake.fail = true;
  assert.equal((await del()).status, 502);
  assert.ok(row());
  fake.fail = false;
  assert.equal((await del()).status, 200);
  assert.deepEqual(fake.cancelled, ['sub_3']);
  assert.equal(row(), undefined);

  // the terms and the privacy page say what supporting means and who takes the money
  assert.match((await req('get', '/rules')).text, /id="supporter-terms"/);
  assert.match((await req('get', '/privacy')).text, /processed by Stripe/);
});

test('supporter checkout searches all pages before reusing or expiring open sessions', async () => {
  const m = await member('paged-checkout');
  const cus = 'cus_paged';
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE username = ?').run(cus, 'paged-checkout');
  const open = (id, price, customer = cus) => ({ id, customer, url: `https://checkout.stripe.com/c/pay/${id}`, line_items: { data: [{ price: { id: price } }] } });
  const others = Array.from({ length: 101 }, (_, i) => open(`cs_other_${i}`, 'price_test_year'));
  const matching = open('cs_matching', 'price_test');
  const unrelated = open('cs_unrelated', 'price_test_year', 'cus_unrelated');
  const checkout = () => req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, plan: 'monthly' });
  fake.open = [unrelated, ...others, matching];
  try {
    const before = stripeCalls.length;
    const reused = await checkout();
    assert.equal(reused.status, 303);
    assert.equal(reused.headers.location, matching.url);
    assert.deepEqual(fake.open, [unrelated, ...others, matching]);
    assert.equal(stripeCalls.length - before, 2); // only subscriptions and sessions listed; no expiry or creation

    fake.open = [unrelated, ...others];
    const start = stripeCalls.length;
    const created = await checkout();
    assert.equal(created.status, 303);
    assert.equal(created.headers.location, 'https://checkout.stripe.com/c/pay/test');
    assert.deepEqual(fake.open, [unrelated]);
    assert.deepEqual(stripeCalls.slice(start + 2, -1), others.map((o) => o.id));
    assert.deepEqual(stripeCalls.at(-1).line_items, [{ price: 'price_test', quantity: 1 }]);
  } finally {
    fake.open = [];
  }
});

test('supporter checkout offers the monthly and the yearly price', async () => {
  const m = await member('choosey');
  const page = await req('get', '/dashboard/support').set('Cookie', m.cookie);
  assert.match(page.text, /Become a supporter — monthly/);
  assert.match(page.text, /Become a supporter — yearly/);
  // the yearly button checks out at the yearly price
  const yr = await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, plan: 'annual' });
  assert.equal(yr.status, 303);
  assert.equal(yr.headers.location, 'https://checkout.stripe.com/c/pay/test');
  assert.deepEqual(stripeCalls.at(-1).line_items, [{ price: 'price_test_year', quantity: 1 }]);
  // no plan in the post (the old single-button form) still checks out at the monthly price
  const mo = await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  assert.equal(mo.status, 303);
  assert.deepEqual(stripeCalls.at(-1).line_items, [{ price: 'price_test', quantity: 1 }]);
  const end = Math.floor(Date.now() / 1000) + 365 * 86400;
  const cus = db.prepare('SELECT stripe_customer_id FROM users WHERE username = ?').get('choosey').stripe_customer_id;
  // an open monthly checkout is reused for monthly, but replaced when the member picks yearly
  fake.open.push({ id: 'cs_mo', customer: cus, url: 'https://checkout.stripe.com/c/pay/mo', line_items: { data: [{ price: { id: 'price_test' } }] } });
  const same = await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, plan: 'monthly' });
  assert.equal(same.headers.location, 'https://checkout.stripe.com/c/pay/mo');
  const sw = await req('post', '/dashboard/support').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, plan: 'annual' });
  assert.equal(sw.headers.location, 'https://checkout.stripe.com/c/pay/test');
  assert.deepEqual(fake.open, []);
  assert.deepEqual(stripeCalls.at(-1).line_items, [{ price: 'price_test_year', quantity: 1 }]);
  // the webhook still just follows the subscription: a yearly one sets supporter_until a year out
  const signer = new Stripe('sk_test_fake').webhooks;
  const hook = (type, object, secret = 'whsec_test') => {
    const payload = JSON.stringify({ id: `evt_${type}`, object: 'event', type, data: { object } });
    return req('post', '/stripe/webhook').set('Content-Type', 'application/json')
      .set('Stripe-Signature', signer.generateTestHeaderString({ payload, secret })).send(payload);
  };
  const sub = { id: 'sub_year', customer: cus, status: 'active', metadata: {}, items: { data: [{ current_period_end: end }] } };
  fake.subs = fake.subs.filter((o) => o.id !== sub.id).concat(sub);
  assert.equal((await hook('customer.subscription.created', sub)).status, 200);
  assert.ok(db.prepare('SELECT supporter_until FROM users WHERE username = ?').get('choosey').supporter_until > end * 1000);
});

test('support checkout, billing portal and account deletion stop when the member is signed out while Stripe answers', async () => {
  const m = await member('midstripe');
  const signOut = () => db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'midstripe')").run();
  const post = (url, body = {}) => req('post', url).set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...body });
  // the request's last Stripe call answers only after the member is signed out, as "log out everywhere" or a ban from elsewhere would;
  // so only a check after the await can stop it
  const during = async (obj, fn, run) => {
    const orig = obj[fn];
    obj[fn] = async (...a) => { const r = await orig(...a); signOut(); return r; };
    try { return await run(); } finally { obj[fn] = orig; }
  };
  const go = await during(stripe.checkout.sessions, 'create', async () => {
    const r = await post('/dashboard/support');
    // signed out mid-request: no Checkout link handed out; sign back in for the next step
    Object.assign(m, await relogin());
    return r;
  });
  assert.equal(go.headers.location, '/login');
  const portal = await during(stripe.billingPortal.sessions, 'create', async () => {
    db.prepare("UPDATE users SET stripe_customer_id = 'cus_mid' WHERE username = 'midstripe'").run();
    const r = await post('/dashboard/support/portal');
    Object.assign(m, await relogin());
    return r;
  });
  assert.equal(portal.headers.location, '/login');
  fake.subs.push({ id: 'sub_mid', customer: 'cus_mid', status: 'active' });
  const del = await during(stripe.subscriptions, 'cancel', () => post('/dashboard/delete-account', { password: 'longpassword1' }));
  assert.equal(del.headers.location, '/login');
  assert.ok(fake.cancelled.includes('sub_mid')); // the cancel went through; the account stays
  assert.ok(db.prepare("SELECT 1 FROM users WHERE username = 'midstripe'").get());

  async function relogin() {
    const res = await req('post', '/login').type('form').send({ username: 'midstripe', password: 'longpassword1' });
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const csrf = (await req('get', '/dashboard').set('Cookie', cookie)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    return { cookie, csrf };
  }
});

test('support checkout and billing portal share a rate limit per login', async () => {
  const m = await member('hammer');
  const post = (url) => req('post', url).set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf });
  for (let i = 0; i < 5; i++) assert.equal((await post('/dashboard/support')).status, 303);
  for (let i = 0; i < 5; i++) assert.notEqual((await post('/dashboard/support/portal')).status, 429);
  const before = stripeCalls.length;
  assert.equal((await post('/dashboard/support')).status, 429);
  assert.equal((await post('/dashboard/support/portal')).status, 429);
  assert.equal(stripeCalls.length, before); // turned away before any Stripe call
});
