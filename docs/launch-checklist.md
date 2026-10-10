# Launch checklist: the steps only the operator can do

The code-side launch blockers in `PLAN.md` §2 are done. What's left needs your accounts, your DNS
and your server. Work top to bottom; each part ends with a check that proves it works.

Assumed throughout: the app lives in `/srv/puppypad` on the VPS, DNS is at Cloudflare, and the
`A puppypad.org` / `A *.puppypad.org` records from `PLAN.md` §5 already exist.

---

## 1. Mail that arrives (PLAN §2.7)

The plan: **send** from `mail.puppypad.org` through Resend, **receive** `abuse@puppypad.org` with
Cloudflare Email Routing, and publish a DMARC record that stops anyone else sending as
`puppypad.org` or as a member's `name.puppypad.org`.

Why a `mail.` subdomain: providers recommend it to keep sending reputation apart from the main
domain, and `mail` is already a reserved site name, so no member can ever claim it. (`send`,
`bounce`, `pm-bounces` and a few other names providers put records on are reserved too.)

### 1a. Receive abuse mail (Cloudflare Email Routing)

1. Cloudflare dashboard → `puppypad.org` → **Email** → **Email Routing** → **Get started**.
2. Let it add its records. You'll get three `MX` records on `puppypad.org`
   (`route1/2/3.mx.cloudflare.net`) and a TXT on `puppypad.org`:
   `v=spf1 include:_spf.mx.cloudflare.net ~all`. If an SPF record already exists, merge them into
   one; two `v=spf1` records on one name break SPF.
3. **Destination addresses**: add the inbox you actually read and click the verification link.
4. **Routing rules**: create `abuse@puppypad.org` → that inbox. Add `postmaster@` too, which
   some providers write to.
5. **Check:** send a message from your phone to `abuse@puppypad.org` and see it arrive.

Member subdomains have no MX record, so `anything@alice.puppypad.org` bounces. That is intended.

### 1b. Send through Resend

1. Sign up at resend.com → **Domains** → **Add domain** → `mail.puppypad.org`. Pick the region
   closest to the VPS.
2. Resend shows the records. Cloudflare can add them for you (the **Auto configure** button), or
   add them by hand. In Cloudflare's *Name* field type only the part before `puppypad.org`:

   | Type | Name | Content | Notes |
   |---|---|---|---|
   | MX | `send.mail` | `feedback-smtp.<region>.amazonses.com` | priority 10; copy the exact host from Resend |
   | TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` | |
   | TXT | `resend._domainkey.mail` | the `p=...` key from Resend | DKIM; copy it exactly |

3. Click **Verify** in Resend and wait for all three to go green.
4. **API Keys** → create a key with *Sending access* limited to `mail.puppypad.org`. Confirm on
   Resend's SMTP page that SMTP is on your plan and the settings below still match.
5. In `/srv/puppypad/.env`:

   ```
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=587
   SMTP_USER=resend
   SMTP_PASS=re_xxxxxxxx            # the API key
   MAIL_FROM=PuppyPad <noreply@mail.puppypad.org>
   ```

6. Apply it: `docker compose up -d app`. (`docker compose restart` does **not** re-read `.env`.)

**Limits to know:** Resend's free plan stops at 100 emails a day. Every signup and password reset
is one email, so a launch post can hit that by lunchtime and new members then can't confirm.
Move to the paid plan before you announce anywhere. If Gmail keeps putting the mail in spam
after everything passes, Postmark is the usual next try; it puts its records on `pm-bounces`,
which is reserved too.

### 1c. DMARC

1. Cloudflare → **Email** → **DMARC Management** → enable. It gives you a free report address
   (`...@dmarc-reports.cloudflare.net`) and a dashboard that reads the reports for you.
2. Set the TXT record it creates (or create it) to:

   | Type | Name | Content |
   |---|---|---|
   | TXT | `_dmarc` | `v=DMARC1; p=reject; sp=quarantine; rua=mailto:<your Cloudflare report address>` |

   - `p=reject`: nothing legitimately sends as `@puppypad.org` itself, so forged mail claiming to be
     from it is refused outright. (If you later want to reply *as* `abuse@puppypad.org`, that mail
     has to go out through a provider that signs for `puppypad.org` first.)
   - `sp=quarantine` covers every subdomain: your own `mail.` and every member's `name.`. Forged
     mail from `alice.puppypad.org` goes to spam.
3. After a week of reports in the DMARC dashboard showing `mail.puppypad.org` passing, change
   `sp=quarantine` to `sp=reject`.

### 1d. Check mail end to end

- [ ] Sign up on `puppypad.org` with a Gmail address. The confirmation lands in the **inbox**.
- [ ] In Gmail, open it → ⋮ → **Show original**. SPF, DKIM and DMARC all say `PASS`, and DKIM shows
      `mail.puppypad.org`.
- [ ] Optional: sign up once with the address mail-tester.com gives you; aim for 9/10 or better.
- [ ] Request a password reset and check that mail arrives too.
- [ ] Submit the report form on a test site; the notice reaches your inbox via `abuse@`.

---

## 2. Backups with an off-server copy (PLAN §2.6)

`scripts/backup.sh` already makes the archive. These steps put a copy somewhere that survives
losing the VPS, then prove a restore works. Cloudflare R2 is suggested because you already have
the account and 10 GB is free; Backblaze B2 works the same way.

### 2a. Create the bucket and key

1. Cloudflare → **R2** → **Create bucket** → `puppypad-backups`. Leave public access **off**: the
   archives hold emails, password hashes and IP addresses.
2. R2 → **Manage API tokens** → **Create API token** → *Object Read & Write*, limited to
   `puppypad-backups`. Note the *Access Key ID*, *Secret Access Key* and the S3 endpoint
   (`https://<account id>.r2.cloudflarestorage.com`).

### 2b. Set up rclone on the VPS

```
sudo -v ; curl https://rclone.org/install.sh | sudo bash
sudo rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<ACCESS KEY ID> secret_access_key=<SECRET> \
  endpoint=https://<ACCOUNT ID>.r2.cloudflarestorage.com no_check_bucket=true
sudo rclone lsd r2:                      # should list puppypad-backups
```

`no_check_bucket=true` is needed because the token can't list or create buckets. Run these with
`sudo` so the config lands in root's home, which is where cron will look.

Then add to `/srv/puppypad/.env`:

```
BACKUP_REMOTE=r2:puppypad-backups/nightly
```

### 2c. Run it once by hand, then schedule it

```
sudo /srv/puppypad/scripts/backup.sh
```

It should print `database copied`, `wrote backups/puppypad-….tar.gz` and
`synced to r2:puppypad-backups/nightly`. Check the copy is there:

```
sudo rclone ls r2:puppypad-backups/nightly
```

Then `sudo crontab -e` and add:

```
15 3 * * * /srv/puppypad/scripts/backup.sh >> /var/log/puppypad-backup.log 2>&1
```

Optional but worth it: a free check at healthchecks.io that emails you when a night is missed.
Append `&& curl -fsS -m 10 --retry 3 https://hc-ping.com/<your uuid>` to that cron line.

### 2d. Test a restore once (doesn't touch the live site)

This pulls the newest archive **back from R2**, so it proves the off-server copy too.

```
cd /srv/puppypad
sudo rm -rf /tmp/restore-test && sudo mkdir -p /tmp/restore-test
latest=$(sudo rclone lsf r2:puppypad-backups/nightly | sort | tail -n 1)
sudo rclone copy "r2:puppypad-backups/nightly/$latest" /tmp/restore-test
sudo tar -xzf "/tmp/restore-test/$latest" -C /tmp/restore-test

sudo docker compose run --rm --no-deps --user root -v /tmp/restore-test:/restore app node -e "
  const d = require('better-sqlite3')('/restore/backup.db');
  console.log('integrity:', d.pragma('integrity_check', { simple: true }));
  console.log('members:', d.prepare('SELECT COUNT(*) n FROM users').get().n);"

echo "sites in backup: $(ls /tmp/restore-test/sites | wc -l)   sites live: $(ls data/sites | wc -l)"
sudo rm -rf /tmp/restore-test
```

- [ ] `integrity: ok`
- [ ] the member count matches `/admin`
- [ ] the two site counts match (or differ only by sites created since 03:15)

For a real restore, follow the README's "Backups" section; it includes deleting the leftover
`-wal`/`-shm` files, which would otherwise corrupt the restored database.

---

## 3. Rules and privacy pages (PLAN §2.9)

Both live in `src/views.js` (`rules` and `privacy`). Read them on the live site, then check these
points. The ones in **bold** are things the current text gets wrong or leaves out.

**Privacy (`/privacy`)**

- [ ] **Say who runs it.** The page names no operator. Add your name (or the name you run it
      under) and country. Privacy laws such as the GDPR expect this.
- [x] IP addresses: guestbook and report IPs are now erased after 90 days, and the page says so.
      Signup IPs stay until the account is deleted.
- [ ] **Name the services that see data.** It mentions "our email provider" and Turnstile. Also
      true: Resend sends mail, Cloudflare runs DNS, forwards abuse mail and stores the backups
      (R2), and the editor loads CodeMirror from cdnjs (Cloudflare), which sees the member's IP.
- [ ] "Backups roll over within 14 days" holds with R2 as set up above (`rclone sync` deletes old
      archives, and R2 keeps no old versions). With B2, set the bucket lifecycle to *keep only the
      last version*, or it stays false.
- [ ] Delete the grey "Review this page before you launch…" note at the bottom. It shows publicly.

**Rules (`/rules`)**

- [ ] Read the eight rules and change any you don't intend to enforce. Keep 13+ unless you have
      a reason to change it; it matches the signup checkbox.
- [ ] Add how to send a copyright notice: "Copyright complaints: email abuse@puppypad.org with
      the URL and what you own." If you're in the US, register a DMCA agent at the Copyright
      Office's online directory (dmca.copyright.gov, $6, renew every 3 years) and put the agent's
      contact here.
- [ ] Delete the grey "Edit this page in src/views.js…" note at the bottom.

---

## 4. Public Suffix List (PLAN §2.4) — after launch

Do this once the site is live and a handful of real members have sites; the maintainers reject
empty platforms. Full steps and the exact entry are in `docs/public-suffix-list.md`. Before you
start:

- [ ] Site live with real member sites on subdomains.
- [ ] `puppypad.org` registered for **at least 2 more years**. Check the expiry at your registrar
      and renew ahead if needed.
- [ ] Re-read the PSL guidelines (linked in that doc); they change.

Then: open the PR on `publicsuffix/list`, add the `_psl` TXT record pointing at it, and leave the
record in place for good.
