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
