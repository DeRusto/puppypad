const { esc, fmtBytes, TEXT_EXT, extOf } = require('./util');

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
background:radial-gradient(ellipse 46% 60% at 50% 62%,var(--pee) 0 60%,transparent 62%)}
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
input[type=text],input[type=email],input[type=password],input[type=file],textarea,select{font:15px "Courier New",monospace;background:#fff;color:#000;border:2px inset var(--edge);padding:4px;width:100%;max-width:100%}
textarea.code{min-height:60vh;white-space:pre;tab-size:2}
button{font:700 14px "Comic Sans MS","Comic Neue",cursive;background:var(--pee);color:var(--ink);border:3px outset #fff3a8;padding:3px 12px;cursor:pointer;align-self:flex-start}
button:active{border-style:inset}
button.link{background:none;border:0;color:var(--link);text-decoration:underline;padding:0;font-weight:400}
button.danger{background:#c0392b;color:#fff;border-color:#e9a59d}
.err{background:#ffdcdc;color:#7a0000;border:2px solid #c00;padding:6px 10px}
.ok{background:#dff7df;color:#0b4d0b;border:2px solid #1a8f1a;padding:6px 10px}
.hp{position:absolute;left:-9999px}
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
`;

function layout(ctx, title, body, opts = {}) {
  const { cfg, user, csrf } = ctx;
  const nav = [
    `<a href="/">Home</a>`, `<a href="/browse">Dog park</a>`, `<a href="/random">Fetch a random pad</a>`, `<a href="/rules">Rules</a>`,
    ...(user
      ? [`<a href="/feed">Feed</a>`, `<a href="/dashboard">My pad</a>`, ...(ctx.isAdmin ? [`<a href="/admin">Admin</a>`] : []),
        `<form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Log out (${esc(user.username)})</button></form>`]
      : [`<a href="/signup">Get a free pad</a>`, `<a href="/login">Log in</a>`]),
  ].join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ${esc(cfg.SITE_NAME)}</title><style>${CSS}</style>${opts.head || ''}</head><body><div class="site${opts.wide ? ' wide' : ''}">
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
const cards = (ctx, rows) => (rows.length
  ? `<ul class="grid">${rows.map((r) => `<li class="card">${shotImg(ctx, r, ctx.cfg.siteUrl(r.username))}
<div><a href="${esc(ctx.cfg.siteUrl(r.username))}"><b>${esc(r.username)}</b></a> <a href="/site/${esc(r.username)}" class="t">[profile]</a></div>
${r.tagline ? `<div class="t">${esc(r.tagline)}</div>` : ''}
<div class="t">updated ${ago(r.updated_at)} | ${r.followers} follower${r.followers === 1 ? '' : 's'} | ${r.hits} hits</div></li>`).join('')}</ul>`
  : `<p>The pad is clean. Make the first mess.</p>`);

const home = (ctx, { recent, newest, total }) => layout(ctx, 'Home', `
<section class="box"><h2>Your own pad on the web</h2>
<p>Sign up and you get <code>yourname.${esc(ctx.cfg.BASE_HOST)}</code>, ${ctx.cfg.QUOTA_MB} MB of space, a code editor with live preview, a hit counter and a guestbook. No templates, no algorithm. Write your own HTML, and do not worry about making a mess. That is what the pad is for.</p>
<p><a href="/signup">Claim your pad</a> | ${total} pad${total === 1 ? '' : 's'} in use so far</p></section>
<section class="box"><h2>Fresh accidents <small>(recently updated)</small></h2>${cards(ctx, recent)}<p style="margin-top:10px"><a href="/browse">See them all &gt;&gt;</a></p></section>
<section class="box"><h2>New puppies <small>(just joined)</small></h2>${siteList(ctx, newest)}</section>`);

const SORT_LABELS = { updated: 'Recently updated', newest: 'Newest', followed: 'Most followed', hits: 'Most visited' };
const browse = (ctx, { rows, page, pages, sort }) => layout(ctx, 'Dog park', `
<section class="box"><h2>The dog park <small>(page ${page} of ${pages})</small></h2>
<p class="sorts">Sort: ${Object.entries(SORT_LABELS).map(([k, l]) => (k === sort ? `<b>${l}</b>` : `<a href="/browse?sort=${k}">${l}</a>`)).join(' ')}</p>
${cards(ctx, rows)}
<p style="margin-top:10px">${page > 1 ? `<a href="/browse?sort=${sort}&amp;page=${page - 1}">&lt;&lt; Prev</a>` : ''} ${page < pages ? `<a href="/browse?sort=${sort}&amp;page=${page + 1}">Next &gt;&gt;</a>` : ''}</p></section>`, { wide: true });

const EVENT_TEXT = { update: 'left a fresh update on their pad', join: 'joined' };
const nameLinks = (rows) => (rows.length ? `<div class="names">${rows.map((r) => `<a href="/site/${esc(r.username)}">${esc(r.username)}</a>`).join('')}</div>` : '<p class="note">Nobody yet.</p>');
const profile = (ctx, m, { p, following, events, followers, follows }) => {
  const url = ctx.cfg.siteUrl(p.username);
  const mine = ctx.user && ctx.user.id === p.id;
  return layout(ctx, p.username, `
<section class="box"><h2>${esc(p.username)}</h2>${msg(m)}<div class="prof">
<div class="pic">${shotImg(ctx, p, url)}</div>
<div class="info"><p><a href="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</a></p>
${p.tagline ? `<p>${esc(p.tagline)}</p>` : ''}
<p>${p.followers} follower${p.followers === 1 ? '' : 's'} | ${p.updates} update${p.updates === 1 ? '' : 's'} | ${p.hits} hits<br>Joined ${ago(p.created_at)}, last updated ${ago(p.updated_at)}</p>
${mine ? '<p><a href="/dashboard">Edit my site</a></p>' : `<form class="inline" method="post" action="/follow">${csrfField(ctx)}<input type="hidden" name="site" value="${esc(p.username)}">
<button name="action" value="${following ? 'unfollow' : 'follow'}">${following ? 'Unfollow' : ctx.user ? 'Follow' : 'Log in to follow'}</button></form>
<p style="margin-top:10px"><a href="/report?site=${esc(p.username)}">Report this site</a></p>`}</div></div></section>
<section class="box"><h2>Recent activity</h2>${events.length ? `<ul>${events.map((e) => `<li>${EVENT_TEXT[e.kind] || esc(e.kind)} ${ago(e.created_at)}</li>`).join('')}</ul>` : '<p class="note">Nothing yet.</p>'}</section>
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
<input type="password" id="emailpw" name="password" required autocomplete="current-password"><button>Change email</button></form></section>` : ''}`);
};

const feed = (ctx, { events, count }) => layout(ctx, 'Feed', `
<section class="box"><h2>Your feed</h2>
${events.length ? `<ul class="feed">${events.map((e) => `<li>${shotImg(ctx, e, ctx.cfg.siteUrl(e.username))}<div><a href="${esc(ctx.cfg.siteUrl(e.username))}"><b>${esc(e.username)}</b></a> ${EVENT_TEXT[e.kind] || esc(e.kind)} ${ago(e.created_at)}${e.tagline ? `<div class="note">${esc(e.tagline)}</div>` : ''}</div></li>`).join('')}</ul>`
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
<div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label><input type="checkbox" name="agree" value="1" required> I am 13 or older and have read the <a href="/rules" target="_blank">rules</a> and <a href="/privacy" target="_blank">privacy notice</a></label>
${ctx.cfg.TURNSTILE_SITE_KEY ? `<div class="cf-turnstile" data-sitekey="${esc(ctx.cfg.TURNSTILE_SITE_KEY)}"></div>` : ''}
<button>Roll out my pad</button></form></section>`, ctx.cfg.TURNSTILE_SITE_KEY ? { head: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' } : {});

const login = (ctx, m, v = {}) => layout(ctx, 'Log in', `
<section class="box"><h2>Log in</h2>${msg(m)}
<form class="stack" method="post" action="/login">
<label for="username">Site name</label><input type="text" id="username" name="username" value="${esc(v.username)}" required autocapitalize="none" autocomplete="username">
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

const notice = (ctx, title, html) => layout(ctx, title, `<section class="box"><h2>${esc(title)}</h2>${html}</section>`);

// Drag-and-drop and many-file uploads: sends the files 20 at a time with a progress bar, then reloads the folder with the totals.
// Without JavaScript the form above still posts normally (20 files at most).
const UPLOADER = `<script>(function(){
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
function send(list){
  if(busy||!list.length)return;busy=true;
  var files=[],skipped=[],saved=0;
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
drop.addEventListener('drop',function(e){send(Array.prototype.slice.call(e.dataTransfer.files).filter(function(f){return f.size||f.type}))});
})();</script>`;

function dashboard(ctx, m, d) {
  const { cfg, user } = ctx;
  const url = cfg.siteUrl(user.username);
  const up = d.dir ? d.dir.split('/').slice(0, -1).join('/') : null;
  const rows = [
    ...(up !== null ? [`<tr><td><a href="/dashboard?dir=${encodeURIComponent(up)}">[ up one folder ]</a></td><td></td><td></td></tr>`] : []),
    ...d.entries.map((e) => {
      const rel = d.dir ? `${d.dir}/${e.name}` : e.name;
      if (e.dir) return `<tr><td><a href="/dashboard?dir=${encodeURIComponent(rel)}">[${esc(e.name)}]</a></td><td class="num">folder</td><td></td></tr>`;
      return `<tr><td><a href="${esc(url)}/${esc(rel)}" target="_blank">${esc(e.name)}</a></td><td class="num">${fmtBytes(e.size)}</td><td>
${TEXT_EXT.has(extOf(e.name)) ? `<a href="/dashboard/edit?path=${encodeURIComponent(rel)}">edit</a> | ` : ''}
<form class="inline" method="post" action="/dashboard/delete">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}"><button class="link">delete</button></form></td></tr>`;
    }),
  ].join('');
  return layout(ctx, 'My pad', `
<section class="box"><h2>My pad</h2>${msg(m)}
${user.banned ? `<p class="err">This site was taken down by a moderator${user.ban_reason ? `: ${esc(user.ban_reason)}` : '.'} Editing is disabled. Contact ${esc(cfg.ABUSE_EMAIL)} to appeal.</p>` : ''}
<p>Address: <a href="${esc(url)}" target="_blank">${esc(url)}</a><br>Space used: ${fmtBytes(d.used.total)} of ${cfg.QUOTA_MB} MB in ${d.used.count} file${d.used.count === 1 ? '' : 's'} | ${user.hits} hits | <a href="/dashboard/guestbook">guestbook entries</a> | <a href="/site/${esc(user.username)}">my profile</a></p>
${d.listed || user.banned ? '' : `<p class="note">Your site is online, but it shows up in the dog park, on the home page and in the webring only after your first edit${cfg.NEW_SITE_HOURS > 0 ? ` and once it is ${cfg.NEW_SITE_HOURS} hours old` : ''}. Make it yours!</p>`}
<form class="stack" method="post" action="/dashboard/tagline">${csrfField(ctx)}<label for="tagline">One-line description for the site directory</label>
<input type="text" id="tagline" name="tagline" maxlength="100" value="${esc(user.tagline)}"><button>Save description</button></form></section>

<section class="box"><h2>Files in /${esc(d.dir)}</h2>
<div class="scroll"><table><tr><th>Name</th><th>Size</th><th>Actions</th></tr>${rows || '<tr><td colspan="3">This folder is empty.</td></tr>'}</table></div>
<h3>Upload files</h3>
<form class="stack" id="upform" method="post" action="/dashboard/upload" enctype="multipart/form-data" data-max="${cfg.MAX_FILE_MB * 1048576}">${csrfField(ctx)}<input type="hidden" name="dir" value="${esc(d.dir)}">
<div class="drop" id="drop"><label for="files">Drop files here, or pick them below. ${cfg.MAX_FILE_MB} MB each at most. Files with the same name are replaced.</label>
<input type="file" id="files" name="files" multiple required></div>
<progress id="upbar" max="1" value="0" hidden></progress><p class="note" id="upnote" role="status"></p><button>Upload</button></form>
${UPLOADER}
<h3>Import a zip</h3>
<form class="stack" method="post" action="/dashboard/import" enctype="multipart/form-data">${csrfField(ctx)}<input type="hidden" name="dir" value="${esc(d.dir)}">
<label for="zip">Moving in from another host? Zip up your site folder (up to ${cfg.ZIP_MAX_MB} MB) and it unpacks here, folders and all. Files with the same name are replaced.</label>
<input type="file" id="zip" name="zip" accept=".zip,application/zip" required><button>Import zip</button></form>
<h3>Download my site</h3>
<p>Get every file as one <a href="/dashboard/download">.zip</a>, folders and all. Handy as a backup, or to move your site somewhere else.</p>
<h3>New file or folder</h3>
<form class="stack" method="get" action="/dashboard/edit"><label for="newpath">File path, for example <code>about.html</code> or <code>pics/index.html</code>. Folders are created for you.</label>
<input type="text" id="newpath" name="path" value="${esc(d.dir ? d.dir + '/' : '')}" required><button>Create and edit</button></form></section>

<section class="box"><h2>Widgets</h2><p>Paste these into your HTML.</p>
<h3>Hit counter</h3><pre>&lt;img src="/_hw/counter.svg" alt="hit counter"&gt;</pre>
<h3>Guestbook</h3><pre>&lt;iframe src="/_hw/guestbook" width="100%" height="420"&gt;&lt;/iframe&gt;</pre>
<h3>Webring</h3><pre>&lt;a href="${esc(cfg.BASE_URL)}/webring/prev?from=${esc(user.username)}"&gt;&amp;lt;&amp;lt; Prev&lt;/a&gt; |
&lt;a href="${esc(cfg.BASE_URL)}/webring/random"&gt;Random&lt;/a&gt; |
&lt;a href="${esc(cfg.BASE_URL)}/webring/next?from=${esc(user.username)}"&gt;Next &amp;gt;&amp;gt;&lt;/a&gt;</pre>
<h3>Custom 404 page</h3><p>Upload a file named <code>not_found.html</code>.</p></section>

<section class="box"><h2>Delete my account</h2><p>This removes your site, files and guestbook for good.</p>
<form class="stack" method="post" action="/dashboard/delete-account">${csrfField(ctx)}<label for="delpw">Confirm with your password</label>
<input type="password" id="delpw" name="password" required autocomplete="current-password"><button class="danger">Delete everything</button></form></section>`);
}

const CM = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16';
const CM_MODE = { html: 'htmlmixed', htm: 'htmlmixed', svg: 'xml', xml: 'xml', css: 'css', js: 'javascript', json: { name: 'javascript', json: true }, md: 'markdown' };
const editor = (ctx, m, { rel, content, isNew }) => {
  const ext = extOf(rel);
  const isHtml = ext === 'html' || ext === 'htm';
  const dir = rel.split('/').slice(0, -1).join('/');
  const siteBase = `${ctx.cfg.siteUrl(ctx.user.username)}/${dir ? dir + '/' : ''}`;
  const head = `<link rel="stylesheet" href="${CM}/codemirror.min.css"><link rel="stylesheet" href="${CM}/theme/material-darker.min.css">`;
  return layout(ctx, `Edit ${rel}`, `
<section class="box"><h2>${isNew ? 'New file' : 'Editing'}: ${esc(rel)}</h2>${msg(m)}
<form id="edform" method="post" action="/dashboard/save" style="display:flex;flex-direction:column;gap:8px">${csrfField(ctx)}<input type="hidden" name="path" value="${esc(rel)}">
<div class="edwrap"><div><label for="content">Code (Ctrl+S or Cmd+S saves)</label><textarea class="code" id="content" name="content" spellcheck="false">${esc(content)}</textarea></div>
${isHtml ? '<div><label for="preview">Live preview (unsaved)</label><iframe class="preview" id="preview" title="Live preview" sandbox="allow-scripts"></iframe></div>' : ''}</div>
<div><button>Save</button> <a href="/dashboard?dir=${encodeURIComponent(dir)}">Back to files</a> | <a href="${esc(ctx.cfg.siteUrl(ctx.user.username))}/${esc(rel)}" target="_blank">View saved page</a></div></form></section>
<script src="${CM}/codemirror.min.js"></script><script src="${CM}/mode/xml/xml.min.js"></script><script src="${CM}/mode/javascript/javascript.min.js"></script>
<script src="${CM}/mode/css/css.min.js"></script><script src="${CM}/mode/htmlmixed/htmlmixed.min.js"></script><script src="${CM}/mode/markdown/markdown.min.js"></script>
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

const guestbookAdmin = (ctx, m, rows) => layout(ctx, 'Guestbook entries', `
<section class="box"><h2>Guestbook entries</h2>${msg(m)}<p><a href="/dashboard">Back to my site</a></p>
<div class="scroll"><table><tr><th>When</th><th>Name</th><th>Message</th><th></th></tr>
${rows.map((r) => `<tr><td>${ago(r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.message)}</td><td><form class="inline" method="post" action="/dashboard/guestbook/delete">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="link">delete</button></form></td></tr>`).join('') || '<tr><td colspan="4">Nobody has signed yet.</td></tr>'}
</table></div></section>`);

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
<p>Questions about these terms or the <a href="/privacy">privacy notice</a>: ${mail}.</p></section>`);
};

const privacy = (ctx) => layout(ctx, 'Privacy', `
<section class="box"><h2>Privacy notice</h2>
<p>${esc(ctx.cfg.SITE_NAME)} keeps as little about you as it can run on.</p>
<h3>What we store</h3>
<ul>
<li><b>Your account:</b> site name, email address, and a scrambled (hashed) copy of your password. We use your email only for confirmation, password resets and messages about your site.</li>
<li><b>Your site:</b> the files you upload, your description, your hit count, who you follow, and a screenshot of your front page for the directory.</li>
<li><b>Network addresses:</b> the IP address you signed up from, and the IP address behind each guestbook entry and abuse report. These help us stop spam and abuse.</li>
<li><b>One cookie</b> that keeps you logged in. No tracking or advertising cookies.</li>
</ul>
<h3>Who else sees it</h3>
<p>Your site, its files, your site name, description, followers and hit count are public. Guestbook entries are public on the site they were left on. We do not sell or share your data. Our email provider delivers our messages${ctx.cfg.TURNSTILE_SITE_KEY ? ', and Cloudflare Turnstile checks that people signing up are human' : ''}.</p>
<h3>Deleting it</h3>
<p>Delete your account from your dashboard and your files, guestbook and account details are removed right away. Backups roll over within 14 days. Your site name stays reserved for 90 days so nobody else can pretend to be you.</p>
<p>Questions: ${esc(ctx.cfg.ABUSE_EMAIL)}.</p>
<p class="note">Review this page before you launch and make it match what you actually run. It is a starting point, not legal advice.</p></section>`);

const admin = (ctx, m, { reports, users, stats }) => layout(ctx, 'Admin', `
<section class="box"><h2>Moderation</h2>${msg(m)}<p>${stats.users} members, ${stats.banned} banned, ${stats.open} open reports.</p>
<h3>Open reports</h3><div class="scroll"><table><tr><th>When</th><th>Site</th><th>Reason</th><th>Details</th><th>From</th><th></th></tr>
${reports.map((r) => `<tr><td>${ago(r.created_at)}</td><td><a href="${esc(ctx.cfg.siteUrl(r.site))}" target="_blank">${esc(r.site)}</a></td><td>${esc(r.reason)}</td><td>${esc(r.details)}</td><td>${esc(r.reporter_email || '')}<br><small>${esc(r.ip)}</small></td>
<td><form class="inline" method="post" action="/admin/report-close">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="link">close</button></form></td></tr>`).join('') || '<tr><td colspan="6">Queue is empty.</td></tr>'}</table></div>
<h3>Take a site down or restore it</h3>
<form class="stack" method="post" action="/admin/ban">${csrfField(ctx)}<label for="bsite">Site name</label><input type="text" id="bsite" name="site" required>
<label for="breason">Reason shown to the member</label><input type="text" id="breason" name="reason" maxlength="200">
<div><button name="action" value="ban" class="danger">Take down</button> <button name="action" value="unban">Restore</button> <button name="action" value="delete" class="danger">Delete account and files</button></div></form>
<h3>Newest members</h3><div class="scroll"><table><tr><th>Site</th><th>Email</th><th>Joined</th><th>State</th><th>Signup IP</th></tr>
${users.map((u) => `<tr><td><a href="${esc(ctx.cfg.siteUrl(u.username))}" target="_blank">${esc(u.username)}</a></td><td>${esc(u.email)}</td><td>${ago(u.created_at)}</td><td>${u.banned ? 'banned' : u.verified ? 'live' : 'unverified'}</td><td>${esc(u.signup_ip)}</td></tr>`).join('')}</table></div></section>`);

// ---- pages served on member subdomains ----
const bare = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
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

const counterSvg = (n) => {
  const d = String(n).padStart(6, '0');
  const w = d.length * 18 + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="30" viewBox="0 0 ${w} 30" role="img" aria-label="${n} hits"><rect width="${w}" height="30" fill="#14264f"/>` +
    [...d].map((c, i) => `<rect x="${4 + i * 18}" y="3" width="16" height="24" fill="#0b2a66" stroke="#2f8fd0"/><text x="${12 + i * 18}" y="22" text-anchor="middle" font-family="Courier New,monospace" font-size="20" font-weight="700" fill="#ffe14d">${c}</text>`).join('') + '</svg>';
};

module.exports = { layout, home, browse, profile, feed, signup, login, forgot, reset, notice, dashboard, editor, guestbookAdmin, report, rules, privacy, admin, sitePage, guestbook, counterSvg };
