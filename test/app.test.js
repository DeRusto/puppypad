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
