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
  sh(path.join(bin, 'docker'), `echo "$*" >> ${log}
case "$*" in
  *"compose up"*) ! grep -q '^PUPPYPAD_VERSION=v0.0.2$' .env ;;
  *"backup('/data/backup.db')"*) touch data/backup.db ;;
  *"rm -f /data/backup.db"*) rm -f data/backup.db ;;
  *) exit 0 ;;
esac`);
  sh(path.join(bin, 'crontab'), `if [ "$1" = -l ]; then cat ${tmp}/crontab 2>/dev/null; else cat > ${tmp}/crontab; fi`);
  sh(path.join(bin, 'rclone'), 'exit 0');
  // a release is the bundle make-bundle.sh would build, with VERSION and docker-compose.yml marking which one it is
  const release = (tag) => {
    const stage = path.join(tmp, `stage-${tag}`);
    fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
    for (const f of ['.env.example', '.env.caddy.example', 'Caddyfile', 'README.md', 'LICENSE']) fs.copyFileSync(path.join(REPO, f), path.join(stage, f));
    for (const f of ['install.sh', 'backup.sh', 'upgrade-watch.sh']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(stage, 'scripts', f));
    fs.writeFileSync(path.join(stage, 'docker-compose.yml'), `# ${tag}\n`);
    fs.writeFileSync(path.join(stage, 'VERSION'), `${tag}\n`);
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
  return { tmp, root, bin, log, release, run, fresh, read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
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
  // tar reporting a file changed while read (exit 1) must not stop the backup or the upgrade
  const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
  sh(path.join(s.bin, 'tar'), `${realTar} "$@" || exit; case "$*" in *backups/puppypad-*) exit 1 ;; esac`);
  const up = s.run('scripts/install.sh', ['v0.0.2']);
  assert.equal(up.status, 1, up.stdout + up.stderr);
  assert.match(up.stdout, /did not come up healthy; going back/);
  assert.equal(s.read('docker-compose.yml'), '# v0.0.1\n');
  assert.equal(s.read('VERSION'), 'v0.0.1\n');
  assert.match(s.read('.env'), /^PUPPYPAD_VERSION=v0.0.1$/m);
  assert.ok(!fs.existsSync(path.join(s.root, 'ADDED.txt')));
  assert.equal(fs.readdirSync(path.join(s.root, 'backups')).filter((f) => f.endsWith('.tar.gz')).length, 1);
  assert.ok(!fs.existsSync(path.join(s.root, 'data/backup.db')));
  // the database copy runs in a throwaway container, so it works while the app is down
  assert.match(fs.readFileSync(s.log, 'utf8'), /compose run --rm -T --no-deps app node/);
  assert.doesNotMatch(fs.readFileSync(s.log, 'utf8'), /compose exec -T app (node -e "require\('better|rm)/);

  // only the newest 3 archives stay on the server, and they are copied to the remote
  for (let i = 1; i <= 5; i++) {
    const f = path.join(s.root, `backups/puppypad-2000010${i}-0315.tar.gz`);
    fs.writeFileSync(f, '');
    fs.utimesSync(f, i, i);
  }
  const b = s.run('scripts/backup.sh', [], { BACKUP_REMOTE: 'r:bucket' });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.equal(fs.readdirSync(path.join(s.root, 'backups')).filter((f) => f.endsWith('.tar.gz')).length, 3);

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
