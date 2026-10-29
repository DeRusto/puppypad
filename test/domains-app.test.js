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
