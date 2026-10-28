// Site files: a site's folder and everything that has to happen when it changes. Every write, delete, move, rename
// and removal goes through here, so the path and type checks, quota, file count, usage totals, phishing check,
// file history and feed event can't be skipped by a route. Reads use siteDir and resolveIn directly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, SITES_DIR, SHOTS_DIR } = require('./db');
const U = require('./util');
const H = require('./history');

const { DAY, lines } = U;
const MAX_FILES = 2000; // the byte quota alone lets a member mint unlimited empty files; this is far above any real site
// the types a browser runs as a page or script; supporters may upload the rarer ones (xhtml, shtml, mjs) too
const SCANNED = /\.(x?html?|shtml|m?js|svg|xml)$/i;
const siteDir = (name) => path.join(SITES_DIR, name);
const shotPath = (name) => path.join(SHOTS_DIR, `${name}.jpg`);
// resolve a member path inside their folder, or null
function resolveIn(site, rel) {
  const root = siteDir(site.username);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}
// The file urlPath (decoded, starting with /) serves from root, the way the site router serves it: { file },
// { redirect } for a folder asked for without its trailing slash, or null. A folder serves its index.html, and a path
// without an extension or trailing slash falls back to .html. Dot segments, .. and NUL never resolve.
// Async, so a slow disk never holds up other visitors' requests.
async function resolve(root, urlPath) {
  // a backslash is a folder on Windows, so it would slip past the segment check; safeRel never makes such a name
  if (/[\0\\]/.test(urlPath) || urlPath.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
  const full = path.join(root, urlPath);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  const slash = urlPath.endsWith('/');
  const st = await statOf(full);
  if (st && st.isDirectory()) {
    if (!slash) return { redirect: `${urlPath}/` };
    return (await statOf(path.join(full, 'index.html')))?.isFile() ? { file: path.join(full, 'index.html') } : null;
  }
  if (st) return !slash && st.isFile() ? { file: full } : null;
  // clean URLs: /about serves about.html when nothing called "about" exists
  if (slash || path.extname(full)) return null;
  return (await statOf(`${full}.html`))?.isFile() ? { file: `${full}.html` } : null;
}
const statOf = (full) => fs.promises.stat(full).catch(() => null);
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
const LINK_ATTR = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
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
const isFileAt = (full) => fs.existsSync(full) && fs.statSync(full).isFile();
const isDirAt = (full) => !!full && fs.existsSync(full) && fs.statSync(full).isDirectory();
const depthBelow = (full) => Math.max(0, ...fs.readdirSync(full, { withFileTypes: true }).map((e) => (e.isDirectory() ? 1 + depthBelow(path.join(full, e.name)) : 1)));
const tidyUp = (site, from) => {
  const root = siteDir(site.username);
  for (let d = path.dirname(from); d !== root && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
};

// limitsFor(site) gives { quotaMB, fileMB, anyType, historyDays }, which depend on the site's login; sendMail sends the auto-flag alert
function createSiteFiles({ cfg, limitsFor, sendMail }) {
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

  // file history (src/history.js): old versions stay for the site's history days and take at most the site's quota again
  const historyKeep = (site) => { const lim = limitsFor(site); return { since: Date.now() - lim.historyDays * DAY, maxBytes: lim.quotaMB * 1048576 }; };
  // history is a convenience: a failure is logged, never shown to the member or allowed to fail their save
  const recordHistory = (site, message) => H.record(site.id, siteDir(site.username), message, historyKeep(site)).catch((e) => console.error(`file history for ${site.username} failed:`, e.message));
  // a starting point for sites that have none yet (new, or here before history was), and the daily trim for the rest
  async function historySweep() {
    for (const u of db.prepare('SELECT * FROM users').all()) {
      if (!H.exists(u.id)) await recordHistory(u, 'history begins');
      else await H.trim(u.id, siteDir(u.username), historyKeep(u)).catch((e) => console.error(`file history trim for ${u.username} failed:`, e.message));
    }
  }

  // queue a saved page or script for review if it looks like phishing or mining; one open flag per site at a time
  function autoFlag(site, rel, content) {
    if (!SCANNED.test(rel)) return;
    const signals = U.phishSignals(String(content));
    if (!signals.length || db.prepare("SELECT 1 FROM reports WHERE site = ? AND reason = 'Auto-flag' AND status = 'open'").get(site.username)) return;
    const details = `${rel}: ${signals.join(', ')}`;
    db.prepare("INSERT INTO reports (site, reason, details, created_at) VALUES (?, 'Auto-flag', ?, ?)").run(site.username, details, Date.now());
    sendMail(cfg.ABUSE_EMAIL, `[${cfg.SITE_NAME}] auto-flag: ${site.username}`, `${details}\n\nReview: ${cfg.BASE_URL}/admin`);
  }

  // after a change: record history, queue a fresh screenshot, and unless feed is off log at most one feed event per hour,
  // naming the files it changed (later changes in the same hour join that event)
  // shortcut: keeps the newest 50 names per event, so "and N more" undercounts a bigger batch; store a count if that matters
  const eventFiles = (old, rels) => [...new Set([...rels, ...lines(old)])].slice(0, 50).join('\n');
  function updated(site, rels, feed = true) {
    const t = Date.now();
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(site.id);
    if (u) recordHistory(u, rels.join(' ') || 'change');
    // a starter alone is a fresh screenshot, not an edit: it doesn't put a site on the public lists
    if (!feed) return db.prepare('UPDATE users SET shot_dirty = 1 WHERE id = ?').run(site.id);
    db.prepare('UPDATE users SET updated_at = ?, shot_dirty = 1 WHERE id = ?').run(t, site.id);
    const last = db.prepare("SELECT id, created_at, files FROM events WHERE user_id = ? AND kind = 'update' ORDER BY id DESC LIMIT 1").get(site.id);
    if (last && t - last.created_at < 3600000) {
      if (rels.length) db.prepare('UPDATE events SET files = ? WHERE id = ?').run(eventFiles(last.files, rels), last.id);
      return;
    }
    db.prepare("INSERT INTO events (user_id, kind, files, created_at) VALUES (?, 'update', ?, ?)").run(site.id, eventFiles('', rels), t);
    db.prepare('UPDATE users SET updates = updates + 1 WHERE id = ?').run(site.id);
  }

  // The path a file named `name` gets in folder `dir`, or null if its name or type is not allowed for this site
  const relFor = (site, dir, name) => U.safeRel((dir ? dir + '/' : '') + name.replace(/\\/g, '/').replace(/\s+/g, '_'), { anyType: limitsFor(site).anyType });

  // write one file through the type, file-count and quota checks; returns why it was not saved, or null once it is
  function write(site, rel, content, { feed = true } = {}) {
    const lim = limitsFor(site);
    const safe = U.safeRel(rel, { anyType: lim.anyType });
    const full = safe && resolveIn(site, safe);
    if (!full) return 'that file name or type is not allowed';
    const size = Buffer.byteLength(content);
    const exists = isFileAt(full);
    const old = exists ? fs.statSync(full).size : 0;
    const used = usage(site.username);
    if (!exists && used.count >= MAX_FILES) return `your site already has ${MAX_FILES} files, the most we keep`;
    if (size > lim.fileMB * 1048576) return `files can be at most ${lim.fileMB} MB`;
    if (used.total - old + size > lim.quotaMB * 1048576) return `this would go over your ${lim.quotaMB} MB limit`;
    try {
      writeAtomic(full, content);
    } catch {
      return 'a file or folder with that name is in the way';
    }
    usageCache.set(site.username, { total: used.total - old + size, count: used.count + (exists ? 0 : 1) });
    autoFlag(site, safe, content);
    updated(site, [safe], feed);
    return null;
  }

  // Write uploaded or unzipped files into folder `dir` through the same checks.
  // Each file is { name, data } in memory or { name, path, size } in a temp file; the caller removes temp files that were not moved in.
  function writeMany(site, dir, files) {
    const size = usage(site.username);
    const lim = limitsFor(site);
    let used = size.total;
    let count = size.count;
    const saved = [];
    const skipped = [];
    for (const f of files) {
      const rel = relFor(site, dir, f.name);
      const full = rel && resolveIn(site, rel);
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
      usageCache.set(site.username, { total: used, count });
      // only pages and scripts are scanned, so only they are read back
      if (SCANNED.test(rel)) autoFlag(site, rel, f.data ? f.data.toString('utf8') : fs.readFileSync(full, 'utf8'));
      saved.push(rel);
    }
    if (saved.length) updated(site, saved);
    return { saved, skipped };
  }

  // delete files and the folders that leaves empty; paths that are not allowed or not there come back as missing
  function deleteFiles(site, rels) {
    const deleted = [];
    const missing = [];
    for (const p of new Set(rels)) {
      const rel = U.safeRel(p, { anyType: true });
      const full = rel && resolveIn(site, rel);
      if (!full || !isFileAt(full)) { missing.push(rel || String(p ?? '')); continue; }
      const { size } = fs.statSync(full);
      const used = usage(site.username);
      fs.unlinkSync(full);
      usageCache.set(site.username, { total: used.total - size, count: used.count - 1 });
      tidyUp(site, full);
      deleted.push(rel);
    }
    if (deleted.length) updated(site, []);
    return { deleted, missing };
  }

  // rename or move a file or folder; folders keep their contents, and nothing is ever overwritten. Returns why not, or null
  function move(site, from, want) {
    const fromRel = U.safeRel(from, { file: false });
    const src = fromRel && resolveIn(site, fromRel);
    if (!src || !fs.existsSync(src)) return 'That file or folder is not there any more.';
    const dir = isDirAt(src);
    const to = U.safeRel(want, { file: !dir, anyType: limitsFor(site).anyType });
    const dst = to && resolveIn(site, to);
    if (!dst) return dir
      ? 'Use a folder path like pics or old/pics, made of letters, numbers, dots, hyphens and underscores.'
      : 'Use a path like about.html or pics/cat.png, made of letters, numbers, dots, hyphens and underscores, ending in an allowed file type.';
    if (to === fromRel) return 'That is where it already is.';
    if (dir && (to + '/').startsWith(fromRel + '/')) return 'A folder cannot go inside itself.';
    if (fs.existsSync(dst)) return `Something called ${to} is already there. Pick another name.`;
    if (dir && to.split('/').length + depthBelow(src) > 6) return 'That would nest files more than 6 folders deep.';
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } catch {
      return 'Not moved: a file is in the way of that path.';
    }
    usageCache.set(site.username, { ...usage(site.username) }); // same totals, new entry: a refresh walking mid-move may have counted it twice or not at all
    tidyUp(site, src);
    // a .txt renamed to .html becomes a page, so it gets the same phishing check a saved page does
    if (!dir && SCANNED.test(to) && !SCANNED.test(fromRel)) autoFlag(site, to, fs.readFileSync(dst, 'utf8'));
    updated(site, dir ? [] : [to]); // a folder is no page to link to
    return null;
  }

  // a new site's folder and front page, with its history started; throws, and the caller rolls back its row
  async function create(site, html) {
    fs.mkdirSync(siteDir(site.username), { recursive: true });
    fs.writeFileSync(path.join(siteDir(site.username), 'index.html'), html);
    await H.remove(site.id); // ids are reused after the newest account goes; never hand over someone else's versions
    recordHistory(site, 'history begins');
  }

  // a site's new name: call last inside the rename's transaction, so a failed folder move rolls the rows back
  function rename(oldName, newName) {
    fs.mkdirSync(siteDir(oldName), { recursive: true });
    fs.renameSync(siteDir(oldName), siteDir(newName));
    try { fs.renameSync(shotPath(oldName), shotPath(newName)); } catch { /* none yet; shot_dirty brings one */ }
    if (usageCache.has(oldName)) { usageCache.set(newName, usageCache.get(oldName)); usageCache.delete(oldName); }
  }

  // everything kept for a deleted site; history goes after any commit still running, and the caller doesn't wait for it
  function removeSite(site) {
    fs.rmSync(siteDir(site.username), { recursive: true, force: true });
    fs.rmSync(shotPath(site.username), { force: true });
    usageCache.delete(site.username);
    H.remove(site.id).catch((e) => console.error(`file history remove for ${site.username} failed:`, e.message));
  }

  const list = (site) => listFiles(siteDir(site.username));
  // href and src values in a site's pages that point at its own files that don't exist, through resolve like the router
  async function brokenLinks(site) {
    const root = siteDir(site.username);
    const served = async (url) => { const r = await resolve(root, url); return !!r && (!!r.file || !!(await resolve(root, r.redirect))); };
    const broken = [];
    for (const file of (await list(site)).filter((f) => /\.html?$/i.test(f))) {
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
        try {
          const u = new URL(link, base);
          if (u.host !== 'x') continue; // the base points at another site
          p = decodeURIComponent(u.pathname);
        } catch { /* malformed: reported below */ }
        if (p !== null && (p === '/_hw' || p.startsWith('/_hw/') || (await served(p)))) continue;
        broken.push({ file, link });
      }
    }
    return broken;
  }

  const forgetUsage = (name) => usageCache.delete(name); // for tests that put files on disk behind the module's back
  return { write, writeMany, deleteFiles, move, create, rename, removeSite, usage, refreshUsage, historySweep, relFor, list, brokenLinks, forgetUsage };
}

module.exports = { createSiteFiles, siteDir, shotPath, resolveIn, resolve, MAX_FILES, SCANNED };
