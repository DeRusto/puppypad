const { esc, fmtBytes, TEXT_EXT, extOf } = require('./util');
const starters = require('./starters');
const style = require('./style');

const CSS = `
/* look: a puppy pad. blue plastic backing with paw prints, white quilted boxes, and one yellow accent for the accidents */
:root{color-scheme:light;--back:#4aa9e6;--pad:#fdfeff;--ink:#14264f;--blue:#0b4f9e;--edge:#2f8fd0;--pee:#ffe14d;--soft:#4a5d85;--link:#0a3fc4;--visited:#7a2ea0}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--back) url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='120'%20height='120'%3E%3Cg%20fill='%23fff'%20fill-opacity='.2'%3E%3Cellipse%20cx='30'%20cy='40'%20rx='11'%20ry='9'/%3E%3Ccircle%20cx='14'%20cy='26'%20r='5'/%3E%3Ccircle%20cx='24'%20cy='17'%20r='5'/%3E%3Ccircle%20cx='36'%20cy='17'%20r='5'/%3E%3Ccircle%20cx='46'%20cy='26'%20r='5'/%3E%3Cg%20transform='translate%2860%2062%29%20rotate%2820%2030%2030%29'%3E%3Cellipse%20cx='30'%20cy='40'%20rx='11'%20ry='9'/%3E%3Ccircle%20cx='14'%20cy='26'%20r='5'/%3E%3Ccircle%20cx='24'%20cy='17'%20r='5'/%3E%3Ccircle%20cx='36'%20cy='17'%20r='5'/%3E%3Ccircle%20cx='46'%20cy='26'%20r='5'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");color:var(--ink);font:16px/1.45 "Comic Sans MS","Comic Neue","Chalkboard SE",cursive}
a{color:var(--link)}a:visited{color:var(--visited)}a:hover{background:var(--pee);color:var(--ink)}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px dashed var(--blue);outline-offset:2px}
.site{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.box{background-color:var(--pad);background-image:repeating-linear-gradient(45deg,transparent 0 21px,#d6eafa 21px 22px),repeating-linear-gradient(-45deg,transparent 0 21px,#d6eafa 21px 22px);border:4px ridge var(--edge);padding:12px;min-width:0;overflow-wrap:anywhere}
header.box{text-align:center}
h1{font:700 clamp(32px,9vw,56px)/1.05 "Comic Sans MS","Comic Neue","Chalkboard SE",cursive;margin:0;color:var(--blue);text-align:center;
background:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20640%20110'%20preserveAspectRatio='none'%3E%3Cpath%20fill='%23ffe14d'%20d='M30%2058C26%2038%2052%2026%2088%2028C104%2014%20142%2012%20168%2020C196%208%20246%2010%20268%2020C298%208%20344%2012%20364%2024C398%2014%20436%2020%20452%2034C492%2030%20522%2044%20518%2064C524%2084%20496%2096%20462%2094C434%20106%20376%20106%20350%2096C318%20108%20254%20108%20228%2097C192%20107%20128%20105%20104%2094C68%20100%2038%2090%2034%2074C26%2068%2027%2064%2030%2058Z'/%3E%3Cellipse%20fill='%23ffffff'%20opacity='.35'%20cx='180'%20cy='40'%20rx='90'%20ry='9'%20transform='rotate(-3%20180%2040)'/%3E%3Cellipse%20fill='%23ffe14d'%20cx='540'%20cy='82'%20rx='12'%20ry='5'/%3E%3Cellipse%20fill='%23ffe14d'%20cx='14'%20cy='80'%20rx='8'%20ry='4'/%3E%3C/svg%3E") no-repeat center 58%/58% 118%}
h1 a,h1 a:visited,h1 a:hover{color:inherit;text-decoration:none;background:none}
.tagline{font-style:italic;color:var(--soft);margin:2px 0 8px}
h2{font:700 24px "Comic Sans MS","Comic Neue",cursive;color:var(--blue);margin:0 0 8px}
h2 small{font-size:14px;font-weight:400;color:var(--soft)}
h3{margin:12px 0 4px;color:var(--blue);font-size:17px}
p{margin:0 0 10px}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center}
form.inline{display:inline}
form.stack{display:flex;flex-direction:column;gap:6px;max-width:460px}
label{font-size:14px;color:var(--blue)}
input[type=text],input[type=search],input[type=email],input[type=password],input[type=file],textarea,select{font:15px "Courier New",monospace;background:#fff;color:#000;border:2px inset var(--edge);padding:4px;width:100%;max-width:100%}
textarea.code{min-height:60vh;white-space:pre;tab-size:2}
button{font:700 14px "Comic Sans MS","Comic Neue",cursive;background:var(--pee);color:var(--ink);border:3px outset #fff3a8;padding:3px 12px;cursor:pointer;align-self:flex-start}
button:active{border-style:inset}
button.link{background:none;border:0;color:var(--link);text-decoration:underline;padding:0;font-weight:400}
button.danger{background:#c0392b;color:#fff;border-color:#e9a59d}
.err{background:#ffdcdc;color:#7a0000;border:2px solid #c00;padding:6px 10px}
.ok{background:#dff7df;color:#0b4d0b;border:2px solid #1a8f1a;padding:6px 10px}
.hp{position:absolute;left:-9999px}
fieldset.starters{border:2px inset var(--edge);display:flex;flex-direction:column;gap:6px;padding:8px 10px}fieldset.starters legend{font-size:14px;color:var(--blue)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--pad)}
th,td{border:2px inset var(--edge);padding:4px 8px;text-align:left;vertical-align:top}
th{color:var(--blue);font-weight:400}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.sites{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.sites small,.note{color:var(--soft);font-size:13px}
code,pre{font:14px "Courier New",monospace;color:var(--pee);background:var(--ink)}
code{padding:0 3px}
pre{padding:8px;overflow-x:auto;border:2px inset var(--edge);margin:0 0 10px}
.b88{display:inline-flex;width:88px;height:31px;align-items:center;justify-content:center;text-align:center;font:700 10px/1.05 Verdana,sans-serif;border:2px outset var(--edge);background:var(--ink);color:var(--pee);text-transform:uppercase;text-decoration:none}
footer{text-align:center;font-size:13px}
.site.wide{max-width:1280px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;list-style:none;margin:0;padding:0}
.card{display:flex;flex-direction:column;gap:4px;min-width:0}
.card .t{font-size:13px;color:var(--soft)}
.shot{display:block;aspect-ratio:4/3;width:100%;height:auto;max-width:100%;border:3px outset #9fd0f0;background:#eaf5fd;object-fit:cover;object-position:top}
.shot.none{display:flex;align-items:center;justify-content:center;color:var(--blue);font:14px "Courier New",monospace;text-align:center;padding:6px;text-decoration:none}
.sorts{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 10px}
.prof{display:flex;flex-wrap:wrap;gap:14px}.prof>.pic{flex:1 1 260px;max-width:420px}.prof>.info{flex:2 1 260px;min-width:0}
.names{display:flex;flex-wrap:wrap;gap:4px 12px}
.feed{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.feed li{display:flex;gap:10px;align-items:center}.feed .shot{width:96px;flex:none;border-width:2px}
.edwrap{display:flex;gap:10px;flex-wrap:wrap}.edwrap>div{flex:1 1 420px;min-width:0}
.CodeMirror{height:65vh;border:2px inset var(--edge);font:14px/1.4 "Courier New",monospace}
.drop{display:flex;flex-direction:column;gap:6px;border:3px dashed var(--edge);padding:12px;background:#fff}.drop.over{background:var(--pee)}
progress{width:100%;max-width:460px}
iframe.preview{width:100%;height:65vh;border:2px inset var(--edge);background:#fff}
.pup{float:right;width:180px;height:auto;margin:0 0 8px 12px}
.pup.left{float:left;margin:0 12px 8px 0}
@media (min-width:561px) and (max-width:820px){.pup{width:120px}}
@media (max-width:560px){.pup,.pup.left{float:none;display:block;margin:0 auto 8px}}
`;

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
      ? [`<a href="/feed">Feed</a>`, `<a href="/dashboard">My pad</a>`, ...(ctx.isAdmin ? [`<a href="/admin">Admin</a>`] : []),
        `<form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Log out (${esc(user.username)})</button></form>`]
      : [`<a href="/signup">Get a free pad</a>`, `<a href="/login">Log in</a>`]),
  ].join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(fullTitle)}</title>${meta}<style>${CSS}</style>${opts.head || ''}</head><body><div class="site${opts.wide ? ' wide' : ''}">
<header class="box"><h1><a href="/">${esc(cfg.SITE_NAME)}</a></h1><p class="tagline">${esc(cfg.TAGLINE)}</p><nav aria-label="Main">${nav}</nav></header>
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
const siteList = (ctx, rows) => rows.length
  ? `<ul class="sites">${rows.map((r) => `<li><a href="${esc(ctx.cfg.siteUrl(r.username))}">${esc(r.username)}</a>${r.tagline ? ` - ${esc(r.tagline)}` : ''} <small>(updated ${ago(r.updated_at)}, ${r.hits} hits)</small></li>`).join('')}</ul>`
  : `<p>The pad is clean. Make the first mess.</p>`;

const shotImg = (ctx, r, link) => (r.shot
  ? `<a href="${esc(link)}"><img class="shot" src="/shots/${esc(r.username)}.jpg?v=${r.shot_at || 0}" alt="Screenshot of ${esc(r.username)}" loading="lazy" width="512" height="384"></a>`
  : `<a class="shot none" href="${esc(link)}">${esc(r.username)}<br>no screenshot yet</a>`);
const tagLinks = (tags) => tags.split(' ').map((t) => `<a href="/browse?q=${encodeURIComponent(t)}">#${esc(t)}</a>`).join(' ');
const cards = (ctx, rows) => (rows.length
  ? `<ul class="grid">${rows.map((r) => `<li class="card">${shotImg(ctx, r, ctx.cfg.siteUrl(r.username))}
<div><a href="${esc(ctx.cfg.siteUrl(r.username))}"><b>${esc(r.username)}</b></a> <a href="/site/${esc(r.username)}" class="t">[profile]</a></div>
${r.tagline ? `<div class="t">${esc(r.tagline)}</div>` : ''}${r.tags ? `<div class="t">${tagLinks(r.tags)}</div>` : ''}
<div class="t">updated ${ago(r.updated_at)} | ${r.followers} follower${r.followers === 1 ? '' : 's'} | ${r.hits} hits</div></li>`).join('')}</ul>`
  : `<p>The pad is clean. Make the first mess.</p>`);

const ATOM_LINK = (title, href) => `<link rel="alternate" type="application/atom+xml" title="${esc(title)}" href="${esc(href)}">`;
const home = (ctx, { recent, newest, total }) => layout(ctx, 'Home', `
<section class="box"><img class="pup" src="/img/pup-hero.webp" alt="Cartoon puppy waving from a puppy pad" width="180" height="143"><img class="pup left" src="/img/pup-coder.webp" alt="Cartoon puppy typing code on a retro computer" width="180" height="120" loading="lazy"><h2>Your own pad on the web</h2>
<p>Sign up and you get <code>yourname.${esc(ctx.cfg.BASE_HOST)}</code>, ${ctx.cfg.QUOTA_MB} MB of space, a code editor with live preview, a hit counter and a guestbook. No templates, no algorithm. Write your own HTML, and do not worry about making a mess. That is what the pad is for.</p>
<p><a href="/signup">Claim your pad</a> | ${total} pad${total === 1 ? '' : 's'} in use so far</p><div style="clear:both"></div></section>
<section class="box"><img class="pup" src="/img/pup-accident.webp" alt="Cartoon puppy looking sheepish next to a puddle on its pad" width="180" height="116" loading="lazy"><h2>Fresh accidents <small>(recently updated)</small></h2><div style="clear:right"></div>${cards(ctx, recent)}<p style="margin-top:10px"><a href="/browse">See them all &gt;&gt;</a></p></section>
<section class="box"><img class="pup" src="/img/pup-guestbook.webp" alt="Cartoon puppy with a pencil next to an open guestbook" width="180" height="114" loading="lazy"><h2>New puppies <small>(just joined)</small></h2>${siteList(ctx, newest)}<div style="clear:both"></div></section>`, {
  fullTitle: `${ctx.cfg.SITE_NAME} \u2014 Free Homepages | Make Your Own Website, Old-Web Style`,
  description: `${ctx.cfg.SITE_NAME} is a free homepage host. Get yourname.${ctx.cfg.BASE_HOST}, ${ctx.cfg.QUOTA_MB} MB, a built-in editor, guestbook and hit counter. No templates, no algorithm \u2014 write your own HTML. Accidents welcome.`,
  path: '/',
  head: ATOM_LINK(`${ctx.cfg.SITE_NAME}: recently updated`, '/feed.xml'),
  jsonLd: JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: ctx.cfg.SITE_NAME, url: ctx.cfg.BASE_URL, description: 'Free old-web homepage host' }),
});

const SORT_LABELS = { updated: 'Recently updated', newest: 'Newest', followed: 'Most followed', hits: 'Most visited' };
const browse = (ctx, { rows, page, pages, sort, q }) => {
  const qs = q ? `&amp;q=${esc(encodeURIComponent(q))}` : '';
  return layout(ctx, 'Dog park', `
<section class="box"><h2>The dog park <small>(page ${page} of ${pages})</small></h2>
<form class="stack" method="get" action="/browse" role="search"><input type="hidden" name="sort" value="${esc(sort)}"><label for="q">Find a site by name or tag</label>
<input type="search" id="q" name="q" maxlength="50" value="${esc(q)}"><button>Search</button></form>${q ? `<p><a href="/browse?sort=${sort}">Show every site</a></p>` : ''}
<p class="sorts">Sort: ${Object.entries(SORT_LABELS).map(([k, l]) => (k === sort ? `<b>${l}</b>` : `<a href="/browse?sort=${k}${qs}">${l}</a>`)).join(' ')}</p>
${q && !rows.length ? '<p>No sites match that search.</p>' : cards(ctx, rows)}
<p style="margin-top:10px">${page > 1 ? `<a href="/browse?sort=${sort}${qs}&amp;page=${page - 1}">&lt;&lt; Prev</a>` : ''} ${page < pages ? `<a href="/browse?sort=${sort}${qs}&amp;page=${page + 1}">Next &gt;&gt;</a>` : ''}</p>
<p class="note"><a href="/feed.xml">Follow recently updated sites in a feed reader</a> (Atom).</p></section>`, { wide: true, noindex: !!q, description: 'Browse homepages hosted on PuppyPad \u2014 the dog park. Fresh, hand-written websites. No feeds, no algorithm.', path: page === 1 && sort === 'updated' ? '/browse' : `/browse?sort=${sort}&page=${page}`, head: ATOM_LINK(`${ctx.cfg.SITE_NAME}: recently updated`, '/feed.xml') });
};

const EVENT_TEXT = { update: 'left a fresh update on their pad', join: 'joined' };
// "updated a.html, b.png and 3 more", each name passed through link; events from before files were recorded keep the old line
const eventText = (e, link) => {
  const files = e.kind === 'update' && e.files ? e.files.split('\n') : [];
  if (!files.length) return EVENT_TEXT[e.kind] || esc(e.kind);
  return `updated ${files.slice(0, 5).map(link).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;
};
const fileLinks = (e, url) => eventText(e, (f) => `<a href="${esc(url)}/${esc(f)}">${esc(f)}</a>`);
const nameLinks = (rows) => (rows.length ? `<div class="names">${rows.map((r) => `<a href="/site/${esc(r.username)}">${esc(r.username)}</a>`).join('')}</div>` : '<p class="note">Nobody yet.</p>');
const profile = (ctx, m, { p, following, events, followers, follows }) => {
  const url = ctx.cfg.siteUrl(p.username);
  const mine = ctx.user && ctx.user.id === p.id;
  return layout(ctx, p.username, `
<section class="box"><h2>${esc(p.username)}</h2>${msg(m)}<div class="prof">
<div class="pic">${shotImg(ctx, p, url)}</div>
<div class="info"><p><a href="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</a></p>
${p.tagline ? `<p>${esc(p.tagline)}</p>` : ''}${p.tags ? `<p>${tagLinks(p.tags)}</p>` : ''}
<p>${p.followers} follower${p.followers === 1 ? '' : 's'} | ${p.updates} update${p.updates === 1 ? '' : 's'} | ${p.hits} hits<br>Joined ${ago(p.created_at)}, last updated ${ago(p.updated_at)}</p>
${mine ? '<p><a href="/dashboard">Edit my site</a></p>' : `<form class="inline" method="post" action="/follow">${csrfField(ctx)}<input type="hidden" name="site" value="${esc(p.username)}">
<button name="action" value="${following ? 'unfollow' : 'follow'}">${following ? 'Unfollow' : ctx.user ? 'Follow' : 'Log in to follow'}</button></form>
<p style="margin-top:10px"><a href="/report?site=${esc(p.username)}">Report this site</a></p>`}</div></div></section>
<section class="box"><h2>Recent activity</h2>${events.length ? `<ul>${events.map((e) => `<li>${fileLinks(e, url)} ${ago(e.created_at)}</li>`).join('')}</ul>` : '<p class="note">Nothing yet.</p>'}
<p class="note"><a href="/site/${esc(p.username)}/feed.xml">Follow ${esc(p.username)} in a feed reader</a> (Atom).</p></section>
<section class="box"><h2>Followers</h2>${nameLinks(followers)}<h3>Following</h3>${nameLinks(follows)}</section>
${mine ? `<section class="box"><h2>Change password</h2>
<form class="stack" method="post" action="/account/password">${csrfField(ctx)}<label for="curpw">Current password</label>
<input type="password" id="curpw" name="password" required autocomplete="current-password">
<label for="newpw">New password (10 characters or more)</label>
<input type="password" id="newpw" name="new_password" minlength="10" maxlength="200" required autocomplete="new-password">
<label for="newpw2">New password again</label>
<input type="password" id="newpw2" name="confirm_password" minlength="10" maxlength="200" required autocomplete="new-password"><button>Change password</button></form></section>
<section class="box"><h2>Change email</h2><p>Your email is <b>${esc(ctx.user.email)}</b>.${ctx.user.new_email ? ` Waiting for <b>${esc(ctx.user.new_email)}</b> to confirm.` : ''}</p>
<form class="stack" method="post" action="/account/email">${csrfField(ctx)}<label for="newemail">New email (we send a link there to confirm it)</label>
<input type="email" id="newemail" name="email" maxlength="200" required autocomplete="email">
<label for="emailpw">Your password</label>
<input type="password" id="emailpw" name="password" required autocomplete="current-password"><button>Change email</button></form></section>` : ''}`, {
    description: p.tagline ? `${p.tagline} \u2014 ${p.username}'s homepage on ${ctx.cfg.SITE_NAME}` : `${p.username}'s homepage on ${ctx.cfg.SITE_NAME}, a free old-web homepage host.`,
    path: `/site/${p.username}`,
    ogImage: p.shot ? `${ctx.cfg.BASE_URL}/shots/${p.username}.jpg` : undefined,
    head: ATOM_LINK(`${p.username} on ${ctx.cfg.SITE_NAME}`, `/site/${p.username}/feed.xml`),
  });
};

const feed = (ctx, { events, count }) => layout(ctx, 'Feed', `
<section class="box"><h2>Your feed</h2>
${events.length ? `<ul class="feed">${events.map((e) => `<li>${shotImg(ctx, e, ctx.cfg.siteUrl(e.username))}<div><a href="${esc(ctx.cfg.siteUrl(e.username))}"><b>${esc(e.username)}</b></a> ${fileLinks(e, ctx.cfg.siteUrl(e.username))} ${ago(e.created_at)}${e.tagline ? `<div class="note">${esc(e.tagline)}</div>` : ''}</div></li>`).join('')}</ul>`
    : count ? '<p>The sites you follow have been quiet. Updates show up here.</p>'
      : '<p>You are not following anyone yet. <a href="/browse">Visit the dog park</a> and press Follow on the ones you like.</p>'}</section>`);

const signup = (ctx, m, v = {}) => layout(ctx, 'Sign up', `
<section class="box"><h2>Get a free pad</h2>${msg(m)}
<form class="stack" method="post" action="/signup">
<label for="username">Site name (3-30 letters, numbers, hyphens). Your address will be name.${esc(ctx.cfg.BASE_HOST)}</label>
<input type="text" id="username" name="username" value="${esc(v.username)}" maxlength="30" required autocapitalize="none" autocomplete="username">
<label for="email">Email (we send one confirmation link, nothing else)</label>
<input type="email" id="email" name="email" value="${esc(v.email)}" required autocomplete="email">
<label for="password">Password (10 characters or more)</label>
<input type="password" id="password" name="password" minlength="10" required autocomplete="new-password">
<fieldset class="starters"><legend>Pick a starter layout. It is only a beginning: every colour, font and box is yours to change.</legend>
${starters.LIST.map((s) => `<label><input type="radio" name="starter" value="${s.id}"${(v.starter || starters.DEFAULT) === s.id ? ' checked' : ''}> <b>${esc(s.name)}</b>: ${esc(s.blurb)} <a href="/starters/${s.id}" target="_blank">Peek</a></label>`).join('\n')}
</fieldset>
<div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label><input type="checkbox" name="agree" value="1" required> I am 13 or older and have read the <a href="/rules" target="_blank">rules</a> and <a href="/privacy" target="_blank">privacy notice</a></label>
${ctx.cfg.TURNSTILE_SITE_KEY ? `<div class="cf-turnstile" data-sitekey="${esc(ctx.cfg.TURNSTILE_SITE_KEY)}"></div>` : ''}
<button>Roll out my pad</button></form></section>`, { noindex: true, description: `Claim a free ${ctx.cfg.SITE_NAME} homepage: your own subdomain, ${ctx.cfg.QUOTA_MB} MB, a code editor with live preview, a guestbook and a hit counter.`, path: '/signup', ...(ctx.cfg.TURNSTILE_SITE_KEY ? { head: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' } : {}) });

const login = (ctx, m, v = {}) => layout(ctx, 'Log in', `
<section class="box"><h2>Log in</h2>${msg(m)}
<form class="stack" method="post" action="/login">
<label for="username">Site name or email</label><input type="text" id="username" name="username" value="${esc(v.username)}" required autocapitalize="none" autocomplete="username">
<label for="password">Password</label><input type="password" id="password" name="password" required autocomplete="current-password">
<button>Log in</button></form><p style="margin-top:10px"><a href="/forgot">Forgot your password?</a></p></section>`);

const forgot = (ctx, m) => layout(ctx, 'Reset password', `
<section class="box"><h2>Reset your password</h2>${msg(m)}
<form class="stack" method="post" action="/forgot"><label for="email">The email you signed up with</label>
<input type="email" id="email" name="email" required><button>Email me a reset link</button></form></section>`);

const reset = (ctx, m, token) => layout(ctx, 'Choose a new password', `
<section class="box"><h2>Choose a new password</h2>${msg(m)}
<form class="stack" method="post" action="/reset"><input type="hidden" name="token" value="${esc(token)}">
<label for="password">New password (10 characters or more)</label>
<input type="password" id="password" name="password" minlength="10" required autocomplete="new-password"><button>Save password</button></form></section>`);

const notice = (ctx, title, html) => layout(ctx, title, `<section class="box"><h2>${esc(title)}</h2>${html}</section>`, { noindex: true });

// Drag-and-drop and many-file uploads: sends the files 20 at a time with a progress bar, then reloads the folder with the totals.
// Without JavaScript the form above still posts normally (20 files at most).
const UPLOADER = (ctx) => `<script nonce="${esc(ctx.nonce || '')}">(function(){
var form=document.getElementById('upform'),drop=document.getElementById('drop'),input=document.getElementById('files'),bar=document.getElementById('upbar'),note=document.getElementById('upnote');
if(!form||!window.FormData||!window.XMLHttpRequest)return;
var max=Number(form.dataset.max),busy=false;
function post(batch,sent,total,cb){
  var fd=new FormData();fd.append('_csrf',form._csrf.value);fd.append('dir',form.dir.value);
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
${TEXT_EXT.has(extOf(e.name)) ? `<a href="/dashboard/edit?path=${encodeURIComponent(rel)}">edit</a> | ` : ''}${mv ? `${mv} | ` : ''}
<form class="inline" method="post" action="/dashboard/delete">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}"><button class="link">delete</button></form></td></tr>`;
    }),
  ].join('');
  return layout(ctx, 'My pad', `
<section class="box"><h2>My pad</h2>${msg(m)}
${user.banned ? `<p class="err">This site was taken down by a moderator${user.ban_reason ? `: ${esc(user.ban_reason)}` : '.'} Editing is disabled. Contact ${esc(cfg.ABUSE_EMAIL)} to appeal.</p>` : ''}
<p>Address: <a href="${esc(url)}" target="_blank">${esc(url)}</a><br>Space used: ${fmtBytes(d.used.total)} of ${d.quota} MB in ${d.used.count} file${d.used.count === 1 ? '' : 's'} | Bandwidth today: ${fmtBytes(d.bandwidth)} of ${cfg.BANDWIDTH_MB} MB | ${user.hits} hits | <a href="/dashboard/guestbook">guestbook entries</a> | <a href="/dashboard/links">check for broken links</a> | <a href="/site/${esc(user.username)}">my profile</a></p>
${!d.hasIndex && !user.banned ? `<div id="noindex"><h3>Your site has no front page</h3>
<p class="err">There is no <code>index.html</code> at the top of your site, so visitors to ${esc(url)} get a "page not found". Rename one of your pages to <code>index.html</code>, or make a new front page from a starter:</p>
${starterForm(ctx, 'Make my front page')}</div>` : ''}
${d.listed || user.banned || user.hidden ? '' : `<p class="note">Your site is online, but it shows up in the dog park, on the home page and in the webring (if you join it) only after your first edit${cfg.NEW_SITE_HOURS > 0 ? ` and once it is ${cfg.NEW_SITE_HOURS} hours old` : ''}. Make it yours!</p>`}
<form class="stack" method="post" action="/dashboard/tagline">${csrfField(ctx)}<label for="tagline">One-line description for the site directory</label>
<input type="text" id="tagline" name="tagline" maxlength="100" value="${esc(user.tagline)}"><button>Save description</button></form>
<form class="stack" method="post" action="/dashboard/tags">${csrfField(ctx)}<label for="tags">Tags, so people can find your site in the dog park: up to 5, separated by spaces, like <code>pixel-art cats retro</code></label>
<input type="text" id="tags" name="tags" maxlength="130" value="${esc(user.tags)}"><button>Save tags</button></form>
<form class="stack" method="post" action="/dashboard/hidden">${csrfField(ctx)}<input type="hidden" name="hidden" value="${user.hidden ? '0' : '1'}">
<p>${user.hidden ? 'Your site is hidden: it stays off the dog park, the home page, feeds and the webring, and asks search engines not to index it. Its address and profile still work.' : 'Want a quiet corner? Hide your site from browsing, feeds, the webring and search engines. Its address and profile keep working.'}</p>
<button>${user.hidden ? 'Show my site again' : 'Hide my site from browsing'}</button></form></section>

<section class="box"><h2>Files in /${esc(d.dir)}</h2>
<div class="scroll"><table><tr><th>Name</th><th>Size</th><th>Actions</th></tr>${rows || '<tr><td colspan="3">This folder is empty.</td></tr>'}</table></div>
<h3>Upload files</h3>
<form class="stack" id="upform" method="post" action="/dashboard/upload" enctype="multipart/form-data" data-max="${cfg.MAX_FILE_MB * 1048576}">${csrfField(ctx)}<input type="hidden" name="dir" value="${esc(d.dir)}">
<div class="drop" id="drop"><label for="files">Drop files here, or pick them below. ${cfg.MAX_FILE_MB} MB each at most. Files with the same name are replaced.</label>
<input type="file" id="files" name="files" multiple required></div>
<progress id="upbar" max="1" value="0" hidden></progress><p class="note" id="upnote" role="status"></p><button>Upload</button></form>
${UPLOADER(ctx)}
<h3>Import a zip</h3>
<form class="stack" method="post" action="/dashboard/import" enctype="multipart/form-data">${csrfField(ctx)}<input type="hidden" name="dir" value="${esc(d.dir)}">
<label for="zip">Moving in from another host? Zip up your site folder (up to ${cfg.ZIP_MAX_MB} MB) and it unpacks here, folders and all. Files with the same name are replaced.</label>
<input type="file" id="zip" name="zip" accept=".zip,application/zip" required><button>Import zip</button></form>
<h3>Download my site</h3>
<p>Get every file as one <a href="/dashboard/download">.zip</a>, folders and all. Handy as a backup, or to move your site somewhere else.</p>
<h3>New file or folder</h3>
<form class="stack" method="get" action="/dashboard/edit"><label for="newpath">File path, for example <code>about.html</code> or <code>pics/index.html</code>. Folders are created for you.</label>
<input type="text" id="newpath" name="path" value="${esc(d.dir ? d.dir + '/' : '')}" required><button>Create and edit</button></form></section>

${d.hasIndex && !user.banned ? `<section class="box"><h2>Start over with a starter</h2>
<p>Want your front page back the way it started, or a different look? Pick a starter and it replaces your <code>index.html</code>. We ask before anything is overwritten, and your other files stay put.</p>
${starterForm(ctx, 'Use this starter')}</section>

` : ''}${user.banned ? '' : `<section class="box"><h2>Colours and fonts</h2>
<p>Restyle your pages without writing CSS: the <a href="/dashboard/style">style editor</a> writes <code>puppypad.css</code> for you.</p></section>

`}<section class="box"><h2>Widgets</h2><p>Paste these into your HTML.</p>
<h3>Hit counter</h3><pre>&lt;img src="/_hw/counter.svg" alt="hit counter"&gt;</pre>
<h3>Guestbook</h3><pre>&lt;iframe src="/_hw/guestbook" width="100%" height="420"&gt;&lt;/iframe&gt;</pre>
<h3>Webring</h3>
<form class="stack" method="post" action="/dashboard/webring">${csrfField(ctx)}<input type="hidden" name="webring" value="${user.webring ? '0' : '1'}">
<p>${user.webring ? 'Your site is in the webring. Visitors clicking Prev, Next or Random on other sites can land on yours.' : 'Your site is not in the webring. Join it and visitors of other sites can land on yours; you can leave any time.'}</p>
<button>${user.webring ? 'Leave the webring' : 'Join the webring'}</button></form>
<pre>&lt;a href="${esc(cfg.BASE_URL)}/webring/prev?from=${esc(user.username)}"&gt;&amp;lt;&amp;lt; Prev&lt;/a&gt; |
&lt;a href="${esc(cfg.BASE_URL)}/webring/random"&gt;Random&lt;/a&gt; |
&lt;a href="${esc(cfg.BASE_URL)}/webring/next?from=${esc(user.username)}"&gt;Next &amp;gt;&amp;gt;&lt;/a&gt;</pre>
<h3>Custom 404 page</h3><p>Upload a file named <code>not_found.html</code>.</p></section>

<section class="box"><h2>Delete my account</h2><p>This removes your site, files and guestbook for good.</p>
<form class="stack" method="post" action="/dashboard/delete-account">${csrfField(ctx)}<label for="delpw">Confirm with your password</label>
<input type="password" id="delpw" name="password" required autocomplete="current-password"><button class="danger">Delete everything</button></form></section>`);
}

const links = (ctx, broken) => layout(ctx, 'Broken links', `
<section class="box"><h2>Broken links</h2>
${broken.length ? `<p>These links and images in your pages point at files your site doesn't have. Fix the path, or upload the missing file.</p>
<div class="scroll"><table><tr><th>Page</th><th>Points at</th></tr>${broken.slice(0, 500).map((b) => `<tr><td><a href="/dashboard/edit?path=${encodeURIComponent(b.file)}">${esc(b.file)}</a></td><td><code>${esc(b.link)}</code></td></tr>`).join('')}</table></div>
${broken.length > 500 ? `<p class="note">...and ${broken.length - 500} more.</p>` : ''}` : '<p class="ok" role="status">No broken links. Every link and image in your pages points at a file you have.</p>'}
<p class="note">Links to other websites aren't checked.</p>
<p><a href="/dashboard">Back to my site</a></p></section>`, { noindex: true });

const CM = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16';
// sha384 of each pinned file CM points at; if the version in CM ever changes, recompute these or the editor will not load
const CM_SRI = {
  'codemirror.min.css': 'sha384-zaeBlB/vwYsDRSlFajnDd7OydJ0cWk+c2OWybl3eSUf6hW2EbhlCsQPqKr3gkznT',
  'theme/material-darker.min.css': 'sha384-eZTPTN0EvJdn23s24UDYJmUM2T7C2ZFa3qFLypeBruJv8mZeTusKUAO/j5zPAQ6l',
  'codemirror.min.js': 'sha384-ZYmwuq4n2gOcNxMSiJ6jyTj+BbIrilr7p6dlq6q5nmSWKmsH9UU4K1qqjycMkfmR',
  'mode/xml/xml.min.js': 'sha384-xPpkMo5nDgD98fIcuRVYhxkZV6/9Y4L8s3p0J5c4MxgJkyKJ8BJr+xfRkq7kn6Tw',
  'mode/javascript/javascript.min.js': 'sha384-g0o+WW9mdIxA7LaaCKTkRm0M5TVT+Bb4s9eocxPsI2G0Xm0POG9iD6G6qP1IIsfS',
  'mode/css/css.min.js': 'sha384-fpeIC2FZuPmw7mIsTvgB5BNc8QVxQC/nWg2W+CgPYOAiBiYVuHe2E8HiTWHBMIJQ',
  'mode/htmlmixed/htmlmixed.min.js': 'sha384-xYIbc5F55vPi7pb/lUnFj3wu24HlpAMZdtBHkNrb2YhPzJV3pX7+eqXT2PXSNMrw',
  'mode/markdown/markdown.min.js': 'sha384-nPWqI+4+e+SwcpI6LVYBpaQd+zIZIQgC6lN7Gep8MJQr5DdmMGtWV8qJQgcyODcF',
};
const sri = (p) => ` integrity="${CM_SRI[p]}" crossorigin="anonymous"`;
const CM_MODE = { html: 'htmlmixed', htm: 'htmlmixed', svg: 'xml', xml: 'xml', css: 'css', js: 'javascript', json: { name: 'javascript', json: true }, md: 'markdown' };
const editor = (ctx, m, { rel, content, isNew }) => {
  const ext = extOf(rel);
  const isHtml = ext === 'html' || ext === 'htm';
  const dir = rel.split('/').slice(0, -1).join('/');
  const siteBase = `${ctx.cfg.siteUrl(ctx.user.username)}/${dir ? dir + '/' : ''}`;
  const head = `<link rel="stylesheet" href="${CM}/codemirror.min.css"${sri('codemirror.min.css')}><link rel="stylesheet" href="${CM}/theme/material-darker.min.css"${sri('theme/material-darker.min.css')}>`;
  return layout(ctx, `Edit ${rel}`, `
<section class="box"><h2>${isNew ? 'New file' : 'Editing'}: ${esc(rel)}</h2>${msg(m)}
<form id="edform" method="post" action="/dashboard/save" style="display:flex;flex-direction:column;gap:8px">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}">
<div class="edwrap"><div><label for="content">Code (Ctrl+S or Cmd+S saves)</label><textarea class="code" id="content" name="content" spellcheck="false">${esc(content)}</textarea></div>
${isHtml ? '<div><label for="preview">Live preview (unsaved)</label><iframe class="preview" id="preview" title="Live preview" sandbox="allow-scripts"></iframe></div>' : ''}</div>
<div><button>Save</button> <a href="/dashboard?dir=${encodeURIComponent(dir)}">Back to files</a> | <a href="${esc(ctx.cfg.siteUrl(ctx.user.username))}/${esc(rel)}" target="_blank">View saved page</a></div></form></section>
<script src="${CM}/codemirror.min.js"${sri('codemirror.min.js')}></script><script src="${CM}/mode/xml/xml.min.js"${sri('mode/xml/xml.min.js')}></script><script src="${CM}/mode/javascript/javascript.min.js"${sri('mode/javascript/javascript.min.js')}></script>
<script src="${CM}/mode/css/css.min.js"${sri('mode/css/css.min.js')}></script><script src="${CM}/mode/htmlmixed/htmlmixed.min.js"${sri('mode/htmlmixed/htmlmixed.min.js')}></script><script src="${CM}/mode/markdown/markdown.min.js"${sri('mode/markdown/markdown.min.js')}></script>
<script>(function(){
var ta=document.getElementById('content'),form=document.getElementById('edform'),frame=document.getElementById('preview');
var base=${JSON.stringify(`<base href="${siteBase}">`).replace(/</g, '\\u003c')};
var get=function(){return ta.value};
// the preview runs in a sandboxed frame with no access to your login; <base> makes your images and stylesheets resolve
function draw(){if(frame)frame.srcdoc=base+get()}
if(window.CodeMirror){
  var cm=CodeMirror.fromTextArea(ta,{mode:${JSON.stringify(CM_MODE[ext] || 'text/plain')},theme:'material-darker',lineNumbers:true,lineWrapping:true,tabSize:2,indentUnit:2,
    extraKeys:{'Ctrl-S':function(){form.requestSubmit()},'Cmd-S':function(){form.requestSubmit()}}});
  get=function(){return cm.getValue()};var t;cm.on('change',function(){clearTimeout(t);t=setTimeout(draw,400)});
}else{var t2;ta.addEventListener('input',function(){clearTimeout(t2);t2=setTimeout(draw,400)})}
draw();
})();</script>`, { wide: true, head });
};

const styleEditor = (ctx, m, { s, page, tail, offerLink }) => {
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
<button>Save puppypad.css</button></form><p><a href="/dashboard">Back to my pad</a></p></div>
<div><label for="preview">Live preview of your front page (unsaved)</label><iframe class="preview" id="preview" title="Live preview" sandbox="allow-scripts"></iframe></div></div></section>
<script>(function(){
var form=document.getElementById('stform'),frame=document.getElementById('preview');
var page=${json(`<base href="${ctx.cfg.siteUrl(ctx.user.username)}/">`)}+${json(page)},fonts=${json(style.FONTS)},tail=${json(tail)};
var block=${style.block.toString()};
// the preview runs in a sandboxed frame with no access to your login; the new block and your own CSS below it go last, as on the saved page.
// A CSS escape keeps a </style> in your CSS from closing the preview's <style> early; it still reads as </style>
function draw(){var s={};for(var i=0;i<form.elements.length;i++){var e=form.elements[i];if(e.name)s[e.name]=e.value}
  frame.srcdoc=page+'<style>'+(block(s,fonts)+tail).replace(/<\\/(style)/gi,'<\\\\/$1')+'</style>'}
form.addEventListener('input',draw);draw();
})();</script>`, { wide: true });
};

const move = (ctx, m, { from, to, dir }) => {
  const back = from.split('/').slice(0, -1).join('/');
  return layout(ctx, `Move ${from}`, `
<section class="box"><h2>Rename or move ${dir ? 'folder' : 'file'}: ${esc(from)}</h2>${msg(m)}
<form class="stack" method="post" action="/dashboard/move">${csrfField(ctx)}<input type="hidden" name="from" value="${esc(from)}">
<label for="to">New path, for example <code>${dir ? 'old/pics' : 'pages/about.html'}</code>. Missing folders are created for you.${dir ? ' Everything inside moves too.' : ''}</label>
<input type="text" id="to" name="to" value="${esc(to)}" required autocapitalize="none"><button>Move</button></form>
<p class="note">Links to the old address stop working, so update any pages that point here.</p>
<p><a href="/dashboard?dir=${encodeURIComponent(back)}">Back to files</a></p></section>`);
};

const guestbookAdmin = (ctx, m, rows, blocked = []) => layout(ctx, 'Guestbook entries', `
<section class="box"><h2>Guestbook entries</h2>${msg(m)}<p><a href="/dashboard">Back to my site</a></p>
<div class="scroll"><table><tr><th>When</th><th>Name</th><th>Message</th><th></th></tr>
${rows.map((r) => `<tr><td>${ago(r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.message)}</td><td>${r.approved ? '' : `<form class="inline" method="post" action="/dashboard/guestbook/approve">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="link">approve (held: has a link)</button></form> `}<form class="inline" method="post" action="/dashboard/guestbook/delete">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="link">delete</button></form>${r.ip && !blocked.includes(r.ip) ? ` <form class="inline" method="post" action="/dashboard/guestbook/block-ip">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="link">block IP</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">Nobody has signed yet.</td></tr>'}
</table></div>
<h3>Email me about new entries</h3>
<form class="stack" method="post" action="/dashboard/guestbook/notify">${csrfField(ctx)}<label for="gn">Sent to ${esc(ctx.user.email)}. Entries waiting for your approval are marked.</label>
<select id="gn" name="notify">${[['instant', 'Right away, one email per entry'], ['daily', 'Once a day, a digest'], ['off', 'Never']].map(([v, l]) => `<option value="${v}"${ctx.user.gb_notify === v ? ' selected' : ''}>${l}</option>`).join('')}</select><button>Save</button></form>
<h3>Moderation</h3><p class="note">Entries with links wait here until you approve them. Entries with a blocked word are refused (one per line). Posts from a blocked IP are silently dropped; visitor IPs are only kept for 90 days.</p>
<p>Blocked IPs: ${blocked.map((ip) => `${esc(ip)} <form class="inline" method="post" action="/dashboard/guestbook/unblock-ip">${csrfField(ctx)}<input type="hidden" name="ip" value="${esc(ip)}"><button class="link">unblock</button></form>`).join(', ') || 'none'}</p>
<form class="stack" method="post" action="/dashboard/guestbook/settings">${csrfField(ctx)}
<label for="gw">Blocked words</label><textarea id="gw" name="words" rows="4">${esc(ctx.user.gb_words)}</textarea>
<button>Save</button></form></section>`);

const report = (ctx, m, v = {}) => layout(ctx, 'Report a site', `
<section class="box"><h2>Report a site</h2>${msg(m)}
<form class="stack" method="post" action="/report">
<label for="site">Site name (the part before .${esc(ctx.cfg.BASE_HOST)})</label><input type="text" id="site" name="site" value="${esc(v.site)}" required>
<label for="reason">Reason</label><select id="reason" name="reason">${['Illegal content', 'Harassment or doxxing', 'Malware or phishing', 'Spam', 'Copyright', 'Other'].map((r) => `<option>${r}</option>`).join('')}</select>
<label for="details">What is wrong, and where on the site?</label><textarea id="details" name="details" rows="5" maxlength="2000" required></textarea>
<label for="remail">Your email (optional, if you want a reply)</label><input type="email" id="remail" name="email">
<div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
<button>Send report</button></form></section>`);

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
<li>One account per person for one site. Don't create accounts in bulk or to hold names.</li>
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
<li><b>Your site:</b> the files you upload, your description, your hit count, who you follow, and a screenshot of your front page for the directory.</li>
<li><b>Network addresses:</b> the IP address you signed up from, and the IP address behind each guestbook entry and abuse report. These help us stop spam and abuse. Guestbook and report addresses are erased after 90 days; your signup address is kept until you delete your account.</li>
<li><b>One cookie</b> that keeps you logged in. No tracking or advertising cookies.</li>
</ul>
<h3>Who else sees it</h3>
<p>Your site, its files, your site name, description, followers and hit count are public. Guestbook entries are public on the site they were left on. We do not sell or share your data. Our email provider delivers our messages${ctx.cfg.TURNSTILE_SITE_KEY ? ', and Cloudflare Turnstile checks that people signing up are human' : ''}.</p>
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

const admin = (ctx, m, { q, reports, users, signups, stats, log, upgrade }) => layout(ctx, 'Admin', `
<section class="box"><h2>Moderation</h2>${msg(m)}<p>${stats.users} members, ${stats.banned} banned, ${stats.open} open reports.</p>
<h3>Open reports</h3><div class="scroll"><table><tr><th>When</th><th>Site</th><th>Reason</th><th>Details</th><th>From</th><th></th></tr>
${reports.map((r) => `<tr><td>${ago(r.created_at)}</td><td><a href="${esc(ctx.cfg.siteUrl(r.site))}" target="_blank">${esc(r.site)}</a></td><td>${esc(r.reason)}</td><td>${esc(r.details)}</td><td>${esc(r.reporter_email || '')}<br><small>${esc(r.ip)}</small></td>
<td><form class="inline" method="post" action="/admin/report-close">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="link">close</button></form></td></tr>`).join('') || '<tr><td colspan="6">Queue is empty.</td></tr>'}</table></div>
<h3>Take a site down or restore it</h3>
<form class="stack" method="post" action="/admin/ban">${csrfField(ctx)}<label for="bsite">Site name</label><input type="text" id="bsite" name="site" required>
<label for="breason">Reason shown to the member</label><input type="text" id="breason" name="reason" maxlength="200">
<div><button name="action" value="ban" class="danger">Take down</button> <button name="action" value="unban">Restore</button> <button name="action" value="delete" class="danger">Delete account and files</button></div></form>
<h3>${q ? `Members matching “${esc(q)}”` : 'Newest members'}</h3>
<form class="inline" method="get" action="/admin"><label for="q">Find a member by name, email or signup IP</label> <input type="search" id="q" name="q" value="${esc(q)}"> <button>Search</button>${q ? ' <a href="/admin">clear</a>' : ''}</form>
<div class="scroll"><table><tr><th>Site</th><th>Email</th><th>Joined</th><th>State</th><th>Signup IP</th><th>Disk</th><th>Bandwidth today</th></tr>
${users.map((u) => `<tr><td><a href="${esc(ctx.cfg.siteUrl(u.username))}" target="_blank">${esc(u.username)}</a></td><td>${esc(u.email)}</td><td>${ago(u.created_at)}</td><td>${u.banned ? 'banned' : u.verified ? 'live' : 'unverified'}</td><td>${esc(u.signup_ip)}</td><td class="num">${fmtBytes(u.disk)}</td><td class="num">${fmtBytes(u.bandwidth)}</td></tr>`).join('') || '<tr><td colspan="7">No members found.</td></tr>'}</table></div>
<h3>Signups per day</h3><div class="scroll"><table><tr><th>Day (UTC)</th><th>Signups</th></tr>
${signups.map((d) => `<tr><td>${d.day}</td><td class="num">${d.n}</td></tr>`).join('') || '<tr><td colspan="2">None in the last 14 days.</td></tr>'}</table></div>
<h3>Moderation log</h3><div class="scroll"><table><tr><th>When</th><th>Moderator</th><th>Action</th><th>Site</th><th>Details</th></tr>
${log.map((l) => `<tr><td>${ago(l.created_at)}</td><td>${esc(l.admin)}</td><td>${esc(l.action)}</td><td>${esc(l.site)}</td><td>${esc(l.detail)}</td></tr>`).join('') || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table></div>
${upgradeBox(ctx, upgrade)}</section>`);

// ---- pages served on member subdomains ----
const bare = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;padding:12px;background:#fdfeff repeating-linear-gradient(45deg,transparent 0 21px,#d6eafa 21px 22px);color:#14264f;font:15px/1.4 "Comic Sans MS","Comic Neue",cursive}a{color:#0a3fc4}h1{font:700 22px "Comic Sans MS","Comic Neue",cursive;color:#0b4f9e;margin:0 0 8px}
form{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}label{color:#0b4f9e;font-size:14px}input,textarea{font:15px "Courier New",monospace;background:#fff;color:#000;border:2px inset #2f8fd0;padding:4px;width:100%;box-sizing:border-box}
button{font:700 14px "Comic Sans MS",cursive;background:#ffe14d;color:#14264f;border:3px outset #fff3a8;padding:3px 12px;align-self:flex-start;cursor:pointer}
.e{border:2px dashed #2f8fd0;background:#fff;padding:6px 8px;margin-bottom:8px;overflow-wrap:anywhere}.e small{color:#0b4f9e}.hp{position:absolute;left:-9999px}.err{color:#b00000}</style></head><body>${body}</body></html>`;

const sitePage = (cfg, title, html) => bare(title, `<h1>${esc(title)}</h1>${html}<p><a href="${esc(cfg.BASE_URL)}">${esc(cfg.SITE_NAME)}</a></p>`);

const guestbook = (rows, err) => bare('Guestbook', `<h1>Sign the guestbook</h1>${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
<form method="post" action="/_hw/guestbook"><label for="n">Name</label><input id="n" name="name" maxlength="40" required>
<label for="m">Message</label><textarea id="m" name="message" rows="3" maxlength="500" required></textarea>
<div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div><button>Sign it!</button></form>
${rows.map((r) => `<div class="e"><small>${esc(r.name)} wrote ${ago(r.created_at)}:</small><div>${esc(r.message)}</div></div>`).join('') || '<p>No entries yet. Be the first!</p>'}`);

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

const counterSvg = (n) => {
  const d = String(n).padStart(6, '0');
  const w = d.length * 18 + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="30" viewBox="0 0 ${w} 30" role="img" aria-label="${n} hits"><rect width="${w}" height="30" fill="#14264f"/>` +
    [...d].map((c, i) => `<rect x="${4 + i * 18}" y="3" width="16" height="24" fill="#0b2a66" stroke="#2f8fd0"/><text x="${12 + i * 18}" y="22" text-anchor="middle" font-family="Courier New,monospace" font-size="20" font-weight="700" fill="#ffe14d">${c}</text>`).join('') + '</svg>';
};

module.exports = { layout, home, browse, profile, feed, signup, login, forgot, reset, notice, dashboard, starterConfirm, links, editor, styleEditor, move, guestbookAdmin, report, rules, privacy, admin, sitePage, guestbook, counterSvg, atom };
