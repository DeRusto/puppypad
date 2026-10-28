const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-cardstyles-'));

const { db } = require('../src/db'); // starts the way the app does
const { siteDir } = require('../src/sitefiles');
const { createCardStyles, VERSION } = require('../src/cardstyle');

const cards = createCardStyles({ db, siteDir });

let n = 0;
const add = () => {
  const name = `pup${++n}`;
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, email, pw_hash, created_at, updated_at) VALUES (?, ?, 'h', 0, 0)").run(name, `${name}@x.test`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
};

test('a passing save shows on the card, scoped to it; a rejected one leaves the saved style alone', () => {
  const site = add();
  assert.equal(cards.cssFor([site]), '');
  assert.deepEqual(cards.of(site), { source: '', error: undefined, note: undefined });

  assert.deepEqual(cards.save(site, '[data-part=card] { transform: rotate(2deg) }'), {});
  assert.equal(cards.cssFor([site]), `.cs-${site.id} [data-part=card]{transform:rotate(2deg)}`);
  assert.equal(cards.of(site).source, '[data-part=card] { transform: rotate(2deg) }');

  assert.match(cards.save(site, '.foo { color: blue }').error, /Selector `\.foo` is not a Card part\./);
  assert.match(cards.save(site, `[data-part=name] { color: red } /*${'x'.repeat(4096)}*/`).error, /Card style is over 4096 bytes\./);
  assert.equal(cards.cssFor([site]), `.cs-${site.id} [data-part=card]{transform:rotate(2deg)}`);
  assert.equal(cards.of(site).source, '[data-part=card] { transform: rotate(2deg) }');

  // a page of cards: each styled card in card order, the rest add nothing
  const other = add();
  const plain = add();
  cards.save(other, '[data-part=name] { color: red }');
  assert.equal(cards.cssFor([other, plain, site]), `.cs-${other.id} [data-part=name]{color:red}\n.cs-${site.id} [data-part=card]{transform:rotate(2deg)}`);
  assert.equal(cards.cssFor([]), '');
});

const PNG = (n = 100) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n - 8, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 2)]);
// card art goes straight onto disk, as any route that writes Site files would leave it
const artFile = (site, rel, data) => {
  const full = path.join(siteDir(site.username), rel);
  fs.rmSync(full, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (data === 'folder') fs.mkdirSync(full); else if (data) fs.writeFileSync(full, data);
  return full;
};
const vOf = (full) => { const s = fs.statSync(full); return `${Math.floor(s.mtimeMs)}-${s.size}`; };

test('card art: own-Site images fill in; the Stock card when any art file fails, and art() serves only passing files', () => {
  const site = add();
  // missing art still saves
  assert.deepEqual(cards.save(site, '[data-part=card] { background: url("art/it\'s here.png") } [data-part=name]::after { content: ""; background: image-set("b.gif" 1x) }'), {});
  assert.equal(cards.cssFor([site]), '');
  assert.equal(cards.art(site, 'b.gif'), null);

  const png = artFile(site, "art/it's here.png", PNG());
  const gif = artFile(site, 'b.gif', GIF);
  // a path with a space and a quote comes out quoted and percent-encoded
  const url = `/card-art/${site.username}/art/it's%20here.png?v=${vOf(png)}`;
  assert.equal(cards.cssFor([site]), `.cs-${site.id} [data-part=card]{background:url("${url}")}.cs-${site.id} [data-part=name]::after{content:"";background:image-set("/card-art/${site.username}/b.gif?v=${vOf(gif)}"1x)}`);
  assert.deepEqual(cards.art(site, "art/it's here.png"), { buf: PNG(), type: 'image/png' });
  assert.deepEqual(cards.art(site, 'b.gif'), { buf: GIF, type: 'image/gif' });

  // replacing a file changes its v
  const v = vOf(png);
  artFile(site, "art/it's here.png", PNG(200));
  assert.doesNotMatch(cards.cssFor([site]), new RegExp(`v=${v}"`));
  assert.equal(cards.art(site, "art/it's here.png").buf.length, 200);

  // cssFor and art agree: 512 KB passes, one byte over doesn't; nor does a fake PNG, a folder or a deleted file
  artFile(site, "art/it's here.png", PNG(512 * 1024));
  assert.notEqual(cards.cssFor([site]), '');
  assert.ok(cards.art(site, "art/it's here.png"));
  for (const data of [PNG(512 * 1024 + 1), Buffer.from('not a png at all, really'), 'folder', null]) {
    artFile(site, "art/it's here.png", data);
    assert.equal(cards.cssFor([site]), '', String(data).slice(0, 20));
    assert.equal(cards.art(site, "art/it's here.png"), null);
  }
  artFile(site, "art/it's here.png", PNG());

  // only files the style uses: not another image, an svg or a traversal
  artFile(site, 'other.png', PNG());
  artFile(site, 'x.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const p of ['other.png', 'x.svg', '../b.gif', 'art/../b.gif']) assert.equal(cards.art(site, p), null, p);

  // urls follow the row's name, so a renamed Site needs no re-save
  fs.renameSync(siteDir(site.username), siteDir('renamedpup'));
  const renamed = { ...site, username: 'renamedpup' };
  assert.match(cards.cssFor([renamed]), /url\("\/card-art\/renamedpup\/art\/it's%20here\.png\?v=/);
  assert.ok(cards.art(renamed, 'b.gif'));
  assert.equal(cards.art(site, 'b.gif'), null);
});

test('check says why a card is the Stock card, and lists only the failing art', () => {
  const site = add();
  assert.deepEqual(cards.check(site), { css: '', why: "you haven't saved a card style", failing: [] });
  cards.save(site, '[data-part=card] { transform: rotate(2deg) }');
  assert.deepEqual(cards.check(site), { css: `.cs-${site.id} [data-part=card]{transform:rotate(2deg)}`, why: null, failing: [] });

  artFile(site, 'ok.png', PNG());
  cards.save(site, '[data-part=card] { background: url(ok.png), url(gone.gif) }');
  assert.deepEqual(cards.check(site), { css: '', why: "some of its art files don't work", failing: [{ path: 'gone.gif', reason: 'missing' }] });
  artFile(site, 'gone.gif', Buffer.from('nope'));
  assert.deepEqual(cards.check(site).failing, [{ path: 'gone.gif', reason: 'not a real GIF' }]);

  // a style the sanitizer now rejects: its reason, without the art list
  db.prepare("UPDATE card_styles SET css = NULL, error = 'Position fixed is not allowed.' WHERE user_id = ?").run(site.id);
  assert.deepEqual(cards.check(site), { css: '', why: 'Position fixed is not allowed', failing: [] });
  assert.equal(cards.of(site).error, 'Position fixed is not allowed.');

  // a style with nothing left once sanitized, like a lone comment, has no rules, not broken art
  cards.save(site, '/* soon */');
  assert.deepEqual(cards.check(site), { css: '', why: 'it has no rules', failing: [] });
});

test('an admin clear leaves a note until the member\'s next save, even an empty one; a rejected save keeps it', () => {
  const site = add();
  assert.equal(cards.clear(site, 'nothing there'), false); // nothing to clear leaves no note
  assert.equal(cards.of(site).note, undefined);

  cards.save(site, '[data-part=card] { color: red }');
  assert.equal(cards.clear(site, 'rude <words>'), true);
  assert.equal(cards.cssFor([site]), '');
  assert.equal(cards.of(site).source, '');
  assert.equal(cards.of(site).note.reason, 'rude <words>');
  assert.ok(cards.save(site, '.foo { color: blue }').error);
  assert.equal(cards.of(site).note.reason, 'rude <words>');
  assert.equal(cards.clear(site), false); // the member's empty save
  assert.equal(cards.of(site).note, undefined);

  cards.save(site, '[data-part=card] { color: red }');
  cards.clear(site, 'again');
  cards.save(site, '[data-part=card] { color: blue }');
  assert.equal(cards.of(site).note, undefined);
  assert.equal(cards.clear(site), true);
  assert.equal(cards.cssFor([site]), '');
});

test('rebuild re-derives every style an older sanitizer made; one it now rejects keeps its source and says why', () => {
  const ok = add();
  const bad = add();
  const fresh = add();
  const style = db.prepare("INSERT INTO card_styles (user_id, source, css, version, updated_at) VALUES (?, ?, '.stale{}', ?, 0)");
  style.run(ok.id, '[data-part=card] { color: red }', VERSION - 1);
  style.run(bad.id, '[data-part=card] { position: fixed }', VERSION - 1);
  cards.save(fresh, '[data-part=card] { color: green }');
  db.prepare("UPDATE card_styles SET css = '.kept{}' WHERE user_id = ?").run(fresh.id); // a current copy isn't touched

  cards.rebuild();
  const row = (id) => db.prepare('SELECT source, css, error, version FROM card_styles WHERE user_id = ?').get(id);
  assert.deepEqual(row(ok.id), { source: '[data-part=card] { color: red }', css: `.cs-${ok.id} [data-part=card]{color:red}`, error: null, version: VERSION });
  assert.equal(cards.cssFor([ok]), `.cs-${ok.id} [data-part=card]{color:red}`);
  assert.equal(row(fresh.id).css, '.kept{}');
  assert.equal(cards.cssFor([bad]), '');
  assert.equal(cards.of(bad).source, '[data-part=card] { position: fixed }');
  assert.match(cards.of(bad).error, /Position/);
  assert.equal(row(bad.id).version, VERSION);
  assert.equal(cards.check(bad).why, cards.of(bad).error.replace(/\.$/, ''));
});