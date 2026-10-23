const { test } = require('node:test');
const assert = require('node:assert/strict');
const csstree = require('css-tree');
const { sanitize, VERSION, MAX_BYTES } = require('../src/cardstyle');

const N = '[data-part=name]';
const ok = (css, id = 7) => {
  const r = sanitize(css, id);
  assert.equal(r.error, undefined, `${JSON.stringify(css)} -> ${r.error}`);
  return r;
};
const out = (css, id) => ok(css, id).css;
const bad = (css, why) => {
  const r = sanitize(css, 7);
  assert.equal(typeof r.error, 'string', `${JSON.stringify(css)} should be rejected, got ${r.css}`);
  assert.equal(r.css, undefined);
  if (why) assert.match(r.error, why, JSON.stringify(css));
  return r.error;
};

test('card style: a Card part rule comes out scoped to the Site, with the space kept', () => {
  assert.deepEqual(ok(`${N}{color:red}`), { css: `.cs-7 ${N}{color:red}`, art: [], version: VERSION });
  assert.equal(typeof VERSION, 'number');
});

test('card style: 4096 bytes of UTF-8 pass, 4097 are rejected before parsing', () => {
  const rule = `${N}{color:red}`;
  const fill = (n) => `${rule}/*${'é'.repeat((n - rule.length - 5) / 2)}x*/`; // é is 2 bytes
  assert.equal(Buffer.byteLength(fill(4096)), 4096);
  ok(fill(4096));
  bad(`${fill(4096)} `, /4096 bytes/);
  bad(`${'{'.repeat(MAX_BYTES + 1)}`, /4096 bytes/); // would be a parse error; the size wins
});

test('card style: deeply nested input is rejected without crashing', () => {
  bad(`${'@media screen{'.repeat(100)}${N}{color:red}${'}'.repeat(100)}`, /nested too deeply/);
  bad(`${N}{width:${'calc('.repeat(600)}1px${')'.repeat(600)}}`, /nested too deeply/);
  bad(`${N}{width:${'('.repeat(2000)}}`, /nested too deeply/);
});

test('card style: an escaped url either decodes to its target and is judged by it, or is rejected', () => {
  for (const v of ['URL(x.png)', 'url( "x.png" )', 'url(\nx.png)', 'url(\tx.png)', 'url(\\78 .png)', 'url("\\78 .png")']) {
    assert.deepEqual(ok(`${N}{background:${v}}`), { css: `.cs-7 ${N}{background:url(<0>)}`, art: ['x.png'], version: VERSION }, v);
  }
  // the browser reads these as url( too; css-tree sees a function named url (not allowed) or a parse error
  for (const v of ['u\\rl(x.png)', '\\75 rl(x.png)', '\\000075rl(x.png)']) bad(`${N}{background:${v}}`, /url\(\) is not allowed|can't be read/);
  for (const v of ['url(ht\\74p://e/x.png)', 'url("ht\\74p://e/x.png")']) bad(`${N}{background:${v}}`, /`http:\/\/e\/x\.png` must be a relative path/);
});

test('card style: urls are checked wherever they appear, and stored as placeholders into the art list', () => {
  const rows = [
    ...['background', 'cursor', 'list-style', 'border-image', 'mask', 'filter', 'content'].map((p) => [`${p}:url(x.png)`, `${p}:url(<0>)`]),
    ['background:image-set("x.png" 1x)', 'background:image-set("<0>"1x)'],
    ['background:-webkit-image-set(url(x.png) 1x)', 'background:-webkit-image-set(url(<0>)1x)'],
    ['background:image("x.png")', 'background:image("<0>")'],
    ['background:src("x.png")', 'background:src("<0>")'],
    ['background:cross-fade(url(x.png), url(y.gif), 50%)', 'background:cross-fade(url(<0>),url(<1>),50%)'],
    ['--x:url(x.png)', '--x:url(<0>)'],
    ['background:var(--x, url(x.png))', 'background:var(--x,url(<0>))'],
  ];
  for (const [decl, stored] of rows) {
    const r = ok(`${N}{${decl}}`);
    assert.equal(r.css, `.cs-7 ${N}{${stored}}`, decl);
    assert.ok(!r.css.includes('/card-art'));
  }
  assert.equal(out('@keyframes k{to{background:url(x.png)}}'), '@keyframes cs7-k{to{background:url(<0>)}}');
  bad(`${N}{background:element(#x)}`, /element\(\)/); // not a url at all: it paints another element of the page
  for (const decl of ['background:image-set("//evil/x.png" 1x)', 'background:image("data:image/png;base64,AA==")', '--x:url(/x.png)', 'background:var(--x, url(x.svg))']) bad(`${N}{${decl}}`, /must be a relative path/);
});

test('card style: a url must be a relative path to a png, jpg, gif, webp or avif file of the Site', () => {
  for (const t of ['//evil/x.png', 'http://evil/x.png', 'https://pad.test/x.png', 'https://other.pad.test/x.png', 'javascript:alert(1)//.png', 'data:image/png;base64,AA==',
    '/x.png', '/../x.png', '../x.png', 'a/../../x.png', 'a/./x.png', 'a//x.png', '.hidden.png', 'a\\x.png', 'x.png?y', 'x.png#y', 'x.svg', 'x.SVG', 'x.png.svg', 'x', 'x.html', '', 'a/']) {
    bad(`${N}{background:url("${t.replace(/\\/g, '\\\\')}")}`, /must be a relative path/);
  }
  for (const t of ['x.png', 'pics/x.jpg', 'a/b/c/x.jpeg', 'x.GIF', 'x.webp', 'x.avif', 'my pic.png', 'it\'s "here".png']) {
    assert.deepEqual(ok(`${N}{background:url(${JSON.stringify(t)})}`).art, [t], t);
  }
});

test('card style: at most 8 distinct art files; the same file twice counts once', () => {
  const urls = (n) => Array.from({ length: n }, (_, i) => `url(a${i}.png)`).join(',');
  const r = ok(`${N}{background:${urls(8)},url(a0.png)}[data-part=card]{background:url(a7.png)}`);
  assert.deepEqual(r.art, ['a0.png', 'a1.png', 'a2.png', 'a3.png', 'a4.png', 'a5.png', 'a6.png', 'a7.png']);
  assert.match(r.css, /url\(<7>\),url\(<0>\)\}\.cs-7 \[data-part=card\]\{background:url\(<7>\)\}$/);
  bad(`${N}{background:${urls(9)}}`, /at most 8 art files/);
});

test('card style: a url-like string outside a url can\'t pass for a placeholder', () => {
  const r = ok(`${N}::before{content:"url(<0>)" "<0>"}[data-part=card]{background:url(x.png)}`);
  assert.equal(r.css, `.cs-7 ${N}::before{content:"url(\\3c 0>)""\\3c 0>"}.cs-7 [data-part=card]{background:url(<0>)}`);
});

test('card style: only @media and @keyframes are allowed, escapes decoded first', () => {
  for (const at of ['@import "x.css";', '@\\69mport "x.css";', '@\\0069mport "x.css";', '@\\69 mport "x.css";', '@\\49mport "x.css";']) bad(at, /@import is not allowed/);
  for (const at of ['@font-face{font-family:x}', '@namespace x "y";', `@supports (color:red){${N}{color:red}}`, `@layer guard{${N}{color:red}}`, '@layer guard;',
    `@container (width>1px){${N}{color:red}}`, `@scope (${N}){a{color:red}}`, '@page{margin:0}', '@property --x{syntax:"*"}', '@charset "utf-8";',
    `@-moz-document url-prefix(){${N}{color:red}}`, '@-webkit-keyframes k{to{color:red}}']) bad(at, /^At-rule @\S+ is not allowed/);
});

test('card style: rules inside @media are scoped', () => {
  assert.equal(out(`@media (min-width:600px){${N},[data-part=tags]{color:red}}`), `@media (min-width:600px){.cs-7 ${N},.cs-7 [data-part=tags]{color:red}}`);
});

test('card style: @keyframes names and every reference get the Site prefix; stops are not scoped', () => {
  const css = `@keyframes wiggle{from{rotate:0deg}50%{rotate:5deg}to{rotate:0deg}}${N}{animation:1s wiggle infinite}[data-part=tags]{animation-name:wiggle,spin}`;
  assert.equal(out(css, 7), `@keyframes cs7-wiggle{from{rotate:0deg}50%{rotate:5deg}to{rotate:0deg}}.cs-7 ${N}{animation:1s cs7-wiggle infinite}.cs-7 [data-part=tags]{animation-name:cs7-wiggle,spin}`);
  assert.notEqual(out(css, 7), out(css, 8)); // two Sites using the same name don't collide
  assert.match(out(css, 8), /@keyframes cs8-wiggle\{.*animation:1s cs8-wiggle infinite/);
  assert.equal(out(`@media screen{@keyframes w\\69ggle{to{color:red}}}${N}{animation-name:wiggle}`), `@media screen{@keyframes cs7-wiggle{to{color:red}}}.cs-7 ${N}{animation-name:cs7-wiggle}`);
  bad(`@keyframes w{${N}{color:red}}`, /Keyframes stop/);
  bad('@keyframes "w"{to{color:red}}', /plain name/);
});

test('card style: banned properties and position values are rejected', () => {
  for (const v of ['fixed', 'sticky', '-webkit-sticky', 'FIXED', 'f\\ixed', 'var(--p)', 'fixed !important', 'absolute fixed']) bad(`${N}{position:${v}}`, /Position can only be/);
  bad(`${N}{posit\\ion: fixed !important}`, /Position can only be/);
  for (const p of ['behavior', 'behav\\ior', '-moz-binding', 'BEHAVIOR']) bad(`${N}{${p}:x}`, /^Property \S+ is not allowed/);
  for (const v of ['expression(alert(1))', 'e\\78pression(alert(1))', 'ex/**/pression(alert(1))', 'expr/* x */ession(1)']) bad(`${N}{width:${v}}`);
  for (const v of ['static', 'relative', 'absolute', 'ABSOLUTE', 'absolute !important']) ok(`${N}{position:${v}}`);
});

test('card style: parser differentials and broken input are rejected', () => {
  for (const css of [`${N}{content:"a\rb"}`, `${N}{content:"a\fb"}`, `${N}{content:"a\r\nb"}`, `${N}{color:red}/*a\rb*/`, `${N}{color:red}/*a\fb*/`, `${N}{color:red}/*a\r\nb*/`,
    `${N}{content:"abc}`, `${N}{content:"abc\\"}`, `${N}{color:red}/* abc`, `${N}{color:red}}`, `${N}{color:red}{`, `${N}{color:red`, `${N}{color:red\0}`, `\ufeff${N}{color:red}`,
    `<!-- ${N}{color:red}`, `${N}{color:red} -->`, `${N}{&:hover{color:red}}`, `${N}{[data-part=tags]{color:red}}`, '{color:red}']) bad(css);
  for (const css of [`${N}{&:hover{color:red}}`, `[data-part=card]{${N}{color:red}}`, `[data-part=card]{:has(${N}){color:red}}`, `[data-part=card]{@media screen{color:red}}`]) bad(css, /Nested rules|can't be read/);
  ok(`${N}{\r\n  color: red;\r\n}\r\n`); // CRLF line ends from a textarea are fine outside strings and comments
  ok(`${N}{content:"\\"}"}/* } */`);
});

test('card style: selectors other than Card parts are rejected, naming the selector', () => {
  for (const s of ['body', 'html', ':root', '*', 'img', 'a', '#x', '.t', '.shot', '.card', '.a\\,b', ':not(body)', ':has(body)', ':is(.t)', ':where(img)',
    `${N} img`, `${N} .t`, `${N}+[data-part=tags]`, `${N}~[data-part=tags]`, `${N}::first-line`, '::before', ':hover', `${N}:not(:hover)`, `${N}:nth-child(2n of .t)`,
    '[data-part=x]', '[data-part~=name]', '[data-part=name i]', '[data-x=name]', `${N}, body`, `${N} &`,
    // :not() and :has() on their own match elements that aren't parts, like the row around the name and [profile] link
    `[data-part=card] > :not([data-part=shot])`, `:not(${N})`, `:has(${N})`, `[data-part=card] :has(${N})`, `:is(:not(${N}))`, `:not(${N}):hover`]) {
    const err = bad(`${s}{color:red}`, /is not a Card part/);
    const named = csstree.parse(s, { context: 'selectorList' }).children.last; // in a list, the selector at fault
    assert.ok(err.includes(`\`${csstree.generate(named)}\``), `${err} names ${s}`);
  }
});

test('card style: Card part selectors pass, and each comes out with the scope and a space', () => {
  const rows = [
    [`${N}:hover::before`, `.cs-7 ${N}:hover::before`],
    ['[data-part="card"]::after', '.cs-7 [data-part="card"]::after'],
    [`[data-part=card] ${N}`, `.cs-7 [data-part=card] ${N}`],
    [`[data-part=card]>${N}`, `.cs-7 [data-part=card]>${N}`],
    [`${N}, [data-part=shot]`, `.cs-7 ${N},.cs-7 [data-part=shot]`],
    [`[data-part=card]:has(${N})`, `.cs-7 [data-part=card]:has(${N})`],
    [`:is([data-part=card]):not(${N})`, `.cs-7 :is([data-part=card]):not(${N})`],
    [`[data-part=card]:has(> ${N}:hover)`, `.cs-7 [data-part=card]:has(>${N}:hover)`],
    [`[data-part=card]:not(${N})`, `.cs-7 [data-part=card]:not(${N})`],
    [`:is(${N},[data-part=tags]):where([data-part=stats])`, `.cs-7 :is(${N},[data-part=tags]):where([data-part=stats])`],
    [`[data-part=tags]:nth-child(2n+1):focus-within`, `.cs-7 [data-part=tags]:nth-child(2n+1):focus-within`],
    ['[data-p\\61rt=n\\61me]', '.cs-7 [data-p\\61rt=n\\61me]'],
  ];
  for (const [sel, scoped] of rows) assert.equal(out(`${sel}{color:red}`), `${scoped}{color:red}`, sel);
});

test('card style: < is escaped in the output, which has no <!-- and re-parses to the same AST', () => {
  assert.equal(out(`${N}::before{content:"</style>"}`), `.cs-7 ${N}::before{content:"\\3c /style>"}`);
  assert.equal(out(`${N}::before{content:"</STYLE"}/*! </STYLE><!-- */`), `.cs-7 ${N}::before{content:"\\3c /STYLE"}/*! \\3c /STYLE>\\3c !-- */`);
  const plain = (s) => csstree.toPlainObject(csstree.parse(s, { parseCustomProperty: true }));
  for (const css of [`${N}::before{content:"<!--"}`, `${N}::before{content:"\\3c !--"}`, `@media (min-width:600px){${N}::before{content:"a<b" "<"}}`]) {
    const o = out(css);
    assert.ok(!o.includes('<'), o);
    assert.deepEqual(plain(o), plain(o.replace(/\\3c /g, '<')), o); // the escape doesn't change what the CSS means
    assert.deepEqual(plain(out(o.replace(/\.cs-7 /g, ''))), plain(o)); // sanitizing the output again changes nothing
  }
  bad(`@media (width<600px){${N}{color:red}}`, /only use </); // \3c would turn the range into an identifier
});

test('card style: a Site id is required', () => {
  assert.throws(() => sanitize(`${N}{color:red}`), TypeError);
  assert.throws(() => sanitize(`${N}{color:red}`, '7'), TypeError);
});
