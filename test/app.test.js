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
  assert.deepEqual(U.phishSignals('<script src="https://coinhive.com/lib/coinhive.min.js"></script>'), ['crypto-miner script']);
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
  await member('shotdog');
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
  const shown = async () => (await req('get', '/dashboard').set('Cookie', m.cookie)).text.match(/Space used: (.*?) of .*? in (\d+) file/).slice(1).join(' / ');
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
  const post = (body) => req('post', '/admin/upgrade').set('Cookie', cookie).type('form').send({ _csrf: csrf, ...body });
  const dir = path.join(process.env.DATA_DIR, 'upgrade');
  const request = path.join(dir, 'request');

  assert.match((await page()).text, /upgrade watcher is not running/);
  assert.match((await post({ action: 'check' })).text, /not running/);
  assert.ok(!fs.existsSync(request));

  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, 'state'), `status=idle\ncurrent=v0.9.0\nlatest=v0.10.0\nurl=https://github.com/DeRusto/puppypad/releases/tag/v0.10.0\npublished_at=${now}\nseen_at=${now}\n`);
  fs.writeFileSync(path.join(dir, 'notes'), 'Add <b>things</b>\n');
  const shown = (await page()).text;
  assert.match(shown, /Running <code>v0\.9\.0<\/code>/);
  assert.match(shown, /Add &lt;b&gt;things&lt;\/b&gt;/);
  assert.match(shown, /upgrade to v0\.10\.0/);

  assert.match((await post({ action: 'upgrade', target: 'v0.11.0' })).text, /no longer the newest/);
  assert.match((await post({ action: 'upgrade', target: 'v0.10.0; rm -rf /' })).text, /no longer the newest/);
  assert.ok(!fs.existsSync(request));
  await post({ action: 'upgrade', target: 'v0.10.0' });
  assert.equal(fs.readFileSync(request, 'utf8'), 'upgrade v0.10.0\n');
  assert.match((await post({ action: 'check' })).text, /already under way/);
  assert.equal(db.prepare("SELECT detail FROM admin_log WHERE action = 'upgrade'").get().detail, 'v0.9.0 -> v0.10.0');

  const other = await member('upgrade-nosy');
  assert.equal((await req('post', '/admin/upgrade').set('Cookie', other.cookie).type('form').send({ _csrf: other.csrf, action: 'check' })).status, 404);
});

test('SEO: robots, sitemap, favicon, and page meta', async () => {
  const robots = await req('get', '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers['content-type'], /text\/plain/);
  assert.match(robots.text, /Disallow: \/dashboard/);
  assert.match(robots.text, /Sitemap: http:\/\/pad\.test\/sitemap\.xml/);

  // a listed site (old enough, has an update) appears in the sitemap; a fresh one does not
  const old = Date.now() - 48 * 3600000;
  db.prepare("INSERT INTO users (username, email, pw_hash, verified, created_at, updated_at, updates) VALUES ('oldtimer', 'oldtimer@example.com', 'x', 1, ?, ?, 1)").run(old, old);
  const sitemap = await req('get', '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.text, /<loc>http:\/\/pad\.test\/<\/loc>/);
  assert.match(sitemap.text, /<loc>http:\/\/pad\.test\/site\/oldtimer<\/loc><lastmod>/);
  assert.ok(!sitemap.text.includes('/dashboard'));

  assert.equal((await req('get', '/favicon.ico')).status, 200);
  assert.equal((await req('get', '/og.svg')).status, 200);

  const home = await req('get', '/');
  assert.match(home.text, /<meta name="description" content="[^"]*free homepage host/);
  assert.match(home.text, /<link rel="canonical" href="http:\/\/pad\.test\/">/);
  assert.match(home.text, /property="og:title"/);
  assert.match(home.text, /application\/ld\+json/);
  assert.ok(!home.text.includes('noindex'));

  const dash = await req('get', '/login');
  assert.match(dash.text, /<meta name="robots" content="noindex">/);

  const profile = await req('get', '/site/oldtimer');
  assert.match(profile.text, /<link rel="canonical" href="http:\/\/pad\.test\/site\/oldtimer">/);
});
