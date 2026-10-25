# Caddy on-demand TLS beside the wildcard cert

Research for [#149](https://github.com/DeRusto/puppypad/issues/149), part of the map
[#148](https://github.com/DeRusto/puppypad/issues/148). Done 2026-10-25.

Read against Caddy **v2.10.2** (the `caddy:2.10` image in `caddy/Dockerfile`, CertMagic v0.24.0)
and the current **v2.11.7** (CertMagic v0.25.6). Where they differ, it says so.

**Recommendation: replace the global `acme_dns cloudflare …` with the global `dns cloudflare …`
option, add `tls { dns }` to the apex and wildcard blocks, and add a catch-all `https://` block
with `tls { on_demand }`.** A per-site `tls { issuer acme }` cannot opt out of `acme_dns`: Caddy
copies the global DNS provider into every ACME issuer, and an issuer with a DNS solver never
registers HTTP-01 or TLS-ALPN-01.

## 1. Why a per-site `issuer acme` does not escape `acme_dns`

- After building the automation policies, the Caddyfile adapter calls
  `fillInGlobalACMEDefaults` on **every** issuer of every policy, including issuers written in a
  site's `tls` block [1].
- In **v2.10.2**, when `acme_dns` is set, it unconditionally replaces the issuer's challenge config
  with a DNS-only one (`acmeIssuer.Challenges = &caddytls.ChallengesConfig{DNS: …}`). That also
  wipes any `disable_*` settings the site block made [1].
- In **v2.11.7**, it adds the global DNS provider whenever the issuer has no DNS provider of its
  own. An issuer with no `dns` still ends up with Cloudflare DNS [2].
- CertMagic registers the HTTP-01 and TLS-ALPN-01 solvers only `if iss.DNS01Solver == nil` [3].
  The Caddy docs say the same: "If the DNS challenge is enabled, other challenges are disabled by
  default" [4].

So with `acme_dns` set, a domain the Cloudflare token can't write to cannot get a certificate
through the Caddyfile. The fix:

- The global **`dns`** option only puts a provider on the TLS app (`tlsApp.DNSRaw`). It does not
  turn on DNS-01 for anyone [1].
- A site's `tls { dns }` with no provider name turns DNS-01 on for that site and uses the global
  provider. The adapter allows a bare `dns` exactly when the global `dns` option is set [5]. At
  provision time the issuer falls back to `tlsApp.dns` [6].
- The catch-all block then gets the default issuers: Let's Encrypt, then ZeroSSL because `email`
  is set [7]. Both use HTTP-01 / TLS-ALPN-01, chosen at random when both are enabled [4]. Ports 80
  and 443 are already published in `docker-compose.yml`.
- Small difference from today: a `tls { dns }` block builds one explicit ACME issuer (Let's
  Encrypt only). The wildcard loses today's ZeroSSL fallback unless you add `issuer acme` and
  `issuer zerossl` lines with `dns` in each.

## 2. Hostname matching: wildcard first, then on-demand

- A request is served by "the site block with the most specific matching address" [8], so
  `*.puppypad.org` and the apex keep their blocks. The host-less `https://` catches everything else.
- During the handshake, CertMagic checks the in-memory cache, including wildcard matches, before
  anything on-demand runs [9]. Member subdomains are served from the wildcard and never reach
  `ask`.
- Names the wildcard does not cover still reach the catch-all and its `ask`, for example
  `a.b.puppypad.org`. The endpoint must refuse every name under `BASE_DOMAIN`.

## 3. The `ask` endpoint contract

The code is identical in v2.10.2 and v2.11.7 (`modules/caddytls/ondemand.go`) [10]:

| | |
|---|---|
| Method | `GET` (`onDemandAskClient.Get`) |
| Query | the configured URL plus `domain=<name>`, merged into any existing query string (`qs.Set("domain", name)`). The value is the SNI name converted with `idna.Lookup.ToASCII`, which gives punycode and lowercase. A handshake without SNI sends the server's **local IP** instead, so the endpoint must reject IPs [9]. |
| Allow | any **2xx** (`resp.StatusCode < 200 \|\| > 299` → deny). The doc comment says "200 OK"; the code accepts all 2xx. |
| Deny | any other status. A transport error also denies, and the handshake fails. |
| Redirects | not followed; a redirect is an error, so a deny |
| Timeout | 10 s HTTP client timeout |
| Body | ignored |
| Placeholders | `{env.X}`-style placeholders in the URL are expanded; an unknown one is an error |

When `ask` is called (CertMagic [9]):

- **On every handshake whose name is not in the memory cache.** The call happens *before* Caddy
  even tries storage (`checkIfCertShouldBeObtained` precedes `loadCertFromStorage`). It also
  happens after a restart, and again for each cached on-demand cert that comes up for renewal.
  The interface comment warns it "may be called as frequently as every TLS handshake" [10], so
  keep it fast: one indexed DB lookup, no live DNS query.
- Not called for names already in cache, such as the wildcard and the apex.

Other rules:

- On-demand without an `ask` (or `permission`) module fails to provision. The error is "on-demand
  TLS cannot be enabled without a permission module" [11].
- The global `on_demand_tls` options `interval` and `burst` "are NOT recommended". The docs say to
  remove them [12].
- The endpoint stays unreachable from outside, because `(common)` already answers
  `/internal/*` with 404. Caddy calls `app:3000` on the Docker network directly.

What `/internal/tls-check` should return 2xx for: the name is a custom domain whose TXT
verification has passed, and it is not under `BASE_DOMAIN`. The section 4 limits make it worth
also requiring that the domain resolves to this server at verification time, because an approved
domain whose DNS points elsewhere costs a failed validation per handshake attempt.

## 4. Let's Encrypt limits for many unrelated domains

From the Let's Encrypt rate-limits page, last modified 2026-08-05 [13]:

| Limit | Value | Applies to us? |
|---|---|---|
| New orders per account | 300 per 3 h, refills 1 per 36 s | Yes: every *first* certificate for a custom domain is a new order. Overridable on request. |
| New certificates per registered domain | 50 per 7 days, refills 1 per 202 min | Per supporter's domain, so practically no. Unrelated domains don't share it. |
| New certificates per exact identifier set | 5 per 7 days, refills 1 per 34 h, no overrides | Only if we keep re-issuing one name, e.g. after losing the `caddy_data` volume |
| Authorization failures per identifier per account | 5 per hour, refills 1 per 12 min, no overrides | Yes, when a verified domain's DNS doesn't point at us |
| Consecutive authorization failures per identifier | 1,152, refills 1 per day, reset by a success; then that identifier is **paused** until unpaused in the Self-Service Portal | Same cause, over months |
| New registrations | 10 per IP per 3 h | No. Caddy keeps one account per CA + email. |
| Overall per-IP request limits | e.g. new-order 300/s | No |

Renewals:

- Orders that carry ARI's `replaces` are "exempt from all rate limits" [13]. Non-ARI renewals with
  the exact same names skip the per-account and per-domain limits, but not the exact-set or
  failure limits [13].
- CertMagic sets `replaces` on renewals unless ARI is disabled or the order goes to the staging CA
  (`ctxKeyARIReplaces`, `params.Replaces`) [14]. On-demand renewals therefore count as ARI renewals.
- Certificate lifetimes are shrinking. The default `classic` profile moves to 64-day certificates
  on 2027-02-10 and to 45-day certificates on 2028-02-16 [15]. More renewal handshakes will come,
  but they are exempt.

How Caddy throttles and retries:

- **Internal throttle:** 10 orders per 10 s sliding window, keyed by CA directory + account email
  (`RateLimitEvents = 10`, `RateLimitEventsWindow = 10s`) [3]. The docs: "10 attempts per ACME
  account per 10 seconds" [4]. Staging-CA retries skip it [14].
- **On-demand obtain:** the handshake runs `ObtainCertAsync` under a **180 s** context.
  Concurrent handshakes for the same name wait up to 2 min on the one in flight [9].
  `doWithRetry` retries after 1 min, then 2 min, and so on, but the 180 s context ends it after
  about 2 attempts [16]. Retries (attempt > 0) go to the CA's **staging** endpoint, so they don't
  burn production failure limits. Caddy retries production only once staging succeeds [14].
- **No memory of failures across handshakes.** CertMagic keeps no per-name negative cache, so the
  next handshake for a failing name runs `ask` and a fresh order again [9]. The only brakes are the
  10/10 s throttle and Let's Encrypt's own limits. This is the strongest reason for `ask` to approve
  only domains that are verified *and* pointed at us.
- **Fallback:** when Let's Encrypt fails, the next issuer, ZeroSSL, is tried. ZeroSSL has its own
  limits [4][7].
- **Background renewal skips on-demand certs entirely** (`if cfg.OnDemand != nil { continue }` in
  the maintenance loop) [17]. They renew during a handshake once `certNeedsRenewal` says so.
  A site with no visitors is never renewed, and its next visitor waits for a fresh issuance.

## 5. Storage and cleanup of a removed domain

**Where certificates live.**

- Key layout: `certificates/<issuer key>/<domain>/<domain>.{crt,key,json}` [18]. The issuer key is
  the CA directory host and path, e.g. `acme-v02.api.letsencrypt.org-directory`.
- Caddy keeps them under `$XDG_DATA_HOME/caddy`. The official image sets `XDG_DATA_HOME=/data`
  [19], and `docker-compose.yml` mounts the named volume `caddy_data` there. On-demand and wildcard
  certs share that volume.

**What happens when a supporter removes a domain** (the app's `ask` starts returning non-2xx):

1. **Until the cert is due for renewal or Caddy restarts,** the cert stays in the memory cache and
   is served without consulting `ask` [9]. The app must therefore answer an unknown `Host` with
   404, not a member page.
2. **At renewal time,** `checkIfCertShouldBeObtained` fails. The cert is removed from the cache
   ("it will be deleted from storage later") and no new order is placed [9].
3. **After a restart,** `ask` runs before any storage load, so a denied name is never loaded [9].
4. **On disk,** the storage cleaner runs every `storage_clean_interval` (default 24 h) [12][20].
   It deletes the `.crt`, `.key` and `.json` of any certificate expired **14 days or more**
   (`ExpiredCertGracePeriod: 24 * time.Hour * 14`) [20][21].

There is no Caddy command to drop one name. To purge one sooner, delete its
`certificates/*/<domain>/` folder from the volume. The worst case is that files linger for about
2 weeks past expiry. There is no reason to revoke, because the key never left the server.

## 6. Different headers for the custom-domain block

Yes. Each site block runs its own handler chain, and a snippet can take arguments (`{args[0]}`)
[8]. Pass the HSTS value in as an argument instead of hard-coding it in `(common)`, so the
`(common)` snippet stays shared. `includeSubDomains` stays on `puppypad.org`. Custom domains get
plain `max-age`, because a supporter's other subdomains aren't ours to pin.

## 7. Minimal Caddyfile sketch

Not run through `caddy adapt`: no Docker or Caddy binary was available here. Check it with
`docker compose run --rm caddy caddy adapt --config /etc/caddy/Caddyfile` before shipping.

```caddyfile
{
	email {$ACME_EMAIL}
	# Provider only. Unlike acme_dns, it does not force DNS-01 onto every site,
	# so the catch-all below can use HTTP-01 / TLS-ALPN-01.
	dns cloudflare {$CF_API_TOKEN}
	on_demand_tls {
		ask http://app:3000/internal/tls-check
	}
}

(common) {
	encode gzip
	header Strict-Transport-Security "{args[0]}"
	# ... rest of (common) unchanged ...
	reverse_proxy app:3000
}

{$BASE_DOMAIN}, www.{$BASE_DOMAIN} {
	tls {
		dns
	}
	import common "max-age=31536000; includeSubDomains"
}

*.{$BASE_DOMAIN} {
	tls {
		dns
	}
	import common "max-age=31536000; includeSubDomains"
}

# Supporters' custom domains: one cert per domain on first visit, gated by the app.
https:// {
	tls {
		on_demand
	}
	import common "max-age=31536000"
}
```

App-side contract for `/internal/tls-check?domain=<name>`:

- Return 200 only for a TXT-verified custom domain that is not under `BASE_DOMAIN`.
- Return 404 for everything else.
- Answer well inside 10 s.

## References

1. Caddy v2.10.2, `caddyconfig/httpcaddyfile/tlsapp.go` (`fillInGlobalACMEDefaults`, the global-`dns` → `tlsApp.DNSRaw` block, the finalize loop): https://github.com/caddyserver/caddy/blob/v2.10.2/caddyconfig/httpcaddyfile/tlsapp.go
2. Caddy v2.11.7, same file: https://github.com/caddyserver/caddy/blob/v2.11.7/caddyconfig/httpcaddyfile/tlsapp.go
3. CertMagic v0.25.6, `acmeclient.go` (solver registration, `throttle`, `RateLimitEvents`): https://github.com/caddyserver/certmagic/blob/v0.25.6/acmeclient.go
4. Caddy docs, Automatic HTTPS (challenges, errors/retries, internal rate limit, storage): https://caddyserver.com/docs/automatic-https
5. Caddy v2.10.2, `caddyconfig/httpcaddyfile/builtins.go` (`tls` → `dns` with optional provider): https://github.com/caddyserver/caddy/blob/v2.10.2/caddyconfig/httpcaddyfile/builtins.go
6. Caddy v2.10.2, `modules/caddytls/acmeissuer.go` (`Provision`, fallback to `tlsApp.dns`): https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddytls/acmeissuer.go
7. Caddy v2.10.2, `modules/caddytls/automation.go` (`DefaultIssuers`, permission-module requirement): https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddytls/automation.go
8. Caddy docs, Caddyfile concepts (snippet args, catch-all `https://`, most-specific match): https://caddyserver.com/docs/caddyfile/concepts
9. CertMagic v0.25.6, `handshake.go` (`getCertDuringHandshake`, `checkIfCertShouldBeObtained`, `obtainOnDemandCertificate`, `renewDynamicCertificate`): https://github.com/caddyserver/certmagic/blob/v0.25.6/handshake.go
10. Caddy `modules/caddytls/ondemand.go` (identical in v2.10.2 and v2.11.7): https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddytls/ondemand.go
11. Caddy v2.11.7, `modules/caddytls/automation.go`: https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddytls/automation.go
12. Caddy docs, global options (`on_demand_tls`, `storage_clean_interval`, `dns`, `acme_dns`): https://caddyserver.com/docs/caddyfile/options
13. Let's Encrypt, Rate Limits (lastmod 2026-08-05): https://letsencrypt.org/docs/rate-limits/ (source: https://github.com/letsencrypt/website/blob/main/content/en/docs/rate-limits.md)
14. CertMagic v0.25.6, `acmeissuer.go` (`Issue`, `doIssue`: staging CA on retries, throttle skipped for staging, ARI `Replaces`): https://github.com/caddyserver/certmagic/blob/v0.25.6/acmeissuer.go
15. Let's Encrypt, "Decreasing Certificate Lifetimes to 45 Days" (2025-12-02): https://letsencrypt.org/2025/12/02/from-90-to-45/
16. CertMagic v0.25.6, `async.go` (`doWithRetry`, `retryIntervals`, `maxRetryDuration` = 30 days): https://github.com/caddyserver/certmagic/blob/v0.25.6/async.go
17. CertMagic v0.25.6, `maintain.go` (`RenewManagedCertificates` skips `OnDemand`; `CleanStorage`, `deleteExpiredCerts`): https://github.com/caddyserver/certmagic/blob/v0.25.6/maintain.go
18. CertMagic v0.25.6, `storage.go` (`KeyBuilder.SiteCert` etc.): https://github.com/caddyserver/certmagic/blob/v0.25.6/storage.go
19. caddy-docker `Dockerfile.tmpl` (`ENV XDG_DATA_HOME=/data`): https://github.com/caddyserver/caddy-docker/blob/master/Dockerfile.tmpl
20. Caddy v2.10.2, `modules/caddytls/tls.go` (`cleanStorageUnits`, `defaultStorageCleanInterval = 24h`): https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddytls/tls.go
21. Caddy v2.11.7, same file (same 14-day grace period and 24 h interval): https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddytls/tls.go
