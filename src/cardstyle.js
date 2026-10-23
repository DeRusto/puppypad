// The card style sanitizer: a Site's own CSS in, either an error a member can read or the CSS scoped to that Site's card.
// Fail-closed: anything it doesn't fully understand rejects the whole style; it never drops or repairs a rule.
const csstree = require('css-tree');

// bump on any change to the rules below or to PARTS; stored copies with an older version are rebuilt from source
const VERSION = 1;
const MAX_BYTES = 4096;
const MAX_DEPTH = 16; // brackets of any kind; real card styles stay far below this
const PARTS = ['card', 'shot', 'name', 'tagline', 'tags', 'stats'];
const DENIED = new Set(['behavior', '-moz-binding']);
const POSITIONS = new Set(['static', 'relative', 'absolute']);
const LOGICAL = new Set(['has', 'not', 'is', 'where']);
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
        anchored = true;
      } else if (!(NTH.has(p) && n.children.size === 1 && n.children.first.type === 'Nth' && !n.children.first.selector)) return false;
    } else if (n.type === 'PseudoElementSelector') {
      if (n.children || !['before', 'after'].includes(name(n.name))) return false;
    } else return false; // type, *, #id, .class, & and anything new
  }
  return anchored;
}

// a keyframes stop: from, to or a percentage
const stopOk = (s) => s.children.size === 1 && (s.children.first.type === 'Percentage' || (s.children.first.type === 'TypeSelector' && ['from', 'to'].includes(name(s.children.first.name))));

function check(ast, id) {
  const prefix = `cs${id}-`;
  const frames = new Set(); // keyframes names as written (decoded), case-sensitive like the browser
  csstree.walk(ast, (n) => {
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
    if (n.type === 'Url') no('url() is not allowed in card style yet.');
    if (n.type === 'Function' && !FUNCTIONS.has(name(n.name))) no(`Function ${name(n.name)}() is not allowed.`);
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
}

// css: the Site's source CSS; id: its Site id. Returns { error } or { css, art, version }.
// art lists the Site file paths the output's url placeholders point into; always empty until url() is allowed.
function sanitize(css, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('sanitize needs a Site id');
  if (typeof css !== 'string') return { error: 'Card style must be text.' };
  if (Buffer.byteLength(css, 'utf8') > MAX_BYTES) return { error: `Card style is over ${MAX_BYTES} bytes.` };
  try {
    checkTokens(css);
    const ast = csstree.parse(css, { parseCustomProperty: true, onParseError: (e) => no(`Card style has CSS that can't be read: ${e.message}`) });
    check(ast, id);
    return { css: csstree.generate(ast).replace(/</g, '\\3c '), art: [], version: VERSION };
  } catch (e) {
    if (e instanceof Reject) return { error: e.message };
    throw e;
  }
}

module.exports = { sanitize, VERSION, MAX_BYTES, PARTS };
