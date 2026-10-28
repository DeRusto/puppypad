const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-names-'));
const { db } = require('../src/db');
const { createNames, NAME_HOLD } = require('../src/names');

let failMove = false;
const moved = [];
const names = createNames({ files: { rename: (from, to) => { if (failMove) throw new Error('disk full'); moved.push([from, to]); } } });

let n = 0;
const add = (fields = {}) => {
  const name = `pup${++n}`;
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, email, pw_hash, verified, banned, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, 0, 0)")
    .run(fields.username || name, `${name}@x.test`, fields.verified ?? 1, fields.banned ?? 0);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
};
const row = (site) => db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);

test('a name is taken while a Site has it or it is held; a held name stays free for nobody but the Site that gave it up', () => {
  const site = add();
  assert.equal(names.taken(site.username), true);
  assert.equal(names.taken('free-name'), false);
  names.hold('gone-name');
  assert.equal(names.taken('gone-name'), true);
  assert.equal(names.taken('gone-name', { by: site }), true); // a plain hold is nobody's to reclaim
  names.hold('given-up', { site });
  assert.equal(names.taken('given-up'), true);
  assert.equal(names.taken('given-up', { by: site }), false);
  assert.equal(names.taken('given-up', { by: add() }), true);
});

test('renamedTo follows a hold with a Site while the hold lasts and the Site is Online', () => {
  const site = add();
  names.hold('before-name', { site });
  assert.equal(names.renamedTo('before-name'), site.username);
  names.hold('plain-hold');
  assert.equal(names.renamedTo('plain-hold'), undefined);
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(site.id);
  assert.equal(names.renamedTo('before-name'), undefined);
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(site.id);
  db.prepare('UPDATE released_names SET released_at = ? WHERE name = ?').run(Date.now() - NAME_HOLD - 1, 'before-name');
  assert.equal(names.renamedTo('before-name'), undefined);
  assert.equal(names.taken('before-name'), false); // the hold is over
  names.sweep();
  assert.equal(db.prepare('SELECT 1 FROM released_names WHERE name = ?').get('before-name'), undefined);
  assert.ok(db.prepare('SELECT 1 FROM released_names WHERE name = ?').get('plain-hold'));
});

test('rename changes the row, swaps the holds, moves the reports and the folder', () => {
  const site = add({ username: 'first-name' });
  db.prepare("INSERT INTO reports (site, reason, details, created_at) VALUES ('first-name', 'Spam', 'x', 0)").run();
  assert.equal(names.rename(site, add().username), 'taken');
  assert.equal(names.rename(site, 'second-name'), 'ok');
  assert.equal(row(site).username, 'second-name');
  assert.ok(row(site).renamed_at > 0);
  assert.equal(row(site).shot_dirty, 1);
  assert.deepEqual(moved.at(-1), ['first-name', 'second-name']);
  assert.equal(names.renamedTo('first-name'), 'second-name');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE site = 'second-name'").get().n, 1);
  // and back: taking its own old name back lifts that hold
  assert.equal(names.rename(row(site), 'first-name'), 'ok');
  assert.equal(names.renamedTo('first-name'), undefined);
  assert.equal(names.renamedTo('second-name'), 'first-name');
});

test('a rename whose folder move fails changes nothing', () => {
  const site = add({ username: 'stuck-name' });
  failMove = true;
  try {
    assert.throws(() => names.rename(site, 'wanted-name'), /disk full/);
  } finally { failMove = false; }
  assert.equal(row(site).username, 'stuck-name');
  assert.equal(row(site).renamed_at, 0);
  assert.equal(names.taken('stuck-name', { by: add() }), true); // still its own name, not a hold
  assert.equal(names.renamedTo('stuck-name'), undefined);
  assert.equal(names.taken('wanted-name'), false);
});
