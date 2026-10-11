# PuppyPad

A free old-web homepage host. Accidents welcome. Every member gets `name.yourdomain`, a file manager, an in-browser HTML editor, a hit counter, a guestbook and a webring link. Static files only.

## What's in the box

- Signup with email confirmation, login, password reset, email change (confirmed by link), account deletion (a deleted site's name is held for 90 days)
- Four starter layouts to pick from at signup (`templates/`), each restyled from one block of colour and font variables
- Per-member folder with drag-and-drop uploads (many files at once, with a progress bar), zip import (unpacks a whole site, with the same name, type and quota checks), folders (rename or move any file or folder), text editor, quota (50 MB), file-type allowlist, and a one-click download of the whole site as a zip
- Member sites served on their own subdomain, with custom `not_found.html` and clean URLs (`/about` serves `about.html`)
- Widgets: `/_hw/counter.svg`, `/_hw/guestbook` (owner can delete entries), webring prev/next/random
- Explore page with a screenshot of every site (new sites join it after their first edit and once they are `NEW_SITE_HOURS` old, 24 by default), sortable by recently updated, newest, most followed, most visited
- Follows, a personal feed of updates from sites you follow, and a profile page per site (`/site/name`)
- Code editor (CodeMirror, loaded from cdnjs) with a sandboxed live preview for HTML files
- Moderation: public report form (linked from default 404/410 pages), `/admin` queue, take down / restore / delete, signup IPs, and a log of every moderator action
- Log in with site name or email; `/healthz` for an uptime monitor
- Abuse brakes: rate limits on signup, login, reports and guestbooks; honeypot fields; unconfirmed accounts purged after 3 days

## Deploy on a VPS

1. In Cloudflare DNS, point `A example.com` and `A *.example.com` at the server, set to **DNS only** (grey cloud). Create an API token with the "Edit zone DNS" template for that zone; Caddy uses it to get one wildcard certificate.
2. Install Docker (with the compose plugin), `curl`, `jq` and `cron`, then install the newest release:

   ```
   sudo mkdir -p /srv/puppypad && sudo chown "$USER" /srv/puppypad && cd /srv/puppypad
   curl -fsSL https://github.com/DeRusto/puppypad/releases/latest/download/install.sh | sh
   ```

   That unpacks the release, creates `.env` and `.env.caddy` from the examples, and adds the upgrade
   watcher (every minute) and the nightly backup (03:15) to your crontab. Fill in `.env` (BASE_DOMAIN, ACME_EMAIL, ADMIN_EMAILS, SMTP_*, SHOT_TOKEN)
   and `.env.caddy` (CF_API_TOKEN, only the Caddy container reads it), then `docker compose up -d`.
3. Sign up with an email you put in `ADMIN_EMAILS` and confirm it. Until SMTP is set, the confirmation link is in `docker compose logs app`.
4. Open `/admin` when logged in as that member.

Everything lives in `./data` (SQLite database plus `sites/`). Back that folder up.

## Backups

`scripts/backup.sh` takes a consistent copy of the database while the app runs, archives it with
every member's files into `./backups`, and keeps the last 14. Set `BACKUP_REMOTE` to an
[rclone](https://rclone.org) remote to copy the archives off the server too. `scripts/install.sh` schedules it every night at
03:15 in the installing user's crontab, logging to `backups/backup.log`.

To restore: `docker compose stop app`, delete `data/puppypad.db-wal` and `data/puppypad.db-shm`
(left over, they would be replayed onto the restored database and corrupt it), unpack an archive
into `./data`, rename `backup.db` to `puppypad.db`, and `docker compose start app`.
`docs/launch-checklist.md` has a restore test that doesn't touch the live data.

## Releases and upgrades

Servers run published releases, not the source tree. Publishing a GitHub release tagged `vX.Y.Z`
runs `.github/workflows/release.yml`, which tests the code, pushes the app, shots and Caddy images to
`ghcr.io/derusto/puppypad-{app,shots,caddy}:vX.Y.Z`, and attaches the deploy bundle, `install.sh`
and `SHA256SUMS` to the release. The first time, check that those three packages are public under
your GitHub profile > Packages, or servers can't pull them.

`scripts/install.sh` both installs and upgrades. In an install folder, `scripts/install.sh` moves to
the newest release and `scripts/install.sh v1.2.3` to a given one (older ones too). An upgrade:

1. downloads the release bundle and checks it against `SHA256SUMS`
2. pulls the new images (nothing has changed yet if this fails)
3. runs `scripts/backup.sh`
4. puts the release's files in place, sets `PUPPYPAD_VERSION` in `.env` and runs `docker compose up -d`
5. waits for `/healthz`; if the new release doesn't come up, it puts the previous files and version back

A rollback leaves the database as the new release left it, which is fine while schema changes only
add tables and columns. The backup from step 3 is the newest archive in `./backups` if one ever isn't.

**From /admin.** The "Server version" box at the bottom of `/admin` shows the running release, the
newest one with its notes, and a button that runs the upgrade above. The app never upgrades itself:
it runs in a container with no Docker access and no credentials. It only leaves a request in
`data/upgrade/`, and `scripts/upgrade-watch.sh` on the host, run every minute from the cron line the
installer adds, picks it up. The watcher only accepts "check" or the newest release's tag, so a
compromised app can at most ask for the release you published. It asks GitHub for the newest release
every `UPGRADE_CHECK_MINUTES` (60 by default); its output goes to `.upgrade/watch.log`, and the full
output of the last upgrade to `.upgrade/last.log`.

The app (uid 1000 in its container) and the watcher both write to `data/upgrade/`, which is
group-writable. If the user running the watcher isn't uid 1000 or root, the installer prints the one
`sudo chown` it needs.

**Moving a server from a git checkout to releases.** In the checkout, delete
`docker-compose.override.yml` (it makes compose build from source), run
`curl -fsSL https://github.com/DeRusto/puppypad/releases/latest/download/install.sh | sh`, then
`docker compose up -d`. `.env`, `.env.caddy`, `data/` and `backups/` stay as they are.

**Working on the code.** In the source tree, `docker-compose.override.yml` makes
`docker compose up -d --build` build the images locally instead of pulling them.

## Email that arrives

Confirmation mail lands in spam unless the domain vouches for your mail provider. `docs/launch-checklist.md`
has the exact records for puppypad.org. In general, in Cloudflare DNS for the domain, add the
records your provider gives you:

- **SPF**: one TXT record on the domain itself, e.g. `v=spf1 include:<provider's domain> ~all`.
  Merge providers into one record if you already have one.
- **DKIM**: the TXT or CNAME records the provider generates (usually under `..._domainkey`).
- **DMARC**: a TXT record named `_dmarc`, starting with `v=DMARC1; p=none; rua=mailto:you@yourdomain`.
  Move to `p=quarantine` once reports show your mail passing.

Then sign up with a Gmail address and check that the confirmation arrives in the inbox.

## Tests

`npm test` runs the suite in `test/`. GitHub Actions runs it on every push, along with
`npm audit` and a check that the Caddyfile is valid.

## Run locally

```
npm install
BASE_URL=http://localhost.test:3000 ADMIN_EMAILS=me@example.com node src/server.js
```

Add `127.0.0.1 localhost.test me.localhost.test` to your hosts file to see a member site.

Screenshots locally: `cd shots && npm install`, then run `APP_URL=http://localhost:3000 SHOT_TOKEN=x node worker.js` with the app started with the same `SHOT_TOKEN` (needs a Playwright Chromium install).

## Before you open signups

- **Mail**: public signups need real SMTP (any transactional mail provider works). Without it nobody can confirm.
- **Certificates**: Caddy (built from `caddy/Dockerfile` with the Cloudflare DNS plugin) gets one `*.yourdomain` certificate through a DNS challenge, so new member sites never wait on a certificate. Keep the DNS records grey-clouded: if you turn on Cloudflare's proxy, every visitor arrives from a Cloudflare IP, and the per-IP rate limits need to read the real address from `CF-Connecting-IP` first.
- **Cookies**: member pages run their own JavaScript on subdomains of your main domain. The login cookie is host-only with the `__Host-` prefix, so member sites cannot read or overwrite it. Serving member sites from a separate domain is stronger still, and is what the big hosts do.
- **Rules**: edit the rules page in `src/views.js`. As the operator you are the one who gets the takedown notices, so keep `ABUSE_EMAIL` monitored. If you are in the US, look into registering a DMCA agent.
- **Captcha**: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile) before opening signups. Without them only the honeypot and rate limits stand in the way of bots.
- **Phishing**: saving or uploading an HTML page with a password field, a card-number field or a big brand name in its title puts the site in the `/admin` queue as an "Auto-flag" report and emails `ABUSE_EMAIL`. The site stays online until a moderator looks.
- **Public Suffix List**: see `docs/public-suffix-list.md`.
- **Screenshots**: the `shots` container opens every member page in headless Chromium. It blocks requests to IP addresses and internal hostnames, but for defense in depth also firewall that container from your private network and the cloud metadata address (169.254.169.254).
- **Disk**: worst case is members x `QUOTA_MB`. Size the VPS disk or lower the quota.

## License

PuppyPad is free software, licensed under the [GNU Affero General Public License v3](LICENSE) — Copyright © 2026 Brandon Douglas Winterton. Run it, modify it, share it; if you run a modified version as a public service, publish your changes too.
