# Adding puppypad.org to the Public Suffix List

Browsers use the [Public Suffix List](https://publicsuffix.org/) (PSL) to decide where one "site"
ends and the next begins. Once `puppypad.org` is listed, browsers treat `alice.puppypad.org` and
`bob.puppypad.org` as separate sites:

- a member page can't set cookies that other members' sites (or `puppypad.org`) receive;
- browser storage, permissions and SameSite rules are kept apart per member;

Until then, the `__Host-sid` login cookie already stops member pages from reading or overwriting
logins. The PSL entry closes the rest.

## Before you submit

The PSL maintainers review each request by hand and have become strict, so check their current
[guidelines](https://github.com/publicsuffix/list/wiki/Guidelines) first. Expect them to ask for:

1. **The site to be live**, with real member sites on subdomains.
2. **A domain registration with at least 2 years left** before it expires. Renew `puppypad.org` ahead
   if needed.
3. **A DNS proof record** linking the domain to your pull request (step 3 below).

## Steps

1. Fork [publicsuffix/list](https://github.com/publicsuffix/list) and add this to the *PRIVATE DOMAINS*
   section of `public_suffix_list.dat`, in alphabetical order by organisation name:

   ```
   // PuppyPad : https://puppypad.org
   // Submitted by Your Name <you@puppypad.org>
   puppypad.org
   ```

2. Open the pull request using their template. Explain that `puppypad.org` hosts free
   user-created websites at `name.puppypad.org`, that members run their own HTML and JavaScript,
   and that the entry isolates member sites from each other.

3. At Cloudflare, add a TXT record that points at the pull request:

   | Type | Name | Content |
   |---|---|---|
   | TXT | `_psl` | `https://github.com/publicsuffix/list/pull/<number>` |

   Leave it in place for good: the maintainers re-check it.

4. Wait for review. After the merge, browsers pick up the change over the next few weeks to months
   as they ship updates.

## Side effects to know about

- `puppypad.org` itself becomes a public suffix. The dashboard keeps working because its cookie is
  host-only (`__Host-`, no `Domain` attribute), but no cookie can be shared across
  `*.puppypad.org` again. Nothing in the app does that today.
- Let's Encrypt rate limits are then counted per member subdomain rather than for `puppypad.org`
  as a whole. That makes no difference to the single wildcard certificate.
