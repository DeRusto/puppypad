const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-listing-'));
const { db } = require('../src/db');
const { createListing, ONLINE } = require('../src/listing');

const listing = createListing({ cfg: { NEW_SITE_HOURS: 24 } });
const old = Date.now() - 25 * 3600000;

test('Online, not hidden and Listed agree in SQL and JS, for a table of Site rows', () => {
  // [name, fields, online, unhidden, listed]
  const table = [
    ['ready', { verified: 1, banned: 0, hidden: 0, updates: 1, created_at: old }, true, true, true],
    ['unconfirmed', { verified: 0, banned: 0, hidden: 0, updates: 1, created_at: old }, false, false, false],
    ['takendown', { verified: 1, banned: 1, hidden: 0, updates: 1, created_at: old }, false, false, false],
    ['withlogin', { verified: 1, banned: 2, hidden: 0, updates: 1, created_at: old }, false, false, false],
    ['shy', { verified: 1, banned: 0, hidden: 1, updates: 1, created_at: old }, true, false, false],
    ['neveredited', { verified: 1, banned: 0, hidden: 0, updates: 0, created_at: old }, true, true, false],
    ['brandnew', { verified: 1, banned: 0, hidden: 0, updates: 3, created_at: Date.now() }, true, true, false],
  ];
  const add = db.prepare("INSERT INTO users (username, email, pw_hash, verified, banned, hidden, updates, created_at, updated_at) VALUES (@username, @email, 'x', @verified, @banned, @hidden, @updates, @created_at, 0)");
  for (const [username, f] of table) add.run({ username, email: `${username}@x.test`, ...f });
  const sql = (where) => db.prepare(`SELECT username FROM users WHERE ${where} ORDER BY id`).all().map((r) => r.username);
  const want = (i) => table.filter((r) => r[i]).map((r) => r[0]);
  assert.deepEqual(sql(ONLINE), want(2));
  assert.deepEqual(sql(listing.unhiddenWhere()), want(3));
  assert.deepEqual(sql(listing.listedWhere()), want(4));
  for (const [username, , online, , listed] of table) {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    assert.equal(listing.isOnline(row), online, username);
    assert.equal(listing.isListed(row), listed, username);
  }
});
