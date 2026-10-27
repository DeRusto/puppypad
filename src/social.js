// Social: follows, comments, likes, Blocks, notifications and the follow feed. Never touches req or res.
// A comment or like shows only while its author is Online and neither the member whose space it is nor the one looking
// blocked them. A Block applies both ways: while either member has blocked the other, neither can follow, comment on
// or like the other's Site, and an action a Block stops returns 'ok', so it looks like it went through.
// Notifications are worked out from the follows, comments and likes themselves on every read, so deletes and Blocks
// apply at once.
const { db } = require('./db');
const U = require('./util');

const { PER_PAGE, pageOf } = U;
const PREVIEW = 5; // comments shown under each Update on the feed and profile; the Update's own page has them all
const NOTE_KINDS = ['follow', 'comment', 'like'];
const NOTE_TEXT = { follow: 'started following you', comment: 'commented on your site', like: 'liked your update' };
// a Site's row with its follower count, for the pages that list Sites
const WITH_FOLLOWERS = 'SELECT u.*, (SELECT COUNT(*) FROM follows f WHERE f.followed_id = u.id) AS followers FROM users u';
const COMMENTS = 'FROM comments c JOIN users u ON u.id = c.author_id WHERE';

// sendMail(to, subject, text) sends the optional notification emails
function createSocial({ cfg, logins, listing, sendMail }) {
  const { ONLINE } = listing;
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const idOf = (viewer) => (viewer ? viewer.id : 0);
  const blocked = (blocker, who) => !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blocker, who);
  const blockedEither = (a, b) => blocked(a.id, b.id) || blocked(b.id, a.id);
  // hidden when the member whose space it is (`owner`, a column), or the one looking (@viewer), blocked its author
  const unblocked = (col, owner) => `${col} NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ${owner} OR blocker_id = @viewer)`;
  const limitOf = (page) => `LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`;

  // the optional email for one kind of notification; capped like guestbook mail so a burst can't flood the inbox
  function notify(owner, actor, kind, extra = '') {
    if (owner.id === actor.id || !owner.note_mail.split(' ').includes(kind) || !U.limit(`notemail:${owner.id}`, 10, 3600000)) return;
    sendMail(logins.loginOf(owner).email, `${actor.username} ${NOTE_TEXT[kind]} on ${cfg.SITE_NAME}`,
      `${actor.username} ${NOTE_TEXT[kind]}.${extra ? `\n\n${extra}` : ''}\n\nSee your notifications, or change which ones we email you about: ${cfg.BASE_URL}/notifications`);
  }

  // what a comment or like is about: { owner } for a Site, { owner, ev } for one of its Updates; null unless the Site is Online
  function target({ site, event }) {
    if (event !== undefined && event !== null && event !== '') {
      const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(event) || 0);
      const owner = ev && byId.get(ev.user_id);
      return owner && listing.isOnline(owner) ? { owner, ev } : null;
    }
    const owner = db.prepare('SELECT * FROM users WHERE username = ?').get(String(site || '').toLowerCase());
    return owner && listing.isOnline(owner) ? { owner, ev: null } : null;
  }
  // 'gone' unless `owner` is Online, not the actor, and the actor is not taken down
  const gone = (me, owner) => !owner || !listing.isOnline(owner) || me.banned || owner.id === me.id;

  // ----- actions: each returns 'ok', 'limited' or 'gone' -----
  function follow(me, owner) {
    if (gone(me, owner)) return 'gone';
    if (blockedEither(me, owner)) return 'ok';
    if (!U.limit(`follow:${me.id}`, 60, 3600000)) return 'limited';
    if (db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?,?,?)').run(me.id, owner.id, Date.now()).changes) notify(owner, me, 'follow');
    return 'ok';
  }
  const unfollow = (me, owner) => { db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?').run(me.id, owner.id); return 'ok'; };
  // on: from target(); per address, as comments may come from many sites of one person. A Block drops it, looking sent
  function comment(me, on, body, { ip }) {
    if (!on || me.banned || !listing.isOnline(on.owner)) return 'gone';
    if (!U.limit(`comment:${ip}`, 3, 600000)) return 'limited';
    if (blockedEither(me, on.owner)) return 'ok';
    db.prepare('INSERT INTO comments (user_id, author_id, event_id, body, created_at) VALUES (?,?,?,?,?)').run(on.owner.id, me.id, on.ev ? on.ev.id : null, body, Date.now());
    notify(on.owner, me, 'comment', body);
    return 'ok';
  }
  // the member whose profile or Update it is can delete any comment there
  const deleteComment = (me, id) => { db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(Number(id) || 0, me.id); return 'ok'; };
  function like(me, on) {
    if (!on || !on.ev || me.banned || !listing.isOnline(on.owner)) return 'gone';
    if (blockedEither(me, on.owner)) return 'ok';
    if (!U.limit(`like:${me.id}`, 60, 3600000)) return 'limited';
    if (db.prepare('INSERT OR IGNORE INTO likes (event_id, user_id, created_at) VALUES (?,?,?)').run(on.ev.id, me.id, Date.now()).changes) notify(on.owner, me, 'like');
    return 'ok';
  }
  const unlike = (me, on) => { if (on && on.ev) db.prepare('DELETE FROM likes WHERE event_id = ? AND user_id = ?').run(on.ev.id, me.id); return 'ok'; };
  // hides the other member's comments and likes and stops new ones both ways; follows between the two end
  function block(me, who) {
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(me.id, who.id, Date.now());
      db.prepare('DELETE FROM follows WHERE (follower_id = @a AND followed_id = @b) OR (follower_id = @b AND followed_id = @a)').run({ a: me.id, b: who.id });
    })();
    return 'ok';
  }
  const unblock = (me, who) => { db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me.id, who.id); return 'ok'; };

  // ----- reads -----
  const isFollowing = (me, site) => !!(me && db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?').get(me.id, site.id));
  const blocking = (me, site) => !!me && blocked(me.id, site.id);
  // page n of the comments on a Site's profile (on.ev null) or on one Update, newest first
  function comments(viewer, on, n) {
    const where = on.ev ? 'c.event_id = @ev' : 'c.user_id = @owner AND c.event_id IS NULL';
    const at = { owner: on.owner.id, ev: on.ev ? on.ev.id : 0, viewer: idOf(viewer) };
    const filter = `${where} AND ${ONLINE} AND ${unblocked('c.author_id', 'c.user_id')}`;
    const { page, pages } = pageOf(db.prepare(`SELECT COUNT(*) n ${COMMENTS} ${filter}`).get(at).n, n);
    return { rows: db.prepare(`SELECT c.*, u.username ${COMMENTS} ${filter} ORDER BY c.id DESC ${limitOf(page)}`).all(at), page, pages };
  }
  // page n of a Site's followers, or of the Sites it follows ('following'), newest first
  function follows(site, side, n) {
    const [who, other] = side === 'followers' ? ['follower_id', 'followed_id'] : ['followed_id', 'follower_id'];
    const from = `FROM follows f JOIN users u ON u.id = f.${who} WHERE f.${other} = ? AND ${ONLINE}`;
    const { page, pages } = pageOf(db.prepare(`SELECT COUNT(*) n ${from}`).get(site.id).n, n);
    return { rows: db.prepare(`SELECT u.username ${from} ORDER BY f.created_at DESC ${limitOf(page)}`).all(site.id), page, pages };
  }
  // Updates with their newest comments and comment count, like count, and whether the viewer liked them
  function details(events, viewer) {
    const at = { ids: JSON.stringify(events.map((e) => e.id)), viewer: idOf(viewer) };
    const cs = db.prepare(`SELECT * FROM (SELECT c.*, u.username, ROW_NUMBER() OVER (PARTITION BY c.event_id ORDER BY c.id DESC) rn, COUNT(*) OVER (PARTITION BY c.event_id) total
      ${COMMENTS} c.event_id IN (SELECT value FROM json_each(@ids)) AND ${ONLINE} AND ${unblocked('c.author_id', 'c.user_id')}) WHERE rn <= ${PREVIEW} ORDER BY id`).all(at);
    const likes = db.prepare(`SELECT l.event_id, COUNT(*) n, MAX(l.user_id = @viewer) mine FROM likes l JOIN events e ON e.id = l.event_id JOIN users u ON u.id = l.user_id
      WHERE l.event_id IN (SELECT value FROM json_each(@ids)) AND ${ONLINE} AND ${unblocked('l.user_id', 'e.user_id')} GROUP BY l.event_id`).all(at);
    return events.map((e) => {
      const l = likes.find((x) => x.event_id === e.id);
      const mine = cs.filter((c) => c.event_id === e.id);
      return { ...e, comments: mine, commentCount: mine.length ? mine[0].total : 0, likes: l ? l.n : 0, liked: !!(l && l.mine) };
    });
  }
  const notes = (me, cols, since = 0, tail = '') => db.prepare(`SELECT ${cols} FROM (
      SELECT 'follow' kind, follower_id actor, NULL event_id, NULL comment_id, '' body, created_at FROM follows WHERE followed_id = @me
      UNION ALL SELECT 'comment', author_id, event_id, id, body, created_at FROM comments WHERE user_id = @me
      UNION ALL SELECT 'like', l.user_id, l.event_id, NULL, '', l.created_at FROM likes l JOIN events e ON e.id = l.event_id WHERE e.user_id = @me
    ) n JOIN users u ON u.id = n.actor
    WHERE ${ONLINE} AND n.actor != @me AND n.actor NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = @me) AND n.created_at > @since ${tail}`).bind({ me: me.id, since });
  // page n of a member's notifications, newest first
  function notifications(me, n) {
    const { page, pages } = pageOf(notes(me, 'COUNT(*) n').get().n, n);
    return { rows: notes(me, 'n.*, u.username', 0, `ORDER BY n.created_at DESC ${limitOf(page)}`).all(), page, pages };
  }
  const unread = (me) => notes(me, 'COUNT(*) n', me.notes_seen_at).get().n;
  const seen = (me) => db.prepare('UPDATE users SET notes_seen_at = ? WHERE id = ?').run(Date.now(), me.id);
  // the newest Updates of the Sites a member follows that are Online and not hidden, with their details, and how many they follow
  function feed(me) {
    const events = db.prepare(`SELECT e.*, u.username, u.tagline FROM events e JOIN users u ON u.id = e.user_id
      WHERE e.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) AND ${listing.unhiddenWhere()} ORDER BY e.id DESC LIMIT 100`).all(me.id);
    return { events: details(events, me), count: db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id = ?').get(me.id).n };
  }
  // the weekly digest's Updates: from followed Sites that are Online and not hidden, after `since` up to `until`, newest first
  const digestFor = (me, since, until) => db.prepare(`SELECT e.*, u.username FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.kind = 'update' AND e.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) AND ${listing.unhiddenWhere()}
    AND e.created_at > ? AND e.created_at <= ? ORDER BY e.id DESC`).all(me.id, since, until);

  return {
    target, follow, unfollow, comment, deleteComment, like, unlike, block, unblock,
    isFollowing, blocking, comments, follows, details, notifications, unread, seen, feed, digestFor,
  };
}

module.exports = { createSocial, WITH_FOLLOWERS, NOTE_KINDS };
