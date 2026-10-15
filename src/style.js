// The style editor: its settings, its presets, and the puppypad.css it writes.
// Every value comes from a fixed list or a strict pattern, so nothing a member types reaches the CSS or the comment that stores it.
const FONTS = {
  'Comic Sans': '"Comic Sans MS", "Chalkboard SE", cursive',
  Verdana: 'Verdana, Geneva, sans-serif',
  Arial: 'Arial, Helvetica, sans-serif',
  Trebuchet: '"Trebuchet MS", Tahoma, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  'Times New Roman': '"Times New Roman", Times, serif',
  'Courier New': '"Courier New", Courier, monospace',
  Impact: 'Impact, "Arial Black", sans-serif',
};
const BORDERS = ['ridge', 'groove', 'inset', 'outset', 'solid', 'double', 'dashed', 'dotted', 'none'];
const CURSORS = ['auto', 'default', 'pointer', 'crosshair', 'help', 'wait', 'progress', 'cell', 'move', 'not-allowed'];
const COLOURS = ['page', 'text', 'link', 'visited'];
const PRESETS = {
  sky: { name: 'Sky blue', page: '#4aa9e6', text: '#14264f', link: '#0a3fc4', visited: '#7a2ea0', font: 'Comic Sans', border: 'ridge', width: 720, cursor: 'auto' },
  geocities: { name: 'Geocities black and lime', page: '#000000', text: '#39ff14', link: '#ffff00', visited: '#ff00ff', font: 'Times New Roman', border: 'outset', width: 800, cursor: 'crosshair' },
  notebook: { name: 'Notebook paper', page: '#fffef6', text: '#26324a', link: '#1d56c9', visited: '#7a2ea0', font: 'Courier New', border: 'dashed', width: 680, cursor: 'auto' },
  pastel: { name: 'Pastel', page: '#fde4f2', text: '#4b2a5a', link: '#7a3fd1', visited: '#b0398a', font: 'Verdana', border: 'dashed', width: 900, cursor: 'auto' },
  night: { name: 'Night mode', page: '#14141f', text: '#d8d8f0', link: '#8ab4ff', visited: '#c79bff', font: 'Verdana', border: 'solid', width: 800, cursor: 'default' },
};

// the settings in x, or null if any of them is missing or not one we offer
function clean(x) {
  if (!x || typeof x !== 'object') return null;
  const s = {};
  for (const k of COLOURS) {
    if (typeof x[k] !== 'string' || !/^#[0-9a-f]{6}$/i.test(x[k])) return null; // a repeated form field arrives as an array
    s[k] = x[k].toLowerCase();
  }
  if (!Object.hasOwn(FONTS, x.font) || !BORDERS.includes(x.border) || !CURSORS.includes(x.cursor)) return null;
  const width = Number(x.width);
  if (!Number.isInteger(width) || width < 320 || width > 2000) return null;
  return { ...s, font: x.font, border: x.border, width, cursor: x.cursor };
}

const END = '/* end puppypad-style: write your own CSS below this line */';
// The generated block. It sets the :root variables the starter layouts use, plus plain rules for pages without them.
// The page sends this function's source to the browser for the live preview, so it uses nothing but its arguments.
const block = (s, fonts) => `/* puppypad-style: ${JSON.stringify({ page: s.page, text: s.text, link: s.link, visited: s.visited, font: s.font, border: s.border, width: s.width, cursor: s.cursor })} */
:root { --page: ${s.page}; --desk: ${s.page}; --text: ${s.text}; --link: ${s.link}; --visited: ${s.visited}; --font: ${fonts[s.font]}; --width: ${s.width}px; }
body { background-color: var(--page); color: var(--text); font-family: var(--font); cursor: ${s.cursor}; }
a { color: var(--link); }
a:visited { color: var(--visited); }
.box, .tile { border-style: ${s.border}; }
/* end puppypad-style: write your own CSS below this line */`;

// the settings stored at the top of a puppypad.css, or null
function parse(text) {
  const m = /^\/\* puppypad-style: (\{[^\n]*?\}) \*\//.exec(text || '');
  try { return m ? clean(JSON.parse(m[1])) : null; } catch { return null; }
}
// what the member wrote below the generated block (or the whole file, if it has none); it stays after the block
const tail = (css) => (css && parse(css) && css.includes(END) ? css.slice(css.indexOf(END) + END.length) : `\n${css || ''}`);
// a new puppypad.css: the generated block, then the member's own CSS
const merge = (old, s) => block(s, FONTS) + tail(old);

const LINK = '<link rel="stylesheet" href="/puppypad.css">';
// only an active stylesheet <link> applies the CSS: not a comment, an <a>, or a preload
const hasLink = (html) => (html.replace(/<!--[^]*?-->/g, '').match(/<link\b[^>]*>/gi) || [])
  .some((tag) => /\brel=["']?stylesheet\b/i.test(tag) && /\bhref=["']?\/?puppypad\.css(["'\s>]|$)/i.test(tag));
// the page with the stylesheet linked after its styles (at the end of <head>), so it wins over the page's own rules
function link(html) {
  const head = html.search(/<\/head>/i);
  if (head >= 0) return `${html.slice(0, head)}${LINK}\n${html.slice(head)}`;
  const style = html.toLowerCase().lastIndexOf('</style>');
  return style >= 0 ? `${html.slice(0, style + 8)}\n${LINK}${html.slice(style + 8)}` : `${LINK}\n${html}`;
}

module.exports = { FONTS, BORDERS, CURSORS, COLOURS, PRESETS, clean, block, parse, merge, tail, hasLink, link };
