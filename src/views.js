const { esc, fmtBytes, TEXT_EXT, extOf, SHRINK_PX, DAY } = require('./util');
const { PENDING_DAYS, FAILING_DAYS, GRACE_DAYS, MISSES, day: ymd } = require('./domains');
const starters = require('./starters');
const style = require('./style');
const { PARTS: CARD_PARTS, MAX_BYTES: CARD_MAX_BYTES, MAX_ART: CARD_MAX_ART, MAX_ART_BYTES: CARD_MAX_ART_BYTES } = require('./cardstyle');
const W = require('./widgets');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// the look lives in assets/site.css; the hash in its URL changes with the file, so browsers can cache it for a year
const CSS_URL = `/site.css?v=${crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'assets', 'site.css'))).digest('hex').slice(0, 12)}`;

function layout(ctx, title, body, opts = {}) {
  const { cfg, user, csrf } = ctx;
  // SEO: a page is indexable only when its view passes a description + path; anything else
  // (dashboard, login flows, notices) defaults to noindex, so private/transient pages stay out of search.
  const fullTitle = opts.fullTitle || `${title} - ${cfg.SITE_NAME}`;
  const desc = opts.description || '';
  const url = opts.path ? cfg.BASE_URL + opts.path : '';
  const meta = [
    desc ? `<meta name="description" content="${esc(desc)}">` : '',
    opts.noindex || !url ? '<meta name="robots" content="noindex">' : '',
    url ? `<link rel="canonical" href="${esc(url)}">` : '',
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    desc && url ? `<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(cfg.SITE_NAME)}"><meta property="og:title" content="${esc(fullTitle)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(opts.ogImage || cfg.BASE_URL + '/og.png')}"><meta name="twitter:card" content="summary_large_image">` : '',
    opts.jsonLd ? `<script type="application/ld+json">${opts.jsonLd}</script>` : '',
  ].join('');
  const nav = [
    `<a href="/">Home</a>`, `<a href="/browse">Dog park</a>`, `<a href="/random">Fetch a random pad</a>`, `<a href="/rules">Rules</a>`,
    ...(user
      ? [`<a href="/feed">Feed</a>`, `<a href="/notifications">Notifications${ctx.unread ? ` (${ctx.unread})` : ''}</a>`, `<a href="/dashboard">My pad</a>`, ...(ctx.isAdmin ? [`<a href="/admin">Admin</a>`] : []),
        `<form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Log out (${esc(user.username)})</button></form>`]
      : [`<a href="/signup">Get a free pad</a>`, `<a href="/login">Log in</a>`]),
  ].join(' ')
    // the tab for the section you are in wears the yellow: Home only on /, the others on their path and below it
    .replace(/<a href="(\/[^"]*)">/g, (a, h) => (h === '/' ? ctx.path === '/' : ctx.path === h || ctx.path?.startsWith(`${h}/`)) ? `<a href="${h}" aria-current="page">` : a);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(fullTitle)}</title>${meta}<link rel="stylesheet" href="${CSS_URL}">${opts.head || ''}</head><body><div class="site">
<header class="box"><h1><a href="/">${esc(cfg.SITE_NAME)}</a></h1>${opts.tight ? '' : `<p class="tagline">${esc(cfg.TAGLINE)}</p>`}<nav aria-label="Main">${nav}</nav></header>
${body}
<footer class="box">Free homepages for good dogs and bad HTML. <a href="/rules">Rules</a> | <a href="/privacy">Privacy</a> | <a href="/report">Report a site</a> | Abuse contact: ${esc(cfg.ABUSE_EMAIL)}</footer>
</div></body></html>`;
}

const msg = (m) => (m && m.err ? `<p class="err" role="alert">${esc(m.err)}</p>` : '') + (m && m.ok ? `<p class="ok" role="status">${esc(m.ok)}</p>` : '');
const csrfField = (ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf || '')}">`;
const ago = (t) => {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  const [n, u] = s < 60 ? [s, 'second'] : s < 3600 ? [s / 60, 'minute'] : s < 86400 ? [s / 3600, 'hour'] : [s / 86400, 'day'];
  const k = Math.floor(n);
  return `${k} ${u}${k === 1 ? '' : 's'} ago`;
};
// a site's name, plus the supporter icon while its login supports; every place that lists names goes through here
const isSup = (ctx, name) => !!ctx.supporters?.has(name);
const nameTag = (ctx, name) => `${esc(name)}${isSup(ctx, name) ? `<img class="badge" src="/img/supporter.svg" alt="${esc(ctx.cfg.SITE_NAME)} supporter" title="${esc(ctx.cfg.SITE_NAME)} supporter">` : ''}`;
const siteList = (ctx, rows) => rows.length
  ? `<ul class="pups">${rows.map((r) => `<li><a href="${esc(ctx.cfg.siteUrl(r.username))}"${r.tagline ? ` title="${esc(r.tagline)}"` : ''}>${nameTag(ctx, r.username)}</a></li>`).join('')}</ul>`
  : `<p>The pad is clean. Make the first mess.</p>`;

const shotImg = (ctx, r, link, part = '') => (r.shot
  ? `<a${part} href="${esc(link)}"><img class="shot" src="/shots/${esc(r.username)}.jpg?v=${r.shot_at || 0}" alt="Screenshot of ${esc(r.username)}" loading="lazy" width="512" height="384"></a>`
  : `<a${part} class="shot none" href="${esc(link)}">${esc(r.username)}<br>no screenshot yet</a>`);
const tagLinks = (tags) => tags.split(' ').map((t) => `<a href="/browse?q=${encodeURIComponent(t)}">#${esc(t)}</a>`).join(' ');
// parts: /browse only; adds the member root and the Card part hooks that card style targets (all six, even when empty).
// A row with no id gets no scope class, so no card style reaches it: the Stock card on /dashboard/card
const cards = (ctx, rows, parts = false) => {
  const p = (name) => (parts ? ` data-part="${name}"` : '');
  return rows.length
    ? `<ul class="grid">${rows.map((r) => `<li class="card${parts && r.id ? ` cs-${r.id}` : ''}${isSup(ctx, r.username) ? ' supporter' : ''}">${parts ? '<div data-part="card">' : ''}${shotImg(ctx, r, ctx.cfg.siteUrl(r.username), p('shot'))}
<div><a${p('name')} href="${esc(ctx.cfg.siteUrl(r.username))}"><b>${nameTag(ctx, r.username)}</b></a> <a href="/site/${esc(r.username)}" class="t">[profile]</a></div>
${r.tagline || parts ? `<div${p('tagline')} class="t">${esc(r.tagline || '')}</div>` : ''}${r.tags || parts ? `<div${p('tags')} class="t">${r.tags ? tagLinks(r.tags) : ''}</div>` : ''}
<div${p('stats')} class="t">updated ${ago(r.updated_at)} | ${r.followers} follower${r.followers === 1 ? '' : 's'} | ${r.hits} hits</div>${parts ? '</div>' : ''}</li>`).join('')}</ul>`
    : `<p>The pad is clean. Make the first mess.</p>`;
};

const ATOM_LINK = (title, href) => `<link rel="alternate" type="application/atom+xml" title="${esc(title)}" href="${esc(href)}">`;
const home = (ctx, { sotw, picks, recent, newest, total, supporters = 0 }) => layout(ctx, 'Home', `
<section class="box split"><div><h2>Your own pad on the web</h2>
<p class="lead">Sign up and you get <code>yourname.${esc(ctx.cfg.BASE_HOST)}</code>, ${ctx.cfg.QUOTA_MB} MB of space, a code editor with live preview, a hit counter and a guestbook. No templates, no algorithm. Write your own HTML, and do not worry about making a mess. That is what the pad is for.</p>
<div class="cta"><a class="btn big" href="/signup">Claim your pad</a><a href="/random">or fetch a random pad first</a></div>
<ul class="stamps"><li class="stamp">${ctx.cfg.QUOTA_MB} MB free</li><li class="stamp">Live preview editor</li><li class="stamp">Hit counter</li><li class="stamp">Guestbook</li><li class="stamp">No algorithm</li></ul>
<p class="note">${total} pad${total === 1 ? '' : 's'} in use so far${supporters ? `, kept running by ${supporters} supporter${supporters === 1 ? '' : 's'} (<a href="/dashboard/support">chip in</a>)` : ''}</p></div>
<img class="wave" src="/img/pup-hero.webp" alt="Cartoon puppy waving from a puppy pad" width="180" height="143"></section>
${sotw ? `<section class="box"><h2>Site of the week</h2><div class="sotw">${shotImg(ctx, sotw, ctx.cfg.siteUrl(sotw.username))}<div>
<h3><a href="${esc(ctx.cfg.siteUrl(sotw.username))}">${nameTag(ctx, sotw.username)}</a> <a href="/site/${esc(sotw.username)}" class="t">[profile]</a></h3>
${sotw.tagline ? `<p>${esc(sotw.tagline)}</p>` : ''}${sotw.tags ? `<p class="t">${tagLinks(sotw.tags)}</p>` : ''}
<p class="note">${sotw.followers} follower${sotw.followers === 1 ? '' : 's'} | ${sotw.hits} hits</p></div></div></section>` : ''}
${picks.length ? `<section class="box split"><div><h2>Staff picks</h2>${cards(ctx, picks)}</div><img src="/img/pup-coder.webp" alt="Cartoon puppy typing code on a retro computer" width="180" height="120" loading="lazy"></section>` : ''}
<section class="box split"><div><h2>Fresh accidents <small>(recently updated)</small></h2>${cards(ctx, recent)}<p class="mt"><a href="/browse">See them all in the dog park &gt;&gt;</a></p></div>
<img src="/img/pup-accident.webp" alt="Cartoon puppy looking sheepish next to a puddle on its pad" width="180" height="116" loading="lazy"></section>
<section class="box split"><div><h2>New puppies <small>(just joined)</small></h2>${siteList(ctx, newest)}</div>
<img src="/img/pup-guestbook.webp" alt="Cartoon puppy with a pencil next to an open guestbook" width="180" height="114" loading="lazy"></section>`, {
  fullTitle: `${ctx.cfg.SITE_NAME} \u2014 Free Homepages | Make Your Own Website, Old-Web Style`,
  description: `${ctx.cfg.SITE_NAME} is a free homepage host. Get yourname.${ctx.cfg.BASE_HOST}, ${ctx.cfg.QUOTA_MB} MB, a built-in editor, guestbook and hit counter. No templates, no algorithm \u2014 write your own HTML. Accidents welcome.`,
  path: '/',
  head: ATOM_LINK(`${ctx.cfg.SITE_NAME}: recently updated`, '/feed.xml'),
  jsonLd: JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: ctx.cfg.SITE_NAME, url: ctx.cfg.BASE_URL, description: 'Free old-web homepage host' }),
});

const SORT_LABELS = { updated: 'Recently updated', newest: 'Newest', followed: 'Most followed', hits: 'Most visited' };
const browse = (ctx, { rows, page, pages, sort, q, cardCss = '' }) => {
  const qs = q ? `&amp;q=${esc(encodeURIComponent(q))}` : '';
  return layout(ctx, 'Dog park', `
<section class="box"><h2>The dog park <small>(page ${page} of ${pages})</small></h2>
<form class="stack" method="get" action="/browse" role="search"><input type="hidden" name="sort" value="${esc(sort)}"><label for="q">Find a site by name or tag</label>
<input type="search" id="q" name="q" maxlength="50" value="${esc(q)}"><button>Search</button></form>${q ? `<p><a href="/browse?sort=${sort}">Show every site</a></p>` : ''}
<p class="sorts">Sort: ${Object.entries(SORT_LABELS).map(([k, l]) => (k === sort ? `<b>${l}</b>` : `<a href="/browse?sort=${k}${qs}">${l}</a>`)).join(' ')}</p>
${q && !rows.length ? '<p>No sites match that search.</p>' : cards(ctx, rows, true)}
<p class="mt pages">${page > 1 ? `<a href="/browse?sort=${sort}${qs}&amp;page=${page - 1}">&lt;&lt; Prev</a>` : ''} ${page < pages ? `<a href="/browse?sort=${sort}${qs}&amp;page=${page + 1}">Next &gt;&gt;</a>` : ''}</p>
<p class="note"><a href="/feed.xml">Follow recently updated sites in a feed reader</a> (Atom).</p></section>`, { noindex: !!q, description: 'Browse homepages hosted on PuppyPad \u2014 the dog park. Fresh, hand-written websites. No feeds, no algorithm.', path: page === 1 && sort === 'updated' ? '/browse' : `/browse?sort=${sort}&page=${page}`, head: ATOM_LINK(`${ctx.cfg.SITE_NAME}: recently updated`, '/feed.xml') + (cardCss ? `<style>${cardCss}</style>` : '') });
};

const EVENT_TEXT = { update: 'left a fresh update on their pad', join: 'joined' };
// "updated a.html, b.png and 3 more", each name passed through link; events from before files were recorded keep the old line
const eventText = (e, link) => {
  const files = e.kind === 'update' && e.files ? e.files.split('\n') : [];
  if (!files.length) return EVENT_TEXT[e.kind] || esc(e.kind);
  return `updated ${files.slice(0, 5).map(link).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;
};
const fileLinks = (e, url) => eventText(e, (f) => `<a href="${esc(url)}/${esc(f)}">${esc(f)}</a>`);
// newer/older links for a paged list; href(n) is page n's address
const pager = (href, page, pages) => (pages > 1 ? `<p>${page > 1 ? `<a href="${esc(href(page - 1))}">&lt;&lt; Newer</a> ` : ''}page ${page} of ${pages}${page < pages ? ` <a href="${esc(href(page + 1))}">Older &gt;&gt;</a>` : ''}</p>` : '');
const updateUrl = (owner, e) => `/site/${owner}/update/${e.id}`;
// comments: the member whose profile or update it is (canDelete) may delete them; back says where the form returns to
const commentHtml = (ctx, c, canDelete, back) => `<div class="cmt"><a href="/site/${esc(c.username)}">${nameTag(ctx, c.username)}</a> <small>${ago(c.created_at)}</small>${canDelete
  ? ` <form class="inline" method="post" action="/comment/delete">${csrfField(ctx)}<input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${back}"><button class="link">delete</button></form>` : ''}<div>${esc(c.body)}</div></div>`;
const commentForm = (ctx, target, back) => `<form class="stack" method="post" action="/comment">${csrfField(ctx)}${target}<input type="hidden" name="back" value="${back}">
<textarea name="body" rows="2" maxlength="500" required aria-label="Your comment"></textarea>
<div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div><button>Comment</button></form>`;
// likes and comments under a feed update
const social = (ctx, e, owner, back) => {
  const like = ctx.user ? ` <form class="inline" method="post" action="/like">${csrfField(ctx)}<input type="hidden" name="event" value="${e.id}"><input type="hidden" name="back" value="${back}"><button class="link" name="action" value="${e.liked ? 'unlike' : 'like'}">${e.liked ? 'unlike' : 'like'}</button></form>` : '';
  return `<div class="social">${e.likes} like${e.likes === 1 ? '' : 's'}${like}
${e.commentCount > e.comments.length ? `<p class="note"><a href="${esc(updateUrl(owner, e))}">See all ${e.commentCount} comments</a></p>` : ''}
${e.comments.map((c) => commentHtml(ctx, c, !!ctx.user && ctx.user.username === owner, back)).join('')}
${ctx.user ? `<details><summary>Comment</summary>${commentForm(ctx, `<input type="hidden" name="event" value="${e.id}">`, back)}</details>` : ''}</div>`;
};
const nameLinks = (ctx, rows) => (rows.length ? `<div class="names">${rows.map((r) => `<a href="/site/${esc(r.username)}">${nameTag(ctx, r.username)}</a>`).join('')}</div>` : '<p class="note">Nobody yet.</p>');
const profile = (ctx, m, { p, following, blocking, login, comments, events, followers, follows }) => {
  const url = ctx.cfg.siteUrl(p.username);
  const mine = ctx.user && ctx.user.id === p.id;
  return layout(ctx, p.username, `
<section class="box"><h2>${nameTag(ctx, p.username)}</h2>${msg(m)}<div class="prof">
<div class="pic${isSup(ctx, p.username) ? ' supporter' : ''}">${shotImg(ctx, p, url)}</div>
<div class="info"><p><a href="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</a></p>
${p.tagline ? `<p>${esc(p.tagline)}</p>` : ''}${p.tags ? `<p>${tagLinks(p.tags)}</p>` : ''}
<p>${p.followers} follower${p.followers === 1 ? '' : 's'} | ${p.updates} update${p.updates === 1 ? '' : 's'} | ${p.hits} hits<br>Joined ${ago(p.created_at)}, last updated ${ago(p.updated_at)}</p>
${mine ? '<p><a href="/dashboard">Edit my site</a></p>' : `<form class="inline" method="post" action="/follow">${csrfField(ctx)}<input type="hidden" name="site" value="${esc(p.username)}">
<button name="action" value="${following ? 'unfollow' : 'follow'}">${following ? 'Unfollow' : ctx.user ? 'Follow' : 'Log in to follow'}</button></form>
${ctx.user ? `<form class="inline" method="post" action="/block">${csrfField(ctx)}<input type="hidden" name="site" value="${esc(p.username)}"><button class="link" name="action" value="${blocking ? 'unblock' : 'block'}">${blocking ? 'Unblock' : 'Block'}</button></form>` : ''}
${blocking ? `<p class="note">You blocked ${esc(p.username)}. Their comments and likes are hidden from you, and they can't comment on, like or follow your site.</p>` : ''}
<p class="mt"><a href="/report?site=${esc(p.username)}">Report this site</a></p>`}</div></div></section>
<section class="box"><h2>Recent activity</h2>${events.length ? `<ul>${events.map((e) => `<li>${fileLinks(e, url)} <a href="${esc(updateUrl(p.username, e))}" class="note">${ago(e.created_at)}</a>${social(ctx, e, p.username, `/site/${p.username}`)}</li>`).join('')}</ul>` : '<p class="note">Nothing yet.</p>'}
<p class="note"><a href="/site/${esc(p.username)}/feed.xml">Follow ${esc(p.username)} in a feed reader</a> (Atom).</p></section>
<section class="box" id="comments"><h2>Comments</h2>${comments.rows.map((c) => commentHtml(ctx, c, mine, `/site/${p.username}`)).join('') || '<p class="note">No comments yet.</p>'}
${pager((n) => `/site/${p.username}?cpage=${n}#comments`, comments.page, comments.pages)}
${ctx.user ? commentForm(ctx, `<input type="hidden" name="site" value="${esc(p.username)}">`, `/site/${p.username}`) : '<p><a href="/login">Log in</a> to leave a comment.</p>'}</section>
<section class="box" id="followers"><h2>Followers</h2>${nameLinks(ctx, followers.rows)}
${pager((n) => `/site/${p.username}?fpage=${n}#followers`, followers.page, followers.pages)}
<h3 id="following">Following</h3>${nameLinks(ctx, follows.rows)}
${pager((n) => `/site/${p.username}?gpage=${n}#following`, follows.page, follows.pages)}</section>
${mine ? `<section class="box"><h2>Change password</h2>
<form class="stack" method="post" action="/account/password">${csrfField(ctx)}<label for="curpw">Current password</label>
<input type="password" id="curpw" name="password" required autocomplete="current-password">
<label for="newpw">New password (10 characters or more)</label>
<input type="password" id="newpw" name="new_password" minlength="10" maxlength="200" required autocomplete="new-password">
<label for="newpw2">New password again</label>
<input type="password" id="newpw2" name="confirm_password" minlength="10" maxlength="200" required autocomplete="new-password"><button>Change password</button></form></section>
<section class="box"><h2>Change email</h2><p>Your email is <b>${esc(ctx.login.email)}</b>.${ctx.login.new_email ? ` Waiting for <b>${esc(ctx.login.new_email)}</b> to confirm.` : ''}</p>
<form class="stack" method="post" action="/account/email">${csrfField(ctx)}<label for="newemail">New email (we send a link there to confirm it)</label>
<input type="email" id="newemail" name="email" maxlength="200" required autocomplete="email">
<label for="emailpw">Your password</label>
<input type="password" id="emailpw" name="password" required autocomplete="current-password"><button>Change email</button></form></section>
<section class="box" id="security"><h2>Logging in</h2>
<form method="post" action="/account/logout-all">${csrfField(ctx)}<button>Log out everywhere</button> <span class="note">Every browser and device logged in to your site, this one too.</span></form>
<h3>Two-factor login</h3>${login.totp_secret ? `<p>On. Logging in takes your password and a code from your authenticator app. Recovery codes left: ${login.totp_codes.split('\n').filter(Boolean).length}.</p>
<form class="stack" method="post" action="/account/2fa/off">${csrfField(ctx)}<label for="offcode">A code from your app, or a recovery code</label>
<input type="text" id="offcode" name="code" required inputmode="numeric" autocomplete="one-time-code">
<label for="offpw">Your password</label><input type="password" id="offpw" name="password" required autocomplete="current-password"><button>Turn off two-factor login</button></form>`
    : '<p>Off. With it on, logging in also takes a code from an authenticator app on your phone, so a leaked password alone can\'t get anyone in. <a href="/account/2fa">Turn on two-factor login</a></p>'}</section>` : ''}`, {
    description: p.tagline ? `${p.tagline} \u2014 ${p.username}'s homepage on ${ctx.cfg.SITE_NAME}` : `${p.username}'s homepage on ${ctx.cfg.SITE_NAME}, a free old-web homepage host.`,
    path: `/site/${p.username}`,
    ogImage: p.shot ? `${ctx.cfg.BASE_URL}/shots/${p.username}.jpg` : undefined,
    head: ATOM_LINK(`${p.username} on ${ctx.cfg.SITE_NAME}`, `/site/${p.username}/feed.xml`),
  });
};

const feed = (ctx, { events, count }) => layout(ctx, 'Feed', `
<section class="box"><h2>Your feed</h2>
${events.length ? `<ul class="feed">${events.map((e) => `<li${isSup(ctx, e.username) ? ' class="supporter"' : ''}>${shotImg(ctx, e, ctx.cfg.siteUrl(e.username))}<div><a href="${esc(ctx.cfg.siteUrl(e.username))}"><b>${nameTag(ctx, e.username)}</b></a> ${fileLinks(e, ctx.cfg.siteUrl(e.username))} <a href="${esc(updateUrl(e.username, e))}" class="note">${ago(e.created_at)}</a>${e.tagline ? `<div class="note">${esc(e.tagline)}</div>` : ''}${social(ctx, e, e.username, '/feed')}</div></li>`).join('')}</ul>`
    : count ? '<p>The sites you follow have been quiet. Updates show up here.</p>'
      : '<p>You are not following anyone yet. <a href="/browse">Visit the dog park</a> and press Follow on the ones you like.</p>'}</section>`);

const NOTE_LINE = { follow: 'started following you', comment: 'commented on your site', like: 'liked your update' };
// one update with its likes and every comment, newest first, a page at a time
const update = (ctx, { p, e, comments }) => {
  const url = ctx.cfg.siteUrl(p.username);
  const here = updateUrl(p.username, e);
  const mine = !!ctx.user && ctx.user.id === p.id;
  return layout(ctx, `${p.username}'s update`, `
<section class="box"><h2><a href="/site/${esc(p.username)}">${nameTag(ctx, p.username)}</a> ${fileLinks(e, url)}</h2><p class="note">${ago(e.created_at)}</p>
${social(ctx, { ...e, comments: [], commentCount: 0 }, p.username, here)}
<h3>Comments</h3>${comments.rows.map((c) => commentHtml(ctx, c, mine, here)).join('') || '<p class="note">No comments yet.</p>'}
${pager((n) => `${here}?page=${n}`, comments.page, comments.pages)}</section>`, { noindex: true });
};

const notifications = (ctx, { rows, page, pages, seenAt }) => {
  const u = ctx.user;
  const box = (k, label) => `<label><input type="checkbox" name="${k}" value="1"${u.note_mail.split(' ').includes(k) ? ' checked' : ''}> ${label}</label>`;
  return layout(ctx, 'Notifications', `
<section class="box"><h2>Notifications</h2>
${rows.length ? `<ul class="sites">${rows.map((n) => `<li${n.created_at > seenAt ? ' class="new"' : ''}><a href="/site/${esc(n.username)}">${nameTag(ctx, n.username)}</a> ${NOTE_LINE[n.kind]}${n.body ? `: "${esc(n.body)}"` : ''} <small>${ago(n.created_at)}${n.kind === 'follow' ? '' : ` | <a href="${esc(n.event_id ? updateUrl(u.username, { id: n.event_id }) : `/site/${u.username}#comments`)}">see it</a>`}</small>${n.comment_id ? ` <form class="inline" method="post" action="/comment/delete">${csrfField(ctx)}<input type="hidden" name="id" value="${n.comment_id}"><input type="hidden" name="back" value="/notifications"><button class="link">delete</button></form>` : ''}</li>`).join('')}</ul>`
    : '<p class="note">Nothing yet. New followers, comments and likes show up here.</p>'}
${pager((n) => `/notifications?page=${n}&since=${seenAt}`, page, pages)}</section>
<section class="box"><h2>Email me</h2>
<form class="stack" method="post" action="/notifications/settings">${csrfField(ctx)}<p class="note">Sent to ${esc(ctx.login.email)}.</p>
${box('follow', 'when someone follows my site')}${box('comment', 'when someone comments on my site or my updates')}${box('like', 'when someone likes one of my updates')}
<label><input type="checkbox" name="digest" value="1"${u.digest ? ' checked' : ''}> a weekly digest of updates from the sites I follow</label>
<button>Save</button></form></section>`);
};

// the pitch beside the signup and login forms: what a pad comes with, and a way across to the other form
const pitch = (ctx, h, cta) => `<aside class="box perks"><img src="/img/pup-hero.webp" alt="Cartoon puppy waving from a puppy pad" width="180" height="143">
<h2>${h}</h2><ul class="stamps"><li class="stamp">${ctx.cfg.QUOTA_MB} MB free</li><li class="stamp">Live preview editor</li><li class="stamp">Hit counter</li><li class="stamp">Guestbook</li><li class="stamp">No algorithm</li></ul>
<p>Your own address at <code>yourname.${esc(ctx.cfg.BASE_HOST)}</code>. Write your own HTML, and do not worry about making a mess.</p>${cta}</aside>`;

const signup = (ctx, m, v = {}) => layout(ctx, 'Sign up', `<div class="cols">
<section class="box"><h2>Get a free pad</h2>${msg(m)}
<form class="stack wide" method="post" action="/signup">
<label for="username">Site name</label>
<input type="text" id="username" name="username" value="${esc(v.username)}" maxlength="30" required autocapitalize="none" autocomplete="username" aria-describedby="username-hint">
<p class="note" id="username-hint">3-30 lowercase letters, numbers or hyphens. Your address will be <code>name.${esc(ctx.cfg.BASE_HOST)}</code>.</p>
<label for="email">Email</label>
<input type="email" id="email" name="email" value="${esc(v.email)}" required autocomplete="email" aria-describedby="email-hint">
<p class="note" id="email-hint">We send one confirmation link, nothing else.</p>
<label for="password">Password</label>
<input type="password" id="password" name="password" minlength="10" required autocomplete="new-password" aria-describedby="password-hint">
<p class="note" id="password-hint">10 characters or more.</p>
<fieldset class="starters"><legend>Pick a starter layout. It is only a beginning: every colour, font and box is yours to change.</legend>
${starters.LIST.map((s) => `<label><input type="radio" name="starter" value="${s.id}"${(v.starter || starters.DEFAULT) === s.id ? ' checked' : ''}> <span><b>${esc(s.name)}</b><br>${esc(s.blurb)} <a href="/starters/${s.id}" target="_blank">Peek</a></span></label>`).join('\n')}
</fieldset>
<div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="check"><input type="checkbox" name="agree" value="1" required> I am 13 or older and have read the <a href="/rules" target="_blank">rules</a> and <a href="/privacy" target="_blank">privacy notice</a></label>
${ctx.cfg.TURNSTILE_SITE_KEY ? `<div class="cf-turnstile" data-sitekey="${esc(ctx.cfg.TURNSTILE_SITE_KEY)}"></div>` : ''}
<button class="big">Roll out my pad</button></form></section>
${pitch(ctx, 'What you get', '<p class="note">Already have a pad? <a href="/login">Log in</a>.</p>')}</div>`, { noindex: true, description: `Claim a free ${ctx.cfg.SITE_NAME} homepage: your own subdomain, ${ctx.cfg.QUOTA_MB} MB, a code editor with live preview, a guestbook and a hit counter.`, path: '/signup', ...(ctx.cfg.TURNSTILE_SITE_KEY ? { head: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' } : {}) });

const login = (ctx, m, v = {}) => layout(ctx, 'Log in', `<div class="cols">
<section class="box"><h2>Log in</h2>${msg(m)}
<form class="stack" method="post" action="/login">
<label for="username">Site name or email</label><input type="text" id="username" name="username" value="${esc(v.username)}" required autocapitalize="none" autocomplete="username">
<label for="password">Password</label><input type="password" id="password" name="password" required autocomplete="current-password">
<button>Log in</button></form><p class="mt"><a href="/forgot">Forgot your password?</a></p></section>
${pitch(ctx, 'New here?', '<p><a class="btn big" href="/signup">Get a free pad</a></p>')}</div>`);

// a page's main box beside a side box with help: forms on the left, the why and what-next on the right
const two = (main, side) => `<div class="cols"><div>${main}</div><div class="side">${side}</div></div>`;
const aside = (title, html) => `<aside class="box"><h2>${title}</h2>${html}</aside>`;

const login2fa = (ctx, m, token) => layout(ctx, 'Log in', two(`
<section class="box"><h2>Two-factor login</h2>${msg(m)}
<form class="stack" method="post" action="/login/2fa"><input type="hidden" name="token" value="${esc(token)}">
<label for="code">The 6-digit code from your authenticator app</label><input type="text" id="code" name="code" required autofocus inputmode="numeric" autocomplete="one-time-code">
<button>Log in</button></form></section>`, aside('Lost your phone?', `<p>Enter one of your recovery codes instead of a code from the app. Each one works once.</p>
<p class="note">No phone and no recovery codes? Write to ${esc(ctx.cfg.ABUSE_EMAIL)} from the email you signed up with.</p>`)), { noindex: true });

// qr is the SVG the qrcode package drew for uri: paths only, nothing a member typed
const twoFactor = (ctx, m, secret, uri, qr) => layout(ctx, 'Two-factor login', two(`
<section class="box"><h2>Turn on two-factor login</h2>${msg(m)}
<ol><li>Open an authenticator app on your phone (Google Authenticator, Authy, 1Password, Bitwarden and others all work).</li>
<li>Add an account by scanning this QR code with the app:<div role="img" aria-label="QR code for your two-factor key" class="qr">${qr}</div>
<span class="note">Can't scan it? Type this key instead: <code>${secret.match(/.{4}/g).join(' ')}</code>, or on your phone <a href="${esc(uri)}">tap here to add it</a>.</span></li>
<li>Enter the 6-digit code the app shows.</li></ol>
<form class="stack" method="post" action="/account/2fa/on">${csrfField(ctx)}<input type="hidden" name="secret" value="${esc(secret)}">
<label for="code">Code from the app</label><input type="text" id="code" name="code" required inputmode="numeric" autocomplete="one-time-code">
<label for="pw">Your password</label><input type="password" id="pw" name="password" required autocomplete="current-password">
<button>Turn on</button></form><p class="mt"><a href="/site/${esc(ctx.user.username)}#security">Cancel</a></p></section>`,
aside('Why turn it on', `<p>With it on, logging in takes your password and a code from your phone, so a leaked password alone can't get anyone into your site.</p>
<p class="note">After you turn it on we show recovery codes once. Keep them somewhere safe: they get you in if you lose your phone.</p>`)), { noindex: true });

const recoveryCodes = (ctx, codes) => layout(ctx, 'Recovery codes', two(`
<section class="box"><h2>Two-factor login is on</h2>
<p>Save these recovery codes now. This is the only time we show them.</p>
<pre>${codes.join('\n')}</pre>
<p><a class="btn" href="/site/${esc(ctx.user.username)}#security">I saved them</a></p></section>`,
aside('Where to keep them', `<p>A password manager, or on paper somewhere safe. If you lose your phone, each code logs you in once in place of a code from the app.</p>`)), { noindex: true });

const forgot = (ctx, m) => layout(ctx, 'Reset password', two(`
<section class="box"><h2>Reset your password</h2>${msg(m)}
<form class="stack" method="post" action="/forgot"><label for="email">The email you signed up with</label>
<input type="email" id="email" name="email" required autocomplete="email"><button>Email me a reset link</button></form>
<p class="mt"><a href="/login">Back to log in</a></p></section>`,
aside("Can't get in?", `<p>We email you a link to choose a new password. It works for one hour.</p>
<p class="note">Nothing arrived? Check your spam folder. Still stuck? Write to ${esc(ctx.cfg.ABUSE_EMAIL)}.</p>`)));

const reset = (ctx, m, token) => layout(ctx, 'Choose a new password', two(`
<section class="box"><h2>Choose a new password</h2>${msg(m)}
<form class="stack" method="post" action="/reset"><input type="hidden" name="token" value="${esc(token)}">
<label for="password">New password</label>
<input type="password" id="password" name="password" minlength="10" required autocomplete="new-password" aria-describedby="password-hint">
<p class="note" id="password-hint">10 characters or more.</p><button>Save password</button></form></section>`,
aside('A good password', `<p>Long beats clever: a few unrelated words make a strong one. A password manager can make and remember it for you.</p>
<p class="note">Saving it logs out your other browsers and switches off your API key, if you have one.</p>`)));

// a one-paragraph page; the sheepish puppy keeps it company on wide screens
const notice = (ctx, title, html) => layout(ctx, title, `<section class="box split"><div><h2>${esc(title)}</h2>${html}</div>
<img src="/img/pup-accident.webp" alt="" width="180" height="116"></section>`, { noindex: true });
// the one-paragraph pages the server answers with; the status code is the route's choice
const notices = {
  busy: (ctx, msg) => notice(ctx, 'Try again soon', `<p>${esc(msg)}</p>`),
  notFound: (ctx) => notice(ctx, 'Not found', '<p>No such page. <a href="/">Go home.</a></p>'),
  noSuchPage: (ctx) => notice(ctx, 'Not found', '<p>No such page.</p>'),
  noSuchSite: (ctx) => notice(ctx, 'Not found', '<p>There is no site with that name. <a href="/browse">Browse sites.</a></p>'),
  updateGone: (ctx) => notice(ctx, 'Not found', '<p>That update is gone. <a href="/browse">Browse sites.</a></p>'),
  noSuchStarter: (ctx) => notice(ctx, 'Not found', '<p>No such starter. <a href="/signup">Back to signup.</a></p>'),
  tooManyComments: (ctx) => notice(ctx, 'Slow down', '<p>Too many comments from you. Try again in ten minutes.</p>'),
  tooManyResets: (ctx) => notice(ctx, 'Slow down', '<p>Too many reset attempts from your connection. Try again in an hour.</p>'),
  signupBot: (ctx) => notice(ctx, 'Check your email', '<p>We sent you a confirmation link.</p>'),
  signupSent: (ctx, email) => notice(ctx, 'Check your email', `<p>We sent a confirmation link to <b>${esc(email)}</b>. Your site goes live when you click it. The link works for 48 hours.</p>`),
  signupLinkExpired: (ctx) => notice(ctx, 'Link expired', '<p>That confirmation link is no longer valid. <a href="/login">Log in</a> to get a new one.</p>'),
  confirmFirst: (ctx) => notice(ctx, 'Confirm your email first', '<p>We sent you a fresh confirmation link. Click it to finish setting up.</p>'),
  loginTimedOut: (ctx) => notice(ctx, 'Log in again', '<p>That login took too long. <a href="/login">Log in again.</a></p>'),
  resetSent: (ctx) => notice(ctx, 'Check your email', '<p>If that address has a site here, a reset link is on its way.</p>'),
  resetLinkExpired: (ctx) => notice(ctx, 'Link expired', '<p>That reset link is no longer valid. <a href="/forgot">Request a new one.</a></p>'),
  passwordSaved: (ctx) => notice(ctx, 'Password saved', '<p>Your new password is saved. <a href="/login">Log in</a> with it and a code from your authenticator app.</p>'),
  badPath: (ctx) => notice(ctx, 'Cannot save', '<p>That file path is not allowed. <a href="/dashboard">Back to my site.</a></p>'),
  emailLinkExpired: (ctx) => notice(ctx, 'Link expired', '<p>That confirmation link is no longer valid. Ask for a new one from your profile page.</p>'),
  emailTaken: (ctx) => notice(ctx, 'Email taken', '<p>Another site signed up with that address in the meantime. Nothing was changed.</p>'),
  emailChanged: (ctx, email) => notice(ctx, 'Email changed', `<p>Your email is now <b>${esc(email)}</b>.</p>`),
  loggedOutEverywhere: (ctx) => notice(ctx, 'Logged out everywhere', '<p>Every browser and device that was logged in to your site is logged out now. <a href="/login">Log in again.</a></p>'),
  accountDeleted: (ctx) => notice({ ...ctx, user: null }, 'Account deleted', '<p>Your site and files are gone. Thanks for stopping by.</p>'),
  reportSent: (ctx) => notice(ctx, 'Report sent', '<p>Thanks. A moderator will look at it.</p>'),
};

// Drag-and-drop and many-file uploads: sends the files 20 at a time with a progress bar, then reloads the folder with the totals.
// Without JavaScript the form above still posts normally (20 files at most).
const UPLOADER = (ctx) => `<script nonce="${esc(ctx.nonce || '')}">(function(){
var form=document.getElementById('upform'),drop=document.getElementById('drop'),input=document.getElementById('files'),bar=document.getElementById('upbar'),note=document.getElementById('upnote');
if(!form||!window.FormData||!window.XMLHttpRequest)return;
var max=Number(form.dataset.max),busy=false;
function post(batch,sent,total,cb){
  var fd=new FormData();fd.append('_csrf',form._csrf.value);fd.append('dir',form.dir.value);if(form.shrink.checked)fd.append('shrink','1');
  batch.forEach(function(f){fd.append('files',f,f.name)});
  var x=new XMLHttpRequest();x.open('POST',form.action);x.setRequestHeader('Accept','application/json');
  x.upload.onprogress=function(e){if(e.lengthComputable){bar.value=(sent+e.loaded*(batch.reduce(function(n,f){return n+f.size},0)/e.total))/total}};
  x.onload=function(){var r;try{r=JSON.parse(x.responseText)}catch(e){r={error:'Upload failed ('+x.status+').'}}cb(r)};
  x.onerror=function(){cb({error:'Upload failed. Check your connection and try again.'})};
  x.send(fd);
}
function send(list,pre){
  if(busy||!list.length)return;busy=true;
  var files=[],skipped=pre||[],saved=0;
  for(var i=0;i<list.length;i++){if(list[i].size>max)skipped.push(list[i].name+' (too big)');else files.push(list[i])}
  var total=files.reduce(function(n,f){return n+f.size},0)||1,sent=0,start=0;
  bar.hidden=false;bar.value=0;
  (function next(){
    if(start>=files.length){
      var q='?dir='+encodeURIComponent(form.dir.value)+(saved?'&ok='+encodeURIComponent('Uploaded '+saved+' file'+(saved===1?'':'s')+'.'):'');
      if(skipped.length)q+='&err='+encodeURIComponent('Skipped: '+skipped.slice(0,20).join(', ')+(skipped.length>20?' and '+(skipped.length-20)+' more':'')+'.');
      location.href='/dashboard'+q;return;
    }
    var batch=files.slice(start,start+20);start+=20;
    note.textContent='Uploading '+Math.min(start,files.length)+' of '+files.length+' files...';
    post(batch,sent,total,function(r){
      if(r.error){skipped=skipped.concat(batch.map(function(f){return f.name+' ('+r.error+')'}))}
      else{saved+=r.saved;skipped=skipped.concat(r.skipped)}
      sent+=batch.reduce(function(n,f){return n+f.size},0);bar.value=sent/total;next();
    });
  })();
}
form.addEventListener('submit',function(e){e.preventDefault();send(Array.prototype.slice.call(input.files))});
['dragenter','dragover'].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();drop.classList.add('over')})});
['dragleave','drop'].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();drop.classList.remove('over')})});
// folders can't be sent as files; name them as skipped instead of letting one sink its whole batch
drop.addEventListener('drop',function(e){
  var items=e.dataTransfer.items,list=[],folders=[];
  if(!items||!items[0]||!items[0].webkitGetAsEntry)return send(Array.prototype.slice.call(e.dataTransfer.files));
  for(var i=0;i<items.length;i++){if(items[i].kind!=='file')continue;var en=items[i].webkitGetAsEntry();
    if(en&&en.isDirectory)folders.push(en.name+' (a folder: zip it and use Import a zip)');else{var f=items[i].getAsFile();if(f)list.push(f)}}
  if(!list.length&&folders.length){note.textContent='Skipped: '+folders.join(', ')+'.';return}
  send(list,folders);
});
})();</script>`;

// the starter picker on the dashboard; the server asks before it replaces an index.html that is already there
const starterForm = (ctx, button) => `<form class="stack" method="post" action="/dashboard/starter">${csrfField(ctx)}
<fieldset class="starters"><legend>Pick a starter layout</legend>
${starters.LIST.map((s, i) => `<label><input type="radio" name="starter" value="${s.id}"${i === 0 ? ' checked' : ''}> <b>${esc(s.name)}</b>: ${esc(s.blurb)} <a href="/starters/${s.id}" target="_blank">Peek</a></label>`).join('\n')}
</fieldset><button>${button}</button></form>`;

const starterConfirm = (ctx, id) => {
  const s = starters.LIST.find((x) => x.id === id);
  return layout(ctx, 'Replace your front page?', `
<section class="box"><h2>Replace your front page?</h2>
<p>This swaps your current <code>index.html</code> for a fresh copy of the <b>${esc(s.name)}</b> starter. Your old front page is gone for good after that.
Other files are left alone.</p>
<p>Want to keep it? <a href="/dashboard/download">Download your site</a> first, or <a href="/dashboard/move?path=index.html">rename index.html</a> to something like <code>old-index.html</code>, then come back.</p>
<form class="stack" method="post" action="/dashboard/starter">${csrfField(ctx)}<input type="hidden" name="starter" value="${esc(s.id)}"><input type="hidden" name="confirm" value="1">
<button class="danger">Yes, replace index.html</button></form>
<p><a href="/dashboard">No, keep my page</a> | <a href="/starters/${esc(s.id)}" target="_blank">Peek at ${esc(s.name)}</a></p></section>`);
};

// ---- the dashboard's Custom domain fold (src/domains.js) ----
// one line saying where the claim stands: [tone, html]
function domainStatus(ctx, user, c, d) {
  const sub = esc(ctx.cfg.subdomainHost(user.username));
  if (!c) return ['note', 'Show this site at a domain you own. You keep the domain at your registrar; we only need two DNS records.'];
  const h = `<b>${esc(c.host)}</b>`;
  if (c.state === 'ended') {
    return ['note', {
      expired: `${h} was never verified, so we dropped the claim on ${ymd(c.ended_at)}. Add it again to get a new TXT record.`,
      lapsed: `${h} was removed on ${ymd(c.ended_at)} because support ended ${GRACE_DAYS} days before. Your site is at ${sub}.`,
      abandoned: `${h} was removed on ${ymd(c.ended_at)} after ${FAILING_DAYS} days of failing checks. Your site is at ${sub}.`,
      moved: `Another site proved it owns ${h} on ${ymd(c.ended_at)}. Your site is back at ${sub}.`,
      moderator: `A moderator removed ${h}: ${esc(c.last_error)}.`,
    }[c.end_reason]];
  }
  if (user.banned) return ['err', `This site was taken down, so ${h} shows the takedown notice too. It comes back if the takedown is lifted.`];
  if (c.state === 'pending') {
    const lapses = `This claim lapses on ${ymd(c.created_at + PENDING_DAYS * DAY)} if it isn't verified.`;
    if (c.txt_ok && !c.addrs_ok) return ['err', `Waiting for ${h}. The TXT record is in place, but ${esc(c.last_error)}, not at us. Fix the record below and check again. ${lapses}`];
    if (c.last_error && c.txt_ok) return ['err', `Waiting for ${h}: ${esc(c.last_error)}. ${lapses}`];
    return ['err', `Waiting for ${h}. We can't find the TXT record yet. DNS changes can take a few hours. We check every hour, or press Check now. ${lapses}`];
  }
  if (c.state === 'verified') return ['note', `${h} is yours and points at us. We're getting its HTTPS certificate now, which usually takes under a minute.${c.last_error ? ` The last try failed: ${esc(c.last_error)}. We try again every hour.` : ''}`];
  if (c.state === 'live' && c.misses) {
    const left = MISSES - c.misses;
    return ['err', `${h} is still live, but today's check failed: ${esc(c.last_error)}. Leave the records below in place. After ${left} more failed daily check${left === 1 ? '' : 's'}, visitors stop being sent there.`];
  }
  if (c.state === 'live') return ['ok', `${h} is live. Visitors to ${sub} are sent there.`];
  return ['err', `${h} stopped working on ${ymd(c.failing_since)}: ${esc(c.last_error)}. Your site is back at ${sub}. Put the records back and press Check now. If nothing changes, we let go of ${h} on ${ymd(c.failing_since + FAILING_DAYS * DAY)}, and another site could claim it before then.`];
}
function domainFold(ctx, user, d) {
  if (!d) return '';
  const c = d.claim && d.claim.state !== 'ended' ? d.claim : null;
  const line = ([tone, html]) => `<p class="${tone}" role="status">${html}</p>`;
  const base = esc(ctx.cfg.BASE_HOST);
  const grace = c && d.graceEnd ? line(['err', `Your support ended on ${ymd(d.graceEnd - GRACE_DAYS * DAY)}. ${esc(c.host)} keeps working until ${ymd(d.graceEnd)}, then your site goes back to its own address. <a href="/dashboard/support">Renew support</a> to keep it.`]) : '';
  if (!c && !d.supporter) {
    // an ended claim still says what happened to it
    return (d.claim ? line(domainStatus(ctx, user, d.claim, d)) : '') +
      (ctx.cfg.SUPPORT_ON ? `<p class="note">Supporters can show this site at a domain they own, like <code>www.example.com</code>. <a href="/dashboard/support">Become a supporter</a>.</p>` : '');
  }
  if (!c && user.banned) return (d.claim ? line(domainStatus(ctx, user, d.claim, d)) : '') + `<p class="note">A taken-down site can't add a domain.</p>`;
  if (!c) {
    return `<details${d.claim ? ' open' : ''}><summary>Use your own domain</summary>${line(domainStatus(ctx, user, d.claim, d))}
<form class="stack" method="post" action="/dashboard/domain">${csrfField(ctx)}<label for="cdhost">Your domain, like <code>example.com</code> or <code>www.example.com</code></label>
<div class="row"><input type="text" id="cdhost" name="host" required maxlength="253"><button>Add domain</button></div></form>
<p class="note">One name per site. To use both <code>example.com</code> and <code>www.example.com</code>, add one here and forward the other to it at your registrar.</p></details>`;
  }
  const chip = user.banned ? ['err', 'taken down'] : d.graceEnd ? ['err', `until ${ymd(d.graceEnd)}`]
    : { pending: ['note', 'waiting for DNS'], verified: ['note', 'getting HTTPS'], live: c.misses ? ['err', 'check failed'] : ['ok', 'live'], failing: ['err', 'failing'] }[c.state];
  const seen = c.checked_at > 0;
  const mark = (ok) => (ok ? '<b class="ok">yes</b>' : '<b class="err">no</b>');
  // only the TXT row gets a Found? mark: the A/AAAA and the CNAME are two ways to point, so one answer covers both
  const tick = (ok) => (!seen ? '' : `<td>${ok === undefined ? '' : mark(ok)}</td>`);
  const v4 = d.baseAddrs.filter((a) => !a.includes(':'));
  const v6 = d.baseAddrs.filter((a) => a.includes(':'));
  const orPlaceholder = (list, kind) => (list.length ? list : [`the ${kind} address of ${ctx.cfg.BASE_HOST}`]);
  const rows = [['TXT', `_puppypad.${c.host}`, `puppypad-verify=${c.proof}`, c.txt_ok],
    ...orPlaceholder(v4, 'IPv4').map((a) => ['A', c.host, a]), ...orPlaceholder(v6, 'IPv6').map((a) => ['AAAA', c.host, a]),
    ['CNAME', c.host, ctx.cfg.BASE_HOST]];
  const open = c.state === 'pending' || c.state === 'failing' || (c.state === 'live' && c.misses) ? ' open' : '';
  return `<p>Your domain: <code>${esc(c.host)}</code> <b class="${chip[0]}">[${esc(chip[1])}]</b></p>
<details${open}><summary>Custom domain settings</summary>${line(domainStatus(ctx, user, c, d))}${grace}
<div class="scroll"><table><tr><th>Type</th><th>Name</th><th>Value</th>${seen ? '<th>Found?</th>' : ''}</tr>
${rows.map(([t, n, v, ok]) => `<tr><td>${t}</td><td><code>${esc(n)}</code></td><td><code>${esc(v)}</code></td>${tick(ok)}</tr>`).join('')}</table></div>${seen ? `
<p>Points at us: ${mark(c.addrs_ok)}</p>` : ''}
<p class="note">The TXT record proves the domain is yours. Then point it at us one of two ways: the A and AAAA records, or one CNAME to <code>${base}</code> (a bare domain like <code>example.com</code> usually can't take a CNAME, but ALIAS, ANAME or CNAME flattening to <code>${base}</code> works). Some DNS hosts want the name without your domain on the end. Remove any other A or AAAA records on ${esc(c.host)}: every address must be ours. Leave the records in place for as long as you use the domain; we check them every day.</p>
<form class="inline" method="post" action="/dashboard/domain/check">${csrfField(ctx)}<button>Check now</button></form>
<details class="mt"><summary>Remove ${esc(c.host)}</summary><p>Your site goes back to its own address at once, and the domain is free for anyone to claim. Adding it again later needs a new TXT record.</p>
<form method="post" action="/dashboard/domain/remove">${csrfField(ctx)}<button class="danger">Remove ${esc(c.host)}</button></form></details></details>`;
}

function dashboard(ctx, m, d) {
  const { cfg, user } = ctx;
  const url = cfg.siteUrl(user.username);
  const up = d.dir ? d.dir.split('/').slice(0, -1).join('/') : null;
  const rows = [
    ...(up !== null ? [`<tr><td><a href="/dashboard?dir=${encodeURIComponent(up)}">[ up one folder ]</a></td><td></td><td></td></tr>`] : []),
    ...d.entries.map((e) => {
      const rel = d.dir ? `${d.dir}/${e.name}` : e.name;
      const mv = user.banned ? '' : `<a href="/dashboard/move?path=${encodeURIComponent(rel)}">rename/move</a>`;
      if (e.dir) return `<tr><td><a href="/dashboard?dir=${encodeURIComponent(rel)}">[${esc(e.name)}]</a></td><td class="num">folder</td><td>${mv}</td></tr>`;
      return `<tr><td><a href="${esc(url)}/${esc(rel)}" target="_blank">${esc(e.name)}</a></td><td class="num">${fmtBytes(e.size)}</td><td>
${TEXT_EXT.has(extOf(e.name)) ? `<a href="/dashboard/edit?path=${encodeURIComponent(rel)}">edit</a> | <a href="/dashboard/history/file?path=${encodeURIComponent(rel)}">history</a> | ` : ''}${mv ? `${mv} | ` : ''}
<form class="inline" method="post" action="/dashboard/delete">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}"><button class="link">delete</button></form></td></tr>`;
    }),
  ].join('');
  const meter = (k, v, of, part) => `<div class="meter"><div class="k">${k}</div><div class="v">${v}${of ? ` <small>${of}</small>` : ''}</div>${part === undefined ? '' : `<div class="bar"><i style="width:${Math.min(100, Math.round(part * 1000) / 10)}%"></i></div>`}</div>`;
  return layout(ctx, 'My pad', `
<section class="box"><h2>My pad: ${esc(user.username)}</h2>${msg(m)}
${d.sites.length > 1 ? `<p>Your sites: ${d.sites.map((x) => (x.id === user.id ? `<b>${esc(x.username)}</b>` : `<form class="inline" method="post" action="/dashboard/sites/switch">${csrfField(ctx)}<input type="hidden" name="id" value="${x.id}"><button class="link">${esc(x.username)}</button></form>`)).join(' | ')}</p>` : ''}
${user.banned ? `<p class="err">This site was taken down by a moderator${user.ban_reason ? `: ${esc(user.ban_reason)}` : '.'} Editing is disabled. Contact ${esc(cfg.ABUSE_EMAIL)} to appeal.</p>` : ''}
${d.cardCleared ? '<p class="err">An admin removed your card style. <a href="/dashboard/card">See why</a></p>' : ''}
${d.cardError ? `<p class="err">${CARD_FAILS}. <a href="/dashboard/card">Fix it.</a></p>` : ''}
<a class="addr" href="${esc(cfg.subdomainUrl(user.username))}" target="_blank">${esc(cfg.subdomainUrl(user.username))}</a>
${domainFold(ctx, user, d.domain)}
<div class="status">${meter('Space used', fmtBytes(d.used.total), `of ${d.quota} MB in ${d.used.count} file${d.used.count === 1 ? '' : 's'}`, d.used.total / (d.quota * 1048576))}
${meter('Bandwidth today', fmtBytes(d.bandwidth), `of ${cfg.BANDWIDTH_MB} MB`, d.bandwidth / (cfg.BANDWIDTH_MB * 1048576))}
${meter('Hits', user.hits)}</div>
<p class="links"><a href="/dashboard/stats">Visitor stats</a> <a href="/dashboard/guestbook">Guestbook entries</a> <a href="/dashboard/links">Check for broken links</a> <a href="/dashboard/history">Bring back deleted files</a> <a href="/dashboard/api">API key</a> <a href="/site/${esc(user.username)}">My profile</a>${d.support ? ' <a href="/dashboard/support">Support us</a>' : ''}</p>
${!d.hasIndex && !user.banned ? `<div id="noindex"><h3>Your site has no front page</h3>
<p class="err">There is no <code>index.html</code> at the top of your site, so visitors to ${esc(url)} get a "page not found". Rename one of your pages to <code>index.html</code>, or make a new front page from a starter:</p>
${starterForm(ctx, 'Make my front page')}</div>` : ''}
${d.listed || user.banned || user.hidden ? '' : `<p class="note">Your site is online, but it shows up in the dog park, on the home page and in the webring (if you join it) only after your first edit${cfg.NEW_SITE_HOURS > 0 ? ` and once it is ${cfg.NEW_SITE_HOURS} hours old` : ''}. Make it yours!</p>`}
${d.canAdd ? `<details><summary>Add another site to this login</summary><form class="stack" method="post" action="/dashboard/sites/new">${csrfField(ctx)}<label for="newsite">Site name (supporters, up to 5 sites)</label><div class="row"><input type="text" id="newsite" name="username" required maxlength="30"><button>Add site</button></div></form></details>` : ''}</section>

<div class="cols"><div>
<section class="box"><h2>Files in /${esc(d.dir)}</h2>
<form class="stack" method="get" action="/dashboard/edit"><label for="newpath">New file or folder, for example <code>about.html</code> or <code>pics/index.html</code>. Folders are created for you.</label>
<div class="row"><input type="text" id="newpath" name="path" value="${esc(d.dir ? d.dir + '/' : '')}" required><button>Create and edit</button></div></form>
<div class="scroll mt"><table><tr><th>Name</th><th>Size</th><th>Actions</th></tr>${rows || '<tr><td colspan="3">This folder is empty.</td></tr>'}</table></div>
<form class="stack mt" id="upform" method="post" action="/dashboard/upload" enctype="multipart/form-data" data-max="${d.fileMB * 1048576}">${csrfField(ctx)}<input type="hidden" name="dir" value="${esc(d.dir)}">
<div class="drop" id="drop"><label for="files"><b>Drop files here</b>, or pick them below. ${d.fileMB} MB each at most. Files with the same name are replaced.</label>
<input type="file" id="files" name="files" multiple required></div>
<label><input type="checkbox" id="shrink" name="shrink" value="1"> Shrink photos bigger than ${SHRINK_PX} pixels across and drop their hidden camera details (smaller files load faster and save space)</label>
<progress id="upbar" max="1" value="0" hidden></progress><p class="note" id="upnote" role="status"></p><button>Upload</button></form>
${UPLOADER(ctx)}
<details class="mt"><summary>Move in from another host, or back up</summary>
<form class="stack" method="post" action="/dashboard/import" enctype="multipart/form-data">${csrfField(ctx)}<input type="hidden" name="dir" value="${esc(d.dir)}">
<label for="zip">Zip up your site folder (up to ${cfg.ZIP_MAX_MB} MB) and it unpacks here, folders and all. Files with the same name are replaced.</label>
<input type="file" id="zip" name="zip" accept=".zip,application/zip" required><button>Import zip</button></form>
<p>Get every file as one <a href="/dashboard/download">.zip</a>, folders and all. Handy as a backup, or to move your site somewhere else.</p></details></section>
</div><div class="side">

<section class="box"><h2>In the dog park</h2>
<form class="stack" method="post" action="/dashboard/tagline">${csrfField(ctx)}<label for="tagline">One-line description</label>
<div class="row"><input type="text" id="tagline" name="tagline" maxlength="100" value="${esc(user.tagline)}"><button>Save</button></div></form>
<form class="stack mt" method="post" action="/dashboard/tags">${csrfField(ctx)}<label for="tags">Tags: up to 5, separated by spaces, like <code>pixel-art cats retro</code></label>
<div class="row"><input type="text" id="tags" name="tags" maxlength="130" value="${esc(user.tags)}"><button>Save</button></div></form>
<form class="stack mt" method="post" action="/dashboard/hidden">${csrfField(ctx)}<input type="hidden" name="hidden" value="${user.hidden ? '0' : '1'}">
<p class="note">${user.hidden ? 'Your site is hidden: it stays off the dog park, the home page, feeds and the webring, and asks search engines not to index it. Its address and profile still work.' : 'Want a quiet corner? Hide your site from browsing, feeds, the webring and search engines. Its address and profile keep working.'}</p>
<button>${user.hidden ? 'Show my site again' : 'Hide my site from browsing'}</button></form>
${user.banned ? '' : '<p class="mt"><a href="/dashboard/card">Card style</a>: dress up your card in the dog park with a little CSS.</p>'}</section>

<section class="box"><h2>Make it yours</h2><ul class="menu">
${user.banned ? '' : '<li><a href="/dashboard/style">Style editor</a><span>Colours, fonts and a background picture without writing CSS. It writes <code>puppypad.css</code> for you.</span></li>'}
<li><a href="/dashboard/widgets">Widgets</a><span>Hit counter, guestbook, status line, webring bar, buttons and more, with a snippet for each.</span></li></ul>
${d.hasIndex && !user.banned ? `<details><summary>Start over with a starter</summary>
<p>Want your front page back the way it started, or a different look? Pick a starter and it replaces your <code>index.html</code>. We ask before anything is overwritten, and your other files stay put.</p>
${starterForm(ctx, 'Use this starter')}</details>` : ''}
<p class="note mt">Custom 404 page: upload a file named <code>not_found.html</code>.</p></section>

<section class="box careful"><h2>Careful</h2>
${user.banned ? '' : `<details><summary>Rename my site</summary>
${user.renamed_at + cfg.RENAME_DAYS * 86400000 > Date.now()
    ? `<p>You renamed your site recently. You can rename it again on ${new Date(user.renamed_at + cfg.RENAME_DAYS * 86400000).toISOString().slice(0, 10)}.</p>`
    : `<p>Pick a new name and your site moves to its new address, files, followers, guestbook and all. The old address redirects to the new one for 90 days, and nobody else can take it meanwhile. You can rename once every ${cfg.RENAME_DAYS} days.</p>
<form class="stack" method="post" action="/dashboard/rename">${csrfField(ctx)}<label for="newname">New site name (3-30 lowercase letters, numbers or hyphens)</label>
<input type="text" id="newname" name="username" required maxlength="30">
<label for="renamepw">Confirm with your password</label><input type="password" id="renamepw" name="password" required autocomplete="current-password"><button>Rename my site</button></form>`}</details>`}
<details><summary>${user.login_id ? 'Delete this site' : 'Delete my account'}</summary>${user.login_id ? '<p>This removes this site, its files and guestbook for good. Your login and other sites stay.</p>' : '<p>This removes your site, files and guestbook for good.</p>'}
${d.domain ? d.domain.doomed.map((h) => `<p class="err">Your custom domain ${esc(h)} will stop working.</p>`).join('') : ''}
<form class="stack" method="post" action="/dashboard/delete-account">${csrfField(ctx)}<label for="delpw">Confirm with your password</label>
<input type="password" id="delpw" name="password" required autocomplete="current-password"><button class="danger">Delete everything</button></form></details></section>
</div></div>`);
}

const crumbs = (here) => `<p class="crumbs"><a href="/dashboard">My pad</a> &gt; ${here}</p>`;
const links = (ctx, broken) => layout(ctx, 'Broken links', two(`
<section class="box">${crumbs('Broken links')}<h2>Broken links ${broken.length ? `<small>(${broken.length})</small>` : ''}</h2>
${broken.length ? `<p>These links and images in your pages point at files your site doesn't have. Fix the path, or upload the missing file.</p>
<div class="scroll"><table><tr><th>Page</th><th>Points at</th></tr>${broken.slice(0, 500).map((b) => `<tr><td><a href="/dashboard/edit?path=${encodeURIComponent(b.file)}">${esc(b.file)}</a></td><td><code>${esc(b.link)}</code></td></tr>`).join('')}</table></div>
${broken.length > 500 ? `<p class="note">...and ${broken.length - 500} more.</p>` : ''}` : '<p class="ok" role="status">No broken links. Every link and image in your pages points at a file you have.</p>'}</section>`,
aside('About this check', `<p>Each HTML page on your site is read, and its link, image and stylesheet paths are checked against your files.</p>
<p class="note">Paths inside CSS files and links to other websites aren't checked. Click a page name to open it in the editor.</p>`)), { noindex: true });

const statTable = (head, rows, cell) => (rows.length ? `<div class="scroll"><table><tr><th>${head}</th><th>Views</th></tr>${rows.map((r) => `<tr><td>${cell(r)}</td><td class="num">${r.views}</td></tr>`).join('')}</table></div>` : '<p class="note">Nothing yet.</p>');
const stats = (ctx, { days, pages, referrers }) => {
  const url = ctx.cfg.siteUrl(ctx.user.username);
  return layout(ctx, 'Visitor stats', `
<section class="box">${crumbs('Visitor stats')}<h2>Visitor stats</h2>
<p>Page views on your site over the last 30 days. We count them without cookies and without keeping anyone's address, and leave out search engine robots.</p>
</section>
${two(`<section class="box"><h2>Views per day <small>(${days.reduce((n, r) => n + r.views, 0)} in all)</small></h2>${statTable('Day (UTC)', days, (r) => esc(r.day))}</section>`,
`<section class="box"><h2>Top pages</h2>${statTable('Page', pages, (r) => `<a href="${esc(url)}${esc(r.path)}" target="_blank">${esc(r.path)}</a>`)}</section>
<section class="box"><h2>Where visitors came from</h2>${statTable('Website', referrers, (r) => esc(r.host))}</section>`)}`, { noindex: true });
};

// CodeMirror comes from the codemirror npm package, served by us (see server.js); the version in the path lets browsers cache it for good
const CM = `/cm/${require('codemirror/package.json').version}`;
const CM_CSS = ['lib/codemirror.css', 'theme/material-darker.css', 'addon/dialog/dialog.css', 'addon/hint/show-hint.css'];
const CM_JS = ['lib/codemirror.js', 'mode/xml/xml.js', 'mode/javascript/javascript.js', 'mode/css/css.js', 'mode/htmlmixed/htmlmixed.js', 'mode/markdown/markdown.js',
  'addon/dialog/dialog.js', 'addon/search/searchcursor.js', 'addon/search/search.js', // find and replace
  'addon/fold/xml-fold.js', 'addon/edit/closetag.js', 'addon/hint/show-hint.js', 'addon/hint/xml-hint.js', 'addon/hint/html-hint.js']; // tag autocomplete
const CM_MODE = { html: 'htmlmixed', htm: 'htmlmixed', svg: 'xml', xml: 'xml', css: 'css', js: 'javascript', json: { name: 'javascript', json: true }, md: 'markdown' };
const editor = (ctx, m, { rel, content, isNew, images = [], insert = null }) => {
  const ext = extOf(rel);
  const isHtml = ext === 'html' || ext === 'htm';
  const dir = rel.split('/').slice(0, -1).join('/');
  const siteBase = `${ctx.cfg.siteUrl(ctx.user.username)}/${dir ? dir + '/' : ''}`;
  const head = CM_CSS.map((f) => `<link rel="stylesheet" href="${CM}/${f}">`).join('');
  return layout(ctx, `Edit ${rel}`, `
<section class="box"><div class="edbar"><h2>${isNew ? 'New file' : 'Editing'}: <code>${esc(rel)}</code></h2><span class="chip" id="dirty" role="status" hidden>Unsaved changes</span>
<div class="acts"><button form="edform">Save</button><a href="${esc(ctx.cfg.siteUrl(ctx.user.username))}/${esc(rel)}" target="_blank">View saved page</a>${isNew ? '' : `<a href="/dashboard/history/file?path=${encodeURIComponent(rel)}">Older versions</a>`}<a href="/dashboard?dir=${encodeURIComponent(dir)}">Back to files</a></div></div>${msg(m)}
<form id="edform" class="edform" method="post" action="/dashboard/save">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}">
<div class="edwrap"><div><label for="content">Code (Ctrl+S or Cmd+S saves)</label> <span class="note" id="findbar" hidden><button type="button" class="link" id="find">find</button> <button type="button" class="link" id="replace">replace</button></span><textarea class="code" id="content" name="content" spellcheck="false">${esc(content)}</textarea></div>
${isHtml ? '<div><label for="preview">Live preview (unsaved)</label><iframe class="preview" id="preview" title="Live preview" sandbox="allow-scripts"></iframe></div>' : ''}</div>
${isHtml && insert ? `<div class="note"><button type="button" id="insert">Insert the ${esc(insert.name)} at the cursor</button> Click where it should go in the code first, then save.</div>` : ''}
${isHtml && images.length ? `<div><label for="imgpick">Insert one of your images at the cursor</label> <select id="imgpick"><option value="">Pick an image...</option>${images.map((i) => `<option>${esc(i)}</option>`).join('')}</select></div>` : ''}
<div><button>Save</button></div></form></section>
${CM_JS.map((f) => `<script src="${CM}/${f}"></script>`).join('')}
<script>(function(){
var ta=document.getElementById('content'),form=document.getElementById('edform'),frame=document.getElementById('preview'),dirty=document.getElementById('dirty'),saved=ta.value;
var base=${JSON.stringify(`<base href="${siteBase}">`).replace(/</g, '\\u003c')};
var get=function(){return ta.value},cm=null;
// the preview runs in a sandboxed frame with no access to your login; <base> makes your images and stylesheets resolve
// every edit (typing, undo, image and widget inserts) ends in draw(), so it also sets the Unsaved tag against the saved text
function draw(){dirty.hidden=get()===saved;if(frame)frame.srcdoc=base+get()}
if(window.CodeMirror){
  cm=CodeMirror.fromTextArea(ta,{mode:${JSON.stringify(CM_MODE[ext] || 'text/plain')},theme:'material-darker',lineNumbers:true,lineWrapping:true,tabSize:2,indentUnit:2,
    autoCloseTags:true,extraKeys:{'Ctrl-S':function(){form.requestSubmit()},'Cmd-S':function(){form.requestSubmit()},'Ctrl-Space':'autocomplete'}});
  // typing < or </ offers tag names; the menu stays out of the way until one is picked
  if(cm.getOption('mode')==='htmlmixed'||cm.getOption('mode')==='xml')cm.on('inputRead',function(c,e){if(e.text[0]==='<'||e.text[0]==='/')c.showHint({completeSingle:false})});
  document.getElementById('findbar').hidden=false;
  ['find','replace'].forEach(function(k){document.getElementById(k).addEventListener('click',function(){cm.focus();cm.execCommand(k)})});
  get=function(){return cm.getValue()};var t;cm.on('change',function(){clearTimeout(t);t=setTimeout(draw,400)});
}else{var t2;ta.addEventListener('input',function(){clearTimeout(t2);t2=setTimeout(draw,400)})}
draw();
// the image picker writes an <img> with the picture's own width and height, so the page doesn't jump while it loads
var pick=document.getElementById('imgpick'),root=${JSON.stringify(ctx.cfg.siteUrl(ctx.user.username)).replace(/</g, '\\u003c')};
if(pick)pick.addEventListener('change',function(){
  var src='/'+pick.value,img=new Image();pick.value='';if(src==='/')return;
  // remember where the cursor was when the image was picked: typing while it loads must not move the insert
  var at=cm?cm.setBookmark(cm.getCursor()):null,s0=ta.selectionStart,s1=ta.selectionEnd;
  function put(w,h){var tag='<img src="'+src+'"'+(w?' width="'+w+'" height="'+h+'"':'')+' alt="">';
    if(cm){var pos=at.find()||cm.getCursor();at.clear();cm.replaceRange(tag,pos);cm.focus()}else{ta.setRangeText(tag,s0,s1,'end');ta.focus();draw()}}
  img.onload=function(){put(img.naturalWidth,img.naturalHeight)};img.onerror=function(){put()};img.src=root+src;
});
// a widget from the widgets page goes where the member puts the cursor, once they press the button
var ins=document.getElementById('insert'),snip=${JSON.stringify(insert ? insert.snippet : '').replace(/</g, '\\u003c')};
if(ins)ins.addEventListener('click',function(){
  if(cm){cm.replaceRange(snip,cm.getCursor());cm.focus()}else{ta.setRangeText(snip,ta.selectionStart,ta.selectionEnd,'end');ta.focus()}draw();
});
})();</script>`, { tight: true, head });
};

// card style: the source as typed; a rejected save comes back here with its text and the error.
// check: the saved card as /browse shows it (row, css), next to the Stock card, and why it is the Stock card when it is
// the dashboard's line, and the start of /dashboard/card's, for a saved style the current sanitizer rejects
const CARD_FAILS = 'Your card style no longer passes our checks, so your card shows the stock card';
const cardStyle = (ctx, m, source, note, check) => layout(ctx, 'Card style', `
<section class="box"><h2>Card style</h2>${note ? `<p class="err">An admin removed your card style: ${esc(note.reason)}</p>` : ''}${msg(m)}
<p>A little CSS that dresses up your card in the <a href="/browse">dog park</a>. Save it empty to go back to the stock card.</p>
${check.listed ? '' : '<p class="note">Your site isn\'t in the dog park right now, so nobody sees this card yet.</p>'}
<p><b>${check.why ? `Your card shows the stock card because: ${esc(check.why)}.` : 'Your card shows your style.'}</b></p>
${check.failing.length ? `<ul>${check.failing.map((f) => `<li><code>${esc(f.path)}</code>: ${esc(f.reason)}</li>`).join('')}</ul>` : ''}
<p class="note">Your saved card, then the stock card, as the dog park shows them.</p>
${cards(ctx, [check.row, { ...check.row, id: null }], true)}
<form class="stack mt" method="post" action="/dashboard/card">${csrfField(ctx)}<label for="css">Your card's CSS</label>
<textarea id="css" name="css" rows="14" spellcheck="false">${esc(source)}</textarea><button>Save</button></form>
<p class="note">Style only the Card parts: ${CARD_PARTS.map((p) => `<code>[data-part="${p}"]</code>`).join(' ')}. Every selector names a part; <code>:has()</code> and <code>:not()</code> only qualify one, and parts combine only with a space (descendant) or <code>&gt;</code> (child).</p>
<p class="note">Rules: up to ${CARD_MAX_BYTES / 1024} KB; at most ${CARD_MAX_ART} art files, each up to ${CARD_MAX_ART_BYTES / 1024} KB and only relative paths to your own PNG, JPEG, GIF, WebP or AVIF files (like <code>url(img/bone.png)</code>); no <code>position: fixed</code> or <code>sticky</code>; no <code>&lt;</code> outside strings (use <code>max-width</code> in <code>@media</code>); <code>@media</code> and <code>@keyframes</code> are fine.</p>
<p><a href="/dashboard">Back to my pad</a></p></section>`, { head: check.css ? `<style>${check.css}</style>` : '' });

const styleEditor = (ctx, m, { s, page, tail, offerLink, images }) => {
  const opts = (list, cur) => list.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const colour = (k, label) => `<label for="st-${k}">${label}</label><input type="color" id="st-${k}" name="${k}" value="${esc(s[k])}">`;
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  return layout(ctx, 'Style editor', `
<section class="box"><h2>Style editor</h2>${msg(m)}
<p>Pick colours, a font and borders. Saving writes <code>puppypad.css</code> at the top of your site; anything you write below its last line is kept.</p>
${offerLink ? `<form class="stack" method="post" action="/dashboard/style/link">${csrfField(ctx)}<p class="note">Your front page does not use <code>puppypad.css</code> yet. Add <code>${esc('<link rel="stylesheet" href="/puppypad.css">')}</code> after its <code>${esc('<style>')}</code>?</p><button>Add it to index.html</button></form>` : ''}
<p>Presets: ${Object.entries(style.PRESETS).map(([id, p]) => `<a href="/dashboard/style?preset=${id}">${esc(p.name)}</a>`).join(' | ')}</p>
<div class="edwrap"><div><form class="stack" id="stform" method="post" action="/dashboard/style">${csrfField(ctx)}
${colour('page', 'Page colour')}${colour('text', 'Text colour')}${colour('link', 'Link colour')}${colour('visited', 'Visited link colour')}
<label for="st-font">Font</label><select id="st-font" name="font">${opts(Object.keys(style.FONTS), s.font)}</select>
<label for="st-border">Box border style</label><select id="st-border" name="border">${opts(style.BORDERS, s.border)}</select>
<label for="st-width">Page width in pixels</label><input type="number" id="st-width" name="width" min="320" max="2000" step="10" value="${s.width}">
<label for="st-cursor">Cursor</label><select id="st-cursor" name="cursor">${opts(style.CURSORS, s.cursor)}</select>
<fieldset class="starters"><legend>Background picture</legend>
<label><input type="radio" name="bg" value=""${s.bg ? '' : ' checked'}> None, just the page colour</label>
${W.BACKGROUNDS.map((b) => `<label><input type="radio" name="bg" value="${b.id}"${s.bg === b.id ? ' checked' : ''}> <img src="/assets/bg/${b.id}.svg" width="40" height="40" alt="" style="vertical-align:middle;border:1px solid #888;background:${esc(s.page)}"> ${esc(b.name)}</label>`).join('\n')}
${images.length ? `<label><input type="radio" name="bg" value="own"${s.bg && s.bg[0] === '/' ? ' checked' : ''}> One of my own pictures:</label>
<select name="ownbg" aria-label="My pictures">${images.map((i) => `<option value="/${esc(i)}"${s.bg === `/${i}` ? ' selected' : ''}>${esc(i)}</option>`).join('')}</select>` : '<p class="note">Upload a picture to use one of your own.</p>'}</fieldset>
<fieldset class="starters"><legend>How the picture fills the page</legend>
${Object.entries(style.BG_MODES).map(([k, label]) => `<label><input type="radio" name="bgmode" value="${k}"${(s.bgmode || 'tile') === k ? ' checked' : ''}> ${label}</label>`).join('\n')}</fieldset>
<button>Save puppypad.css</button></form><p><a href="/dashboard">Back to my pad</a></p></div>
<div><label for="preview">Live preview of your front page (unsaved)</label><iframe class="preview" id="preview" title="Live preview" sandbox="allow-scripts"></iframe></div></div></section>
<script>(function(){
var form=document.getElementById('stform'),frame=document.getElementById('preview');
var page=${json(`<base href="${ctx.cfg.siteUrl(ctx.user.username)}/">`)}+${json(page)},fonts=${json(style.FONTS)},tail=${json(tail)},bgs=${json(style.bgUrls(ctx.cfg.BASE_URL))};
var block=${style.block.toString()};
// the preview runs in a sandboxed frame with no access to your login; the new block and your own CSS below it go last, as on the saved page.
// A CSS escape keeps a </style> in your CSS from closing the preview's <style> early; it still reads as </style>
function draw(){var s={};for(var i=0;i<form.elements.length;i++){var e=form.elements[i];if(e.name&&(e.type!=='radio'||e.checked))s[e.name]=e.value}
  if(s.bg==='own')s.bg=s.ownbg||'';
  frame.srcdoc=page+'<style>'+(block(s,fonts,bgs)+tail).replace(/<\\/(style)/gi,'<\\\\/$1')+'</style>'}
form.addEventListener('input',draw);draw();
})();</script>`);
};

// every widget with its snippet; "Add to a page" opens the editor, where the member inserts it at the cursor
const widgets = (ctx, m, { groups, pages }) => {
  const { user } = ctx;
  const add = (id) => (user.banned ? '' : `<form class="inline" method="get" action="/dashboard/edit"><input type="hidden" name="widget" value="${esc(id)}">
<label>Page <input type="text" name="path" value="index.html" list="pages" size="14" required></label> <button>Add to a page</button></form>`);
  const copy = (id) => (user.banned ? '' : `<form class="inline" method="post" action="/dashboard/widgets/copy">${csrfField(ctx)}<input type="hidden" name="fx" value="${esc(id)}"><button>Copy ${esc(id)}.js into my site</button></form> `);
  const extra = {
    status: user.banned ? '' : `<form class="stack" method="post" action="/dashboard/widgets/status">${csrfField(ctx)}<label for="status">My status (60 characters at most)</label>
<input type="text" id="status" name="status" maxlength="60" value="${esc(user.status)}"><button>Save status</button></form>`,
    webring: `<form class="stack" method="post" action="/dashboard/webring">${csrfField(ctx)}<input type="hidden" name="webring" value="${user.webring ? '0' : '1'}">
<p>${user.webring ? 'Your site is in the webring. Visitors clicking Prev, Next or Random on other sites can land on yours.' : 'Your site is not in the webring. Join it and visitors of other sites can land on yours; you can leave any time.'}</p>
<button>${user.webring ? 'Leave the webring' : 'Join the webring'}</button></form>`,
  };
  const item = (g, i) => `<div class="wcard"><b>${esc(i.name)}</b>${i.early ? ' <small>(supporters\' first look)</small>' : ''}
${i.preview ? `<p><img src="${esc(i.preview)}" alt=""${i.w ? ` width="${i.w}" height="${i.h}"` : ''}></p>` : ''}${i.see ? `<p><a href="${esc(i.see)}" target="_blank">See it</a></p>` : ''}
<pre>${esc(i.snippet)}</pre>${g.id === 'effects' ? copy(i.id) : ''}${add(i.id)}</div>`;
  return layout(ctx, 'Widgets', `
<section class="box">${crumbs('Widgets')}<h2>Widgets</h2>${msg(m)}<p>Each widget is a snippet of HTML. Copy it into a page yourself, or press "Add to a page": the editor opens and puts it where you click. Nothing changes on your pages until you save.</p>
<datalist id="pages">${pages.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></section>
${groups.map((g) => `<section class="box"><h2>${esc(g.title)}</h2><p>${g.about}</p>${extra[g.id] || ''}<div class="wgrid">${g.items.map((i) => item(g, i)).join('\n')}</div></section>`).join('\n')}
<section class="box"><h2>Backgrounds</h2><p>Pick a tiling background in the <a href="/dashboard/style">style editor</a>.</p></section>`);
};

// what supporting gets you; the support page and the supporter terms on /rules both list it
const perks = (c) => `<ul>
<li>${c.SUPPORTER_QUOTA_MB} MB of space instead of ${c.QUOTA_MB} MB, and files up to ${c.SUPPORTER_MAX_FILE_MB} MB instead of ${c.MAX_FILE_MB} MB.</li>
<li>Any type of file, not just the usual web ones. They are still checked for phishing and never run as anything but what they are.</li>
<li>File history kept for ${c.SUPPORTER_HISTORY_DAYS} days instead of ${c.HISTORY_DAYS}.</li>
<li>Up to 5 sites under one login.</li>
${c.CUSTOM_DOMAINS ? '<li>Your own domain for a site, like <code>www.example.com</code>, with HTTPS.</li>' : ''}
<li>A rainbow frame around your screenshot and a little star next to your name across ${esc(c.SITE_NAME)}.</li>
<li>A first look at new widgets before everyone gets them.</li></ul>`;
const support = (ctx, m, { until, customer, limits }) => {
  const c = ctx.cfg;
  const live = until > Date.now();
  const manage = customer ? `<form class="inline" method="post" action="/dashboard/support/portal">${csrfField(ctx)}<button>Manage billing, cancel or change card</button></form> <span class="note">on Stripe</span>` : '';
  const buy = (plan, label) => `<form method="post" action="/dashboard/support">${csrfField(ctx)}<input type="hidden" name="plan" value="${plan}"><button>${label}</button></form>`;
  const offers = [c.PRICE_ID ? buy('monthly', c.PRICE_ID_ANNUAL ? 'Become a supporter — monthly' : 'Become a supporter') : '',
    c.PRICE_ID_ANNUAL ? buy('annual', c.PRICE_ID ? 'Become a supporter — yearly' : 'Become a supporter') : ''].filter(Boolean).join('\n');
  return layout(ctx, 'Support', two(`
<section class="box">${crumbs('Support')}<h2>Support ${esc(c.SITE_NAME)}</h2>${msg(m)}
<p>${esc(c.SITE_NAME)} is free and stays free. Supporters chip in for the server and get a few extras that cost us something to give.</p>
${perks(c)}
${live ? '' : c.SUPPORT_ON ? `<div class="acts">${offers}</div>
<p class="note mt">Payment is handled by Stripe; your card never touches our server. See the <a href="/rules#supporter-terms">supporter terms</a>.</p>` : ''}</section>`,
aside('Your pad now', `${live ? `<p class="ok" role="status">You are a supporter until ${date(until)}. Thank you!</p>`
    : until ? `<p class="note">Your support ended ${date(until)}. Nothing was deleted: files over the free ${c.QUOTA_MB} MB stay online, and uploads wait until your site is back under it.</p>` : ''}
<div class="meter"><div class="k">Space</div><div class="v">${limits.quotaMB} MB</div></div>
<div class="meter mt"><div class="k">Biggest file</div><div class="v">${limits.fileMB} MB <small>${limits.anyType ? 'any file type' : 'usual web files'}</small></div></div>
${manage ? `<p class="mt">${manage}</p>` : ''}`)));
};

// the member's API key: made with their password, shown once, revoked any time
const apiPage = (ctx, m, { hasKey, key }) => {
  const base = ctx.cfg.BASE_URL;
  return layout(ctx, 'API key', two(`
<section class="box">${crumbs('API key')}<h2>API key</h2>${msg(m)}
<p>An API key lets a program change your site for you: a deploy script, a command-line tool, a GitHub Action. It can upload, delete and list files, and read your site's details, through the same checks as this dashboard. Keep it secret, like a password. Changing or resetting your password switches the key off.</p>
${key ? `<p class="ok" role="status">Your new key. Copy it now: we only keep a fingerprint of it, so it is never shown again.</p><pre>${esc(key)}</pre>` : ''}
<p>${hasKey ? 'You have an API key.' : 'You have no API key.'}</p>
${ctx.user.banned ? '' : `<form class="stack" method="post" action="/dashboard/api">${csrfField(ctx)}<input type="hidden" name="action" value="new">
<label for="apipw">Confirm with your password</label><input type="password" id="apipw" name="password" required autocomplete="current-password">
<button>${hasKey ? 'Make a new key (the old one stops working)' : 'Make an API key'}</button></form>`}
${hasKey ? `<form class="stack mt" method="post" action="/dashboard/api">${csrfField(ctx)}<input type="hidden" name="action" value="revoke"><button class="danger">Switch off my key</button></form>` : ''}</section>
<section class="box"><h2>How to use it</h2><p>Send the key in an <code>Authorization: Bearer</code> header. Every answer is JSON.</p>
<pre># your site's details: address, space used and left, file count
curl -H "Authorization: Bearer $KEY" ${esc(base)}/api/site

# every file with its size and when it last changed
curl -H "Authorization: Bearer $KEY" ${esc(base)}/api/files

# upload up to 20 files at a time; the filename sets the path, folders are made for you
curl -H "Authorization: Bearer $KEY" -F "files=@index.html" -F "files=@cat.png;filename=pics/cat.png" ${esc(base)}/api/upload

# delete one file
curl -H "Authorization: Bearer $KEY" -d "path=pics/cat.png" ${esc(base)}/api/delete</pre>
<p>Uploads follow the dashboard's rules: allowed file types only (any type for supporters), your file size limit (${ctx.cfg.MAX_FILE_MB} MB, more for supporters), your space limit, and files with the same name are replaced. At most 120 requests a minute.</p></section>`,
`<section class="box"><h2>Edit on your computer</h2><p>The <code>puppypad</code> command-line tool uploads a folder for you, sending only the files that changed. It needs <a href="https://nodejs.org/">Node.js</a>.</p>
<pre>npx @puppypad/cli login --url ${esc(base)}   # paste your key
npx @puppypad/cli push           # upload new and changed files from this folder
npx @puppypad/cli push --delete  # also delete files your folder doesn't have
npx @puppypad/cli pull           # download your whole site</pre>
<p>To publish from a GitHub repository on every push, save the key as a secret called <code>PUPPYPAD_API_KEY</code> and add <code>.github/workflows/deploy.yml</code>:</p>
<pre>on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeRusto/puppypad@main
        with:
          api_key: \${{ secrets.PUPPYPAD_API_KEY }}
          url: ${esc(base)}</pre>
<p><a href="https://github.com/DeRusto/puppypad/tree/main/cli#readme">More about the tool and the Action</a></p></section>`));
};

const move = (ctx, m, { from, to, dir }) => {
  const back = from.split('/').slice(0, -1).join('/');
  return layout(ctx, `Move ${from}`, two(`
<section class="box">${crumbs(`<a href="/dashboard?dir=${encodeURIComponent(back)}">Files</a> &gt; Move`)}<h2>Rename or move ${dir ? 'folder' : 'file'}: <code>${esc(from)}</code></h2>${msg(m)}
<form class="stack" method="post" action="/dashboard/move">${csrfField(ctx)}<input type="hidden" name="from" value="${esc(from)}">
<label for="to">New path, for example <code>${dir ? 'old/pics' : 'pages/about.html'}</code>. Missing folders are created for you.${dir ? ' Everything inside moves too.' : ''}</label>
<input type="text" id="to" name="to" value="${esc(to)}" required autocapitalize="none"><button>Move</button></form></section>`,
aside('Before you move it', `<p>Links to the old address stop working, so update any pages that point here.</p>
<p class="note">The <a href="/dashboard/links">broken links check</a> finds any you missed.</p>`)));
};

// file history: what is kept, every version of one file, and deleted files to bring back
const keptNote = (days) => `<p class="note">Every save of a page or other text file is kept for ${days} days, so you can look back and put an old version back. Pictures and other files are not kept.</p>`;
const date = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const restoreForm = (ctx, rel, sha, label) => `<form class="inline" method="post" action="/dashboard/history/restore">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}"><input type="hidden" name="v" value="${esc(sha)}"><button class="link">${label}</button></form>`;
const viewLink = (rel, sha) => `<a href="/dashboard/history/view?path=${encodeURIComponent(rel)}&amp;v=${esc(sha)}" target="_blank">view</a>`;
const history = (ctx, m, { rel, rows, page, pages, exists, days }) => {
  const dir = rel.split('/').slice(0, -1).join('/');
  return layout(ctx, `History of ${rel}`, two(`
<section class="box">${crumbs(`<a href="/dashboard?dir=${encodeURIComponent(dir)}">Files</a> &gt; History`)}<h2>History: <code>${esc(rel)}</code></h2>${msg(m)}
<div class="scroll"><table><tr><th>Saved</th><th></th></tr>
${rows.map((r, i) => `<tr><td>${date(r.t)} <small>(${ago(r.t)})</small></td><td>${viewLink(rel, r.sha)}${exists && page === 1 && i === 0 ? ' | current version' : ctx.user.banned ? '' : ` | ${restoreForm(ctx, rel, r.sha, 'put this version back')}`}</td></tr>`).join('') || '<tr><td colspan="2">No versions kept yet.</td></tr>'}
</table></div>${pager((n) => `/dashboard/history/file?path=${encodeURIComponent(rel)}&page=${n}`, page, pages)}</section>`,
aside('About history', `${keptNote(days)}<ul class="menu">${exists ? `<li><a href="/dashboard/edit?path=${encodeURIComponent(rel)}">Edit ${esc(rel)}</a></li>` : ''}<li><a href="/dashboard/history">Deleted files</a><span>Bring back files you deleted</span></li></ul>`)));
};
const historyDeleted = (ctx, m, { rows, page, pages, days }) => layout(ctx, 'Deleted files', two(`
<section class="box">${crumbs('Deleted files')}<h2>Deleted files</h2>${msg(m)}
<div class="scroll"><table><tr><th>File</th><th>Deleted</th><th></th></tr>
${rows.map((r) => `<tr><td>${esc(r.rel)}</td><td>${date(r.t)} <small>(${ago(r.t)})</small></td><td>${viewLink(r.rel, r.sha)} | <a href="/dashboard/history/file?path=${encodeURIComponent(r.rel)}">history</a>${ctx.user.banned ? '' : ` | ${restoreForm(ctx, r.rel, r.sha, 'bring back')}`}</td></tr>`).join('') || '<tr><td colspan="3">Nothing deleted lately.</td></tr>'}
</table></div>${pager((n) => `/dashboard/history?page=${n}`, page, pages)}</section>`,
aside('About history', `${keptNote(days)}<p class="note">"Bring back" puts the file back at its old path.</p>`)));

const guestbookAdmin = (ctx, m, { rows, page, pages }, blocked = []) => layout(ctx, 'Guestbook entries', two(`
<section class="box">${crumbs('Guestbook entries')}<h2>Guestbook entries</h2>${msg(m)}
<div class="scroll"><table><tr><th>When</th><th>Name</th><th>Message</th><th></th></tr>
${rows.map((r) => `<tr><td>${ago(r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.message)}</td><td>${r.approved ? '' : `<form class="inline" method="post" action="/dashboard/guestbook/approve">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="page" value="${page}"><button class="link">approve (held: has a link)</button></form> `}<form class="inline" method="post" action="/dashboard/guestbook/delete">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="page" value="${page}"><button class="link">delete</button></form>${r.ip && !blocked.includes(r.ip) ? ` <form class="inline" method="post" action="/dashboard/guestbook/block-ip">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="page" value="${page}"><button class="link">block IP</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">Nobody has signed yet.</td></tr>'}
</table></div>${pager((n) => `/dashboard/guestbook?page=${n}`, page, pages)}</section>`,
`<section class="box"><h2>Email me about new entries</h2>
<form class="stack" method="post" action="/dashboard/guestbook/notify">${csrfField(ctx)}<label for="gn">Sent to ${esc(ctx.login.email)}. Entries waiting for your approval are marked.</label>
<select id="gn" name="notify">${[['instant', 'Right away, one email per entry'], ['daily', 'Once a day, a digest'], ['off', 'Never']].map(([v, l]) => `<option value="${v}"${ctx.user.gb_notify === v ? ' selected' : ''}>${l}</option>`).join('')}</select><button>Save</button></form>
</section>
<section class="box"><h2>Moderation</h2><p class="note">Entries with links wait here until you approve them. Entries with a blocked word are refused (one per line). Posts from a blocked IP are silently dropped; visitor IPs are only kept for 90 days.</p>
<p>Blocked IPs: ${blocked.map((ip) => `${esc(ip)} <form class="inline" method="post" action="/dashboard/guestbook/unblock-ip">${csrfField(ctx)}<input type="hidden" name="ip" value="${esc(ip)}"><button class="link">unblock</button></form>`).join(', ') || 'none'}</p>
<form class="stack" method="post" action="/dashboard/guestbook/settings">${csrfField(ctx)}
<label for="gw">Blocked words</label><textarea id="gw" name="words" rows="4">${esc(ctx.user.gb_words)}</textarea>
<button>Save</button></form></section>`));

const report = (ctx, m, v = {}) => layout(ctx, 'Report a site', two(`
<section class="box"><h2>Report a site</h2>${msg(m)}
<form class="stack" method="post" action="/report">
<label for="site">Site name (the part before .${esc(ctx.cfg.BASE_HOST)})</label><input type="text" id="site" name="site" value="${esc(v.site)}" required>
<label for="reason">Reason</label><select id="reason" name="reason">${['Illegal content', 'Harassment or doxxing', 'Malware or phishing', 'Spam', 'Copyright', 'Other'].map((r) => `<option>${r}</option>`).join('')}</select>
<label for="details">What is wrong, and where on the site?</label><textarea id="details" name="details" rows="5" maxlength="2000" required></textarea>
<label for="remail">Your email (optional, if you want a reply)</label><input type="email" id="remail" name="email">
<div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
<button>Send report</button></form></section>`,
aside('What happens next', `<p>A moderator reads every report. Sites that break the <a href="/rules">house rules</a> are taken down.</p>
<p class="note">Copyright complaints need a few more details: see "Copyright complaints" in the <a href="/rules">rules</a>. You can also write to ${esc(ctx.cfg.ABUSE_EMAIL)}.</p>`)));

const rules = (ctx) => {
  const c = ctx.cfg, name = esc(c.SITE_NAME), mail = esc(c.ABUSE_EMAIL);
  return layout(ctx, 'Rules', `
<section class="box"><h2>Rules and terms</h2>
<p>${c.OPERATOR ? `${name} is run by ${esc(c.OPERATOR)}. ` : ''}By signing up for or using ${name} you agree to these terms.
If you don't agree, please don't use it. "We" and "us" below means the people who run ${name}.</p>

<h3>A hobby host, run on a best-effort basis</h3>
<p>${name} is a free host for static homepages. It is run by a small team that does its best to keep it up, but we
can't promise any level of uptime or service.</p>
<p>You are responsible for keeping your own copy of your site. We take backups, but if a server fails badly your
files may not be recoverable.</p>

<h3>Who can sign up</h3>
<p>You must be a person, not a bot, and at least 13 years old, or older if the age of digital consent where you live
is higher than 13. If we learn an account holder doesn't meet this, we may suspend or delete the account.</p>

<h3>Your content is yours, and your responsibility</h3>
<p>You keep the rights to what you upload. You are responsible for everything you publish here, and you confirm
that you have the right to publish it and that it breaks no law. We don't pre-screen sites, but we do look at
reports and at sites our automatic checks flag.</p>
<p>To show your site in the dog park and on your profile, we take a screenshot of your front page.
Deleting your account removes it.</p>

<h3>House rules</h3>
<p>Accidents are welcome. These are not, and breaking them gets your pad rolled up:</p>
<ol>
<li>Nothing illegal where you live or in the United States.</li>
<li>No content that sexualizes minors, ever, drawn or not.</li>
<li>No adult or pornographic content, and no real gore or shock content.</li>
<li>No malware, phishing, scams, crypto miners, or pages built to collect people's information under false pretenses.</li>
<li>No pretending to be another person, company or website.</li>
<li>No harassment, threats or bullying. No sites made to "expose", dox or pile on another person.</li>
<li>No spam, link farms, or sites that exist only for search engine tricks.</li>
<li>No pirated or cracked software, and no "unblocked games" or other copies of things you don't own.</li>
<li>No file dumps. Your ${c.QUOTA_MB} MB is for the files your website uses.</li>
<li>No attacks on ${name} or other members: no break-in attempts, no flooding, nothing meant to knock the site over.</li>
<li>One account per person, with one site (supporters can add up to 5 under the same login). Don't create accounts in bulk or to hold names.</li>
</ol>

<h3>When we remove a site</h3>
<p>Moderators can take down or delete any site that breaks these rules. We may also contact you, and act if you
don't respond, when a site's traffic is causing problems for everyone else, or remove sites that have been
empty and untouched for a year so names aren't held forever. Removed names stay reserved for 90 days.</p>
<p>To appeal a decision, write to ${mail}. You can delete your own account at any time from your dashboard.</p>

<h3>Reporting a site</h3>
<p>Use the <a href="/report">report form</a> or write to ${mail} with the site's address and what's wrong.</p>

<h3>Copyright complaints</h3>
<p>If something on ${name} uses your work without permission, send a notice to ${c.DMCA_AGENT ? esc(c.DMCA_AGENT) : mail} with:</p>
<ul>
<li>what work you own, and the exact address of the page or file that copies it;</li>
<li>your name, postal address, phone number and email;</li>
<li>a statement that you believe in good faith the use isn't authorized by you, your agent or the law;</li>
<li>a statement, under penalty of perjury, that your notice is accurate and that you own the work or may act for its owner;</li>
<li>your physical or electronic signature.</li>
</ul>
<p>We remove material that a valid notice covers, tell the member who posted it, and close the accounts of
repeat infringers. We may pass your notice, including your email address, to that member so they can respond.</p>
<h3>No warranty, limited liability</h3>
<p>${name} is provided as is, without any warranty. As far as the law allows, we are not liable for any loss or
damage from using or being unable to use it, including lost files, downtime, or anything another member
publishes. Member sites are made by members, not by us, and some may contain things you find offensive.
You visit them at your own risk.</p>
${c.SUPPORT_ON ? `
<h3 id="supporter-terms">Supporter terms</h3>
<p>Supporting is optional; everything free stays free. A supporter subscription renews each period at the price shown at checkout until you cancel, and includes:</p>
${perks(c)}
<p>Payments are taken by Stripe. Cancel any time from the support page on your dashboard; the extras last until the end of the period you paid for, and nothing more is charged. We don't refund part-used periods, but if something went wrong with a charge, write to ${mail} and we will sort it out.</p>
<p>When support ends nothing is deleted. Files over the free ${c.QUOTA_MB} MB stay online, but new uploads wait until the site is back under the free limits; extra sites stay, and new ones can't be added. Supporting doesn't change the house rules: a site that breaks them is removed like any other.</p>` : ''}
${c.GOVERNING_LAW ? `
<h3>Governing law</h3>
<p>These terms are governed by the laws of ${esc(c.GOVERNING_LAW)}.</p>` : ''}
<h3>Changes</h3>
<p>We may update these terms. The current version is always on this page, and using ${name} after a change means
you accept it.</p>

<h3>Contact</h3>
<p>Questions about these terms or the <a href="/privacy">privacy notice</a>: ${mail}.</p></section>`, { description: `The rules and terms for ${ctx.cfg.SITE_NAME}, a free homepage host: what you can publish, what we remove, and how copyright complaints work.`, path: '/rules' });
};

const privacy = (ctx) => layout(ctx, 'Privacy', `
<section class="box"><h2>Privacy notice</h2>
<p>${esc(ctx.cfg.SITE_NAME)} keeps as little about you as it can run on.</p>
<h3>What we store</h3>
<ul>
<li><b>Your account:</b> site name, email address, and a scrambled (hashed) copy of your password. We use your email only for confirmation, password resets and messages about your site.</li>
<li><b>Your site:</b> the files you upload, your description, your hit count, who you follow or block, and a screenshot of your front page for the directory.</li>
<li><b>Network addresses:</b> the IP address you signed up from, and the IP address behind each guestbook entry and abuse report. These help us stop spam and abuse. Guestbook and report addresses are erased after 90 days; your signup address is kept until you delete your account.</li>
<li><b>Visitor counts:</b> each site counts its page views per day and the names of the websites visitors came from, without cookies or IP addresses. Only the site's owner sees them, and they are deleted after 30 days.</li>
<li><b>One cookie</b> that keeps you logged in. No tracking or advertising cookies.</li>
</ul>
<h3>Who else sees it</h3>
<p>Your site, its files, your site name, description, followers and hit count are public. Guestbook entries are public on the site they were left on, and comments and likes you leave are public too. We do not sell or share your data. Our email provider delivers our messages${ctx.cfg.TURNSTILE_SITE_KEY ? ', and Cloudflare Turnstile checks that people signing up are human' : ''}.${ctx.cfg.SUPPORT_ON ? ' Supporter payments are processed by Stripe, which receives your email address and payment details; we keep only your Stripe customer number and how long your support lasts, never your card.' : ''}</p>
<h3>Deleting it</h3>
<p>Delete your account from your dashboard and your files, guestbook and account details are removed right away. Backups roll over within 14 days. Your site name stays reserved for 90 days so nobody else can pretend to be you.</p>
<p>Questions: ${esc(ctx.cfg.ABUSE_EMAIL)}.</p>
<p class="note">Review this page before you launch and make it match what you actually run. It is a starting point, not legal advice.</p></section>`, { description: `What ${ctx.cfg.SITE_NAME} stores about you, who else sees it, and how to delete it. One login cookie, no tracking or advertising cookies.`, path: '/privacy' });

// polls /admin in the background and navigates only once it shows the run finished, so the app restarting
// mid-upgrade never strands the page on a browser error; data-follow marks a page that is still busy
const follow = (ctx) => `<script data-follow nonce="${esc(ctx.nonce || '')}">(function f(){setTimeout(function(){fetch('/admin').then(function(r){return r.ok?r.text():'<script data-follow';}).then(function(t){if(t.indexOf('<script data-follow')<0)location.replace('/admin');else f();},f);},5000);})();</script>`;
const upgradeBox = (ctx, u) => {
  if (!u) return '';
  const when = (t) => (t ? ago(t) : 'never');
  const busy = !!u.request || u.status === 'queued' || u.status === 'running';
  const btn = (action, label, cls = '') => `<form class="inline" method="post" action="/admin/upgrade">${csrfField(ctx)}<input type="hidden" name="action" value="${action}">${action === 'upgrade' ? `<input type="hidden" name="target" value="${esc(u.latest)}">` : ''}<button${cls ? ` class="${cls}"` : ''}>${label}</button></form>`;
  if (!u.watcher) {
    return `<h3>Server version</h3><p>The upgrade watcher is not running on the server${u.seenAt ? ` (last seen ${ago(u.seenAt)})` : ''}. scripts/install.sh adds it to cron; see "Upgrades" in the README.</p>`;
  }
  const status = busy ? `<p><strong>${u.status === 'running' ? 'Upgrading now.' : 'Waiting for the server to pick this up.'}</strong> This page refreshes itself until it finishes.</p>${follow(ctx)}`
    : u.status === 'failed' ? `<p class="err">The last upgrade failed ${when(u.finishedAt)}: ${esc(u.message)}</p>`
    : u.status === 'ok' ? `<p class="ok">Last upgrade finished ${when(u.finishedAt)}.</p>` : '';
  const release = u.url ? `<a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.latest)}</a>` : esc(u.latest);
  return `<h3>Server version</h3>
<p>Running <code>${esc(u.current || 'unknown')}</code>. Last checked ${when(u.checkedAt)}.</p>${status}
${u.behind ? `<p>Release ${release} is out${u.publishedAt ? ` (published ${ago(u.publishedAt)})` : ''}.</p>${u.notes ? `<pre class="scroll">${esc(u.notes)}</pre>` : ''}` : u.latest ? '<p>Up to date.</p>' : '<p>No release found yet.</p>'}
<div>${busy ? '' : btn('check', 'Check now') + (u.behind ? ` ${btn('upgrade', `Back up and upgrade to ${esc(u.latest)}`, 'danger')}` : '')}</div>
${u.log ? `<details><summary>Output of the last run</summary><pre class="scroll">${esc(u.log)}</pre></details>` : ''}`;
};

// moderation first: counts, then reports and members on the left, and the tools on the right.
// "act" on a report or member row reloads with ?site= so every tool below already holds that name.
const admin = (ctx, m, { q, site, reports, users, signups, stats, log, upgrade, sotw, picks, domains }) => {
  const act = (name) => `<a href="/admin?site=${encodeURIComponent(name)}${q ? `&amp;q=${encodeURIComponent(q)}` : ''}#act">act</a>`;
  const siteField = (id) => `<label for="${id}">Site name</label><input type="text" id="${id}" name="site" value="${esc(site)}" required>`;
  const count = (k, v) => `<div class="meter"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  return layout(ctx, 'Admin', `
<section class="box"><h2>Admin</h2>${msg(m)}
<div class="status four">${count('Members', stats.users)}${count('Banned', stats.banned)}${count('Supporters', stats.supporters)}${count('Open reports', stats.open)}</div></section>
${domains ? `<section class="box"><h2>Custom domains</h2><div class="status">${count('Pending', domains.counts.pending || 0)}${count('Live', domains.counts.live || 0)}${count('Failing', domains.counts.failing || 0)}</div>
${domains.failing.length ? `<h3>Failing domains</h3><div class="scroll"><table><tr><th>Domain</th><th>Site</th><th>Last error</th><th>Since</th></tr>${domains.failing.map((f) => `<tr><td>${esc(f.host)}</td><td>${esc(f.username)}</td><td>${esc(f.last_error)}</td><td>${ago(f.failing_since)}</td></tr>`).join('')}</table></div>` : ''}</section>` : ''}

<div class="cols"><div>
<section class="box"><h2>Open reports <small>(${stats.open})</small></h2>
<div class="scroll"><table><tr><th>When</th><th>Site</th><th>Reason</th><th>Details</th><th>From</th><th>Actions</th></tr>
${reports.rows.map((r) => `<tr><td>${ago(r.created_at)}</td><td><a href="${esc(ctx.cfg.siteUrl(r.site))}" target="_blank">${esc(r.site)}</a></td><td>${esc(r.reason)}</td><td>${esc(r.details)}</td><td>${esc(r.reporter_email || '')}<br><small>${esc(r.ip)}</small></td>
<td><div class="acts">${act(r.site)}<form class="inline" method="post" action="/admin/report-close">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="rpage" value="${reports.page}"><button class="link">close</button></form></div></td></tr>`).join('') || '<tr><td colspan="6">Queue is empty.</td></tr>'}</table></div>${pager((n) => `/admin?${q ? `q=${encodeURIComponent(q)}&` : ''}rpage=${n}`, reports.page, reports.pages)}</section>

<section class="box"><h2>${q ? `Members matching “${esc(q)}”` : 'Newest members'}</h2>
<form class="stack" method="get" action="/admin"><label for="q">Find a member by name, email or signup IP</label><div class="row"><input type="search" id="q" name="q" value="${esc(q)}"><button>Search</button></div>${q ? '<p class="note"><a href="/admin">Clear the search</a></p>' : ''}</form>
<div class="scroll mt"><table><tr><th>Site</th><th>Email</th><th>Joined</th><th>State</th><th>Signup IP</th><th>Disk</th><th>Bandwidth today</th><th></th></tr>
${users.map((u) => `<tr><td><a href="${esc(ctx.cfg.siteUrl(u.username))}" target="_blank">${esc(u.username)}</a></td><td>${esc(u.email)}</td><td>${ago(u.created_at)}</td><td>${u.banned ? 'banned' : u.verified ? 'live' : 'unverified'}${u.domain && u.domain.state !== 'ended' ? `<br><small>${esc(u.domain.host)} (${u.domain.state})</small>` : ''}${u.until > Date.now() ? `<br><small>supporter to ${date(u.until).slice(0, 10)}${u.stripe_customer_id ? ' (Stripe)' : ''}</small>` : ''}</td><td>${esc(u.signup_ip)}</td><td class="num">${fmtBytes(u.disk)}</td><td class="num">${fmtBytes(u.bandwidth)}</td><td>${act(u.username)}</td></tr>`).join('') || '<tr><td colspan="8">No members found.</td></tr>'}</table></div></section>

<section class="box"><h2>Moderation log <small>(last 100)</small></h2><div class="scroll"><table><tr><th>When</th><th>Moderator</th><th>Action</th><th>Site</th><th>Details</th></tr>
${log.map((l) => `<tr><td>${ago(l.created_at)}</td><td>${esc(l.admin)}</td><td>${esc(l.action)}</td><td>${esc(l.site)}</td><td>${esc(l.detail)}</td></tr>`).join('') || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table></div></section>
</div><div class="side">

<section class="box" id="act"><h2>Act on a site</h2>
${site ? `<p>Acting on <b>${esc(site)}</b>: <a href="${esc(ctx.cfg.siteUrl(site))}" target="_blank">site</a> | <a href="/site/${esc(site)}">profile</a> | <a href="/admin?q=${encodeURIComponent(site)}">find member</a></p>` : '<p class="note">Type a site name, or press "act" on a report or member to fill it in.</p>'}
<form class="stack" method="post" action="/admin/ban">${csrfField(ctx)}${siteField('bsite')}
<label for="breason">Reason shown to the member</label><input type="text" id="breason" name="reason" maxlength="200">
<div class="acts"><button name="action" value="ban" class="danger">Take down</button><button name="action" value="unban">Restore</button>${domains ? '<button name="action" value="detach">Detach domain</button>' : ''}</div>
<details><summary>Delete for good</summary><p class="note">Removes the account and every file. This cannot be undone.</p><button name="action" value="delete" class="danger">Delete account and files</button></details></form>
<details class="mt"><summary>Supporter</summary>
<form class="stack" method="post" action="/admin/supporter">${csrfField(ctx)}${siteField('ssite')}
<label for="sdays">Days from now (0 removes supporter)</label><input type="number" id="sdays" name="days" min="0" max="3650" value="365" required><button>Set supporter</button></form></details>
<details><summary>Card style</summary>
<form class="stack" method="post" action="/admin/card-clear">${csrfField(ctx)}${siteField('csite')}
<label for="creason">Reason shown to the member</label><input type="text" id="creason" name="reason" maxlength="200" required><button>Clear card style</button></form></details>
<details><summary>Staff picks and site of the week</summary>
<p>Site of the week: ${sotw ? `<a href="/site/${esc(sotw.username)}">${esc(sotw.username)}</a>` : 'none'}. Staff picks: ${picks.map((p) => `<a href="/site/${esc(p.username)}">${esc(p.username)}</a>`).join(', ') || 'none'}.
The home page shows them while they are listed (not hidden, and past the new-site wait).</p>
<form class="stack" method="post" action="/admin/feature">${csrfField(ctx)}<label for="fsite">Site name</label><input type="text" id="fsite" name="site" value="${esc(site)}">
<div class="acts"><button name="action" value="sotw">Make site of the week</button><button name="action" value="pick">Add to staff picks</button><button name="action" value="unpick">Remove from staff picks</button><button name="action" value="unsotw">Clear site of the week</button></div></form></details></section>

<section class="box"><h2>Signups per day</h2><div class="scroll"><table><tr><th>Day (UTC)</th><th>Signups</th></tr>
${signups.map((d) => `<tr><td>${d.day}</td><td class="num">${d.n}</td></tr>`).join('') || '<tr><td colspan="2">None in the last 14 days.</td></tr>'}</table></div></section>
${upgrade ? `<section class="box">${upgradeBox(ctx, upgrade)}</section>` : ''}
</div></div>`);
};

// ---- pages served on member subdomains ----
const bare = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;padding:12px;background:#fdfeff repeating-linear-gradient(45deg,transparent 0 21px,#d6eafa 21px 22px);color:#14264f;font:15px/1.4 "Comic Sans MS","Comic Neue",cursive}a{color:#0a3fc4}h1{font:700 22px "Comic Sans MS","Comic Neue",cursive;color:#0b4f9e;margin:0 0 8px}
form{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}label{color:#0b4f9e;font-size:14px}input,textarea{font:15px "Courier New",monospace;background:#fff;color:#000;border:2px inset #2f8fd0;padding:4px;width:100%;box-sizing:border-box}
button{font:700 14px "Comic Sans MS",cursive;background:#ffe14d;color:#14264f;border:3px outset #fff3a8;padding:3px 12px;align-self:flex-start;cursor:pointer}
.e{border:2px dashed #2f8fd0;background:#fff;padding:6px 8px;margin-bottom:8px;overflow-wrap:anywhere}.e small{color:#0b4f9e}.hp{position:absolute;left:-9999px}.err{color:#b00000}</style></head><body>${body}</body></html>`;

const sitePage = (cfg, title, html) => bare(title, `<h1>${esc(title)}</h1>${html}<p><a href="${esc(cfg.BASE_URL)}">${esc(cfg.SITE_NAME)}</a></p>`);
const reportLink = (cfg, name) => `<p><small><a href="${cfg.BASE_URL}/report?site=${encodeURIComponent(name)}">Report this site</a></small></p>`;
// what a member subdomain shows when there is no page to serve
const sitePages = {
  empty: (cfg, name) => sitePage(cfg, 'This pad is empty', `<p>The name <b>${esc(name)}</b> is not a site on ${esc(cfg.SITE_NAME)}. <a href="${cfg.BASE_URL}/signup">Roll out a pad of your own.</a></p>`),
  banned: (cfg, name) => sitePage(cfg, 'This pad got rolled up', `<p>A moderator removed this site for breaking the house rules.</p>${reportLink(cfg, name)}`),
  resting: (cfg) => sitePage(cfg, 'This pad is resting', '<p>This site used up its bandwidth for today. It comes back at midnight UTC.</p>'),
  missing: (cfg, name) => sitePage(cfg, '404 - Page not found', `<p>That page does not exist on this site. <a href="/">Go to the front page.</a></p>${reportLink(cfg, name)}`),
};

// theme is one of W.GB_THEMES; its CSS goes after the base look
const guestbook = ({ rows, page, pages }, err, theme = 'classic') => bare('Guestbook', `${W.GB_THEMES[theme].css ? `<style>${W.GB_THEMES[theme].css}</style>` : ''}<h1>Sign the guestbook</h1>${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
<form method="post" action="/_hw/guestbook${theme === 'classic' ? '' : `?theme=${theme}`}"><label for="n">Name</label><input id="n" name="name" maxlength="40" required>
<label for="m">Message</label><textarea id="m" name="message" rows="3" maxlength="500" required></textarea>
<div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div><button>Sign it!</button></form>
${rows.map((r) => `<div class="e"><small>${esc(r.name)} wrote ${ago(r.created_at)}:</small><div>${esc(r.message)}</div></div>`).join('') || '<p>No entries yet. Be the first!</p>'}
${pager((n) => `/_hw/guestbook?${theme === 'classic' ? '' : `theme=${theme}&`}page=${n}`, page, pages)}`);

// one entry per feed event; the five characters esc() replaces are the ones XML needs escaped too
const atom = (cfg, { title, path, link, events }) => {
  const self = cfg.BASE_URL + path;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${esc(title)}</title><id>${esc(self)}</id><link rel="self" href="${esc(self)}"/><link href="${esc(link)}"/>
<updated>${new Date(events.length ? events[0].created_at : 0).toISOString()}</updated>
${events.map((e) => {
    const url = cfg.siteUrl(e.username);
    return `<entry><title>${esc(`${e.username} ${eventText(e, (f) => f)}`)}</title><id>tag:${esc(cfg.BASE_HOST)},2026:event-${e.id}</id><link href="${esc(url)}/"/>
<updated>${new Date(e.created_at).toISOString()}</updated><author><name>${esc(e.username)}</name></author><content type="html">${esc(`<a href="${esc(url)}/">${esc(e.username)}</a> ${fileLinks(e, url)}`)}</content></entry>`;
  }).join('\n')}
</feed>
`;
};

module.exports = { CM, layout, support, home, browse, profile, feed, update, notifications, eventText, signup, login, login2fa, twoFactor, recoveryCodes, forgot, reset, notice, notices, dashboard, starterConfirm, links, stats, editor, styleEditor, cardStyle, CARD_FAILS, move, history, historyDeleted, guestbookAdmin, report, rules, privacy, admin, sitePage, sitePages, guestbook, atom, widgets, apiPage };
