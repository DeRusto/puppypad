# PuppyPad

A free old-web homepage host. Accidents welcome. Every member gets `name.yourdomain`, a file manager, an in-browser HTML editor, a hit counter, a guestbook and a webring link. Static files only.

## What's in the box

- Signup with email confirmation, login, password reset, account deletion (a deleted site's name is held for 90 days)
- Per-member folder with uploads, folders, text editor, quota (50 MB) and file-type allowlist
- Member sites served on their own subdomain, with custom `not_found.html`
- Widgets: `/_hw/counter.svg`, `/_hw/guestbook` (owner can delete entries), webring prev/next/random
- Explore page with a screenshot of every site, sortable by recently updated, newest, most followed, most visited
- Follows, a personal feed of updates from sites you follow, and a profile page per site (`/site/name`)
- Code editor (CodeMirror, loaded from cdnjs) with a sandboxed live preview for HTML files
- Moderation: public report form, `/admin` queue, take down / restore / delete, signup IPs
- Abuse brakes: rate limits on signup, login, reports and guestbooks; honeypot fields; unconfirmed accounts purged after 3 days

## Deploy on a VPS

1. In Cloudflare DNS, point `A example.com` and `A *.example.com` at the server, set to **DNS only** (grey cloud). Create an API token with the "Edit zone DNS" template for that zone; Caddy uses it to get one wildcard certificate.
2. Install Docker, copy this folder up, then:

   ```
   cp .env.example .env     # fill in BASE_DOMAIN, ACME_EMAIL, CF_API_TOKEN, ADMIN_EMAILS, SMTP_*
   docker compose up -d --build
   ```
3. Sign up with an email you put in `ADMIN_EMAILS` and confirm it. Until SMTP is set, the confirmation link is in `docker compose logs app`.
4. Open `/admin` when logged in as that member.

Everything lives in `./data` (SQLite database plus `sites/`). Back that folder up.

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
- **Captcha**: there is a honeypot and rate limits, no captcha. Add one to `/signup` if bots find you.
- **Screenshots**: the `shots` container opens every member page in headless Chromium. It blocks requests to IP addresses and internal hostnames, but for defense in depth also firewall that container from your private network and the cloud metadata address (169.254.169.254).
- **Disk**: worst case is members x `QUOTA_MB`. Size the VPS disk or lower the quota.
