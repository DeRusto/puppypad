// PROTOTYPE, throwaway (wayfinder ticket "Do the containment guardrails hold on a real /browse grid?", DeRusto/puppypad#124).
// Renders the real /browse view with fake rows, then lets you flip guardrail levels and attacks on one card.
// Run: node scripts/prototype-card-containment.js  -> writes prototype-card-containment.html, open it in a browser.
// URL params: ?guard=0..4&attack=overlay,bump,link,move,wide,fixed
const fs = require('fs');
const path = require('path');
const views = require('../src/views');

const names = ['rex', 'biscuit', 'nekocat', 'mallory', 'patches', 'ziggy', 'pip', 'mochi'];
const rows = names.map((username, i) => ({ username, shot: 0, tagline: `${username}'s homepage`, tags: 'dogs html', updated_at: Date.now() - i * 3600e3, followers: i, hits: 100 * i }));
const cfg = { SITE_NAME: 'PuppyPad', TAGLINE: 'prototype', BASE_URL: 'https://puppypad.test', BASE_HOST: 'puppypad.test', ABUSE_EMAIL: 'abuse@puppypad.test', siteUrl: (n) => `https://${n}.puppypad.test/` };
let html = views.browse({ cfg, path: '/browse', supporters: new Set() }, { rows, page: 2, pages: 3, sort: 'updated', q: '' });

const css = fs.readFileSync(path.join(__dirname, '../src/assets/site.css'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="[^"]+">/, `<style>${css}</style>`)
  .replace(/<li class="card">(<a class="shot none" href="https:\/\/([a-z]+)\.)/g, '<li class="card" data-card="$2">$1')
  .replace('<p class="mt">', '<p class="mt pager">');

// platform guardrails, as the source issue wrote them; the level decides how they are emitted
const SPEC = `.card{position:relative!important;isolation:isolate!important}
.card::before,.card::after{pointer-events:none!important}
nav,.pager{position:relative!important;z-index:2147483647!important}`;
const GUARDS = [
  ['0: none (stock site.css)', ''],
  ['1: as written, plain CSS before member CSS', SPEC],
  ['2: same rules in @layer guard', `@layer guard{${SPEC}}`],
  ['3: layer + clip-path bleed 24px', `@layer guard{${SPEC}.card{clip-path:inset(-24px)!important}}`],
  ['4: layer + contain:paint (no bleed)', `@layer guard{${SPEC}.card{contain:paint!important}}`],
];
const M = '[data-card="mallory"]';
const ATTACKS = {
  overlay: `${M}::before{content:"";position:absolute;inset:-3000px;z-index:2147483647;background:rgba(255,0,0,.25);pointer-events:auto!important}`,
  bump: `${M}${M}${M}::before{pointer-events:auto!important}`,
  link: `${M}>a:first-child{position:absolute;inset:-300px -400px;width:auto;height:auto;aspect-ratio:auto;max-width:none;z-index:2147483647;background:rgba(0,0,255,.15)}`,
  move: `${M}{transform:translate(-105%,-30px);z-index:2147483647}`,
  wide: `${M}::after{content:"MALLORY WAS HERE";position:absolute;left:100%;top:30px;font:900 56px Impact,sans-serif;color:#c00;white-space:nowrap;background:#ff0}`,
  fixed: `${M}>div:nth-of-type(1){position:fixed;inset:0;z-index:2147483647;background:rgba(0,160,0,.3)}`,
};
// a benign Nekoweb-style card: a frame and a sticker draped past the corner, a wobble on hover
const BENIGN = `[data-card="nekocat"]{transition:transform .2s}[data-card="nekocat"]:hover{transform:rotate(-3deg) scale(1.05)}
[data-card="nekocat"]::before{content:"";position:absolute;inset:-6px;border:3px dashed hotpink;border-radius:8px}
[data-card="nekocat"]::after{content:"\\1F43E\\1F431";position:absolute;top:-18px;right:-14px;font-size:34px}`;

const bar = `<div id="proto" style="position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;background:#222;color:#eee;font:12px/1.4 monospace;padding:8px;border-radius:8px;isolation:isolate;max-height:45vh;overflow:auto">
<b>PROTOTYPE</b> guard: <select id="g">${GUARDS.map(([l], i) => `<option value="${i}">${l}</option>`).join('')}</select>
attacks on mallory: ${Object.keys(ATTACKS).map((k) => `<label><input type="checkbox" value="${k}">${k}</label>`).join(' ')}
<pre id="out" style="margin:4px 0 0;border:0;padding:0;background:none;color:#eee"></pre></div>
<style id="guard"></style><style id="member"></style>
<script>
const GUARDS=${JSON.stringify(GUARDS)},ATTACKS=${JSON.stringify(ATTACKS)},BENIGN=${JSON.stringify(BENIGN)};
const q=new URLSearchParams(location.search),g=document.getElementById('g'),boxes=[...document.querySelectorAll('#proto input')];
g.value=q.get('guard')||'2';const on=(q.has('attack')?q.get('attack'):'overlay,bump,link,wide').split(',');boxes.forEach(b=>b.checked=on.includes(b.value));
// targets that must stay clickable: [label, element]; the hit at the element's centre must land inside it
const T=()=>[['nav: Rules','nav a[href="/rules"]'],['search box','#q'],['sort: Newest','.sorts a'],['pager: Next','.pager a:last-child'],['left neighbour nekocat','[data-card=nekocat] b'],['right neighbour patches','[data-card=patches] b'],['row below: pip','[data-card=pip] b'],['mallory own name','[data-card=mallory] b']];
function apply(){
  const gi=+g.value,atk=boxes.filter(b=>b.checked).map(b=>b.value);
  // level 1 emits the guardrails before member CSS in one sheet; the rest emit a layer, order then does not matter
  document.getElementById('guard').textContent=GUARDS[gi][1];
  document.getElementById('member').textContent=BENIGN+atk.map(a=>ATTACKS[a]).join('\\n');
  history.replaceState(null,'','?guard='+gi+'&attack='+atk.join(','));
  requestAnimationFrame(()=>{const r=T().map(([l,s])=>{const e=document.querySelector(s);if(!e)return l+': missing';const b=e.getBoundingClientRect();
    e.scrollIntoView({block:'center'});const c=e.getBoundingClientRect(),hit=document.elementFromPoint(c.left+c.width/2,c.top+c.height/2);
    const ok=hit&&(e.contains(hit)||hit.contains(e)||hit.closest('a,input')===e.closest('a,input'));
    return (ok?'OK   ':'FAIL ')+l+' -> '+(hit?hit.tagName.toLowerCase()+(hit.closest('[data-card]')?' in card '+hit.closest('[data-card]').dataset.card:''):'nothing');});
    window.scrollTo(0,0);document.getElementById('out').textContent=r.join('\\n');window.RESULT=r;});
}
g.onchange=apply;boxes.forEach(b=>b.onchange=apply);apply();
</script>`;
html = html.replace('</body>', `${bar}</body>`);
fs.writeFileSync(path.join(__dirname, '../prototype-card-containment.html'), html);
console.log('wrote prototype-card-containment.html');
