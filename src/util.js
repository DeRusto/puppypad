const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
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

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

module.exports = { esc, sha, newToken, hashPw, checkPw, validUsername, TEXT_EXT, ALLOWED_EXT, extOf, safeRel, dirSize, limit, fmtBytes, phishSignals };
