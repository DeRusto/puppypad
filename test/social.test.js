const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-social-'));
const { db } = require('../src/db');
const { createLogins } = require('../src/logins');
const { createListing } = require('../src/listing');
const { createSocial } = require('../src/social');

const cfg = { SITE_NAME: 'Pad', BASE_URL: 'http://pad.test', NEW_SITE_HOURS: 24, ADMIN_EMAILS: new Set() };
const mail = [];
const logins = createLogins({ cfg, removeSite: () => {}, dropShot: () => {}, holdName: () => {} });
const social = createSocial({ cfg, logins, listing: createListing({ cfg }), sendMail: async (...a) => { mail.push(a); return true; } });

let n = 0;
const add = (fields = {}) => {
  const name = `pup${++n}`;
  const f = { username: name, email: `${name}@x.test`, banned: 0, hidden: 0, note_mail: '', ...fields };
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, email, pw_hash, verified, banned, hidden, note_mail, created_at, updated_at) VALUES (@username, @email, 'x', 1, @banned, @hidden, @note_mail, 0, 0)").run(f);
  return row({ id: lastInsertRowid });
};
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);
const update = (site, at = Date.now()) => db.prepare("INSERT INTO events (user_id, kind, files, created_at) VALUES (?, 'update', 'index.html', ?)").run(site.id, at).lastInsertRowid;
const on = (site, event) => social.target(event ? { event } : { site: site.username });
const bodies = (viewer, target) => social.comments(viewer, target, 1).rows.map((c) => c.body);
const followers = (site) => social.follows(site, 'followers', 1).rows.map((r) => r.username);
let ipN = 0;
const ip = () => `10.1.0.${ipN++}`;

test('target finds an Online Site or an Update of one, and nothing else', () => {
  const a = add();
  const ev = update(a);
  assert.equal(on(a).owner.id, a.id);
  assert.equal(on(a, ev).ev.id, ev);
  assert.equal(social.target({ site: 'nobody-here' }), null);
  assert.equal(social.target({ event: 99999 }), null);
  const down = add({ banned: 1 });
  assert.equal(on(down), null);
  assert.equal(on(down, update(down)), null);
});

test('follow, comment and like are refused as gone when the target is not Online or the actor is taken down', () => {
  const a = add();
  const me = add();
  const ev = update(a);
  assert.equal(social.follow(me, a), 'ok');
  assert.equal(social.follow(me, me), 'gone');
  const banned = add({ banned: 1 });
  assert.equal(social.follow(banned, a), 'gone');
  assert.equal(social.comment(banned, on(a), 'hi', { ip: ip() }), 'gone');
  assert.equal(social.like(banned, on(a, ev)), 'gone');
  assert.equal(social.comment(me, null, 'hi', { ip: ip() }), 'gone');
});

test('a Block applies both ways: neither member can follow, comment on or like the other, and a blocked comment looks sent', () => {
  const a = add();
  const b = add();
  const evA = update(a);
  const evB = update(b);
  assert.equal(social.block(a, b), 'ok');
  for (const [me, them, ev] of [[b, a, evA], [a, b, evB]]) {
    assert.equal(social.follow(me, them), 'ok');
    assert.equal(social.comment(me, on(them), 'sneaky', { ip: ip() }), 'ok'); // looks like it went through
    assert.equal(social.comment(me, on(them, ev), 'sneaky', { ip: ip() }), 'ok');
    assert.equal(social.like(me, on(them, ev)), 'ok');
  }
  social.unblock(a, b);
  // nothing was kept while the Block stood, so nothing shows once it is gone
  assert.deepEqual([followers(a), followers(b)], [[], []]);
  assert.deepEqual([bodies(null, on(a)), bodies(null, on(b))], [[], []]);
  assert.deepEqual(social.details([{ id: evA }, { id: evB }], null).map((e) => [e.commentCount, e.likes]), [[0, 0], [0, 0]]);
  // and after it, both ways work again
  social.comment(b, on(a), 'hello again', { ip: ip() });
  assert.deepEqual(bodies(null, on(a)), ['hello again']);
});

test('a Block ends the follows between the two', () => {
  const a = add();
  const b = add();
  social.follow(a, b);
  social.follow(b, a);
  assert.deepEqual([followers(a), followers(b)], [[b.username], [a.username]]);
  social.block(b, a);
  assert.deepEqual([followers(a), followers(b)], [[], []]);
  assert.equal(social.isFollowing(a, b), false);
  assert.equal(social.blocking(b, a), true);
  assert.equal(social.blocking(a, b), false);
});

test('notifications come from the follows, comments and likes themselves: a deleted comment or a Block takes them away', () => {
  const me = add();
  const fan = add();
  const pest = add();
  const ev = update(me);
  social.follow(fan, me);
  social.comment(fan, on(me, ev), 'nice update', { ip: ip() });
  social.like(fan, on(me, ev));
  social.comment(pest, on(me), 'buy stuff', { ip: ip() });
  social.comment(me, on(me), 'my own note', { ip: ip() }); // not news to me
  const kinds = () => social.notifications(me, 1).rows.map((r) => `${r.kind}:${r.username}`).sort();
  assert.deepEqual(kinds(), [`comment:${fan.username}`, `comment:${pest.username}`, `follow:${fan.username}`, `like:${fan.username}`].sort());
  const pestComment = social.comments(null, on(me), 1).rows.find((c) => c.body === 'buy stuff');
  social.deleteComment(fan, pestComment.id); // only the member whose space it is may
  assert.equal(kinds().length, 4);
  social.deleteComment(me, pestComment.id);
  assert.equal(kinds().length, 3);
  // a Block hides notifications either way: here the one who commented blocks me afterwards
  const rude = add();
  social.comment(rude, on(me), 'bye', { ip: ip() });
  assert.equal(kinds().length, 4);
  social.block(rude, me);
  assert.equal(kinds().length, 3);
  social.block(me, fan);
  assert.deepEqual(kinds(), []);
});

test('unread counts what came since notifications were last seen', () => {
  const me = add();
  social.follow(add(), me);
  social.follow(add(), me);
  assert.equal(social.unread(row(me)), 2);
  social.seen(me);
  assert.equal(social.unread(row(me)), 0);
  db.prepare('UPDATE follows SET created_at = ? WHERE followed_id = ?').run(Date.now() + 1000, me.id); // something newer
  assert.equal(social.unread(row(me)), 2);
});

test('the follow feed shows Updates of followed Sites that are Online and not hidden', () => {
  const me = add();
  const shown = add();
  const shy = add({ hidden: 1 });
  const down = add();
  for (const s of [shown, shy, down]) { social.follow(me, s); update(s); }
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(down.id);
  update(add()); // not followed
  const { events, count } = social.feed(me);
  assert.deepEqual(events.map((e) => e.username), [shown.username]);
  assert.equal(count, 3);
});

test('digestFor lists Updates of followed, unhidden Sites inside its window, newest first', () => {
  const me = add();
  const a = add();
  const shy = add({ hidden: 1 });
  social.follow(me, a);
  social.follow(me, shy);
  const t = Date.now();
  update(a, t - 3000);
  const inside = update(a, t - 2000);
  const edge = update(a, t - 1000);
  update(a, t + 1000);
  update(shy, t - 1500);
  db.prepare("INSERT INTO events (user_id, kind, created_at) VALUES (?, 'join', ?)").run(a.id, t - 1500);
  assert.deepEqual(social.digestFor(me, t - 3000, t - 1000).map((e) => e.id), [edge, inside]); // after since, up to until
});

test('comments and likes send the owner\'s chosen emails, and each action has its rate limit', () => {
  const owner = add({ note_mail: 'comment like' });
  const me = add();
  const ev = update(owner);
  mail.length = 0;
  social.follow(me, owner); // follow mail is off for this owner
  social.like(me, on(owner, ev));
  social.comment(me, on(owner), 'hi there', { ip: 'same-ip' });
  assert.deepEqual(mail.map((m) => m[1]), [`${me.username} liked your update on Pad`, `${me.username} commented on your site on Pad`]);
  assert.match(mail[1][2], /hi there/);
  social.comment(me, on(owner), 'two', { ip: 'same-ip' });
  social.comment(me, on(owner), 'three', { ip: 'same-ip' });
  assert.equal(social.comment(me, on(owner), 'four', { ip: 'same-ip' }), 'limited'); // 3 per address in ten minutes
});
