// Session: a signed-in visit, by the session cookie or by an API key, and the one rule for whether it is still good.
// Password hashing and Stripe calls yield to other requests, and a body can take long to arrive, so by the time a
// request acts, a reset, a rename, a take-down or a new key may have happened. A route asks current() before it acts.
// Also the one-time tokens (signup, reset, email change, the second login step) and two-factor codes.
// Never touches Express: start() returns the cookie's value and server.js sets it.
const { db } = require('./db');
const U = require('./util');

const { DAY, lines } = U;
const SESSION_TTL = 30 * DAY;
// the per-action limits on confirming a password: [key, tries, window, counted per login or per site]
const LIMITS = {
  password: ['pwchange', 10, 900000, 'login'],
  email: ['emailchange', 5, 3600000, 'login'],
  '2fa': ['2fa', 10, 900000, 'login'],
  apikey: ['apikey', 5, 900000, 'site'],
  rename: ['rename', 5, 900000, 'site'],
  delete: ['delacct', 5, 900000, 'site'],
};

function createSessions({ logins }) {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const sessionRow = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');

  function start(userId) {
    const t = U.newToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires) VALUES (?,?,?,?)').run(U.sha(t), userId, U.newToken(), Date.now() + SESSION_TTL);
    return t;
  }
  // the Session of a session cookie's value, a snapshot of the Site and its Login as they were when the request came in; null when none
  function lookup(cookie) {
    const s = cookie ? sessionRow.get(U.sha(String(cookie))) : null;
    const user = s && s.expires > Date.now() && byId.get(s.user_id);
    if (!user) return null;
    const login = logins.loginOf(user);
    return {
      user, login, csrf: s.csrf, hash: s.token_hash,
      csrfOk: (body) => !!body && body._csrf === s.csrf,
      // the same password, name and session row, and not taken down (renamed_at changes with every rename);
      // takenDown: true for the member's own account steps (password, email, two-factor, deletion, billing), which a
      // taken-down member may still take
      current({ takenDown = false } = {}) {
        const cur = byId.get(user.id);
        return !!cur && (takenDown || !cur.banned) && cur.renamed_at === user.renamed_at && logins.loginOf(cur).pw_hash === login.pw_hash && !!sessionRow.get(s.token_hash);
      },
    };
  }
  // the Session of an API key; it carries no CSRF token, since the key comes in a header no other site can send
  function forKey(key) {
    const user = key ? db.prepare("SELECT * FROM users WHERE api_key = ? AND api_key != ''").get(U.sha(String(key))) : null;
    if (!user) return null;
    return {
      user, login: logins.loginOf(user), csrf: '',
      csrfOk: () => true,
      current() {
        const cur = byId.get(user.id);
        return !!cur && cur.api_key === user.api_key && !cur.banned && cur.renamed_at === user.renamed_at;
      },
    };
  }
  const end = (session) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.hash);
  // the session goes on as another site of the same login
  const move = (session, siteId) => db.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(siteId, session.hash);
  // every session of the login and its sites but `except` (a Session), and its logins still waiting on their second step
  function endSessions(site, { except } = {}) {
    const id = logins.loginOf(site).id;
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR login_id = ?) AND token_hash != ?').run(id, id, except ? except.hash : '');
    db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'login2fa'").run(id);
  }
  const revokeApiKeys = (site) => { const id = logins.loginOf(site).id; db.prepare("UPDATE users SET api_key = '' WHERE id = ? OR login_id = ?").run(id, id); };

  // 'ok', 'wrong', 'limited', or 'signedOut' when the Session stopped being current while the password was checked.
  // A take-down alone doesn't stop it: the actions that edit the Site (rename, a new API key) refuse taken-down Sites first
  async function confirmPassword(session, action, password) {
    const [key, max, windowMs, per] = LIMITS[action];
    if (!U.limit(`${key}:${(per === 'login' ? session.login : session.user).id}`, max, windowMs)) return 'limited';
    if (!(await U.checkPw(String(password || ''), session.login.pw_hash))) return 'wrong';
    return session.current({ takenDown: true }) ? 'ok' : 'signedOut';
  }

  // a new token replaces the site's last one of its kind
  function makeToken(userId, kind, ttl) {
    const t = U.newToken();
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
    db.prepare('INSERT INTO tokens (token_hash, user_id, kind, expires) VALUES (?,?,?,?)').run(U.sha(t), userId, kind, Date.now() + ttl);
    return t;
  }
  const tokenRow = (t, kind) => {
    const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(U.sha(String(t || '')), kind);
    return row && row.expires >= Date.now() ? row : null;
  };
  // whose token this is, without spending it, so a costly step can be skipped for links that would fail anyway
  const peekToken = (t, kind) => { const row = tokenRow(t, kind); return (row && byId.get(row.user_id)) || null; };
  // spends the token: its site, once
  function useToken(t, kind) {
    const row = tokenRow(t, kind);
    if (!row || !db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(row.token_hash).changes) return null;
    return byId.get(row.user_id) || null;
  }

  // a code from the member's app, used at most once (its step must be newer than the last one used), or one of their recovery codes
  function useCode(user, raw) {
    if (!user || !user.totp_secret) return false;
    const code = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^\d{6}$/.test(code)) {
      const step = U.totpStep(user.totp_secret, code);
      return !!step && db.prepare('UPDATE users SET totp_step = ? WHERE id = ? AND totp_step < ?').run(step, user.id, step).changes === 1;
    }
    const codes = lines(user.totp_codes);
    const left = codes.filter((h) => h !== U.sha(code));
    // only against the codes as read: a racing request that spent one first makes this update miss
    return code.length === 10 && left.length < codes.length &&
      db.prepare('UPDATE users SET totp_codes = ? WHERE id = ? AND totp_codes = ?').run(left.join('\n'), user.id, user.totp_codes).changes === 1;
  }

  const sweep = () => {
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('DELETE FROM tokens WHERE expires < ?').run(Date.now());
  };

  return { start, lookup, forKey, end, move, endSessions, revokeApiKeys, confirmPassword, makeToken, peekToken, useToken, useCode, sweep, SESSION_TTL };
}

module.exports = { createSessions };
