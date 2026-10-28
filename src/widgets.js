// Widgets: what the /_hw/ routes draw (src/server.js serves them), the galleries members pick from, and the snippets /dashboard/widgets hands out.
// Every widget is a plain snippet the member pastes or inserts themselves; nothing is ever written into their pages for them.
const fs = require('fs');
const path = require('path');
const { esc } = require('./util');

const ASSETS = path.join(__dirname, 'assets');
// tiling backgrounds for the style editor; each is ours to give away (see assets/bg/CREDITS.md).
// The see-through ones are the patterns PuppyPad and the starters already use, so they take on the member's page colour
const BACKGROUNDS = [
  { id: 'paws', name: 'Paw prints (the PuppyPad look)' }, { id: 'dots', name: 'Polka dots (from Shrine)' }, { id: 'grid', name: 'Grid lines (from Arcade)' },
  { id: 'notebook', name: 'Ruled lines (from Notebook)' }, { id: 'stripes', name: 'Diagonal stripes (from Sky Blue)' },
  { id: 'stars', name: 'Stars' }, { id: 'clouds', name: 'Clouds' }, { id: 'checkers', name: 'Checkerboard' },
];
const BUTTONS = [
  { id: 'made-with', name: 'Made with PuppyPad' }, { id: 'best-viewed', name: 'Best viewed with eyes' },
  { id: 'under-construction', name: 'Under construction' }, { id: 'html-handmade', name: 'HTML made by hand' },
  { id: 'no-cookies', name: 'No cookies' }, { id: 'good-dog', name: 'Good dog' },
].map((b) => ({ ...b, w: 88, h: 31 }));
const STAMPS = [
  { id: 'stamp-dogs', name: 'I love dogs' }, { id: 'stamp-oldweb', name: 'Old web forever' }, { id: 'stamp-tea', name: 'Fuelled by tea' },
].map((b) => ({ ...b, w: 99, h: 56 }));
const EFFECTS = [{ id: 'sparkle', name: 'Sparkle cursor' }, { id: 'snow', name: 'Falling snow' }];
const GB_THEMES = {
  classic: { name: 'Classic', css: '' },
  night: { name: 'Night', css: 'body{background:#14141f;color:#d8d8f0}h1,label,.e small{color:#8ab4ff}a{color:#8ab4ff}.e{background:#1f1f30;border-color:#8ab4ff}input,textarea{background:#1f1f30;color:#d8d8f0}' },
  notebook: { name: 'Notebook', css: 'body{background:#fffef6 repeating-linear-gradient(transparent 0 27px,#a9c8ec 27px 28px);color:#26324a;font-family:"Courier New",monospace}h1,label,.e small{color:#1d56c9}.e{background:transparent;border:0;border-bottom:1px dashed #a9c8ec}' },
  pastel: { name: 'Pastel', css: 'body{background:#fde4f2;color:#4b2a5a;font-family:Verdana,sans-serif}h1,label,.e small{color:#7a3fd1}.e{border-color:#e79acb}button{background:#c9b3ff;border-color:#e6dcff}' },
  arcade: { name: 'Arcade', css: 'body{background:#000;color:#39ff14;font-family:"Courier New",monospace}h1,label,.e small{color:#ff00ff}.e{background:#000;border:2px solid #39ff14}input,textarea{background:#000;color:#39ff14;border-color:#ff00ff}button{background:#ff00ff;color:#000;border-color:#ff7aff}' },
};
const gbTheme = (t) => (typeof t === 'string' && Object.hasOwn(GB_THEMES, t) ? t : 'classic');

const svgUri = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const counterSvg = (n) => {
  const d = String(n).padStart(6, '0');
  const w = d.length * 18 + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="30" viewBox="0 0 ${w} 30" role="img" aria-label="${n} hits"><rect width="${w}" height="30" fill="#14264f"/>` +
    [...d].map((c, i) => `<rect x="${4 + i * 18}" y="3" width="16" height="24" fill="#0b2a66" stroke="#2f8fd0"/><text x="${12 + i * 18}" y="22" text-anchor="middle" font-family="Courier New,monospace" font-size="20" font-weight="700" fill="#ffe14d">${c}</text>`).join('') + '</svg>';
};
// one line of monospace text in a box; monospace so the width can be worked out from the length
const lineSvg = (text) => {
  const w = [...text].length * 7 + 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img" aria-label="${esc(text)}"><rect x=".5" y=".5" width="${w - 1}" height="19" fill="#14264f" stroke="#2f8fd0"/><text x="7" y="14" font-family="Courier New,monospace" font-size="12" fill="#ffe14d">${esc(text)}</text></svg>`;
};
const updatedSvg = (t) => lineSvg(`updated ${new Date(t).toISOString().slice(0, 10)}`);
const statusSvg = (status) => lineSvg(status || '...');
// one short line, no control characters
const cleanStatus = (s) => String(s || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

// the widgets page, group by group; each item's snippet is what "Add to a page" inserts, looked up by its id.
// A list entry marked early: true is a supporters' first look: only they see it until the mark comes off
function groups(cfg, user, supporter = false) {
  const base = cfg.BASE_URL;
  const site = cfg.siteUrl(user.username);
  const img = (src, alt, extra = '') => `<img src="${src}" alt="${esc(alt)}"${extra}>`;
  const gallery = (list) => list.map((b) => ({
    id: b.id, name: b.name, early: b.early, preview: `/assets/buttons/${b.id}.svg`, w: b.w, h: b.h,
    snippet: `<a href="${base}">${img(`${base}/assets/buttons/${b.id}.svg`, b.name, ` width="${b.w}" height="${b.h}"`)}</a>`,
  }));
  return [
    { id: 'counter', title: 'Hit counter', about: 'Counts visitors, once an hour each.',
      items: [{ id: 'counter', name: 'Hit counter', preview: svgUri(counterSvg(user.hits)), snippet: img('/_hw/counter.svg', 'hit counter') }] },
    { id: 'guestbook', title: 'Guestbook', about: 'Visitors sign it; you approve entries with links and delete the rest under <a href="/dashboard/guestbook">guestbook entries</a>. Pick a look:',
      items: Object.entries(GB_THEMES).map(([t, th]) => ({ id: t === 'classic' ? 'guestbook' : `guestbook-${t}`, name: `${th.name} guestbook`, see: `${site}/_hw/guestbook${t === 'classic' ? '' : `?theme=${t}`}`,
        snippet: `<iframe src="/_hw/guestbook${t === 'classic' ? '' : `?theme=${t}`}" width="100%" height="420" title="Guestbook"></iframe>` })) },
    { id: 'updated', title: '"Last updated" badge', about: 'Shows the day you last changed your site.',
      items: [{ id: 'updated', name: 'Last updated badge', preview: svgUri(updatedSvg(user.updated_at)), snippet: img('/_hw/updated.svg', 'last updated') }] },
    { id: 'status', title: 'Status line', about: 'One short line about what you are up to. Change it here any time and every page showing it changes too.',
      items: [{ id: 'status', name: 'Status line', preview: svgUri(statusSvg(user.status)), snippet: img('/_hw/status.svg', 'my status') }] },
    { id: 'webring', title: 'Webring bar', about: 'Prev, random and next links around the webring.',
      items: [{ id: 'webring', name: 'Webring bar', snippet: `<p class="webring"><a href="${base}/webring/prev?from=${user.username}">&lt;&lt; Prev</a> | <a href="${base}/webring/random">Random</a> | <a href="${base}/webring/next?from=${user.username}">Next &gt;&gt;</a></p>` }] },
    { id: 'buttons', title: '88×31 buttons', about: 'Little buttons that link back here.', items: gallery(BUTTONS) },
    { id: 'stamps', title: 'Stamps', about: 'Say something about yourself.', items: gallery(STAMPS) },
    { id: 'effects', title: 'Effects', about: 'Small scripts that run on your pages. Copy one into your site first, then add it to a page. Visitors who ask their browser for less motion don\'t see them.',
      items: EFFECTS.map((e) => ({ id: e.id, name: e.name, early: e.early, see: `/assets/fx/${e.id}.js`, snippet: `<script src="/${e.id}.js"></script>` })) },
  ].map((g) => ({ ...g, items: g.items.filter((i) => supporter || !i.early) })).filter((g) => g.items.length);
}
const snippet = (cfg, user, id, supporter) => groups(cfg, user, supporter).flatMap((g) => g.items).find((i) => i.id === id) || null;
const effectSource = (id) => (EFFECTS.some((e) => e.id === id) ? fs.readFileSync(path.join(ASSETS, 'fx', `${id}.js`), 'utf8') : null);

// the gallery files under src/assets that /assets/<kind>/<file> serves; nothing else there is handed out
const ASSET_FILES = new Set([
  ...BACKGROUNDS.map((b) => `bg/${b.id}.svg`), ...[...BUTTONS, ...STAMPS].map((b) => `buttons/${b.id}.svg`), ...EFFECTS.map((e) => `fx/${e.id}.js`),
]);

module.exports = { BACKGROUNDS, BUTTONS, STAMPS, EFFECTS, GB_THEMES, gbTheme, counterSvg, updatedSvg, statusSvg, cleanStatus, groups, snippet, effectSource, ASSET_FILES };
