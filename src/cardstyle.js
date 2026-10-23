// The card style sanitizer: a Site's own CSS in, either an error a member can read or the CSS scoped to that Site's card.
// Fail-closed: anything it doesn't fully understand rejects the whole style; it never drops or repairs a rule.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const csstree = require('css-tree');

// bump on any change to the rules below or to the Card parts (PARTS, or their markup on /browse): any Card part change
// is a breaking change. Startup rebuilds stored copies with an older version from source (src/server.js)
const VERSION = 2;
const MAX_BYTES = 4096;
const MAX_DEPTH = 16; // brackets of any kind; real card styles stay far below this
const PARTS = ['card', 'shot', 'name', 'tagline', 'tags', 'stats'];
const DENIED = new Set(['behavior', '-moz-binding']);
const POSITIONS = new Set(['static', 'relative', 'absolute']);
const LOGICAL = new Set(['has', 'not', 'is', 'where']);
const SAME = new Set(['is', 'where']); // these match exactly what's inside them; :not() and :has() match other elements, so they only qualify a part
// functions whose strings are urls, like url()
const URL_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image', 'src', 'cross-fade']);
const MAX_ART = 8;
const MAX_ART_BYTES = 512 * 1024;
// Card art formats by extension: the name members see, and a check of the file's first 16 bytes
const ART = {
  png: ['PNG', (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  jpg: ['JPEG', (b) => b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))],
  gif: ['GIF', (b) => /^GIF8[79]a/.test(b.toString('latin1', 0, 6))],
  webp: ['WebP', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  avif: ['AVIF', (b) => b.toString('latin1', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(b.toString('latin1', 8, 12))],
};
ART.jpeg = ART.jpg;
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
// a path into the Site's own files: relative, no empty or dot segments, nothing a browser would read as a scheme, query or fragment
const artPathOk = (p) => Object.hasOwn(ART, extOf(p)) && !/[\0-\x1f\\:?#]/.test(p) && p.split('/').every((s) => s && s[0] !== '.');
const NTH = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);
// value functions a card may use; everything else (expression, url-bearing functions, env, attr, ...) is refused
const FUNCTIONS = new Set(['var', 'calc', 'min', 'max', 'clamp', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scalez', 'scale3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'cubic-bezier', 'steps', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'inset', 'circle', 'ellipse', 'polygon', 'counter', 'counters']);
const T = csstree.tokenTypes;
const OPEN = { [T.LeftCurlyBracket]: '}', [T.LeftParenthesis]: ')', [T.Function]: ')', [T.LeftSquareBracket]: ']' };
const CLOSE = { [T.RightCurlyBracket]: '}', [T.RightParenthesis]: ')', [T.RightSquareBracket]: ']' };

const name = (s) => csstree.ident.decode(s).toLowerCase();
class Reject extends Error {}
const no = (msg) => { throw new Reject(msg); };

// what css-tree quietly forgives but a browser might read differently: unclosed strings, comments and brackets, \r or \f inside them
function checkTokens(css) {
  if (/[\0﻿]/.test(css)) no('Card style can\'t contain a null byte or a byte order mark.');
  const stack = [];
  csstree.tokenize(css, (type, start, end) => {
    const text = css.slice(start, end);
    if (type === T.BadString || type === T.BadUrl) no('Card style has a broken string or url.');
    if (type === T.String && !(text.length > 1 && text.at(-1) === text[0] && /(^|[^\\])(\\\\)*.$/s.test(text.slice(0, -1)))) no('Card style has an unclosed string.');
    if (type === T.Comment && !(text.length > 3 && text.endsWith('*/'))) no('Card style has an unclosed comment.');
    if ((type === T.String || type === T.Comment) && /[\r\f]/.test(text)) no('Card style can\'t have a carriage return or form feed inside a string or comment.');
    if (type === T.CDO || type === T.CDC) no('Card style can\'t contain <!-- or -->.');
    // the output escapes < as \3c, which only keeps its meaning inside strings, comments and urls; @media (width < 600px) would break
    if (type === T.Delim && text === '<') no('Card style can only use < inside a string, so write @media (max-width: …) instead of (width < …).');
    if (OPEN[type]) {
      stack.push(OPEN[type]);
      if (stack.length > MAX_DEPTH) no('Card style is nested too deeply.');
    } else if (CLOSE[type] && stack.pop() !== CLOSE[type]) no(`Card style has a stray ${CLOSE[type]}.`);
  });
  if (stack.length) no(`Card style has an unclosed bracket: ${stack.at(-1)} is missing.`);
}

// true if the selector's compounds are all Card parts (or logical pseudo-classes around parts), joined by descendant or child combinators
// relative: inside :has(), where the selector may start with a combinator, as in :has(> [data-part=name])
function partsOnly(selector, relative = false) {
  let compound = [];
  for (const [i, n] of [...selector.children.toArray(), null].entries()) {
    if (n && n.type !== 'Combinator') { compound.push(n); continue; }
    if (!(relative && i === 0 && n) && !compoundOk(compound)) return false;
    if (n && n.name !== ' ' && n.name !== '>') return false;
    compound = [];
  }
  return true;
}
function compoundOk(nodes) {
  let anchored = false;
  for (const n of nodes) {
    if (n.type === 'AttributeSelector') {
      const v = n.value && (n.value.type === 'String' ? n.value.value : csstree.ident.decode(n.value.name));
      if (name(n.name.name) !== 'data-part' || n.matcher !== '=' || n.flags || !PARTS.includes(v)) return false;
      anchored = true;
    } else if (n.type === 'PseudoClassSelector') {
      const p = name(n.name);
      if (!n.children) continue;
      if (LOGICAL.has(p)) {
        const list = n.children.first;
        if (n.children.size !== 1 || list.type !== 'SelectorList' || !list.children.toArray().every((s) => s.type === 'Selector' && partsOnly(s, p === 'has'))) return false;
        if (SAME.has(p)) anchored = true;
      } else if (!(NTH.has(p) && n.children.size === 1 && n.children.first.type === 'Nth' && !n.children.first.selector)) return false;
    } else if (n.type === 'PseudoElementSelector') {
      if (n.children || !['before', 'after'].includes(name(n.name))) return false;
    } else return false; // type, *, #id, .class, & and anything new
  }
  return anchored;
}

// a keyframes stop: from, to or a percentage
const stopOk = (s) => s.children.size === 1 && (s.children.first.type === 'Percentage' || (s.children.first.type === 'TypeSelector' && ['from', 'to'].includes(name(s.children.first.name))));

// marker: a prefix nobody can guess, written in place of each url so sanitize() can turn it into a placeholder.
// Returns the distinct art paths, in order of first use.
function check(ast, id, marker) {
  const prefix = `cs${id}-`;
  const frames = new Set(); // keyframes names as written (decoded), case-sensitive like the browser
  const art = [];
  csstree.walk(ast, function (n) {
    if (n.type === 'Raw' || n.type === 'CDO' || n.type === 'CDC') no('Card style has CSS that can\'t be read.');
    if (n.type === 'Rule' && n.block.children.some((c) => c.type !== 'Declaration')) no('Nested rules aren\'t allowed in card style.');
    if (n.type === 'Atrule') {
      const at = name(n.name);
      if (at !== 'media' && at !== 'keyframes') no(`At-rule @${at} is not allowed.`);
      if (!n.block) no(`@${at} needs a block.`);
      if (at === 'keyframes') {
        const p = n.prelude && n.prelude.children;
        if (!p || p.size !== 1 || p.first.type !== 'Identifier') no('@keyframes needs a plain name.');
        frames.add(csstree.ident.decode(p.first.name));
      }
    }
    // css-tree hands over urls and strings decoded, so escapes can't hide a target
    if (n.type === 'Url' || (n.type === 'String' && this.function && URL_FUNCTIONS.has(name(this.function.name)))) {
      if (!artPathOk(n.value)) no(`Card art \`${n.value}\` must be a relative path to a PNG, JPEG, GIF, WebP or AVIF file of your site.`);
      let i = art.indexOf(n.value);
      if (i < 0) {
        if (art.length === MAX_ART) no(`Card style can use at most ${MAX_ART} art files.`);
        i = art.push(n.value) - 1;
      }
      n.value = marker + i;
    }
    if (n.type === 'Function' && !FUNCTIONS.has(name(n.name)) && !URL_FUNCTIONS.has(name(n.name))) no(`Function ${name(n.name)}() is not allowed.`);
  });
  csstree.walk(ast, {
    visit: 'Rule',
    enter(rule) {
      if (this.atrule && name(this.atrule.name) === 'keyframes') {
        if (!rule.prelude.children.toArray().every(stopOk)) no(`Keyframes stop \`${csstree.generate(rule.prelude)}\` is not allowed.`);
        return;
      }
      for (const s of rule.prelude.children) {
        if (!partsOnly(s)) no(`Selector \`${csstree.generate(s)}\` is not a Card part.`);
        s.children.prependData({ type: 'Combinator', name: ' ' });
        s.children.prependData({ type: 'ClassSelector', name: `cs-${id}` });
      }
    },
  });
  csstree.walk(ast, (n) => {
    if (n.type === 'Atrule' && name(n.name) === 'keyframes') {
      const f = n.prelude.children.first;
      f.name = csstree.ident.encode(prefix + csstree.ident.decode(f.name));
    }
    if (n.type !== 'Declaration') return;
    const prop = name(n.property);
    if (DENIED.has(prop)) no(`Property ${prop} is not allowed.`);
    const v = n.value.children;
    if (prop === 'position' && !(v.size === 1 && v.first.type === 'Identifier' && POSITIONS.has(name(v.first.name)))) no('Position can only be static, relative or absolute.');
    if (prop === 'animation' || prop === 'animation-name') {
      for (const x of v) if (x.type === 'Identifier' && frames.has(csstree.ident.decode(x.name))) x.name = csstree.ident.encode(prefix + csstree.ident.decode(x.name));
    }
  });
  return art;
}

// css: the Site's source CSS; id: its Site id. Returns { error } or { css, art, version }.
// art lists the Site file paths the output's placeholders point into: url(<i>), or "<i>" inside image-set() and the like.
// The output has no other <, so a placeholder can't be forged; fill() swaps them for real urls at render time.
function sanitize(css, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('sanitize needs a Site id');
  if (typeof css !== 'string') return { error: 'Card style must be text.' };
  if (Buffer.byteLength(css, 'utf8') > MAX_BYTES) return { error: `Card style is over ${MAX_BYTES} bytes.` };
  try {
    checkTokens(css);
    const ast = csstree.parse(css, { parseCustomProperty: true, onParseError: (e) => no(`Card style has CSS that can't be read: ${e.message}`) });
    const marker = `cs${crypto.randomBytes(8).toString('hex')}-`;
    const art = check(ast, id, marker);
    const output = csstree.generate(ast).replace(/</g, '\\3c ')
      .replace(new RegExp(`url\\(${marker}(\\d+)\\)`, 'g'), 'url(<$1>)').replace(new RegExp(`"${marker}(\\d+)"`, 'g'), '"<$1>"');
    return { css: output, art, version: VERSION };
  } catch (e) {
    if (e instanceof Reject) return { error: e.message };
    throw e;
  }
}

// stored css with each placeholder i swapped for urls[i]; the urls must be percent-encoded, so they hold no " or \
const fill = (css, urls) => css.replace(/url\(<(\d+)>\)|"<(\d+)>"/g, (_, u, s) => (u ? `url("${urls[u]}")` : `"${urls[s]}"`));

// The art check, shared by /browse and /card-art: each art path of a style, looked up in the Site folder root.
// reason is null when the file passes, and v (mtime-size) then changes whenever the file does.
function checkArt(root, art) {
  return art.map((p) => {
    const fail = (reason) => ({ path: p, reason });
    if (!artPathOk(p)) return fail('not card art');
    const full = path.join(root, ...p.split('/'));
    const head = Buffer.alloc(16);
    let st;
    try {
      st = fs.statSync(full);
      if (!st.isFile()) return fail('a folder, not a file');
      if (st.size > MAX_ART_BYTES) return fail('over 512 KB');
      const fd = fs.openSync(full, 'r');
      try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    } catch { return fail('missing'); }
    const [kind, ok] = ART[extOf(p)];
    if (!ok(head)) return fail(`not a real ${kind}`);
    return { path: p, reason: null, v: `${Math.floor(st.mtimeMs)}-${st.size}` };
  });
}

module.exports = { sanitize, fill, checkArt, VERSION, MAX_BYTES, MAX_ART, MAX_ART_BYTES, PARTS };
