// Custom domains (GLOSSARY.md): a supporter's Site served at a hostname they own, while its subdomain 301s there.
// Claims live in custom_domains (src/db.js). A claim goes pending -> verified -> live <-> failing, or ended.
// Every check goes through `net`, so tests stub DNS and HTTPS: txt(name) the TXT strings, addrs(name) the A and AAAA
// addresses (CNAMEs followed), https(host) true once an HTTPS request to the host through Caddy gets an answer.
const crypto = require('crypto');
const net = require('net');
const url = require('url');
const { db } = require('./db');

const DAY = 86400000;
const HOUR = 3600000;
const PENDING_DAYS = 7; // a claim not live this long after it was added ends as expired
const FAILING_DAYS = 30; // a failing claim nobody fixes ends as abandoned
const GRACE_DAYS = 30; // a lapsed supporter's claims keep working this long
const MISSES = 3; // daily checks in a row that fail before a live claim is failing
const HTTPS_ERROR = "the certificate couldn't be issued; check for a CAA record that leaves out Let's Encrypt";
const RECHECKED = ['live', 'failing']; // the states the daily re-check covers
const inList = (states) => `(${states.map((s) => `'${s}'`).join(', ')})`; // for SQL; the states are ours, never input
const day = (t) => new Date(t).toISOString().slice(0, 10);

// { host } as stored, matched and shown (the A-label), or { err } saying why it's refused
function normalise(input, baseHost) {
  let h = String(input ?? '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  const bad = { err: 'Type just the domain name, like example.com or www.example.com.' };
  if (!h || /[^\p{L}\p{N}.-]/u.test(h) || net.isIP(h)) return bad; // a scheme, port, path, *, space or IPv6 literal
  const a = url.domainToASCII(h); // also turns IPv4 spellings like 0x7f.1 into 127.0.0.1
  const labels = a.split('.');
  if (!a || net.isIP(a) || labels.length < 2 || a.length > 253 || labels.some((l) => !l || l.length > 63)) return bad;
  if (a === baseHost || a.endsWith(`.${baseHost}`)) return { err: `Addresses on ${baseHost} are ours already; pick a domain you own.` };
  return { host: a };
}

// cfg for the flag, base host and mail wording; logins (src/logins.js) for who supports; sendMail(to, subject, text)
function createDomains({ cfg, logins, sendMail, net: dns }) {
  const on = () => cfg.CUSTOM_DOMAINS;
  const byId = db.prepare('SELECT * FROM custom_domains WHERE id = ?');
  const of = (site) => db.prepare('SELECT * FROM custom_domains WHERE site_id = ?').get(site.id);
  const siteOf = (c) => db.prepare('SELECT * FROM users WHERE id = ?').get(c.site_id);
  const update = (c, fields) => db.prepare(`UPDATE custom_domains SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: c.id });
  const sub = (site) => `${site.username}.${cfg.BASE_HOST}`;
  const mailTo = (c, subject, text) => {
    const site = siteOf(c);
    return sendMail(logins.loginOf(site).email, `${subject}`, `${text}\n\nYour domain settings: ${cfg.BASE_URL}/dashboard`);
  };
  const end = (c, reason, fields = {}) => update(c, { state: 'ended', end_reason: reason, ended_at: Date.now(), misses: 0, ...fields });

  // BASE_HOST's addresses as last looked up: what every address of a claim must be one of, and what the dashboard shows
  let ours = [];
  const refreshOurs = async () => { ours = await dns.addrs(cfg.BASE_HOST); return ours; };

  // when a login that stopped supporting loses its claims; 0 while it supports
  const graceEnd = (site) => {
    if (logins.isSupporter(site)) return 0;
    const c = of(site);
    return logins.supporterUntil(logins.loginOf(site)) + GRACE_DAYS * DAY + (c ? c.grace_shift : 0);
  };

  // Add a claim: { claim } or { err }. A new token each time, so adding a host again needs a new TXT record
  function add(site, input) {
    if (!on() || !logins.isSupporter(site)) return { err: 'Custom domains are for supporters.' };
    if (site.banned) return { err: 'A moderator took this site down, so it cannot add a domain.' };
    const had = of(site);
    if (had && had.state !== 'ended') return { err: `This site already has ${had.host}. Remove it first.` };
    const { host, err } = normalise(input, cfg.BASE_HOST);
    if (err) return { err };
    if (db.prepare("SELECT 1 FROM custom_domains WHERE host = ? AND state IN ('verified', 'live')").get(host)) return { err: `Another site already uses ${host}.` };
    const id = db.transaction(() => {
      db.prepare('DELETE FROM custom_domains WHERE site_id = ?').run(site.id); // an ended claim reserves nothing
      return db.prepare('INSERT INTO custom_domains (site_id, host, token, created_at) VALUES (?, ?, ?, ?)').run(site.id, host, crypto.randomBytes(16).toString('hex'), Date.now()).lastInsertRowid;
    })();
    return { claim: byId.get(id) };
  }
  const remove = (site) => db.prepare('DELETE FROM custom_domains WHERE site_id = ?').run(site.id).changes > 0;

  // the two DNS proofs: the TXT with the claim's token, and every address one of ours (at least one)
  async function proof(c) {
    const txt = (await dns.txt(`_puppypad.${c.host}`)).includes(`puppypad-verify=${c.token}`);
    const addrs = await dns.addrs(c.host);
    const mine = ours.length ? ours : await refreshOurs();
    const elsewhere = addrs.filter((a) => !mine.includes(a));
    const points = addrs.length > 0 && !elsewhere.length;
    const error = !txt ? 'TXT record not found' : !addrs.length ? `${c.host} has no A or AAAA record` : !points ? `${c.host} points at ${elsewhere.join(', ')}` : '';
    return { txt, points, error };
  }

  // the HTTPS request that makes Caddy issue (or renew) the certificate; a verified claim goes live once it works
  async function goLive(c) {
    const ok = await dns.https(c.host);
    const now = byId.get(c.id);
    if (!now || now.state !== 'verified') return; // removed or ended meanwhile
    update(c, ok ? { state: 'live', live_at: Date.now(), misses: 0, last_error: '', checked_at: Date.now() } : { last_error: HTTPS_ERROR, checked_at: Date.now() });
  }

  // a pending claim: both proofs pass -> verified, taking over a failing holder; the first to verify wins
  async function verify(c) {
    const p = await proof(c);
    if (!byId.get(c.id) || byId.get(c.id).state !== 'pending') return;
    update(c, { txt_ok: +p.txt, addrs_ok: +p.points, last_error: p.error, checked_at: Date.now() });
    if (p.error) return;
    const moved = db.transaction(() => {
      const holder = db.prepare("SELECT * FROM custom_domains WHERE host = ? AND state IN ('verified', 'live', 'failing')").get(c.host);
      if (holder && holder.state !== 'failing') { update(c, { last_error: `another site proved it owns ${c.host} first` }); return false; }
      if (holder) end(holder, 'moved');
      update(c, { state: 'verified', verified_at: Date.now(), last_error: '' });
      return holder || null;
    })();
    if (moved === false) return;
    if (moved) {
      mailTo(moved, `${moved.host} now shows another site`, `Another site proved it owns ${moved.host}, so it no longer shows your site. Your site is back at ${sub(siteOf(moved))}.`);
    }
    await goLive(c);
  }

  // a daily check of a live or failing claim: { c, error, httpsFailed } (no HTTPS request while DNS is wrong)
  async function recheck(c) {
    const p = await proof(c);
    if (p.error) return { c, txt: p.txt, points: p.points, error: p.error };
    const ok = await dns.https(c.host);
    return { c, txt: true, points: true, error: ok ? '' : HTTPS_ERROR, httpsFailed: !ok };
  }
  function applyRecheck({ c, txt, points, error }, { mail = true } = {}) {
    const cur = byId.get(c.id);
    if (!cur || !RECHECKED.includes(cur.state)) return;
    const t = Date.now();
    if (!error) return update(c, { state: 'live', misses: 0, last_error: '', failing_since: 0, txt_ok: 1, addrs_ok: 1, checked_at: t });
    const misses = cur.misses + 1;
    const failing = cur.state === 'failing' || misses >= MISSES;
    update(c, { misses, last_error: error, txt_ok: +txt, addrs_ok: +points, checked_at: t, ...(failing && cur.state === 'live' ? { state: 'failing', failing_since: t } : {}) });
    if (!mail) return;
    const site = siteOf(c);
    if (misses === 1 && cur.state === 'live') {
      mailTo(c, `Today's check of ${c.host} failed`, `${c.host} is still live, but today's check failed: ${error}. Leave both DNS records in place. After ${MISSES - 1} more failed daily checks in a row, visitors stop being sent there.`);
    } else if (failing && cur.state === 'live') {
      mailTo(c, `${c.host} stopped working`, `${c.host} failed ${MISSES} daily checks in a row (${error}), so your site is back at ${sub(site)}. Put the records back and press Check now. If nothing changes, we let go of ${c.host} on ${day(t + FAILING_DAYS * DAY)}, and another site could claim it before then.`);
    }
  }

  // Check now: { the claim after the check }. A verified claim retries HTTPS at most hourly (Let's Encrypt allows 5 failures an hour).
  // A live or failing claim that passes is live again; one that fails only shows why, since misses are the daily check's to count
  async function check(site) {
    const c = of(site);
    if (!on() || !c) return c;
    if (c.state === 'pending') await verify(c);
    else if (c.state === 'verified' && c.checked_at < Date.now() - HOUR) await goLive(c);
    else if (c.state === 'live' || c.state === 'failing') {
      const r = await recheck(c);
      if (!r.error) applyRecheck(r);
      else if (RECHECKED.includes(byId.get(c.id)?.state)) update(c, { last_error: r.error, txt_ok: +r.txt, addrs_ok: +r.points });
    }
    return of(site);
  }

  // A moderator ends the claim; the member is told why. The claim, or null when there was none to end
  function detach(site, reason) {
    const c = of(site);
    if (!c || c.state === 'ended') return null;
    end(c, 'moderator', { last_error: reason });
    mailTo(c, `A moderator removed ${c.host}`, `A moderator removed ${c.host} from ${site.username}: ${reason}. Your site is back at ${sub(site)}.`);
    return c;
  }

  // the hourly run: lapses, expiries, abandonments, pending and verified claims, then the day's re-checks
  let lastRun = 0;
  async function housekeeping(t = Date.now()) {
    const ran = lastRun;
    lastRun = t;
    if (!on()) {
      // dormant: every clock stands still, so the time since the last run is added back
      // shortcut: time while the app itself was down isn't added back; keep the last run in the database if that matters
      const gap = ran ? t - ran : 0;
      if (gap) {
        db.prepare("UPDATE custom_domains SET created_at = created_at + @gap, failing_since = CASE WHEN failing_since > 0 THEN failing_since + @gap ELSE 0 END, grace_shift = grace_shift + @gap WHERE state != 'ended'").run({ gap });
      }
      return;
    }
    await refreshOurs().catch(() => {});
    const active = (where = '') => db.prepare(`SELECT * FROM custom_domains WHERE state != 'ended' ${where} ORDER BY id`).all();
    for (const c of active()) {
      const site = siteOf(c);
      if (logins.isSupporter(site)) { if (c.mailed || c.grace_shift) update(c, { mailed: '', grace_shift: 0 }); continue; }
      const until = logins.supporterUntil(logins.loginOf(site));
      const ends = graceEnd(site);
      if (t >= ends) {
        end(c, 'lapsed');
        mailTo(c, `${c.host} was removed`, `Your support ended ${GRACE_DAYS} days ago, so ${c.host} no longer shows ${site.username}. Your site is at ${sub(site)}. Supporters can add a domain again.`);
      } else if (t >= ends - 7 * DAY && c.mailed !== `soon:${until}`) {
        update(c, { mailed: `soon:${until}` });
        mailTo(c, `${c.host} stops working in a week`, `Your support ended, so ${c.host} stops showing ${site.username} on ${day(ends)}. Renew to keep it: ${cfg.BASE_URL}/dashboard/support`);
      } else if (!c.mailed.endsWith(`:${until}`)) {
        update(c, { mailed: `lapse:${until}` });
        mailTo(c, `${c.host} keeps working until ${day(ends)}`, `Your support ended. ${c.host} keeps working until ${day(ends)}, then your site goes back to ${sub(site)}. Renew to keep it: ${cfg.BASE_URL}/dashboard/support`);
      }
    }
    for (const c of active(`AND state IN ('pending', 'verified') AND created_at < ${t - PENDING_DAYS * DAY}`)) end(c, 'expired');
    for (const c of active(`AND state = 'failing' AND failing_since < ${t - FAILING_DAYS * DAY}`)) {
      end(c, 'abandoned');
      mailTo(c, `${c.host} was removed`, `${c.host} failed its checks for ${FAILING_DAYS} days, so we let go of it. Your site is at ${sub(siteOf(c))}. You can add it again.`);
    }
    const verifiedNow = new Set(); // already had this run's HTTPS request
    for (const c of active("AND state = 'pending'")) { await verify(c); verifiedNow.add(c.id); }
    for (const c of active("AND state = 'verified'")) if (!verifiedNow.has(c.id)) await goLive(c);
    // a day after its last check a claim is due; each run takes the longest-waiting 1/24th, so checks spread over the hours.
    // At least 10, so the outage guard below has enough to go on
    const checked = db.prepare(`SELECT COUNT(*) n FROM custom_domains WHERE state IN ${inList(RECHECKED)}`).get().n;
    const due = db.prepare(`SELECT * FROM custom_domains WHERE state IN ${inList(RECHECKED)} AND checked_at <= ? ORDER BY checked_at LIMIT ?`).all(t - 23 * HOUR, Math.max(10, Math.ceil(checked / 24)));
    const results = [];
    for (const c of due) results.push(await recheck(c));
    const https = results.filter((r) => r.httpsFailed !== undefined);
    // every HTTPS request failing at once is us (Caddy down, or Let's Encrypt), not the members
    const outage = https.length >= 3 && https.every((r) => r.httpsFailed);
    for (const r of results) if (!(outage && r.httpsFailed)) applyRecheck(r, { mail: !outage }); // an outage run emails no member at all
    if (outage) {
      sendMail(cfg.ABUSE_EMAIL, `[${cfg.SITE_NAME}] custom domain HTTPS checks all failed`, `All ${https.length} HTTPS checks of custom domains failed in one run, so none counted against their members. Check that Caddy is up and can reach Let's Encrypt.`);
    }
  }

  // lookups for serving, Caddy's ask and reports; all of them nothing while the flag is off
  const hostIn = (name, states) => {
    const { host } = normalise(name, cfg.BASE_HOST);
    return on() && host ? db.prepare(`SELECT c.*, u.username FROM custom_domains c JOIN users u ON u.id = c.site_id WHERE c.host = ? AND c.state IN ${inList(states)}`).get(host) : undefined;
  };
  const ask = (name) => !!hostIn(name, ['verified', 'live']);
  const siteFor = (host) => hostIn(host, ['live'])?.username; // the Site a request to this host is served as
  const reportTarget = (host) => hostIn(host, ['verified', 'live', 'failing']);
  // the live custom host of the Site with this name
  const liveHost = (name) => (on() ? db.prepare("SELECT c.host FROM custom_domains c JOIN users u ON u.id = c.site_id WHERE u.username = ? AND c.state = 'live'").get(String(name))?.host : undefined);

  return { of, add, remove, check, detach, housekeeping, ask, siteFor, reportTarget, liveHost, graceEnd, ours: () => ours, refreshOurs, PENDING_DAYS, FAILING_DAYS, MISSES };
}

module.exports = { normalise, createDomains };
