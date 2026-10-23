const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-rebuild-'));
process.env.BASE_URL = 'http://pad.test';

test('startup rebuilds every card style an older sanitizer derived', () => {
  const { db } = require('../src/db');
  const { VERSION } = require('../src/cardstyle');
  const user = db.prepare("INSERT INTO users (username, email, pw_hash, created_at, updated_at) VALUES (?, ?, 'x', 0, 0)");
  const ok = user.run('oldok', 'oldok@example.com').lastInsertRowid;
  const bad = user.run('oldbad', 'oldbad@example.com').lastInsertRowid;
  const style = db.prepare("INSERT INTO card_styles (user_id, source, css, version, updated_at) VALUES (?, ?, '.stale{}', ?, 0)");
  style.run(ok, '[data-part=card] { color: red }', VERSION - 1);
  style.run(bad, '[data-part=card] { position: fixed }', VERSION - 1);

  require('../src/server');
  const row = (id) => db.prepare('SELECT source, css, error, version FROM card_styles WHERE user_id = ?').get(id);
  assert.deepEqual(row(ok), { source: '[data-part=card] { color: red }', css: `.cs-${ok} [data-part=card]{color:red}`, error: null, version: VERSION });
  const rejected = row(bad);
  assert.equal(rejected.source, '[data-part=card] { position: fixed }');
  assert.equal(rejected.css, null);
  assert.match(rejected.error, /Position/);
  assert.equal(rejected.version, VERSION);
});
