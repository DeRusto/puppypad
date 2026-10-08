# Caddy with the Cloudflare DNS plugin, so it can get one *.puppypad.org certificate via a DNS-01 challenge
FROM caddy:2.10-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.10
COPY --from=build /usr/bin/caddy /usr/bin/caddy
