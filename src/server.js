const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR, SITES_DIR, SHOTS_DIR } = require('./db');
const U = require('./util');
const V = require('./views');
const { readZip, writeZip } = require('./zip');
const starters = require('./starters');
const style = require('./style');
const upgrade = require('./upgrade');
const W = require('./widgets');
const H = require('./history');

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
  // the supporter tier is on only with all three Stripe settings; otherwise its pages are hidden and nobody can pay
  SUPPORT_ON: !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_ID),
  // a new site joins the public lists only after its first edit and once it is this old, so throwaway spam gets no audience
  NEW_SITE_HOURS: Number.isFinite(Number(env.NEW_SITE_HOURS)) && env.NEW_SITE_HOURS !== '' ? Number(env.NEW_SITE_HOURS) : 24,
  // matched on confirmed email, not site name, so nobody can grab admin by signing up with the right name first
  ADMIN_EMAILS: new Set((env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)),
  SECURE: base.protocol === 'https:',
  SHOT_TOKEN: env.SHOT_TOKEN || '',
  TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY || '', // signup captcha; off when unset
  siteUrl: (name) => `${base.protocol}//${name}.${base.host}`,
};
const COOKIE = cfg.SECURE ? '__Host-sid' : 'sid'; // __Host- stops member subdomains from overwriting it
const DAY = 86400000;
const NAME_HOLD = 90 * DAY; // a deleted site's name stays unclaimable this long, so nobody can take over a known address
const HEALTH_MIN_FREE = 0.05; // /healthz fails once less than 5% of the disk is free
const IP_KEEP = 90 * DAY; // guestbook and report IPs are erased after this; the privacy page promises it
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10); // UTC
const bwToday = (u) => (u.bw_day === today() ? u.bw_bytes : 0);
const HOTLINK_MEDIA = /\.(png|jpe?g|gif|webp|ico|bmp|svg|midi?|mp3|ogg|wav)$/i;
const BOT_UA = /bot|crawl|spider|slurp|preview|headless/i; // shortcut: a word list, not a bot database
const STATS_DAYS = 30;
const HOTLINK_PER_MIN = 60; // media requests a minute per site from pages on other domains
const SUPPORT_GRACE = 3 * DAY; // Stripe retries a failed renewal for a few days before giving up

const stripe = cfg.SUPPORT_ON ? new Stripe(env.STRIPE_SECRET_KEY) : null;
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
// a save or upload: bump the directory, queue a fresh screenshot, and log at most one feed event per hour,
// naming the files it changed (later changes in the same hour join that event)
// shortcut: keeps the newest 50 names per event, so "and N more" undercounts a bigger batch; store a count if that matters
const eventFiles = (old, rels) => [...new Set([...rels, ...lines(old)])].slice(0, 50).join('\n');
function markUpdated(userId, rels = []) {
  const t = now();
  const u = q.userById.get(userId);
  if (u) recordHistory(u, rels.join(' ') || 'change');
  db.prepare('UPDATE users SET updated_at = ?, shot_dirty = 1 WHERE id = ?').run(t, userId);
  const last = db.prepare("SELECT id, created_at, files FROM events WHERE user_id = ? AND kind = 'update' ORDER BY id DESC LIMIT 1").get(userId);
  if (last && t - last.created_at < 3600000) {
    if (rels.length) db.prepare('UPDATE events SET files = ? WHERE id = ?').run(eventFiles(last.files, rels), last.id);
    return;
  }
  db.prepare("INSERT INTO events (user_id, kind, files, created_at) VALUES (?, 'update', ?, ?)").run(userId, eventFiles('', rels), t);
  db.prepare('UPDATE users SET updates = updates + 1 WHERE id = ?').run(userId);
}
// queue a saved page or script for review if it looks like phishing or mining; one open flag per site at a time
// the types a browser runs as a page or script; supporters may upload the rarer ones (xhtml, shtml, mjs) too
const SCANNED = /\.(x?html?|shtml|m?js|svg|xml)$/i;
function autoFlag(user, rel, content) {
  if (!SCANNED.test(rel)) return;
  const signals = U.phishSignals(content);
  if (!signals.length || db.prepare("SELECT 1 FROM reports WHERE site = ? AND reason = 'Auto-flag' AND status = 'open'").get(user.username)) return;
  const details = `${rel}: ${signals.join(', ')}`;
  db.prepare("INSERT INTO reports (site, reason, details, created_at) VALUES (?, 'Auto-flag', ?, ?)").run(user.username, details, now());
  sendMail(cfg.ABUSE_EMAIL, `[${cfg.SITE_NAME}] auto-flag: ${user.username}`, `${details}\n\nReview: ${cfg.BASE_URL}/admin`);
}
const shotPath = (name) => path.join(SHOTS_DIR, `${name}.jpg`);
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
    return req.accepts(['html', 'json']) === 'json' ? res.status(503).json({ error: msg }) : res.status(503).send(V.notice(req.ctx, 'Try again soon', `<p>${msg}</p>`));
  }
  tempReserved += bytes;
  let held = true;
  const release = () => { if (held) { held = false; tempReserved -= bytes; } };
  res.on('finish', release).on('close', release);
  next();
};
const dropTemp = (files) => { for (const f of files) if (f && f.path) fs.rmSync(f.path, { force: true }); };
const LIVE = 'verified = 1 AND banned = 0';
// live, unhidden sites shown on the home page, the dog park, the sitemap and /random; the webring takes only those that joined it (profiles and addresses work for every live site)
const listedSince = () => Math.floor(now() - cfg.NEW_SITE_HOURS * 3600000);
const listed = () => `${LIVE} AND hidden = 0 AND updates > 0 AND created_at <= ${listedSince()}`;
const isListed = (u) => !!(u.verified && !u.banned && !u.hidden && u.updates > 0 && u.created_at <= listedSince());
const siteDir = (name) => path.join(SITES_DIR, name);
// Each member keeps the largest QUOTA_MB they have had: raising it in .env grows every site, lowering it only affects new signups
db.prepare('UPDATE users SET quota_mb = ? WHERE quota_mb < ?').run(cfg.QUOTA_MB, cfg.QUOTA_MB);
const quotaMB = (user) => Math.max(user.quota_mb || 0, cfg.QUOTA_MB);

// the current name of the site that gave up `name` in a rename, while that name is still held
const renamedTo = (name) => db.prepare(`SELECT u.username FROM released_names r JOIN users u ON u.id = r.user_id WHERE r.name = ? AND r.released_at > ? AND ${LIVE}`).get(String(name), now() - NAME_HOLD)?.username;

function makeToken(userId, kind, ttl) {
  const t = U.newToken();
  db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
  db.prepare('INSERT INTO tokens (token_hash, user_id, kind, expires) VALUES (?,?,?,?)').run(U.sha(t), userId, kind, now() + ttl);
  return t;
}
function useToken(t, kind) {
  const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(U.sha(String(t || '')), kind);
  if (!row || row.expires < now()) return null;
  db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(row.token_hash);
  return q.userById.get(row.user_id);
}
// is this token live? without spending it, so a costly step can be skipped for links that would fail anyway
const tokenLive = (t, kind) => {
  const row = db.prepare('SELECT expires FROM tokens WHERE token_hash = ? AND kind = ?').get(U.sha(String(t || '')), kind);
  return !!row && row.expires >= now();
};
// Password hashing yields to other requests, so by the time it finishes a reset may have replaced the password
// and logged every session out. Signed-in actions check that nothing like that happened before they act.
// A rename meanwhile counts too (renamed_at changes with every one): the request would act on the old name's folder.
const stillCurrent = (req, user) => {
  const cur = q.userById.get(user.id);
  return !!cur && cur.pw_hash === user.pw_hash && cur.renamed_at === user.renamed_at &&
    (!req.sessionHash || !!db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(req.sessionHash));
};
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;
const isAdmin = (user) => !!user.verified && cfg.ADMIN_EMAILS.has(user.email);
// logins waiting on their second step, which a password change or "log out everywhere" also ends
const dropLogins = (userId) => db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'login2fa'").run(userId);
function startSession(res, userId) {
  const t = U.newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires) VALUES (?,?,?,?)').run(U.sha(t), userId, U.newToken(), now() + 30 * DAY);
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: cfg.SECURE, path: '/', maxAge: 30 * DAY });
}
const MAX_SITES = 5;
const isSupporter = (user) => user.supporter_until > now() || isAdmin(user);
const ownerRow = (user) => (user.owner_id ? q.userById.get(user.owner_id) : user);
// what a site may store: free limits, or bigger ones and any file type while its login supports.
// When support lapses nothing is deleted; uploads are refused until the site is back under the free limits
const limitsFor = (user) => {
  const sup = isSupporter(ownerRow(user));
  return {
    quotaMB: sup ? Math.max(quotaMB(user), cfg.SUPPORTER_QUOTA_MB) : quotaMB(user),
    fileMB: sup ? Math.max(cfg.MAX_FILE_MB, cfg.SUPPORTER_MAX_FILE_MB) : cfg.MAX_FILE_MB,
    anyType: sup,
  };
};
// sites whose login supports right now (admins aside), for the flair next to their names; read only when a page shows names
const supporterNames = () => new Set(db.prepare('SELECT u.username FROM users o JOIN users u ON u.id = o.id OR u.owner_id = o.id WHERE o.supporter_until > ?').all(now()).map((r) => r.username));
const withFlair = (ctx) => { let names; return Object.defineProperty(ctx, 'supporters', { get: () => (names ??= supporterNames()), enumerable: true }); };
// a login row and its extra sites: for its sessions, API keys and bans
const loginIds = '(SELECT id FROM users WHERE id = ? OR owner_id = ?)';
const sitesOf = (user) => { const id = user.owner_id || user.id; return db.prepare('SELECT * FROM users WHERE id = ? OR owner_id = ? ORDER BY id').all(id, id); };
function deleteAccountRows(user) {
  for (const s of db.prepare('SELECT username FROM users WHERE owner_id = ?').all(user.id)) db.prepare('INSERT OR REPLACE INTO released_names (name, released_at) VALUES (?, ?)').run(s.username, now());
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  // never-confirmed accounts were never online, so their names are free again at once
  if (user.verified) db.prepare('INSERT OR REPLACE INTO released_names (name, released_at) VALUES (?, ?)').run(user.username, now());
}
function deleteAccount(user, rows = deleteAccountRows) {
  const extra = db.prepare('SELECT id, username FROM users WHERE owner_id = ?').all(user.id);
  rows(user);
  for (const s of extra) { fs.rmSync(siteDir(s.username), { recursive: true, force: true }); fs.rmSync(shotPath(s.username), { force: true }); usageCache.delete(s.username); H.remove(s.id); }
  fs.rmSync(siteDir(user.username), { recursive: true, force: true });
  H.remove(user.id);
  fs.rmSync(shotPath(user.username), { force: true });
  usageCache.delete(user.username);
}
// A site's bytes and file count, kept rather than walked per request: walking a 500 MB folder stalls every other site.
// The writes made here keep it current, and refreshUsage() rewalks every site in the background to catch changes made outside the app (a restore)
const usageCache = new Map();
function usage(name) {
  if (!usageCache.has(name)) usageCache.set(name, U.dirSize(siteDir(name))); // only before the first refresh reaches this site
  return usageCache.get(name);
}
async function refreshUsage() {
  for (const { username } of db.prepare('SELECT username FROM users').all()) {
    const before = usageCache.get(username);
    try {
      const fresh = await U.dirSizeAsync(siteDir(username));
      // a write during the walk already stored newer totals, which the walk may have missed
      if (usageCache.get(username) === before) usageCache.set(username, fresh);
    } catch { usageCache.delete(username); } // changed while walked: the next look rewalks
  }
}
// file history (src/history.js): old versions stay for HISTORY_DAYS, longer for supporters, and take at most the site's quota again
const historyDays = (user) => (isSupporter(ownerRow(user)) ? cfg.SUPPORTER_HISTORY_DAYS : cfg.HISTORY_DAYS);
const historyKeep = (user) => ({ since: now() - historyDays(user) * DAY, maxBytes: limitsFor(user).quotaMB * 1048576 });
// history is a convenience: a failure is logged, never shown to the member or allowed to fail their save
const recordHistory = (user, message) => H.record(user.id, siteDir(user.username), message, historyKeep(user)).catch((e) => console.error(`file history for ${user.username} failed:`, e.message));
// a starting point for sites that have none yet (new, or here before history was), and the daily trim for the rest
async function historySweep() {
  for (const u of db.prepare('SELECT * FROM users').all()) {
    if (!H.exists(u.id)) await recordHistory(u, 'history begins');
    else await H.trim(u.id, siteDir(u.username), historyKeep(u)).catch((e) => console.error(`file history trim for ${u.username} failed:`, e.message));
  }
}
// resolve a member path inside their folder, or null
function resolveIn(user, rel) {
  const root = siteDir(user.username);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

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
const reportLink = (name) => `<p><small><a href="${cfg.BASE_URL}/report?site=${encodeURIComponent(name)}">Report this site</a></small></p>`;
site.use((req, res, next) => {
  const owner = q.userByName.get(req.siteName);
  if (!owner || !owner.verified) {
    const to = renamedTo(req.siteName);
    // a day's cache, not forever: once the hold ends someone else may take the old name
    if (to) return res.set('Cache-Control', 'public, max-age=86400').redirect(301, cfg.siteUrl(to) + req.originalUrl);
    return res.status(404).send(V.sitePage(cfg, 'This pad is empty', `<p>The name <b>${U.esc(req.siteName)}</b> is not a site on ${U.esc(cfg.SITE_NAME)}. <a href="${cfg.BASE_URL}/signup">Roll out a pad of your own.</a></p>`));
  }
  if (owner.banned) return res.status(410).send(V.sitePage(cfg, 'This pad got rolled up', `<p>A moderator removed this site for breaking the house rules.</p>${reportLink(owner.username)}`));
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
W.siteRoutes(site);

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const GB_LINK = /https?:|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ru|xyz|info|biz|top|click|link)\b/i; // shortcut: a TLD list, not a URL parser
const gbEntryText = (e) => `${e.name} wrote:\n${e.message}${e.approved ? '' : '\n(This entry has a link, so it waits for your approval.)'}`;
const gbMailFooter = `Approve or delete entries, or change how often we email you about them: ${cfg.BASE_URL}/dashboard/guestbook`;
const GB_NOTIFY = ['instant', 'daily', 'off'];
// one page of a guestbook, newest first: the approved entries visitors see, or all of them for the owner
function gbPage(req, id, all = false) {
  const from = `FROM guestbook WHERE user_id = ?${all ? '' : ' AND approved = 1'}`;
  const { page, pages } = pageOf(req, db.prepare(`SELECT COUNT(*) n ${from}`).get(id).n);
  return { rows: db.prepare(`SELECT * ${from} ORDER BY id DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all(id), page, pages };
}
site.get('/_hw/guestbook', (req, res) => res.set('Cache-Control', 'no-store').send(V.guestbook(gbPage(req, req.owner.id), '', W.gbTheme(req.query.theme))));
site.post('/_hw/guestbook', express.urlencoded({ extended: false, limit: '8kb' }), bodyDefault, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const message = String(req.body.message || '').trim().slice(0, 500);
  const theme = W.gbTheme(req.query.theme);
  const back = `/_hw/guestbook${theme === 'classic' ? '' : `?theme=${theme}`}`;
  const fail = (code, err) => res.status(code).send(V.guestbook(gbPage(req, req.owner.id), err, theme));
  if (req.body.website) return res.redirect(back); // bot filled the hidden field
  if (!name || !message) return fail(400, 'Name and message are both required.');
  if (!U.limit(`gb:${req.ip}`, 3, 600000)) return fail(429, 'Too many entries from you. Try again in ten minutes.');
  if (lines(req.owner.gb_ips).includes(req.ip)) return res.redirect(back); // blocked: look like success
  const text = `${name} ${message}`.toLowerCase();
  if (lines(req.owner.gb_words).some((w) => text.includes(w.toLowerCase()))) return fail(400, 'Your entry contains a word the owner has blocked.');
  const approved = GB_LINK.test(text) ? 0 : 1; // entries with links wait for the owner
  db.prepare('INSERT INTO guestbook (user_id, name, message, ip, approved, created_at) VALUES (?,?,?,?,?,?)').run(req.owner.id, name, message, req.ip, approved, now());
  // capped so a spam wave from many addresses can't flood the owner's inbox
  if (req.owner.gb_notify === 'instant' && U.limit(`gbmail:${req.owner.id}`, 10, 3600000)) {
    sendMail(ownerRow(req.owner).email, `New guestbook entry on ${req.owner.username}.${cfg.BASE_HOST}`, `${gbEntryText({ name, message, approved })}\n\n${gbMailFooter}`);
  }
  res.redirect(back);
});

site.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).type('text').send('Method not allowed');
  if (bwToday(req.owner) >= cfg.BANDWIDTH_MB * 1048576) {
    return res.status(429).set('Retry-After', String(Math.ceil((Date.parse(today()) + DAY - now()) / 1000)))
      .send(V.sitePage(cfg, 'This pad is resting', '<p>This site used up its bandwidth for today. It comes back at midnight UTC.</p>'));
  }
  let refHost = '';
  try { refHost = new URL(req.get('referer')).hostname; } catch {}
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
        if (refHost && refHost !== req.hostname) db.prepare('INSERT INTO referrers (user_id, day, host, views) VALUES (@id, @day, @host, 1) ON CONFLICT DO UPDATE SET views = views + 1').run({ ...at, host: refHost.slice(0, 200) });
      } catch (e) { if (q.userById.get(req.owner.id)) console.error('visitor stats failed:', e.message); }
    }
  });
  const root = siteDir(req.owner.username);
  const notFound = () => {
    if (req.path === '/favicon.ico') return asset('favicon.svg', 'image/svg+xml')(req, res); // sites without an icon of their own get ours
    const custom = path.join(root, 'not_found.html');
    if (fs.existsSync(custom)) return res.status(404).sendFile(custom);
    res.status(404).send(V.sitePage(cfg, '404 - Page not found', `<p>That page does not exist on this site. <a href="/">Go to the front page.</a></p>${reportLink(req.owner.username)}`));
  };
  let rel;
  try { rel = decodeURIComponent(req.path); } catch { return notFound(); }
  const hotlinked = req.get('referer') && refHost !== cfg.BASE_HOST && !refHost.endsWith(`.${cfg.BASE_HOST}`);
  if (hotlinked && HOTLINK_MEDIA.test(rel) && !U.limit(`hotlink:${req.owner.id}`, HOTLINK_PER_MIN, 60000)) {
    return res.status(429).type('text').send('Too many requests from other websites for this file. Try again in a minute.');
  }
  if (rel.includes('\0') || rel.split('/').some((s) => s === '..' || s.startsWith('.'))) return notFound();
  let full = path.join(root, rel);
  if (!full.startsWith(root)) return notFound();
  fs.stat(full, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!req.path.endsWith('/')) return res.redirect(301, req.path + '/');
      full = path.join(full, 'index.html');
    } else if (err) {
      // clean URLs: /about serves about.html when nothing called "about" exists
      if (req.path.endsWith('/') || path.extname(full)) return notFound();
      full += '.html';
    }
    page = /\.html?$/i.test(full);
    res.set('Cache-Control', 'public, max-age=60');
    if (page && fs.existsSync(shotPath(req.owner.username))) {
      return fs.readFile(full, (e, buf) => (e ? notFound() : res.type('html').send(withOgImage(buf, req.owner.username))));
    }
    res.sendFile(full, { dotfiles: 'deny' }, (e) => { if (e && !res.headersSent) notFound(); });
  });
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
  const u = db.prepare(`SELECT username FROM users WHERE ${LIVE} AND shot_dirty = 1 AND updated_at < ? ORDER BY updated_at LIMIT 1`).get(now() - 20000);
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
  if (!stripe) return res.sendStatus(404);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', env.STRIPE_WEBHOOK_SECRET); } catch { return res.status(400).type('text').send('Bad signature'); }
  try {
    const o = event.data.object;
    if (event.type === 'checkout.session.completed' && o.customer) {
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND owner_id IS NULL").run(String(o.customer), Number(o.client_reference_id) || 0);
    } else if (event.type.startsWith('customer.subscription.')) {
      applySubscription(o);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('stripe webhook failed:', e.message);
    res.sendStatus(500); // Stripe retries
  }
});
// a subscription's state sets supporter_until: paid up to the period's end (plus a few days for a late renewal), or over now
function applySubscription(sub) {
  // shortcut: events apply in arrival order; Stripe can reorder them, so compare event.created if a stale one ever revives a lapsed member
  const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(String(sub.customer)) ||
    db.prepare('SELECT * FROM users WHERE id = ? AND owner_id IS NULL').get(Number(sub.metadata?.user_id) || 0);
  if (!user) return;
  // newer Stripe API versions keep the period on each item
  const end = (sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? 0) * 1000;
  let until = null;
  if (['active', 'trialing', 'past_due'].includes(sub.status) && end) until = end + SUPPORT_GRACE;
  else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) until = Math.min(user.supporter_until, now());
  db.prepare('UPDATE users SET stripe_customer_id = ?, supporter_until = COALESCE(?, supporter_until) WHERE id = ?').run(String(sub.customer), until, user.id);
}

// the HTTP API takes a member's API key in the Authorization header and never reads the session cookie,
// so a page on another site can't use it with a visitor's login and it needs no CSRF token; its routes are under "HTTP API" below
const api = express.Router();
main.use('/api', api);

// session
main.use((req, res, next) => {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE);
  req.ctx = withFlair({ cfg, user: null, csrf: '', isAdmin: false, nonce: res.locals.nonce });
  if (m && m[1]) {
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(U.sha(m[1]));
    if (s && s.expires > now()) {
      const user = q.userById.get(s.user_id);
      if (user) {
        const login = ownerRow(user); // an extra site's admin rights and email are its login's
        req.ctx = withFlair({ cfg, user, login, csrf: s.csrf, isAdmin: isAdmin(login), nonce: res.locals.nonce, unread: notes(user, 'COUNT(*) n', user.notes_seen_at).get().n });
        req.sessionHash = s.token_hash;
      }
    }
  }
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
const csrfOk = (req) => !req.ctx.user || (req.body && req.body._csrf === req.ctx.csrf);
main.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin;
  if (origin && origin !== cfg.BASE_URL) return res.status(403).type('text').send('Cross-site request blocked');
  // multipart bodies are not parsed yet here, so their token cannot be checked yet:
  // every multipart route MUST call csrfOk itself after multer runs (upload and import do)
  if (!req.is('multipart/form-data') && !csrfOk(req)) return res.status(403).type('text').send('Form expired. Go back, reload and try again.');
  next();
});
const auth = (req, res, next) => (req.ctx.user ? next() : res.redirect('/login'));
const canEdit = (req, res, next) => (req.ctx.user.banned ? res.redirect('/dashboard') : next());
const adminOnly = (req, res, next) => (req.ctx.isAdmin ? next() : res.status(404).send(V.notice(req.ctx, 'Not found', '<p>No such page.</p>')));

// ----- SEO: robots, sitemap, brand assets -----
const ASSETS_DIR = path.join(__dirname, 'assets');
const asset = (file, type) => (req, res) => res.set('Cache-Control', 'public, max-age=86400').type(type).sendFile(path.join(ASSETS_DIR, file), (e) => { if (e && !res.headersSent) res.sendStatus(404); });
// the editor's CodeMirror, from node_modules; files never change under a versioned path
main.use(V.CM, express.static(path.dirname(require.resolve('codemirror/package.json')), { immutable: true, maxAge: '365d', index: false }));
main.get('/favicon.ico', asset('favicon.svg', 'image/svg+xml')); // shortcut: SVG at the .ico path; browsers and Google accept SVG favicons
main.get('/favicon.svg', asset('favicon.svg', 'image/svg+xml'));
main.get('/og.svg', asset('og.svg', 'image/svg+xml'));
main.get('/og.png', asset('og.png', 'image/png')); // the share-preview raster; og:image points here because several scrapers ignore SVG
main.get('/img/supporter.svg', asset('supporter.svg', 'image/svg+xml'));
main.get('/img/pup-hero.webp', asset('pup-hero.webp', 'image/webp'));
main.get('/img/pup-coder.webp', asset('pup-coder.webp', 'image/webp'));
main.get('/img/pup-accident.webp', asset('pup-accident.webp', 'image/webp'));
main.get('/img/pup-guestbook.webp', asset('pup-guestbook.webp', 'image/webp'));
W.assetRoutes(main); // backgrounds, buttons and effects member pages load from here
main.get('/robots.txt', (req, res) => res.type('text/plain').send(
  // /login, /signup, /forgot, /reset and /feed stay crawlable on purpose: they carry noindex tags,
  // which a crawler can only read if robots.txt lets it in. Only the auth-gated areas are disallowed.
  `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /admin\nDisallow: /internal/\n\nSitemap: ${cfg.BASE_URL}/sitemap.xml\n`));
main.get('/sitemap.xml', (req, res) => {
  const urls = [['/', null], ['/browse', null], ['/rules', null], ['/privacy', null],
    ...db.prepare(`SELECT username, updated_at FROM users WHERE ${listed()} ORDER BY updated_at DESC`).all()
      .map((u) => [`/site/${u.username}`, new Date(u.updated_at).toISOString().slice(0, 10)])];
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([loc, mod]) => `<url><loc>${cfg.BASE_URL}${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
});

// ----- public pages -----
main.get('/', (req, res) => res.send(V.home(req.ctx, {
  sotw: db.prepare(`${WITH_FOLLOWERS} WHERE ${listed()} AND u.sotw_at > 0`).all().map(hasShot)[0],
  picks: db.prepare(`${WITH_FOLLOWERS} WHERE ${listed()} AND u.staff_pick > 0 ORDER BY u.staff_pick DESC LIMIT 8`).all().map(hasShot),
  recent: db.prepare(`${WITH_FOLLOWERS} WHERE ${listed()} ORDER BY u.updated_at DESC LIMIT 8`).all().map(hasShot),
  newest: db.prepare(`SELECT * FROM users WHERE ${listed()} ORDER BY id DESC LIMIT 10`).all(),
  total: db.prepare(`SELECT COUNT(*) n FROM users WHERE ${LIVE}`).get().n,
  supporters: cfg.SUPPORT_ON ? db.prepare('SELECT COUNT(*) n FROM users WHERE supporter_until > ?').get(now()).n : 0,
})));
const SORTS = { updated: 'u.updated_at DESC', newest: 'u.id DESC', followed: 'followers DESC, u.updated_at DESC', hits: 'u.hits DESC' };
const WITH_FOLLOWERS = `SELECT u.*, (SELECT COUNT(*) FROM follows f WHERE f.followed_id = u.id) AS followers FROM users u`;
const hasShot = (r) => ({ ...r, shot: fs.existsSync(shotPath(r.username)) });
main.get('/browse', (req, res) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'updated';
  const search = String(req.query.q || '').trim().toLowerCase().slice(0, 50);
  // part of a site name or tag; instr, not LIKE, so % and _ in the search are plain characters
  const where = `${listed()}${search ? ' AND (instr(username, @search) OR instr(tags, @search))' : ''}`;
  const total = db.prepare(`SELECT COUNT(*) n FROM users WHERE ${where}`).get({ search }).n;
  const pages = Math.max(1, Math.ceil(total / 24));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = db.prepare(`${WITH_FOLLOWERS} WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT 24 OFFSET @offset`).all({ offset: (page - 1) * 24, search }).map(hasShot);
  res.send(V.browse(req.ctx, { rows, page, pages, sort, q: search }));
});
function showProfile(req, res, name, m, status = 200) {
  const p = db.prepare(`${WITH_FOLLOWERS} WHERE u.username = ? AND ${LIVE}`).get(String(name).toLowerCase());
  if (!p) {
    const to = renamedTo(String(name).toLowerCase());
    if (to) return res.set('Cache-Control', 'public, max-age=86400').redirect(301, `/site/${to}`);
    return res.status(404).send(V.notice(req.ctx, 'Not found', '<p>There is no site with that name. <a href="/browse">Browse sites.</a></p>'));
  }
  const me = req.ctx.user;
  const viewer = me ? me.id : 0;
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  res.status(status).send(V.profile(req.ctx, m, {
    p: hasShot(p),
    following: !!(me && db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?').get(me.id, p.id)),
    blocking: !!me && blocked(me.id, p.id),
    login: me && ownerRow(me),
    comments: commentPage(req, 'c.user_id = @owner AND c.event_id IS NULL', { owner: p.id, viewer }, 'cpage'),
    events: withSocial(db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(p.id), viewer),
    followers: followPage(req, 'follower_id', 'followed_id', p.id, 'fpage'),
    follows: followPage(req, 'followed_id', 'follower_id', p.id, 'gpage'),
  }));
}
// only the owner sees ?ok= notices, so a crafted link cannot show visitors a fake one
main.get('/site/:name', (req, res) => showProfile(req, res, req.params.name,
  req.query.ok && req.ctx.user && req.ctx.user.username === String(req.params.name).toLowerCase() ? { ok: String(req.query.ok) } : null));
main.post('/follow', (req, res) => {
  const me = req.ctx.user;
  if (!me) return res.redirect('/login');
  const target = q.userByName.get(String(req.body.site || '').toLowerCase());
  if (!target || !target.verified || target.banned || target.id === me.id || me.banned) return res.redirect('/browse');
  if (req.body.action === 'unfollow') db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?').run(me.id, target.id);
  else if (!blocked(target.id, me.id) && !blocked(me.id, target.id) && U.limit(`follow:${me.id}`, 60, 3600000)) {
    if (db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?,?,?)').run(me.id, target.id, now()).changes) notify(target, me, 'follow');
  }
  res.redirect(`/site/${target.username}`);
});

// ----- comments, likes, blocks, notifications -----
const blocked = (blocker, who) => !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blocker, who);
// a comment or like is hidden when the member whose space it is, or the one looking (@viewer), blocked its author
const unblocked = (col, owner) => `${col} NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ${owner} OR blocker_id = @viewer)`;
const PER_PAGE = 50;
// the page asked for in ?<key>=, kept within the pages there are
const pageOf = (req, total, key = 'page') => {
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  return { page: Math.min(pages, Math.max(1, parseInt(req.query[key], 10) || 1)), pages };
};
const COMMENTS = 'FROM comments c JOIN users u ON u.id = c.author_id WHERE';
// one page of the comments matching `where`, newest first, without those from banned or blocked members
function commentPage(req, where, at, key) {
  const filter = `${where} AND ${LIVE} AND ${unblocked('c.author_id', 'c.user_id')}`;
  const { page, pages } = pageOf(req, db.prepare(`SELECT COUNT(*) n ${COMMENTS} ${filter}`).get(at).n, key);
  return { rows: db.prepare(`SELECT c.*, u.username ${COMMENTS} ${filter} ORDER BY c.id DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all(at), page, pages };
}
// one page of the members on the `who` side of a site's follows, newest first
function followPage(req, who, side, id, key) {
  const from = `FROM follows f JOIN users u ON u.id = f.${who} WHERE f.${side} = ? AND ${LIVE}`;
  const { page, pages } = pageOf(req, db.prepare(`SELECT COUNT(*) n ${from}`).get(id).n, key);
  return { rows: db.prepare(`SELECT u.username ${from} ORDER BY f.created_at DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all(id), page, pages };
}
const PREVIEW = 5; // comments shown under each update on the feed and profile; the update's own page has them all
// feed events with their newest comments and comment count, like count, and whether the viewer liked them
function withSocial(events, viewer) {
  const at = { ids: JSON.stringify(events.map((e) => e.id)), viewer };
  const comments = db.prepare(`SELECT * FROM (SELECT c.*, u.username, ROW_NUMBER() OVER (PARTITION BY c.event_id ORDER BY c.id DESC) rn, COUNT(*) OVER (PARTITION BY c.event_id) total
    ${COMMENTS} c.event_id IN (SELECT value FROM json_each(@ids)) AND ${LIVE} AND ${unblocked('c.author_id', 'c.user_id')}) WHERE rn <= ${PREVIEW} ORDER BY id`).all(at);
  const likes = db.prepare(`SELECT l.event_id, COUNT(*) n, MAX(l.user_id = @viewer) mine FROM likes l JOIN events e ON e.id = l.event_id JOIN users u ON u.id = l.user_id
    WHERE l.event_id IN (SELECT value FROM json_each(@ids)) AND ${LIVE} AND ${unblocked('l.user_id', 'e.user_id')} GROUP BY l.event_id`).all(at);
  return events.map((e) => {
    const l = likes.find((x) => x.event_id === e.id);
    const mine = comments.filter((c) => c.event_id === e.id);
    return { ...e, comments: mine, commentCount: mine.length ? mine[0].total : 0, likes: l ? l.n : 0, liked: !!(l && l.mine) };
  });
}
// a member's notifications, worked out from the follows, comments and likes themselves, so deletes and blocks apply at once
const notes = (user, cols, since = 0, tail = '') => db.prepare(`SELECT ${cols} FROM (
    SELECT 'follow' kind, follower_id actor, NULL event_id, NULL comment_id, '' body, created_at FROM follows WHERE followed_id = @me
    UNION ALL SELECT 'comment', author_id, event_id, id, body, created_at FROM comments WHERE user_id = @me
    UNION ALL SELECT 'like', l.user_id, l.event_id, NULL, '', l.created_at FROM likes l JOIN events e ON e.id = l.event_id WHERE e.user_id = @me
  ) n JOIN users u ON u.id = n.actor
  WHERE ${LIVE} AND n.actor != @me AND n.actor NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = @me) AND n.created_at > @since ${tail}`).bind({ me: user.id, since });
const NOTE_KINDS = ['follow', 'comment', 'like'];
const NOTE_TEXT = { follow: 'started following you', comment: 'commented on your site', like: 'liked your update' };
// the optional email for one kind of notification; capped like guestbook mail so a burst can't flood the inbox
function notify(owner, actor, kind, extra = '') {
  if (owner.id === actor.id || !owner.note_mail.split(' ').includes(kind) || !U.limit(`notemail:${owner.id}`, 10, 3600000)) return;
  sendMail(ownerRow(owner).email, `${actor.username} ${NOTE_TEXT[kind]} on ${cfg.SITE_NAME}`,
    `${actor.username} ${NOTE_TEXT[kind]}.${extra ? `\n\n${extra}` : ''}\n\nSee your notifications, or change which ones we email you about: ${cfg.BASE_URL}/notifications`);
}
// a comment or like lands back on the page of ours it was made from, never on another site
const BACK = /^\/(feed|notifications|site\/[a-z0-9-]+(\/update\/\d+)?)$/;
const backTo = (req, owner) => (BACK.test(String(req.body.back || '')) ? req.body.back : `/site/${owner.username}`);
// the event a comment or like is about, with its site's owner; null unless both are live
const eventOwner = (id) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id) || 0);
  const owner = ev && q.userById.get(ev.user_id);
  return owner && owner.verified && !owner.banned ? { ev, owner } : null;
};
main.post('/comment', (req, res) => {
  const me = req.ctx.user;
  if (!me) return res.redirect('/login');
  const on = req.body.event ? eventOwner(req.body.event) : null;
  const owner = req.body.event ? on && on.owner : q.userByName.get(String(req.body.site || '').toLowerCase());
  if (!owner || !owner.verified || owner.banned || me.banned) return res.redirect('/browse');
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (req.body.website || !body) return res.redirect(backTo(req, owner)); // bot filled the hidden field, or nothing written
  if (!U.limit(`comment:${req.ip}`, 3, 600000)) return res.status(429).send(V.notice(req.ctx, 'Slow down', '<p>Too many comments from you. Try again in ten minutes.</p>'));
  if (!blocked(owner.id, me.id)) { // blocked: look like success
    db.prepare('INSERT INTO comments (user_id, author_id, event_id, body, created_at) VALUES (?,?,?,?,?)').run(owner.id, me.id, on ? on.ev.id : null, body, now());
    notify(owner, me, 'comment', body);
  }
  res.redirect(backTo(req, owner));
});
// the member whose profile or update it is can delete any comment there
main.post('/comment/delete', auth, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(Number(req.body.id) || 0, req.ctx.user.id);
  res.redirect(backTo(req, req.ctx.user));
});
main.post('/like', (req, res) => {
  const me = req.ctx.user;
  if (!me) return res.redirect('/login');
  const on = eventOwner(req.body.event);
  if (!on || me.banned) return res.redirect('/feed');
  if (req.body.action === 'unlike') db.prepare('DELETE FROM likes WHERE event_id = ? AND user_id = ?').run(on.ev.id, me.id);
  else if (!blocked(on.owner.id, me.id) && U.limit(`like:${me.id}`, 60, 3600000)) {
    if (db.prepare('INSERT OR IGNORE INTO likes (event_id, user_id, created_at) VALUES (?,?,?)').run(on.ev.id, me.id, now()).changes) notify(on.owner, me, 'like');
  }
  res.redirect(backTo(req, on.owner));
});
// blocking hides the other member's comments and likes and stops new ones; follows between the two end
main.post('/block', auth, (req, res) => {
  const me = req.ctx.user;
  const target = q.userByName.get(String(req.body.site || '').toLowerCase());
  if (!target || target.id === me.id) return res.redirect('/browse');
  if (req.body.action === 'unblock') db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me.id, target.id);
  else {
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(me.id, target.id, now());
      db.prepare('DELETE FROM follows WHERE (follower_id = @a AND followed_id = @b) OR (follower_id = @b AND followed_id = @a)').run({ a: me.id, b: target.id });
    })();
  }
  res.redirect(`/site/${target.username}`);
});
// one update with every comment on it, a page at a time
main.get('/site/:name/update/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM users WHERE username = ? AND ${LIVE}`).get(String(req.params.name).toLowerCase());
  const ev = p && db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(Number(req.params.id) || 0, p.id);
  if (!ev) return res.status(404).send(V.notice(req.ctx, 'Not found', '<p>That update is gone. <a href="/browse">Browse sites.</a></p>'));
  const viewer = req.ctx.user ? req.ctx.user.id : 0;
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  res.send(V.update(req.ctx, { p, e: withSocial([ev], viewer)[0], comments: commentPage(req, 'c.event_id = @ev', { ev: ev.id, viewer }) }));
});
// the newest page marks everything read; older pages carry ?since= so they still show what was new on arrival
main.get('/notifications', auth, (req, res) => {
  const user = req.ctx.user;
  const { page, pages } = pageOf(req, notes(user, 'COUNT(*) n').get().n);
  const rows = notes(user, 'n.*, u.username', 0, `ORDER BY n.created_at DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all();
  const seenAt = req.query.since !== undefined ? Number(req.query.since) || 0 : user.notes_seen_at;
  if (page === 1) db.prepare('UPDATE users SET notes_seen_at = ? WHERE id = ?').run(now(), user.id);
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
  const events = db.prepare(`SELECT e.*, u.username, u.tagline FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) AND u.verified = 1 AND u.banned = 0 AND u.hidden = 0 ORDER BY e.id DESC LIMIT 100`).all(req.ctx.user.id).map(hasShot);
  res.send(V.feed(req.ctx, { events: withSocial(events, req.ctx.user.id), count: db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id = ?').get(req.ctx.user.id).n }));
});
// Atom feeds: one per site (hidden sites too, like their profile), and the recently updated list without hidden or new sites
const atom = (res, feed) => res.set('Cache-Control', 'public, max-age=300').type('application/atom+xml').send(V.atom(cfg, feed));
main.get('/feed.xml', (req, res) => atom(res, {
  title: `${cfg.SITE_NAME}: recently updated`, path: '/feed.xml', link: `${cfg.BASE_URL}/browse`,
  events: db.prepare(`SELECT e.*, u.username FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.kind = 'update' AND e.user_id IN (SELECT id FROM users WHERE ${listed()}) ORDER BY e.id DESC LIMIT 50`).all(),
}));
main.get('/site/:name/feed.xml', (req, res) => {
  const p = db.prepare(`SELECT * FROM users WHERE username = ? AND ${LIVE}`).get(String(req.params.name).toLowerCase());
  if (!p) {
    const to = renamedTo(String(req.params.name).toLowerCase());
    return to ? res.set('Cache-Control', 'public, max-age=86400').redirect(301, `/site/${to}/feed.xml`) : res.sendStatus(404);
  }
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  atom(res, {
    title: `${p.username} on ${cfg.SITE_NAME}`, path: `/site/${p.username}/feed.xml`, link: cfg.siteUrl(p.username) + '/',
    events: db.prepare('SELECT *, ? AS username FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(p.username, p.id),
  });
});
const inRing = () => `${listed()} AND webring = 1`;
const randomSite = (where) => (req, res) => {
  const r = db.prepare(`SELECT username FROM users WHERE ${where()} ORDER BY RANDOM() LIMIT 1`).get();
  res.redirect(r ? cfg.siteUrl(r.username) : '/');
};
main.get('/random', randomSite(listed));
main.get('/webring/random', randomSite(inRing));
const webring = (next) => (req, res) => {
  const fromName = String(req.query.from || '').toLowerCase();
  const from = q.userByName.get(fromName) || q.userByName.get(renamedTo(fromName) || ''); // old webring snippets still name the site's old name
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
  if (!starters.valid(req.params.id)) return res.status(404).send(V.notice(req.ctx, 'Not found', '<p>No such starter. <a href="/signup">Back to signup.</a></p>'));
  res.send(starters.preview(req.params.id, cfg));
});
main.post('/signup', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const starter = starters.valid(req.body.starter) ? req.body.starter : starters.DEFAULT;
  const fail = (err, code = 400) => res.status(code).send(V.signup(req.ctx, { err }, { username, email, starter }));
  if (req.body.website) return res.send(V.notice(req.ctx, 'Check your email', '<p>We sent you a confirmation link.</p>')); // bot
  if (!U.limit(`signup:${req.ip}`, 5, 3600000)) return fail('Too many signups from your connection. Try again in an hour.', 429);
  if (!U.validUsername(username)) return fail('That site name is not available. Use 3-30 lowercase letters, numbers or hyphens.');
  if (!validEmail(email)) return fail('That email address does not look right.');
  if (password.length < 10 || password.length > 200) return fail('Use a password with at least 10 characters.');
  if (!req.body.agree) return fail('You need to be 13 or older and accept the rules.');
  if (q.userByName.get(username) || db.prepare('SELECT 1 FROM released_names WHERE name = ? AND released_at > ?').get(username, now() - NAME_HOLD)) return fail('That site name is taken.');
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
    fs.mkdirSync(siteDir(username), { recursive: true });
    fs.writeFileSync(path.join(siteDir(username), 'index.html'), starters.render(starter, username, cfg));
    H.remove(id); // ids are reused after the newest account goes; never hand over someone else's versions
    recordHistory(q.userById.get(id), 'history begins');
  } catch {
    try { deleteAccount(q.userById.get(id)); } catch { /* roll the row back, but a folder that refuses to delete must not crash the signup too */ }
    return fail('Something went wrong making your site. Try again.', 500);
  }
  await sendMail(email, `Confirm your ${cfg.SITE_NAME} site`,
    `Welcome! Confirm your email to put ${username}.${cfg.BASE_HOST} online:\n\n${cfg.BASE_URL}/verify?token=${makeToken(id, 'verify', 2 * DAY)}\n\nIf you did not sign up, ignore this message.`);
  res.send(V.notice(req.ctx, 'Check your email', `<p>We sent a confirmation link to <b>${U.esc(email)}</b>. Your site goes live when you click it. The link works for 48 hours.</p>`));
});
main.get('/verify', (req, res) => {
  const user = useToken(req.query.token, 'verify');
  if (!user) return res.status(400).send(V.notice(req.ctx, 'Link expired', '<p>That confirmation link is no longer valid. <a href="/login">Log in</a> to get a new one.</p>'));
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
  const ok = !!user && !user.owner_id && (await U.checkPw(String(req.body.password || ''), user.pw_hash));
  const cur = ok && q.userById.get(user.id); // re-read: two-factor may have been turned on while the hash ran
  if (!cur || cur.pw_hash !== user.pw_hash) {
    return res.status(401).send(V.login(req.ctx, { err: 'Wrong site name, email or password.' }, { username }));
  }
  if (!user.verified) {
    if (U.limit(`reverify:${user.id}`, 3, 3600000)) {
      await sendMail(user.email, `Confirm your ${cfg.SITE_NAME} site`, `Confirm your email:\n\n${cfg.BASE_URL}/verify?token=${makeToken(user.id, 'verify', 2 * DAY)}`);
    }
    return res.send(V.notice(req.ctx, 'Confirm your email first', '<p>We sent you a fresh confirmation link. Click it to finish setting up.</p>'));
  }
  if (cur.totp_secret) return res.send(V.login2fa(req.ctx, null, makeToken(user.id, 'login2fa', 600000)));
  startSession(res, user.id);
  res.redirect('/dashboard');
});
// the second login step: the password was right, and the token says for whom, until a code from their app or a recovery code matches
main.post('/login/2fa', (req, res) => {
  const token = String(req.body.token || '');
  const row = db.prepare("SELECT user_id FROM tokens WHERE token_hash = ? AND kind = 'login2fa' AND expires >= ?").get(U.sha(token), now());
  if (!row) return res.status(400).send(V.notice(req.ctx, 'Log in again', '<p>That login took too long. <a href="/login">Log in again.</a></p>'));
  if (!U.limit(`login:${req.ip}`, 20, 900000) || !U.limit(`login2fa:${row.user_id}`, 10, 900000)) {
    return res.status(429).send(V.login2fa(req.ctx, { err: 'Too many attempts. Wait 15 minutes and try again.' }, token));
  }
  if (!useCode(q.userById.get(row.user_id), req.body.code)) return res.status(401).send(V.login2fa(req.ctx, { err: 'That code is not right. Codes change every 30 seconds.' }, token));
  if (!useToken(token, 'login2fa')) return res.redirect('/login');
  startSession(res, row.user_id);
  res.redirect('/dashboard');
});
main.post('/logout', (req, res) => {
  if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  res.clearCookie(COOKIE, { path: '/', secure: cfg.SECURE });
  res.redirect('/');
});
main.get('/forgot', (req, res) => res.send(V.forgot(req.ctx)));
main.post('/forgot', async (req, res) => {
  const user = q.userByEmail.get(String(req.body.email || '').trim().toLowerCase());
  if (user && U.limit(`forgot:${user.id}`, 3, 3600000) && U.limit(`forgot:${req.ip}`, 10, 3600000)) {
    await sendMail(user.email, `Reset your ${cfg.SITE_NAME} password`, `Reset the password for ${user.username}:\n\n${cfg.BASE_URL}/reset?token=${makeToken(user.id, 'reset', 3600000)}\n\nThe link works for one hour. If you did not ask for this, ignore it.`);
  }
  res.send(V.notice(req.ctx, 'Check your email', '<p>If that address has a site here, a reset link is on its way.</p>'));
});
main.get('/reset', (req, res) => res.send(V.reset(req.ctx, null, String(req.query.token || ''))));
main.post('/reset', async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 10 || password.length > 200) return res.status(400).send(V.reset(req.ctx, { err: 'Use a password with at least 10 characters.' }, String(req.body.token || '')));
  const expired = () => res.status(400).send(V.notice(req.ctx, 'Link expired', '<p>That reset link is no longer valid. <a href="/forgot">Request a new one.</a></p>'));
  if (!U.limit(`reset:${req.ip}`, 10, 3600000)) return res.status(429).send(V.notice(req.ctx, 'Slow down', '<p>Too many reset attempts from your connection. Try again in an hour.</p>'));
  if (!tokenLive(req.body.token, 'reset')) return expired(); // hashing costs real time, so only for a link that works
  const pwHash = await U.hashPw(password); // before the token is spent, so nothing else can run between spending it and using it
  const user = useToken(req.body.token, 'reset');
  if (!user) return expired();
  db.prepare("UPDATE users SET pw_hash = ?, verified = 1 WHERE id = ?").run(pwHash, user.id);
  db.prepare(`UPDATE users SET api_key = '' WHERE id IN ${loginIds}`).run(user.id, user.id); // a reset may follow a break-in, so the API keys of all its sites go too
  db.prepare(`DELETE FROM sessions WHERE user_id IN ${loginIds}`).run(user.id, user.id);
  dropLogins(user.id);
  // the reset link proves the email only; with two-factor on, logging in still takes a code
  if (user.totp_secret) return res.send(V.notice(req.ctx, 'Password saved', '<p>Your new password is saved. <a href="/login">Log in</a> with it and a code from your authenticator app.</p>'));
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
  res.status(status).send(V.dashboard(req.ctx, m, { dir, entries, used: usage(user.username), quota: limitsFor(user).quotaMB, fileMB: limitsFor(user).fileMB, support: cfg.SUPPORT_ON || isSupporter(ownerRow(user)), bandwidth: bwToday(user), listed: isListed(user), hasIndex: hasIndex(user), sites: sitesOf(user), canAdd: isSupporter(ownerRow(user)) && !user.banned && sitesOf(user).length < MAX_SITES }));
}
const hasIndex = (user) => { try { return fs.statSync(path.join(siteDir(user.username), 'index.html')).isFile(); } catch { return false; } };
// ?ok= and ?err= carry the result of a redirect (and of the drag-and-drop uploader); the dashboard is only ever shown to its owner
const msgOf = (req) => (req.query.ok || req.query.err ? { ok: String(req.query.ok || ''), err: String(req.query.err || '') } : null);
main.get('/dashboard', auth, (req, res) => showDashboard(req, res, msgOf(req)));

// The path a file named `name` gets in folder `dir`, or null if its name or type is not allowed
const uploadRel = (dir, name, anyType) => U.safeRel((dir ? dir + '/' : '') + name.replace(/\\/g, '/').replace(/\s+/g, '_'), { anyType });

// write beside the target and rename over it, so a failed write never leaves a replaced file half-written
function writeAtomic(full, data) {
  const tmp = `${full}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, full);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
const MAX_FILES = 2000; // the byte quota alone lets a member mint unlimited empty files; this is far above any real site

// Write uploaded or unzipped files into a member's folder through the same checks: safe name, allowed type, quota.
// Each file is { name, data } in memory or { name, path, size } in UPLOAD_TMP; the caller removes temp files that were not moved in.
function saveFiles(user, dir, files, skipped) {
  const size = usage(user.username);
  const lim = limitsFor(user);
  let used = size.total;
  let count = size.count;
  const saved = [];
  for (const f of files) {
    const rel = uploadRel(dir, f.name, lim.anyType);
    const full = rel && resolveIn(user, rel);
    if (!full) { skipped.push(`${f.name} (name or file type not allowed)`); continue; }
    const exists = fs.existsSync(full);
    const old = exists && fs.statSync(full).isFile() ? fs.statSync(full).size : 0;
    if (!exists && count >= MAX_FILES) { skipped.push(`${f.name} (too many files: ${MAX_FILES} max)`); continue; }
    const bytes = f.data ? f.data.length : f.size;
    if (bytes > lim.fileMB * 1048576) { skipped.push(`${f.name} (bigger than ${lim.fileMB} MB)`); continue; }
    if (used - old + bytes > lim.quotaMB * 1048576) { skipped.push(`${f.name} (over your ${lim.quotaMB} MB limit)`); continue; }
    try {
      if (f.data) writeAtomic(full, f.data);
      else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.renameSync(f.path, full); } // a rename replaces the old file in one step
    } catch {
      skipped.push(`${f.name} (a file or folder with that name is in the way)`);
      continue;
    }
    used += bytes - old;
    if (!exists) count++;
    // record each write as it lands, so a later failure in the batch can't leave the totals short
    usageCache.set(user.username, { total: used, count });
    // only pages and scripts are scanned, so only they are read back
    if (SCANNED.test(rel)) autoFlag(user, rel, f.data ? f.data.toString('utf8') : fs.readFileSync(full, 'utf8'));
    saved.push(rel);
  }
  if (saved.length) markUpdated(user.id, saved);
  return saved;
}
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
  if (!csrfOk(req)) return fail('Form expired. Reload the page and try again.', 403);
  // the body can take a long time to arrive; a ban, reset or deletion meanwhile must stop the write
  if (!stillCurrent(req, req.ctx.user)) return json ? res.status(403).json({ error: 'You were signed out. Sign in and try again.' }) : res.redirect('/login');
  if (err) return fail(err.code === 'LIMIT_FILE_SIZE' ? `Files can be at most ${limitsFor(req.ctx.user).fileMB} MB each.` : 'Upload failed. Send at most 20 files at a time.', 400);
  const dir = U.safeRel(req.body.dir || '', { file: false });
  if (dir === null) return fail('That folder name is not allowed.', 400);
  const skipped = [];
  const files = (req.files || []).map((f) => ({ name: path.basename(f.originalname.replace(/\\/g, '/')), path: f.path, size: f.size }));
  if (req.body.shrink === '1') {
    for (const f of files) f.size = await U.shrinkImage(f.path, f.name);
    // the shrinking took a while; a ban, reset or deletion meanwhile must still stop the write
    if (!stillCurrent(req, req.ctx.user)) return json ? res.status(403).json({ error: 'You were signed out. Sign in and try again.' }) : res.redirect('/login');
  }
  const saved = saveFiles(req.ctx.user, dir, files, skipped);
  if (json) return res.json({ saved: saved.length, skipped });
  showDashboard(req, res, savedMsg(saved, skipped, 'Uploaded'));
}

// Import a whole site from one .zip, unpacked into the current folder
const zipUpload = multer({ storage: tmpStorage, limits: { fileSize: cfg.ZIP_MAX_MB * 1048576, files: 1 } }).single('zip');
main.post('/dashboard/import', auth, canEdit, tempBudget((req) => (cfg.ZIP_MAX_MB + limitsFor(req.ctx.user).quotaMB) * 1048576), (req, res, next) => zipUpload(req, res, (err) => importZip(req, res, err).catch(next).finally(() => dropTemp([req.file]))));
async function importZip(req, res, err) {
  if (!csrfOk(req)) return res.status(403).type('text').send('Form expired. Go back, reload and try again.');
  if (err) return showDashboard(req, res, { err: err.code === 'LIMIT_FILE_SIZE' ? `Zip files can be at most ${cfg.ZIP_MAX_MB} MB.` : 'Import failed. Send one .zip file.' }, 400);
  if (!req.file) return showDashboard(req, res, { err: 'Choose a .zip file to import.' }, 400);
  const dir = U.safeRel(req.body.dir || '', { file: false });
  if (dir === null) return showDashboard(req, res, { err: 'That folder name is not allowed.' }, 400);
  if (!U.limit(`import:${req.ctx.user.id}`, 10, 3600000)) return showDashboard(req, res, { err: 'That is a lot of imports. Try again in an hour.' }, 429);
  let zip;
  try {
    const lim = limitsFor(req.ctx.user);
    zip = await readZip(req.file.path, { tmpDir: UPLOAD_TMP, maxFileBytes: lim.fileMB * 1048576, maxTotalBytes: lim.quotaMB * 1048576, allowed: (name) => !!uploadRel(dir, name, lim.anyType) });
  } catch (e) {
    return showDashboard(req, res, { err: `That zip file could not be read (${e.message}). Nothing was imported.` }, 400);
  }
  const skipped = zip.skipped;
  try {
    if (!stillCurrent(req, req.ctx.user)) return res.redirect('/login'); // signed out, banned or deleted while the zip arrived
    showDashboard(req, res, savedMsg(saveFiles(req.ctx.user, dir, zip.files, skipped), skipped, 'Imported'));
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
const siteImages = async (user, rel) => (/\.html?$/i.test(rel) ? (await U.listFiles(siteDir(user.username))).filter((f) => IMAGE.test(f)).sort() : []);
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
// write one text file through the file-count and quota checks; returns why it was not saved, or null once it is
function saveText(user, full, content) {
  const size = Buffer.byteLength(content);
  const exists = fs.existsSync(full) && fs.statSync(full).isFile();
  const old = exists ? fs.statSync(full).size : 0;
  const used = usage(user.username);
  const lim = limitsFor(user);
  if (!exists && used.count >= MAX_FILES) return `your site already has ${MAX_FILES} files, the most we keep`;
  if (size > lim.fileMB * 1048576) return `files can be at most ${lim.fileMB} MB`;
  if (used.total - old + size > lim.quotaMB * 1048576) return `this would go over your ${lim.quotaMB} MB limit`;
  try {
    writeAtomic(full, content);
  } catch {
    return 'a file or folder with that name is in the way';
  }
  usageCache.set(user.username, { total: used.total - old + size, count: used.count + (exists ? 0 : 1) });
  return null;
}
main.post('/dashboard/save', auth, canEdit, async (req, res) => {
  const user = req.ctx.user;
  const rel = U.safeRel(req.body.path);
  const full = rel && U.TEXT_EXT.has(U.extOf(rel)) && resolveIn(user, rel);
  if (!full) return res.status(400).send(V.notice(req.ctx, 'Cannot save', '<p>That file path is not allowed. <a href="/dashboard">Back to my site.</a></p>'));
  const content = String(req.body.content ?? '').replace(/\r\n/g, '\n');
  const isNew = !(fs.existsSync(full) && fs.statSync(full).isFile());
  const err = saveText(user, full, content);
  const images = await siteImages(user, rel);
  if (err) return res.status(400).send(V.editor(req.ctx, { err: `Not saved: ${err}.` }, { rel, content, isNew, images }));
  autoFlag(user, rel, content);
  markUpdated(user.id, [rel]);
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
    images: (await U.listFiles(root)).filter((f) => style.IMAGE.test(f)).sort(), // for "use my own" background
  }));
});
main.post('/dashboard/style', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  // "one of my own pictures" sends the picture in a separate field
  const s = style.clean({ ...req.body, bg: req.body.bg === 'own' ? req.body.ownbg : req.body.bg });
  if (!s) return res.redirect(`/dashboard/style?err=${encodeURIComponent('Pick each setting from the form.')}`);
  const full = path.join(siteDir(user.username), 'puppypad.css');
  const err = saveText(user, full, style.merge(readText(full), s, cfg.BASE_URL));
  if (err) return res.redirect(`/dashboard/style?err=${encodeURIComponent(`Not saved: ${err}.`)}`);
  markUpdated(user.id, ['puppypad.css']);
  res.redirect(`/dashboard/style?ok=${encodeURIComponent('Saved puppypad.css.')}`);
});
main.post('/dashboard/style/link', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const full = path.join(siteDir(user.username), 'index.html');
  const html = readText(full);
  if (html === null || style.hasLink(html)) return res.redirect('/dashboard/style');
  const content = style.link(html);
  const err = saveText(user, full, content);
  if (err) return res.redirect(`/dashboard/style?err=${encodeURIComponent(`Not linked: ${err}.`)}`);
  autoFlag(user, 'index.html', content);
  markUpdated(user.id, ['index.html']);
  res.redirect(`/dashboard/style?ok=${encodeURIComponent('Your front page now uses puppypad.css.')}`);
});
// put a starter layout back as the front page: straight away when there is none, after a confirm when it would replace one
main.post('/dashboard/starter', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  if (!starters.valid(req.body.starter)) return showDashboard(req, res, { err: 'Pick one of the starter layouts.' }, 400);
  const full = path.join(siteDir(user.username), 'index.html');
  const exists = hasIndex(user);
  if (exists && req.body.confirm !== '1') return res.send(V.starterConfirm(req.ctx, req.body.starter));
  if (!U.limit(`starter:${user.id}`, 20, 3600000)) return showDashboard(req, res, { err: 'That is a lot of fresh starts. Try again in an hour.' }, 429);
  const err = saveText(user, full, starters.render(req.body.starter, user.username, cfg));
  if (err) return showDashboard(req, res, { err: `Not made: ${err}.` }, 400);
  // a fresh screenshot, but not an edit: a starter alone doesn't put a site on the public lists
  db.prepare('UPDATE users SET shot_dirty = 1, starter = ? WHERE id = ?').run(req.body.starter, user.id);
  recordHistory(user, 'starter');
  const name = starters.LIST.find((s) => s.id === req.body.starter).name;
  res.redirect(`/dashboard?ok=${encodeURIComponent(`${exists ? 'Replaced' : 'Made'} your front page (index.html) from the ${name} starter.`)}`);
});
// delete one of a member's files, and the folders that leaves empty; false when there is no such file
function deleteFile(user, rel) {
  const full = rel && resolveIn(user, rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const { size } = fs.statSync(full);
  const used = usage(user.username);
  fs.unlinkSync(full);
  usageCache.set(user.username, { total: used.total - size, count: used.count - 1 });
  const root = siteDir(user.username);
  for (let d = path.dirname(full); d !== root && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d); // tidy empty folders
  return true;
}
main.post('/dashboard/delete', auth, canEdit, (req, res) => {
  if (deleteFile(req.ctx.user, U.safeRel(req.body.path, { anyType: true }))) markUpdated(req.ctx.user.id);
  res.redirect(`/dashboard?ok=${encodeURIComponent('File deleted.')}`);
});
// rename or move a file or folder; folders keep their contents, and nothing is ever overwritten
const isDirAt = (full) => !!full && fs.existsSync(full) && fs.statSync(full).isDirectory();
const depthBelow = (full) => Math.max(0, ...fs.readdirSync(full, { withFileTypes: true }).map((e) => (e.isDirectory() ? 1 + depthBelow(path.join(full, e.name)) : 1)));
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
  const dir = isDirAt(src);
  const want = String(req.body.to || '').trim().replace(/^\/+|\/+$/g, '');
  const fail = (err) => res.status(400).send(V.move(req.ctx, { err }, { from, to: want, dir }));
  const to = U.safeRel(want, { file: !dir, anyType: limitsFor(user).anyType });
  const dst = to && resolveIn(user, to);
  if (!dst) return fail(dir
    ? 'Use a folder path like pics or old/pics, made of letters, numbers, dots, hyphens and underscores.'
    : 'Use a path like about.html or pics/cat.png, made of letters, numbers, dots, hyphens and underscores, ending in an allowed file type.');
  if (to === from) return fail('That is where it already is.');
  if (dir && (to + '/').startsWith(from + '/')) return fail('A folder cannot go inside itself.');
  if (fs.existsSync(dst)) return fail(`Something called ${to} is already there. Pick another name.`);
  if (dir && to.split('/').length + depthBelow(src) > 6) return fail('That would nest files more than 6 folders deep.');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  } catch {
    return fail('Not moved: a file is in the way of that path.');
  }
  usageCache.set(user.username, { ...usage(user.username) }); // same totals, new entry: a refresh walking mid-move may have counted it twice or not at all
  const root = siteDir(user.username);
  for (let d = path.dirname(src); d !== root && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d); // tidy empty folders
  // a .txt renamed to .html becomes a page, so it gets the same phishing check a saved page does
  if (!dir && SCANNED.test(to) && !SCANNED.test(from)) autoFlag(user, to, fs.readFileSync(dst, 'utf8'));
  markUpdated(user.id, dir ? [] : [to]); // a folder is no page to link to
  const parent = to.split('/').slice(0, -1).join('/');
  res.redirect(`/dashboard?dir=${encodeURIComponent(parent)}&ok=${encodeURIComponent(`Moved ${from} to ${to}.`)}`);
});
// file history: deleted files to bring back, every kept version of one file, and putting an old version back
main.get('/dashboard/history', auth, async (req, res) => {
  const user = req.ctx.user;
  const all = await H.deleted(user.id, siteDir(user.username));
  const { page, pages } = pageOf(req, all.length);
  res.send(V.historyDeleted(req.ctx, msgOf(req), { rows: all.slice((page - 1) * PER_PAGE, page * PER_PAGE), page, pages, days: historyDays(user) }));
});
main.get('/dashboard/history/file', auth, async (req, res) => {
  const user = req.ctx.user;
  const rel = U.safeRel(req.query.path);
  if (!rel || !U.TEXT_EXT.has(U.extOf(rel))) return showDashboard(req, res, { err: 'Only pages and other text files have a history.' }, 400);
  const tree = siteDir(user.username);
  const all = await H.versions(user.id, tree, rel);
  const { page, pages } = pageOf(req, all.length);
  res.send(V.history(req.ctx, msgOf(req), { rel, rows: all.slice((page - 1) * PER_PAGE, page * PER_PAGE), page, pages, exists: fs.existsSync(path.join(tree, rel)), days: historyDays(user) }));
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
  const err = saveText(user, full, old);
  if (err) return back('err', `Not restored: ${err}.`);
  autoFlag(user, rel, old.toString('utf8'));
  markUpdated(user.id, [rel]);
  back('ok', `Restored ${rel}. The version it replaced is kept in this list too.`);
});
main.get('/dashboard/links', auth, async (req, res) => {
  if (!U.limit(`links:${req.ctx.user.id}`, 30, 3600000)) return showDashboard(req, res, { err: 'That is a lot of link checks. Try again in an hour.' }, 429);
  res.send(V.links(req.ctx, await U.brokenLinks(siteDir(req.ctx.user.username))));
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
main.post('/dashboard/sites/new', auth, canEdit, (req, res) => {
  const owner = ownerRow(req.ctx.user);
  const username = String(req.body.username || '').trim().toLowerCase();
  const fail = (e) => res.redirect(`/dashboard?err=${encodeURIComponent(e)}`);
  if (!isSupporter(owner)) return fail('Several sites under one login is for supporters.');
  if (sitesOf(owner).length >= MAX_SITES) return fail(`You can have up to ${MAX_SITES} sites.`);
  if (!U.validUsername(username)) return fail('That site name is not available. Use 3-30 lowercase letters, numbers or hyphens.');
  if (q.userByName.get(username) || db.prepare('SELECT 1 FROM released_names WHERE name = ? AND released_at > ?').get(username, now() - NAME_HOLD)) return fail('That site name is taken.');
  const t = now();
  try {
    db.prepare("INSERT INTO users (username, email, pw_hash, verified, owner_id, signup_ip, starter, quota_mb, created_at, updated_at) VALUES (?,?,'!',1,?,?,?,?,?,?)")
      .run(username, `${username}@sites.invalid`, owner.id, req.ip, starters.DEFAULT, cfg.QUOTA_MB, t, t);
  } catch (err) { if (String(err && err.code).includes('CONSTRAINT')) return fail('That site name is taken.'); throw err; }
  try {
    fs.mkdirSync(siteDir(username), { recursive: true });
    fs.writeFileSync(path.join(siteDir(username), 'index.html'), starters.render(starters.DEFAULT, username, cfg));
    const site = q.userByName.get(username);
    H.remove(site.id); // as at signup: a reused id must start clean
    recordHistory(site, 'history begins');
  } catch {
    db.prepare('DELETE FROM users WHERE username = ?').run(username);
    fs.rmSync(siteDir(username), { recursive: true, force: true });
    return fail('Something went wrong making that site. Nothing was changed.');
  }
  res.redirect(`/dashboard?ok=${encodeURIComponent(`Made ${username}. Switch to it from the list at the top.`)}`);
});
main.post('/dashboard/sites/switch', auth, (req, res) => {
  const target = sitesOf(req.ctx.user).find((s) => s.id === Number(req.body.id));
  if (target) db.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(target.id, req.sessionHash);
  res.redirect('/dashboard');
});
main.post('/dashboard/hidden', auth, canEdit, (req, res) => {
  const hide = req.body.hidden === '1';
  db.prepare('UPDATE users SET hidden = ? WHERE id = ?').run(hide ? 1 : 0, req.ctx.user.id);
  res.redirect(`/dashboard?ok=${encodeURIComponent(hide ? 'Your site is hidden from browsing.' : 'Your site is back in the listings.')}`);
});
main.get('/dashboard/guestbook', auth, (req, res) => res.send(V.guestbookAdmin(req.ctx, null, gbPage(req, req.ctx.user.id, true), lines(req.ctx.user.gb_ips))));
// an entry's buttons send the page they were on, so the owner lands back there
const gbBack = (req) => `/dashboard/guestbook${Number(req.body.page) > 1 ? `?page=${Number(req.body.page)}` : ''}`;
main.post('/dashboard/guestbook/approve', auth, (req, res) => {
  db.prepare('UPDATE guestbook SET approved = 1 WHERE id = ? AND user_id = ?').run(Number(req.body.id) || 0, req.ctx.user.id);
  res.redirect(gbBack(req));
});
main.post('/dashboard/guestbook/notify', auth, (req, res) => {
  // the digest restarts from now, so switching from instant never repeats entries already mailed
  // saving the same setting again keeps entries already waiting for the digest
  if (GB_NOTIFY.includes(req.body.notify)) {
    // one ms back, so an entry signed in the same millisecond as the switch still makes the digest (it counts entries after gb_digest_at)
    db.prepare('UPDATE users SET gb_digest_at = CASE WHEN gb_notify = @v THEN gb_digest_at ELSE @t END, gb_notify = @v WHERE id = @id').run({ v: req.body.notify, t: now() - 1, id: req.ctx.user.id });
  }
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/settings', auth, (req, res) => {
  db.prepare('UPDATE users SET gb_words = ? WHERE id = ?').run(lines(req.body.words).slice(0, 100).map((l) => l.slice(0, 60)).join('\n'), req.ctx.user.id);
  res.redirect('/dashboard/guestbook');
});
const setIps = (id, ips) => db.prepare('UPDATE users SET gb_ips = ? WHERE id = ?').run(ips.slice(-200).join('\n'), id);
main.post('/dashboard/guestbook/block-ip', auth, (req, res) => {
  const e = db.prepare('SELECT ip FROM guestbook WHERE id = ? AND user_id = ?').get(Number(req.body.id) || 0, req.ctx.user.id);
  const ips = lines(req.ctx.user.gb_ips);
  if (e && e.ip && !ips.includes(e.ip)) setIps(req.ctx.user.id, [...ips, e.ip]);
  res.redirect(gbBack(req));
});
main.post('/dashboard/guestbook/unblock-ip', auth, (req, res) => {
  setIps(req.ctx.user.id, lines(req.ctx.user.gb_ips).filter((ip) => ip !== req.body.ip));
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/delete', auth, (req, res) => {
  db.prepare('DELETE FROM guestbook WHERE id = ? AND user_id = ?').run(Number(req.body.id) || 0, req.ctx.user.id);
  res.redirect(gbBack(req));
});
main.post('/account/password', auth, async (req, res) => {
  const user = ownerRow(req.ctx.user); // an extra site has no password, email or 2FA of its own
  const fail = (err, code = 400) => showProfile(req, res, user.username, { err }, code);
  const password = String(req.body.new_password || '');
  if (!U.limit(`pwchange:${user.id}`, 10, 900000)) return fail('Too many attempts. Wait 15 minutes and try again.', 429);
  if (!(await U.checkPw(String(req.body.password || ''), user.pw_hash))) return fail('Your current password is wrong. Nothing was changed.');
  if (password.length < 10 || password.length > 200) return fail('Use a new password with at least 10 characters.');
  if (password !== String(req.body.confirm_password || '')) return fail('The two new passwords do not match.');
  if (await U.checkPw(password, user.pw_hash)) return fail('Your new password has to be different from the current one.');
  const pwHash = await U.hashPw(password);
  if (!stillCurrent(req, user)) return res.redirect('/login');
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, user.id);
  db.prepare(`UPDATE users SET api_key = '' WHERE id IN ${loginIds}`).run(user.id, user.id);
  // log out everywhere else and switch off the API key, in case the old password leaked
  db.prepare(`DELETE FROM sessions WHERE user_id IN ${loginIds} AND token_hash != ?`).run(user.id, user.id, req.sessionHash);
  dropLogins(user.id);
  res.redirect(`/site/${user.username}?ok=${encodeURIComponent('Password changed. Other devices are logged out.')}`);
});
// a new email takes effect only once its owner clicks the link sent there; the old address hears about it either way
main.post('/account/email', auth, async (req, res) => {
  const user = ownerRow(req.ctx.user);
  const fail = (err, code = 400) => showProfile(req, res, user.username, { err }, code);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!U.limit(`emailchange:${user.id}`, 5, 3600000)) return fail('Too many attempts. Try again in an hour.', 429);
  if (!(await U.checkPw(String(req.body.password || ''), user.pw_hash))) return fail('Your password is wrong. Nothing was changed.');
  if (!stillCurrent(req, user)) return res.redirect('/login');
  if (!validEmail(email)) return fail('That email address does not look right.');
  if (email === user.email) return fail('That is already your email address.');
  if (q.userByEmail.get(email)) return fail('That email already has a site.');
  db.prepare('UPDATE users SET new_email = ? WHERE id = ?').run(email, user.id);
  await sendMail(email, `Confirm your new ${cfg.SITE_NAME} email`,
    `Confirm this address for ${user.username}.${cfg.BASE_HOST}:\n\n${cfg.BASE_URL}/account/email/confirm?token=${makeToken(user.id, 'email', 2 * DAY)}\n\nThe link works for 48 hours. If you did not ask for this, ignore it.`);
  await sendMail(user.email, `Your ${cfg.SITE_NAME} email is being changed`,
    `Someone logged in as ${user.username} asked to move the account to ${email}. It changes once that address confirms.\n\nIf this was not you, reset your password now: ${cfg.BASE_URL}/forgot`);
  res.redirect(`/site/${user.username}?ok=${encodeURIComponent(`Check ${email} for a confirmation link. Your email changes when you click it.`)}`);
});
main.get('/account/email/confirm', (req, res) => {
  const user = useToken(req.query.token, 'email');
  const done = (title, html, code = 200) => res.status(code).send(V.notice(req.ctx, title, html));
  if (!user || !user.new_email) return done('Link expired', '<p>That confirmation link is no longer valid. Ask for a new one from your profile page.</p>', 400);
  if (q.userByEmail.get(user.new_email)) return done('Email taken', '<p>Another site signed up with that address in the meantime. Nothing was changed.</p>', 400);
  db.prepare('UPDATE users SET email = ?, new_email = NULL WHERE id = ?').run(user.new_email, user.id);
  sendMail(user.email, `Your ${cfg.SITE_NAME} email was changed`,
    `The email for ${user.username} is now ${user.new_email}. Mail about the site goes there from now on.\n\nIf this was not you, write to ${cfg.ABUSE_EMAIL}.`);
  done('Email changed', `<p>Your email is now <b>${U.esc(user.new_email)}</b>.</p>`);
});
// every session of this member ends, this one too: for a login left open on a computer that isn't theirs
main.post('/account/logout-all', auth, (req, res) => {
  db.prepare(`DELETE FROM sessions WHERE user_id IN ${loginIds}`).run(ownerRow(req.ctx.user).id, ownerRow(req.ctx.user).id);
  dropLogins(ownerRow(req.ctx.user).id);
  res.clearCookie(COOKIE, { path: '/', secure: cfg.SECURE });
  res.send(V.notice(req.ctx, 'Logged out everywhere', '<p>Every browser and device that was logged in to your site is logged out now. <a href="/login">Log in again.</a></p>'));
});
// a code from the member's app, used at most once (its step must be newer than the last one used), or one of their recovery codes
function useCode(user, raw) {
  if (!user || !user.totp_secret) return false;
  const code = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\d{6}$/.test(code)) {
    const step = U.totpStep(user.totp_secret, code);
    return !!step && db.prepare('UPDATE users SET totp_step = ? WHERE id = ? AND totp_step < ?').run(step, user.id, step).changes === 1;
  }
  const codes = lines(user.totp_codes);
  const left = codes.filter((h) => h !== U.sha(code));
  return code.length === 10 && left.length < codes.length &&
    db.prepare('UPDATE users SET totp_codes = ? WHERE id = ? AND totp_codes = ?').run(left.join('\n'), user.id, user.totp_codes).changes === 1;
}
const otpauth = (user, secret) => `otpauth://totp/${encodeURIComponent(`${cfg.SITE_NAME}:${user.username}`)}?secret=${secret}&issuer=${encodeURIComponent(cfg.SITE_NAME)}`;
// the setup page: the key as text, a link and a QR code, all for the same otpauth address
const twoFactorPage = async (req, m, secret) => {
  const uri = otpauth(req.ctx.user, secret);
  return V.twoFactor(req.ctx, m, secret, uri, await QRCode.toString(uri, { type: 'svg', margin: 2 }));
};
main.get('/account/2fa', auth, async (req, res) => {
  if (ownerRow(req.ctx.user).totp_secret) return res.redirect(`/site/${req.ctx.user.username}#security`);
  const secret = U.newTotpSecret();
  res.set('Cache-Control', 'no-store').send(await twoFactorPage(req, null, secret));
});
main.post('/account/2fa/on', auth, async (req, res) => {
  const user = ownerRow(req.ctx.user);
  const secret = String(req.body.secret || '');
  if (!/^[A-Z2-7]{32}$/.test(secret)) return res.redirect('/account/2fa');
  const fail = async (err, code = 400) => res.status(code).set('Cache-Control', 'no-store').send(await twoFactorPage(req, { err }, secret));
  if (!U.limit(`2fa:${user.id}`, 10, 900000)) return fail('Too many attempts. Wait 15 minutes and try again.', 429);
  if (!(await U.checkPw(String(req.body.password || ''), user.pw_hash))) return fail('Your password is wrong. Two-factor login is still off.');
  const step = U.totpStep(secret, String(req.body.code || '').replace(/\D/g, ''));
  if (!step) return fail('That code is not right. Check the key in your app and try the newest code.');
  if (!stillCurrent(req, user)) return res.redirect('/login');
  const codes = Array.from({ length: 10 }, () => U.newTotpSecret().slice(0, 10).toLowerCase());
  if (!db.prepare("UPDATE users SET totp_secret = ?, totp_step = ?, totp_codes = ? WHERE id = ? AND totp_secret = ''").run(secret, step, codes.map(U.sha).join('\n'), user.id).changes) {
    return res.redirect(`/site/${user.username}#security`); // already on, from another tab
  }
  res.set('Cache-Control', 'no-store').send(V.recoveryCodes(req.ctx, codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`)));
});
main.post('/account/2fa/off', auth, async (req, res) => {
  const user = ownerRow(req.ctx.user);
  const fail = (err, code = 400) => showProfile(req, res, user.username, { err }, code);
  if (!U.limit(`2fa:${user.id}`, 10, 900000)) return fail('Too many attempts. Wait 15 minutes and try again.', 429);
  if (!(await U.checkPw(String(req.body.password || ''), user.pw_hash))) return fail('Your password is wrong. Two-factor login is still on.');
  if (!stillCurrent(req, user)) return res.redirect('/login');
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
  if (!U.limit(`rename:${user.id}`, 5, 900000)) return fail('Too many attempts. Wait 15 minutes and try again.', 429);
  if (!(await U.checkPw(String(req.body.password || ''), ownerRow(user).pw_hash))) return fail('Wrong password. Nothing was changed.');
  if (!stillCurrent(req, user)) return res.redirect('/login');
  // a member may take back a name they gave up themselves
  const held = db.prepare('SELECT user_id FROM released_names WHERE name = ? AND released_at > ?').get(name, now() - NAME_HOLD);
  if (q.userByName.get(name) || (held && held.user_id !== user.id)) return fail('That site name is taken.');
  const t = now();
  try {
    fs.mkdirSync(siteDir(user.username), { recursive: true });
    db.transaction(() => {
      db.prepare('UPDATE users SET username = ?, renamed_at = ?, shot_dirty = 1 WHERE id = ?').run(name, t, user.id);
      db.prepare('DELETE FROM released_names WHERE name = ?').run(name);
      db.prepare('INSERT OR REPLACE INTO released_names (name, released_at, user_id) VALUES (?, ?, ?)').run(user.username, t, user.id);
      db.prepare('UPDATE reports SET site = ? WHERE site = ?').run(name, user.username);
      fs.renameSync(siteDir(user.username), siteDir(name)); // last, so a failed move rolls the rows back
    })();
  } catch (err) {
    if (String(err && err.code).includes('CONSTRAINT')) return fail('That site name is taken.'); // a signup took it meanwhile
    console.error('rename failed:', err.message);
    return fail('Something went wrong renaming your site. Nothing was changed.', 500);
  }
  try { fs.renameSync(shotPath(user.username), shotPath(name)); } catch { /* none yet; shot_dirty brings one */ }
  if (usageCache.has(user.username)) { usageCache.set(name, usageCache.get(user.username)); usageCache.delete(user.username); }
  res.redirect(`/dashboard?ok=${encodeURIComponent(`Your site is now ${cfg.siteUrl(name)}. The old address redirects there for 90 days. Pages that spell out the old address or name need editing by hand.`)}`);
});
main.post('/dashboard/delete-account', auth, async (req, res) => {
  if (!U.limit(`delacct:${req.ctx.user.id}`, 5, 900000)) return showDashboard(req, res, { err: 'Too many attempts. Wait 15 minutes and try again.' }, 429);
  if (!(await U.checkPw(String(req.body.password || ''), ownerRow(req.ctx.user).pw_hash))) return showDashboard(req, res, { err: 'Wrong password. Nothing was deleted.' }, 400);
  if (!stillCurrent(req, req.ctx.user)) return res.redirect('/login');
  if (req.ctx.user.owner_id) { // an extra site goes alone, and the session moves back to the login
    db.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(req.ctx.user.owner_id, req.sessionHash);
    deleteAccount(req.ctx.user);
    return res.redirect(`/dashboard?ok=${encodeURIComponent(`Deleted ${req.ctx.user.username} and its files.`)}`);
  }
  if (!(await cancelBilling(req.ctx.user))) return showDashboard(req, res, { err: 'Stripe could not be reached to cancel your supporter payments, so nothing was deleted. Try again in a little while.' }, 502);
  deleteAccount(req.ctx.user);
  res.clearCookie(COOKIE, { path: '/', secure: cfg.SECURE });
  res.send(V.notice({ ...req.ctx, user: null }, 'Account deleted', '<p>Your site and files are gone. Thanks for stopping by.</p>'));
});

// ----- supporter tier (Stripe) -----
// a deleted login must stop paying: its subscriptions are cancelled first, and the account stays if Stripe can't be reached
async function cancelBilling(user) {
  if (user.owner_id || !user.stripe_customer_id || !stripe) return true;
  try {
    for await (const sub of stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'all' })) {
      if (!['canceled', 'incomplete_expired'].includes(sub.status)) await stripe.subscriptions.cancel(sub.id);
    }
    return true;
  } catch (e) {
    console.error('stripe cancel failed:', e.message);
    return false;
  }
}
// supporting is per login: an extra site's page shows and pays for the login that owns it
const supportPage = (req, res, m, status = 200) => res.status(status).send(V.support(req.ctx, m, {
  until: req.ctx.login.supporter_until, customer: !!req.ctx.login.stripe_customer_id, limits: limitsFor(req.ctx.user),
}));
main.get('/dashboard/support', auth, (req, res) => (cfg.SUPPORT_ON || isSupporter(req.ctx.login) ? supportPage(req, res, msgOf(req)) : res.redirect('/dashboard')));
// Stripe's hosted Checkout takes the card; the webhook above turns the perks on once it is paid
main.post('/dashboard/support', auth, async (req, res) => {
  if (!stripe) return res.redirect('/dashboard');
  const already = () => supportPage(req, res, { err: 'You already support us. Manage it with the billing button below.' }, 409);
  let login = req.ctx.login;
  if (login.supporter_until > now() && login.stripe_customer_id) return already();
  try {
    // one Stripe customer per login, made before checkout, so a second tab or a payment the webhook hasn't reported yet
    // finds the same customer: an open checkout is reused and a live subscription refuses another
    if (!login.stripe_customer_id) {
      const customer = await stripe.customers.create({ email: login.email, metadata: { user_id: String(login.id) } });
      // two requests at once: the first stored wins, the other customer is left unused
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id = ''").run(customer.id, login.id);
      login = q.userById.get(login.id);
    }
    const subs = await stripe.subscriptions.list({ customer: login.stripe_customer_id, status: 'all', limit: 10 });
    if (subs.data.some((x) => ['active', 'trialing', 'past_due', 'incomplete'].includes(x.status))) return already();
    const open = (await stripe.checkout.sessions.list({ customer: login.stripe_customer_id, status: 'open', limit: 1 })).data[0];
    if (open) return res.redirect(303, open.url);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: String(login.id),
      // flexible billing mode: Stripe's recommended default for predictable proration and invoices
      subscription_data: { metadata: { user_id: String(login.id) }, billing_mode: { type: 'flexible' } },
      customer: login.stripe_customer_id,
      success_url: `${cfg.BASE_URL}/dashboard/support?ok=${encodeURIComponent('Thank you! Your supporter perks switch on as soon as Stripe confirms the payment.')}`,
      cancel_url: `${cfg.BASE_URL}/dashboard/support`,
    });
    res.redirect(303, session.url);
  } catch (e) {
    console.error('stripe checkout failed:', e.message);
    supportPage(req, res, { err: 'Stripe could not be reached. Nothing was charged; try again in a little while.' }, 502);
  }
});
// Stripe's Customer Portal: cancel, change the card, see receipts
main.post('/dashboard/support/portal', auth, async (req, res) => {
  if (!stripe || !req.ctx.login.stripe_customer_id) return res.redirect('/dashboard/support');
  try {
    const session = await stripe.billingPortal.sessions.create({ customer: req.ctx.login.stripe_customer_id, return_url: `${cfg.BASE_URL}/dashboard/support` });
    res.redirect(303, session.url);
  } catch (e) {
    console.error('stripe portal failed:', e.message);
    supportPage(req, res, { err: 'Stripe could not be reached. Try again in a little while.' }, 502);
  }
});

// ----- widgets -----
main.get('/dashboard/widgets', auth, async (req, res) => res.send(V.widgets(req.ctx, msgOf(req), {
  groups: W.groups(cfg, req.ctx.user, isSupporter(req.ctx.login)),
  pages: (await U.listFiles(siteDir(req.ctx.user.username))).filter((f) => /\.html?$/i.test(f)).sort(),
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
  const err = saveText(user, full, src);
  if (err) return back('err', `Not copied: ${err}.`);
  markUpdated(user.id, [rel]);
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
  if (!U.limit(`apikey:${user.id}`, 5, 900000)) return show({ err: 'Too many attempts. Wait 15 minutes and try again.' }, '', 429);
  // a key outlives the session, so making one takes the password, as a rename does
  if (!(await U.checkPw(String(req.body.password || ''), ownerRow(user).pw_hash))) return show({ err: 'Wrong password. No key was made.' }, '', 400);
  if (!stillCurrent(req, user)) return res.redirect('/login');
  const key = `pp_${U.newToken()}`;
  db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(U.sha(key), user.id);
  show(null, key);
});
api.use((req, res, next) => {
  req.headers.accept = 'application/json'; // so shared steps like tempBudget answer in JSON
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  const user = m && db.prepare("SELECT * FROM users WHERE api_key = ? AND api_key != ''").get(U.sha(m[1]));
  if (!user || !user.verified) return res.status(401).json({ error: 'Missing or unknown API key. Make one at /dashboard/api.' });
  if (user.banned) return res.status(403).json({ error: 'A moderator took this site down. Editing is disabled.' });
  if (!U.limit(`api:${user.id}`, 120, 60000)) return res.status(429).set('Retry-After', '60').json({ error: 'Too many requests. Wait a minute.' });
  req.ctx = { cfg, user, csrf: '', isAdmin: false, nonce: '' };
  next();
});
// an upload can take a while to arrive; a new key, a ban or a rename meanwhile stops the write
const apiCurrent = (user) => {
  const cur = q.userById.get(user.id);
  return !!cur && cur.api_key === user.api_key && !cur.banned && cur.renamed_at === user.renamed_at;
};
api.get('/site', (req, res) => {
  const u = req.ctx.user;
  const used = usage(u.username);
  const lim = limitsFor(u);
  res.json({
    name: u.username, url: `${cfg.siteUrl(u.username)}/`, profile: `${cfg.BASE_URL}/site/${u.username}`, listed: isListed(u), hidden: !!u.hidden,
    used_bytes: used.total, quota_bytes: lim.quotaMB * 1048576, files: used.count, max_files: MAX_FILES, max_file_bytes: lim.fileMB * 1048576,
    bandwidth_today_bytes: bwToday(u), bandwidth_cap_bytes: cfg.BANDWIDTH_MB * 1048576, hits: u.hits, updated_at: new Date(u.updated_at).toISOString(),
    allowed_types: [...U.ALLOWED_EXT], any_type: lim.anyType,
  });
});
api.get('/files', async (req, res) => {
  const root = siteDir(req.ctx.user.username);
  const files = [];
  for (const f of (await U.listFiles(root)).sort()) {
    try {
      const full = path.join(root, f);
      const st = await fs.promises.stat(full);
      // the CLI compares hashes to skip unchanged files; mtimes mean nothing after a git checkout
      // shortcut: hashes the whole site on every listing (500 MB at most); cache by size and mtime if listings get slow
      const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(full)).digest('hex');
      files.push({ path: f, size: st.size, modified: st.mtime.toISOString(), sha256 });
    } catch { /* deleted meanwhile */ }
  }
  res.json({ files });
});
// preservePath keeps the folders in a filename like pics/cat.png, so one request can upload a whole tree
api.post('/upload', uploadBudget, (req, res, next) => uploadFiles(req, res, (err) => {
  try {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files can be at most ${limitsFor(req.ctx.user).fileMB} MB each.` : 'Upload failed. Send at most 20 files at a time, in a field called "files".' });
    if (!apiCurrent(req.ctx.user)) return res.status(403).json({ error: 'The API key changed or the site was taken down during the upload.' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files. Send them in a field called "files".' });
    const dir = U.safeRel(req.body?.dir || '', { file: false });
    if (dir === null) return res.status(400).json({ error: 'That folder name is not allowed.' });
    const skipped = [];
    const saved = saveFiles(req.ctx.user, dir, req.files.map((f) => ({ name: f.originalname, path: f.path, size: f.size })), skipped);
    res.json({ saved, skipped });
  } catch (e) { next(e); } finally { dropTemp(req.files || []); }
}, true));
// one file as { path }, or up to 100 as { paths: [...] } with one history entry for the lot
api.post('/delete', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  if (!apiCurrent(req.ctx.user)) return res.status(403).json({ error: 'The API key changed or the site was taken down during the request.' });
  const user = req.ctx.user;
  if (req.body?.paths !== undefined) {
    const list = [req.body.paths].flat();
    if (!list.length || list.length > 100) return res.status(400).json({ error: 'Send between 1 and 100 paths at a time.' });
    const rels = list.map((p) => U.safeRel(p, { anyType: true }));
    const bad = list.find((p, i) => !rels[i]);
    if (bad !== undefined) return res.status(400).json({ error: `That path is not allowed: ${String(bad).slice(0, 100)}` });
    const deleted = [];
    const missing = [];
    for (const rel of new Set(rels)) (deleteFile(user, rel) ? deleted : missing).push(rel);
    if (deleted.length) markUpdated(user.id);
    return res.json({ deleted, missing });
  }
  const rel = U.safeRel(req.body?.path, { anyType: true });
  if (!rel) return res.status(400).json({ error: 'Send the path of one file, like pics/cat.png.' });
  if (!deleteFile(user, rel)) return res.status(404).json({ error: `There is no file called ${rel}.` });
  markUpdated(user.id);
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
  const siteName = String(req.body.site || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[./]/)[0];
  const details = String(req.body.details || '').trim().slice(0, 2000);
  if (req.body.website) return res.send(V.notice(req.ctx, 'Report sent', '<p>Thanks. A moderator will look at it.</p>'));
  if (!U.limit(`report:${req.ip}`, 5, 3600000)) return res.status(429).send(V.report(req.ctx, { err: 'Too many reports from your connection. Try again in an hour.' }, { site: siteName }));
  if (!q.userByName.get(siteName)) return res.status(400).send(V.report(req.ctx, { err: 'There is no site with that name.' }, { site: siteName }));
  if (!details) return res.status(400).send(V.report(req.ctx, { err: 'Tell us what is wrong.' }, { site: siteName }));
  db.prepare('INSERT INTO reports (site, reason, details, reporter_email, ip, created_at) VALUES (?,?,?,?,?,?)')
    .run(siteName, String(req.body.reason || 'Other').slice(0, 60), details, String(req.body.email || '').trim().slice(0, 200), req.ip, now());
  await sendMail(cfg.ABUSE_EMAIL, `[${cfg.SITE_NAME}] report: ${siteName}`, `${req.body.reason}\n\n${details}\n\nReview: ${cfg.BASE_URL}/admin`);
  res.send(V.notice(req.ctx, 'Report sent', '<p>Thanks. A moderator will look at it.</p>'));
});

// who did what in /admin; names are stored as text so the log outlives deleted accounts
const adminLog = (req, action, site, detail = '') => db.prepare('INSERT INTO admin_log (admin, action, site, detail, created_at) VALUES (?,?,?,?,?)')
  .run(req.ctx.user.username, action, site, detail, now());
const showAdmin = (req, res, m) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  // instr, not LIKE, so % and _ in the search are plain characters
  const users = q
    ? db.prepare('SELECT * FROM users WHERE instr(lower(username), lower(@q)) OR instr(lower(email), lower(@q)) OR signup_ip = @q ORDER BY id DESC LIMIT 50').all({ q })
    : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 50').all();
  const open = db.prepare("SELECT COUNT(*) n FROM reports WHERE status = 'open'").get().n;
  const { page, pages } = pageOf(req, open, 'rpage');
  res.send(V.admin(req.ctx, m, {
    q,
    reports: { rows: db.prepare(`SELECT * FROM reports WHERE status = 'open' ORDER BY id DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all(), page, pages },
    log: db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100').all(),
    users: users.map((u) => ({ ...u, disk: usage(u.username).total, bandwidth: bwToday(u) })),
    signups: db.prepare("SELECT date(created_at / 1000, 'unixepoch') day, COUNT(*) n FROM users WHERE created_at >= unixepoch('now', 'start of day', '-13 days') * 1000 GROUP BY day ORDER BY day DESC").all(),
    stats: {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      banned: db.prepare('SELECT COUNT(*) n FROM users WHERE banned > 0').get().n,
      supporters: db.prepare('SELECT COUNT(*) n FROM users WHERE supporter_until > ?').get(now()).n,
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
  if (!target || target.owner_id) return showAdmin(req, res, { err: 'No login with that site name.' });
  const days = Math.max(0, Math.min(3650, Number(req.body.days) || 0));
  db.transaction(() => { db.prepare('UPDATE users SET supporter_until = ? WHERE id = ?').run(days ? now() + days * DAY : 0, target.id); adminLog(req, 'supporter', target.username, `${days} days`); })();
  showAdmin(req, res, { ok: days ? `${target.username} is a supporter for ${days} days.` : `${target.username} is no longer a supporter.` });
});
main.post('/admin/ban', auth, adminOnly, async (req, res) => {
  const target = q.userByName.get(String(req.body.site || '').trim().toLowerCase());
  if (!target) return showAdmin(req, res, { err: 'No site with that name.' });
  const login = ownerRow(target);
  if (isAdmin(login)) return showAdmin(req, res, { err: 'That is an admin account.' });
  const action = req.body.action;
  const reason = String(req.body.reason || '').slice(0, 200);
  if (action === 'delete') {
    if (!(await cancelBilling(target))) return showAdmin(req, res, { err: `Stripe could not be reached to cancel ${target.username}'s supporter payments, so nothing was deleted.` });
    // the rows and the log entry commit together; the files go only after both have
    deleteAccount(target, db.transaction((u) => { deleteAccountRows(u); adminLog(req, 'delete', u.username, reason); }));
    return showAdmin(req, res, { ok: `Deleted ${target.username} and all its files.` });
  }
  const ban = action === 'ban' ? 1 : 0;
  // the state change and its log entry commit together, so no take-down or restore goes unrecorded
  // a login's ban covers its extra sites; an extra site's ban covers only itself, but either ends every session of the login.
  // banned = 2 marks an extra site taken down only along with its login, so restoring the login brings back those
  // and never one a moderator took down on its own (banned = 1)
  const sites = target.owner_id ? [target] : sitesOf(target).filter((s) => s.id === target.id || s.banned === (ban ? 0 : 2));
  db.transaction(() => {
    for (const s of sites) {
      db.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?').run(ban && s.id !== target.id ? 2 : ban, ban ? reason : null, s.id);
      if (ban) db.prepare("UPDATE reports SET status = 'closed' WHERE site = ?").run(s.username);
      else db.prepare('UPDATE users SET shot_dirty = 1 WHERE id = ?').run(s.id);
    }
    adminLog(req, ban ? 'take down' : 'restore', target.username, ban ? reason : '');
    if (ban) db.prepare(`DELETE FROM sessions WHERE user_id IN ${loginIds}`).run(login.id, login.id);
  })();
  if (ban) for (const s of sites) fs.rmSync(shotPath(s.username), { force: true });
  showAdmin(req, res, { ok: ban ? `${target.username} is offline.` : `${target.username} is back online.` });
});

main.use((req, res) => res.status(404).send(V.notice(req.ctx, 'Not found', '<p>No such page. <a href="/">Go home.</a></p>')));
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
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(now());
    db.prepare('DELETE FROM tokens WHERE expires < ?').run(now());
    db.prepare('DELETE FROM released_names WHERE released_at < ?').run(now() - NAME_HOLD);
    db.prepare('UPDATE guestbook SET ip = NULL WHERE ip IS NOT NULL AND created_at < ?').run(now() - IP_KEEP);
    db.prepare('UPDATE reports SET ip = NULL WHERE ip IS NOT NULL AND created_at < ?').run(now() - IP_KEEP);
    const statsFrom = statsSince();
    db.prepare('DELETE FROM page_views WHERE day < ?').run(statsFrom);
    db.prepare('DELETE FROM referrers WHERE day < ?').run(statsFrom);
    for (const u of db.prepare('SELECT * FROM users WHERE verified = 0 AND created_at < ?').all(now() - 3 * DAY)) deleteAccount(u);
    // daily guestbook digests: at most one a day per site, only when someone signed since the last
    for (const u of db.prepare(`SELECT * FROM users WHERE gb_notify = 'daily' AND gb_digest_at < ? AND ${LIVE}`).all(now() - DAY)) {
      const cutoff = now();
      const rows = db.prepare('SELECT * FROM guestbook WHERE user_id = ? AND created_at > ? AND created_at <= ? ORDER BY id').all(u.id, u.gb_digest_at, cutoff);
      if (!rows.length) continue;
      const held = rows.filter((e) => !e.approved).length;
      sendMail(ownerRow(u).email, `${rows.length} new guestbook entr${rows.length === 1 ? 'y' : 'ies'} on ${u.username}.${cfg.BASE_HOST}`,
        `${held ? `${held} of them wait${held === 1 ? 's' : ''} for your approval.\n\n` : ''}${rows.slice(0, 100).map(gbEntryText).join('\n\n')}${rows.length > 100 ? `\n\n...and ${rows.length - 100} more.` : ''}\n\n${gbMailFooter}`)
        // only a digest that went out moves the cutoff, so a failed one is retried at the next hourly run
        .then((sent) => { if (sent) db.prepare('UPDATE users SET gb_digest_at = ? WHERE id = ?').run(cutoff, u.id); });
    }
    // weekly digests of updates from followed sites, for members who opted in; a quiet week sends nothing
    for (const u of db.prepare(`SELECT * FROM users WHERE digest = 1 AND digest_at < ? AND ${LIVE}`).all(now() - 7 * DAY)) {
      const cutoff = now();
      const done = () => db.prepare('UPDATE users SET digest_at = ? WHERE id = ?').run(cutoff, u.id);
      const rows = db.prepare(`SELECT e.*, s.username FROM events e JOIN users s ON s.id = e.user_id
        WHERE e.kind = 'update' AND e.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) AND s.verified = 1 AND s.banned = 0 AND s.hidden = 0
        AND e.created_at > ? AND e.created_at <= ? ORDER BY e.id DESC`).all(u.id, u.digest_at, cutoff);
      if (!rows.length) { done(); continue; }
      sendMail(ownerRow(u).email, `This week on ${cfg.SITE_NAME}: ${rows.length} update${rows.length === 1 ? '' : 's'} from sites you follow`,
        `${rows.slice(0, 100).map((e) => `${e.username} ${V.eventText(e, (f) => f)}\n${cfg.siteUrl(e.username)}/`).join('\n\n')}${rows.length > 100 ? `\n\n...and ${rows.length - 100} more.` : ''}\n\nStop these emails: ${cfg.BASE_URL}/notifications`)
        .then((sent) => { if (sent) done(); }); // a failed digest is retried at the next hourly run
    }
    // temp files are removed when their request ends; anything an hour old was orphaned
    for (const f of fs.readdirSync(UPLOAD_TMP)) {
      const full = path.join(UPLOAD_TMP, f);
      try { if (now() - fs.statSync(full).mtimeMs > 3600000) fs.rmSync(full, { force: true }); } catch { /* finished with meanwhile */ }
    }
  } catch (e) { console.error('housekeeping failed:', e.message); }
};
setInterval(housekeeping, 3600000).unref();
const refreshAll = () => refreshUsage().catch((e) => console.error('disk totals refresh failed:', e.message));
setInterval(refreshAll, 3600000).unref();
const sweepHistory = () => historySweep().catch((e) => console.error('file history sweep failed:', e.message));
setInterval(sweepHistory, DAY).unref();

module.exports = app; // tests import the app without starting a server
app.housekeeping = housekeeping;
app.forgetUsage = (name) => usageCache.delete(name); // for tests that put files on disk behind the app's back
app.refreshUsage = refreshUsage;
app.historySweep = historySweep;

if (require.main === module) {
  const port = Number(env.PORT || 3000);
  app.listen(port, () => console.log(`${cfg.SITE_NAME} listening on :${port} for ${cfg.BASE_URL}`));
  refreshAll(); // so the first /admin view after a restart reads stored totals
  sweepHistory();
}
