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

const cols = () => db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
const indexes = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users'").all().map((r) => r.name);
const version = () => db.pragma('user_version', { simple: true });
const schemaCli = (...args) => execFileSync(process.execPath, [path.join(__dirname, '../src/schema.js'), ...args], { env: { ...process.env }, encoding: 'utf8' });

const removed = [];
const logins = createLogins({
  cfg: { ADMIN_EMAILS: new Set(['boss@x.test']), QUOTA_MB: 1, MAX_FILE_MB: 1, SUPPORTER_QUOTA_MB: 3, SUPPORTER_MAX_FILE_MB: 2, HISTORY_DAYS: 30, SUPPORTER_HISTORY_DAYS: 365 },
  removeSite: (site) => removed.push(site.username),
});

let n = 0;
const add = (fields = {}) => {
  const name = `pup${++n}`;
  const f = { username: name, email: `${name}@x.test`, pw_hash: 'h', verified: 1, login_id: null, supporter_until: 0, ...fields };
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, email, pw_hash, verified, login_id, supporter_until, created_at, updated_at) VALUES (@username, @email, @pw_hash, @verified, @login_id, @supporter_until, 0, 0)').run(f);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
};
const extra = (login) => add({ login_id: login.id, email: `x${n + 1}@sites.invalid`, pw_hash: '!' });
const session = (site) => { const t = `s${Math.random()}`; db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires) VALUES (?, ?, ?, ?)').run(t, site.id, 'c', Date.now() + 1e6); return t; };
const pending = (site) => db.prepare("INSERT INTO tokens (token_hash, user_id, kind, expires) VALUES (?, ?, 'login2fa', ?)").run(`t${Math.random()}`, site.id, Date.now() + 1e6);
const sessionsOf = (...sites) => sites.map((s) => db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(s.id).n);
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);

test('starting the new code renames owner_id to login_id on an older database, keeping its links', () => {
  assert.ok(cols().includes('login_id'));
  assert.ok(!cols().includes('owner_id'));
  assert.equal(version(), 1);
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

test('endSessions ends every session of the login and its pending two-factor logins, except the one kept', () => {
  const login = add();
  const site = extra(login);
  const other = add();
  const keep = session(site);
  session(login);
  session(other);
  pending(login);
  logins.endSessions(site, { except: keep });
  assert.deepEqual(sessionsOf(login, site, other), [0, 1, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tokens WHERE user_id = ? AND kind = 'login2fa'").get(login.id).n, 0);
  logins.endSessions(login);
  assert.deepEqual(sessionsOf(login, site, other), [0, 0, 1]);
});

test('revokeApiKeys switches off the keys of every site of the login and no other', () => {
  const login = add();
  const site = extra(login);
  const other = add();
  for (const [s, k] of [[login, 'k1'], [site, 'k2'], [other, 'k3']]) db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(k + n, s.id);
  logins.revokeApiKeys(site);
  assert.deepEqual([row(login).api_key, row(site).api_key], ['', '']);
  assert.notEqual(row(other).api_key, '');
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
});

test('schema down 0 puts owner_id back for an older release, does nothing twice, and the new code re-applies it', () => {
  const login = add();
  const site = extra(login);
  assert.match(schemaCli('down', '0'), /database schema 1 -> 0/);
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
  assert.equal(version(), 1);
  assert.deepEqual(logins.sitesOf(site).map((s) => s.id), [login.id, site.id]);
});

test('schema.js refuses anything but down <n> and version', () => {
  assert.throws(() => schemaCli('down'), /usage/);
  assert.throws(() => schemaCli('up', '1'), /usage/);
  assert.equal(schemaCli('version').trim(), '1');
});
