const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
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
function autoFlag(user, rel, content) {
  if (!/\.(html?|js|svg)$/i.test(rel)) return;
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
const tempBudget = (bytes) => (req, res, next) => {
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
function startSession(res, userId) {
  const t = U.newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires) VALUES (?,?,?,?)').run(U.sha(t), userId, U.newToken(), now() + 30 * DAY);
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: cfg.SECURE, path: '/', maxAge: 30 * DAY });
}
function deleteAccountRows(user) {
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  // never-confirmed accounts were never online, so their names are free again at once
  if (user.verified) db.prepare('INSERT OR REPLACE INTO released_names (name, released_at) VALUES (?, ?)').run(user.username, now());
}
function deleteAccount(user, rows = deleteAccountRows) {
  rows(user);
  fs.rmSync(siteDir(user.username), { recursive: true, force: true });
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
  res.set('Cache-Control', 'no-store').type('image/svg+xml').send(V.counterSvg(hits));
});

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const GB_LINK = /https?:|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ru|xyz|info|biz|top|click|link)\b/i; // shortcut: a TLD list, not a URL parser
const gbEntryText = (e) => `${e.name} wrote:\n${e.message}${e.approved ? '' : '\n(This entry has a link, so it waits for your approval.)'}`;
const gbMailFooter = `Approve or delete entries, or change how often we email you about them: ${cfg.BASE_URL}/dashboard/guestbook`;
const GB_NOTIFY = ['instant', 'daily', 'off'];
const gbRows = (id) => db.prepare('SELECT * FROM guestbook WHERE user_id = ? AND approved = 1 ORDER BY id DESC LIMIT 50').all(id);
site.get('/_hw/guestbook', (req, res) => res.set('Cache-Control', 'no-store').send(V.guestbook(gbRows(req.owner.id))));
site.post('/_hw/guestbook', express.urlencoded({ extended: false, limit: '8kb' }), bodyDefault, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const message = String(req.body.message || '').trim().slice(0, 500);
  if (req.body.website) return res.redirect('/_hw/guestbook'); // bot filled the hidden field
  if (!name || !message) return res.status(400).send(V.guestbook(gbRows(req.owner.id), 'Name and message are both required.'));
  if (!U.limit(`gb:${req.ip}`, 3, 600000)) return res.status(429).send(V.guestbook(gbRows(req.owner.id), 'Too many entries from you. Try again in ten minutes.'));
  if (lines(req.owner.gb_ips).includes(req.ip)) return res.redirect('/_hw/guestbook'); // blocked: look like success
  const text = `${name} ${message}`.toLowerCase();
  if (lines(req.owner.gb_words).some((w) => text.includes(w.toLowerCase()))) return res.status(400).send(V.guestbook(gbRows(req.owner.id), 'Your entry contains a word the owner has blocked.'));
  const approved = GB_LINK.test(text) ? 0 : 1; // entries with links wait for the owner
  db.prepare('INSERT INTO guestbook (user_id, name, message, ip, approved, created_at) VALUES (?,?,?,?,?,?)').run(req.owner.id, name, message, req.ip, approved, now());
  // capped so a spam wave from many addresses can't flood the owner's inbox
  if (req.owner.gb_notify === 'instant' && U.limit(`gbmail:${req.owner.id}`, 10, 3600000)) {
    sendMail(req.owner.email, `New guestbook entry on ${req.owner.username}.${cfg.BASE_HOST}`, `${gbEntryText({ name, message, approved })}\n\n${gbMailFooter}`);
  }
  res.redirect('/_hw/guestbook');
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
  "form-action 'self'",
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

// session
main.use((req, res, next) => {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE);
  req.ctx = { cfg, user: null, csrf: '', isAdmin: false, nonce: res.locals.nonce };
  if (m && m[1]) {
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(U.sha(m[1]));
    if (s && s.expires > now()) {
      const user = q.userById.get(s.user_id);
      if (user) { req.ctx = { cfg, user, csrf: s.csrf, isAdmin: isAdmin(user), nonce: res.locals.nonce }; req.sessionHash = s.token_hash; }
    }
  }
  next();
});
main.use(express.urlencoded({ extended: false, limit: (cfg.MAX_FILE_MB * 3 + 1) * 1048576 })); // the editor posts whole files, and percent-escaping can triple a byte, so the cap tracks MAX_FILE_MB with room for that
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
main.get('/favicon.ico', asset('favicon.svg', 'image/svg+xml')); // shortcut: SVG at the .ico path; browsers and Google accept SVG favicons
main.get('/favicon.svg', asset('favicon.svg', 'image/svg+xml'));
main.get('/og.svg', asset('og.svg', 'image/svg+xml'));
main.get('/og.png', asset('og.png', 'image/png')); // the share-preview raster; og:image points here because several scrapers ignore SVG
main.get('/img/pup-hero.webp', asset('pup-hero.webp', 'image/webp'));
main.get('/img/pup-coder.webp', asset('pup-coder.webp', 'image/webp'));
main.get('/img/pup-accident.webp', asset('pup-accident.webp', 'image/webp'));
main.get('/img/pup-guestbook.webp', asset('pup-guestbook.webp', 'image/webp'));
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
  recent: db.prepare(`${WITH_FOLLOWERS} WHERE ${listed()} ORDER BY u.updated_at DESC LIMIT 8`).all().map(hasShot),
  newest: db.prepare(`SELECT * FROM users WHERE ${listed()} ORDER BY id DESC LIMIT 10`).all(),
  total: db.prepare(`SELECT COUNT(*) n FROM users WHERE ${LIVE}`).get().n,
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
  if (p.hidden) res.set('X-Robots-Tag', 'noindex');
  res.status(status).send(V.profile(req.ctx, m, {
    p: hasShot(p),
    following: !!(me && db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?').get(me.id, p.id)),
    events: db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(p.id),
    followers: db.prepare(`SELECT u.username FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followed_id = ? AND ${LIVE} ORDER BY f.created_at DESC LIMIT 60`).all(p.id),
    follows: db.prepare(`SELECT u.username FROM follows f JOIN users u ON u.id = f.followed_id WHERE f.follower_id = ? AND ${LIVE} ORDER BY f.created_at DESC LIMIT 60`).all(p.id),
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
  else if (U.limit(`follow:${me.id}`, 60, 3600000)) db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?,?,?)').run(me.id, target.id, now());
  res.redirect(`/site/${target.username}`);
});
main.get('/feed', (req, res) => {
  if (!req.ctx.user) return res.redirect('/login');
  const events = db.prepare(`SELECT e.*, u.username, u.tagline FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) AND u.verified = 1 AND u.banned = 0 AND u.hidden = 0 ORDER BY e.id DESC LIMIT 100`).all(req.ctx.user.id).map(hasShot);
  res.send(V.feed(req.ctx, { events, count: db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id = ?').get(req.ctx.user.id).n }));
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
  startSession(res, user.id);
  res.redirect('/dashboard');
});
main.get('/login', (req, res) => res.send(V.login(req.ctx)));
main.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  // site names can't contain @, so anything with one is an email
  const user = username.includes('@') ? q.userByEmail.get(username) : q.userByName.get(username);
  // count attempts per account, not per spelling, so switching between name and email doesn't double the guesses
  if (!U.limit(`login:${req.ip}`, 20, 900000) || !U.limit(user ? `login:id:${user.id}` : `login:name:${username}`, 10, 900000)) {
    return res.status(429).send(V.login(req.ctx, { err: 'Too many attempts. Wait 15 minutes and try again.' }, { username }));
  }
  if (!user || !(await U.checkPw(String(req.body.password || ''), user.pw_hash)) || q.userById.get(user.id)?.pw_hash !== user.pw_hash) {
    return res.status(401).send(V.login(req.ctx, { err: 'Wrong site name, email or password.' }, { username }));
  }
  if (!user.verified) {
    if (U.limit(`reverify:${user.id}`, 3, 3600000)) {
      await sendMail(user.email, `Confirm your ${cfg.SITE_NAME} site`, `Confirm your email:\n\n${cfg.BASE_URL}/verify?token=${makeToken(user.id, 'verify', 2 * DAY)}`);
    }
    return res.send(V.notice(req.ctx, 'Confirm your email first', '<p>We sent you a fresh confirmation link. Click it to finish setting up.</p>'));
  }
  startSession(res, user.id);
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
  db.prepare('UPDATE users SET pw_hash = ?, verified = 1 WHERE id = ?').run(pwHash, user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
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
  res.status(status).send(V.dashboard(req.ctx, m, { dir, entries, used: usage(user.username), quota: quotaMB(user), bandwidth: bwToday(user), listed: isListed(user), hasIndex: hasIndex(user) }));
}
const hasIndex = (user) => { try { return fs.statSync(path.join(siteDir(user.username), 'index.html')).isFile(); } catch { return false; } };
// ?ok= and ?err= carry the result of a redirect (and of the drag-and-drop uploader); the dashboard is only ever shown to its owner
main.get('/dashboard', auth, (req, res) => showDashboard(req, res, req.query.ok || req.query.err ? { ok: String(req.query.ok || ''), err: String(req.query.err || '') } : null));

// The path a file named `name` gets in folder `dir`, or null if its name or type is not allowed
const uploadRel = (dir, name) => U.safeRel((dir ? dir + '/' : '') + name.replace(/\\/g, '/').replace(/\s+/g, '_'));

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
  let used = size.total;
  let count = size.count;
  const saved = [];
  for (const f of files) {
    const rel = uploadRel(dir, f.name);
    const full = rel && resolveIn(user, rel);
    if (!full) { skipped.push(`${f.name} (name or file type not allowed)`); continue; }
    const exists = fs.existsSync(full);
    const old = exists && fs.statSync(full).isFile() ? fs.statSync(full).size : 0;
    if (!exists && count >= MAX_FILES) { skipped.push(`${f.name} (too many files: ${MAX_FILES} max)`); continue; }
    const bytes = f.data ? f.data.length : f.size;
    if (used - old + bytes > quotaMB(user) * 1048576) { skipped.push(`${f.name} (over your ${quotaMB(user)} MB limit)`); continue; }
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
const upload = multer({ storage: tmpStorage, limits: { fileSize: cfg.MAX_FILE_MB * 1048576, files: 20 } }).array('files', 20);
// The plain form gets the dashboard back; the drag-and-drop uploader asks for JSON so it can send many batches and sum them up
main.post('/dashboard/upload', auth, canEdit, tempBudget(20 * cfg.MAX_FILE_MB * 1048576), (req, res, next) => upload(req, res, (err) => {
  handleUpload(req, res, err).catch(next).finally(() => dropTemp(req.files || []));
}));
async function handleUpload(req, res, err) {
  const json = req.accepts(['html', 'json']) === 'json';
  const fail = (msg, code) => (json ? res.status(code).json({ error: msg }) : showDashboard(req, res, { err: msg }, code));
  if (!csrfOk(req)) return fail('Form expired. Reload the page and try again.', 403);
  // the body can take a long time to arrive; a ban, reset or deletion meanwhile must stop the write
  if (!stillCurrent(req, req.ctx.user)) return json ? res.status(403).json({ error: 'You were signed out. Sign in and try again.' }) : res.redirect('/login');
  if (err) return fail(err.code === 'LIMIT_FILE_SIZE' ? `Files can be at most ${cfg.MAX_FILE_MB} MB each.` : 'Upload failed. Send at most 20 files at a time.', 400);
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
main.post('/dashboard/import', auth, canEdit, tempBudget((cfg.ZIP_MAX_MB + cfg.QUOTA_MB) * 1048576), (req, res, next) => zipUpload(req, res, (err) => importZip(req, res, err).catch(next).finally(() => dropTemp([req.file]))));
async function importZip(req, res, err) {
  if (!csrfOk(req)) return res.status(403).type('text').send('Form expired. Go back, reload and try again.');
  if (err) return showDashboard(req, res, { err: err.code === 'LIMIT_FILE_SIZE' ? `Zip files can be at most ${cfg.ZIP_MAX_MB} MB.` : 'Import failed. Send one .zip file.' }, 400);
  if (!req.file) return showDashboard(req, res, { err: 'Choose a .zip file to import.' }, 400);
  const dir = U.safeRel(req.body.dir || '', { file: false });
  if (dir === null) return showDashboard(req, res, { err: 'That folder name is not allowed.' }, 400);
  if (!U.limit(`import:${req.ctx.user.id}`, 10, 3600000)) return showDashboard(req, res, { err: 'That is a lot of imports. Try again in an hour.' }, 429);
  let zip;
  try {
    zip = await readZip(req.file.path, { tmpDir: UPLOAD_TMP, maxFileBytes: cfg.MAX_FILE_MB * 1048576, maxTotalBytes: cfg.QUOTA_MB * 1048576, allowed: (name) => !!uploadRel(dir, name) });
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
  res.send(V.editor(req.ctx, null, { rel, content: exists ? fs.readFileSync(full, 'utf8') : blank, isNew: !exists, images: await siteImages(req.ctx.user, rel) }));
});
// write one text file through the file-count and quota checks; returns why it was not saved, or null once it is
function saveText(user, full, content) {
  const size = Buffer.byteLength(content);
  const exists = fs.existsSync(full) && fs.statSync(full).isFile();
  const old = exists ? fs.statSync(full).size : 0;
  const used = usage(user.username);
  if (!exists && used.count >= MAX_FILES) return `your site already has ${MAX_FILES} files, the most we keep`;
  if (used.total - old + size > quotaMB(user) * 1048576) return `this would go over your ${quotaMB(user)} MB limit`;
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
main.get('/dashboard/style', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const root = siteDir(user.username);
  const css = readText(path.join(root, 'puppypad.css'));
  const index = readText(path.join(root, 'index.html'));
  const preset = Object.hasOwn(style.PRESETS, req.query.preset) ? style.PRESETS[req.query.preset] : null;
  const m = req.query.ok || req.query.err ? { ok: String(req.query.ok || ''), err: String(req.query.err || '') } : null;
  res.send(V.styleEditor(req.ctx, m, {
    s: style.clean(preset) || style.parse(css) || style.clean(style.PRESETS.sky),
    page: index ?? starters.render(user.starter, user.username, cfg),
    tail: style.tail(css),
    offerLink: css !== null && index !== null && !style.hasLink(index),
  }));
});
main.post('/dashboard/style', auth, canEdit, (req, res) => {
  const user = req.ctx.user;
  const s = style.clean(req.body);
  if (!s) return res.redirect(`/dashboard/style?err=${encodeURIComponent('Pick each setting from the form.')}`);
  const full = path.join(siteDir(user.username), 'puppypad.css');
  const err = saveText(user, full, style.merge(readText(full), s));
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
  const content = starters.render(req.body.starter, user.username, cfg);
  const dirSize = usage(user.username);
  const old = exists ? fs.statSync(full).size : 0;
  if (!exists && dirSize.count >= MAX_FILES) return showDashboard(req, res, { err: `Your site already has ${MAX_FILES} files, the most we keep. Delete one first.` }, 400);
  if (dirSize.total - old + Buffer.byteLength(content) > quotaMB(user) * 1048576) return showDashboard(req, res, { err: `That would go over your ${quotaMB(user)} MB limit. Free up some space first.` }, 400);
  try {
    writeAtomic(full, content);
  } catch {
    return showDashboard(req, res, { err: 'Could not write index.html: a folder with that name is in the way.' }, 400);
  }
  usageCache.set(user.username, { total: dirSize.total - old + Buffer.byteLength(content), count: dirSize.count + (exists ? 0 : 1) });
  // a fresh screenshot, but not an edit: a starter alone doesn't put a site on the public lists
  db.prepare('UPDATE users SET shot_dirty = 1, starter = ? WHERE id = ?').run(req.body.starter, user.id);
  const name = starters.LIST.find((s) => s.id === req.body.starter).name;
  res.redirect(`/dashboard?ok=${encodeURIComponent(`${exists ? 'Replaced' : 'Made'} your front page (index.html) from the ${name} starter.`)}`);
});
main.post('/dashboard/delete', auth, canEdit, (req, res) => {
  const rel = U.safeRel(req.body.path);
  const full = rel && resolveIn(req.ctx.user, rel);
  if (full && fs.existsSync(full) && fs.statSync(full).isFile()) {
    const { size } = fs.statSync(full);
    const used = usage(req.ctx.user.username);
    fs.unlinkSync(full);
    usageCache.set(req.ctx.user.username, { total: used.total - size, count: used.count - 1 });
    const root = siteDir(req.ctx.user.username);
    for (let d = path.dirname(full); d !== root && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d); // tidy empty folders
    markUpdated(req.ctx.user.id);
  }
  res.redirect(`/dashboard?ok=${encodeURIComponent('File deleted.')}`);
});
// rename or move a file or folder; folders keep their contents, and nothing is ever overwritten
const isDirAt = (full) => !!full && fs.existsSync(full) && fs.statSync(full).isDirectory();
const depthBelow = (full) => Math.max(0, ...fs.readdirSync(full, { withFileTypes: true }).map((e) => (e.isDirectory() ? 1 + depthBelow(path.join(full, e.name)) : 1)));
const SCANNED = /\.(html?|js|svg)$/i;
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
  const to = U.safeRel(want, { file: !dir });
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
  res.redirect(`/dashboard?ok=${encodeURIComponent(join ? 'You joined the webring.' : 'You left the webring.')}`);
});
main.post('/dashboard/hidden', auth, canEdit, (req, res) => {
  const hide = req.body.hidden === '1';
  db.prepare('UPDATE users SET hidden = ? WHERE id = ?').run(hide ? 1 : 0, req.ctx.user.id);
  res.redirect(`/dashboard?ok=${encodeURIComponent(hide ? 'Your site is hidden from browsing.' : 'Your site is back in the listings.')}`);
});
main.get('/dashboard/guestbook', auth, (req, res) => res.send(V.guestbookAdmin(req.ctx, null,
  db.prepare('SELECT * FROM guestbook WHERE user_id = ? ORDER BY id DESC LIMIT 500').all(req.ctx.user.id), lines(req.ctx.user.gb_ips))));
main.post('/dashboard/guestbook/approve', auth, (req, res) => {
  db.prepare('UPDATE guestbook SET approved = 1 WHERE id = ? AND user_id = ?').run(Number(req.body.id) || 0, req.ctx.user.id);
  res.redirect('/dashboard/guestbook');
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
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/unblock-ip', auth, (req, res) => {
  setIps(req.ctx.user.id, lines(req.ctx.user.gb_ips).filter((ip) => ip !== req.body.ip));
  res.redirect('/dashboard/guestbook');
});
main.post('/dashboard/guestbook/delete', auth, (req, res) => {
  db.prepare('DELETE FROM guestbook WHERE id = ? AND user_id = ?').run(Number(req.body.id) || 0, req.ctx.user.id);
  res.redirect('/dashboard/guestbook');
});
main.post('/account/password', auth, async (req, res) => {
  const user = req.ctx.user;
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
  // log out everywhere else, in case the old password leaked
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, req.sessionHash);
  res.redirect(`/site/${user.username}?ok=${encodeURIComponent('Password changed. Other devices are logged out.')}`);
});
// a new email takes effect only once its owner clicks the link sent there; the old address hears about it either way
main.post('/account/email', auth, async (req, res) => {
  const user = req.ctx.user;
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
  if (!(await U.checkPw(String(req.body.password || ''), user.pw_hash))) return fail('Wrong password. Nothing was changed.');
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
  if (!(await U.checkPw(String(req.body.password || ''), req.ctx.user.pw_hash))) return showDashboard(req, res, { err: 'Wrong password. Nothing was deleted.' }, 400);
  if (!stillCurrent(req, req.ctx.user)) return res.redirect('/login');
  deleteAccount(req.ctx.user);
  res.clearCookie(COOKIE, { path: '/', secure: cfg.SECURE });
  res.send(V.notice({ ...req.ctx, user: null }, 'Account deleted', '<p>Your site and files are gone. Thanks for stopping by.</p>'));
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
  res.send(V.admin(req.ctx, m, {
    q,
    reports: db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY id DESC LIMIT 200").all(),
    log: db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100').all(),
    users: users.map((u) => ({ ...u, disk: usage(u.username).total, bandwidth: bwToday(u) })),
    signups: db.prepare("SELECT date(created_at / 1000, 'unixepoch') day, COUNT(*) n FROM users WHERE created_at >= unixepoch('now', 'start of day', '-13 days') * 1000 GROUP BY day ORDER BY day DESC").all(),
    stats: {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      banned: db.prepare('SELECT COUNT(*) n FROM users WHERE banned = 1').get().n,
      open: db.prepare("SELECT COUNT(*) n FROM reports WHERE status = 'open'").get().n,
    },
    upgrade: upgrade.readState(DATA_DIR),
  }));
};
// ?ok= and ?err= carry the result of an upgrade request, redirected so a reload never re-sends the form
main.get('/admin', auth, adminOnly, (req, res) => showAdmin(req, res, req.query.ok || req.query.err ? { ok: String(req.query.ok || ''), err: String(req.query.err || '') } : null));
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
main.post('/admin/report-close', auth, adminOnly, (req, res) => {
  const r = db.prepare("SELECT * FROM reports WHERE id = ? AND status = 'open'").get(Number(req.body.id) || 0);
  if (r) {
    db.transaction(() => {
      db.prepare("UPDATE reports SET status = 'closed' WHERE id = ?").run(r.id);
      adminLog(req, 'close report', r.site, `${r.reason}: ${r.details}`.slice(0, 200));
    })();
  }
  res.redirect('/admin');
});
main.post('/admin/ban', auth, adminOnly, (req, res) => {
  const target = q.userByName.get(String(req.body.site || '').trim().toLowerCase());
  if (!target) return showAdmin(req, res, { err: 'No site with that name.' });
  if (isAdmin(target)) return showAdmin(req, res, { err: 'That is an admin account.' });
  const action = req.body.action;
  const reason = String(req.body.reason || '').slice(0, 200);
  if (action === 'delete') {
    // the rows and the log entry commit together; the files go only after both have
    deleteAccount(target, db.transaction((u) => { deleteAccountRows(u); adminLog(req, 'delete', u.username, reason); }));
    return showAdmin(req, res, { ok: `Deleted ${target.username} and all its files.` });
  }
  const ban = action === 'ban' ? 1 : 0;
  // the state change and its log entry commit together, so no take-down or restore goes unrecorded
  db.transaction(() => {
    db.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?').run(ban, ban ? reason : null, target.id);
    adminLog(req, ban ? 'take down' : 'restore', target.username, ban ? reason : '');
    if (ban) { db.prepare("UPDATE reports SET status = 'closed' WHERE site = ?").run(target.username); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); }
    else db.prepare('UPDATE users SET shot_dirty = 1 WHERE id = ?').run(target.id);
  })();
  if (ban) fs.rmSync(shotPath(target.username), { force: true });
  showAdmin(req, res, { ok: ban ? `${target.username} is offline.` : `${target.username} is back online.` });
});

main.use((req, res) => res.status(404).send(V.notice(req.ctx, 'Not found', '<p>No such page. <a href="/">Go home.</a></p>')));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
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
      sendMail(u.email, `${rows.length} new guestbook entr${rows.length === 1 ? 'y' : 'ies'} on ${u.username}.${cfg.BASE_HOST}`,
        `${held ? `${held} of them wait${held === 1 ? 's' : ''} for your approval.\n\n` : ''}${rows.slice(0, 100).map(gbEntryText).join('\n\n')}${rows.length > 100 ? `\n\n...and ${rows.length - 100} more.` : ''}\n\n${gbMailFooter}`)
        // only a digest that went out moves the cutoff, so a failed one is retried at the next hourly run
        .then((sent) => { if (sent) db.prepare('UPDATE users SET gb_digest_at = ? WHERE id = ?').run(cutoff, u.id); });
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

module.exports = app; // tests import the app without starting a server
app.housekeeping = housekeeping;
app.forgetUsage = (name) => usageCache.delete(name); // for tests that put files on disk behind the app's back
app.refreshUsage = refreshUsage;

if (require.main === module) {
  const port = Number(env.PORT || 3000);
  app.listen(port, () => console.log(`${cfg.SITE_NAME} listening on :${port} for ${cfg.BASE_URL}`));
  refreshAll(); // so the first /admin view after a restart reads stored totals
}
