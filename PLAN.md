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
   ┌──────────▼───────────┐   on-demand TLS: asks the app /internal/tls-check
   │ Caddy (Caddyfile)    │   before issuing a certificate for a subdomain
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

**Keep this stack.** Express, SQLite and the local disk are the right size for one VPS and
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

These are ordered by risk. Each one is small.

### 2.1 Admin name can be squatted — fix first
Admin rights come from `ADMIN_USERS`, a list of site *names*. The README says to "sign up with
this name first". Until you do, anyone can register that name and get `/admin`. The same thing
happens if your unconfirmed admin account is purged after 3 days.
**Fix:** add `role` to `users` and promote admins with a one-off CLI command
(`node src/admin.js promote <name>`). Or keep the env var but match on a confirmed *email*
(`ADMIN_EMAILS`), not on a name.

### 2.2 Upgrade `multer` 1.x → 2.x
`multer@1.4.5-lts.1` has published denial-of-service advisories, fixed in 2.x. The upload code
uses only `memoryStorage()` and `.array()`, so the upgrade should be a version bump plus a
re-test of uploads.

### 2.3 Use one wildcard certificate instead of one certificate per subdomain
Caddy currently issues a certificate for each member subdomain on first visit (`on_demand`).
Let's Encrypt caps new certificates per registered domain per week, so a signup rush stalls new
sites. **Fix:** use one `*.puppypad.org` certificate through a DNS-01 challenge:
- build Caddy with the DNS plugin for wherever `puppypad.org`'s DNS lives (for example
  `caddy-dns/cloudflare`), using `xcaddy` in a small `caddy/Dockerfile`;
- replace `tls { on_demand }` with `tls { dns cloudflare {env.CF_API_TOKEN} }`;
- keep `/internal/tls-check` only if custom domains are added later (§3).

### 2.4 Submit `puppypad.org` to the Public Suffix List
Browsers then treat each `name.puppypad.org` as its own site. This stops cookie-tossing between
members and isolates browser storage per member. Approval takes weeks, so file the request now.
The `__Host-` cookie already protects logins in the meantime.

### 2.5 Hold released names
Deleting an account (or admin "delete") frees the name immediately. Someone else can then
re-register a well-known site's name and impersonate it. **Fix:** a `released_names` table
(`name`, `released_at`). Signup rejects a name released in the last 90 days.

### 2.6 Backups
Everything lives in `./data`. Copying the SQLite file while it's in use can corrupt the copy.
**Fix:** a nightly job that runs `sqlite3 puppypad.db ".backup …"` (or Litestream for continuous
replication), then `rsync`/`restic` of `data/sites` to off-box storage (Backblaze B2, R2 or S3).
Test a restore once before launch.

### 2.7 Mail that actually arrives
Set up a transactional SMTP provider, plus SPF, DKIM and DMARC records for `puppypad.org`.
Without them, confirmation mail lands in spam and nobody can activate a site.

### 2.8 Bot and phishing brakes
- Add Cloudflare Turnstile (or hCaptcha) to `/signup`. The current honeypot alone won't hold
  once bots find the site.
- Flag pages on save or upload when they contain `<input type="password">`, card-number fields,
  or a big brand name in the `<title>`. Flagged sites go into the `/admin` queue (still live)
  so a moderator looks at them early.

### 2.9 Rules and legal
Edit the rules page in `src/views.js` and add a privacy page. Set a minimum age of 13. Keep
`abuse@puppypad.org` monitored, and register a DMCA agent if you're in the US.

### 2.10 Tests and CI
There are no tests yet. Add `node --test` with `supertest` covering the risky paths:
- name validation and reserved names
- `safeRel` path traversal
- the upload quota
- the CSRF/Origin rejection
- banned and unverified sites returning 410/404
- admin-only routes

Run them, plus `npm audit --omit=dev`, in a GitHub Actions workflow on every push.

---

## 3. After launch (feature roadmap)

**Phase A — small wins (weeks 1–3 after launch)**
- Zip upload (extract server-side through `safeRel` and the quota check) and folder rename/move.
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

1. DNS: `A puppypad.org → VPS`, `A *.puppypad.org → VPS` (plus `AAAA` if the VPS has IPv6).
2. `.env`: `BASE_DOMAIN=puppypad.org`, `ACME_EMAIL`, `ABUSE_EMAIL=abuse@puppypad.org`, a strong
   `SHOT_TOKEN` (`openssl rand -hex 32`), and the SMTP settings.
3. Firewall the `shots` container from the private network and `169.254.169.254`, as the README
   says.
4. `docker compose up -d --build`, sign up, promote yourself to admin (§2.1), open `/admin`.
5. Monitoring: an uptime check on `puppypad.org` and on one member site, and a disk-usage alert
   at 80%.

A 2 vCPU / 4 GB / 80 GB VPS (about $10–25 a month) fits the app, Caddy and the Chromium screenshot
worker comfortably.

---

## 6. Open questions

1. **Old PuppyPad content:** were there member sites, accounts or pages on the old host to bring
   back? If so, add an import script (`data/sites/{name}/` + `users` rows with `verified=1` and a
   forced password reset) before launch.
2. **Where is `puppypad.org`'s DNS hosted?** That picks the Caddy DNS plugin for §2.3.
3. **Member JavaScript:** allowed today, as on classic hosts. Keep it?
4. **Quota:** 50 MB per member and 5 MB per file today. Keep these for launch?
