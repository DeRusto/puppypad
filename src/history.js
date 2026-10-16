// File version history: one git repository per site in data/history/<site id>.git, with the site's folder as its work tree.
// Git does the versioning; this file decides when to commit and how much to keep. Only text files are kept:
// pictures don't diff or compress, so keeping them would double the disk every site takes.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');
const { TEXT_EXT } = require('./util');

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const gitDir = (id) => path.join(HISTORY_DIR, `${Number(id)}.git`);
const SHA = /^[0-9a-f]{40}$/;
// safe.directory: a restore from backup may hand the folders to another uid
const run = (args, encoding = 'utf8') => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'safe.directory=*', ...args], { encoding, maxBuffer: 64 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
});
const git = (id, tree, args, encoding) => run(['--git-dir', gitDir(id), '--work-tree', tree, ...args], encoding);
const ci = (ext) => ext.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`); // ignore rules are case-sensitive
const EXCLUDE = ['*', '!*/', ...[...TEXT_EXT].map((e) => `!*.${ci(e)}`)].join('\n') + '\n';

// one git command at a time per site, or two saves race for the index lock
const queues = new Map();
function queue(id, fn) {
  const p = (queues.get(id) || Promise.resolve()).then(fn);
  const tail = p.catch(() => {});
  queues.set(id, tail);
  tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
  return p;
}

// made beside its place and renamed in, so a crash halfway never leaves a broken repository to trip over
async function init(id) {
  if (fs.existsSync(gitDir(id))) return;
  const tmp = `${gitDir(id)}.${process.pid}.tmp`;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  await run(['init', '-q', '--bare', '-b', 'main', tmp]);
  fs.writeFileSync(path.join(tmp, 'info', 'exclude'), EXCLUDE);
  // gc runs only from trim(); small packing windows keep it inside the app's 512 MB
  for (const [k, v] of [['gc.auto', '0'], ['pack.threads', '1'], ['pack.windowMemory', '16m'], ['core.bigFileThreshold', '1m'], ['user.name', 'puppypad'], ['user.email', 'history@puppypad.invalid']]) {
    await run(['--git-dir', tmp, 'config', k, v]);
  }
  fs.renameSync(tmp, gitDir(id));
}

// bytes the repository takes on disk
async function size(id, tree) {
  const out = await git(id, tree, ['count-objects', '-v']);
  const kib = (k) => Number((out.match(new RegExp(`^${k}: (\\d+)`, 'm')) || [])[1] || 0);
  return (kib('size') + kib('size-pack')) * 1024;
}

// Drop versions older than `since` (ms), then halve what is left until the repository fits in maxBytes.
// The oldest kept commit becomes a shallow boundary, git's own way to forget what came before it; gc then deletes it.
async function trim(id, tree, { since, maxBytes }) {
  const log = (await git(id, tree, ['log', '--format=%H %ct']).catch(() => '')).trim(); // fails while there are no commits yet
  if (!log) return;
  const all = log.split('\n').map((l) => { const [sha, t] = l.split(' '); return { sha, t: t * 1000 }; });
  let keep = Math.max(1, all.filter((c) => c.t >= since).length);
  for (let cut = all.length; ; keep = Math.ceil(keep / 2)) {
    if (keep < cut) {
      fs.writeFileSync(path.join(gitDir(id), 'shallow'), `${all[keep - 1].sha}\n`);
      await git(id, tree, ['reflog', 'expire', '--expire=now', '--all']);
      await git(id, tree, ['gc', '-q', '--prune=now']);
      cut = keep;
    }
    if (keep === 1 || (await size(id, tree)) <= maxBytes) return;
  }
}

// commit whatever changed in the site's text files; keep = { since, maxBytes } for trim() when the repository grows past maxBytes
const record = (id, tree, message, keep) => queue(id, async () => {
  if (!fs.existsSync(tree)) return; // deleted meanwhile; don't leave a repository behind
  await init(id);
  await git(id, tree, ['add', '-A']);
  try { await git(id, tree, ['diff', '--cached', '--quiet']); return; } catch { /* exit 1: something to commit */ }
  await git(id, tree, ['commit', '-q', '--no-verify', '-m', message]);
  if (keep && (await size(id, tree)) > keep.maxBytes) await trim(id, tree, keep);
});

const exists = (id) => fs.existsSync(gitDir(id));
const trimSite = (id, tree, keep) => queue(id, async () => { if (exists(id)) await trim(id, tree, keep); });
// every kept version of one file, newest first: [{ sha, t }]; the commits that deleted it hold no version, so they are left out
async function versions(id, tree, rel) {
  if (!exists(id)) return [];
  const log = await git(id, tree, ['log', '--no-renames', '--diff-filter=AMT', '--format=%H %ct', '--', rel]).catch(() => ''); // no commits yet
  return log.trim().split('\n').filter(Boolean).map((l) => { const [sha, t] = l.split(' '); return { sha, t: t * 1000 }; });
}
// deleted files that are not back, newest deletion first: [{ rel, sha (the version before the delete), t }]
async function deleted(id, tree) {
  if (!exists(id)) return [];
  const out = await git(id, tree, ['log', '--no-renames', '--diff-filter=D', '--name-only', '--format=%x00%P %ct']).catch(() => ''); // no commits yet
  const seen = new Set();
  const rows = [];
  for (const block of out.split('\0').slice(1)) {
    const [head, ...files] = block.trim().split('\n');
    const [sha, t] = head.split(' ');
    for (const rel of files) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!fs.existsSync(path.join(tree, rel))) rows.push({ rel, sha, t: t * 1000 });
    }
  }
  return rows;
}
// a file as it was at version sha, as a Buffer, or null
async function show(id, tree, sha, rel) {
  if (!SHA.test(String(sha)) || !exists(id)) return null;
  try { return await git(id, tree, ['show', `${sha}:${rel}`], 'buffer'); } catch { return null; }
}
const remove = (id) => fs.rmSync(gitDir(id), { recursive: true, force: true });

module.exports = { HISTORY_DIR, record, trim: trimSite, versions, deleted, show, remove, exists };
