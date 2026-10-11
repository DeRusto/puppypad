// Starter layouts a new member picks at signup. Each one becomes their index.html.
const fs = require('fs');
const path = require('path');
const { esc } = require('./util');

const LIST = [
  { id: 'sky', name: 'Sky Blue', blurb: 'Stacked boxes on PuppyPad blue, marquee and all. The classic.' },
  { id: 'shrine', name: 'Shrine', blurb: 'Menu down the left, your stuff on the right. Pastel polka dots.' },
  { id: 'notebook', name: 'Notebook', blurb: 'A diary on ruled paper. One column of dated entries.' },
  { id: 'arcade', name: 'Arcade', blurb: 'Black and neon tiles that wrap to fit any screen.' },
];
const DEFAULT = LIST[0].id;
const html = Object.fromEntries(LIST.map((s) => [s.id, fs.readFileSync(path.join(__dirname, '..', 'templates', `${s.id}.html`), 'utf8')]));

const valid = (id) => typeof id === 'string' && Object.hasOwn(html, id);
// name must already be a valid site name; host values come from config
const render = (id, name, cfg) => html[valid(id) ? id : DEFAULT]
  .replaceAll('{{NAME}}', name).replaceAll('{{HOST_NAME}}', esc(cfg.SITE_NAME)).replaceAll('{{HOST_URL}}', cfg.BASE_URL);

// the gallery preview lives on the main site, where the counter and guestbook don't exist; stand-ins keep it looking right
const COUNTER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="20"><rect width="88" height="20" fill="#000"/><text x="44" y="15" fill="#39ff14" font-family="monospace" font-size="14" text-anchor="middle">0001337</text></svg>')}`;
const preview = (id, cfg) => render(id, 'yourname', cfg)
  .replaceAll('src="/_hw/counter.svg"', `src="${COUNTER}"`)
  .replaceAll('src="/_hw/guestbook"', 'srcdoc="&lt;p style=&quot;font:14px sans-serif;padding:8px&quot;&gt;Your guestbook shows up here.&lt;/p&gt;"');

module.exports = { LIST, DEFAULT, valid, render, preview };
