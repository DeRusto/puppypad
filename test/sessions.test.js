const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-sessions-'));
const { db } = require('../src/db');
const U = require('../src/util');
const { createLogins } = require('../src/logins');
const { createSessions } = require('../src/sessions');

const logins = createLogins({ cfg: { ADMIN_EMAILS: new Set(), QUOTA_MB: 1 }, removeSite: () => {}, dropShot: () => {} });
const sessions = createSessions({ logins });

let n = 0;
let hash;
const add = async (fields = {}) => {
  hash ??= await U.hashPw('longpassword1');
  const name = `pup${++n}`;
  const f = { username: name, email: `${name}@x.test`, pw_hash: hash, login_id: null, ...fields };
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, email, pw_hash, verified, login_id, created_at, updated_at) VALUES (@username, @email, @pw_hash, 1, @login_id, 0, 0)").run(f);
  return row({ id: lastInsertRowid });
};
const extra = (login) => add({ login_id: login.id, email: `x${n + 1}@sites.invalid`, pw_hash: '!' });
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);
const set = (site, sql, ...a) => db.prepare(`UPDATE users SET ${sql} WHERE id = ?`).run(...a, site.id);
const signIn = (site) => sessions.lookup(sessions.start(site.id));

test('a started session is found by its token until it ends or expires', async () => {
  const site = await add();
  const token = sessions.start(site.id);
  const s = sessions.lookup(token);
  assert.equal(s.user.id, site.id);
  assert.equal(s.login.id, site.id);
  assert.ok(s.csrfOk({ _csrf: s.csrf }));
  assert.ok(!s.csrfOk({ _csrf: 'nope' }));
  assert.equal(sessions.lookup('made-up'), null);
  assert.equal(sessions.lookup(''), null);
  sessions.end(s);
  assert.equal(sessions.lookup(token), null);

  const old = sessions.start(site.id);
  db.prepare('UPDATE sessions SET expires = 1 WHERE token_hash = ?').run(U.sha(old));
  assert.equal(sessions.lookup(old), null);
  sessions.sweep();
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(U.sha(old)), undefined);
});

test('current() turns false after a reset, a rename, a take-down or the session ending', async () => {
  const site = await add();
  const s = signIn(site);
  assert.equal(s.current(), true);
  set(site, 'pw_hash = ?', await U.hashPw('resetpassword1'));
  assert.equal(s.current(), false);

  const renamed = signIn(site);
  set(site, 'renamed_at = ?', Date.now());
  assert.equal(renamed.current(), false);

  const banned = signIn(site);
  set(site, 'banned = 1');
  assert.equal(banned.current(), false);
  set(site, 'banned = 0');

  const ended = signIn(site);
  sessions.endSessions(site);
  assert.equal(ended.current(), false);
});

test('an extra site\'s session answers for its login\'s password', async () => {
  const login = await add();
  const site = await extra(login);
  const s = signIn(site);
  assert.equal(s.login.id, login.id);
  assert.equal(s.current(), true);
  set(login, 'pw_hash = ?', await U.hashPw('resetpassword1'));
  assert.equal(s.current(), false);
});

test('move switches the session to another site; endSessions ends a login\'s sessions but the one kept', async () => {
  const login = await add();
  const site = await extra(login);
  const other = await add();
  const token = sessions.start(login.id);
  sessions.move(sessions.lookup(token), site.id);
  assert.equal(sessions.lookup(token).user.id, site.id);

  const keep = sessions.lookup(sessions.start(site.id));
  const gone = sessions.start(login.id);
  const stays = sessions.start(other.id);
  sessions.makeToken(login.id, 'login2fa', 1e6);
  sessions.endSessions(site, { except: keep });
  assert.equal(keep.current(), true);
  assert.equal(sessions.lookup(gone), null);
  assert.equal(sessions.lookup(token), null);
  assert.ok(sessions.lookup(stays));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tokens WHERE user_id = ? AND kind = 'login2fa'").get(login.id).n, 0);
});

test('an API key session: found by the key, and no longer current after a new key, a rename or a take-down', async () => {
  const site = await add();
  set(site, 'api_key = ?', U.sha('pp_one'));
  const s = sessions.forKey('pp_one');
  assert.equal(s.user.id, site.id);
  assert.ok(s.csrfOk({})); // the API needs no CSRF token
  assert.equal(sessions.forKey('pp_two'), null);
  assert.equal(sessions.forKey(''), null);
  assert.equal(s.current(), true);
  set(site, 'api_key = ?', U.sha('pp_two'));
  assert.equal(s.current(), false);
  const renamed = sessions.forKey('pp_two');
  set(site, 'renamed_at = ?', Date.now());
  assert.equal(renamed.current(), false);
  const banned = sessions.forKey('pp_two');
  set(site, 'banned = 1');
  assert.equal(banned.current(), false);
});

test('revokeApiKeys switches off the keys of every site of the login and no other', async () => {
  const login = await add();
  const site = await extra(login);
  const other = await add();
  for (const [s, k] of [[login, 'k1'], [site, 'k2'], [other, 'k3']]) set(s, 'api_key = ?', k + n);
  sessions.revokeApiKeys(site);
  assert.deepEqual([row(login).api_key, row(site).api_key], ['', '']);
  assert.notEqual(row(other).api_key, '');
});

test('tokens: a new one replaces the last of its kind, peeking leaves it, using spends it, and expired ones are dead', async () => {
  const site = await add();
  const first = sessions.makeToken(site.id, 'reset', 1e6);
  const t = sessions.makeToken(site.id, 'reset', 1e6);
  assert.equal(sessions.peekToken(first, 'reset'), null);
  assert.equal(sessions.peekToken(t, 'verify'), null); // another kind
  assert.equal(sessions.peekToken(t, 'reset').id, site.id);
  assert.equal(sessions.peekToken(t, 'reset').id, site.id);
  assert.equal(sessions.useToken(t, 'reset').id, site.id);
  assert.equal(sessions.useToken(t, 'reset'), null);
  assert.equal(sessions.peekToken(t, 'reset'), null);
  const dead = sessions.makeToken(site.id, 'email', -1);
  assert.equal(sessions.peekToken(dead, 'email'), null);
  assert.equal(sessions.useToken(dead, 'email'), null);
  assert.equal(sessions.useToken(undefined, 'email'), null);
});

test('useCode: an app code works once, a recovery code once, and two requests racing with one code get one success', async () => {
  const secret = U.newTotpSecret();
  const codes = ['aaaaa11111', 'bbbbb22222'];
  const site = await add();
  set(site, 'totp_secret = ?, totp_codes = ?', secret, codes.map(U.sha).join('\n'));
  const now = U.totp(secret, Math.floor(Date.now() / 30000));
  assert.equal(sessions.useCode(row(site), now), true);
  assert.equal(sessions.useCode(row(site), now), false); // replayed
  assert.equal(sessions.useCode(row(site), '000000'.replace(/./g, (c, i) => (now[i] === '0' ? '1' : '0'))), false);

  // both requests read the row before either spends the code
  const a = row(site);
  const b = row(site);
  assert.equal(sessions.useCode(a, 'AAAAA-11111'), true);
  assert.equal(sessions.useCode(b, 'aaaaa11111'), false);
  // a stale read of the codes can't spend another code either; a fresh one can
  assert.equal(sessions.useCode(b, 'bbbbb22222'), false);
  assert.equal(sessions.useCode(row(site), 'bbbbb22222'), true);
  assert.equal(sessions.useCode(row(site), 'bbbbb22222'), false);
  assert.equal(sessions.useCode(await add(), now), false); // two-factor off
});

test('confirmPassword: ok, wrong, limited per action, and signedOut when the session ended meanwhile', async () => {
  const login = await add();
  const site = await extra(login);
  const s = signIn(site);
  assert.equal(await sessions.confirmPassword(s, 'rename', 'longpassword1'), 'ok'); // the login's password, from an extra site
  assert.equal(await sessions.confirmPassword(s, 'rename', 'wrongpassword'), 'wrong');
  for (let i = 0; i < 3; i++) await sessions.confirmPassword(s, 'rename', 'wrongpassword');
  assert.equal(await sessions.confirmPassword(s, 'rename', 'longpassword1'), 'limited'); // 5 renames a quarter hour
  assert.equal(await sessions.confirmPassword(s, 'email', 'longpassword1'), 'ok'); // each action has its own limit
  sessions.endSessions(site);
  assert.equal(await sessions.confirmPassword(s, 'password', 'longpassword1'), 'signedOut');
});
