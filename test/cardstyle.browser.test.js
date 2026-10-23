// Card style containment on a real /browse grid: the guardrails in site.css hold against hostile member CSS.
// Checked by hit-testing (elementFromPoint), not pixels. The CSS goes straight into card_styles, as if it had got
// past the sanitizer. CI installs Chromium; elsewhere the test skips when no browser is installed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3998;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-cards-'));
process.env.BASE_URL = `http://localhost:${PORT}`;
delete process.env.SMTP_HOST;
delete process.env.TURNSTILE_SECRET_KEY;

const app = require('../src/server');
const { db, SHOTS_DIR } = require('../src/db');
const { sanitize, VERSION } = require('../src/cardstyle');
const { siteDir } = require('../src/sitefiles');
let server;
let browser;
let skip = false;

// 26 listed sites, so /browse has a second page; a and b are the first two cards, and b supports
const ids = {};
before(async () => {
  const old = Date.now() - 48 * 3600000;
  const add = db.prepare("INSERT INTO users (username, email, pw_hash, verified, updates, created_at, updated_at, supporter_until) VALUES (?, ?, 'x', 1, 1, ?, ?, ?)");
  for (let i = 0; i < 26; i++) {
    const name = ['a', 'b'][i] ? `card${['a', 'b'][i]}` : `filler${i}`;
    ids[name] = add.run(name, `${name}@example.com`, old, old + 1000 - i, name === 'cardb' ? Date.now() + 86400000 : 0).lastInsertRowid;
  }
  fs.writeFileSync(path.join(SHOTS_DIR, 'cardb.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  server = app.listen(PORT);
  try {
    browser = await require('playwright').chromium.launch();
  } catch (e) {
    if (process.env.CI) throw e;
    skip = `no browser installed (${e.message.split('\n')[0]})`;
  }
});
after(async () => {
  if (browser) await browser.close();
  server.close();
});

// /browse with card a and card b wearing these styles (raw CSS, scoped by hand with .cs-<id>)
async function show({ a = '', b = '' } = {}) {
  db.prepare('DELETE FROM card_styles').run();
  const put = db.prepare('INSERT INTO card_styles (user_id, source, css, version, updated_at) VALUES (?, ?, ?, ?, 0)');
  for (const [name, css] of [['carda', a], ['cardb', b]]) if (css) put.run(ids[name], css, css.replaceAll('$', `.cs-${ids[name]}`), VERSION);
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`http://localhost:${PORT}/browse`);
  return page;
}
// the element at (x, y), described by what it is inside: 'a', 'b' (a card's root or below), or its own selector match
const hit = (page, x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  const card = el && el.closest('.card');
  return card ? card.querySelector('[data-part=name]').textContent.replace('card', '') : el && el.outerHTML.slice(0, 60);
}, [x, y]);
const box = (page, sel) => page.locator(sel).first().boundingBox();
const center = (r) => [r.x + r.width / 2, r.y + r.height / 2];
// true if a click at the middle of sel lands on sel itself (or inside it)
const clickable = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
}, sel);

test('cards: a transform or decoration on one card leaves its neighbour alone', async (t) => {
  if (skip) return t.skip(skip);
  const plain = await show();
  const before = await box(plain, '.card >> nth=1');
  await plain.close();
  const page = await show({ a: '$ [data-part=card] { transform: translateX(400px) scale(3); background: red } $ [data-part=card]::after { content: ""; position: absolute; inset: -500px; background: blue }' });
  assert.deepEqual(await box(page, '.card >> nth=1'), before);
  assert.equal(await hit(page, ...center(await box(page, '.card >> nth=1 >> [data-part=name]'))), 'b');
  await page.close();
});

test('cards: ::before and ::after never take clicks, whatever the selector weight', async (t) => {
  if (skip) return t.skip(skip);
  const page = await show({ a: '$ [data-part=card][data-part=card][data-part=card]::before, $ [data-part=card]::after { content: ""; position: absolute; inset: 0; z-index: 9; pointer-events: auto !important } $ [data-part=card]::after { pointer-events: all !important }' });
  assert.ok(await clickable(page, '.card [data-part=shot]'));
  assert.ok(await clickable(page, '.card [data-part=name]'));
  await page.close();
});

test('cards: positioned parts, transforms and even position: fixed stay inside the clip; the page controls stay clickable', async (t) => {
  if (skip) return t.skip(skip);
  for (const a of [
    '$ [data-part=shot] { position: absolute; top: -300px; left: -300px; width: 2000px; height: 2000px; z-index: 99999 } $ [data-part=name] { position: relative; top: -500px }',
    '$ [data-part=card] { transform: translateY(-300px) } $ [data-part=shot] { position: absolute; inset: -400px }',
    '$ [data-part=shot] { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647 }',
  ]) {
    const page = await show({ a });
    for (const sel of ['nav a[href="/rules"]', '#q', '.sorts a', '.pages a']) assert.ok(await clickable(page, sel), `${sel} under ${a}`);
    // more than 24px outside card a, nothing of it takes the click
    await page.evaluate(() => scrollTo(0, 0));
    const r = await box(page, '.card');
    for (const [x, y] of [[r.x - 30, r.y + 10], [r.x + 10, r.y - 30], [r.x + r.width / 2, r.y + r.height + 30], [500, 880]]) {
      assert.notEqual(await hit(page, x, y), 'a', `(${x}, ${y}) under ${a}`);
    }
    await page.close();
  }
});

test('cards: a benign 18px sticker draped over the edge survives the clip', async (t) => {
  if (skip) return t.skip(skip);
  const page = await show({ a: '$ [data-part=stats] { position: absolute; top: -18px; left: -18px; width: 36px; height: 36px; background: gold }' });
  const r = await box(page, '.card');
  assert.equal(await hit(page, r.x - 12, r.y - 12), 'a');
  await page.close();
});

test('cards: real card art drapes 18px over the edge and loads; transformed art stays inside the clip', async (t) => {
  if (skip) return t.skip(skip);
  // a 1x1 gold PNG in carda's own Site files, saved through the sanitizer like a member would
  fs.mkdirSync(siteDir('carda'), { recursive: true });
  fs.writeFileSync(path.join(siteDir('carda'), 'sticker.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));
  const put = async (source) => {
    db.prepare('DELETE FROM card_styles').run();
    const r = sanitize(source, Number(ids.carda));
    db.prepare('INSERT INTO card_styles (user_id, source, css, art, version, updated_at) VALUES (?, ?, ?, ?, ?, 0)').run(ids.carda, source, r.css, JSON.stringify(r.art), VERSION);
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const art = page.waitForResponse((res) => res.url().includes('/card-art/carda/sticker.png'));
    await page.goto(`http://localhost:${PORT}/browse`);
    assert.equal((await art).status(), 200);
    return page;
  };
  let page = await put('[data-part=stats] { position: absolute; top: -18px; left: -18px; width: 36px; height: 36px; background: url(sticker.png) 0 0 / cover }');
  const r = await box(page, '.card');
  assert.equal(await hit(page, r.x - 12, r.y - 12), 'a');
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.card [data-part=stats]')).backgroundImage), /\/card-art\/carda\/sticker\.png\?v=/);
  await page.close();
  page = await put('[data-part=card] { transform: translateY(-300px) scale(2) } [data-part=shot] { position: absolute; inset: -400px; background: url(sticker.png) }');
  const c = await box(page, '.card');
  for (const [x, y] of [[c.x - 30, c.y + 10], [c.x + c.width / 2, c.y + c.height + 30], [500, 880]]) assert.notEqual(await hit(page, x, y), 'a', `(${x}, ${y})`);
  await page.close();
});

test('cards: a Supporter keeps the rainbow frame on the shot', async (t) => {
  if (skip) return t.skip(skip);
  const page = await show({ b: '$ [data-part=shot] > * { border: 0 !important; background: none !important; animation: none !important } $ [data-part=card] img.shot.shot.shot { border-width: 0 !important }' });
  const s = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.supporter img.shot')); return [c.borderTopWidth, c.backgroundImage.includes('gradient'), c.animationName]; });
  assert.deepEqual(s, ['4px', true, 'rainbow']);
  await page.close();
});

test('cards: the name and the [profile] link can\'t be hidden', async (t) => {
  if (skip) return t.skip(skip);
  const hide = 'display: none !important; visibility: hidden !important; opacity: 0 !important; clip-path: inset(100%) !important; mask: linear-gradient(transparent, transparent) !important';
  const page = await show({ a: `$ [data-part=name] { ${hide} } $ [data-part=card] a[href^="/site/"] { ${hide} } $ [data-part=card] > div:not([data-part]) { ${hide} } $ [data-part=card] { visibility: hidden }` });
  assert.ok(await clickable(page, '.card [data-part=name]'));
  assert.ok(await clickable(page, '.card a[href^="/site/"]'));
  await page.close();
  // nor by hiding the card root itself; a transform on it stays the member's
  for (const rule of ['display: none', 'visibility: hidden', 'opacity: 0', 'clip-path: inset(100%)', 'mask: linear-gradient(transparent, transparent)', 'content-visibility: hidden']) {
    const p = await show({ a: `$ [data-part=card] { ${rule} !important; transform: rotate(3deg) }` });
    assert.ok(await clickable(p, '.card [data-part=name]'), rule);
    assert.ok(await clickable(p, '.card a[href^="/site/"]'), rule);
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.card [data-part=name]')).opacity === '1' && getComputedStyle(document.querySelector('.card [data-part=card]')).opacity), '1', rule);
    assert.match(await p.evaluate(() => getComputedStyle(document.querySelector('.card [data-part=card]')).transform), /^matrix\(/, rule);
    await p.close();
  }
});

test('cards: two cards with the same @keyframes name animate independently', async (t) => {
  if (skip) return t.skip(skip);
  db.prepare('DELETE FROM card_styles').run();
  const put = db.prepare('INSERT INTO card_styles (user_id, source, css, version, updated_at) VALUES (?, ?, ?, ?, 0)');
  for (const [name, frame] of [['carda', 'transform: translateX(20px)'], ['cardb', 'transform: translateY(20px)']]) {
    const source = `@keyframes wiggle { to { ${frame} } } [data-part=card] { animation: wiggle 100s linear -50s paused }`;
    put.run(ids[name], source, sanitize(source, Number(ids[name])).css, VERSION);
  }
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/browse`);
  const st = await page.evaluate(() => [...document.querySelectorAll('.card [data-part=card]')].slice(0, 2).map((c) => { const s = getComputedStyle(c); return s.transform; }));
  assert.deepEqual(st, ['matrix(1, 0, 0, 1, 10, 0)', 'matrix(1, 0, 0, 1, 0, 10)']);
  await page.close();
});
