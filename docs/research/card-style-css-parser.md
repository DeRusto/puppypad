# Which CSS parser can sanitize and scope card style?

Research for [#123](https://github.com/DeRusto/puppypad/issues/123), part of the map
[#122 Card style for the /browse grid](https://github.com/DeRusto/puppypad/issues/122). Done 2026-10-22.

**Recommendation: [css-tree](https://github.com/csstree/csstree) 3.x, used fail-closed.** Parse with
`parseCustomProperty: true`, reject the whole style on any `onParseError` call or any `Raw`,
`CDO` or `CDC` node, decode every identifier with `csstree.ident.decode()` before comparing it,
allowlist at-rules/properties/values, scope selectors by inserting AST nodes, re-serialize with
`csstree.generate()`, and escape `<` in the output.

## The question

Card style is a Site's own CSS (up to ~4 KB, untrusted) that styles only that Site's card on
`/browse`. The server must parse it like a browser does, put every selector under the card root,
find and check every URL, allow only `@media` and Site-name-prefixed `@keyframes`, refuse
`position: fixed|sticky`, `behavior`, `-moz-binding` and `expression()`, and re-serialize the result.

## Comparison

| | css-tree | postcss + selector-parser + value-parser | lightningcss | hand-rolled tokenizer |
|---|---|---|---|---|
| Version checked | 3.2.1, published 2026-03-05 [1] | postcss 8.5.31 (2026-10-18), postcss-selector-parser 7.1.7 (2026-10-20), postcss-value-parser 4.2.0 (2021-11-29) [1] | 1.33.0, published 2026-07-20 [1] | n/a |
| License | MIT [1] | MIT (all three) [1] | MPL-2.0 [1] | ours (AGPL-3.0-only) |
| Install (measured, `npm i` in scratch) | 3 packages, ~3.2 MB (css-tree 2.2 MB, mdn-data 792 KB, source-map-js 192 KB) [2] | 8 packages, ~1.1 MB [2] | 2 packages, ~10.2 MB, of which 9.6 MB is a native binary picked from 11 per-platform optional packages [2] | 0 |
| Parses selectors and values into an AST | Yes, both [3] | postcss: no, values and selectors are strings. Needs the two extra parsers [2] | Yes, typed AST [2] | Only what we write |
| Decodes CSS escapes (`posit\ion`, `\75 rl(`) | No, keeps them raw, but ships `ident.decode()` [2] | No, keeps them raw everywhere [2] | Yes [2] | Only if we write it |
| What happens to things it can't classify | Becomes a `Raw` node and calls `onParseError` [3]: easy to reject | Kept as text in `decl.value`: you can't tell if it's unsafe | Dropped with a warning (`errorRecovery`) [4]; JS visitor crashed on valid input [2] | Depends on us |
| CSS nesting (`.a{ .b &{…} }`) | Not parsed: becomes `Raw` [2], so you reject it | Parsed as nested rules [2] | Parsed [2] | Depends on us |
| Published security advisories | None [5] | CVE-2023-44270 (fixed in 8.4.31) [6]; and sanitize-html's CVE-2024-21501, from postcss reading source maps [7][8] | None [9] | n/a |

### Why css-tree

- **It fails safe on the inputs that matter.** In our probes, every input css-tree could not
  fully understand became a `Raw` node and triggered `onParseError`. This covered `u\rl(…)`,
  `\75 rl(…)`, nested rules, stray `}` and a null byte [2]. css-tree's docs say: "bad content is
  wrapping into a `Raw` node and `onParseError` is invoking" [3]. So "any parse error or any `Raw`
  node rejects the style" gives a safe default with no extra code.
- **It gives a real AST for selectors and values in one plain-JS package,** which fits a repo with
  no build step. The postcss route needs three parsers whose results we would have to keep in sync.
  It also keeps every escape as raw text, which is exactly how CVE-2026-28348 happened (below).
- **Licence:** MIT, compatible with AGPL-3.0-only.
- **Trade-off we accept:** css-tree does not decode escapes in identifiers. We must call
  `csstree.ident.decode()` and lowercase every property, function, at-rule and keyword name before
  comparing it, and the tests must cover that. Our probe confirmed that `ident.decode('posit\\ion')`
  returns `position` and `ident.decode('\\75 rl')` returns `url` [2]. css-tree's last release was
  2026-03-05, older than the postcss releases [1], and the project has no SECURITY.md [5].

### Why not the others

- **postcss.** It has had a real parser-differential CVE: "An attacker can prepare CSS in such a way
  that it will contains parts parsed by PostCSS as a CSS comment. After processing by PostCSS, it
  will be included in the PostCSS output in CSS nodes" (CVE-2023-44270, fixed in 8.4.31) [6].
  sanitize-html's CVE-2024-21501 (file enumeration when the `style` attribute is allowed) was fixed
  by "Do not parse sourcemaps in `post-css`" [7][8]. Using postcss safely means passing
  `map: false`, adding two more parsers, and decoding escapes ourselves. `@\69mport` makes it
  throw "At-rule without name" [2]. That is safe, but by luck rather than by design.
- **lightningcss.** It is the most browser-accurate parser: it decodes escapes, parses nesting, and
  with `analyzeDependencies` it reports `image-set()` string URLs [2][4]. But:
  (a) it adds a 9.6 MB native binary chosen per platform [2];
  (b) its JS `visitor` threw "failed to deserialize" on `image-set("…" 1x)` and on `var(--x)`, and its
  `Url` visitor missed the `image-set` string URL, so the URL list has to come from
  `analyzeDependencies`, which replaces URLs with placeholders and silently removes `@import`
  rules [2][4];
  (c) it did not report a URL inside `image("…")` [2];
  (d) it is MPL-2.0. That is usable here: MPL-2.0 names AGPL-3.0 as a "Secondary License"
  (MPL-2.0 §1.12, §3.3). I could not fetch mozilla.org from this environment, so check the licence
  text when adopting it [10].
  The binary and the visitor bugs are the reasons it loses.
- **Hand-rolled tokenizer.** Every bypass cited below comes from a filter whose view of the CSS
  differs from the browser's. CVE-2026-28348 is a homemade normalisation step ("strips backslashes
  before checking for dangerous CSS keywords") that turned `@\69mport` into `@69mport`, while
  browsers still read `@import` [11]. Writing a CSS Syntax 3 tokenizer ourselves would mean owning
  exactly this risk.

## Known bypasses (primary sources)

| Advisory | What went wrong | Lesson for us |
|---|---|---|
| CVE-2026-28348 / GHSA-hw26-mmpg-fqfg, lxml_html_clean ≤ 0.4.3 [11] | `@\69mport url(…)` and the variants `@\0069mport`, `@\69 mport`, `@\49mport` got past a keyword blacklist | Decode escapes the way the CSS spec does, and only then compare. Use an allowlist, not a blacklist |
| CVE-2023-44270 / GHSA-7fh5-64p2-3v2j, postcss < 8.4.31 [6] | `\r` inside a comment made postcss output, as real rules, CSS the browser treats as a comment | The parser must agree with the browser. Test `\r`, `\f` and `\r\n` inside comments and strings |
| CVE-2023-36823 / GHSA-f5ww-cq3m-q3g7, Ruby Sanitize < 6.0.2 [12] | Crafted CSS in `style` element content got through. The workaround: escape "the character sequence `</` as `<\/`" | Card style goes into an inline `<style>`: escape `<` when writing it out |
| CVE-2026-40301 / GHSA-93vf-569f-22cq, dom-sanitizer < 1.0.10 [13] | CSS in `<style>` text was never inspected, so `url()` and `@import` reached attacker hosts | Check URLs in every place they can appear, not only in common properties |
| CVE-2024-21501 / GHSA-rm97-x556-q36h, sanitize-html < 2.12.1 [7][8] | postcss followed `sourceMappingURL` comments in untrusted CSS on the server, which revealed which files exist | The parser must not touch the filesystem or network. css-tree's `parse()` takes only a string [3] |
| CVE-2025-66021 / GHSA-g9gq-3pfx-2gw2, OWASP java-html-sanitizer [14] | XSS when the policy allows `style` together with `noscript` | Same raw-text context risk as above. Escape `<` in the output |

The MySpace "Samy" worm (2005) is the classic case of `java\nscript` and `expression()` in CSS
getting past a filter. Its primary write-up (samy.pl/myspace/tech.html) could not be reached from
this environment, so it is mentioned here but not cited.

## Probe results (css-tree prototype)

I wrote a prototype of about 60 lines using the rules above. The repo was not changed; the
prototype is in the scratch directory. Results [2]:

- **Blocked:**
  - escaped and hex-escaped `url(`, plus an escaped `url(` inside a custom property (parse error, then `Raw`);
  - `url("ht\74p://…")`: css-tree decodes the string to `http://…`, then the own-host check rejects it;
  - string URLs in `image-set()` and `src()`, and `-webkit-image-set(url(//evil))`;
  - `posit\ion: f\ixed`, `POSITION: Sticky !important`, and `position: var(--p)`;
  - `@\69mport`, `@import`, `@font-face`, `@supports`, `@layer`, `@namespace`;
  - unprefixed `@keyframes`, and `url()` inside `@keyframes`;
  - nesting, stray `}`, `<!--`, a null byte;
  - `expression()`, `e\78pression()`, `behav\ior`, `-moz-binding`.
- **Allowed and scoped:** `.title{…}` became `.card-bob .title{…}`. `@media` rules are scoped
  inside. `@keyframes bob-spin` is kept with its `from`/`to` selectors unprefixed.
  `content:"</style>"` is written out as `"\3c /style>"`.
- **Mistakes the prototype made first, which the tests must catch:**
  - Prepending a parsed `".card-x "` lost the space and produced `.card-bob.title`. Insert a
    `Combinator` node with name `' '` instead.
  - A path regex accepted the protocol-relative `//evil/x`. Check own-host URLs with
    `new URL(u, siteOrigin).origin === siteOrigin` (plus a path check against the Site's files).
  - Turning `<!--` into `\3c !--` changes what the CSS means. Reject `CDO`/`CDC` nodes instead.

## Rules the sanitizer must follow

1. Parse with `{ parseCustomProperty: true, onParseError }`. Any error, `Raw`, `CDO` or `CDC`
   rejects the style; never fix it up [3].
2. Pass every name through `ident.decode()` and `toLowerCase()` before comparing it.
3. At-rules: allow only `media` and `keyframes`, and require the decoded `keyframes` name to start
   with `<site-name>-`.
4. Properties: use an allowlist if possible. At minimum, deny `behavior` and `-moz-binding`, and
   allow `position` only as `static|relative|absolute`, so `fixed`, `sticky` and `var()` are all
   refused.
5. Functions: deny `expression`. Collect every `Url` node, and every `String` inside `image-set`,
   `-webkit-image-set`, `image`, `src`, `cross-fade` and `element`. Better still, allowlist
   function names. Every URL must resolve to the Site's own origin and an existing Site file.
6. Selectors: for every `Rule` not inside `@keyframes`, prepend `ClassSelector(card-<site>)` and
   `Combinator(' ')` to each `Selector` in the list.
7. Write out with `generate()`, then replace `<` with `\3c ` (a CSS escape that is still valid in
   strings, URLs and identifiers). The theme preview in `src/views.js` already escapes `</style`
   for the same reason.
8. Sanitize again from the stored source whenever a Site is renamed. The `keyframes` prefix and
   the own-host URLs both contain the Site name (map #122 notes).

## Bypass cases the test suite must cover

Each case should be a `node --test` row: input → rejected, or input → exact output.

- **Escaped url:**
  - `u\rl(x)`, `\75 rl(x)`, `\000075rl(x)`, `URL(x)`;
  - `url( "x" )` with spaces;
  - `url(ht\74p://e)` and `url("ht\74p://e")`;
  - newline or tab inside `url(`.
- **URL positions:**
  - `background`, `cursor`, `list-style`, `border-image`, `mask`, `filter: url()`, `content`;
  - `image-set("x" 1x)`, `-webkit-image-set(url(x) 1x)`, `image("x")`, `src("x")`, `cross-fade()`;
  - inside `@keyframes`;
  - in a custom property (`--x:url(x)`) and in a `var(--x, url(x))` fallback.
- **URL targets:**
  - protocol-relative `//evil/x`, `http:` and `javascript:`;
  - `data:` (decide if allowed);
  - `/../` traversal;
  - another Site's host, and the main host;
  - a relative path, checked by resolving against the Site origin.
- **At-rules:**
  - `@import`, `@\69mport`, `@\0069mport`, `@\69 mport`, `@\49mport` [11];
  - `@font-face`, `@namespace`, `@supports`, `@layer`, `@container`, `@scope`, `@page`,
    `@property`, `@charset`, `@-moz-document`;
  - `@keyframes` without the prefix, `@-webkit-keyframes`, a prefix written with escapes,
    another Site's prefix.
- **Banned properties and values:**
  - `position: fixed|sticky|FIXED|f\ixed|-webkit-sticky|var(--p)`;
  - `posit\ion` and `!important`;
  - `behavior`, `behav\ior`, `-moz-binding`;
  - `expression(`, `e\78pression(`, `expression` written with comments.
- **Parser differential:**
  - `\r`, `\f` and `\r\n` inside comments and strings [6];
  - unterminated string and unterminated comment;
  - stray `}` and `{`;
  - null byte, BOM, `<!--` and `-->`.
- **Selectors:**
  - a selector list `a, b`;
  - `:root`, `html`, `body`, `*`, `:has()`, `:is()`, `:where()`, `:not()`;
  - CSS nesting (`&`, nested rules) rejected;
  - escaped commas `.a\,b`;
  - `@media` contents scoped;
  - `@keyframes` stops (`from`, `50%`) not scoped.
- **Output context:**
  - `</style>` and `</STYLE` inside strings, comments and URLs;
  - `<!--` in output;
  - the output re-parses to the same AST (round trip).
- **Size:**
  - input over 4 KB rejected before parsing;
  - deeply nested `@media` and parentheses.

## Sources

1. npm registry metadata via `npm view <pkg> version license dependencies time repository dist.unpackedSize optionalDependencies`, run 2026-10-22 for css-tree, postcss, postcss-selector-parser, postcss-value-parser and lightningcss.
2. Local probe: `npm i css-tree postcss postcss-selector-parser lightningcss` in a scratch directory (Node v22.22.0), `du -sh node_modules/*`, and probe scripts that parse each input above with each library. Results as reported in this file.
3. css-tree docs, parsing options: https://github.com/csstree/csstree/blob/master/docs/parsing.md
4. lightningcss `TransformOptions` type docs (`errorRecovery`, `analyzeDependencies`, `visitor`): https://github.com/parcel-bundler/lightningcss/blob/master/node/index.d.ts
5. csstree security page ("There aren't any published security advisories"): https://github.com/csstree/csstree/security
6. CVE-2023-44270, PostCSS line return parsing error: https://github.com/advisories/GHSA-7fh5-64p2-3v2j
7. CVE-2024-21501, sanitize-html Information Exposure: https://github.com/advisories/GHSA-rm97-x556-q36h
8. sanitize-html CHANGELOG 2.12.1 ("Do not parse sourcemaps in `post-css`"): https://github.com/apostrophecms/sanitize-html/blob/main/CHANGELOG.md
9. lightningcss security page ("There aren't any published security advisories"): https://github.com/parcel-bundler/lightningcss/security
10. Mozilla Public License 2.0, §1.12 and §3.3: https://www.mozilla.org/en-US/MPL/2.0/ (not fetched from this environment)
11. CVE-2026-28348, lxml-html-clean CSS @import filter bypass via Unicode escapes: https://github.com/advisories/GHSA-hw26-mmpg-fqfg
12. CVE-2023-36823, Sanitize, insufficient neutralization of `style` element content: https://github.com/rgrove/sanitize/security/advisories/GHSA-f5ww-cq3m-q3g7
13. CVE-2026-40301, dom-sanitizer SVG `<style>` CSS injection: https://github.com/advisories/GHSA-93vf-569f-22cq
14. CVE-2025-66021, OWASP java-html-sanitizer: https://github.com/advisories/GHSA-g9gq-3pfx-2gw2
