// Login: what a member signs in with. A supporter's extra sites are their own users rows pointing at the
// login's row through login_id; email, password, two-factor login, supporter status and admin rights live on the
// login's row only. Every function here takes any site row, a login's own or an extra one, and answers for its
// login, so no caller has to remember which row a fact lives on.
const { db } = require('./db');

// Taken down (users.banned): UP is not taken down, ALONE was taken down on its own, WITH_LOGIN only along with its login
const UP = 0;
const ALONE = 1;
const WITH_LOGIN = 2;

// cfg for the admin list and limits; removeSite(site) deletes a site's folder, screenshot and history (Site files);
// dropShot(site) deletes its screenshot; holdName(name) holds a deleted Site's name (src/names.js)
function createLogins({ cfg, removeSite, dropShot, holdName }) {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const idOf = (site) => site.login_id || site.id;
  const loginOf = (site) => (site.login_id ? byId.get(site.login_id) : site);
  const isLogin = (site) => !site.login_id;
  // the login and its extra sites, oldest first
  const sitesOf = (site) => db.prepare('SELECT * FROM users WHERE id = ? OR login_id = ? ORDER BY id').all(idOf(site), idOf(site));
  const isAdmin = (site) => { const login = loginOf(site); return !!login.verified && cfg.ADMIN_EMAILS.has(login.email); };
  // support lasts until the later of paid time (supporter_until, from Stripe) and granted time (from an admin); takes a login row
  const supporterUntil = (login) => Math.max(login.supporter_until, login.supporter_granted_until);
  const supporterUntilSql = (t = '') => `MAX(${t}supporter_until, ${t}supporter_granted_until)`; // the same, for a query; t is a table alias like 'o.'
  const isSupporter = (site) => supporterUntil(loginOf(site)) > Date.now() || isAdmin(site);

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

  // An extra site goes alone; a login takes its extra sites along. Deleted names are held (src/names.js), except a
  // never-confirmed Site's, which was never online, and with hold: false, the rollback of a Site whose making
  // failed, whose name was never served. inTransaction(site) commits with the rows.
  function remove(site, { inTransaction, hold = true } = {}) {
    const extra = db.prepare('SELECT * FROM users WHERE login_id = ?').all(site.id);
    db.transaction(() => {
      if (hold) for (const s of extra) holdName(s.username);
      db.prepare('DELETE FROM users WHERE id = ?').run(site.id);
      if (hold && site.verified) holdName(site.username);
      if (inTransaction) inTransaction(site);
    })();
    for (const s of extra) removeSite(s);
    removeSite(site);
  }

  // A login's take-down covers its Online extra sites (as WITH_LOGIN); an extra site's covers only itself.
  // inTransaction(sites) commits with the rows; the shots go after.
  function takeDown(site, reason, { inTransaction } = {}) {
    const sites = isLogin(site) ? sitesOf(site).filter((s) => s.id === site.id || s.banned === UP) : [site];
    db.transaction(() => {
      for (const s of sites) {
        db.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?').run(s.id === site.id ? ALONE : WITH_LOGIN, reason, s.id);
        db.prepare("UPDATE reports SET status = 'closed' WHERE site = ?").run(s.username);
      }
      if (inTransaction) inTransaction(sites);
    })();
    for (const s of sites) dropShot(s);
  }
  // Brings back the site, and for a login the extra sites marked WITH_LOGIN, never one taken down on its own (ALONE).
  // 'login-down', changing nothing, for an extra site whose login is taken down: no Online Site under a taken-down login
  function restore(site, { inTransaction } = {}) {
    if (!isLogin(site) && loginOf(site).banned) return 'login-down';
    const sites = isLogin(site) ? sitesOf(site).filter((s) => s.id === site.id || s.banned === WITH_LOGIN) : [site];
    db.transaction(() => {
      for (const s of sites) db.prepare('UPDATE users SET banned = ?, ban_reason = NULL, shot_dirty = 1 WHERE id = ?').run(UP, s.id);
      if (inTransaction) inTransaction(sites);
    })();
    return 'ok';
  }

  return { loginOf, isLogin, sitesOf, isAdmin, supporterUntil, supporterUntilSql, isSupporter, limitsFor, remove, takeDown, restore };
}

module.exports = { createLogins };
