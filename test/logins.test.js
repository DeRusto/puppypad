const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

// A database as releases before login_id left it: extra sites point at their login through owner_id.
// The rest of the users columns come from src/db.js, as they would on any older database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-logins-'));
const DB_FILE = path.join(process.env.DATA_DIR, 'puppypad.db');
const old = new Database(DB_FILE);
old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, tagline TEXT NOT NULL DEFAULT '', hits INTEGER NOT NULL DEFAULT 0,
  signup_ip TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX idx_users_owner ON users(owner_id);
  INSERT INTO users (id, username, email, pw_hash, verified, created_at, updated_at) VALUES (1, 'oldpup', 'old@x.test', 'h', 1, 0, 0);
  INSERT INTO users (id, username, email, pw_hash, verified, owner_id, created_at, updated_at) VALUES (2, 'oldpup2', 'oldpup2@sites.invalid', '!', 1, 1, 0, 0);`);
old.close();

const { db } = require('../src/db'); // starts the way the app does
const { createLogins } = require('../src/logins');
const { createNames } = require('../src/names');

const cols = () => db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
const indexes = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users'").all().map((r) => r.name);
const version = () => db.pragma('user_version', { simple: true });
const schemaCli = (...args) => execFileSync(process.execPath, [path.join(__dirname, '../src/schema.js'), ...args], { env: { ...process.env }, encoding: 'utf8' });

const removed = [];
const dropped = [];
const logins = createLogins({
  cfg: { ADMIN_EMAILS: new Set(['boss@x.test']), QUOTA_MB: 1, MAX_FILE_MB: 1, SUPPORTER_QUOTA_MB: 3, SUPPORTER_MAX_FILE_MB: 2, HISTORY_DAYS: 30, SUPPORTER_HISTORY_DAYS: 365 },
  removeSite: (site) => removed.push(site.username),
  dropShot: (site) => dropped.push(site.username),
  holdName: (name) => names.hold(name),
});
const names = createNames({ files: { rename: () => {} } });

let n = 0;
const add = (fields = {}) => {
  const name = `pup${++n}`;
  const f = { username: name, email: `${name}@x.test`, pw_hash: 'h', verified: 1, login_id: null, supporter_until: 0, ...fields };
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, email, pw_hash, verified, login_id, supporter_until, created_at, updated_at) VALUES (@username, @email, @pw_hash, @verified, @login_id, @supporter_until, 0, 0)').run(f);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
};
const extra = (login) => add({ login_id: login.id, email: `x${n + 1}@sites.invalid`, pw_hash: '!' });
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);

test('starting the new code renames owner_id to login_id on an older database, keeping its links', () => {
  assert.ok(cols().includes('login_id'));
  assert.ok(!cols().includes('owner_id'));
  assert.equal(version(), 2);
  assert.ok(indexes().includes('idx_users_login'));
  assert.ok(!indexes().includes('idx_users_owner'));
  const oldExtra = db.prepare('SELECT * FROM users WHERE id = 2').get();
  assert.equal(logins.loginOf(oldExtra).username, 'oldpup');
  assert.deepEqual(logins.sitesOf(oldExtra).map((s) => s.username), ['oldpup', 'oldpup2']);
});

test('an extra site answers with its login: login, sites, supporter, admin and limits', () => {
  const login = add({ supporter_until: Date.now() + 1e6 });
  const site = extra(login);
  assert.equal(logins.loginOf(site).id, login.id);
  assert.equal(logins.loginOf(login).id, login.id);
  assert.equal(logins.isLogin(login), true);
  assert.equal(logins.isLogin(site), false);
  assert.deepEqual(logins.sitesOf(site).map((s) => s.id), [login.id, site.id]);
  assert.equal(logins.isSupporter(site), true);
  assert.deepEqual(logins.limitsFor(site), { quotaMB: 3, fileMB: 2, anyType: true, historyDays: 365 });

  const free = add();
  assert.equal(logins.isSupporter(extra(free)), false);
  assert.deepEqual(logins.limitsFor(free), { quotaMB: 1, fileMB: 1, anyType: false, historyDays: 30 });

  const boss = add({ email: 'boss@x.test' });
  const bossSite = extra(boss);
  assert.equal(logins.isAdmin(bossSite), true); // its own email is a placeholder; the login's counts
  assert.equal(logins.isSupporter(bossSite), true); // admins get supporter limits
  assert.equal(logins.isAdmin(add({ email: 'boss2@x.test' })), false);
  db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(boss.id);
  assert.equal(logins.isAdmin(bossSite), false); // an unconfirmed address isn't proof
});

test('remove: an extra site goes alone; a login takes its sites, holds their names, and commits inTransaction with the rows', () => {
  const login = add();
  const a = extra(login);
  const b = extra(login);
  removed.length = 0;
  logins.remove(a);
  assert.equal(row(a), undefined);
  assert.ok(row(login) && row(b));
  assert.deepEqual(removed, [a.username]);

  removed.length = 0;
  const logged = [];
  logins.remove(login, { inTransaction: (s) => logged.push(s.username) });
  assert.equal(row(login), undefined);
  assert.equal(row(b), undefined);
  assert.deepEqual(removed, [b.username, login.username]);
  assert.deepEqual(logged, [login.username]);
  const held = db.prepare('SELECT name FROM released_names WHERE name IN (?, ?)').all(login.username, b.username).map((r) => r.name).sort();
  assert.deepEqual(held, [login.username, b.username].sort());

  // a failing log entry rolls the rows back and deletes no files
  const c = add();
  removed.length = 0;
  assert.throws(() => logins.remove(c, { inTransaction: () => { throw new Error('log failed'); } }));
  assert.ok(row(c));
  assert.deepEqual(removed, []);

  // a never-confirmed account's name is free again at once
  const unconfirmed = add({ verified: 0 });
  logins.remove(unconfirmed);
  assert.equal(db.prepare('SELECT 1 FROM released_names WHERE name = ?').get(unconfirmed.username), undefined);

  // hold: false, the rollback of a Site whose making failed, holds no name, its extra sites' neither
  const rolled = add();
  const rolledExtra = extra(rolled);
  logins.remove(rolled, { hold: false });
  assert.equal(names.taken(rolled.username), false);
  assert.equal(names.taken(rolledExtra.username), false);
});

const report = (site) => db.prepare("INSERT INTO reports (site, reason, details, created_at) VALUES (?, 'Spam', 'x', 0)").run(site.username).lastInsertRowid;
const reportStatus = (id) => db.prepare('SELECT status FROM reports WHERE id = ?').get(id).status;
const banned = (...sites) => sites.map((s) => row(s).banned);

test('takeDown: a login takes its Online extra sites down with it, closes their reports and drops their shots after commit', () => {
  const login = add();
  const a = extra(login);
  const b = extra(login);
  const r = report(a);
  dropped.length = 0;
  const seen = [];
  logins.takeDown(login, 'spam', { inTransaction: (sites) => seen.push(...sites.map((s) => s.username)) });
  assert.deepEqual(banned(login, a, b), [1, 2, 2]);
  assert.equal(row(login).ban_reason, 'spam');
  assert.equal(reportStatus(r), 'closed');
  assert.deepEqual(seen.sort(), [login.username, a.username, b.username].sort());
  assert.deepEqual(dropped.sort(), seen);

  // a failing inTransaction leaves everything up and drops no shot
  const c = add();
  dropped.length = 0;
  assert.throws(() => logins.takeDown(c, 'x', { inTransaction: () => { throw new Error('log failed'); } }));
  assert.deepEqual(banned(c), [0]);
  assert.deepEqual(dropped, []);
});

test('restore: a login brings back the extra sites that went down with it, and leaves one taken down on its own', () => {
  const login = add();
  const alone = extra(login);
  const along = extra(login);
  logins.takeDown(alone, 'phishing');
  logins.takeDown(login, 'spam');
  assert.deepEqual(banned(login, alone, along), [1, 1, 2]);
  db.prepare('UPDATE users SET shot_dirty = 0 WHERE id IN (?, ?)').run(login.id, along.id);
  const seen = [];
  assert.equal(logins.restore(login, { inTransaction: (sites) => seen.push(...sites.map((s) => s.username)) }), 'ok');
  assert.deepEqual(banned(login, alone, along), [0, 1, 0]);
  assert.equal(row(alone).ban_reason, 'phishing');
  assert.deepEqual([row(login).shot_dirty, row(along).shot_dirty], [1, 1]);
  assert.deepEqual(seen.sort(), [login.username, along.username].sort());
});

test('restore refuses an extra site on its own while its login is taken down, changing nothing', () => {
  const login = add();
  const site = extra(login);
  logins.takeDown(login, 'spam');
  let called = false;
  assert.equal(logins.restore(site, { inTransaction: () => { called = true; } }), 'login-down');
  assert.deepEqual(banned(login, site), [1, 2]);
  assert.equal(called, false);
  logins.restore(login);
  logins.takeDown(site, 'phishing');
  assert.equal(logins.restore(site), 'ok'); // with the login up, it comes back alone
  assert.deepEqual(banned(login, site), [0, 0]);
});

test('schema down 0 puts owner_id back for an older release, does nothing twice, and the new code re-applies it', () => {
  const login = add();
  const site = extra(login);
  assert.match(schemaCli('down', '0'), /database schema 2 -> 0/);
  assert.ok(cols().includes('owner_id'));
  assert.ok(!cols().includes('login_id'));
  assert.equal(version(), 0);
  assert.ok(indexes().includes('idx_users_owner'));
  // what an older release asks still finds every extra site, the ones made before and after the upgrade
  const ownedBy = (id) => db.prepare('SELECT username FROM users WHERE owner_id = ? ORDER BY id').all(id).map((r) => r.username);
  assert.deepEqual(ownedBy(1), ['oldpup2']);
  assert.deepEqual(ownedBy(login.id), [site.username]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n > 2, true);

  assert.match(schemaCli('down', '0'), /database schema already 0/);
  assert.ok(cols().includes('owner_id'));

  // the newer app starting again (its src/db.js) moves the database forward
  execFileSync(process.execPath, ['-e', "require('./src/db')"], { cwd: path.join(__dirname, '..'), env: { ...process.env } });
  assert.ok(cols().includes('login_id'));
  assert.equal(version(), 2);
  assert.deepEqual(logins.sitesOf(site).map((s) => s.id), [login.id, site.id]);
});

test('schema.js refuses anything but down <n> and version', () => {
  assert.throws(() => schemaCli('down'), /usage/);
  assert.throws(() => schemaCli('up', '1'), /usage/);
  assert.equal(schemaCli('version').trim(), '2');
});
