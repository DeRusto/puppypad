// Screenshot worker. Runs in its own container with no access to member data.
// It asks the app which site needs a picture, renders it in headless Chromium, and posts the JPEG back.
const { chromium } = require('playwright-core');
const net = require('net');

const APP = process.env.APP_URL || 'http://app:3000';
const TOKEN = process.env.SHOT_TOKEN;
const HOST_MAP = process.env.SHOT_HOST_MAP; // optional Chromium --host-resolver-rules, e.g. "MAP *.example.com caddy"
if (!TOKEN) { console.error('SHOT_TOKEN is required'); process.exit(1); }
const headers = { 'x-shot-token': TOKEN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Member pages are untrusted. Refuse anything that is not a normal public hostname,
// so a page cannot use this browser to poke at the app, other containers or cloud metadata.
function allowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h.includes('.') && !net.isIP(h) && !/(^|\.)(localhost|internal|local)$/i.test(h);
}

async function shoot(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 0.5, acceptDownloads: false, serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (allowed(route.request().url()) ? route.continue() : route.abort()));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(1500); // let fonts and gifs settle
    return await page.screenshot({ type: 'jpeg', quality: 70, timeout: 10000 });
  } finally {
    await ctx.close().catch(() => {});
  }
}

(async () => {
  const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--mute-audio', ...(HOST_MAP ? [`--host-resolver-rules=${HOST_MAP}`] : [])] });
  let browser = await launch();
  console.log('screenshot worker ready');
  for (;;) {
    let job = {};
    try { job = await (await fetch(`${APP}/internal/shots/next`, { headers })).json(); } catch (e) { console.error('app unreachable:', e.message); }
    if (!job.name) { if (process.env.SHOT_ONCE) break; await sleep(5000); continue; }
    let body = Buffer.from('fail');
    try {
      if (!browser.isConnected()) browser = await launch();
      body = await shoot(browser, job.url);
      console.log('shot', job.name, body.length);
    } catch (e) { console.error('shot failed', job.name, e.message.split('\n')[0]); }
    await fetch(`${APP}/internal/shots/${job.name}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body }).catch(() => {});
    if (process.env.SHOT_ONCE) break;
  }
  await browser.close();
})();
