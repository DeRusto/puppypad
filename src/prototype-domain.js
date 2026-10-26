// PROTOTYPE, throwaway: three layouts for the custom domain dashboard flow (wayfinder ticket #154).
// Served at /dashboard/domain-prototype?variant=A|B|C&state=...&host=..., outside production only.
// Nothing here touches DNS, the database or Caddy: every button just moves to another stubbed state.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const VARIANTS = { A: 'Own page', B: 'On the dashboard', C: 'Step by step' };
const STATES = {
  notsupporter: 'Not a supporter',
  none: 'Supporter, no domain yet',
  'pending-txt': 'Pending: TXT not found',
  'pending-points': 'Pending: TXT ok, points elsewhere',
  verified: 'Verified: waiting on HTTPS',
  live: 'Live',
  'live-miss': 'Live, 1 failed check',
  failing: 'Failing (3 misses)',
  expired: 'Pending expired (7 days)',
  grace: 'Support lapsed: grace',
  detached: 'Detached after lapse',
  moved: 'Taken over by another site',
  banned: 'Site taken down',
};
const OURS = ['203.0.113.7', '2001:db8::7'];
const TOKEN = 'puppypad-verify=k3T9vQ2mXa7LpW4z';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// shortcut: two labels = apex; real code needs the public suffix list (co.uk etc.)
const isApex = (host) => host.split('.').length === 2;

// what the DNS checks found, per state
function found(state, host) {
  const txt = !['pending-txt', 'expired'].includes(state);
  const points = !['pending-txt', 'pending-points', 'expired'].includes(state);
  const failingNow = ['live-miss', 'failing'].includes(state);
  return {
    txt: failingNow ? true : txt,
    addrs: failingNow || !points ? ['198.51.100.20'] : OURS,
    points: failingNow ? false : points,
    https: ['live', 'grace', 'banned'].includes(state),
    host,
  };
}

// one line per state, shared by every layout: the copy is part of the question
function status(state, host, site) {
  const h = `<b>${esc(host)}</b>`;
  return {
    notsupporter: ['note', `Supporters can show this site at a domain they own, like <code>www.example.com</code>. <a href="/dashboard/support">Become a supporter</a>.`],
    none: ['note', 'Show this site at a domain you own. You keep the domain at your registrar; we only need two DNS records.'],
    'pending-txt': ['err', `Waiting for ${h}. We can't find the TXT record yet. DNS changes can take up to a few hours. We check every hour, or press Check now. This claim lapses on ${day(6)} if it isn't verified.`],
    'pending-points': ['err', `Waiting for ${h}. The TXT record is in place, but ${h} points at 198.51.100.20, not at us. Fix the record below and check again.`],
    verified: ['note', `${h} is yours and points at us. We're getting its HTTPS certificate now, which usually takes under a minute.`],
    live: ['ok', `${h} is live. Visitors to ${esc(site)} are sent there.`],
    'live-miss': ['err', `${h} is still live, but today's check failed: it points at 198.51.100.20. Leave the records below in place. After 2 more failed daily checks, visitors stop being sent there.`],
    failing: ['err', `${h} stopped working on ${day(-1)}: it no longer points at us. Your site is back at ${esc(site)}. Put the records back and press Check now. If nothing changes, we let go of ${h} on ${day(29)}, and another site could claim it before then.`],
    expired: ['err', `${h} was never verified, so we dropped the claim on ${day(-1)}. Add it again to get a new TXT record.`],
    grace: ['err', `Your support ended on ${day(-5)}. ${h} keeps working until ${day(25)}, then your site goes back to ${esc(site)}. <a href="/dashboard/support">Renew support</a> to keep it.`],
    detached: ['note', `${h} was removed on ${day(-2)} because support ended 30 days before. Your site is at ${esc(site)}. Supporters can add a domain again.`],
    moved: ['err', `${h} stopped pointing at us, and another site proved it owns it on ${day(-1)}. It no longer shows your site, which is back at ${esc(site)}.`],
    banned: ['err', `This site was taken down, so ${h} shows the takedown notice too. It comes back if the takedown is lifted.`],
  }[state];
}
const line = ([tone, html]) => `<p class="${tone}" role="status">${html}</p>`;
const hasClaim = (state) => !['notsupporter', 'none', 'expired', 'detached', 'moved'].includes(state);
const go = (q, state) => `?variant=${q.variant}&host=${encodeURIComponent(q.host)}&state=${state}`;
const tick = (ok) => (ok ? '<b class="ok">yes</b>' : '<b class="err">no</b>');

function records(host, f, withFound) {
  const pt = isApex(host)
    ? [['A', host, OURS[0]], ['AAAA', host, OURS[1]]]
    : [['CNAME', host, 'puppypad.org']];
  const rows = [['TXT', `_puppypad.${host}`, TOKEN, f.txt], ...pt.map((r) => [...r, f.points])];
  return `<div class="scroll"><table><tr><th>Type</th><th>Name</th><th>Value</th>${withFound ? '<th>Found?</th>' : ''}</tr>
${rows.map(([t, n, v, ok]) => `<tr><td>${t}</td><td><code>${esc(n)}</code></td><td><code>${esc(v)}</code></td>${withFound ? `<td>${tick(ok)}</td>` : ''}</tr>`).join('')}</table></div>
<p class="note">${isApex(host) ? 'This is a bare domain, so it takes A and AAAA records. If your DNS host offers ALIAS or ANAME, pointing that at <code>puppypad.org</code> works too.' : 'Some DNS hosts want the name without your domain on the end (just <code>' + esc(host.split('.')[0]) + '</code>).'} Remove any other A or AAAA records on ${esc(host)}: every address must be ours.</p>`;
}
const addForm = (q) => `<form class="stack" method="get"><input type="hidden" name="variant" value="${q.variant}"><input type="hidden" name="state" value="pending-txt">
<label for="host">Your domain, like <code>example.com</code> or <code>www.example.com</code></label><div class="row"><input type="text" id="host" name="host" value="${esc(q.host)}"><button>Add domain</button></div></form>`;
const checkNow = (q) => `<a class="button" href="${go(q, q.state === 'pending-txt' ? 'pending-points' : q.state === 'pending-points' ? 'verified' : 'live')}">Check now</a>`;
const remove = (q) => `<details class="careful"><summary>Remove ${esc(q.host)}</summary><p>Your site goes back to its own address at once and the domain is free for anyone to claim. To use it again later you'd add it again with a new TXT record.</p>
<a class="button danger" href="${go(q, 'none')}">Remove domain</a></details>`;

// A: its own page, linked from the dashboard like Card style
function variantA(q, site) {
  const f = found(q.state, q.host);
  const claim = hasClaim(q.state);
  const lastCheck = claim && !['pending-txt', 'pending-points', 'verified'].includes(q.state) ? `<p class="note">Last checked ${day(0)} 04:12. We check every day; you'll get an email if a check fails.</p>` : '';
  return `<div class="cols"><div><section class="box"><p class="crumbs"><a href="/dashboard">My pad</a> &gt; Custom domain</p><h2>Custom domain</h2>
${line(status(q.state, q.host, site))}
${q.state === 'notsupporter' || q.state === 'banned' ? '' : claim ? `<h3>DNS records</h3>${records(q.host, f, true)}${q.state === 'live' || q.state === 'grace' ? '' : checkNow(q)}${lastCheck}` : addForm(q)}
</section>${claim && q.state !== 'banned' ? `<section class="box careful"><h2>Careful</h2>${remove(q)}</section>` : ''}</div>
<div class="side"><aside class="box"><h2>How it works</h2><ol><li>Add the domain you own.</li><li>Set the TXT record so we know it's yours, and point the domain at us.</li><li>We check it and get an HTTPS certificate.</li><li>Your ${esc(site)} address then sends visitors to your domain.</li></ol>
<p class="note">Leave both records in place for as long as you use the domain: we re-check them every day.</p></aside></div></div>`;
}

// B: no new page; a status line under the site address and setup folded into the top box
function variantB(q, site, dashHtml) {
  const f = found(q.state, q.host);
  const claim = hasClaim(q.state);
  const chip = { live: 'ok', grace: 'err', 'live-miss': 'err', failing: 'err', verified: 'note', 'pending-txt': 'note', 'pending-points': 'note', banned: 'err' }[q.state];
  const label = { live: 'live', grace: 'until ' + day(25), 'live-miss': 'check failed', failing: 'failing', verified: 'getting HTTPS', 'pending-txt': 'waiting for DNS', 'pending-points': 'waiting for DNS', banned: 'taken down' }[q.state];
  const top = claim ? `<p>Your domain: <code>${esc(q.host)}</code> <b class="${chip}">[${label}]</b></p>` : '';
  const open = ['pending-txt', 'pending-points', 'live-miss', 'failing'].includes(q.state) ? ' open' : '';
  const body = q.state === 'notsupporter' ? line(status(q.state, q.host, site))
    : `${line(status(q.state, q.host, site))}${claim && q.state !== 'banned' ? `${records(q.host, f, true)}<p>${checkNow(q)}</p>${remove(q)}` : claim ? '' : addForm(q)}`;
  const block = `${top}<details${open}><summary>${claim ? 'Custom domain settings' : 'Use your own domain'}</summary>${body}</details>`;
  return dashHtml.replace(/(<a class="addr"[^>]*>[^<]*<\/a>)/, `$1\n${block}`);
}

// C: a wizard, one step at a time, then a short status page once live
function variantC(q, site) {
  const f = found(q.state, q.host);
  const step = { none: 1, 'pending-txt': 2, 'pending-points': 3, verified: 4 }[q.state];
  const bar = step ? `<p class="note">Step ${step} of 4: ${['Your domain', 'Prove it is yours', 'Point it at us', 'HTTPS'][step - 1]}</p><div class="bar"><i style="width:${step * 25}%"></i></div>` : '';
  const pt = isApex(q.host) ? [['A', q.host, OURS[0]], ['AAAA', q.host, OURS[1]]] : [['CNAME', q.host, 'puppypad.org']];
  const table = (rows) => `<div class="scroll"><table><tr><th>Type</th><th>Name</th><th>Value</th></tr>${rows.map(([t, n, v]) => `<tr><td>${t}</td><td><code>${esc(n)}</code></td><td><code>${esc(v)}</code></td></tr>`).join('')}</table></div>`;
  let body;
  if (q.state === 'notsupporter' || q.state === 'banned') body = line(status(q.state, q.host, site));
  else if (step === 1 || ['expired', 'detached', 'moved'].includes(q.state)) body = `${q.state === 'none' ? '' : line(status(q.state, q.host, site))}<h3>Which domain?</h3>${addForm(q)}`;
  else if (step === 2) body = `<h3>Prove ${esc(q.host)} is yours</h3><p>At the company that runs DNS for ${esc(q.host)}, add this record:</p>${table([['TXT', `_puppypad.${q.host}`, TOKEN]])}
<p class="note">Keep it there for as long as you use the domain.</p>${f.txt ? '' : '<p class="err">Not found yet. DNS changes can take a while.</p>'}<p>${checkNow(q)} <a href="${go(q, 'none')}">Start over</a></p>`;
  else if (step === 3) body = `<p class="ok">TXT record found.</p><h3>Point ${esc(q.host)} at us</h3>${table(pt)}
<p class="err">${esc(q.host)} points at ${f.addrs.join(', ')} right now. Every address must be ours, so remove any others.</p><p>${checkNow(q)}</p>`;
  else if (step === 4) body = `<p class="ok">TXT record found. ${esc(q.host)} points at us.</p><h3>Getting your certificate</h3>${line(status(q.state, q.host, site))}<p><a class="button" href="${go(q, 'live')}">Refresh</a></p>`;
  else body = `${line(status(q.state, q.host, site))}<p>Records we check every day:</p>${records(q.host, f, true)}${q.state === 'live' || q.state === 'grace' ? '' : `<p>${checkNow(q)}</p>`}${remove(q)}`;
  return `<section class="box"><p class="crumbs"><a href="/dashboard">My pad</a> &gt; Custom domain</p><h2>Custom domain</h2>${bar}${body}</section>`;
}

function bar(q, nonce) {
  const keys = Object.keys(VARIANTS);
  const i = keys.indexOf(q.variant);
  const to = (v) => `?variant=${v}&host=${encodeURIComponent(q.host)}&state=${q.state}`;
  return `<div id="proto" style="position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:999px;box-shadow:0 4px 16px #0006;font:14px sans-serif;display:flex;gap:10px;align-items:center;z-index:99;white-space:nowrap;max-width:96vw">
<a style="color:#fff" href="${to(keys[(i + keys.length - 1) % keys.length])}" id="prev">&larr;</a><b>${q.variant} (${VARIANTS[q.variant]})</b><a style="color:#fff" href="${to(keys[(i + 1) % keys.length])}" id="next">&rarr;</a>
<select id="pstate">${Object.entries(STATES).map(([k, v]) => `<option value="${k}"${k === q.state ? ' selected' : ''}>${v}</option>`).join('')}</select>
<a style="color:#fff" href="?variant=${q.variant}&state=${q.state}&host=${isApex(q.host) ? 'www.' + q.host : q.host.split('.').slice(1).join('.')}">${isApex(q.host) ? 'try subdomain' : 'try apex'}</a></div>
<script nonce="${nonce}">
document.getElementById('pstate').onchange = (e) => { const u = new URL(location); u.searchParams.set('state', e.target.value); location = u; };
addEventListener('keydown', (e) => { if (e.target.closest('input,textarea,select,[contenteditable]')) return;
  if (e.key === 'ArrowLeft') location = document.getElementById('prev').href; if (e.key === 'ArrowRight') location = document.getElementById('next').href; });
</script>`;
}

// dashHtml: the real dashboard page, for variant B; layout: views.layout
function render(ctx, query, dashHtml, layout) {
  const q = {
    variant: VARIANTS[query.variant] ? query.variant : 'A',
    state: STATES[query.state] ? query.state : 'none',
    host: String(query.host || 'www.rexsden.com').toLowerCase(),
  };
  const site = ctx.cfg.siteUrl(ctx.user.username).replace(/^https?:\/\//, '');
  const page = q.variant === 'B' ? variantB(q, site, dashHtml) : layout(ctx, 'Custom domain', q.variant === 'A' ? variantA(q, site) : variantC(q, site), { noindex: true });
  return page.replace('</body>', `${bar(q, ctx.nonce)}</body>`);
}

module.exports = { render };
