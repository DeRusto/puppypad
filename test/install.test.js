const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

// scripts/install.sh checks the app with a node one-liner inside the container. It also has to pass against
// releases up to v0.1.0, which only answer /healthz when Host is the public hostname, so run it against a
// server that behaves that way.
const probe = fs.readFileSync(path.join(__dirname, '../scripts/install.sh'), 'utf8').match(/node -e "(require\('http'\)[^"]*)"/)[1];

const run = (port, env) => new Promise((resolve) => {
  execFile(process.execPath, ['-e', probe.replace('port: 3000', `port: ${port}`)], { env: { ...process.env, ...env } }, (err) => resolve(err ? err.code : 0));
});

test('installer health probe sends the public hostname and only passes on 200', async () => {
  let status = 200;
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === '/healthz' && req.headers.host === 'pad.example' ? status : 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  const { port } = server.address();
  try {
    assert.equal(await run(port, { BASE_URL: 'https://pad.example' }), 0);
    assert.equal(await run(port, { BASE_URL: 'https://other.example' }), 1);
    status = 503;
    assert.equal(await run(port, { BASE_URL: 'https://pad.example' }), 1);
  } finally {
    server.close();
  }
  assert.equal(await run(port, { BASE_URL: 'https://pad.example' }), 1); // nothing listening
});

// The rest drive the real scripts in a temp folder, with stand-ins for docker, crontab and rclone on PATH
// and releases served from disk through UPGRADE_GITHUB_URL, so they never touch Docker, cron or GitHub.
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
const REPO = path.join(__dirname, '..');
const sh = (file, body) => { fs.writeFileSync(file, `#!/bin/sh\n${body}\n`); fs.chmodSync(file, 0o755); };

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-install-'));
  const root = path.join(tmp, 'srv');
  const bin = path.join(tmp, 'bin');
  const web = path.join(tmp, 'web');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const log = path.join(tmp, 'docker.log');
  // docker: the new release never comes up (`up` fails while .env names v0.0.2); the database copy is a file
  // each line ends with the release .env names at that moment, [v0.0.2], to show which image a command runs with
  sh(path.join(bin, 'docker'), `echo "$* [$(sed -n 's/^PUPPYPAD_VERSION=//p' .env 2>/dev/null)]" >> ${log}
case "$*" in
  *"compose up"*) ! grep -q '^PUPPYPAD_VERSION=v0.0.2$' .env ;;
  *"user_version"*) cat data/user_version 2>/dev/null || echo 0 ;;
  *"schema.js down"*) [ ! -f data/down_fails ] ;;
  *"backup('/data/backup.db')"*) touch data/backup.db ;;
  *"rm -f /data/backup.db"*) rm -f data/backup.db ;;
  *) exit 0 ;;
esac`);
  sh(path.join(bin, 'crontab'), `if [ "$1" = -l ]; then cat ${tmp}/crontab 2>/dev/null; else cat > ${tmp}/crontab; fi`);
  sh(path.join(bin, 'rclone'), `echo "rclone $*" >> ${log}`);
  // a release is the bundle make-bundle.sh would build, with VERSION and docker-compose.yml marking which one it is;
  // schema writes its SCHEMA file (none: an older release), installer replaces its scripts/install.sh
  const release = (tag, { schema, installer } = {}) => {
    const stage = path.join(tmp, `stage-${tag}`);
    fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
    for (const f of ['.env.example', '.env.caddy.example', 'Caddyfile', 'README.md', 'LICENSE']) fs.copyFileSync(path.join(REPO, f), path.join(stage, f));
    for (const f of ['install.sh', 'backup.sh', 'upgrade-watch.sh']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(stage, 'scripts', f));
    fs.writeFileSync(path.join(stage, 'docker-compose.yml'), `# ${tag}\n`);
    fs.writeFileSync(path.join(stage, 'VERSION'), `${tag}\n`);
    if (schema !== undefined) fs.writeFileSync(path.join(stage, 'SCHEMA'), `${schema}\n`);
    if (installer) sh(path.join(stage, 'scripts/install.sh'), installer);
    if (tag === 'v0.0.2') fs.writeFileSync(path.join(stage, 'ADDED.txt'), 'new in v0.0.2\n');
    const out = path.join(web, 'DeRusto/puppypad/releases/download', tag);
    fs.mkdirSync(out, { recursive: true });
    execFileSync('tar', ['-czf', path.join(out, `puppypad-${tag}.tar.gz`), '-C', stage, '.']);
    execFileSync('sh', ['-c', `sha256sum puppypad-${tag}.tar.gz > SHA256SUMS`], { cwd: out });
  };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPGRADE_GITHUB_URL: `file://${web}`, UPGRADE_REPO: 'DeRusto/puppypad' };
  const run = (cmd, args, extra = {}, input) => spawnSync(cmd, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', input });
  // a first install is piped into sh, as the README's curl line does
  const fresh = (tag) => run('sh', ['-s', tag], {}, fs.readFileSync(path.join(REPO, 'scripts/install.sh')));
  // the docker commands run so far, one per line, and the data folders backup.sh copies
  const docker = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const data = () => { for (const d of ['data/sites', 'data/shots']) fs.mkdirSync(path.join(root, d), { recursive: true }); };
  return { tmp, root, bin, log, release, run, fresh, docker, data, read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}

test('installer: a first install refuses a folder that holds other files', () => {
  const s = sandbox();
  s.release('v0.0.1');
  fs.writeFileSync(path.join(s.root, 'README.md'), 'mine');
  const r = s.fresh('v0.0.1');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /run this in an empty folder/);
  assert.equal(s.read('README.md'), 'mine');
});

test('installer: an upgrade that does not come up puts every file and .env value back; backups ride through', () => {
  const s = sandbox();
  s.release('v0.0.1');
  s.release('v0.0.2');
  const first = s.fresh('v0.0.1');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  fs.mkdirSync(path.join(s.root, 'data/sites/pup'), { recursive: true });
  fs.mkdirSync(path.join(s.root, 'data/shots'));
  fs.writeFileSync(path.join(s.root, 'data/sites/pup/index.html'), 'hi');
  // rsync reporting a file vanished while it ran (exit 24) must not stop the backup or the upgrade
  const realRsync = execFileSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).trim();
  sh(path.join(s.bin, 'rsync'), `${realRsync} "$@" || exit; exit 24`);
  const up = s.run('scripts/install.sh', ['v0.0.2']);
  assert.equal(up.status, 1, up.stdout + up.stderr);
  assert.match(up.stdout, /did not come up healthy; going back/);
  assert.equal(s.read('docker-compose.yml'), '# v0.0.1\n');
  assert.equal(s.read('VERSION'), 'v0.0.1\n');
  assert.match(s.read('.env'), /^PUPPYPAD_VERSION=v0.0.1$/m);
  assert.ok(!fs.existsSync(path.join(s.root, 'ADDED.txt')));
  assert.equal(s.read('backups/latest/sites/pup/index.html'), 'hi');
  assert.ok(fs.existsSync(path.join(s.root, 'backups/latest/backup.db')));
  assert.ok(!fs.existsSync(path.join(s.root, 'data/backup.db')));
  // the database copy runs in a throwaway container, so it works while the app is down
  assert.match(fs.readFileSync(s.log, 'utf8'), /compose run --rm -T --no-deps app node/);
  assert.doesNotMatch(fs.readFileSync(s.log, 'utf8'), /compose exec -T app (node -e "require\('better|rm)/);
  // neither release has a schema, so the database is left alone
  assert.doesNotMatch(fs.readFileSync(s.log, 'utf8'), /schema\.js/);

  // one copy, kept current: deleted files and old full archives go, history comes along, and the remote mirrors it
  fs.writeFileSync(path.join(s.root, 'backups/puppypad-20000101-0315.tar.gz'), '');
  fs.rmSync(path.join(s.root, 'data/sites/pup/index.html'));
  fs.mkdirSync(path.join(s.root, 'data/history/1.git'), { recursive: true });
  const b = s.run('scripts/backup.sh', [], { BACKUP_REMOTE: 'r:bucket' });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'backups')).sort(), ['latest']);
  assert.ok(!fs.existsSync(path.join(s.root, 'backups/latest/sites/pup/index.html')));
  assert.ok(fs.existsSync(path.join(s.root, 'backups/latest/history/1.git')));
  assert.match(fs.readFileSync(s.log, 'utf8'), /rclone sync backups\/latest r:bucket\/latest --backup-dir r:bucket\/old\/\d{8}-\d{4}/);

  // the watcher runs the installer only for the newest release it found itself, never for what the app asks
  sh(path.join(s.root, 'scripts/install.sh'), 'echo "$1" > ran');
  fs.writeFileSync(path.join(s.root, '.upgrade/latest'), 'v0.0.3\n');
  fs.writeFileSync(path.join(s.root, '.upgrade/checked_at'), `${Math.floor(Date.now() / 1000)}\n`);
  const watch = (request) => {
    fs.writeFileSync(path.join(s.root, 'data/upgrade/request'), `${request}\n`);
    return s.run('scripts/upgrade-watch.sh', []);
  };
  assert.match(watch('upgrade v0.0.2').stdout, /ignored a request/);
  assert.ok(!fs.existsSync(path.join(s.root, 'ran')));
  assert.equal(watch('upgrade v0.0.3').status, 0);
  assert.equal(s.read('ran'), 'v0.0.3\n');
});

// the index of the first docker command matching re, after index `from`
const at = (lines, re, from = -1) => lines.findIndex((l, i) => i > from && re.test(l));
const DOWN = (n, tag) => new RegExp(`^compose run --rm -T --no-deps app node src/schema\\.js down ${n} \\[${tag}\\]$`);

test('installer: a failed upgrade to a newer schema puts the database back with the new image before the old release starts', () => {
  const s = sandbox();
  s.release('v0.0.1');
  s.release('v0.0.2', { schema: 1 });
  assert.equal(s.fresh('v0.0.1').status, 0);
  s.data();
  const up = s.run('scripts/install.sh', ['v0.0.2']);
  assert.equal(up.status, 1, up.stdout + up.stderr);
  assert.match(up.stdout, /putting the database back to schema 0/);
  const d = s.docker();
  const failed = at(d, /^compose up -d --remove-orphans \[v0\.0\.2\]$/);
  const stop = at(d, /^compose stop app \[v0\.0\.2\]$/, failed);
  const down = at(d, DOWN(0, 'v0.0.2'), stop);
  const back = at(d, /^compose up -d --remove-orphans \[v0\.0\.1\]$/, down);
  assert.ok(failed >= 0 && stop > failed && down > stop && back > down, d.join('\n'));
  assert.equal(s.read('VERSION'), 'v0.0.1\n');
  assert.ok(!fs.existsSync(path.join(s.root, 'SCHEMA')));
});

test('installer: moving to an older schema keeps control, backs up and puts the database back before switching', () => {
  const s = sandbox();
  s.release('v0.0.1', { installer: 'echo "handed over to the v0.0.1 installer"; exit 7' });
  s.release('v0.0.3', { schema: 1 });
  assert.equal(s.fresh('v0.0.3').status, 0);
  assert.equal(s.read('SCHEMA'), '1\n');
  s.data();
  const down = s.run('scripts/install.sh', ['v0.0.1']);
  assert.equal(down.status, 0, down.stdout + down.stderr);
  assert.doesNotMatch(down.stdout, /handed over/);
  const d = s.docker();
  const backup = at(d, /backup\('\/data\/backup\.db'\).* \[v0\.0\.3\]$/);
  const stop = at(d, /^compose stop app \[v0\.0\.3\]$/, backup);
  const migrate = at(d, DOWN(0, 'v0.0.3'), stop);
  const start = at(d, /^compose up -d --remove-orphans \[v0\.0\.1\]$/, migrate);
  assert.ok(backup >= 0 && stop > backup && migrate > stop && start > migrate, d.join('\n'));
  assert.equal(s.read('VERSION'), 'v0.0.1\n');
  assert.ok(!fs.existsSync(path.join(s.root, 'SCHEMA'))); // v0.0.1 has none, so the next upgrade compares against 0
});

test('installer: an upgrade still hands over to the new release installer', () => {
  const s = sandbox();
  s.release('v0.0.1');
  s.release('v0.0.3', { schema: 1, installer: 'echo "handed over to the v0.0.3 installer: $1"' });
  assert.equal(s.fresh('v0.0.1').status, 0);
  const up = s.run('scripts/install.sh', ['v0.0.3']);
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.match(up.stdout, /handed over to the v0\.0\.3 installer: v0\.0\.3/);
});

test('installer: after an upgrade that died before writing SCHEMA, going back still reads the schema from the database', () => {
  const s = sandbox();
  s.release('v0.0.1');
  s.release('v0.0.3', { schema: 1 });
  assert.equal(s.fresh('v0.0.1').status, 0);
  s.release('v0.0.1', { installer: 'echo "handed over to the v0.0.1 installer"; exit 7' }); // republished: a handover would show
  s.data();
  // what an upgrade to v0.0.3 killed after `compose up` leaves: its files and images in place, the database
  // moved on by its app, but no SCHEMA file and the old VERSION
  fs.writeFileSync(path.join(s.root, 'data/user_version'), '1\n');
  fs.writeFileSync(path.join(s.root, '.env'), s.read('.env').replace(/^PUPPYPAD_VERSION=.*$/m, 'PUPPYPAD_VERSION=v0.0.3'));
  assert.ok(!fs.existsSync(path.join(s.root, 'SCHEMA')));
  const back = s.run('scripts/install.sh', ['v0.0.1']);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.doesNotMatch(back.stdout, /handed over/);
  const d = s.docker();
  const migrate = at(d, DOWN(0, 'v0.0.3'));
  const start = at(d, /^compose up -d --remove-orphans \[v0\.0\.1\]$/, migrate);
  assert.ok(migrate >= 0 && start > migrate, d.join('\n'));
});

test('installer: when the database cannot be put back after a failed upgrade, the older release is not started on it', () => {
  const s = sandbox();
  s.release('v0.0.1');
  s.release('v0.0.2', { schema: 1 });
  assert.equal(s.fresh('v0.0.1').status, 0);
  s.data();
  fs.writeFileSync(path.join(s.root, 'data/down_fails'), '');
  const up = s.run('scripts/install.sh', ['v0.0.2']);
  assert.equal(up.status, 1, up.stdout + up.stderr);
  assert.match(up.stdout, /could not put the database back/);
  const d = s.docker();
  assert.ok(at(d, DOWN(0, 'v0.0.2')) >= 0, d.join('\n'));
  assert.equal(at(d, /^compose up .*\[v0\.0\.1\]$/), -1, d.join('\n'));
  // left as the failed attempt: the next run of the installer starts from it and tries the step back again
  assert.ok(fs.existsSync(path.join(s.root, '.upgrade/prev.env')));
  assert.equal(s.read('VERSION'), 'v0.0.1\n');
});

// Step 2 on its own, through src/schema.js the way the installer runs it: blocked guestbook addresses move to
// guestbook_blocks on the way up and the newest 200 per Site go back to users.gb_ips on the way down
test('schema step 2: blocked guestbook addresses survive up and then down', () => {
  const Database = require('better-sqlite3');
  const schema = require('../src/schema');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-schema2-'));
  const file = path.join(dir, 'puppypad.db');
  const many = Array.from({ length: 205 }, (_, i) => `10.3.0.${i}`);
  let db = new Database(file);
  // a database as schema 1 left it, with the users columns step 2 reads
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, login_id INTEGER, gb_ips TEXT NOT NULL DEFAULT '');
    PRAGMA user_version = 1;`);
  const put = db.prepare('INSERT INTO users (id, username, gb_ips) VALUES (?, ?, ?)');
  put.run(1, 'few', '10.0.0.1\n 10.0.0.2 \n\n10.0.0.1');
  put.run(2, 'many', many.join('\n'));
  put.run(3, 'none', '');
  const before = Date.now();
  schema.up(db);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  const blocks = (id) => db.prepare('SELECT ip, created_at FROM guestbook_blocks WHERE user_id = ? ORDER BY rowid').all(id);
  assert.deepEqual(blocks(1).map((b) => b.ip), ['10.0.0.1', '10.0.0.2']);
  assert.equal(blocks(2).length, 205);
  assert.ok(blocks(1).every((b) => b.created_at >= before)); // the 90 days count from the upgrade
  assert.deepEqual(db.prepare('SELECT gb_ips FROM users ORDER BY id').all().map((u) => u.gb_ips), ['', '', '']);
  db.prepare('INSERT INTO guestbook_blocks (user_id, ip, created_at) VALUES (3, ?, ?)').run('10.9.9.9', Date.now()); // blocked after the upgrade
  // expired but not swept yet: an older release would keep it for good, so it doesn't go back
  db.prepare('INSERT INTO guestbook_blocks (user_id, ip, created_at) VALUES (3, ?, ?)').run('10.8.8.8', Date.now() - 91 * 86400000);
  db.close();

  const out = execFileSync(process.execPath, [path.join(REPO, 'src/schema.js'), 'down', '1'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.match(out, /database schema 2 -> 1/);
  db = new Database(file);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  const ips = (id) => db.prepare('SELECT gb_ips FROM users WHERE id = ?').get(id).gb_ips.split('\n');
  assert.deepEqual(ips(1), ['10.0.0.1', '10.0.0.2']);
  assert.deepEqual(ips(2), many.slice(-200)); // the newest 200
  assert.deepEqual(ips(3), ['10.9.9.9']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM guestbook_blocks').get().n, 0);

  schema.up(db); // and up again
  assert.deepEqual(blocks(3).map((b) => b.ip), ['10.9.9.9']);
  assert.equal(blocks(2).length, 200);
  db.close();
});
