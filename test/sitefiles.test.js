const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// fresh data folder before the db loads
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-files-'));
const { db } = require('../src/db');
const H = require('../src/history');
const { createSiteFiles, siteDir, shotPath, resolve } = require('../src/sitefiles');

const free = { quotaMB: 1, fileMB: 0.5, anyType: false, historyDays: 30 };
const limits = new Map(); // site id -> limits, free unless a test says otherwise
const mail = [];
const files = createSiteFiles({
  cfg: { ABUSE_EMAIL: 'abuse@pad.test', SITE_NAME: 'Pad', BASE_URL: 'http://pad.test' },
  limitsFor: (site) => limits.get(site.id) || free,
  sendMail: async (...a) => { mail.push(a); return true; },
});

let n = 0;
async function newSite(lim) {
  const name = `site${++n}`;
  const t = Date.now();
  const { lastInsertRowid: id } = db.prepare("INSERT INTO users (username, email, pw_hash, verified, created_at, updated_at) VALUES (?, ?, '!', 1, ?, ?)").run(name, `${name}@x.test`, t, t);
  if (lim) limits.set(Number(id), lim);
  const site = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  await files.create(site, '<p>hi</p>');
  await H.versions(site.id, siteDir(site.username), 'index.html'); // waits in the site's queue until the first commit lands
  return site;
}
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);
const events = (site) => db.prepare("SELECT * FROM events WHERE user_id = ? AND kind = 'update'").all(site.id);
const read = (site, rel) => fs.readFileSync(path.join(siteDir(site.username), rel), 'utf8');
const MB = 1048576;

test('create makes the folder, the front page and the first history entry', async () => {
  const site = await newSite();
  assert.equal(read(site, 'index.html'), '<p>hi</p>');
  assert.equal((await H.versions(site.id, siteDir(site.username), 'index.html')).length, 1);
  assert.deepEqual(files.usage(site.username), { total: 9, count: 1 });
});

test('write saves, counts the bytes, records history and logs one feed event per hour', async () => {
  const site = await newSite();
  assert.equal(files.write(site, 'about.html', 'one'), null);
  assert.equal(files.write(site, 'pics/notes.txt', 'two'), null);
  assert.equal(read(site, 'pics/notes.txt'), 'two');
  assert.deepEqual(files.usage(site.username), { total: 15, count: 3 });
  const ev = events(site);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].files.split('\n').sort(), ['about.html', 'pics/notes.txt']);
  assert.equal(row(site).updates, 1);
  assert.equal(row(site).shot_dirty, 1);
  assert.equal((await H.versions(site.id, siteDir(site.username), 'about.html')).length, 1);
});

test('write refuses bad paths, other types, big files, a full quota and too many files', async () => {
  const site = await newSite();
  assert.match(files.write(site, '../escape.html', 'x'), /not allowed/);
  assert.match(files.write(site, 'tool.exe', 'x'), /not allowed/);
  assert.match(files.write(site, 'big.txt', 'x'.repeat(0.6 * MB)), /at most 0.5 MB/);
  assert.equal(files.write(site, 'a.txt', 'x'.repeat(0.45 * MB)), null);
  assert.equal(files.write(site, 'b.txt', 'x'.repeat(0.45 * MB)), null);
  assert.match(files.write(site, 'c.txt', 'x'.repeat(0.2 * MB)), /over your 1 MB limit/);
  assert.equal(fs.existsSync(path.join(siteDir(site.username), 'c.txt')), false);
  // replacing a file only counts the difference
  assert.equal(files.write(site, 'b.txt', 'x'.repeat(0.5 * MB)), null);
  const crowded = await newSite();
  for (let i = 1; i < 2000; i++) fs.writeFileSync(path.join(siteDir(crowded.username), `f${i}.txt`), '');
  files.forgetUsage(crowded.username);
  assert.match(files.write(crowded, 'one-more.txt', ''), /already has 2000 files/);
  assert.equal(files.write(crowded, 'f1.txt', 'replaced'), null);
});

test('supporter limits allow any type and bigger files', async () => {
  const site = await newSite({ quotaMB: 3, fileMB: 2, anyType: true, historyDays: 365 });
  assert.equal(files.write(site, 'tool.exe', 'x'), null);
  assert.equal(files.write(site, 'big.txt', 'x'.repeat(1.5 * MB)), null);
});

test('a phishing-looking page opens one auto-flag and mails abuse once', async () => {
  const site = await newSite();
  mail.length = 0;
  const page = '<title>PayPal login</title><input type="password">';
  assert.equal(files.write(site, 'login.html', page), null);
  assert.equal(files.write(site, 'login2.html', page), null);
  assert.equal(files.write(site, 'notes.txt', page), null); // not a type a browser runs
  const flags = db.prepare("SELECT * FROM reports WHERE site = ? AND reason = 'Auto-flag'").all(site.username);
  assert.equal(flags.length, 1);
  assert.match(flags[0].details, /^login\.html: password field/);
  assert.equal(mail.length, 1);
});

test('feed: false records history and a fresh screenshot without a feed event', async () => {
  const site = await newSite();
  db.prepare('UPDATE users SET shot_dirty = 0 WHERE id = ?').run(site.id);
  assert.equal(files.write(site, 'index.html', '<p>starter</p>', { feed: false }), null);
  assert.equal(events(site).length, 0);
  assert.equal(row(site).updates, 0);
  assert.equal(row(site).shot_dirty, 1);
  assert.equal((await H.versions(site.id, siteDir(site.username), 'index.html')).length, 2);
});

test('writeMany saves what fits and says why the rest was skipped', async () => {
  const site = await newSite();
  const tmp = path.join(process.env.DATA_DIR, 'up-1');
  fs.writeFileSync(tmp, 'from disk');
  const { saved, skipped } = files.writeMany(site, 'pics', [
    { name: 'a.txt', data: Buffer.from('in memory') },
    { name: 'b.txt', path: tmp, size: 9 },
    { name: 'my page.html', data: Buffer.from('x') },
    { name: 'bad.exe', data: Buffer.from('x') },
    { name: 'huge.txt', data: Buffer.alloc(0.6 * MB) },
  ]);
  assert.deepEqual(saved, ['pics/a.txt', 'pics/b.txt', 'pics/my_page.html']);
  assert.deepEqual(skipped, ['bad.exe (name or file type not allowed)', 'huge.txt (bigger than 0.5 MB)']);
  assert.equal(read(site, 'pics/b.txt'), 'from disk');
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(events(site).length, 1);
  assert.equal(files.relFor(site, 'pics', 'bad.exe'), null);
  assert.equal(files.relFor(site, '', 'my page.html'), 'my_page.html');
});

test('deleteFiles reports deleted and missing, tidies empty folders and logs one event', async () => {
  const site = await newSite();
  files.write(site, 'a/b/one.txt', '1');
  files.write(site, 'two.txt', '22');
  db.prepare('DELETE FROM events WHERE user_id = ?').run(site.id);
  const before = files.usage(site.username);
  assert.deepEqual(files.deleteFiles(site, ['a/b/one.txt', 'two.txt', 'two.txt', 'nope.txt', '../x']), { deleted: ['a/b/one.txt', 'two.txt'], missing: ['nope.txt', '../x'] });
  assert.equal(fs.existsSync(path.join(siteDir(site.username), 'a')), false);
  assert.deepEqual(files.usage(site.username), { total: before.total - 3, count: before.count - 2 });
  assert.equal(events(site).length, 1);
  assert.deepEqual(files.deleteFiles(site, ['nope.txt']), { deleted: [], missing: ['nope.txt'] });
});

test('move renames files and folders and never overwrites', async () => {
  const site = await newSite();
  files.write(site, 'old/a.txt', 'a');
  files.write(site, 'b.txt', 'b');
  assert.equal(files.move(site, 'b.txt', 'b.txt'), 'That is where it already is.');
  assert.match(files.move(site, 'b.txt', 'old/a.txt'), /already there/);
  assert.equal(files.move(site, 'old', 'old/inner'), 'A folder cannot go inside itself.');
  assert.match(files.move(site, 'old', '1/2/3/4/5/6'), /more than 6 folders deep/);
  assert.match(files.move(site, 'b.txt', 'b.exe'), /allowed file type/);
  assert.match(files.move(site, 'gone.txt', 'x.txt'), /not there any more/);
  assert.equal(files.move(site, 'old', 'new/place'), null);
  assert.equal(read(site, 'new/place/a.txt'), 'a');
  assert.equal(files.move(site, 'b.txt', 'new/b.txt'), null);
  assert.equal(fs.existsSync(path.join(siteDir(site.username), 'old')), false);
});

test('moving a text file to a page type runs the phishing check', async () => {
  const site = await newSite();
  files.write(site, 'plan.txt', '<input type="password">');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE site = ?").get(site.username).n, 0);
  assert.equal(files.move(site, 'plan.txt', 'plan.html'), null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE site = ?").get(site.username).n, 1);
});

test('rename carries the folder, screenshot and totals; removeSite leaves nothing behind', async () => {
  const site = await newSite();
  files.write(site, 'about.html', 'about');
  fs.writeFileSync(shotPath(site.username), 'jpg');
  const used = files.usage(site.username);
  files.rename(site.username, 'renamed');
  assert.equal(fs.existsSync(siteDir(site.username)), false);
  assert.equal(fs.existsSync(shotPath('renamed')), true);
  assert.deepEqual(files.usage('renamed'), used);
  // a site that never had a folder still renames
  files.rename('never-made', 'made-now');
  assert.equal(fs.existsSync(siteDir('made-now')), true);

  const moved = { ...site, username: 'renamed' };
  files.removeSite(moved);
  assert.equal(fs.existsSync(siteDir('renamed')), false);
  assert.equal(fs.existsSync(shotPath('renamed')), false);
  await H.remove(site.id); // waits in the site's queue behind the removal removeSite started
  assert.equal(H.exists(site.id), false);
});

test('resolve: which file a URL path serves, the one rule the router and the link check share', async () => {
  const site = await newSite();
  files.write(site, 'about.html', 'about');
  files.write(site, 'pics/index.html', 'pics');
  files.write(site, 'pics/cat.png', 'png');
  files.write(site, 'empty/notes.txt', 'x');
  const root = siteDir(site.username);
  const at = (...p) => ({ file: path.join(root, ...p) });
  for (const [url, want] of [
    ['/', at('index.html')],
    ['/about.html', at('about.html')],
    ['/about', at('about.html')], // clean URL
    ['/about/', null], // a trailing slash asks for a folder
    ['/about.htm', null], // an extension never falls back
    ['/pics/', at('pics', 'index.html')],
    ['/pics', { redirect: '/pics/' }], // a folder without its slash
    ['/pics/cat.png', at('pics', 'cat.png')],
    ['/pics/cat.png/', null],
    ['/empty/', null], // a folder without an index
    ['/nothing', null],
    ['/../puppypad.db', null],
    ['/x/../../puppypad.db', null],
    ['/.env', null],
    ['/pics/.hidden', null],
    ['/a\0b', null],
  ]) assert.deepEqual(resolve(root, url), want, url);
});

test('brokenLinks lists links and images that point at missing files, resolved like the router', async () => {
  const site = await newSite();
  files.write(site, 'about.html', '<p>about</p>');
  files.write(site, 'cat.png', 'png');
  files.write(site, 'index.html', `<a href="about.html">ok</a> <a href="/about">clean</a> <a href=about.html#top>anchor</a> <a href="./">home</a>
<img src="cat.png"> <img data-src="lazy.png"> <img src='gone.png'> <a href="/nope/">dir</a> <a href="old.html?x=1">old</a>
<a href="https://example.com/x.html">out</a> <a href="mailto:a@b.c">mail</a> <a href="#top">top</a> <img src="/_hw/counter.svg"> <a href="/about/">slash</a>`);
  // <base href> moves where relative links point, as in the browser
  files.write(site, 'pics/cat.png.txt', 'x');
  files.write(site, 'page.html', '<base href="/pics/"><a href="cat.png.txt">ok</a> <a href="dog.txt">gone</a> <a href="/pics">folder</a>');
  files.write(site, 'away.html', '<base href="https://elsewhere.example/"><img src="x.png">');
  const broken = (await files.brokenLinks(site)).map((b) => `${b.file} ${b.link}`).sort();
  assert.deepEqual(broken, ['index.html /about/', 'index.html /nope/', 'index.html gone.png', 'index.html old.html?x=1', 'page.html /pics', 'page.html dog.txt']);
  assert.deepEqual((await files.list(site)).sort(), ['about.html', 'away.html', 'cat.png', 'index.html', 'page.html', 'pics/cat.png.txt']);
});
