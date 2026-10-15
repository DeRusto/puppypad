# PuppyPad

A free old-web homepage host. Accidents welcome. Every member gets `name.yourdomain` for a static
site, with a file manager, an in-browser editor, a hit counter, a guestbook and a webring link.

## Features

**Accounts.** Signup with email confirmation and an optional Cloudflare Turnstile captcha. Log in
with site name or email. Password reset, email change (confirmed by link) and account deletion; a
deleted site's name is held for 90 days.

**Building a site.**

- Four starter layouts (`templates/`), picked at signup and each styled from one block of colour and
  font variables. If `index.html` goes missing, the dashboard offers to put a starter back.
- File manager: drag-and-drop uploads with a progress bar, folders, rename and move, zip import, and
  a one-click download of the whole site as a zip. Uploads can shrink big photos on the server
  (sharp) and strip their camera details, and the dashboard lists links and images that point at missing files.
- Code editor (CodeMirror, from cdnjs) with a sandboxed live preview. New pages start from the
  member's starter layout. An image picker inserts `<img>` with the picture's width and height.
- Style editor (`/dashboard/style`): colours, font, borders, page width and cursor, with presets and
  a live preview. It writes `puppypad.css` and leaves any CSS below its block alone.
- Limits from `.env`: `QUOTA_MB` of space per member (500 by default), `MAX_FILE_MB` per file,
  `ZIP_MAX_MB` per import and `BANDWIDTH_MB` served per day. File types follow a fixed allowlist
  (`src/util.js`). Raising
  `QUOTA_MB` grows every site; lowering it only applies to new signups.

**Serving.** Each site is served on its own subdomain, with clean URLs (`/about` serves `about.html`)
and an optional custom `not_found.html`. Members see views per page per day and the sites visitors
came from for the last 30 days, counted without cookies or IP addresses. A member can rename their
site once every `RENAME_DAYS` (30 by default); the old address redirects for the 90 days it is held. Built-in widgets: `/_hw/counter.svg`, `/_hw/guestbook`
(the owner can delete entries, and is emailed about new ones right away, in a daily digest or not at
all) and webring prev/next/random links.

**Community.** The Explore page shows a screenshot of every site, sortable by recently updated,
newest, most followed and most visited, with a search by site name or tag (members add up to 5 tags).
Members can follow sites and read a feed of their updates, which names the files each update changed,
and every site has a profile page (`/site/name`). Atom feeds: `/site/name/feed.xml` per site and
`/feed.xml` for recently updated sites. A new site joins Explore, the home page, the
webring and `/random` after its first edit, once it is `NEW_SITE_HOURS` old (24 by default). A
member can hide their site from all of these and from search engines.

**Moderation.** A public report form (linked from the default 404/410 pages), an `/admin` queue,
take down / restore / delete, signup IPs and a log of every moderator action. HTML that looks like
phishing is flagged into the queue automatically. Rate limits on signup, login, reports and
guestbooks, honeypot fields, and unconfirmed accounts are purged after 3 days.

`/healthz` answers for an uptime monitor.

## Deploy on a VPS

1. In Cloudflare DNS, point `A example.com` and `A *.example.com` at the server, set to **DNS only**
   (grey cloud). Create an API token with the "Edit zone DNS" template for that zone; Caddy uses it to
   get one wildcard certificate.
2. Install Docker (with the compose plugin), `curl`, `jq` and `cron`, then install the newest release:

   ```
   sudo mkdir -p /srv/puppypad && sudo chown "$USER" /srv/puppypad && cd /srv/puppypad
   curl -fsSL https://github.com/DeRusto/puppypad/releases/latest/download/install.sh | sh
   ```

   That unpacks the release, creates `.env` and `.env.caddy` from the examples, and adds the upgrade
   watcher (every minute) and the nightly backup (03:15) to your crontab. Fill in `.env` (BASE_DOMAIN,
   ACME_EMAIL, ADMIN_EMAILS, SMTP_*, SHOT_TOKEN) and `.env.caddy` (CF_API_TOKEN, which only the Caddy
   container reads), then `docker compose up -d`.
3. Sign up with an email you put in `ADMIN_EMAILS` and confirm it. Until SMTP is set, the
   confirmation link is in `docker compose logs app`.
4. Open `/admin` when logged in as that member.

Everything lives in `./data` (SQLite database plus `sites/`). Back that folder up.

To move a server that runs from a git checkout onto releases, run the same `curl ... | sh` line in
the checkout with the app running. It treats this as an upgrade (below) and leaves `.env`,
`.env.caddy`, `data/` and `backups/` as they are. Delete any `docker-compose.override.yml` first.

## Backups

`scripts/backup.sh` takes a consistent copy of the database while the app runs, archives it with
every member's files into `./backups`, and keeps the last 14. Set `BACKUP_REMOTE` to an
[rclone](https://rclone.org) remote to copy the archives off the server too. The installer schedules
it every night at 03:15, logging to `backups/backup.log`.

To restore: `docker compose stop app`, delete `data/puppypad.db-wal` and `data/puppypad.db-shm`
(left over, they would be replayed onto the restored database and corrupt it), unpack an archive
into `./data`, rename `backup.db` to `puppypad.db`, and `docker compose start app`.
`docs/launch-checklist.md` has a restore test that doesn't touch the live data.

## Releases and upgrades

Servers run published releases, not the source tree. Publishing a GitHub release tagged `vX.Y.Z`
runs `.github/workflows/release.yml`, which tests the code, pushes the app, shots and Caddy images to
`ghcr.io/derusto/puppypad-{app,shots,caddy}:vX.Y.Z`, and attaches the deploy bundle, `install.sh`
and `SHA256SUMS` to the release. Those three packages must be public (GitHub profile > Packages) or
servers can't pull them.

`scripts/install.sh` both installs and upgrades: with no argument it moves to the newest release,
and `scripts/install.sh v1.2.3` moves to a given one (older ones too). An upgrade:

1. downloads the release bundle, checks it against `SHA256SUMS`, and hands over to that release's
   own `install.sh`
2. pulls the new images by the digests the bundle records, so re-pushing a tag can't change what a
   release runs
3. runs `scripts/backup.sh`
4. puts the release's files in place, sets `PUPPYPAD_VERSION` and the image digests in `.env`, and
   runs `docker compose up -d`
5. waits for `/healthz` and for every container to stay running, and puts the previous files and
   version back if it doesn't come up. `VERSION` changes only once this passes, so an interrupted
   upgrade is simply tried again.

Every download and pull has a time limit. A rollback leaves the database as the new release left it,
which is fine while schema changes only add tables and columns; the backup from step 3 is the newest
archive in `./backups` if it isn't.

**From /admin.** The "Server version" box at the bottom of `/admin` shows the running release, the
newest one with its notes, and a button that runs the upgrade above. The app never upgrades itself:
it runs in a container with no Docker access and no credentials, and only leaves a request in
`data/upgrade/`. `scripts/upgrade-watch.sh`, run every minute from cron on the host, picks it up and
only accepts "check" or the newest release's tag, so a compromised app can at most ask for the
release you published. It checks GitHub every `UPGRADE_CHECK_MINUTES` (60 by default) and logs to
`.upgrade/watch.log`, with the full output of the last upgrade in `.upgrade/last.log`.

The app (uid 1000 in its container) and the watcher both write to `data/upgrade/`, which is
group-writable. If the user running the watcher isn't uid 1000 or root, the installer prints the one
`sudo chown` it needs.

## Email that arrives

Confirmation mail lands in spam unless the domain vouches for your mail provider.
`docs/launch-checklist.md` has the exact records for puppypad.org. In general, in Cloudflare DNS for
the domain, add the records your provider gives you:

- **SPF**: one TXT record on the domain itself, e.g. `v=spf1 include:<provider's domain> ~all`.
  Merge providers into one record if you already have one.
- **DKIM**: the TXT or CNAME records the provider generates (usually under `..._domainkey`).
- **DMARC**: a TXT record named `_dmarc`, starting with `v=DMARC1; p=none; rua=mailto:you@yourdomain`.
  Move to `p=quarantine` once reports show your mail passing.

Then sign up with a Gmail address and check that the confirmation arrives in the inbox.

## Development

```
npm install
BASE_URL=http://localhost.test:3000 ADMIN_EMAILS=me@example.com node src/server.js
```

Add `127.0.0.1 localhost.test me.localhost.test` to your hosts file to see a member site.

Screenshots: `cd shots && npm install`, then run `APP_URL=http://localhost:3000 SHOT_TOKEN=x node worker.js`
with the app started with the same `SHOT_TOKEN` (needs a Playwright Chromium install).

In the source tree, `docker-compose.override.yml` makes `docker compose up -d --build` build the
images locally instead of pulling them.

`npm test` runs the suite in `test/`. GitHub Actions runs it on every push, along with `npm audit`
and a check that the Caddyfile is valid.

## Before you open signups

- **Mail**: public signups need real SMTP (any transactional mail provider works). Without it nobody can confirm.
- **Certificates**: Caddy (built from `caddy/Dockerfile` with the Cloudflare DNS plugin) gets one `*.yourdomain` certificate through a DNS challenge, so new member sites never wait on a certificate. Keep the DNS records grey-clouded: if you turn on Cloudflare's proxy, every visitor arrives from a Cloudflare IP, and the per-IP rate limits need to read the real address from `CF-Connecting-IP` first.
- **Cookies**: member pages run their own JavaScript on subdomains of your main domain. The login cookie is host-only with the `__Host-` prefix, so member sites cannot read or overwrite it. Serving member sites from a separate domain is stronger still, and is what the big hosts do.
- **Rules**: edit the rules page in `src/views.js`. As the operator you are the one who gets the takedown notices, so keep `ABUSE_EMAIL` monitored. If you are in the US, look into registering a DMCA agent.
- **Captcha**: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile) before opening signups. Without them only the honeypot and rate limits stand in the way of bots.
- **Phishing**: saving or uploading an HTML page with a password field, a card-number field or a big brand name in its title puts the site in the `/admin` queue as an "Auto-flag" report and emails `ABUSE_EMAIL`. The site stays online until a moderator looks.
- **Public Suffix List**: see `docs/public-suffix-list.md`.
- **Screenshots**: the `shots` container opens every member page in headless Chromium. It blocks requests to IP addresses and internal hostnames, but for defense in depth also firewall that container from your private network and the cloud metadata address (169.254.169.254).
- **Disk**: worst case is members x `QUOTA_MB` (500 MB by default, so an 80 GB disk holds about 100 full sites). Add a volume before signups grow past that, keep a disk alert at 80%, or lower the quota.

## License

PuppyPad is free software, licensed under the [GNU Affero General Public License v3](LICENSE) — Copyright © 2026 Brandon Douglas Winterton. Run it, modify it, share it; if you run a modified version as a public service, publish your changes too.
