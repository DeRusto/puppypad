// Screenshot worker. Runs in its own container with no access to member data.
// It asks the app which site needs a picture, renders it in headless Chromium, and posts the JPEG back.
const { chromium } = require('playwright-core');
const net = require('net');
const dns = require('dns').promises;

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

// allowed() judges the name; this judges what the name points at, which is what a DNS-rebinding
// page controls. Chromium resolves again for the real connection, so a name that flips answers
// between the two lookups can still slip through — the container egress firewall stays required.
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const h = ip.toLowerCase();
  return !(h === '::' || h === '::1' || h.startsWith('::ffff:') || h.startsWith('fc') || h.startsWith('fd') ||
    h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'));
}
async function resolvesPublic(hostname) {
  try {
    const all = await dns.lookup(hostname, { all: true });
    return all.length > 0 && all.every(({ address }) => isPublicIp(address));
  } catch { return false; }
}

async function shoot(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 0.5, acceptDownloads: false, serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    // the site being shot is exempt from the resolution check: its name deliberately
    // resolves to the Caddy container in production (SHOT_HOST_MAP)
    const ownHost = new URL(url).hostname;
    const verdicts = new Map(); // hostname -> safe to connect, for this page only
    const routeOk = async (rawUrl) => {
      if (!allowed(rawUrl)) return false;
      let u; try { u = new URL(rawUrl); } catch { return false; }
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === ownHost) return true;
      if (!verdicts.has(u.hostname)) verdicts.set(u.hostname, await resolvesPublic(u.hostname));
      return verdicts.get(u.hostname);
    };
    await page.route('**/*', async (route) => ((await routeOk(route.request().url())) ? route.continue() : route.abort()));
    // page.route does not see WebSocket connections; route them through the same check
    await page.routeWebSocket(/.*/, async (ws) => ((await routeOk(ws.url())) ? ws.connectToServer() : ws.close({ code: 1008, reason: 'blocked' })));
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
