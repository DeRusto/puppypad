const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-guestbook-'));
const { db } = require('../src/db');
const { createGuestbook } = require('../src/guestbook');
const { createListing } = require('../src/listing');

const DAY = 86400000;
const sent = [];
let mailWorks = true;
const guestbook = createGuestbook({
  cfg: { BASE_URL: 'http://pad.test', BASE_HOST: 'pad.test' },
  logins: { loginOf: (site) => site },
  sendMail: async (to, subject, text) => { sent.push({ to, subject, text }); return mailWorks; },
  listing: createListing({ cfg: { NEW_SITE_HOURS: 24 } }),
});

let n = 0;
const add = (fields = {}) => {
  const name = `book${++n}`;
  const f = { username: name, email: `${name}@x.test`, gb_notify: 'off', ...fields };
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, email, pw_hash, verified, gb_notify, created_at, updated_at) VALUES (@username, @email, \'h\', 1, @gb_notify, 0, 0)').run(f);
  return row({ id: lastInsertRowid });
};
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);
const entries = (site) => db.prepare('SELECT * FROM guestbook WHERE user_id = ? ORDER BY id').all(site.id);
let ipN = 0;
const ip = () => `10.1.${(ipN >> 8) & 255}.${ipN++ & 255}`;
const sign = (site, message, more = {}) => guestbook.sign(site, { name: 'Vee', message, ip: ip(), ...more });
const to = (site) => sent.filter((m) => m.to === site.email);

test('sign: ok, missing, limited, a bot, a blocked word and a blocked address', () => {
  guestbook.settings(add(), { words: 'nothing' }); // another Site's words don't apply
  const site = add();
  assert.equal(sign(site, 'nice pad!'), 'ok');
  assert.equal(guestbook.sign(site, { name: '  ', message: 'hi', ip: ip() }), 'missing');
  assert.equal(sign(site, ''), 'missing');
  assert.equal(sign(site, 'from a bot', { bot: true }), 'ok'); // looks like success, keeps nothing
  const busy = ip();
  for (const m of ['one', 'two', 'three']) assert.equal(sign(site, m, { ip: busy }), 'ok');
  assert.equal(sign(site, 'four', { ip: busy }), 'limited');

  guestbook.settings(site, { words: 'Viagra\n\n  pills  ' });
  assert.equal(row(site).gb_words, 'Viagra\npills');
  assert.equal(sign(row(site), 'cheap VIAGRA'), 'word');
  assert.equal(guestbook.sign(row(site), { name: 'pills4u', message: 'hi', ip: ip() }), 'word'); // the name counts too

  const first = entries(site)[0];
  guestbook.blockIp(site, first.id);
  assert.deepEqual(guestbook.blocked(site), [first.ip]);
  assert.equal(sign(row(site), 'again', { ip: first.ip }), 'ok'); // looks like success
  assert.deepEqual(entries(site).map((e) => e.message), ['nice pad!', 'one', 'two', 'three']);
  guestbook.unblockIp(site, first.ip);
  assert.deepEqual(guestbook.blocked(site), []);
  assert.equal(sign(row(site), 'back', { ip: first.ip }), 'ok');
  assert.equal(entries(site).at(-1).message, 'back');
  // long fields are cut, not refused
  assert.equal(guestbook.sign(site, { name: 'n'.repeat(99), message: 'm'.repeat(999), ip: ip() }), 'ok');
  assert.deepEqual([entries(site).at(-1).name.length, entries(site).at(-1).message.length], [40, 500]);
});

test('an entry with a link is held: visitors never see it until the owner approves', () => {
  const site = add();
  assert.equal(sign(site, 'buy at http://spam.example'), 'held');
  assert.equal(sign(site, 'see www.example.com'), 'held');
  assert.equal(sign(site, 'cheap.xyz deals'), 'held');
  assert.equal(sign(site, 'no links here'), 'ok');
  assert.deepEqual(guestbook.page(site, 1).rows.map((e) => e.message), ['no links here']);
  assert.equal(guestbook.page(site, 1, { all: true }).rows.length, 4);
  const held = entries(site)[0];
  guestbook.approve(add(), held.id); // not theirs: nothing happens
  assert.equal(entries(site)[0].approved, 0);
  guestbook.approve(site, held.id);
  assert.equal(entries(site)[0].approved, 1);
  assert.equal(guestbook.page(site, 1).rows.at(-1).message, 'buy at http://spam.example');
});

test('page: 50 a page, newest first, kept within the pages there are', () => {
  const site = add();
  const put = db.prepare('INSERT INTO guestbook (user_id, name, message, approved, created_at) VALUES (?, ?, ?, ?, ?)');
  put.run(site.id, 'oldest', 'held', 0, 1);
  for (let i = 0; i < 120; i++) put.run(site.id, 'n', `entry ${i}`, 1, 2 + i);
  const first = guestbook.page(site, undefined);
  assert.deepEqual([first.page, first.pages, first.rows.length, first.rows[0].message], [1, 3, 50, 'entry 119']);
  const last = guestbook.page(site, '99');
  assert.deepEqual([last.page, last.rows.length, last.rows.at(-1).message], [3, 20, 'entry 0']);
  assert.equal(guestbook.page(site, 3, { all: true }).rows.at(-1).name, 'oldest');
  assert.deepEqual(guestbook.page(add(), 1), { rows: [], page: 1, pages: 1 });
});

test('owner tools only reach the owner\'s own entries; remove deletes one', () => {
  const site = add();
  const other = add();
  sign(site, 'hello');
  const mine = entries(site)[0];
  guestbook.blockIp(other, mine.id);
  assert.deepEqual(guestbook.blocked(other), []);
  guestbook.remove(other, mine.id);
  assert.equal(entries(site).length, 1);
  guestbook.remove(site, mine.id);
  assert.equal(entries(site).length, 0);
  guestbook.blockIp(site, mine.id); // gone: nothing to block
  assert.deepEqual(guestbook.blocked(site), []);
});

test('blocks: an address once, the newest 200 per Site', () => {
  const site = add();
  const put = db.prepare('INSERT INTO guestbook (user_id, name, message, ip, created_at) VALUES (?, \'n\', \'m\', ?, 0)');
  const ids = Array.from({ length: 202 }, (_, i) => put.run(site.id, `10.2.${i >> 8}.${i & 255}`).lastInsertRowid);
  guestbook.blockIp(site, ids[0]);
  guestbook.blockIp(site, ids[0]);
  assert.equal(guestbook.blocked(site).length, 1);
  for (const id of ids.slice(1)) guestbook.blockIp(site, id);
  const list = guestbook.blocked(site);
  assert.equal(list.length, 200);
  assert.equal(list[0], '10.2.0.2'); // the oldest two went
  assert.equal(list.at(-1), '10.2.0.201');
});

test('instant email: one per entry, held ones say so, at most 10 an hour', () => {
  const site = add({ gb_notify: 'instant' });
  sign(site, 'lovely pad');
  sign(site, 'see http://spam.example');
  assert.equal(to(site).length, 2);
  assert.match(to(site)[0].subject, new RegExp(`New guestbook entry on ${site.username}\\.pad\\.test`));
  assert.match(to(site)[1].text, /spam\.example\n\(This entry has a link, so it waits for your approval\.\)/);
  assert.match(to(site)[1].text, /http:\/\/pad\.test\/dashboard\/guestbook/);
  for (let i = 0; i < 12; i++) sign(site, `wave ${i}`);
  assert.equal(to(site).length, 10);
  assert.equal(entries(site).length, 14); // the entries all stay
  const quiet = add({ gb_notify: 'daily' });
  sign(quiet, 'digest only');
  assert.equal(to(quiet).length, 0);
});

// a day passes for the Site's digest cutoff and its entries
const dayPasses = (site) => {
  db.prepare('UPDATE users SET gb_digest_at = gb_digest_at - ? WHERE id = ?').run(DAY + 1000, site.id);
  db.prepare('UPDATE guestbook SET created_at = created_at - ? WHERE user_id = ?').run(DAY + 1000, site.id);
};

test('daily digest: once a day, only what was signed since, and only a send that worked moves the cutoff', async () => {
  const site = add({ gb_notify: 'instant' });
  sign(site, 'lovely pad');
  db.prepare('UPDATE guestbook SET created_at = created_at - 10 WHERE user_id = ?').run(site.id); // not the switch's millisecond
  guestbook.settings(site, { notify: 'daily' }); // switching restarts the digest, so nothing is mailed twice
  sign(site, 'digest one');
  sign(site, 'see http://spam.example');
  const before = to(site).length;
  await guestbook.sendDigests();
  assert.equal(to(site).length, before); // the digest waits a day after switching
  dayPasses(site);
  guestbook.settings(site, { notify: 'daily' }); // saving the same setting keeps what waits
  mailWorks = false;
  await guestbook.sendDigests();
  mailWorks = true;
  assert.equal(to(site).length, before + 1);
  await guestbook.sendDigests(); // the failed one is tried again
  assert.equal(to(site).length, before + 2);
  const digest = to(site).at(-1);
  assert.match(digest.subject, new RegExp(`2 new guestbook entries on ${site.username}\\.pad\\.test`));
  assert.match(digest.text, /^1 of them waits for your approval\./);
  assert.match(digest.text, /digest one/);
  assert.doesNotMatch(digest.text, /lovely pad/);
  await guestbook.sendDigests();
  assert.equal(to(site).length, before + 2); // once a day at most
  dayPasses(site);
  await guestbook.sendDigests();
  assert.equal(to(site).length, before + 2); // nobody signed: nothing sent

  const off = add({ gb_notify: 'off' });
  sign(off, 'quiet one');
  dayPasses(off);
  await guestbook.sendDigests();
  assert.equal(to(off).length, 0);
  guestbook.settings(off, { notify: 'bogus' });
  assert.equal(row(off).gb_notify, 'off');
});

test('switching notify counts from one millisecond back, so an entry signed in the same millisecond makes the digest', async () => {
  const site = add({ gb_notify: 'off' });
  const realNow = Date.now;
  const t = realNow();
  try {
    Date.now = () => t;
    guestbook.settings(site, { notify: 'daily' });
    sign(site, 'same millisecond');
    assert.equal(row(site).gb_digest_at, t - 1);
    Date.now = () => t + DAY + 1;
    await guestbook.sendDigests();
  } finally { Date.now = realNow; }
  assert.match(to(site).at(-1).subject, new RegExp(`^1 new guestbook entry on ${site.username}\\.pad\\.test$`));
  assert.match(to(site).at(-1).text, /same millisecond/);
});

test('sweep erases entry addresses and expires blocks after 90 days', () => {
  const site = add();
  sign(site, 'old');
  sign(site, 'new');
  const [old, fresh] = entries(site);
  guestbook.blockIp(site, old.id);
  guestbook.blockIp(site, fresh.id);
  db.prepare('UPDATE guestbook SET created_at = ? WHERE id = ?').run(Date.now() - 91 * DAY, old.id);
  db.prepare('UPDATE guestbook_blocks SET created_at = ? WHERE ip = ?').run(Date.now() - 91 * DAY, old.ip);
  guestbook.sweep();
  assert.deepEqual(entries(site).map((e) => e.ip), [null, fresh.ip]);
  assert.deepEqual(guestbook.blocked(site), [fresh.ip]);
  assert.equal(sign(row(site), 'unblocked now', { ip: old.ip }), 'ok');
  assert.equal(entries(site).at(-1).message, 'unblocked now');

  // blocking an address again starts its 90 days over
  db.prepare('UPDATE guestbook_blocks SET created_at = ? WHERE ip = ?').run(Date.now() - 89 * DAY, fresh.ip);
  guestbook.blockIp(site, fresh.id);
  db.prepare('UPDATE guestbook_blocks SET created_at = created_at - ? WHERE ip = ?').run(2 * DAY, fresh.ip);
  guestbook.sweep();
  assert.deepEqual(guestbook.blocked(site), [fresh.ip]);
});
