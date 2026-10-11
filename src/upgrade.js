// The admin page's side of in-place upgrades. The app runs in a container with no git, no Docker
// socket and no network credentials, so it never upgrades itself. It shares one folder,
// data/upgrade, with scripts/upgrade-watch.sh on the host:
//   state, pending, log  written by the host: what is running, what is new on the branch, the last run's output
//   request              written here: "check" or "upgrade <sha>"; the host deletes it when it picks it up
// The worst a compromised app can do through this folder is ask for a commit that is already on the
// branch the host follows; the host checks that before running anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHA = /^[0-9a-f]{40}$/;
const STALE = 5 * 60000; // the watcher runs every minute; no sign of it for this long means it isn't running
const RUN_STALE = 60 * 60000;

const dirOf = (dataDir) => path.join(dataDir, 'upgrade');
const ensureDir = (dataDir) => fs.mkdirSync(dirOf(dataDir), { recursive: true });

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
  const sha = (s) => (SHA.test(s || '') ? s : '');
  const time = (s) => (/^\d+$/.test(s || '') ? Number(s) * 1000 : 0);
  const seenAt = time(kv.seen_at);
  const state = {
    // a long rebuild holds the watcher up, so "running" counts as alive for a while longer
    watcher: seenAt > 0 && (now - seenAt < STALE || (kv.status === 'running' && now - seenAt < RUN_STALE)),
    seenAt,
    status: ['idle', 'queued', 'running', 'ok', 'failed'].includes(kv.status) ? kv.status : 'idle',
    branch: kv.branch || '',
    current: sha(kv.current),
    latest: sha(kv.latest),
    checkedAt: time(kv.checked_at),
    finishedAt: time(kv.finished_at),
    message: (kv.message || '').slice(0, 300),
    pending: readText(path.join(dir, 'pending'), 16384).split('\n').filter(Boolean).slice(0, 50),
    log: readText(path.join(dir, 'log'), 16384),
    request: readText(path.join(dir, 'request'), 200).trim(),
  };
  state.behind = !!(state.current && state.latest && state.current !== state.latest);
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

module.exports = { SHA, readState, writeRequest, ensureDir };
