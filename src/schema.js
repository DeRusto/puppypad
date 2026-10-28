// Schema changes that older releases can't run with, numbered in PRAGMA user_version. Each step has an up, run at
// startup (src/db.js), and a down that puts the database back the way the release before it expects.
// Each release bundle carries a SCHEMA file with SCHEMA from here (scripts/make-bundle.sh); one without counts as 0.
// When scripts/install.sh moves to a release with a lower schema (a failed upgrade, or a deliberate downgrade), it
// runs the downs with the image of the release it leaves:
//   node src/schema.js down <n>     # undo every step above n; nothing to do when already at or below n
// Additions that older code ignores (a new table or column) need no step here.
const colsOf = (db) => new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));

const STEPS = [
  { // 1: a supporter's extra site points at its login through login_id (it was owner_id)
    up(db) {
      const cols = colsOf(db);
      if (cols.has('owner_id')) db.exec('ALTER TABLE users RENAME COLUMN owner_id TO login_id');
      else if (!cols.has('login_id')) db.exec('ALTER TABLE users ADD COLUMN login_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      db.exec('DROP INDEX IF EXISTS idx_users_owner');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_login ON users(login_id)');
    },
    down(db) {
      if (colsOf(db).has('login_id')) db.exec('ALTER TABLE users RENAME COLUMN login_id TO owner_id');
      db.exec('DROP INDEX IF EXISTS idx_users_login');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id)');
    },
  },
  { // 2: a guestbook's blocked addresses move from users.gb_ips lines to rows that expire (src/guestbook.js)
    up(db) {
      // made here rather than in src/db.js, so the step runs on any database that reaches it
      db.exec(`CREATE TABLE IF NOT EXISTS guestbook_blocks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, ip))`);
      // blocked before the upgrade: the 90 days count from now
      const put = db.prepare('INSERT OR IGNORE INTO guestbook_blocks (user_id, ip, created_at) VALUES (?, ?, ?)');
      for (const u of db.prepare("SELECT id, gb_ips FROM users WHERE gb_ips != ''").all()) {
        for (const ip of u.gb_ips.split('\n').map((l) => l.trim()).filter(Boolean)) put.run(u.id, ip, Date.now());
      }
      db.exec("UPDATE users SET gb_ips = ''");
    },
    down(db) {
      // the newest 200 per Site back as lines, oldest first, so an older release still blocks them
      const back = db.prepare('UPDATE users SET gb_ips = ? WHERE id = ?');
      for (const { user_id } of db.prepare('SELECT DISTINCT user_id FROM guestbook_blocks').all()) {
        // not the expired ones the hourly sweep hasn't reached yet: an older release would keep them for good
        const ips = db.prepare('SELECT ip FROM guestbook_blocks WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 200')
          .all(user_id, Date.now() - 90 * 86400000).map((r) => r.ip);
        back.run(ips.reverse().join('\n'), user_id);
      }
      db.exec('DELETE FROM guestbook_blocks'); // a later upgrade copies the lines again, unblocks made meanwhile included
    },
  },
];
const SCHEMA = STEPS.length;
const version = (db) => db.pragma('user_version', { simple: true });

// each step and its version number commit together, so a crash never leaves a step half applied
function up(db) {
  for (let v = version(db); v < SCHEMA; v++) db.transaction(() => { STEPS[v].up(db); db.pragma(`user_version = ${v + 1}`); })();
}
function down(db, target) {
  for (let v = version(db); v > target; v--) db.transaction(() => { STEPS[v - 1].down(db); db.pragma(`user_version = ${v - 1}`); })();
}

module.exports = { SCHEMA, up, down };

if (require.main === module) {
  const [cmd, n] = process.argv.slice(2);
  if (cmd === 'version') { console.log(SCHEMA); process.exit(0); }
  if (cmd !== 'down' || !/^\d+$/.test(n || '')) { console.error('usage: node src/schema.js down <n> | version'); process.exit(2); }
  // opened here, not through src/db.js, which would run the ups first
  const path = require('path');
  const db = new (require('better-sqlite3'))(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'puppypad.db'));
  const from = version(db);
  down(db, Number(n));
  console.log(from > Number(n) ? `database schema ${from} -> ${version(db)}` : `database schema already ${from}`);
}
