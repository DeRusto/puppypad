// Custom domains through the app: serving, redirects, the dashboard, reports and /admin. The claim rules
// themselves are in test/domains.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-domains-app-'));
process.env.BASE_URL = 'http://pad.test';
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.CUSTOM_DOMAINS = 'on';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SMTP_HOST;
delete process.env.TURNSTILE_SECRET_KEY;

const mail = [];
const log = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail not configured]')) mail.push(s); else log(...a); };

const app = require('../src/server');
const { db } = require('../src/db');

const OURS = ['203.0.113.7', '2001:db8::7'];
const world = { txt: new Map(), addrs: new Map(), https: new Map() };
app.setDomainNet({
  txt: async (name) => world.txt.get(name) || [],
  addrs: async (name) => (name === 'pad.test' ? OURS : world.addrs.get(name) || []),
  https: async (host) => world.https.get(host) ?? true,
});
const point = (c) => { world.txt.set(`_puppypad.${c.host}`, [`puppypad-verify=${c.token}`]); world.addrs.set(c.host, OURS); };

let ipN = 0;
const ip = () => `10.1.${(ipN >> 8) & 255}.${ipN++ & 255}`;
const req = (method, url, host = 'pad.test') => request(app)[method](url).set('Host', host).set('X-Forwarded-For', ip());
const lastLink = (kind) => mail.join('\n').match(new RegExp(`${kind}\\?token=([\\w-]+)`, 'g')).pop().split('=')[1];
const row = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
async function member(username, { supporter = true } = {}) {
  await req('post', '/signup').type('form').send({ username, email: `${username}@example.com`, password: 'longpassword1', agree: '1' });
  const res = await req('get', `/verify?token=${lastLink('verify')}`);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  if (supporter) db.prepare('UPDATE users SET supporter_until = ? WHERE username = ?').run(Date.now() + 100 * 86400000, username);
  const dash = await req('get', '/dashboard').set('Cookie', cookie);
  return { cookie, csrf: dash.text.match(/name="_csrf" value="([^"]+)"/)[1], name: username };
}
// a Site serving at `host`, through the module the dashboard uses
async function liveAt(name, host) {
  const m = await member(name);
  const c = app.domains.add(row(name), host).claim;
  point(c);
  assert.equal((await app.domains.check(row(name))).state, 'live');
  return m;
}

test('tls-check answers 200 for a live claim and 404 for anything else', async () => {
  await liveAt('tlsdog', 'tls.example');
  assert.equal((await req('get', '/internal/tls-check?domain=tls.example', 'app')).status, 200);
  for (const d of ['other.example', 'pad.test', 'tlsdog.pad.test', '203.0.113.7', '']) {
    assert.equal((await req('get', `/internal/tls-check?domain=${encodeURIComponent(d)}`, 'app')).status, 404, d);
  }
});

test('the custom host serves its Site, and the subdomain 301s GET and HEAD there', async () => {
  await liveAt('rexden', 'www.rexden.example');
  const page = await req('get', '/', 'www.rexden.example');
  assert.equal(page.status, 200);
  assert.match(page.text, /rexden/);
  for (const method of ['get', 'head']) {
    const r = await req(method, '/pics/a.png?x=1', 'rexden.pad.test');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, 'https://www.rexden.example/pics/a.png?x=1');
    assert.match(r.headers['cache-control'], /max-age=86400/);
  }
  // other methods are served as before
  assert.notEqual((await req('post', '/_hw/guestbook', 'rexden.pad.test').type('form').send({ name: 'a', message: 'b' })).status, 301);
  // links everywhere name the custom host
  assert.match((await req('get', '/site/rexden')).text, /https:\/\/www\.rexden\.example/);
});

test('visits between a Site\'s two hosts are not referrals', async () => {
  await liveAt('refdog', 'ref.example');
  await req('get', '/', 'ref.example').set('Referer', 'http://refdog.pad.test/a.html');
  await req('get', '/', 'ref.example').set('Referer', 'https://elsewhere.example/');
  const id = row('refdog').id;
  assert.deepEqual(db.prepare('SELECT host FROM referrers WHERE user_id = ?').all(id).map((r) => r.host), ['elsewhere.example']);
});

test('a taken-down Site gives 410 on both hosts, and Caddy may still renew its certificate', async () => {
  await liveAt('downdog', 'down.example');
  db.prepare('UPDATE users SET banned = 1 WHERE username = ?').run('downdog');
  assert.equal((await req('get', '/', 'down.example')).status, 410);
  assert.equal((await req('get', '/', 'downdog.pad.test')).status, 410);
  assert.equal((await req('get', '/internal/tls-check?domain=down.example', 'app')).status, 200);
});

test('a failing host is an unknown host, and the subdomain serves again', async () => {
  await liveAt('faildog', 'fail.example');
  db.prepare("UPDATE custom_domains SET state = 'failing' WHERE host = 'fail.example'").run();
  const r = await req('get', '/', 'fail.example');
  assert.equal(r.status, 404);
  assert.equal(r.text, 'Unknown host');
  assert.equal((await req('get', '/', 'faildog.pad.test')).status, 200);
});

test('a renamed Site keeps its domain, and the held old name 301s straight to it', async () => {
  const m = await liveAt('oldname', 'renamed.example');
  const r = await req('post', '/dashboard/rename').set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, username: 'newname', password: 'longpassword1' });
  assert.equal(r.status, 302);
  assert.equal((await req('get', '/', 'renamed.example')).status, 200);
  const old = await req('get', '/x.html', 'oldname.pad.test');
  assert.equal(old.status, 301);
  assert.equal(old.headers.location, 'https://renamed.example/x.html');
});

const post = (m, url, body = {}) => req('post', url).set('Cookie', m.cookie).type('form').send({ _csrf: m.csrf, ...body });
const dash = async (m) => (await req('get', '/dashboard').set('Cookie', m.cookie)).text;

test('on the dashboard a supporter adds a domain, sees the records, checks it and removes it', async () => {
  const m = await member('dashdog');
  assert.match(await dash(m), /<summary>Use your own domain<\/summary>/);
  assert.match((await post(m, '/dashboard/domain', { host: 'https://nope.example/' })).headers.location, /err=/);
  assert.equal((await post(m, '/dashboard/domain', { host: 'WWW.Dash.Example' })).status, 302);
  let page = await dash(m);
  assert.match(page, /Your domain: <code>www\.dash\.example<\/code> <b class="note">\[waiting for DNS\]<\/b>/);
  assert.match(page, /<details open><summary>Custom domain settings<\/summary>/);
  const c = app.domains.of(row('dashdog'));
  assert.ok(page.includes(`puppypad-verify=${c.token}`));
  assert.ok(page.includes('<code>_puppypad.www.dash.example</code>'));
  for (const a of OURS) assert.ok(page.includes(`<code>${a}</code>`), a);
  assert.match(page, /CNAME<\/td><td><code>www\.dash\.example<\/code><\/td><td><code>pad\.test<\/code>/);
  assert.match(page, /Your custom domain www\.dash\.example will stop working\./); // in the delete confirmation
  // Check now, with the records still missing, then in place
  await post(m, '/dashboard/domain/check');
  assert.match(await dash(m), /can.t find the TXT record yet/);
  point(c);
  await post(m, '/dashboard/domain/check');
  page = await dash(m);
  assert.match(page, /\[live\]/);
  assert.match(page, /is live\. Visitors to dashdog\.pad\.test are sent there/);
  assert.equal((await post(m, '/dashboard/domain/remove')).status, 302);
  assert.equal(app.domains.of(row('dashdog')), undefined);
  assert.equal((await req('get', '/', 'www.dash.example')).status, 404);
});

test('a member who does not support gets no domain form, and cannot add one', async () => {
  const m = await member('freedog', { supporter: false });
  assert.doesNotMatch(await dash(m), /Use your own domain/);
  assert.match((await post(m, '/dashboard/domain', { host: 'free.example' })).headers.location, /supporters/);
  assert.equal(app.domains.of(row('freedog')), undefined);
});

test('the dashboard says what happened to an ended claim', async () => {
  const m = await liveAt('enddog', 'end.example');
  app.domains.detach(row('enddog'), 'it hosted phishing');
  const page = await dash(m);
  assert.match(page, /A moderator removed <b>end\.example<\/b>: it hosted phishing\./);
  assert.match(page, /<summary>Use your own domain<\/summary>/); // and a new one can be added
});
