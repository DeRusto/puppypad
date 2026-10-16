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
CREATE TABLE IF NOT EXISTS released_names (
  name TEXT PRIMARY KEY,
  released_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  site TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- visitor stats: no cookies or IPs, just counts per UTC day, kept 30 days
CREATE TABLE IF NOT EXISTS page_views (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, path)
);
CREATE TABLE IF NOT EXISTS referrers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, host)
);
-- comments on a member's profile (event_id NULL) or on one of their feed updates; user_id is the member whose space it is
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_event ON comments(event_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_users_updated ON users(updated_at);
CREATE INDEX IF NOT EXISTS idx_guestbook_user ON guestbook(user_id, id);
`);

// columns added after v0.1
const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
for (const [name, def] of [['updates', 'INTEGER NOT NULL DEFAULT 0'], ['shot_dirty', 'INTEGER NOT NULL DEFAULT 0'], ['shot_at', 'INTEGER NOT NULL DEFAULT 0'], ['new_email', 'TEXT'], ['webring', 'INTEGER NOT NULL DEFAULT 0'], ['hidden', 'INTEGER NOT NULL DEFAULT 0'], ['gb_words', "TEXT NOT NULL DEFAULT ''"], ['gb_ips', "TEXT NOT NULL DEFAULT ''"], ['bw_day', "TEXT NOT NULL DEFAULT ''"], ['bw_bytes', 'INTEGER NOT NULL DEFAULT 0'], ['starter', "TEXT NOT NULL DEFAULT ''"], ['quota_mb', 'INTEGER NOT NULL DEFAULT 0'], ['tags', "TEXT NOT NULL DEFAULT ''"], ['gb_notify', "TEXT NOT NULL DEFAULT 'daily'"], ['gb_digest_at', 'INTEGER NOT NULL DEFAULT 0'], ['renamed_at', 'INTEGER NOT NULL DEFAULT 0'], ['staff_pick', 'INTEGER NOT NULL DEFAULT 0'], ['sotw_at', 'INTEGER NOT NULL DEFAULT 0'], ['notes_seen_at', 'INTEGER NOT NULL DEFAULT 0'], ['note_mail', "TEXT NOT NULL DEFAULT ''"], ['digest', 'INTEGER NOT NULL DEFAULT 0'], ['digest_at', 'INTEGER NOT NULL DEFAULT 0'], ['status', "TEXT NOT NULL DEFAULT ''"], ['api_key', "TEXT NOT NULL DEFAULT ''"], ['totp_secret', "TEXT NOT NULL DEFAULT ''"], ['totp_step', 'INTEGER NOT NULL DEFAULT 0'], ['totp_codes', "TEXT NOT NULL DEFAULT ''"], ['supporter_until', 'INTEGER NOT NULL DEFAULT 0'], ['owner_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE']]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
}
// two-factor login: totp_secret is '' when it is off; totp_step is the last code's step, so a code works once;
// totp_codes holds the sha256 of each unused recovery code, one per line
// owner_id: a supporter's extra site is its own row (files, stats and guestbook stay keyed by site) pointing at the login row that owns it; it has no password of its own
// the API key's sha256; '' when the member has none
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key) WHERE api_key != ''");
// sitesOf() and the cascade on deleting a login both look extra sites up by owner
db.exec('CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id)');
// existing guestbooks start their first digest from now, not from every entry ever signed
if (!cols.has('gb_digest_at')) db.prepare('UPDATE users SET gb_digest_at = ?').run(Date.now());
// existing members' old followers are not news
if (!cols.has('notes_seen_at')) db.prepare('UPDATE users SET notes_seen_at = ?').run(Date.now());
if (!db.prepare('PRAGMA table_info(guestbook)').all().some((c) => c.name === 'approved')) db.exec('ALTER TABLE guestbook ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
// a name left behind by a rename points at its site, so the old address redirects while the name is held
if (!db.prepare('PRAGMA table_info(released_names)').all().some((c) => c.name === 'user_id')) db.exec('ALTER TABLE released_names ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
// the files an update changed, newest first, one per line
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'files')) db.exec("ALTER TABLE events ADD COLUMN files TEXT NOT NULL DEFAULT ''");

module.exports = { db, DATA_DIR, SITES_DIR, SHOTS_DIR };
