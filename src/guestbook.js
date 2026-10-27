// Guestbook: a Site's visitor book (GLOSSARY.md). Signing, the spam rules, the owner's tools and both emails live
// here; callers hand in the Site's row and plain values, never req or res.
const { db } = require('./db');
const U = require('./util');

const DAY = 86400000;
const PER_PAGE = 50;
const KEEP = 90 * DAY; // entry addresses are erased and blocks expire after this; the privacy page promises it
const MAX_BLOCKS = 200; // per Site
const LINK = /https?:|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ru|xyz|info|biz|top|click|link)\b/i; // shortcut: a TLD list, not a URL parser
const NOTIFY = ['instant', 'daily', 'off'];
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

// live: the SQL that picks Sites still online, for the digest
function createGuestbook({ cfg, logins, sendMail, live }) {
  const entryText = (e) => `${e.name} wrote:\n${e.message}${e.approved ? '' : '\n(This entry has a link, so it waits for your approval.)'}`;
  const footer = `Approve or delete entries, or change how often we email you about them: ${cfg.BASE_URL}/dashboard/guestbook`;

  // 'ok' also for a bot and a blocked address, so neither learns it was turned away; 'held' waits for approval
  function sign(site, { name, message, ip, bot }) {
    if (bot) return 'ok';
    name = String(name || '').trim().slice(0, 40);
    message = String(message || '').trim().slice(0, 500);
    if (!name || !message) return 'missing';
    if (!U.limit(`gb:${ip}`, 3, 600000)) return 'limited';
    if (db.prepare('SELECT 1 FROM guestbook_blocks WHERE user_id = ? AND ip = ?').get(site.id, ip)) return 'ok';
    const text = `${name} ${message}`.toLowerCase();
    if (lines(site.gb_words).some((w) => text.includes(w.toLowerCase()))) return 'word';
    const approved = LINK.test(text) ? 0 : 1;
    db.prepare('INSERT INTO guestbook (user_id, name, message, ip, approved, created_at) VALUES (?,?,?,?,?,?)').run(site.id, name, message, ip, approved, Date.now());
    // capped so a spam wave from many addresses can't flood the owner's inbox
    if (site.gb_notify === 'instant' && U.limit(`gbmail:${site.id}`, 10, 3600000)) {
      sendMail(logins.loginOf(site).email, `New guestbook entry on ${site.username}.${cfg.BASE_HOST}`, `${entryText({ name, message, approved })}\n\n${footer}`);
    }
    return approved ? 'ok' : 'held';
  }

  // page n, newest first, kept within the pages there are: the approved entries visitors see, or all for the owner
  function page(site, n, { all = false } = {}) {
    const from = `FROM guestbook WHERE user_id = ?${all ? '' : ' AND approved = 1'}`;
    const pages = Math.max(1, Math.ceil(db.prepare(`SELECT COUNT(*) n ${from}`).get(site.id).n / PER_PAGE));
    const at = Math.min(pages, Math.max(1, parseInt(n, 10) || 1));
    return { rows: db.prepare(`SELECT * ${from} ORDER BY id DESC LIMIT ${PER_PAGE} OFFSET ${(at - 1) * PER_PAGE}`).all(site.id), page: at, pages };
  }

  const approve = (site, id) => db.prepare('UPDATE guestbook SET approved = 1 WHERE id = ? AND user_id = ?').run(Number(id) || 0, site.id);
  const remove = (site, id) => db.prepare('DELETE FROM guestbook WHERE id = ? AND user_id = ?').run(Number(id) || 0, site.id);
  // oldest first
  const blocked = (site) => db.prepare('SELECT ip FROM guestbook_blocks WHERE user_id = ? ORDER BY created_at, rowid').all(site.id).map((r) => r.ip);
  // the address behind one of the Site's entries; the newest 200 blocks stay
  function blockIp(site, entryId) {
    const e = db.prepare('SELECT ip FROM guestbook WHERE id = ? AND user_id = ?').get(Number(entryId) || 0, site.id);
    if (!e?.ip) return;
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO guestbook_blocks (user_id, ip, created_at) VALUES (?, ?, ?)').run(site.id, e.ip, Date.now());
      db.prepare(`DELETE FROM guestbook_blocks WHERE user_id = ? AND rowid NOT IN
        (SELECT rowid FROM guestbook_blocks WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_BLOCKS})`).run(site.id, site.id);
    })();
  }
  const unblockIp = (site, ip) => db.prepare('DELETE FROM guestbook_blocks WHERE user_id = ? AND ip = ?').run(site.id, String(ip || ''));

  // either field alone; a notify outside the list is ignored
  function settings(site, { words, notify } = {}) {
    if (words !== undefined) db.prepare('UPDATE users SET gb_words = ? WHERE id = ?').run(lines(words).slice(0, 100).map((l) => l.slice(0, 60)).join('\n'), site.id);
    if (NOTIFY.includes(notify)) {
      // the digest restarts from now, so switching from instant never repeats entries already mailed;
      // saving the same setting again keeps entries already waiting for the digest.
      // One ms back, so an entry signed in the same millisecond as the switch still makes the digest (it counts entries after gb_digest_at)
      db.prepare('UPDATE users SET gb_digest_at = CASE WHEN gb_notify = @v THEN gb_digest_at ELSE @t END, gb_notify = @v WHERE id = @id').run({ v: notify, t: Date.now() - 1, id: site.id });
    }
  }

  // at most one a day per Site, only when someone signed since the last; resolves once every send has settled
  function sendDigests() {
    const sends = [];
    for (const u of db.prepare(`SELECT * FROM users WHERE gb_notify = 'daily' AND gb_digest_at < ? AND ${live}`).all(Date.now() - DAY)) {
      const cutoff = Date.now();
      const rows = db.prepare('SELECT * FROM guestbook WHERE user_id = ? AND created_at > ? AND created_at <= ? ORDER BY id').all(u.id, u.gb_digest_at, cutoff);
      if (!rows.length) continue;
      const held = rows.filter((e) => !e.approved).length;
      sends.push(sendMail(logins.loginOf(u).email, `${rows.length} new guestbook entr${rows.length === 1 ? 'y' : 'ies'} on ${u.username}.${cfg.BASE_HOST}`,
        `${held ? `${held} of them wait${held === 1 ? 's' : ''} for your approval.\n\n` : ''}${rows.slice(0, 100).map(entryText).join('\n\n')}${rows.length > 100 ? `\n\n...and ${rows.length - 100} more.` : ''}\n\n${footer}`)
        // only a digest that went out moves the cutoff, so a failed one is retried at the next run
        .then((sent) => { if (sent) db.prepare('UPDATE users SET gb_digest_at = ? WHERE id = ?').run(cutoff, u.id); }));
    }
    return Promise.all(sends);
  }

  function sweep() {
    db.prepare('UPDATE guestbook SET ip = NULL WHERE ip IS NOT NULL AND created_at < ?').run(Date.now() - KEEP);
    db.prepare('DELETE FROM guestbook_blocks WHERE created_at < ?').run(Date.now() - KEEP);
  }

  return { sign, page, approve, remove, blocked, blockIp, unblockIp, settings, sendDigests, sweep };
}

module.exports = { createGuestbook };
