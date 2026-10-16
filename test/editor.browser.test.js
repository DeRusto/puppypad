// The editor in a real browser: tag hints, auto-closing tags and find-and-replace.
// CI installs Chromium (see .github/workflows/ci.yml); elsewhere the test skips when no browser is installed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3999;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-browser-'));
process.env.BASE_URL = `http://localhost:${PORT}`;
process.env.SHOT_TOKEN = 'test-shot-token';
delete process.env.SMTP_HOST;
delete process.env.TURNSTILE_SECRET_KEY;

const mail = [];
const log = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail not configured]')) mail.push(s); else log(...a); };

const app = require('../src/server');
let server;
let browser;
let skip = false;

before(async () => {
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

// a confirmed member, logged in, in a fresh browser page
async function editorPage() {
  const base = process.env.BASE_URL;
  await fetch(`${base}/signup`, { method: 'POST', body: new URLSearchParams({ username: 'browserdog', email: 'browserdog@example.com', password: 'longpassword1', agree: '1' }) });
  const token = mail.join('\n').match(/verify\?token=([\w-]+)/)[1];
  const res = await fetch(`${base}/verify?token=${token}`, { redirect: 'manual' });
  const [name, value] = res.headers.get('set-cookie').split(';')[0].split('=');
  const context = await browser.newContext();
  await context.addCookies([{ name, value, url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/dashboard/edit?path=index.html`);
  await page.waitForSelector('.CodeMirror');
  return { page, errors };
}
const value = (page) => page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());

test('editor: tag hints, auto-closing tags, and find-and-replace', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await editorPage();
  await page.evaluate(() => { const cm = document.querySelector('.CodeMirror').CodeMirror; cm.setValue(''); cm.focus(); });

  // typing <di offers tag names; picking one and typing > closes the tag
  await page.keyboard.type('<di');
  await page.waitForSelector('.CodeMirror-hint');
  assert.ok((await page.$$eval('.CodeMirror-hint', (h) => h.map((x) => x.textContent))).includes('<div'));
  await page.click('.CodeMirror-hint >> text="<div"');
  await page.waitForFunction(() => document.querySelector('.CodeMirror').CodeMirror.getValue() === '<div');
  await page.focus('.CodeMirror textarea');
  await page.keyboard.type('>');
  await page.waitForFunction(() => /^<div>\s*<\/div>$/.test(document.querySelector('.CodeMirror').CodeMirror.getValue()), null, { timeout: 5000 })
    .catch(async () => assert.fail(`no closing tag: ${JSON.stringify(await value(page))}`));

  // the replace link swaps every match
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('cat and cat'));
  await page.click('#replace');
  await page.keyboard.type('cat');
  await page.keyboard.press('Enter');
  await page.keyboard.type('dog');
  await page.keyboard.press('Enter');
  await page.click('.CodeMirror-dialog button:has-text("All")');
  await page.waitForFunction(() => document.querySelector('.CodeMirror').CodeMirror.getValue() === 'dog and dog', null, { timeout: 5000 })
    .catch(async () => assert.fail(`not replaced: ${JSON.stringify(await value(page))}`));

  assert.deepEqual(errors, []);
});
