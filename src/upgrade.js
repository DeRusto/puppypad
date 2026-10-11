// The admin page's side of in-place upgrades. The app runs in a container with no git, no Docker
// socket and no network credentials, so it never upgrades itself. It shares one folder,
// data/upgrade, with scripts/upgrade-watch.sh on the host:
//   state, notes, log  written by the host: the running and newest release, that release's notes, the last run's output
//   request            written here: "check" or "upgrade <tag>"; the host takes it away when it picks it up
// The worst a compromised app can do through this folder is ask for the newest published release;
// the host checks that before running anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TAG = /^v\d+\.\d+\.\d+$/;
// true when release tag a is newer than b
const newer = (a, b) => {
  const [x, y] = [a, b].map((t) => t.slice(1).split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const STALE = 5 * 60000; // the watcher runs every minute; no sign of it for this long means it isn't running
const RUN_STALE = 60 * 60000;

const dirOf = (dataDir) => path.join(dataDir, 'upgrade');
// group-writable: the host watcher, running as a user in this folder's group, renames files in and out
const ensureDir = (dataDir) => {
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  try { fs.chmodSync(dirOf(dataDir), 0o770); } catch { /* not ours to change; the README covers it */ }
};

const readText = (file, max = 65536) => {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return '';
    return fs.readFileSync(file, 'utf8').slice(-max);
  } catch { return ''; }
};

// state is "key=value" lines; anything malformed is dropped rather than trusted
function readState(dataDir, now = Date.now()) {
  const dir = dirOf(dataDir);
  const kv = {};
  for (const line of readText(path.join(dir, 'state'), 8192).split('\n')) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  const tag = (s) => (TAG.test(s || '') ? s : '');
  const time = (s) => (/^\d+$/.test(s || '') ? Number(s) * 1000 : 0);
  const seenAt = time(kv.seen_at);
  const state = {
    // a long upgrade holds the watcher up, so "running" counts as alive for a while longer
    watcher: seenAt > 0 && (now - seenAt < STALE || (kv.status === 'running' && now - seenAt < RUN_STALE)),
    seenAt,
    status: ['idle', 'queued', 'running', 'ok', 'failed'].includes(kv.status) ? kv.status : 'idle',
    current: tag(kv.current),
    latest: tag(kv.latest),
    url: /^https:\/\/github\.com\/[\w./-]+$/.test(kv.url || '') ? kv.url : '',
    publishedAt: time(kv.published_at),
    checkedAt: time(kv.checked_at),
    finishedAt: time(kv.finished_at),
    message: (kv.message || '').slice(0, 300),
    notes: readText(path.join(dir, 'notes'), 8000).trim(),
    log: readText(path.join(dir, 'log'), 16384),
    request: readText(path.join(dir, 'request'), 200).trim(),
  };
  // nothing recorded as running (a server set up from a git checkout) counts as behind too
  state.behind = !!(state.latest && (!state.current || newer(state.latest, state.current)));
  return state;
}

// written to a temp name and renamed, so the host never reads half a request
function writeRequest(dataDir, line) {
  const dir = dirOf(dataDir);
  ensureDir(dataDir);
  const tmp = path.join(dir, `.request-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, `${line}\n`, { flag: 'wx' });
  fs.renameSync(tmp, path.join(dir, 'request'));
}

module.exports = { TAG, newer, readState, writeRequest, ensureDir };
