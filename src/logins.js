// Login: the account a member signs in with. A supporter's extra sites are their own users rows pointing at the
// login's row through login_id; email, password, two-factor login, supporter status and admin rights live on the
// login's row only. Every function here takes any site row, a login's own or an extra one, and answers for its
// login, so no caller has to remember which row a fact lives on.
const { db } = require('./db');

// cfg for the admin list and limits; removeSite(site) deletes a site's folder, screenshot and history (Site files)
function createLogins({ cfg, removeSite }) {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const idOf = (site) => site.login_id || site.id;
  const loginOf = (site) => (site.login_id ? byId.get(site.login_id) : site);
  const isLogin = (site) => !site.login_id;
  // the login and its extra sites, oldest first
  const sitesOf = (site) => db.prepare('SELECT * FROM users WHERE id = ? OR login_id = ? ORDER BY id').all(idOf(site), idOf(site));
  const isAdmin = (site) => { const login = loginOf(site); return !!login.verified && cfg.ADMIN_EMAILS.has(login.email); };
  const isSupporter = (site) => loginOf(site).supporter_until > Date.now() || isAdmin(site);

  // Each site keeps the largest QUOTA_MB it has had: raising it in .env grows every site, lowering it only affects new signups
  const quotaMB = (site) => Math.max(site.quota_mb || 0, cfg.QUOTA_MB);
  // what a site may store: free limits, or bigger ones and any file type while its login supports.
  // When support lapses nothing is deleted; uploads are refused until the site is back under the free limits
  const limitsFor = (site) => {
    const sup = isSupporter(site);
    return {
      quotaMB: sup ? Math.max(quotaMB(site), cfg.SUPPORTER_QUOTA_MB) : quotaMB(site),
      fileMB: sup ? Math.max(cfg.MAX_FILE_MB, cfg.SUPPORTER_MAX_FILE_MB) : cfg.MAX_FILE_MB,
      anyType: sup,
      historyDays: sup ? cfg.SUPPORTER_HISTORY_DAYS : cfg.HISTORY_DAYS,
    };
  };

  // every session of the login and its sites but `except`, and its logins still waiting on their second step
  function endSessions(site, { except } = {}) {
    const id = idOf(site);
    if (except) db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR login_id = ?) AND token_hash != ?').run(id, id, except);
    else db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR login_id = ?)').run(id, id);
    db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'login2fa'").run(id);
  }
  const revokeApiKeys = (site) => db.prepare("UPDATE users SET api_key = '' WHERE id = ? OR login_id = ?").run(idOf(site), idOf(site));

  // An extra site goes alone; a login takes its extra sites along. Deleted names stay unclaimable for a while
  // (released_names), except a never-confirmed account's, which was never online. inTransaction(site) commits with the rows.
  function remove(site, { inTransaction } = {}) {
    const extra = db.prepare('SELECT * FROM users WHERE login_id = ?').all(site.id);
    db.transaction(() => {
      const hold = db.prepare('INSERT OR REPLACE INTO released_names (name, released_at) VALUES (?, ?)');
      for (const s of extra) hold.run(s.username, Date.now());
      db.prepare('DELETE FROM users WHERE id = ?').run(site.id);
      if (site.verified) hold.run(site.username, Date.now());
      if (inTransaction) inTransaction(site);
    })();
    for (const s of extra) removeSite(s);
    removeSite(site);
  }

  return { loginOf, isLogin, sitesOf, isAdmin, isSupporter, limitsFor, endSessions, revokeApiKeys, remove };
}

module.exports = { createLogins };
