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
// the Site's row as it is now
const fresh = (s) => db.prepare('SELECT * FROM users WHERE id = ?').get(s.id);
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

test('a pending claim says which record is missing until both are right', async () => {
  const s = site();
  const c = claim(s);
  assert.equal((await domains.check(s)).last_error, 'TXT record not found');
  world.txt.set(`_puppypad.${c.host}`, [`puppypad-verify=${c.token}`]);
  world.addrs.set(c.host, ['198.51.100.20', OURS[0]]);
  const after = await domains.check(s);
  assert.equal(after.state, 'pending');
  assert.equal(after.txt_ok, 1);
  assert.match(after.last_error, /points at 198\.51\.100\.20$/);
  world.addrs.set(c.host, OURS);
  assert.equal((await domains.housekeeping(), domains.of(s).state), 'live'); // the hourly run checks pending claims too
});

test('three missed daily checks make a live claim failing, with an email at the first and the third; one pass makes it live', async () => {
  const { s, c } = await live();
  const sent = mail.length;
  world.addrs.set(c.host, ['198.51.100.20']);
  for (let i = 1; i <= 3; i++) {
    dueRecheck(c);
    await domains.housekeeping();
    assert.equal(domains.of(s).misses, i);
    assert.equal(domains.of(s).state, i < 3 ? 'live' : 'failing');
    assert.equal(domains.ask(c.host), i < 3);
  }
  assert.match(domains.of(s).last_error, /points at 198\.51\.100\.20/);
  const mails = mail.slice(sent).filter((m) => m.to === s.email);
  assert.equal(mails.length, 2);
  assert.match(mails[0].text, /still live/);
  assert.match(mails[1].subject, /stopped working/);
  // checked today already: the next hourly run leaves it alone
  await domains.housekeeping();
  assert.equal(domains.of(s).misses, 3);
  world.addrs.set(c.host, OURS);
  assert.equal((await domains.check(s)).state, 'live');
  assert.equal(domains.of(s).misses, 0);
});

test('a pending claim not live after 7 days expires; a failing one ends after 30 days', async () => {
  const s = site();
  const c = claim(s);
  set(c, { created_at: Date.now() - 8 * DAY });
  await domains.housekeeping();
  assert.equal(domains.of(s).state, 'ended');
  assert.equal(domains.of(s).end_reason, 'expired');
  assert.equal(domains.ask(c.host), false);
  // an ended row reserves nothing, and adding again replaces it with a new token
  const again = claim(s, c.host);
  assert.notEqual(again.token, c.token);

  const f = await live();
  set(f.c, { state: 'failing', misses: 3, failing_since: Date.now() - 31 * DAY, checked_at: Date.now() });
  await domains.housekeeping();
  assert.equal(domains.of(f.s).end_reason, 'abandoned');
  assert.match(mail.at(-1).subject, /was removed/);
});

test('a pending claim that proves a failing host takes it over; the old member hears their site moved', async () => {
  const old = await live();
  set(old.c, { state: 'failing', misses: 3, failing_since: Date.now() });
  const s = site();
  const c = claim(s, old.c.host);
  world.txt.set(`_puppypad.${c.host}`, [`puppypad-verify=${c.token}`]);
  assert.equal((await domains.check(s)).state, 'live');
  assert.equal(domains.of(old.s).state, 'ended');
  assert.equal(domains.of(old.s).end_reason, 'moved');
  assert.ok(mail.some((m) => m.to === old.s.email && /another site/i.test(m.text) && m.text.includes(`${old.s.username}.${BASE}`)));
  // nobody can add a host that is live on another site
  assert.match(domains.add(site(), c.host).err, /Another site/);
});

test('of two pending claims on one host, the first to verify wins', async () => {
  const host = newHost();
  const a = site();
  const b = site();
  const ca = claim(a, host);
  const cb = claim(b, host);
  point(ca);
  point(cb);
  assert.equal((await domains.check(b)).state, 'live');
  await domains.housekeeping();
  assert.equal(domains.of(a).state, 'pending');
  assert.match(domains.of(a).last_error, /another site/);
});

test('when every HTTPS check of a run fails, none counts: no member email, one to the abuse address', async () => {
  const all = [await live(), await live(), await live()];
  const sent = mail.length;
  for (const { c } of all) { world.https.set(c.host, false); dueRecheck(c); }
  await domains.housekeeping();
  for (const { s } of all) assert.equal(domains.of(s).misses, 0);
  assert.deepEqual(mail.slice(sent).map((m) => m.to), [cfg.ABUSE_EMAIL]);
  // one failing on its own is that member's miss
  for (const { c } of all) world.https.set(c.host, true);
  world.https.set(all[0].c.host, false);
  for (const { c } of all) dueRecheck(c);
  await domains.housekeeping();
  assert.equal(domains.of(all[0].s).misses, 1);
  assert.match(domains.of(all[0].s).last_error, /CAA/);
  assert.equal(domains.of(all[1].s).misses, 0);
  world.https.set(all[0].c.host, true);
});

test('liveHost gives the custom host only while the claim is live', async () => {
  const { s, c } = await live();
  assert.equal(domains.liveHost(s.username), c.host);
  set(c, { state: 'failing' });
  assert.equal(domains.liveHost(s.username), undefined);
  set(c, { state: 'live' });
  assert.equal(createDomains({ cfg: { ...cfg, CUSTOM_DOMAINS: false }, logins, sendMail, net }).liveHost(s.username), undefined);
});

test('removing a domain frees it at once; a moderator detach ends it with the reason and an email', async () => {
  const { s, c } = await live();
  assert.equal(domains.remove(s), true);
  assert.equal(domains.of(s), undefined);
  assert.ok(domains.add(site(), c.host).claim);
  const m = await live();
  assert.equal(domains.detach(m.s, 'phishing').host, m.c.host);
  assert.equal(domains.of(m.s).end_reason, 'moderator');
  assert.equal(domains.of(m.s).last_error, 'phishing');
  assert.ok(mail.at(-1).text.includes('phishing'));
  assert.equal(domains.detach(m.s, 'again'), null);
});

test('a lapsed supporter keeps their domains for 30 days, adds none, and loses them at the end', async () => {
  const login = site();
  const extra = site({ login_id: login.id });
  const { c } = await live(extra);
  const sent = mail.length;
  const until = Date.now() - DAY;
  db.prepare('UPDATE users SET supporter_until = ? WHERE id = ?').run(until, login.id);
  await domains.housekeeping();
  assert.equal(domains.of(extra).state, 'live');
  assert.equal(domains.ask(c.host), true);
  assert.equal(domains.graceEnd(extra), until + 30 * DAY);
  assert.match(domains.add(fresh(login), newHost()).err, /supporters/);
  await domains.housekeeping(); // the lapse email goes once
  const mails = () => mail.slice(sent).filter((m) => m.to === login.email);
  assert.equal(mails().length, 1);
  assert.match(mails()[0].subject, /keeps working until/);
  // 7 days before the end
  db.prepare('UPDATE users SET supporter_until = ? WHERE id = ?').run(Date.now() - 24 * DAY, login.id);
  await domains.housekeeping();
  await domains.housekeeping();
  assert.match(mails().at(-1).subject, /in a week/);
  assert.equal(mails().length, 2); // once
  // day 30
  db.prepare('UPDATE users SET supporter_until = ? WHERE id = ?').run(Date.now() - 30 * DAY - 1000, login.id);
  await domains.housekeeping();
  assert.equal(domains.of(extra).end_reason, 'lapsed');
  assert.match(mails().at(-1).subject, /was removed/);
});

test('support back within the grace changes nothing', async () => {
  const { s, c } = await live();
  db.prepare('UPDATE users SET supporter_until = ? WHERE id = ?').run(Date.now() - 10 * DAY, s.id);
  await domains.housekeeping();
  assert.ok(domains.graceEnd(fresh(s)) > Date.now());
  db.prepare('UPDATE users SET supporter_until = ? WHERE id = ?').run(Date.now() + 30 * DAY, s.id);
  await domains.housekeeping();
  assert.equal(domains.graceEnd(fresh(s)), 0);
  assert.equal(domains.of(s).state, 'live');
  assert.equal(domains.of(s).mailed, '');
  assert.equal(domains.liveHost(s.username), c.host);
});

test('while the flag is off, claims sleep: no checks, and their clocks stand still', async () => {
  const s = site();
  const c = claim(s);
  point(c);
  const off = createDomains({ cfg: { ...cfg, CUSTOM_DOMAINS: false }, logins, sendMail, net });
  const t = Date.now();
  await off.housekeeping(t);
  await off.housekeeping(t + 5 * DAY);
  assert.equal(off.of(s).state, 'pending');
  assert.equal(off.of(s).created_at, c.created_at + 5 * DAY);
  assert.equal(off.add(site(), newHost()).err, 'Custom domains are for supporters.');
});
