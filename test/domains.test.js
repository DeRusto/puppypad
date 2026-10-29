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

// ---------- claims, with DNS and HTTPS stubbed ----------
const OURS = ['203.0.113.7', '2001:db8::7'];
const cfg = { CUSTOM_DOMAINS: true, BASE_HOST: BASE, BASE_URL: `http://${BASE}`, SITE_NAME: 'PuppyPad', ABUSE_EMAIL: `abuse@${BASE}`, ADMIN_EMAILS: new Set() };
const logins = createLogins({ cfg, removeSite: () => {}, holdName: () => {} });
// what the world's DNS says, and whether an HTTPS request to a host gets through Caddy
const world = { txt: new Map(), addrs: new Map(), https: new Map() };
const net = {
  txt: async (name) => world.txt.get(name) || [],
  addrs: async (name) => (name === BASE ? OURS : world.addrs.get(name) || []),
  https: async (host) => world.https.get(host) ?? true,
};
const mail = [];
const sendMail = async (to, subject, text) => { mail.push({ to, subject, text }); return true; };
const domains = createDomains({ cfg, logins, sendMail, net });

let n = 0;
const site = (fields = {}) => {
  const name = `pup${++n}`;
  const f = { username: name, email: `${name}@x.test`, login_id: null, supporter_until: Date.now() + 100 * DAY, banned: 0, ...fields };
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, email, pw_hash, verified, banned, login_id, supporter_until, created_at, updated_at) VALUES (@username, @email, 'h', 1, @banned, @login_id, @supporter_until, 0, 0)").run(f);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
};
let h = 0;
const newHost = () => `www.dog${++h}.example`;
// the member put both records in place
const point = (claim) => {
  world.txt.set(`_puppypad.${claim.host}`, [...(world.txt.get(`_puppypad.${claim.host}`) || []), `puppypad-verify=${claim.token}`]);
  world.addrs.set(claim.host, OURS);
};
const claim = (s, host = newHost()) => { const r = domains.add(s, host); assert.ok(r.claim, r.err); return r.claim; };
const set = (c, fields) => db.prepare(`UPDATE custom_domains SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: c.id });
// a live claim, as Check now leaves it with both records right and Caddy answering
async function live(s = site(), host = newHost()) {
  const c = claim(s, host);
  point(c);
  assert.equal((await domains.check(s)).state, 'live');
  return { s, c: domains.of(s) };
}
// past the next daily re-check
const dueRecheck = (c) => set(c, { checked_at: Date.now() - DAY });

test('tls-check approves a host only while its claim is verified or live', async () => {
  const s = site();
  const c = claim(s);
  assert.equal(domains.ask(c.host), false); // pending
  point(c);
  world.https.set(c.host, false);
  assert.equal((await domains.check(s)).state, 'verified');
  assert.equal(domains.ask(c.host), true);
  assert.equal(domains.ask(c.host.toUpperCase()), true);
  world.https.set(c.host, true);
  await domains.housekeeping(); // the hourly retry of the HTTPS request
  assert.equal(domains.of(s).state, 'live');
  assert.equal(domains.ask(c.host), true);
  for (const no of ['192.0.2.1', '2001:db8::7', BASE, `pup1.${BASE}`, `a.b.${BASE}`, 'unknown.example', '']) assert.equal(domains.ask(no), false, no);
  // the flag off: nothing is approved
  assert.equal(createDomains({ cfg: { ...cfg, CUSTOM_DOMAINS: false }, logins, sendMail, net }).ask(c.host), false);
});
