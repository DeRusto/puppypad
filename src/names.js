// Site names: which names are taken, and Held names. A deleted Site's name, and a name given up in a rename, stays
// unclaimable for NAME_HOLD so nobody can take over a known address; a rename's hold also redirects to the Site.
const { db } = require('./db');
const { ONLINE } = require('./listing');

const NAME_HOLD = 90 * 86400000;

// files.rename(oldName, newName) moves a Site's folder (Site files)
function createNames({ files }) {
  const holdOf = (name) => db.prepare('SELECT user_id FROM released_names WHERE name = ? AND released_at > ?').get(String(name), Date.now() - NAME_HOLD);
  // a Site has it or it is held; `by` may take back a name it gave up itself
  const taken = (name, { by } = {}) => {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(String(name))) return true;
    const held = holdOf(name);
    return !!held && !(by && held.user_id === by.id);
  };
  // with `site`, the hold redirects there and that Site may reclaim it; without, the name is just held
  const hold = (name, { site } = {}) => db.prepare('INSERT OR REPLACE INTO released_names (name, released_at, user_id) VALUES (?, ?, ?)').run(name, Date.now(), site ? site.id : null);
  // the current name of the Online Site that gave up `name` in a rename, while that name is still held
  const renamedTo = (name) => db.prepare(`SELECT u.username FROM released_names r JOIN users u ON u.id = r.user_id WHERE r.name = ? AND r.released_at > ? AND ${ONLINE}`)
    .get(String(name), Date.now() - NAME_HOLD)?.username;
  // 'taken' or 'ok'; the folder moves last, so a failed move rolls the rows back (and throws)
  function rename(site, name) {
    if (taken(name, { by: site })) return 'taken';
    try {
      db.transaction(() => {
        db.prepare('UPDATE users SET username = ?, renamed_at = ?, shot_dirty = 1 WHERE id = ?').run(name, Date.now(), site.id);
        db.prepare('DELETE FROM released_names WHERE name = ?').run(name);
        hold(site.username, { site });
        db.prepare('UPDATE reports SET site = ? WHERE site = ?').run(name, site.username);
        files.rename(site.username, name);
      })();
    } catch (err) {
      if (String(err && err.code).includes('CONSTRAINT')) return 'taken'; // a signup took it meanwhile
      throw err;
    }
    return 'ok';
  }
  const sweep = () => db.prepare('DELETE FROM released_names WHERE released_at < ?').run(Date.now() - NAME_HOLD);
  return { taken, hold, renamedTo, rename, sweep };
}

module.exports = { createNames, NAME_HOLD };
