# PuppyPad — Plan

PuppyPad is a free, old-web homepage host. Every member gets `name.puppypad.org`, a file manager,
an in-browser HTML editor, a hit counter, a guestbook and a webring link. Sites are static files
only.

The code in this repo already works end to end, so this plan builds on it rather than replacing
it. It covers what the framework is today, what must change before signups open on
`puppypad.org`, and what to build after launch.

---

## 1. The framework today

```
   puppypad.org, *.puppypad.org
              │
   ┌──────────▼───────────┐   one *.puppypad.org certificate via a
   │ Caddy (Caddyfile)    │   Cloudflare DNS-01 challenge (caddy/Dockerfile)
   └──────────┬───────────┘
              │ reverse_proxy
   ┌──────────▼────────────────────────────────────────────┐
   │ app — Express (src/server.js), routes on the Host     │
   │   puppypad.org      → main router: home, browse,      │
   │                       signup, dashboard, editor,      │
   │                       follows/feed, report, admin     │
   │   name.puppypad.org → site router: static files,      │
   │                       /_hw/counter.svg, /_hw/guestbook│
   └──────┬──────────────────────────────┬─────────────────┘
          │                              │
   ./data/puppypad.db (SQLite)    ./data/sites/{name}/…   ./data/shots/{name}.jpg
          ▲
   ┌──────┴───────────────┐  polls /internal/shots/next with SHOT_TOKEN,
   │ shots — Playwright   │  renders the member site, posts back a JPEG
   └──────────────────────┘
```

| Part | File | Notes |
|---|---|---|
| Config, routing, all handlers | `src/server.js` | Single Express app, one process |
| Schema | `src/db.js` | `CREATE TABLE IF NOT EXISTS` plus ad-hoc `ALTER TABLE` for new columns |
| Helpers | `src/util.js` | scrypt passwords, name rules, reserved names, path safety, in-memory rate limiter |
| HTML | `src/views.js` | Server-rendered template strings; CodeMirror 5 from cdnjs |
| New-site page | `templates/starter.html` | Written to `index.html` at signup |
| Screenshots | `shots/worker.js` | Separate container, blocks IPs and internal hostnames |
| Deploy | `docker-compose.yml`, `Caddyfile`, `Dockerfile` | One VPS, everything under `./data` |

**Keep this stack, and keep JavaScript.** A rewrite in another language would cost weeks and
fix nothing that's broken. Node handles this workload well, and JavaScript is the language
members write their pages in anyway. If the codebase grows, add type checking in place: `// @ts-check`
plus JSDoc types, checked by `tsc --noEmit` in CI. That works on the existing `.js` files without
a build step.

 Express, SQLite and the local disk are the right size for one VPS and
thousands of members. Several security basics are already right:

- `__Host-sid` session cookie, so member subdomains can't read or overwrite it
- CSRF token plus an `Origin` check on dashboard forms
- Path normalisation and a file-type allowlist on uploads
- `nosniff` on every response
- Sandboxed editor preview
- An isolated screenshot browser
- Honeypots and rate limits
- Unconfirmed accounts purged after 3 days

---

## 2. Before signups open (launch blockers)

These are ordered by risk. Each one is small. ✅ = done on this branch.

### 2.1 ✅ Admin name can be squatted
Admin rights come from `ADMIN_USERS`, a list of site *names*. The README says to "sign up with
this name first". Until you do, anyone can register that name and get `/admin`. The same thing
happens if your unconfirmed admin account is purged after 3 days.
**Done:** `ADMIN_USERS` is replaced by `ADMIN_EMAILS`. An account is admin only when its email
is in that list *and* has been confirmed.

### 2.2 ✅ Upgrade `multer` 1.x → 2.x (and `nodemailer`)
**Done:** `multer` 2.x and `nodemailer` 10.x. `nodemailer` 6.x had high-severity advisories, and it
receives user-supplied email addresses. `npm audit --omit=dev` is clean.

### 2.3 ✅ Use one wildcard certificate instead of one certificate per subdomain
Caddy currently issues a certificate for each member subdomain on first visit (`on_demand`).
Let's Encrypt caps new certificates per registered domain per week, so a signup rush stalls new
sites. **Done:** `caddy/Dockerfile` builds Caddy with `caddy-dns/cloudflare`, and the Caddyfile gets
every certificate through a DNS-01 challenge using `CF_API_TOKEN`. On-demand TLS and the app's
`/internal/tls-check` endpoint are removed; custom domains (§3) would bring them back. Keep the
Cloudflare records **DNS only** (grey cloud). Turning on the proxy makes every visitor appear as a
Cloudflare IP until the app reads `CF-Connecting-IP`.

### 2.4 🟡 Submit `puppypad.org` to the Public Suffix List — your step
Browsers then treat each `name.puppypad.org` as its own site. This stops cookie-tossing between
members and isolates browser storage per member. The `__Host-` cookie already protects logins in
the meantime. **Ready:** `docs/public-suffix-list.md` has the entry, the `_psl` TXT record and the
steps. Submit once the site is live with some member sites.

### 2.5 ✅ Hold released names
Deleting an account (or admin "delete") frees the name immediately. Someone else can then
re-register a well-known site's name and impersonate it. **Done:** a
`released_names` table. Signup rejects a name released in the last 90 days. Names from
never-confirmed accounts are freed at once, so squatters can't lock names by signing up and
walking away.

### 2.6 ✅ Backups
**Done:** `scripts/backup.sh` uses SQLite's online backup (safe while the app writes), archives it
with `data/sites`, keeps 14 nightly archives, and syncs them off the server with rclone when
`BACKUP_REMOTE` is set. **Your step:** add the cron line, set up a remote, and test a restore once
(steps in the README).

### 2.7 🟡 Mail that actually arrives — your step
Pick a transactional SMTP provider, fill in `SMTP_*`, and add SPF, DKIM and DMARC records at
Cloudflare. The README's "Email that arrives" section lists them.

### 2.8 ✅ Bot and phishing brakes
**Done:**
- **Captcha.** Cloudflare Turnstile on `/signup`, turned on by `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY`. It fails closed: if Cloudflare can't be reached, signups are refused.
- **Phishing flags.** Saving or uploading HTML with a password field, a card field or a big
  brand in the `<title>` adds one "Auto-flag" report per site to `/admin` and emails
  `ABUSE_EMAIL`. The site stays live until a moderator decides.

### 2.9 ✅ Rules and legal (mostly)
**Done:** `/privacy` page (linked in the footer and at signup), a 13+ rule, and a 13+ checkbox at
signup. **Your step:** read both pages and make them match how you run things. Keep
`abuse@puppypad.org` monitored. Register a DMCA agent if you're in the US.

### 2.10 ✅ Tests and CI
**Done:** `npm test` (`node:test` + `supertest`, 11 tests) covers:
- site names and reserved names
- path traversal on upload and serving
- the file-type allowlist and upload quota
- CSRF and `Origin` checks
- the 404/410 site states
- admin access by confirmed email
- the name hold
- phishing flags
- the Turnstile verdict

`.github/workflows/ci.yml` runs the tests, `npm audit` and `caddy validate` on every push.

---

## 3. After launch (feature roadmap)

**Phase A — small wins (weeks 1–3 after launch)**
- ✅ Zip import: `/dashboard/import` unpacks a `.zip` (up to `ZIP_MAX_MB`) through the same name, type, quota and phishing checks as uploads; drops a wrapping folder and OS junk; refuses `../` names, links, encrypted entries and oversized files.
- Folder rename/move.
- Template gallery at signup: a few retro starters next to `starter.html`.
- Log in with site name *or* email.
- Admin audit log table: who banned, restored or deleted what, and when.
- Visible "Report this site" link on default 404/410 pages and profile pages.

**Phase B — community (weeks 4–8)**
- Webring membership as opt-in (today every live site is in the ring).
- Tags or categories on profiles, and a search on `/browse`.
- Guestbook moderation: hold entries containing links for owner approval.
- RSS/Atom feed per site and for the global "recently updated" list.

**Phase C — growth (later)**
- File version history (keep the last N versions per file under `data/history`).
- Custom domains: the member adds a CNAME, the app verifies a TXT record, and the existing
  `/internal/tls-check` + on-demand TLS path issues the certificate.
- CLI/WebDAV or Git push for members who prefer local editors.
- Optional supporter tier with a bigger quota.

---

## 4. Scaling path (only when needed)

One VPS goes a long way. Hit counters are the only hot write. Move up a step only when a metric
says to:

1. **Disk fills** → bigger volume, or lower `QUOTA_MB` for inactive sites.
2. **Bandwidth or CPU from popular sites** → put Cloudflare in front of `*.puppypad.org` (cache
   static files; `Cache-Control: public, max-age=60` is already set).
3. **More than one app server** → move the in-memory rate limiter and sessions to SQLite or
   Redis, and move member files to object storage (R2/S3) keyed by user id. SQLite can stay
   until writes contend; then move to Postgres.

---

## 5. Domain setup for puppypad.org

1. Cloudflare DNS: `A puppypad.org → VPS`, `A *.puppypad.org → VPS` (plus `AAAA` if the VPS has
   IPv6), both **DNS only**. Create an API token from the "Edit zone DNS" template, scoped to the
   `puppypad.org` zone.
2. `.env`: `BASE_DOMAIN=puppypad.org`, `ACME_EMAIL`, `CF_API_TOKEN`, `ADMIN_EMAILS`, `ABUSE_EMAIL=abuse@puppypad.org`, a strong
   `SHOT_TOKEN` (`openssl rand -hex 32`), and the SMTP settings.
3. Firewall the `shots` container from the private network and `169.254.169.254`, as the README
   says.
4. `docker compose up -d --build`, sign up with your `ADMIN_EMAILS` address, confirm it, open `/admin`.
5. Monitoring: an uptime check on `puppypad.org` and on one member site, and a disk-usage alert
   at 80%.

A 2 vCPU / 4 GB / 80 GB VPS (about $10–25 a month) fits the app, Caddy and the Chromium screenshot
worker comfortably.

---

## 6. Open questions

1. **Old PuppyPad content:** were there member sites, accounts or pages on the old host to bring
   back? If so, add an import script (`data/sites/{name}/` + `users` rows with `verified=1` and a
   forced password reset) before launch.
2. **Member JavaScript:** allowed today, as on classic hosts. Keep it?
3. **Quota:** 50 MB per member and 5 MB per file today. Keep these for launch?
