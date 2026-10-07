const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const SHOTS_DIR = path.join(DATA_DIR, 'shots');
fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'puppypad.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  tagline TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  signup_ip TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL,
  reporter_email TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followed_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_users_updated ON users(updated_at);
CREATE INDEX IF NOT EXISTS idx_guestbook_user ON guestbook(user_id, id);
`);

// columns added after v0.1
const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
for (const [name, def] of [['updates', 'INTEGER NOT NULL DEFAULT 0'], ['shot_dirty', 'INTEGER NOT NULL DEFAULT 0'], ['shot_at', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
}

module.exports = { db, DATA_DIR, SITES_DIR, SHOTS_DIR };
