const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

sharp.concurrency(1); // one core per image, so a batch of uploads can't starve every other site

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// async, so a login's ~50 ms of hashing doesn't stall every other site on the one event loop
const scrypt = require('util').promisify(crypto.scrypt);
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(pw, salt, 64)).toString('hex')}`;
}
async function checkPw(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// 3-30 chars, valid DNS label
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set(('www admin administrator root api app mail email smtp imap pop ftp ns ns1 ns2 dns static assets cdn img images ' +
  'help support abuse security report postmaster hostmaster webmaster login signup register account dashboard browse random webring ' +
  'rules terms privacy status blog news about contact internal test dev staging official staff mod moderator ' +
  // hostnames mail providers put DNS records on (bounce and feedback addresses)
  'send bounce bounces pm-bounces em mta mx').split(' '));
const validUsername = (u) => USERNAME_RE.test(u) && !u.includes('--') && !RESERVED.has(u);

const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'txt', 'md', 'json', 'xml', 'svg']);
const ALLOWED_EXT = new Set([...TEXT_EXT, 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'mid', 'midi', 'mp3', 'ogg', 'wav', 'woff', 'woff2', 'ttf', 'pdf']);
const extOf = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');

// Normalise a member-supplied relative path. Returns null if it is not safe.
function safeRel(p, { file = true } = {}) {
  const parts = String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length > 6 || (file && !parts.length)) return null;
  for (const seg of parts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seg) || seg.includes('..')) return null;
  }
  if (parts[0] && parts[0].toLowerCase() === '_hw') return null; // reserved for widgets
  if (file && !ALLOWED_EXT.has(extOf(parts[parts.length - 1]))) return null;
  return parts.join('/');
}

// the same totals without holding up the server: each read and stat runs off the main thread
async function dirSizeAsync(dir) {
  let total = 0;
  let count = 0;
  const walk = async (d) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) { total += (await fs.promises.stat(full)).size; count++; }
    }
  };
  if (fs.existsSync(dir)) await walk(dir);
  return { total, count };
}
function dirSize(dir) {
  let total = 0;
  let count = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { total += fs.statSync(full).size; count++; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { total, count };
}

// every file under dir as a slash-separated path relative to it, read off the main thread
async function listFiles(dir) {
  const out = [];
  const walk = async (d, pre) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile()) out.push(pre + e.name);
    }
  };
  if (fs.existsSync(dir)) await walk(dir, '');
  return out;
}

// href and src values in a site's pages that point at its own files that don't exist, resolved the way the site router serves them
const LINK_ATTR = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
async function brokenLinks(root) {
  const files = await listFiles(root);
  const have = new Set(files);
  const dirs = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  // like the router: a folder serves its index.html, and only a path without a trailing slash or extension falls back to .html
  const served = (p, slash) => (!slash && have.has(p)) || ((p === '' || dirs.has(p)) && have.has(p ? `${p}/index.html` : 'index.html')) || (!slash && !path.posix.extname(p) && have.has(`${p}.html`));
  const broken = [];
  for (const file of files.filter((f) => /\.html?$/i.test(f))) {
    let html = await fs.promises.readFile(path.join(root, file), 'utf8');
    // a <base href> moves where the page's relative links point, as in the browser; it is no link itself
    const baseTag = html.match(/<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
    let base = new URL(`http://x/${file}`);
    try { if (baseTag) base = new URL((baseTag[1] ?? baseTag[2] ?? baseTag[3]).trim(), base); } catch { /* invalid: the browser ignores it too */ }
    html = html.replace(/<base\b[^>]*>/gi, '');
    for (const m of html.matchAll(LINK_ATTR)) {
      const link = (m[1] ?? m[2] ?? m[3]).trim();
      // other sites, mail and script links, in-page anchors and the /_hw/ widgets are not files to check
      if (!link || link.startsWith('#') || link.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.includes('{')) continue;
      let p = null;
      let slash = false;
      try {
        const u = new URL(link, base);
        if (u.host !== 'x') continue; // the base points at another site
        slash = u.pathname.length > 1 && u.pathname.endsWith('/');
        p = decodeURIComponent(u.pathname).slice(1).replace(/\/$/, '');
      } catch { /* malformed: reported below */ }
      if (p !== null && (p === '_hw' || p.startsWith('_hw/') || served(p, slash))) continue;
      broken.push({ file, link });
    }
  }
  return broken;
}

// Shrink a JPEG, PNG or WebP on disk to at most SHRINK_PX on its longest side, in place, keeping its type.
// Turns photos upright and drops their metadata (camera, GPS). Keeps the original when the result isn't smaller
// or the file isn't a readable image. GIFs are left alone so animations survive. Resolves to the new size.
const SHRINK_PX = 1600;
const SHRINK_TYPES = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };
async function shrinkImage(file, name) {
  const type = SHRINK_TYPES[extOf(name)];
  const before = fs.statSync(file).size;
  if (!type) return before;
  const out = `${file}.shrunk`;
  try {
    const info = await sharp(file).rotate().resize({ width: SHRINK_PX, height: SHRINK_PX, fit: 'inside', withoutEnlargement: true })
      .toFormat(type, type === 'png' ? { compressionLevel: 9, palette: true } : { quality: 82 }).toFile(out);
    if (info.size < before) { fs.renameSync(out, file); return info.size; }
  } catch { /* not an image sharp can read: upload it as it is */ }
  fs.rmSync(out, { force: true });
  return before;
}

// tiny in-memory rate limiter: true = allowed
const buckets = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { buckets.set(key, hits); return false; }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 86400000) buckets.delete(k);
}, 600000).unref();

// Signs that a member page or script is phishing or mining. A match only puts the site in the admin queue; it stays online.
const BRANDS = /\b(paypal|apple ?id|icloud|microsoft|office ?365|outlook|hotmail|google|gmail|facebook|instagram|whatsapp|netflix|amazon|ebay|coinbase|binance|metamask|steam|roblox|discord|wells ?fargo|chase|bank of america|citibank|hsbc|barclays|dhl|fedex|usps)\b/i;
const MINERS = /\b(coin-?hive|crypto-?loot|cryptonight|coinimp|webminepool|jsecoin|minero\.cc|deepminer|monerominer|webmine\.(cz|pro))\b/i;
function phishSignals(html) {
  const s = String(html);
  const found = [];
  // the second pattern catches forms built by script, e.g. el.type = 'password' or setAttribute('type', "password")
  if (/<input\b[^>]*\btype\s*=\s*["']?password/i.test(s) || /\btype\b["']?\s*[=:,]\s*["'`]password["'`]/i.test(s)) found.push('password field');
  if (/<input\b[^>]*\b(autocomplete\s*=\s*["']?cc-|name\s*=\s*["']?[^"'\s>]*(card.?num|cvv|cvc))/i.test(s)) found.push('card field');
  const title = (s.match(/<title\b[^>]*>([^<]*)/i) || s.match(/document\.title\s*=\s*["'`]([^"'`]*)/) || [])[1] || '';
  const brand = title.match(BRANDS);
  if (brand) found.push(`"${brand[0]}" in title`);
  if (MINERS.test(s)) found.push('crypto-miner script');
  return found;
}

// two-factor login (RFC 6238 TOTP): 6 digits from a base32 secret and the 30-second step, as authenticator apps do it
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const newTotpSecret = () => Array.from(crypto.randomBytes(32), (b) => B32[b & 31]).join(''); // 160 bits
const b32bytes = (s) => Buffer.from([...s].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('').match(/.{8}/g).map((b) => parseInt(b, 2)));
function totp(secret, step) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32bytes(secret)).update(c).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
// the step a code matches, allowing a step of clock drift either way; 0 when it matches none
function totpStep(secret, code, t = Date.now()) {
  const now = Math.floor(t / 30000);
  return [now - 1, now, now + 1].find((s) => totp(secret, s) === code) || 0;
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

module.exports = { esc, sha, newToken, hashPw, checkPw, validUsername, TEXT_EXT, ALLOWED_EXT, extOf, safeRel, dirSize, dirSizeAsync, listFiles, brokenLinks, SHRINK_PX, shrinkImage, limit, fmtBytes, phishSignals, B32, newTotpSecret, totp, totpStep };
