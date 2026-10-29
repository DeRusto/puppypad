const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const dnsp = require('dns').promises;
const { db, DATA_DIR, SITES_DIR } = require('./db');
const U = require('./util');
const V = require('./views');
const { readZip, writeZip } = require('./zip');
const starters = require('./starters');
const style = require('./style');
const { createCardStyles } = require('./cardstyle');
const upgrade = require('./upgrade');
const W = require('./widgets');
const H = require('./history');
const { createSiteFiles, siteDir, shotPath, resolveIn, resolve, MAX_FILES } = require('./sitefiles');
const { createLogins } = require('./logins');
const { createSessions } = require('./sessions');
const { createListing } = require('./listing');
const { createNames } = require('./names');
const { createSocial, WITH_FOLLOWERS, NOTE_KINDS } = require('./social');
const { createGuestbook } = require('./guestbook');
const { createBilling, BadSignature } = require('./billing');
const { createDomains } = require('./domains');

// ---------- config ----------
const env = process.env;
const base = new URL(env.BASE_URL || 'http://localhost:3000');
const cfg = {
  SITE_NAME: env.SITE_NAME || 'PuppyPad',
  TAGLINE: env.TAGLINE || 'accidents welcome',
  BASE_URL: base.origin,
  BASE_HOST: base.hostname,
  ABUSE_EMAIL: env.ABUSE_EMAIL || `abuse@${base.hostname}`,
  // shown on /rules when set
  OPERATOR: env.OPERATOR || '',
  GOVERNING_LAW: env.GOVERNING_LAW || '',
  DMCA_AGENT: env.DMCA_AGENT || '',
  QUOTA_MB: Number(env.QUOTA_MB || 500),
  MAX_FILE_MB: Number(env.MAX_FILE_MB || 5),
  ZIP_MAX_MB: Number(env.ZIP_MAX_MB || 20),
  BANDWIDTH_MB: Number(env.BANDWIDTH_MB || 1024), // per site per UTC day
  RENAME_DAYS: Number(env.RENAME_DAYS || 30), // a member renames their site at most once this often
  HISTORY_DAYS: Number(env.HISTORY_DAYS || 30), // how long old versions of text files are kept
  SUPPORTER_HISTORY_DAYS: Number(env.SUPPORTER_HISTORY_DAYS || 365),
  SUPPORTER_QUOTA_MB: Number(env.SUPPORTER_QUOTA_MB || 2000),
  SUPPORTER_MAX_FILE_MB: Number(env.SUPPORTER_MAX_FILE_MB || 25),
  // the supporter tier is on only with the Stripe keys and at least one price; otherwise its pages are hidden and nobody can pay
  SUPPORT_ON: !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && (env.STRIPE_PRICE_ID || env.STRIPE_PRICE_ID_ANNUAL)),
  PRICE_ID: env.STRIPE_PRICE_ID || '', // the monthly supporter price
  PRICE_ID_ANNUAL: env.STRIPE_PRICE_ID_ANNUAL || '', // an optional yearly price, offered next to monthly while set
  // supporters' own domains (src/domains.js); off by default, apart from the Stripe keys. While off, stored claims sleep
  CUSTOM_DOMAINS: env.CUSTOM_DOMAINS === 'on',
  // a new site joins the public lists only after its first edit and once it is this old, so throwaway spam gets no audience
  NEW_SITE_HOURS: Number.isFinite(Number(env.NEW_SITE_HOURS)) && env.NEW_SITE_HOURS !== '' ? Number(env.NEW_SITE_HOURS) : 24,
  // matched on confirmed email, not site name, so nobody can grab admin by signing up with the right name first
  ADMIN_EMAILS: new Set((env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)),
  SECURE: base.protocol === 'https:',
  SHOT_TOKEN: env.SHOT_TOKEN || '',
  TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY || '', // signup captcha; off when unset
  subdomainUrl: (name) => `${base.protocol}//${name}.${base.host}`,
};
// a Site's address: its live Custom domain when it has one (set once src/domains.js is made, below)
cfg.siteUrl = cfg.subdomainUrl;
const COOKIE = cfg.SECURE ? '__Host-sid' : 'sid'; // __Host- stops member subdomains from overwriting it
const { DAY, lines, PER_PAGE } = U;
const HEALTH_MIN_FREE = 0.05; // /healthz fails once less than 5% of the disk is free
const IP_KEEP = 90 * DAY; // report IPs are erased after this (src/guestbook.js keeps its own); the privacy page promises it
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10); // UTC
const bwToday = (u) => (u.bw_day === today() ? u.bw_bytes : 0);
const HOTLINK_MEDIA = /\.(png|jpe?g|gif|webp|ico|bmp|svg|midi?|mp3|ogg|wav)$/i;
const BOT_UA = /bot|crawl|spider|slurp|preview|headless/i; // shortcut: a word list, not a bot database
const STATS_DAYS = 30;
const HOTLINK_PER_MIN = 60; // media requests a minute per site from pages on other domains

const mailer = env.SMTP_HOST ? nodemailer.createTransport({
  host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: Number(env.SMTP_PORT) === 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
}) : null;
// resolves true once the message is handed over, false when sending failed
async function sendMail(to, subject, text) {
  if (!mailer) { console.log(`[mail not configured] to=${to} subject="${subject}"\n${text}\n`); return true; }
  try { await mailer.sendMail({ from: env.MAIL_FROM || `${cfg.SITE_NAME} <noreply@${cfg.BASE_HOST}>`, to, subject, text }); return true; }
  catch (e) { console.error('mail failed:', e.message); return false; }
}

// Cloudflare Turnstile. Fails closed: if Cloudflare cannot be reached, nobody signs up until it can.
async function humanCheck(req) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: String(req.body['cf-turnstile-response'] || ''), remoteip: req.ip }),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).success === true;
  } catch (e) {
    console.error('turnstile check failed:', e.message);
    return false;
  }
}

// ---------- helpers ----------
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
};
// uploads and unpacked zips land here first: on disk, not in memory, and on the same volume as the sites so they move in with a rename
const UPLOAD_TMP = path.join(DATA_DIR, 'tmp');
fs.rmSync(UPLOAD_TMP, { recursive: true, force: true }); // whatever a crash left behind
fs.mkdirSync(UPLOAD_TMP, { recursive: true });
// Temp files sit outside every member's quota, so running uploads share one budget: each reserves its largest
// possible size up front and is turned away while that would eat into the 5% of the disk /healthz keeps free.
let tempReserved = 0;
// bytes is a number, or a function of the request when the most a request can unpack depends on the member
const tempBudget = (most) => (req, res, next) => {
  const bytes = typeof most === 'function' ? most(req) : most;
  let spare = 0;
  try { const s = fs.statfsSync(UPLOAD_TMP); spare = (s.bavail - s.blocks * HEALTH_MIN_FREE) * s.bsize; } catch { /* unknown: refuse */ }
  if (spare - tempReserved < bytes) {
    const msg = 'The server is short on space for uploads right now. Try again in a little while.';
    return req.accepts(['html', 'json']) === 'json' ? res.status(503).json({ error: msg }) : res.status(503).send(V.notices.busy(req.ctx, msg));
  }
  tempReserved += bytes;
  let held = true;
  const release = () => { if (held) { held = false; tempReserved -= bytes; } };
  res.on('finish', release).on('close', release);
  next();
};
const dropTemp = (files) => { for (const f of files) if (f && f.path) fs.rmSync(f.path, { force: true }); };
// Online, not hidden and Listed (src/listing.js); the webring takes only Listed Sites that joined it (profiles and addresses work for every Online Site)
const listing = createListing({ cfg });
const { ONLINE, listedWhere } = listing;
// Each member keeps the largest QUOTA_MB they have had: raising it in .env grows every site, lowering it only affects new signups
db.prepare('UPDATE users SET quota_mb = ? WHERE quota_mb < ?').run(cfg.QUOTA_MB, cfg.QUOTA_MB);

const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;
const MAX_SITES = 5;
// what belongs to a site's login, from any of its sites (src/logins.js)
const logins = createLogins({ cfg, removeSite: (site) => files.removeSite(site), dropShot: (site) => fs.rmSync(shotPath(site.username), { force: true }), holdName: (name) => names.hold(name) });
const { loginOf, isLogin, sitesOf, isAdmin, supporterUntil, supporterUntilSql, isSupporter, limitsFor } = logins;
// signed-in visits, tokens and two-factor codes, and whether a Session is still good (src/sessions.js)
const sessions = createSessions({ logins });
const { makeToken, useToken, peekToken, useCode } = sessions;
const startSession = (res, userId) => res.cookie(COOKIE, sessions.start(userId), { httpOnly: true, sameSite: 'lax', secure: cfg.SECURE, path: '/', maxAge: sessions.SESSION_TTL });
const clearSession = (res) => res.clearCookie(COOKIE, { path: '/', secure: cfg.SECURE });
// what a route answers when its Session stopped being current while it waited
const signedOut = (req, res) => (req.accepts(['html', 'json']) === 'json' ? res.status(403).json({ error: 'You were signed out. Sign in and try again.' }) : res.redirect('/login'));
// the supporter tier's rules (src/billing.js), only while it is switched on; app.setStripe swaps the Stripe client for tests
const makeBilling = (stripe) => createBilling({ cfg, logins, stripe, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
let billing = cfg.SUPPORT_ON ? makeBilling(new Stripe(env.STRIPE_SECRET_KEY)) : null;
// every change to a site's folder goes through here (src/sitefiles.js)
const files = createSiteFiles({ cfg, limitsFor, sendMail });
// which names are taken, Held names and renames (src/names.js)
const names = createNames({ files });
// follows, comments, likes, Blocks, notifications and the follow feed (src/social.js)
const social = createSocial({ cfg, logins, listing, sendMail });
// supporters' own domains (src/domains.js). DNS answers come from the system resolver; the HTTPS request goes straight
// to the Caddy container with the custom host as SNI, so Caddy issues or renews its certificate. app.setDomainNet swaps them for tests
const domainNet = {
  txt: (name) => dnsp.resolveTxt(name).then((r) => r.map((parts) => parts.join('')), () => []),
  addrs: async (name) => [...await dnsp.resolve4(name).catch(() => []), ...await dnsp.resolve6(name).catch(() => [])],
  https: (host) => new Promise((done) => {
    const r = https.get({ host: 'caddy', port: 443, servername: host, headers: { host }, path: '/', timeout: 60000 }, (res) => { res.resume(); done(true); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => done(false));
  }),
};
const domains = createDomains({ cfg, logins, sendMail, net: domainNet });
cfg.siteUrl = (name) => { const host = domains.liveHost(name); return host ? `https://${host}` : cfg.subdomainUrl(name); };
// how a mail or page names a Site in plain text
cfg.siteHost = (name) => cfg.siteUrl(name).replace(/^https?:\/\//, '');
// sites whose login supports right now (admins aside), for the flair next to their names; read only when a page shows names
const supporterNames = () => new Set(db.prepare(`SELECT u.username FROM users o JOIN users u ON u.id = o.id OR u.login_id = o.id WHERE ${supporterUntilSql('o.')} > ?`).all(now()).map((r) => r.username));
const withFlair = (ctx) => { let names; return Object.defineProperty(ctx, 'supporters', { get: () => (names ??= supporterNames()), enumerable: true }); };
// ---------- app ----------
// Express 5 leaves req.body undefined when no parser ran (a GET, or a POST that is not a form); handlers read fields off it freely
const bodyDefault = (req, res, next) => { req.body ??= {}; next(); };
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

const main = express.Router();
const site = express.Router();

app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  // The screenshot worker calls /internal/* by container name, not by the public hostname.
  // Caddy refuses /internal/* from the outside, so this path is only reachable inside the Docker network.
  if (host === cfg.BASE_HOST || req.path.startsWith('/internal/')) return main(req, res, next);
  if (host === `www.${cfg.BASE_HOST}`) return res.redirect(301, cfg.BASE_URL + req.originalUrl);
  if (host.endsWith(`.${cfg.BASE_HOST}`)) {
    const name = host.slice(0, -cfg.BASE_HOST.length - 1);
    if (!name.includes('.')) { req.siteName = name; return site(req, res, next); }
  }
  // a live Custom domain is served as its Site
  const custom = domains.siteFor(host);
  if (custom) { req.siteName = custom; req.customHost = host; return site(req, res, next); }
  // monitors and the installer's upgrade check call /healthz by whatever name reaches the app (localhost, an IP),
  // not the public hostname; member sites keep their own /healthz
  if (req.path === '/healthz') return main(req, res, next);
  res.status(404).type('text').send('Unknown host');
});

// ================= member sites (name.BASE_HOST) =================
// link previews: a page with a <head> but no og:image of its own gets the site's dog-park screenshot.
// Worked on as latin1 so the member's bytes pass through unchanged whatever their charset.
function withOgImage(buf, name) {
  const html = buf.toString('latin1');
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head || /<meta[^>]+og:image/i.test(html.replace(/<!--[^]*?-->/g, ''))) return buf;
  const at = head.index + head[0].length;
  return Buffer.concat([buf.subarray(0, at), Buffer.from(`<meta property="og:image" content="${cfg.BASE_URL}/shots/${name}.jpg">`), buf.subarray(at)]);
}
site.use((req, res, next) => {
  const owner = q.userByName.get(req.siteName);
  if (!owner || !owner.verified) {
    const to = names.renamedTo(req.siteName);
    // a day's cache, not forever: once the hold ends someone else may take the old name
    if (to) return res.set('Cache-Control', 'public, max-age=86400').redirect(301, cfg.siteUrl(to) + req.originalUrl);
    return res.status(404).send(V.sitePages.empty(cfg, req.siteName));
  }
  if (owner.banned) return res.status(410).send(V.sitePages.banned(cfg, owner.username));
  // while the Site has a live Custom domain, its subdomain sends visitors there (a day's cache, like a rename's)
  const live = !req.customHost && (req.method === 'GET' || req.method === 'HEAD') && domains.liveHost(owner.username);
  if (live) return res.set('Cache-Control', 'public, max-age=86400').redirect(301, `https://${live}${req.originalUrl}`);
  req.owner = owner;
  if (owner.hidden) res.set('X-Robots-Tag', 'noindex');
  next();
});

site.get('/_hw/counter.svg', (req, res) => {
  let hits = req.owner.hits;
  if (U.limit(`hit:${req.owner.id}:${req.ip}`, 1, 3600000)) {
    db.prepare('UPDATE users SET hits = hits + 1 WHERE id = ?').run(req.owner.id);
    hits++;
  }
  res.set('Cache-Control', 'no-store').type('image/svg+xml').send(W.counterSvg(hits));
});
site.get('/_hw/updated.svg', (req, res) => res.set('Cache-Control', 'public, max-age=300').type('image/svg+xml').send(W.updatedSvg(req.owner.updated_at)));
site.get('/_hw/status.svg', (req, res) => res.set('Cache-Control', 'public, max-age=60').type('image/svg+xml').send(W.statusSvg(req.owner.status)));

// signing, spam rules, owner tools and mail (src/guestbook.js); the routes here read forms and render
const guestbook = createGuestbook({ cfg, logins, sendMail, listing });
site.get('/_hw/guestbook', (req, res) => res.set('Cache-Control', 'no-store').send(V.guestbook(guestbook.page(req.owner, req.query.page), '', W.gbTheme(req.query.theme))));
site.post('/_hw/guestbook', express.urlencoded({ extended: false, limit: '8kb' }), bodyDefault, (req, res) => {
  const theme = W.gbTheme(req.query.theme);
  // website is the hidden field only bots fill
  const result = guestbook.sign(req.owner, { name: req.body.name, message: req.body.message, ip: req.ip, bot: !!req.body.website });
  const fail = { missing: [400, 'Name and message are both required.'], limited: [429, 'Too many entries from you. Try again in ten minutes.'], word: [400, 'Your entry contains a word the owner has blocked.'] }[result];
  if (fail) return res.status(fail[0]).send(V.guestbook(guestbook.page(req.owner, req.query.page), fail[1], theme));
  res.redirect(`/_hw/guestbook${theme === 'classic' ? '' : `?theme=${theme}`}`);
});

site.use(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).type('text').send('Method not allowed');
  if (bwToday(req.owner) >= cfg.BANDWIDTH_MB * 1048576) {
    return res.status(429).set('Retry-After', String(Math.ceil((Date.parse(today()) + DAY - now()) / 1000)))
      .send(V.sitePages.resting(cfg));
  }
  let refHost = '';
  try { refHost = new URL(req.get('referer')).hostname; } catch {}
  // the Site's subdomain and its live Custom domain: visits between the two are not referrals
  const ownHosts = [`${req.owner.username}.${cfg.BASE_HOST}`, domains.liveHost(req.owner.username)];
  let page = false; // set once the request resolves to a page
  // shortcut: bytes count when a response finishes, so downloads already in flight can overshoot the cap; reserve up front if that shows up in practice
  res.on('finish', () => {
    const bytes = Number(res.get('Content-Length')) || 0;
    if (req.method === 'GET' && bytes) {
      db.prepare('UPDATE users SET bw_bytes = (CASE WHEN bw_day = @day THEN bw_bytes ELSE 0 END) + @bytes, bw_day = @day WHERE id = @id').run({ day: today(), bytes, id: req.owner.id });
    }
    // visitor stats: pages only, crawlers left out, and only the name of the website a visitor came from
    // a 304 is a returning visitor whose browser kept the page
    if (req.method === 'GET' && page && (res.statusCode === 200 || res.statusCode === 304) && !BOT_UA.test(req.get('user-agent') || '')) {
      const at = { id: req.owner.id, day: today() };
      // a throw here would escape every handler and stop the server; the site may have been deleted while this page went out
      try {
        db.prepare('INSERT INTO page_views (user_id, day, path, views) VALUES (@id, @day, @path, 1) ON CONFLICT DO UPDATE SET views = views + 1').run({ ...at, path: req.path.slice(0, 200) });
        if (refHost && refHost !== req.hostname && !ownHosts.includes(refHost)) db.prepare('INSERT INTO referrers (user_id, day, host, views) VALUES (@id, @day, @host, 1) ON CONFLICT DO UPDATE SET views = views + 1').run({ ...at, host: refHost.slice(0, 200) });
      } catch (e) { if (q.userById.get(req.owner.id)) console.error('visitor stats failed:', e.message); }
    }
  });
  const root = siteDir(req.owner.username);
  const notFound = () => {
    if (req.path === '/favicon.ico') return asset('favicon.svg', 'image/svg+xml')(req, res); // sites without an icon of their own get ours
    const custom = path.join(root, 'not_found.html');
    if (fs.existsSync(custom)) return res.status(404).sendFile(custom);
    res.status(404).send(V.sitePages.missing(cfg, req.owner.username));
  };
  let rel;
  try { rel = decodeURIComponent(req.path); } catch { return notFound(); }
  const hotlinked = req.get('referer') && refHost !== cfg.BASE_HOST && !refHost.endsWith(`.${cfg.BASE_HOST}`) && !domains.siteFor(refHost); // a live Custom domain counts as ours
  if (hotlinked && HOTLINK_MEDIA.test(rel) && !U.limit(`hotlink:${req.owner.id}`, HOTLINK_PER_MIN, 60000)) {
    return res.status(429).type('text').send('Too many requests from other websites for this file. Try again in a minute.');
  }
  const r = await resolve(root, rel);
  if (!r) return notFound();
  if (r.redirect) return res.redirect(301, req.path + '/');
  const full = r.file;
  page = /\.html?$/i.test(full);
  res.set('Cache-Control', 'public, max-age=60');
  if (page && fs.existsSync(shotPath(req.owner.username))) {
    return fs.readFile(full, (e, buf) => (e ? notFound() : res.type('html').send(withOgImage(buf, req.owner.username))));
  }
  res.sendFile(full, { dotfiles: 'deny' }, (e) => { if (e && !res.headersSent) notFound(); });
});

// ================= main site =================
main.use((req, res, next) => { res.set('X-Frame-Options', 'DENY').set('Referrer-Policy', 'same-origin'); next(); });
// Content-Security-Policy for the main site only: member sites run whatever their owners write, and get none.
// The editor is left out too. Its live preview is an about:srcdoc frame, which inherits the page's policy, so any
// policy there would also block the member's own scripts, images and <base> in the preview.
const EDITOR_PATHS = new Set(['/dashboard/edit', '/dashboard/save', '/dashboard/style']);
const csp = (nonce) => [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`, // Turnstile on the signup form
  "style-src 'self' 'unsafe-inline'", // the pages' own <style> and style attributes; scripts are what the policy is for
  "img-src 'self' data:",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  // the support page's forms redirect to Stripe's Checkout and billing portal
  `form-action 'self'${cfg.SUPPORT_ON ? ' https://checkout.stripe.com https://billing.stripe.com' : ''}`,
  "frame-ancestors 'none'",
].join('; ');
main.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  // routes match regardless of case and a trailing slash, so the exception has to as well
  if (!EDITOR_PATHS.has(req.path.toLowerCase().replace(/\/+$/, ''))) res.set('Content-Security-Policy', csp(res.locals.nonce));
  next();
});

// Screenshot worker API. The worker is a separate container; member pages it renders must not be able to call this, hence the token.
const shotAuth = (req, res, next) => {
  const got = Buffer.from(String(req.headers['x-shot-token'] || ''));
  const want = Buffer.from(cfg.SHOT_TOKEN);
  return cfg.SHOT_TOKEN && got.length === want.length && crypto.timingSafeEqual(got, want) ? next() : res.sendStatus(403);
};
main.get('/internal/shots/next', shotAuth, (req, res) => {
  // wait 20s after the last save so a burst of edits makes one screenshot
  const u = db.prepare(`SELECT username FROM users WHERE ${ONLINE} AND shot_dirty = 1 AND updated_at < ? ORDER BY updated_at LIMIT 1`).get(now() - 20000);
  res.json(u ? { name: u.username, url: cfg.siteUrl(u.username) + '/' } : {});
});
main.post('/internal/shots/:name', shotAuth, express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const u = q.userByName.get(req.params.name);
  if (!u) return res.sendStatus(404);
  const ok = Buffer.isBuffer(req.body) && req.body.length > 100 && req.body[0] === 0xff && req.body[1] === 0xd8; // JPEG magic
  if (ok && !u.banned) fs.writeFileSync(shotPath(u.username), req.body);
  // clear the flag even on failure, so a page that cannot render is retried on its next edit, not forever
  db.prepare('UPDATE users SET shot_dirty = 0, shot_at = ? WHERE id = ?').run(ok ? now() : u.shot_at, u.id);
  res.sendStatus(204);
});
main.get('/shots/:name.jpg', (req, res) => {
  const u = q.userByName.get(req.params.name);
  if (!u || !u.verified || u.banned || !fs.existsSync(shotPath(u.username))) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=300').type('image/jpeg').sendFile(shotPath(u.username));
});

// Caddy's on-demand TLS asks here before it gets a certificate for a host it has none for: one indexed lookup, no DNS
main.get('/internal/tls-check', (req, res) => res.sendStatus(domains.ask(req.query.domain) ? 200 : 404));

// uptime monitor: 200 when the database answers and the disk has room, 503 otherwise
main.get('/healthz', (req, res) => {
  let dbOk = false;
  let diskOk = false;
  try { dbOk = db.prepare('SELECT 1 AS one').get().one === 1; } catch { /* reported below */ }
  try { const s = fs.statfsSync(SITES_DIR); diskOk = s.bavail / s.blocks >= HEALTH_MIN_FREE; } catch { /* reported below */ }
  res.set('Cache-Control', 'no-store').status(dbOk && diskOk ? 200 : 503).json({ ok: dbOk && diskOk, db: dbOk, disk: diskOk });
});

// Stripe tells us when a subscription starts, renews or ends. Signed with STRIPE_WEBHOOK_SECRET over the raw body,
// so it sits ahead of the form parser and the CSRF/Origin check, and carries no session
main.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!billing) return res.sendStatus(404);
  try {
    await billing.receive(req.body, req.get('stripe-signature'));
    res.json({ received: true });
  } catch (e) {
    if (e instanceof BadSignature) return res.status(400).type('text').send('Bad signature');
    console.error('stripe webhook failed:', e.message);
    res.sendStatus(500); // Stripe retries
  }
});


// the HTTP API takes a member's API key in the Authorization header and never reads the session cookie,
// so a page on another site can't use it with a visitor's login and it needs no CSRF token; its routes are under "HTTP API" below
const api = express.Router();
main.use('/api', api);

// session
main.use((req, res, next) => {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE);
  const s = sessions.lookup(m && m[1]);
  req.session = s;
  req.ctx = s
    ? withFlair({ cfg, user: s.user, login: s.login, csrf: s.csrf, isAdmin: isAdmin(s.user), nonce: res.locals.nonce, unread: social.unread(s.user), path: req.path })
    : withFlair({ cfg, user: null, csrf: '', isAdmin: false, nonce: res.locals.nonce, path: req.path });
  next();
});
// the editor posts whole files, and percent-escaping can triple a byte, so its cap tracks the member's file limit with room for that;
// every other form, signed in or not, keeps the parser's 100 KB default so nobody can make the app hold megabytes per request
const editorBody = (mb) => express.urlencoded({ extended: false, limit: (mb * 3 + 1) * 1048576 });
const freeBody = editorBody(cfg.MAX_FILE_MB);
const supporterBody = editorBody(Math.max(cfg.MAX_FILE_MB, cfg.SUPPORTER_MAX_FILE_MB));
main.use(['/dashboard/save', '/dashboard/style'], (req, res, next) => (req.ctx.user && limitsFor(req.ctx.user).anyType ? supporterBody : freeBody)(req, res, next));
main.use(express.urlencoded({ extended: false })); // skips a body already parsed above
main.use(bodyDefault);

// CSRF: every POST must come from this origin; logged-in POSTs also need the session token
const csrfOk = (req) => !req.session || req.session.csrfOk(req.body);
main.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin;
  if (origin && origin !== cfg.BASE_URL) return res.status(403).type('text').send('Cross-site request blocked');
  // multipart bodies are not parsed yet here, so their token is checked by bodyCheck once multer has run
  if (!req.is('multipart/form-data') && !csrfOk(req)) return res.status(403).type('text').send('Form expired. Go back, reload and try again.');
  next();
});
// after multer, for every multipart route (upload, import, the API's upload): the body's CSRF token, then whether the
// Session is still good, since the body can take long to arrive. 'csrf', 'signedOut' or 'ok'
const bodyCheck = (req) => (!csrfOk(req) ? 'csrf' : !req.session.current() ? 'signedOut' : 'ok');
const auth = (req, res, next) => (req.ctx.user ? next() : res.redirect('/login'));
// a form's body has arrived by now and can take a long time to; a ban, reset or deletion meanwhile must stop the write
// (multipart bodies arrive later, so they go through bodyCheck too)
const canEdit = (req, res, next) => (req.ctx.user.banned ? res.redirect('/dashboard')
  : req.method === 'POST' && !req.session.current() ? res.redirect('/login') : next());
// the social forms are open to taken-down members too (src/social.js turns their actions away), so only the sign-out half
main.post(['/follow', '/comment', '/comment/delete', '/like', '/block'], (req, res, next) => (req.session && !req.session.current({ takenDown: true }) ? res.redirect('/login') : next()));
const adminOnly = (req, res, next) => (req.ctx.isAdmin ? next() : res.status(404).send(V.notices.noSuchPage(req.ctx)));

// ----- SEO: robots, sitemap, brand assets -----
const ASSETS_DIR = path.join(__dirname, 'assets');
const asset = (file, type) => (req, res) => res.set('Cache-Control', 'public, max-age=86400').type(type).sendFile(path.join(ASSETS_DIR, file), (e) => { if (e && !res.headersSent) res.sendStatus(404); });
// the editor's CodeMirror, from node_modules; files never change under a versioned path
main.use(V.CM, express.static(path.dirname(require.resolve('codemirror/package.json')), { immutable: true, maxAge: '365d', index: false }));
main.get('/favicon.ico', asset('favicon.svg', 'image/svg+xml')); // shortcut: SVG at the .ico path; browsers and Google accept SVG favicons
main.get('/favicon.svg', asset('favicon.svg', 'image/svg+xml'));
main.get('/site.css', (req, res) => res.set('Cache-Control', 'public, max-age=31536000, immutable').type('text/css').sendFile(path.join(ASSETS_DIR, 'site.css'))); // its URL carries a hash of the file, see views.js
main.get('/og.svg', asset('og.svg', 'image/svg+xml'));
main.get('/og.png', asset('og.png', 'image/png')); // the share-preview raster; og:image points here because several scrapers ignore SVG
main.get('/img/supporter.svg', asset('supporter.svg', 'image/svg+xml'));
main.get('/img/pup-hero.webp', asset('pup-hero.webp', 'image/webp'));
main.get('/img/pup-coder.webp', asset('pup-coder.webp', 'image/webp'));
main.get('/img/pup-accident.webp', asset('pup-accident.webp', 'image/webp'));
main.get('/img/pup-guestbook.webp', asset('pup-guestbook.webp', 'image/webp'));
// backgrounds, buttons and effects member pages load from here, so they cache for a long time
main.get('/assets/:kind/:file', (req, res) => {
  const rel = `${req.params.kind}/${req.params.file}`;
  if (!W.ASSET_FILES.has(rel)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=2592000').type(path.extname(rel) === '.js' ? 'text/javascript' : 'image/svg+xml').sendFile(path.join(ASSETS_DIR, rel));
});
main.get('/robots.txt', (req, res) => res.type('text/plain').send(
  // /login, /signup, /forgot, /reset and /feed stay crawlable on purpose: they carry noindex tags,
  // which a crawler can only read if robots.txt lets it in. Only the auth-gated areas are disallowed.
  `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /admin\nDisallow: /internal/\n\nSitemap: ${cfg.BASE_URL}/sitemap.xml\n`));
main.get('/sitemap.xml', (req, res) => {
  const urls = [['/', null], ['/browse', null], ['/rules', null], ['/privacy', null],
    ...db.prepare(`SELECT username, updated_at FROM users WHERE ${listedWhere()} ORDER BY updated_at DESC`).all()
      .map((u) => [`/site/${u.username}`, new Date(u.updated_at).toISOString().slice(0, 10)])];
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([loc, mod]) => `<url><loc>${cfg.BASE_URL}${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
});

// ----- public pages -----
main.get('/', (req, res) => res.send(V.home(req.ctx, {
  sotw: db.prepare(`${WITH_FOLLOWERS} WHERE ${listedWhere()} AND u.sotw_at > 0`).all().map(hasShot)[0],
  picks: db.prepare(`${WITH_FOLLOWERS} WHERE ${listedWhere()} AND u.staff_pick > 0 ORDER BY u.staff_pick DESC LIMIT 8`).all().map(hasShot),
  recent: db.prepare(`${WITH_FOLLOWERS} WHERE ${listedWhere()} ORDER BY u.updated_at DESC LIMIT 8`).all().map(hasShot),
  newest: db.prepare(`SELECT * FROM users WHERE ${listedWhere()} ORDER BY id DESC LIMIT 10`).all(),
  total: db.prepare(`SELECT COUNT(*) n FROM users WHERE ${ONLINE}`).get().n,
  supporters: cfg.SUPPORT_ON ? db.prepare(`SELECT COUNT(*) n FROM users WHERE ${supporterUntilSql()} > ?`).get(now()).n : 0,
})));
const SORTS = { updated: 'u.updated_at DESC', newest: 'u.id DESC', followed: 'followers DESC, u.updated_at DESC', hits: 'u.hits DESC' };
const hasShot = (r) => ({ ...r, shot: fs.existsSync(shotPath(r.username)) });
const cards = createCardStyles({ db, siteDir });
cards.rebuild(); // before listening
// Card art: a file of a style's art list, straight from the Site folder, for Sites /browse shows, and for the Site's own
// session too, so the /dashboard/card preview of a hidden or new Site has its art. Never counts toward bandwidth
// (that is counted on member hosts only). sandbox and nosniff keep it an image even if a browser opens it as a page.
main.get('/card-art/:name/*path', (req, res) => {
  res.set('Content-Security-Policy', 'sandbox').set('X-Content-Type-Options', 'nosniff');
  const site = db.prepare(`SELECT *, ${listedWhere()} AS shown FROM users WHERE username = ? AND (${listedWhere()} OR (${ONLINE} AND id = ?))`)
    .get(req.params.name, req.ctx.user?.id ?? 0);
  const f = site && cards.art(site, req.params.path.join('/'));
  if (!f) return res.status(404).type('text').send('Not found');
  res.set('Cache-Control', site.shown ? 'public, max-age=86400' : 'private, no-store').type(f.type).send(f.buf);
});
main.get('/browse', (req, res) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'updated';
  const search = String(req.query.q || '').trim().toLowerCase().slice(0, 50);
  // part of a site name or tag; instr, not LIKE, so % and _ in the search are plain characters
  const where = `${listedWhere()}${search ? ' AND (instr(username, @search) OR instr(tags, @search))' : ''}`;
  const total = db.prepare(`SELECT COUNT(*) n FROM users WHERE ${where}`).get({ search }).n;
  const pages = Math.max(1, Math.ceil(total / 24));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = db.prepare(`${WITH_FOLLOWERS} WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT 24 OFFSET @offset`).all({ offset: (page - 1) * 24, search }).map(hasShot);
  // member CSS changes whenever a card style is saved, so the page itself is never cached
  res.set('Cache-Control', 'no-store').send(V.browse(req.ctx, { rows, page, pages, sort, q: search, cardCss: cards.cssFor(rows) }));
});
function showProfile(req, res, name, m, status = 200) {
  const p = db.prepare(`${WITH_FOLLOWERS} WHERE u.username = ? AND ${ONLINE}`).get(String(name).toLowerCase());
  if (!p) {
    const to = names.renamedTo(String(name).toLowerCase());
    if (to) return res.set('Cache-Control', 'public, max-age=86400').redirect(301, `/site/${to}`);
    return res.status(404).send(V.notices.noSuchSite(req.ctx));
  }
  const me = req.ctx.user;
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  res.status(status).send(V.profile(req.ctx, m, {
    p: hasShot(p),
    following: social.isFollowing(me, p),
    blocking: social.blocking(me, p),
    login: me && loginOf(me),
    comments: social.comments(me, { owner: p, ev: null }, req.query.cpage),
    events: social.details(db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(p.id), me),
    followers: social.follows(p, 'followers', req.query.fpage),
    follows: social.follows(p, 'following', req.query.gpage),
  }));
}
// only the owner sees ?ok= notices, so a crafted link cannot show visitors a fake one
main.get('/site/:name', (req, res) => showProfile(req, res, req.params.name,
  req.query.ok && req.ctx.user && req.ctx.user.username === String(req.params.name).toLowerCase() ? { ok: String(req.query.ok) } : null));
main.post('/follow', (req, res) => {
  const me = req.ctx.user;
  if (!me) return res.redirect('/login');
  const target = q.userByName.get(String(req.body.site || '').toLowerCase());
  const r = target && (req.body.action === 'unfollow' ? social.unfollow(me, target) : social.follow(me, target));
  res.redirect(!r || r === 'gone' ? '/browse' : `/site/${target.username}`);
});

// ----- comments, likes, blocks, notifications (src/social.js) -----
// the page asked for in ?<key>=, kept within the pages there are
const pageOf = (req, total, key = 'page') => U.pageOf(total, req.query[key]);
// a comment or like lands back on the page of ours it was made from, never on another site
const BACK = /^\/(feed|notifications|site\/[a-z0-9-]+(\/update\/\d+)?)$/;
const backTo = (req, owner) => (BACK.test(String(req.body.back || '')) ? req.body.back : `/site/${owner.username}`);
main.post('/comment', (req, res) => {
  const me = req.ctx.user;
  if (!me) return res.redirect('/login');
  const on = social.target(req.body);
  if (!on || me.banned) return res.redirect('/browse');
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (req.body.website || !body) return res.redirect(backTo(req, on.owner)); // bot filled the hidden field, or nothing written
  if (social.comment(me, on, body, { ip: req.ip }) === 'limited') return res.status(429).send(V.notices.tooManyComments(req.ctx));
  res.redirect(backTo(req, on.owner));
});
main.post('/comment/delete', auth, (req, res) => {
  social.deleteComment(req.ctx.user, req.body.id);
  res.redirect(backTo(req, req.ctx.user));
});
main.post('/like', (req, res) => {
  const me = req.ctx.user;
  if (!me) return res.redirect('/login');
  const on = social.target({ event: req.body.event || 0 });
  if (!on || me.banned) return res.redirect('/feed');
  if (req.body.action === 'unlike') social.unlike(me, on);
  else social.like(me, on);
  res.redirect(backTo(req, on.owner));
});
main.post('/block', auth, (req, res) => {
  const me = req.ctx.user;
  const target = q.userByName.get(String(req.body.site || '').toLowerCase());
  if (!target || target.id === me.id) return res.redirect('/browse');
  if (req.body.action === 'unblock') social.unblock(me, target);
  else social.block(me, target);
  res.redirect(`/site/${target.username}`);
});
// one update with every comment on it, a page at a time
main.get('/site/:name/update/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM users WHERE username = ? AND ${ONLINE}`).get(String(req.params.name).toLowerCase());
  const ev = p && db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(Number(req.params.id) || 0, p.id);
  if (!ev) return res.status(404).send(V.notices.updateGone(req.ctx));
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  res.send(V.update(req.ctx, { p, e: social.details([ev], req.ctx.user)[0], comments: social.comments(req.ctx.user, { owner: p, ev }, req.query.page) }));
});
// the newest page marks everything read; older pages carry ?since= so they still show what was new on arrival
main.get('/notifications', auth, (req, res) => {
  const user = req.ctx.user;
  const { rows, page, pages } = social.notifications(user, req.query.page);
  const seenAt = req.query.since !== undefined ? Number(req.query.since) || 0 : user.notes_seen_at;
  if (page === 1) social.seen(user);
  res.send(V.notifications(page === 1 ? { ...req.ctx, unread: 0 } : req.ctx, { rows, page, pages, seenAt }));
});
main.post('/notifications/settings', auth, (req, res) => {
  const digest = req.body.digest ? 1 : 0;
  // the first digest covers the week after opting in, not everything from before
  db.prepare('UPDATE users SET note_mail = @mail, digest_at = CASE WHEN digest = 0 AND @digest = 1 THEN @t ELSE digest_at END, digest = @digest WHERE id = @id')
    .run({ mail: NOTE_KINDS.filter((k) => req.body[k]).join(' '), digest, t: now(), id: req.ctx.user.id });
  res.redirect('/notifications');
});
main.get('/feed', (req, res) => {
  if (!req.ctx.user) return res.redirect('/login');
  const { events, count } = social.feed(req.ctx.user);
  res.send(V.feed(req.ctx, { events: events.map(hasShot), count }));
});
// Atom feeds: one per site (hidden sites too, like their profile), and the recently updated list without hidden or new sites
const atom = (res, feed) => res.set('Cache-Control', 'public, max-age=300').type('application/atom+xml').send(V.atom(cfg, feed));
main.get('/feed.xml', (req, res) => atom(res, {
  title: `${cfg.SITE_NAME}: recently updated`, path: '/feed.xml', link: `${cfg.BASE_URL}/browse`,
  events: db.prepare(`SELECT e.*, u.username FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.kind = 'update' AND e.user_id IN (SELECT id FROM users WHERE ${listedWhere()}) ORDER BY e.id DESC LIMIT 50`).all(),
}));
main.get('/site/:name/feed.xml', (req, res) => {
  const p = db.prepare(`SELECT * FROM users WHERE username = ? AND ${ONLINE}`).get(String(req.params.name).toLowerCase());
  if (!p) {
    const to = names.renamedTo(String(req.params.name).toLowerCase());
    return to ? res.set('Cache-Control', 'public, max-age=86400').redirect(301, `/site/${to}/feed.xml`) : res.sendStatus(404);
  }
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  atom(res, {
    title: `${p.username} on ${cfg.SITE_NAME}`, path: `/site/${p.username}/feed.xml`, link: cfg.siteUrl(p.username) + '/',
    events: db.prepare('SELECT *, ? AS username FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(p.username, p.id),
  });
});
const inRing = () => `${listedWhere()} AND webring = 1`;
const randomSite = (where) => (req, res) => {
  const r = db.prepare(`SELECT username FROM users WHERE ${where()} ORDER BY RANDOM() LIMIT 1`).get();
  res.redirect(r ? cfg.siteUrl(r.username) : '/');
};
main.get('/random', randomSite(listedWhere));
main.get('/webring/random', randomSite(inRing));
const webring = (next) => (req, res) => {
  const fromName = String(req.query.from || '').toLowerCase();
  const from = q.userByName.get(fromName) || q.userByName.get(names.renamedTo(fromName) || ''); // old webring snippets still name the site's old name
  const id = from ? from.id : 0;
  const ring = inRing();
  const r = next
    ? db.prepare(`SELECT username FROM users WHERE ${ring} AND id > ? ORDER BY id LIMIT 1`).get(id) || db.prepare(`SELECT username FROM users WHERE ${ring} ORDER BY id LIMIT 1`).get()
    : db.prepare(`SELECT username FROM users WHERE ${ring} AND id < ? ORDER BY id DESC LIMIT 1`).get(id || 1e15) || db.prepare(`SELECT username FROM users WHERE ${ring} ORDER BY id DESC LIMIT 1`).get();
  res.redirect(r ? cfg.siteUrl(r.username) : '/');
};
main.get('/webring/next', webring(true));
main.get('/webring/prev', webring(false));
main.get('/rules', (req, res) => res.send(V.rules(req.ctx)));
main.get('/terms', (req, res) => res.redirect(301, '/rules'));
main.get('/privacy', (req, res) => res.send(V.privacy(req.ctx)));

// ----- signup / login -----
main.get('/signup', (req, res) => res.send(V.signup(req.ctx)));
// full-page look at a starter layout, opened from the signup form
main.get('/starters/:id', (req, res) => {
  if (!starters.valid(req.params.id)) return res.status(404).send(V.notices.noSuchStarter(req.ctx));
  res.send(starters.preview(req.params.id, cfg));
});
main.post('/signup', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const starter = starters.valid(req.body.starter) ? req.body.starter : starters.DEFAULT;
  const fail = (err, code = 400) => res.status(code).send(V.signup(req.ctx, { err }, { username, email, starter }));
  if (req.body.website) return res.send(V.notices.signupBot(req.ctx)); // bot
  if (!U.limit(`signup:${req.ip}`, 5, 3600000)) return fail('Too many signups from your connection. Try again in an hour.', 429);
  if (!U.validUsername(username)) return fail('That site name is not available. Use 3-30 lowercase letters, numbers or hyphens.');
  if (!validEmail(email)) return fail('That email address does not look right.');
  if (password.length < 10 || password.length > 200) return fail('Use a password with at least 10 characters.');
  if (!req.body.agree) return fail('You need to be 13 or older and accept the rules.');
  if (names.taken(username)) return fail('That site name is taken.');
  if (q.userByEmail.get(email)) return fail('That email already has a site. Log in or reset your password.');
  if (!(await humanCheck(req))) return fail('The "are you human" check did not pass. Try again.');
  const pwHash = await U.hashPw(password);
  const t = now();
  let id;
  try {
    id = db.prepare('INSERT INTO users (username, email, pw_hash, signup_ip, starter, quota_mb, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(username, email, pwHash, req.ip, starter, cfg.QUOTA_MB, t, t).lastInsertRowid;
  } catch (err) {
    // a twin signup for the same name or email landed while the human check ran, so the checks above are stale;
    // anything that is not a constraint violation (a locked or full db) is a server error, not a conflict
    if (!String(err && err.code).includes('CONSTRAINT')) return fail('Something went wrong on our end. Try again.', 500);
    return fail(q.userByName.get(username) ? 'That site name is taken.' : 'That email already has a site. Log in or reset your password.');
  }
  try {
    await files.create(q.userById.get(id), starters.render(starter, username, cfg));
  } catch {
    try { logins.remove(q.userById.get(id), { hold: false }); } catch { /* roll the row back, but a folder that refuses to delete must not crash the signup too */ }
    return fail('Something went wrong making your site. Try again.', 500);
  }
  await sendMail(email, `Confirm your ${cfg.SITE_NAME} site`,
    `Welcome! Confirm your email to put ${username}.${cfg.BASE_HOST} online:\n\n${cfg.BASE_URL}/verify?token=${makeToken(id, 'verify', 2 * DAY)}\n\nIf you did not sign up, ignore this message.`);
  res.send(V.notices.signupSent(req.ctx, email));
});
main.get('/verify', (req, res) => {
  const user = useToken(req.query.token, 'verify');
  if (!user) return res.status(400).send(V.notices.signupLinkExpired(req.ctx));
  db.prepare('UPDATE users SET verified = 1, updated_at = ?, shot_dirty = 1 WHERE id = ?').run(now(), user.id);
  if (!user.verified) db.prepare("INSERT INTO events (user_id, kind, created_at) VALUES (?, 'join', ?)").run(user.id, now());
  if (user.totp_secret) return res.redirect('/login'); // an old signup link must not skip the second factor
  startSession(res, user.id);
  res.redirect('/dashboard');
});
main.get('/login', (req, res) => res.send(V.login(req.ctx)));
main.post('/login', async (req, res) => {
  // capped: the name keys an in-memory rate limit for a day, so a huge one would sit in memory that long
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 200);
  // site names can't contain @, so anything with one is an email
  const user = username.includes('@') ? q.userByEmail.get(username) : q.userByName.get(username);
  // count attempts per account, not per spelling, so switching between name and email doesn't double the guesses
  if (!U.limit(`login:${req.ip}`, 20, 900000) || !U.limit(user ? `login:id:${user.id}` : `login:name:${username}`, 10, 900000)) {
    return res.status(429).send(V.login(req.ctx, { err: 'Too many attempts. Wait 15 minutes and try again.' }, { username }));
  }
  const ok = !!user && isLogin(user) && (await U.checkPw(String(req.body.password || ''), user.pw_hash));
  const cur = ok && q.userById.get(user.id); // re-read: two-factor may have been turned on while the hash ran
  if (!cur || cur.pw_hash !== user.pw_hash) {
    return res.status(401).send(V.login(req.ctx, { err: 'Wrong site name, email or password.' }, { username }));
  }
  if (!user.verified) {
    if (U.limit(`reverify:${user.id}`, 3, 3600000)) {
      await sendMail(user.email, `Confirm your ${cfg.SITE_NAME} site`, `Confirm your email:\n\n${cfg.BASE_URL}/verify?token=${makeToken(user.id, 'verify', 2 * DAY)}`);
    }
    return res.send(V.notices.confirmFirst(req.ctx));
  }
  if (cur.totp_secret) return res.send(V.login2fa(req.ctx, null, makeToken(user.id, 'login2fa', 600000)));
  startSession(res, user.id);
  res.redirect('/dashboard');
});
// the second login step: the password was right, and the token says for whom, until a code from their app or a recovery code matches
main.post('/login/2fa', (req, res) => {
  const token = String(req.body.token || '');
  const user = peekToken(token, 'login2fa');
  if (!user) return res.status(400).send(V.notices.loginTimedOut(req.ctx));
  if (!U.limit(`login:${req.ip}`, 20, 900000) || !U.limit(`login2fa:${user.id}`, 10, 900000)) {
    return res.status(429).send(V.login2fa(req.ctx, { err: 'Too many attempts. Wait 15 minutes and try again.' }, token));
  }
  if (!useCode(user, req.body.code)) return res.status(401).send(V.login2fa(req.ctx, { err: 'That code is not right. Codes change every 30 seconds.' }, token));
  if (!useToken(token, 'login2fa')) return res.redirect('/login');
  startSession(res, user.id);
  res.redirect('/dashboard');
});
main.post('/logout', (req, res) => {
  if (req.session) sessions.end(req.session);
  clearSession(res);
  res.redirect('/');
});
main.get('/forgot', (req, res) => res.send(V.forgot(req.ctx)));
main.post('/forgot', async (req, res) => {
  const user = q.userByEmail.get(String(req.body.email || '').trim().toLowerCase());
  if (user && U.limit(`forgot:${user.id}`, 3, 3600000) && U.limit(`forgot:${req.ip}`, 10, 3600000)) {
    await sendMail(user.email, `Reset your ${cfg.SITE_NAME} password`, `Reset the password for ${user.username}:\n\n${cfg.BASE_URL}/reset?token=${makeToken(user.id, 'reset', 3600000)}\n\nThe link works for one hour. If you did not ask for this, ignore it.`);
  }
  res.send(V.notices.resetSent(req.ctx));
});
main.get('/reset', (req, res) => res.send(V.reset(req.ctx, null, String(req.query.token || ''))));
main.post('/reset', async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 10 || password.length > 200) return res.status(400).send(V.reset(req.ctx, { err: 'Use a password with at least 10 characters.' }, String(req.body.token || '')));
  const expired = () => res.status(400).send(V.notices.resetLinkExpired(req.ctx));
  if (!U.limit(`reset:${req.ip}`, 10, 3600000)) return res.status(429).send(V.notices.tooManyResets(req.ctx));
  if (!peekToken(req.body.token, 'reset')) return expired(); // hashing costs real time, so only for a link that works
  const pwHash = await U.hashPw(password); // before the token is spent, so nothing else can run between spending it and using it
  const user = useToken(req.body.token, 'reset');
  if (!user) return expired();
  db.prepare("UPDATE users SET pw_hash = ?, verified = 1 WHERE id = ?").run(pwHash, user.id);
  sessions.revokeApiKeys(user); // a reset may follow a break-in, so the API keys of all its sites go too
  sessions.endSessions(user);
  // the reset link proves the email only; with two-factor on, logging in still takes a code
  if (user.totp_secret) return res.send(V.notices.passwordSaved(req.ctx));
  startSession(res, user.id);
  res.redirect('/dashboard');
});

// ----- dashboard -----
function showDashboard(req, res, m, status = 200) {
  const user = req.ctx.user;
  let dir = U.safeRel(req.query.dir ?? req.body?.dir ?? '', { file: false });
  let full = dir === null ? null : resolveIn(user, dir);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) { dir = ''; full = siteDir(user.username); fs.mkdirSync(full, { recursive: true }); }
  const entries = fs.readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? fs.statSync(path.join(full, e.name)).size : 0 }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
  res.status(status).send(V.dashboard(req.ctx, m, { dir, entries, used: files.usage(user.username), quota: limitsFor(user).quotaMB, fileMB: limitsFor(user).fileMB, support: cfg.SUPPORT_ON || isSupporter(user), bandwidth: bwToday(user), listed: listing.isListed(user), hasIndex: hasIndex(user), cardError: !user.banned && !!cards.of(user).error, cardCleared: !user.banned && !!cards.of(user).note, sites: sitesOf(user), canAdd: isSupporter(user) && !user.banned && sitesOf(user).length < MAX_SITES, domain: domainView(user) }));
}
// what the dashboard's Custom domain fold needs; null while the flag is off
const domainView = (user) => cfg.CUSTOM_DOMAINS && {
  claim: domains.of(user), supporter: isSupporter(user), graceEnd: domains.graceEnd(user), ours: domains.ours(), MISSES: domains.MISSES,
  // what deleting this site, or the whole login, stops
  doomed: (isLogin(user) ? sitesOf(user) : [user]).map((s) => domains.of(s)).filter((c) => c && c.state !== 'ended').map((c) => c.host),
};
const hasIndex = (user) => { try { return fs.statSync(path.join(siteDir(user.username), 'index.html')).isFile(); } catch { return false; } };
// ?ok= and ?err= carry the result of a redirect (and of the drag-and-drop uploader); the dashboard is only ever shown to its owner
const msgOf = (req) => (req.query.ok || req.query.err ? { ok: String(req.query.ok || ''), err: String(req.query.err || '') } : null);
main.get('/dashboard', auth, (req, res) => showDashboard(req, res, msgOf(req)));

const savedMsg = (saved, skipped, verb) => ({
  ok: saved.length ? `${verb} ${saved.length} file${saved.length === 1 ? '' : 's'}.` : '',
  err: skipped.length ? `Skipped: ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ` and ${skipped.length - 20} more` : ''}. Allowed types: ${[...U.ALLOWED_EXT].join(', ')}.` : '',
});

const tmpStorage = multer.diskStorage({ destination: UPLOAD_TMP, filename: (req, file, cb) => cb(null, `up-${crypto.randomBytes(8).toString('hex')}`) });
// up to 20 files a request, each within the member's file size limit; preservePath keeps folders in names for the API
const uploadFiles = (req, res, cb, preservePath = false) => multer({ storage: tmpStorage, preservePath, limits: { fileSize: limitsFor(req.ctx.user).fileMB * 1048576, files: 20 } }).array('files', 20)(req, res, cb);
const uploadBudget = tempBudget((req) => 20 * limitsFor(req.ctx.user).fileMB * 1048576);
// The plain form gets the dashboard back; the drag-and-drop uploader asks for JSON so it can send many batches and sum them up
main.post('/dashboard/upload', auth, canEdit, uploadBudget, (req, res, next) => uploadFiles(req, res, (err) => {
  handleUpload(req, res, err).catch(next).finally(() => dropTemp(req.files || []));
}));
async function handleUpload(req, res, err) {
  const json = req.accepts(['html', 'json']) === 'json';
  const fail = (msg, code) => (json ? res.status(code).json({ error: msg }) : showDashboard(req, res, { err: msg }, code));
  const body = bodyCheck(req);
  if (body === 'csrf') return fail('Form expired. Reload the page and try again.', 403);
  if (body === 'signedOut') return signedOut(req, res);
  if (err) return fail(err.code === 'LIMIT_FILE_SIZE' ? `Files can be at most ${limitsFor(req.ctx.user).fileMB} MB each.` : 'Upload failed. Send at most 20 files at a time.', 400);
  const dir = U.safeRel(req.body.dir || '', { file: false });
  if (dir === null) return fail('That folder name is not allowed.', 400);
  const ups = (req.files || []).map((f) => ({ name: path.basename(f.originalname.replace(/\\/g, '/')), path: f.path, size: f.size }));
  if (req.body.shrink === '1') {
    for (const f of ups) f.size = await U.shrinkImage(f.path, f.name);
    // the shrinking took a while; a ban, reset or deletion meanwhile must still stop the write
    if (!req.session.current()) return signedOut(req, res);
  }
  const { saved, skipped } = files.writeMany(req.ctx.user, dir, ups);
  if (json) return res.json({ saved: saved.length, skipped });
  showDashboard(req, res, savedMsg(saved, skipped, 'Uploaded'));
}

// Import a whole site from one .zip, unpacked into the current folder
const zipUpload = multer({ storage: tmpStorage, limits: { fileSize: cfg.ZIP_MAX_MB * 1048576, files: 1 } }).single('zip');
main.post('/dashboard/import', auth, canEdit, tempBudget((req) => (cfg.ZIP_MAX_MB + limitsFor(req.ctx.user).quotaMB) * 1048576), (req, res, next) => zipUpload(req, res, (err) => importZip(req, res, err).catch(next).finally(() => dropTemp([req.file]))));
async function importZip(req, res, err) {
  const body = bodyCheck(req);
  if (body === 'csrf') return res.status(403).type('text').send('Form expired. Go back, reload and try again.');
  if (body === 'signedOut') return res.redirect('/login');
  if (err) return showDashboard(req, res, { err: err.code === 'LIMIT_FILE_SIZE' ? `Zip files can be at most ${cfg.ZIP_MAX_MB} MB.` : 'Import failed. Send one .zip file.' }, 400);
  if (!req.file) return showDashboard(req, res, { err: 'Choose a .zip file to import.' }, 400);
  const dir = U.safeRel(req.body.dir || '', { file: false });
  if (dir === null) return showDashboard(req, res, { err: 'That folder name is not allowed.' }, 400);
  if (!U.limit(`import:${req.ctx.user.id}`, 10, 3600000)) return showDashboard(req, res, { err: 'That is a lot of imports. Try again in an hour.' }, 429);
  let zip;
  try {
    const lim = limitsFor(req.ctx.user);
    zip = await readZip(req.file.path, { tmpDir: UPLOAD_TMP, maxFileBytes: lim.fileMB * 1048576, maxTotalBytes: lim.quotaMB * 1048576, allowed: (name) => !!files.relFor(req.ctx.user, dir, name) });
  } catch (e) {
    return showDashboard(req, res, { err: `That zip file could not be read (${e.message}). Nothing was imported.` }, 400);
  }
  try {
    if (!req.session.current()) return res.redirect('/login'); // signed out, banned or deleted while the zip unpacked
    const { saved, skipped } = files.writeMany(req.ctx.user, dir, zip.files);
    showDashboard(req, res, savedMsg(saved, [...zip.skipped, ...skipped], 'Imported'));
  } finally {
    dropTemp(zip.files);
  }
}

// the member's whole site as one zip: their own backup, or their bags packed to move elsewhere
main.get('/dashboard/download', auth, (req, res) => {
  const user = req.ctx.user;
  if (!U.limit(`download:${user.id}`, 10, 3600000)) return showDashboard(req, res, { err: 'That is a lot of downloads. Try again in an hour.' }, 429);
  res.set('Content-Type', 'application/zip').set('Cache-Control', 'no-store')
    .set('Content-Disposition', `attachment; filename="${user.username}-${new Date().toISOString().slice(0, 10)}.zip"`);
  const zip = writeZip(siteDir(user.username));
  zip.on('error', (e) => { console.error('zip download failed:', e.message); res.destroy(); });
  zip.pipe(res);
});

// the member's pictures for the editor's image picker
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const siteImages = async (user, rel) => (/\.html?$/i.test(rel) ? (await files.list(user)).filter((f) => IMAGE.test(f)).sort() : []);
main.get('/dashboard/edit', auth, canEdit, async (req, res) => {
  const rel = U.safeRel(req.query.path);
  const full = rel && U.TEXT_EXT.has(U.extOf(rel)) && resolveIn(req.ctx.user, rel);
  if (!full) return showDashboard(req, res, { err: 'Use a path like about.html or pics/index.html, made of letters, numbers, dots, hyphens and underscores, ending in a text type (html, css, js, txt, md, json, xml, svg).' }, 400);
  const exists = fs.existsSync(full) && fs.statSync(full).isFile();
  // a new page starts as a copy of the member's starter layout, already using their puppypad.css
  const blank = /\.html?$/i.test(rel) ? style.link(starters.render(req.ctx.user.starter, req.ctx.user.username, cfg)) : '';
  // "Add to a page" on the widgets page: the editor offers that widget's snippet to insert at the cursor
  const insert = req.query.widget ? W.snippet(cfg, req.ctx.user, String(req.query.widget), isSupporter(req.ctx.login)) : null;
  res.send(V.editor(req.ctx, null, { rel, content: exists ? fs.readFileSync(full, 'utf8') : blank, isNew: !exists, images: await siteImages(req.ctx.user, rel), insert }));
});
main.post('/dashboard/save', auth, canEdit, async (req, res) => {
  const user = req.ctx.user;
  const rel = U.safeRel(req.body.path);
  const full = rel && U.TEXT_EXT.has(U.extOf(rel)) && resolveIn(user, rel);
  if (!full) return res.status(400).send(V.notices.badPath(req.ctx));
  const content = String(req.body.content ?? '').replace(/\r\n/g, '\n');
  const isNew = !(fs.existsSync(full) && fs.statSync(full).isFile());
  const err = files.write(user, rel, content);
  const images = await siteImages(user, rel);
  if (err) return res.status(400).send(V.editor(req.ctx, { err: `Not saved: ${err}.` }, { rel, content, isNew, images }));
  res.send(V.editor(req.ctx, { ok: 'Saved. Your page is live.' }, { rel, content, isNew: false, images }));
});
// the style editor writes puppypad.css; it never touches a page without asking
const readText = (full) => { try { return fs.readFileSync(full, 'utf8'); } catch { return null; } };
main.get('/dashboard/style', auth, canEdit, async (req, res) => {
  const user = req.ctx.user;
  const root = siteDir(user.username);
  const css = readText(path.join(root, 'puppypad.css'));
  const index = readText(path.join(root, 'index.html'));
  const preset = Object.hasOwn(style.PRESETS, req.query.preset) ? style.PRESETS[req.query.preset] : null;
  res.send(V.styleEditor(req.ctx, msgOf(req), {
    s: style.clean(preset) || style.parse(css) || style.clean(style.PRESETS.sky),
    page: index ?? starters.render(user.starter, user.username, cfg),
    tail: style.tail(css),
    offerLink: css !== null && index !== null && !style.hasLink(index),
    images: (await files.list(user)).filter((f) => style.IMAGE.test(f)).sort(), // for "use my own" background
  }));
});
main.post('/dashboard/style', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  // "one of my own pictures" sends the picture in a separate field
  const s = style.clean({ ...req.body, bg: req.body.bg === 'own' ? req.body.ownbg : req.body.bg });
  if (!s) return res.redirect(`/dashboard/style?err=${encodeURIComponent('Pick each setting from the form.')}`);
  const full = path.join(siteDir(user.username), 'puppypad.css');
  const err = files.write(user, 'puppypad.css', style.merge(readText(full), s, cfg.BASE_URL));
  if (err) return res.redirect(`/dashboard/style?err=${encodeURIComponent(`Not saved: ${err}.`)}`);
  res.redirect(`/dashboard/style?ok=${encodeURIComponent('Saved puppypad.css.')}`);
});
// card style: a little CSS for the current Site's card on /browse.
// save-and-check: the Site's card exactly as /browse renders it (same row, same cssFor), and why it is the Stock card when it is
const cardCheck = (user) => {
  const row = hasShot(db.prepare(`${WITH_FOLLOWERS} WHERE u.id = ?`).get(user.id));
  return { row, ...cards.check(row), listed: listing.isListed(user) };
};
main.get('/dashboard/card', auth, canEdit, (req, res) => {
  const c = cards.of(req.ctx.user);
  res.send(V.cardStyle(req.ctx, msgOf(req) || (c.error && { err: `${V.CARD_FAILS}: ${c.error}` }), c.source, c.note, cardCheck(req.ctx.user)));
});
main.post('/dashboard/card', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const source = String(req.body.css ?? '');
  if (!source.trim()) {
    cards.clear(user);
    return res.redirect(`/dashboard/card?ok=${encodeURIComponent('Card style removed. Your card is the stock card again.')}`);
  }
  const { error } = cards.save(user, source);
  // rejected: the page again, not a redirect, so the typed text stays; the saved style stays live
  if (error) return res.status(400).send(V.cardStyle(req.ctx, { err: `Not saved: ${error}` }, source, cards.of(user).note, cardCheck(user)));
  // bad art still saves; the page's status line and art list say so, and the card shows as the Stock card until it's fixed
  res.redirect(`/dashboard/card?ok=${encodeURIComponent('Saved your card style.')}`);
});
main.post('/dashboard/style/link', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const full = path.join(siteDir(user.username), 'index.html');
  const html = readText(full);
  if (html === null || style.hasLink(html)) return res.redirect('/dashboard/style');
  const err = files.write(user, 'index.html', style.link(html));
  if (err) return res.redirect(`/dashboard/style?err=${encodeURIComponent(`Not linked: ${err}.`)}`);
  res.redirect(`/dashboard/style?ok=${encodeURIComponent('Your front page now uses puppypad.css.')}`);
});
// put a starter layout back as the front page: straight away when there is none, after a confirm when it would replace one
main.post('/dashboard/starter', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  if (!starters.valid(req.body.starter)) return showDashboard(req, res, { err: 'Pick one of the starter layouts.' }, 400);
  const exists = hasIndex(user);
  if (exists && req.body.confirm !== '1') return res.send(V.starterConfirm(req.ctx, req.body.starter));
  if (!U.limit(`starter:${user.id}`, 20, 3600000)) return showDashboard(req, res, { err: 'That is a lot of fresh starts. Try again in an hour.' }, 429);
  // a fresh screenshot, but not an edit: a starter alone doesn't put a site on the public lists
  const err = files.write(user, 'index.html', starters.render(req.body.starter, user.username, cfg), { feed: false });
  if (err) return showDashboard(req, res, { err: `Not made: ${err}.` }, 400);
  db.prepare('UPDATE users SET starter = ? WHERE id = ?').run(req.body.starter, user.id);
  const name = starters.LIST.find((s) => s.id === req.body.starter).name;
  res.redirect(`/dashboard?ok=${encodeURIComponent(`${exists ? 'Replaced' : 'Made'} your front page (index.html) from the ${name} starter.`)}`);
});
main.post('/dashboard/delete', auth, canEdit, (req, res) => {
  files.deleteFiles(req.ctx.user, [req.body.path]);
  res.redirect(`/dashboard?ok=${encodeURIComponent('File deleted.')}`);
});
// rename or move a file or folder; folders keep their contents, and nothing is ever overwritten
const isDirAt = (full) => !!full && fs.existsSync(full) && fs.statSync(full).isDirectory();
main.get('/dashboard/move', auth, canEdit, (req, res) => {
  const from = U.safeRel(req.query.path, { file: false });
  const full = from && resolveIn(req.ctx.user, from);
  if (!full || !fs.existsSync(full)) return res.redirect(`/dashboard?err=${encodeURIComponent('That file or folder is not there any more.')}`);
  res.send(V.move(req.ctx, null, { from, to: from, dir: isDirAt(full) }));
});
main.post('/dashboard/move', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const from = U.safeRel(req.body.from, { file: false });
  const src = from && resolveIn(user, from);
  if (!src || !fs.existsSync(src)) return res.redirect(`/dashboard?err=${encodeURIComponent('That file or folder is not there any more.')}`);
  const to = String(req.body.to || '').trim().replace(/^\/+|\/+$/g, '');
  const err = files.move(user, from, to);
  if (err) return res.status(400).send(V.move(req.ctx, { err }, { from, to, dir: isDirAt(src) }));
  const moved = U.safeRel(to, { file: false }); // the path as stored: backslashes become folders
  const parent = moved.split('/').slice(0, -1).join('/');
  res.redirect(`/dashboard?dir=${encodeURIComponent(parent)}&ok=${encodeURIComponent(`Moved ${from} to ${moved}.`)}`);
});
// file history: deleted files to bring back, every kept version of one file, and putting an old version back
main.get('/dashboard/history', auth, async (req, res) => {
  const user = req.ctx.user;
  const all = await H.deleted(user.id, siteDir(user.username));
  const { page, pages } = pageOf(req, all.length);
  res.send(V.historyDeleted(req.ctx, msgOf(req), { rows: all.slice((page - 1) * PER_PAGE, page * PER_PAGE), page, pages, days: limitsFor(user).historyDays }));
});
main.get('/dashboard/history/file', auth, async (req, res) => {
  const user = req.ctx.user;
  const rel = U.safeRel(req.query.path);
  if (!rel || !U.TEXT_EXT.has(U.extOf(rel))) return showDashboard(req, res, { err: 'Only pages and other text files have a history.' }, 400);
  const tree = siteDir(user.username);
  const all = await H.versions(user.id, tree, rel);
  const { page, pages } = pageOf(req, all.length);
  res.send(V.history(req.ctx, msgOf(req), { rel, rows: all.slice((page - 1) * PER_PAGE, page * PER_PAGE), page, pages, exists: fs.existsSync(path.join(tree, rel)), days: limitsFor(user).historyDays }));
});
main.get('/dashboard/history/view', auth, async (req, res) => {
  const rel = U.safeRel(req.query.path);
  const old = rel && await H.show(req.ctx.user.id, siteDir(req.ctx.user.username), req.query.v, rel);
  if (!old) return res.status(404).type('text').send('That version is not kept any more.');
  // as plain text, so an old page shows its code and runs nothing on the main domain
  res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send(old);
});
main.post('/dashboard/history/restore', auth, canEdit, async (req, res) => {
  const user = req.ctx.user;
  const rel = U.safeRel(req.body.path);
  const full = rel && U.TEXT_EXT.has(U.extOf(rel)) && resolveIn(user, rel);
  const back = (kind, text) => res.redirect(`/dashboard/history/file?path=${encodeURIComponent(rel || '')}&${kind}=${encodeURIComponent(text)}`);
  const old = full && await H.show(user.id, siteDir(user.username), req.body.v, rel);
  if (!old) return back('err', 'That version is not kept any more.');
  if (!req.session.current()) return res.redirect('/login'); // H.show can wait behind other history work for this site
  const err = files.write(user, rel, old);
  if (err) return back('err', `Not restored: ${err}.`);
  back('ok', `Restored ${rel}. The version it replaced is kept in this list too.`);
});
main.get('/dashboard/links', auth, async (req, res) => {
  if (!U.limit(`links:${req.ctx.user.id}`, 30, 3600000)) return showDashboard(req, res, { err: 'That is a lot of link checks. Try again in an hour.' }, 429);
  res.send(V.links(req.ctx, await files.brokenLinks(req.ctx.user)));
});
const statsSince = () => new Date(now() - (STATS_DAYS - 1) * DAY).toISOString().slice(0, 10);
main.get('/dashboard/stats', auth, (req, res) => {
  const at = { id: req.ctx.user.id, since: statsSince() };
  res.send(V.stats(req.ctx, {
    days: db.prepare('SELECT day, SUM(views) views FROM page_views WHERE user_id = @id AND day >= @since GROUP BY day ORDER BY day DESC').all(at),
    pages: db.prepare('SELECT path, SUM(views) views FROM page_views WHERE user_id = @id AND day >= @since GROUP BY path ORDER BY views DESC, path LIMIT 30').all(at),
    referrers: db.prepare('SELECT host, SUM(views) views FROM referrers WHERE user_id = @id AND day >= @since GROUP BY host ORDER BY views DESC, host LIMIT 30').all(at),
  }));
});
main.post('/dashboard/tagline', auth, canEdit, (req, res) => {
  db.prepare('UPDATE users SET tagline = ? WHERE id = ?').run(String(req.body.tagline || '').trim().slice(0, 100), req.ctx.user.id);
  res.redirect(`/dashboard?ok=${encodeURIComponent('Description saved.')}`);
});
// up to 5 tags of lowercase letters, numbers and hyphens, kept space-separated
const cleanTags = (t) => [...new Set(String(t || '').toLowerCase().split(/[\s,#]+/).filter((x) => /^[a-z0-9][a-z0-9-]{0,23}$/.test(x)))].slice(0, 5).join(' ');
main.post('/dashboard/tags', auth, canEdit, (req, res) => {
  db.prepare('UPDATE users SET tags = ? WHERE id = ?').run(cleanTags(req.body.tags), req.ctx.user.id);
  res.redirect(`/dashboard?ok=${encodeURIComponent('Tags saved.')}`);
});
main.post('/dashboard/webring', auth, canEdit, (req, res) => {
  const join = req.body.webring === '1';
  db.prepare('UPDATE users SET webring = ? WHERE id = ?').run(join ? 1 : 0, req.ctx.user.id);
  res.redirect(`/dashboard/widgets?ok=${encodeURIComponent(join ? 'You joined the webring.' : 'You left the webring.')}`);
});
// several sites under one login (supporters): each extra site is a users row owned by the login row
main.post('/dashboard/sites/new', auth, canEdit, async (req, res) => {
  const owner = loginOf(req.ctx.user);
  const username = String(req.body.username || '').trim().toLowerCase();
  const fail = (e) => res.redirect(`/dashboard?err=${encodeURIComponent(e)}`);
  if (owner.banned) return fail('A moderator took this login down, so it cannot make new sites.');
  if (!isSupporter(owner)) return fail('Several sites under one login is for supporters.');
  if (sitesOf(owner).length >= MAX_SITES) return fail(`You can have up to ${MAX_SITES} sites.`);
  if (!U.validUsername(username)) return fail('That site name is not available. Use 3-30 lowercase letters, numbers or hyphens.');
  if (names.taken(username)) return fail('That site name is taken.');
  const t = now();
  try {
    db.prepare("INSERT INTO users (username, email, pw_hash, verified, login_id, signup_ip, starter, quota_mb, created_at, updated_at) VALUES (?,?,'!',1,?,?,?,?,?,?)")
      .run(username, `${username}@sites.invalid`, owner.id, req.ip, starters.DEFAULT, cfg.QUOTA_MB, t, t);
  } catch (err) { if (String(err && err.code).includes('CONSTRAINT')) return fail('That site name is taken.'); throw err; }
  try {
    await files.create(q.userByName.get(username), starters.render(starters.DEFAULT, username, cfg));
  } catch {
    logins.remove(q.userByName.get(username), { hold: false }); // never served, so its name is not held
    return fail('Something went wrong making that site. Nothing was changed.');
  }
  res.redirect(`/dashboard?ok=${encodeURIComponent(`Made ${username}. Switch to it from the list at the top.`)}`);
});
main.post('/dashboard/sites/switch', auth, (req, res) => {
  const target = sitesOf(req.ctx.user).find((s) => s.id === Number(req.body.id));
  if (target) sessions.move(req.session, target.id);
  res.redirect('/dashboard');
});
// a Custom domain for the current Site (src/domains.js); the dashboard shows its records and state
const domainBack = (res, kind, text) => res.redirect(`/dashboard?${kind}=${encodeURIComponent(text)}`);
main.post('/dashboard/domain', auth, canEdit, (req, res) => {
  const r = domains.add(req.ctx.user, req.body.host);
  if (r.err) return domainBack(res, 'err', r.err);
  domainBack(res, 'ok', `Added ${r.claim.host}. Put the two DNS records below in place, then press Check now.`);
});
main.post('/dashboard/domain/check', auth, async (req, res) => {
  if (!U.limit(`domaincheck:${req.ctx.user.id}`, 20, 3600000)) return domainBack(res, 'err', 'That is a lot of checks. Try again in an hour.');
  const c = await domains.check(req.ctx.user);
  if (!c) return res.redirect('/dashboard');
  domainBack(res, c.last_error ? 'err' : 'ok', c.last_error ? `Checked ${c.host}: ${c.last_error}.` : c.state === 'live' ? `${c.host} is live.` : `Checked ${c.host}.`);
});
main.post('/dashboard/domain/remove', auth, (req, res) => {
  const c = domains.of(req.ctx.user);
  if (domains.remove(req.ctx.user) && c.state !== 'ended') return domainBack(res, 'ok', `Removed ${c.host}. Your site is back at its own address.`);
  res.redirect('/dashboard');
});
main.post('/dashboard/hidden', auth, canEdit, (req, res) => {
  const hide = req.body.hidden === '1';
  db.prepare('UPDATE users SET hidden = ? WHERE id = ?').run(hide ? 1 : 0, req.ctx.user.id);
  res.redirect(`/dashboard?ok=${encodeURIComponent(hide ? 'Your site is hidden from browsing.' : 'Your site is back in the listings.')}`);
});
main.get('/dashboard/guestbook', auth, (req, res) => res.send(V.guestbookAdmin(req.ctx, null, guestbook.page(req.ctx.user, req.query.page, { all: true }), guestbook.blocked(req.ctx.user))));
// an entry's buttons send the page they were on, so the owner lands back there
const gbBack = (req) => `/dashboard/guestbook${Number(req.body.page) > 1 ? `?page=${Number(req.body.page)}` : ''}`;
main.post('/dashboard/guestbook/approve', auth, (req, res) => {
  guestbook.approve(req.ctx.user, req.body.id);
  res.redirect(gbBack(req));
});
main.post('/dashboard/guestbook/notify', auth, (req, res) => {
  guestbook.settings(req.ctx.user, { notify: req.body.notify });
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/settings', auth, (req, res) => {
  guestbook.settings(req.ctx.user, { words: req.body.words });
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/block-ip', auth, (req, res) => {
  guestbook.blockIp(req.ctx.user, req.body.id);
  res.redirect(gbBack(req));
});
main.post('/dashboard/guestbook/unblock-ip', auth, (req, res) => {
  guestbook.unblockIp(req.ctx.user, req.body.ip);
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/delete', auth, (req, res) => {
  guestbook.remove(req.ctx.user, req.body.id);
  res.redirect(gbBack(req));
});
// the password step of a signed-in action (sessions.confirmPassword); answers the request itself unless it passed
async function confirmed(req, res, action, fail, wrong) {
  const r = await sessions.confirmPassword(req.session, action, req.body.password);
  if (r === 'signedOut') res.redirect('/login');
  else if (r === 'limited') await fail(action === 'email' ? 'Too many attempts. Try again in an hour.' : 'Too many attempts. Wait 15 minutes and try again.', 429);
  else if (r === 'wrong') await fail(wrong, 400);
  return r === 'ok';
}
main.post('/account/password', auth, async (req, res) => {
  const user = loginOf(req.ctx.user); // an extra site has no password, email or 2FA of its own
  const fail = (err, code = 400) => showProfile(req, res, user.username, { err }, code);
  const password = String(req.body.new_password || '');
  if (!(await confirmed(req, res, 'password', fail, 'Your current password is wrong. Nothing was changed.'))) return;
  if (password.length < 10 || password.length > 200) return fail('Use a new password with at least 10 characters.');
  if (password !== String(req.body.confirm_password || '')) return fail('The two new passwords do not match.');
  if (await U.checkPw(password, user.pw_hash)) return fail('Your new password has to be different from the current one.');
  const pwHash = await U.hashPw(password);
  if (!req.session.current({ takenDown: true })) return res.redirect('/login');
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, user.id);
  // log out everywhere else and switch off the API keys, in case the old password leaked
  sessions.revokeApiKeys(user);
  sessions.endSessions(user, { except: req.session });
  res.redirect(`/site/${user.username}?ok=${encodeURIComponent('Password changed. Other devices are logged out.')}`);
});
// a new email takes effect only once its owner clicks the link sent there; the old address hears about it either way
main.post('/account/email', auth, async (req, res) => {
  const user = loginOf(req.ctx.user);
  const fail = (err, code = 400) => showProfile(req, res, user.username, { err }, code);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!(await confirmed(req, res, 'email', fail, 'Your password is wrong. Nothing was changed.'))) return;
  if (!validEmail(email)) return fail('That email address does not look right.');
  if (email === user.email) return fail('That is already your email address.');
  if (q.userByEmail.get(email)) return fail('That email already has a site.');
  db.prepare('UPDATE users SET new_email = ? WHERE id = ?').run(email, user.id);
  await sendMail(email, `Confirm your new ${cfg.SITE_NAME} email`,
    `Confirm this address for ${cfg.siteHost(user.username)}:\n\n${cfg.BASE_URL}/account/email/confirm?token=${makeToken(user.id, 'email', 2 * DAY)}\n\nThe link works for 48 hours. If you did not ask for this, ignore it.`);
  await sendMail(user.email, `Your ${cfg.SITE_NAME} email is being changed`,
    `Someone logged in as ${user.username} asked to move the account to ${email}. It changes once that address confirms.\n\nIf this was not you, reset your password now: ${cfg.BASE_URL}/forgot`);
  res.redirect(`/site/${user.username}?ok=${encodeURIComponent(`Check ${email} for a confirmation link. Your email changes when you click it.`)}`);
});
main.get('/account/email/confirm', (req, res) => {
  const user = useToken(req.query.token, 'email');
  if (!user || !user.new_email) return res.status(400).send(V.notices.emailLinkExpired(req.ctx));
  if (q.userByEmail.get(user.new_email)) return res.status(400).send(V.notices.emailTaken(req.ctx));
  db.prepare('UPDATE users SET email = ?, new_email = NULL WHERE id = ?').run(user.new_email, user.id);
  sendMail(user.email, `Your ${cfg.SITE_NAME} email was changed`,
    `The email for ${user.username} is now ${user.new_email}. Mail about the site goes there from now on.\n\nIf this was not you, write to ${cfg.ABUSE_EMAIL}.`);
  res.send(V.notices.emailChanged(req.ctx, user.new_email));
});
// every session of this member ends, this one too: for a login left open on a computer that isn't theirs
main.post('/account/logout-all', auth, (req, res) => {
  sessions.endSessions(req.ctx.user);
  clearSession(res);
  res.send(V.notices.loggedOutEverywhere(req.ctx));
});
const otpauth = (user, secret) => `otpauth://totp/${encodeURIComponent(`${cfg.SITE_NAME}:${user.username}`)}?secret=${secret}&issuer=${encodeURIComponent(cfg.SITE_NAME)}`;
// the setup page: the key as text, a link and a QR code, all for the same otpauth address
const twoFactorPage = async (req, m, secret) => {
  const uri = otpauth(req.ctx.user, secret);
  return V.twoFactor(req.ctx, m, secret, uri, await QRCode.toString(uri, { type: 'svg', margin: 2 }));
};
main.get('/account/2fa', auth, async (req, res) => {
  if (loginOf(req.ctx.user).totp_secret) return res.redirect(`/site/${req.ctx.user.username}#security`);
  const secret = U.newTotpSecret();
  res.set('Cache-Control', 'no-store').send(await twoFactorPage(req, null, secret));
});
main.post('/account/2fa/on', auth, async (req, res) => {
  const user = loginOf(req.ctx.user);
  const secret = String(req.body.secret || '');
  if (!/^[A-Z2-7]{32}$/.test(secret)) return res.redirect('/account/2fa');
  const fail = async (err, code = 400) => res.status(code).set('Cache-Control', 'no-store').send(await twoFactorPage(req, { err }, secret));
  if (!(await confirmed(req, res, '2fa', fail, 'Your password is wrong. Two-factor login is still off.'))) return;
  const step = U.totpStep(secret, String(req.body.code || '').replace(/\D/g, ''));
  if (!step) return fail('That code is not right. Check the key in your app and try the newest code.');
  const codes = Array.from({ length: 10 }, () => U.newTotpSecret().slice(0, 10).toLowerCase());
  if (!db.prepare("UPDATE users SET totp_secret = ?, totp_step = ?, totp_codes = ? WHERE id = ? AND totp_secret = ''").run(secret, step, codes.map(U.sha).join('\n'), user.id).changes) {
    return res.redirect(`/site/${user.username}#security`); // already on, from another tab
  }
  res.set('Cache-Control', 'no-store').send(V.recoveryCodes(req.ctx, codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`)));
});
main.post('/account/2fa/off', auth, async (req, res) => {
  const user = loginOf(req.ctx.user);
  const fail = (err, code = 400) => showProfile(req, res, user.username, { err }, code);
  if (!(await confirmed(req, res, '2fa', fail, 'Your password is wrong. Two-factor login is still on.'))) return;
  if (!useCode(q.userById.get(user.id), req.body.code)) return fail('That code is not right. Two-factor login is still on.');
  db.prepare("UPDATE users SET totp_secret = '', totp_step = 0, totp_codes = '' WHERE id = ?").run(user.id);
  res.redirect(`/site/${user.username}?ok=${encodeURIComponent('Two-factor login is off.')}#security`);
});
// a new site name: the folder, screenshot and open reports follow, and the old name is held for 90 days, redirecting here
main.post('/dashboard/rename', auth, canEdit, async (req, res) => {
  const user = req.ctx.user;
  const name = String(req.body.username || '').trim().toLowerCase();
  const fail = (err, code = 400) => showDashboard(req, res, { err }, code);
  const wait = user.renamed_at + cfg.RENAME_DAYS * DAY - now();
  if (wait > 0) return fail(`You can rename your site again in ${Math.ceil(wait / DAY)} day${Math.ceil(wait / DAY) === 1 ? '' : 's'}.`);
  if (name === user.username) return fail('That is already your site name.');
  if (!U.validUsername(name)) return fail('That site name is not available. Use 3-30 lowercase letters, numbers or hyphens.');
  if (!(await confirmed(req, res, 'rename', fail, 'Wrong password. Nothing was changed.'))) return;
  // a member may take back a name they gave up themselves
  let renamed;
  try { renamed = names.rename(user, name); } catch (err) {
    console.error('rename failed:', err.message);
    return fail('Something went wrong renaming your site. Nothing was changed.', 500);
  }
  if (renamed === 'taken') return fail('That site name is taken.');
  res.redirect(`/dashboard?ok=${encodeURIComponent(`Your site is now ${cfg.siteUrl(name)}. The old address redirects there for 90 days. Pages that spell out the old address or name need editing by hand.`)}`);
});
main.post('/dashboard/delete-account', auth, async (req, res) => {
  if (!(await confirmed(req, res, 'delete', (err, code) => showDashboard(req, res, { err }, code), 'Wrong password. Nothing was deleted.'))) return;
  if (!isLogin(req.ctx.user)) { // an extra site goes alone, and the session moves back to the login
    sessions.move(req.session, loginOf(req.ctx.user).id);
    logins.remove(req.ctx.user);
    return res.redirect(`/dashboard?ok=${encodeURIComponent(`Deleted ${req.ctx.user.username} and its files.`)}`);
  }
  if (billing && !(await billing.cancel(req.ctx.user))) return showDashboard(req, res, { err: 'Stripe could not be reached to cancel your supporter payments, so nothing was deleted. Try again in a little while.' }, 502);
  if (!req.session.current({ takenDown: true })) return res.redirect('/login'); // signed out while Stripe answered (a take-down ends every session too)
  logins.remove(req.ctx.user);
  clearSession(res);
  res.send(V.notices.accountDeleted(req.ctx));
});

// ----- supporter tier (Stripe) -----
// supporting is per login: an extra site's page shows and pays for the login that owns it
const supportPage = (req, res, m, status = 200) => res.status(status).send(V.support(req.ctx, m, {
  until: supporterUntil(req.ctx.login), customer: !!req.ctx.login.stripe_customer_id, limits: limitsFor(req.ctx.user),
}));
main.get('/dashboard/support', auth, (req, res) => (cfg.SUPPORT_ON || isSupporter(req.ctx.login) ? supportPage(req, res, msgOf(req)) : res.redirect('/dashboard')));
// Stripe's hosted Checkout takes the card; the webhook above turns the perks on once it is paid
// every try is a few Stripe calls, so they share a limit with the portal below
const supportLimited = (req, res) => !U.limit(`support:${req.ctx.login.id}`, 10, 900000) && supportPage(req, res, { err: 'Too many attempts. Wait 15 minutes and try again.' }, 429);
main.post('/dashboard/support', auth, async (req, res) => {
  if (!billing) return res.redirect('/dashboard');
  if (supportLimited(req, res)) return;
  try {
    const go = await billing.checkout(req.ctx.login, req.body.plan);
    if (!req.session.current({ takenDown: true })) return res.redirect('/login'); // signed out while Stripe answered (a take-down ends every session too)
    if (go.already) return supportPage(req, res, { err: 'You already support us. Manage it with the billing button below.' }, 409);
    res.redirect(303, go.url);
  } catch (e) {
    console.error('stripe checkout failed:', e.message);
    supportPage(req, res, { err: 'Stripe could not be reached. Nothing was charged; try again in a little while.' }, 502);
  }
});
// Stripe's Customer Portal: cancel, change the card, see receipts
main.post('/dashboard/support/portal', auth, async (req, res) => {
  if (!billing) return res.redirect('/dashboard/support');
  if (supportLimited(req, res)) return;
  try {
    const url = await billing.portal(req.ctx.login);
    if (!req.session.current({ takenDown: true })) return res.redirect('/login');
    if (!url) return res.redirect('/dashboard/support');
    res.redirect(303, url);
  } catch (e) {
    console.error('stripe portal failed:', e.message);
    supportPage(req, res, { err: 'Stripe could not be reached. Try again in a little while.' }, 502);
  }
});

// ----- widgets -----
main.get('/dashboard/widgets', auth, async (req, res) => res.send(V.widgets(req.ctx, msgOf(req), {
  groups: W.groups(cfg, req.ctx.user, isSupporter(req.ctx.login)),
  pages: (await files.list(req.ctx.user)).filter((f) => /\.html?$/i.test(f)).sort(),
})));
main.post('/dashboard/widgets/status', auth, canEdit, (req, res) => {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(W.cleanStatus(req.body.status), req.ctx.user.id);
  res.redirect(`/dashboard/widgets?ok=${encodeURIComponent('Status saved.')}`);
});
// an effect script goes into the member's site as their own file, through the same checks as a save; nothing already there is replaced
main.post('/dashboard/widgets/copy', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const back = (kind, text) => res.redirect(`/dashboard/widgets?${kind}=${encodeURIComponent(text)}`);
  const src = W.snippet(cfg, user, String(req.body.fx), isSupporter(req.ctx.login)) && W.effectSource(req.body.fx);
  if (!src) return back('err', 'Pick one of the effects.');
  const rel = `${req.body.fx}.js`;
  const full = resolveIn(user, rel);
  if (fs.existsSync(full)) return back('err', `You already have ${rel}. Rename or delete it first to copy a fresh one.`);
  const err = files.write(user, rel, src);
  if (err) return back('err', `Not copied: ${err}.`);
  back('ok', `Copied ${rel} into your site. Now add it to a page.`);
});

// ----- API key and HTTP API -----
main.get('/dashboard/api', auth, (req, res) => res.send(V.apiPage(req.ctx, null, { hasKey: !!req.ctx.user.api_key })));
// only the key's sha256 is kept, so the key itself is shown once, here
main.post('/dashboard/api', auth, async (req, res) => {
  const user = req.ctx.user;
  const show = (m, key = '', code = 200) => res.status(code).set('Cache-Control', 'no-store').send(V.apiPage(req.ctx, m, { hasKey: !!q.userById.get(user.id).api_key, key }));
  if (req.body.action === 'revoke') {
    db.prepare("UPDATE users SET api_key = '' WHERE id = ?").run(user.id);
    return show({ ok: 'Your API key is switched off.' });
  }
  if (user.banned) return res.redirect('/dashboard');
  // a key outlives the session, so making one takes the password, as a rename does
  if (!(await confirmed(req, res, 'apikey', (err, code) => show({ err }, '', code), 'Wrong password. No key was made.'))) return;
  const key = `pp_${U.newToken()}`;
  db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(U.sha(key), user.id);
  show(null, key);
});
api.use((req, res, next) => {
  req.headers.accept = 'application/json'; // so shared steps like tempBudget answer in JSON
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  const s = sessions.forKey(m && m[1]);
  const user = s && s.user;
  if (!user || !user.verified) return res.status(401).json({ error: 'Missing or unknown API key. Make one at /dashboard/api.' });
  if (user.banned) return res.status(403).json({ error: 'A moderator took this site down. Editing is disabled.' });
  if (!U.limit(`api:${user.id}`, 120, 60000)) return res.status(429).set('Retry-After', '60').json({ error: 'Too many requests. Wait a minute.' });
  req.session = s;
  req.ctx = { cfg, user, csrf: '', isAdmin: false, nonce: '' };
  next();
});
api.get('/site', (req, res) => {
  const u = req.ctx.user;
  const used = files.usage(u.username);
  const lim = limitsFor(u);
  res.json({
    name: u.username, url: `${cfg.siteUrl(u.username)}/`, profile: `${cfg.BASE_URL}/site/${u.username}`, listed: listing.isListed(u), hidden: !!u.hidden,
    used_bytes: used.total, quota_bytes: lim.quotaMB * 1048576, files: used.count, max_files: MAX_FILES, max_file_bytes: lim.fileMB * 1048576,
    bandwidth_today_bytes: bwToday(u), bandwidth_cap_bytes: cfg.BANDWIDTH_MB * 1048576, hits: u.hits, updated_at: new Date(u.updated_at).toISOString(),
    allowed_types: [...U.ALLOWED_EXT], any_type: lim.anyType,
  });
});
api.get('/files', async (req, res) => {
  const root = siteDir(req.ctx.user.username);
  const list = [];
  for (const f of (await files.list(req.ctx.user)).sort()) {
    try {
      const full = path.join(root, f);
      const st = await fs.promises.stat(full);
      // the CLI compares hashes to skip unchanged files; mtimes mean nothing after a git checkout
      // shortcut: hashes the whole site on every listing (500 MB at most); cache by size and mtime if listings get slow
      const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(full)).digest('hex');
      list.push({ path: f, size: st.size, modified: st.mtime.toISOString(), sha256 });
    } catch { /* deleted meanwhile */ }
  }
  res.json({ files: list });
});
// preservePath keeps the folders in a filename like pics/cat.png, so one request can upload a whole tree
api.post('/upload', uploadBudget, (req, res, next) => uploadFiles(req, res, (err) => {
  try {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files can be at most ${limitsFor(req.ctx.user).fileMB} MB each.` : 'Upload failed. Send at most 20 files at a time, in a field called "files".' });
    // an upload can take a while to arrive; a new key, a ban or a rename meanwhile stops the write
    if (bodyCheck(req) !== 'ok') return res.status(403).json({ error: 'The API key changed or the site was taken down during the upload.' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files. Send them in a field called "files".' });
    const dir = U.safeRel(req.body?.dir || '', { file: false });
    if (dir === null) return res.status(400).json({ error: 'That folder name is not allowed.' });
    const { saved, skipped } = files.writeMany(req.ctx.user, dir, req.files.map((f) => ({ name: f.originalname, path: f.path, size: f.size })));
    res.json({ saved, skipped });
  } catch (e) { next(e); } finally { dropTemp(req.files || []); }
}, true));
// one file as { path }, or up to 100 as { paths: [...] } with one history entry for the lot
api.post('/delete', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  if (!req.session.current()) return res.status(403).json({ error: 'The API key changed or the site was taken down during the request.' });
  const user = req.ctx.user;
  if (req.body?.paths !== undefined) {
    const list = [req.body.paths].flat();
    if (!list.length || list.length > 100) return res.status(400).json({ error: 'Send between 1 and 100 paths at a time.' });
    const rels = list.map((p) => U.safeRel(p, { anyType: true }));
    const bad = list.find((p, i) => !rels[i]);
    if (bad !== undefined) return res.status(400).json({ error: `That path is not allowed: ${String(bad).slice(0, 100)}` });
    return res.json(files.deleteFiles(user, rels));
  }
  const rel = U.safeRel(req.body?.path, { anyType: true });
  if (!rel) return res.status(400).json({ error: 'Send the path of one file, like pics/cat.png.' });
  if (!files.deleteFiles(user, [rel]).deleted.length) return res.status(404).json({ error: `There is no file called ${rel}.` });
  res.json({ deleted: rel });
});
// a file's bytes as stored, for the CLI's pull; served as a download so a member's page never runs on this origin
api.get('/file', (req, res) => {
  const rel = U.safeRel(req.query.path, { anyType: true });
  const full = rel && resolveIn(req.ctx.user, rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ error: `There is no file called ${String(req.query.path ?? '').slice(0, 100)}.` });
  res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' }).sendFile(full);
});
api.use((req, res) => res.status(404).json({ error: 'No such API endpoint. There are GET /api/site, GET /api/files, GET /api/file, POST /api/upload and POST /api/delete.' }));
// a bad body (malformed JSON, too big) answers in JSON with its own status, like every other API error
api.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status && err.status < 500 ? 'That request body could not be read.' : 'Something broke on our side. Try again.' });
});

// ----- reports + admin -----
main.get('/report', (req, res) => res.send(V.report(req.ctx, null, { site: String(req.query.site || '') })));
main.post('/report', async (req, res) => {
  const typed = String(req.body.site || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  // a Custom domain held by a Site (verified, live or failing) is filed against that Site; anything else by its first label
  const claim = domains.reportTarget(typed.split(/[/?#:]/)[0]);
  const siteName = claim ? claim.username : typed.split(/[./]/)[0];
  const text = String(req.body.details || '').trim().slice(0, 2000);
  const details = claim ? `via ${claim.host}${text ? `: ${text}` : ''}`.slice(0, 2000) : text;
  if (req.body.website) return res.send(V.notices.reportSent(req.ctx));
  if (!U.limit(`report:${req.ip}`, 5, 3600000)) return res.status(429).send(V.report(req.ctx, { err: 'Too many reports from your connection. Try again in an hour.' }, { site: siteName }));
  if (!q.userByName.get(siteName)) return res.status(400).send(V.report(req.ctx, { err: 'There is no site with that name.' }, { site: siteName }));
  if (!details) return res.status(400).send(V.report(req.ctx, { err: 'Tell us what is wrong.' }, { site: siteName }));
  db.prepare('INSERT INTO reports (site, reason, details, reporter_email, ip, created_at) VALUES (?,?,?,?,?,?)')
    .run(siteName, String(req.body.reason || 'Other').slice(0, 60), details, String(req.body.email || '').trim().slice(0, 200), req.ip, now());
  await sendMail(cfg.ABUSE_EMAIL, `[${cfg.SITE_NAME}] report: ${siteName}`, `${req.body.reason}\n\n${details}\n\nReview: ${cfg.BASE_URL}/admin`);
  res.send(V.notices.reportSent(req.ctx));
});

// who did what in /admin; names are stored as text so the log outlives deleted accounts
const adminLog = (req, action, site, detail = '') => db.prepare('INSERT INTO admin_log (admin, action, site, detail, created_at) VALUES (?,?,?,?,?)')
  .run(req.ctx.user.username, action, site, detail, now());
const showAdmin = (req, res, m) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  // instr, not LIKE, so % and _ in the search are plain characters
  const users = q
    ? db.prepare(`SELECT * FROM users WHERE instr(lower(username), lower(@q)) OR instr(lower(email), lower(@q)) OR signup_ip = @q
      OR id IN (SELECT site_id FROM custom_domains WHERE state != 'ended' AND instr(host, lower(@q))) ORDER BY id DESC LIMIT 50`).all({ q })
    : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 50').all();
  const open = db.prepare("SELECT COUNT(*) n FROM reports WHERE status = 'open'").get().n;
  const { page, pages } = pageOf(req, open, 'rpage');
  res.send(V.admin(req.ctx, m, {
    q,
    site: String(req.query.site || '').trim().slice(0, 100), // fills the site boxes after "act" on a report or member
    reports: { rows: db.prepare(`SELECT * FROM reports WHERE status = 'open' ORDER BY id DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all(), page, pages },
    log: db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100').all(),
    users: users.map((u) => ({ ...u, until: supporterUntil(u), disk: files.usage(u.username).total, bandwidth: bwToday(u), domain: domains.of(u) })),
    // Custom domains by state, and the failing ones with why; null while the flag is off
    domains: cfg.CUSTOM_DOMAINS && {
      counts: Object.fromEntries(db.prepare("SELECT state, COUNT(*) n FROM custom_domains WHERE state != 'ended' GROUP BY state").all().map((r) => [r.state, r.n])),
      failing: db.prepare("SELECT c.host, c.last_error, c.failing_since, u.username FROM custom_domains c JOIN users u ON u.id = c.site_id WHERE c.state = 'failing' ORDER BY c.failing_since LIMIT 100").all(),
    },
    signups: db.prepare("SELECT date(created_at / 1000, 'unixepoch') day, COUNT(*) n FROM users WHERE created_at >= unixepoch('now', 'start of day', '-13 days') * 1000 GROUP BY day ORDER BY day DESC").all(),
    stats: {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      banned: db.prepare('SELECT COUNT(*) n FROM users WHERE banned > 0').get().n,
      supporters: db.prepare(`SELECT COUNT(*) n FROM users WHERE ${supporterUntilSql()} > ?`).get(now()).n,
      open,
    },
    upgrade: upgrade.readState(DATA_DIR),
    sotw: db.prepare('SELECT username FROM users WHERE sotw_at > 0').get(),
    picks: db.prepare('SELECT username FROM users WHERE staff_pick > 0 ORDER BY staff_pick DESC').all(),
  }));
};
// ?ok= and ?err= carry the result of an upgrade request, redirected so a reload never re-sends the form
main.get('/admin', auth, adminOnly, (req, res) => showAdmin(req, res, msgOf(req)));
// asks scripts/upgrade-watch.sh on the host to look for a new version or install one (see src/upgrade.js)
main.post('/admin/upgrade', auth, adminOnly, (req, res) => {
  const back = (kind, text) => res.redirect(`/admin?${kind}=${encodeURIComponent(text)}`);
  const st = upgrade.readState(DATA_DIR);
  if (!st.watcher) return back('err', 'The upgrade watcher is not running on the server. See "Upgrades" in the README.');
  if (st.request || st.status === 'queued' || st.status === 'running') return back('err', 'An upgrade or check is already under way.');
  if (req.body.action === 'check') {
    upgrade.writeRequest(DATA_DIR, 'check');
    return back('ok', 'Checking for a new release.');
  }
  if (req.body.action === 'upgrade') {
    const target = String(req.body.target || '');
    // only the release this page showed, so nobody installs something they didn't see listed
    if (!upgrade.TAG.test(target) || target !== st.latest || !st.behind) return back('err', 'That release is no longer the newest one. Check again.');
    upgrade.writeRequest(DATA_DIR, `upgrade ${target}`);
    adminLog(req, 'upgrade', '', `${st.current || 'unknown'} -> ${target}`);
    return back('ok', 'Upgrade queued. The server backs up the database, then switches to the new release; the site blips for a few seconds.');
  }
  res.redirect('/admin');
});
// staff picks and the one site of the week, shown on the home page while the site is listed
main.post('/admin/feature', auth, adminOnly, (req, res) => {
  const target = q.userByName.get(String(req.body.site || '').trim().toLowerCase());
  const action = req.body.action;
  if (action === 'unsotw') {
    const was = db.prepare('SELECT username FROM users WHERE sotw_at > 0').get();
    if (was) db.transaction(() => { db.prepare('UPDATE users SET sotw_at = 0').run(); adminLog(req, 'clear site of the week', was.username); })();
    return showAdmin(req, res, { ok: 'No site of the week now.' });
  }
  // a pick can be removed from a site that was taken down since, so it doesn't come back with a restore
  if (!target || (action !== 'unpick' && (!target.verified || target.banned))) return showAdmin(req, res, { err: 'No live site with that name.' });
  const set = {
    pick: ['staff pick', 'UPDATE users SET staff_pick = @t WHERE id = @id', `${target.username} is a staff pick.`],
    unpick: ['remove staff pick', 'UPDATE users SET staff_pick = 0 WHERE id = @id', `${target.username} is no longer a staff pick.`],
    sotw: ['site of the week', 'UPDATE users SET sotw_at = CASE WHEN id = @id THEN @t ELSE 0 END', `${target.username} is the site of the week.`],
  }[action];
  if (!set) return res.redirect('/admin');
  db.transaction(() => { db.prepare(set[1]).run({ id: target.id, t: now() }); adminLog(req, set[0], target.username); })();
  showAdmin(req, res, { ok: set[2] });
});
main.post('/admin/report-close', auth, adminOnly, (req, res) => {
  const r = db.prepare("SELECT * FROM reports WHERE id = ? AND status = 'open'").get(Number(req.body.id) || 0);
  if (r) {
    db.transaction(() => {
      db.prepare("UPDATE reports SET status = 'closed' WHERE id = ?").run(r.id);
      adminLog(req, 'close report', r.site, `${r.reason}: ${r.details}`.slice(0, 200));
    })();
  }
  res.redirect(Number(req.body.rpage) > 1 ? `/admin?rpage=${Number(req.body.rpage)}` : '/admin'); // back to the page it was closed from
});
main.post('/admin/supporter', auth, adminOnly, (req, res) => {
  const target = q.userByName.get(String(req.body.site || '').trim().toLowerCase());
  if (!target || !isLogin(target)) return showAdmin(req, res, { err: 'No login with that site name.' });
  const days = Math.max(0, Math.min(3650, Number(req.body.days) || 0));
  // granted time only: paid time is Stripe's, so clearing a grant leaves a paying member supporting.
  // Clearing ends a running grant now rather than zeroing it, so a Custom domain's grace runs from now
  db.transaction(() => { db.prepare('UPDATE users SET supporter_granted_until = ? WHERE id = ?').run(days ? now() + days * DAY : Math.min(target.supporter_granted_until, now()), target.id); adminLog(req, 'supporter', target.username, `${days} days`); })();
  const paid = target.supporter_until > now();
  showAdmin(req, res, { ok: days ? `${target.username} is a supporter for ${days} days.` : paid ? `${target.username} has no granted time; Stripe support runs until ${new Date(target.supporter_until).toISOString().slice(0, 10)}.` : `${target.username} is no longer a supporter.` });
});
// clearing is an empty save done for the member; there's no lock, so a repeat offender gets a takedown instead
main.post('/admin/card-clear', auth, adminOnly, (req, res) => {
  const target = q.userByName.get(String(req.body.site || '').trim().toLowerCase());
  if (!target) return showAdmin(req, res, { err: 'No site with that name.' });
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!reason) return showAdmin(req, res, { err: 'Give a reason; the member sees it.' });
  const cleared = db.transaction(() => {
    if (!cards.clear(target, reason)) return false;
    adminLog(req, 'clear card style', target.username, reason);
    return true;
  })();
  showAdmin(req, res, cleared ? { ok: `Cleared the card style of ${target.username}.` } : { err: 'No card style on that site.' });
});
main.post('/admin/ban', auth, adminOnly, async (req, res) => {
  const target = q.userByName.get(String(req.body.site || '').trim().toLowerCase());
  if (!target) return showAdmin(req, res, { err: 'No site with that name.' });
  const action = req.body.action;
  const reason = String(req.body.reason || '').slice(0, 200);
  // there's no blocklist: a repeat offender gets their site taken down instead
  if (action === 'detach') {
    if (!reason.trim()) return showAdmin(req, res, { err: 'Give a reason; the member sees it.' });
    const c = domains.of(target);
    if (!c || c.state === 'ended') return showAdmin(req, res, { err: `${target.username} has no custom domain.` });
    db.transaction(() => { domains.detach(target, reason); adminLog(req, 'detach domain', target.username, `${c.host}: ${reason}`); })();
    return showAdmin(req, res, { ok: `Detached ${c.host} from ${target.username}.` });
  }
  if (isAdmin(target)) return showAdmin(req, res, { err: 'That is an admin account.' });
  if (action === 'delete') {
    if (billing && !(await billing.cancel(target))) return showAdmin(req, res, { err: `Stripe could not be reached to cancel ${target.username}'s supporter payments, so nothing was deleted.` });
    // the rows and the log entry commit together; the files go only after both have
    logins.remove(target, { inTransaction: (u) => adminLog(req, 'delete', u.username, reason) });
    return showAdmin(req, res, { ok: `Deleted ${target.username} and all its files.` });
  }
  // the state change and its log entry commit together, so no take-down or restore goes unrecorded;
  // either take-down ends every session of the login
  if (action === 'ban') {
    logins.takeDown(target, reason, { inTransaction: () => { adminLog(req, 'take down', target.username, reason); sessions.endSessions(target); } });
    return showAdmin(req, res, { ok: `${target.username} is offline.` });
  }
  if (logins.restore(target, { inTransaction: () => adminLog(req, 'restore', target.username) }) === 'login-down') {
    return showAdmin(req, res, { err: `${loginOf(target).username} is taken down, so ${target.username} stays down with it. Restore ${loginOf(target).username} first.` });
  }
  showAdmin(req, res, { ok: `${target.username} is back online.` });
});

main.use((req, res) => res.status(404).send(V.notices.notFound(req.ctx)));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // a body the parser refused (too big, malformed) is the sender's mistake, so it keeps its own 4xx status
  if (err.status >= 400 && err.status < 500) return res.status(err.status).type('text').send(err.status === 413 ? 'That form is too big to send.' : 'That request could not be read.');
  console.error(err);
  res.status(500).type('text').send('Something broke on our side. Try again.');
});

upgrade.ensureDir(DATA_DIR);

// housekeeping: expired sessions/tokens, old guestbook and report IPs, and accounts never confirmed after 3 days
const housekeeping = () => {
  // an error here must not kill the process: this runs from a timer with nobody watching
  try {
    sessions.sweep();
    names.sweep();
    guestbook.sweep();
    db.prepare('UPDATE reports SET ip = NULL WHERE ip IS NOT NULL AND created_at < ?').run(now() - IP_KEEP);
    const statsFrom = statsSince();
    db.prepare('DELETE FROM page_views WHERE day < ?').run(statsFrom);
    db.prepare('DELETE FROM referrers WHERE day < ?').run(statsFrom);
    for (const u of db.prepare('SELECT * FROM users WHERE verified = 0 AND created_at < ?').all(now() - 3 * DAY)) logins.remove(u);
    guestbook.sendDigests(); // a failed digest is retried at the next hourly run
    // weekly digests of updates from followed sites, for members who opted in; a quiet week sends nothing
    for (const u of db.prepare(`SELECT * FROM users WHERE digest = 1 AND digest_at < ? AND ${ONLINE}`).all(now() - 7 * DAY)) {
      const cutoff = now();
      const done = () => db.prepare('UPDATE users SET digest_at = ? WHERE id = ?').run(cutoff, u.id);
      const rows = social.digestFor(u, u.digest_at, cutoff);
      if (!rows.length) { done(); continue; }
      sendMail(loginOf(u).email, `This week on ${cfg.SITE_NAME}: ${rows.length} update${rows.length === 1 ? '' : 's'} from sites you follow`,
        `${rows.slice(0, 100).map((e) => `${e.username} ${V.eventText(e, (f) => f)}\n${cfg.siteUrl(e.username)}/`).join('\n\n')}${rows.length > 100 ? `\n\n...and ${rows.length - 100} more.` : ''}\n\nStop these emails: ${cfg.BASE_URL}/notifications`)
        .then((sent) => { if (sent) done(); }); // a failed digest is retried at the next hourly run
    }
    // temp files are removed when their request ends; anything an hour old was orphaned
    for (const f of fs.readdirSync(UPLOAD_TMP)) {
      const full = path.join(UPLOAD_TMP, f);
      try { if (now() - fs.statSync(full).mtimeMs > 3600000) fs.rmSync(full, { force: true }); } catch { /* finished with meanwhile */ }
    }
  } catch (e) { console.error('housekeeping failed:', e.message); }
  domains.housekeeping().catch((e) => console.error('custom domain checks failed:', e.message));
};
setInterval(housekeeping, 3600000).unref();
const refreshAll = () => files.refreshUsage().catch((e) => console.error('disk totals refresh failed:', e.message));
setInterval(refreshAll, 3600000).unref();
const sweepHistory = () => files.historySweep().catch((e) => console.error('file history sweep failed:', e.message));
setInterval(sweepHistory, DAY).unref();

module.exports = app; // tests import the app without starting a server
app.housekeeping = housekeeping;
app.setStripe = (client) => { billing = makeBilling(client); }; // tests bring an in-memory Stripe (test/fake-stripe.js)
app.forgetUsage = files.forgetUsage; // for tests that put files on disk behind the app's back
app.refreshUsage = files.refreshUsage;
app.historySweep = files.historySweep;
app.setDomainNet = (stub) => Object.assign(domainNet, stub); // tests stub DNS and HTTPS
app.domains = domains;

if (require.main === module) {
  const port = Number(env.PORT || 3000);
  app.listen(port, () => console.log(`${cfg.SITE_NAME} listening on :${port} for ${cfg.BASE_URL}`));
  refreshAll(); // so the first /admin view after a restart reads stored totals
  sweepHistory();
  if (cfg.CUSTOM_DOMAINS) domains.refreshOurs().catch(() => {}); // the dashboard's records table shows them
}
