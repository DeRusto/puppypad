#!/bin/sh
# Installs PuppyPad from a GitHub release, or upgrades an install to a newer (or older) release.
#
# First install, on the server, as a user that can run docker:
#   sudo mkdir -p /srv/puppypad && sudo chown "$USER" /srv/puppypad && cd /srv/puppypad
#   curl -fsSL https://github.com/DeRusto/puppypad/releases/latest/download/install.sh | sh
# That unpacks the newest release into the current folder, creates .env and .env.caddy from the
# examples, and adds cron lines for scripts/upgrade-watch.sh and the nightly scripts/backup.sh. It
# doesn't start anything: fill in
# .env and .env.caddy, then run docker compose up -d.
#
# Upgrade, from the install folder (the button on /admin runs the same thing through the watcher):
#   scripts/install.sh            # the newest release
#   scripts/install.sh v1.2.3     # a specific release, newer or older
# It downloads the release, pulls its images, backs up, switches, and switches back if the app
# doesn't come up healthy.
#
# Needs docker (with compose), curl, jq, flock, sha256sum, tar, timeout, crontab and rsync. Releases come from
# UPGRADE_REPO (in .env or the environment), DeRusto/puppypad by default.
set -eu

# everything is in main(), so when this is piped into sh the shell has read the whole script before
# running any of it, and docker and the other commands below can't eat the rest of it from stdin
main() {
exec </dev/null

# run from scripts/install.sh: the install folder is one up. Piped into sh: the current folder.
case "$0" in */scripts/install.sh|scripts/install.sh) cd "$(dirname "$0")/.." ;; esac

# an upgrade replaces this file, so run from a copy of our own (also one level down, so the line
# above lands in the same folder); a copy per run, so a second run can't rewrite the one in use
case "$0" in
  */scripts/install.sh|scripts/install.sh)
    mkdir -p .upgrade
    copy=$(mktemp .upgrade/install-XXXXXX)
    cp scripts/install.sh "$copy"
    PUPPYPAD_INSTALL_COPY=1 exec sh "$copy" "$@" ;;
esac
# the shell holds the copy open, so it can go now
[ "${PUPPYPAD_INSTALL_COPY:-}" = 1 ] && rm -f "$0"
root=$(pwd)

missing=""
for c in docker curl jq flock sha256sum tar timeout crontab rsync; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
docker compose version >/dev/null 2>&1 || missing="$missing docker-compose-plugin"
[ -z "$missing" ] || { echo "install these first:$missing"; exit 1; }

if [ -f docker-compose.override.yml ]; then
  echo "docker-compose.override.yml is here (it comes from a git checkout), so docker compose would"
  echo "build from source instead of running the release images. Delete it and run this again."; exit 1
fi

# one install or upgrade at a time, whether started by hand or by the watcher
mkdir -p .upgrade
exec 8>.upgrade/upgrade.lock
flock -n 8 || { echo "another upgrade is already running"; exit 1; }

env_val() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d "\"'\r"; }
# rewrites one line of .env in place (same file, so its owner and mode stay)
set_env() {
  tmp=$(mktemp .upgrade/env-XXXXXX)
  { grep -v "^$1=" .env || true; echo "$1=$2"; } > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}
is_tag() { echo "$1" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+'; }
# every network step has a time limit: a stalled one would otherwise hold the upgrade locks forever,
# and the watcher could never notice the run had died
fetch() { curl -fsSL --connect-timeout 15 --max-time 300 "$@"; }

[ -n "${UPGRADE_REPO:-}" ] || UPGRADE_REPO=$(env_val UPGRADE_REPO)
repo=${UPGRADE_REPO:-DeRusto/puppypad}
echo "$repo" | grep -Eqx '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' || { echo "bad UPGRADE_REPO: $repo"; exit 1; }
web=${UPGRADE_GITHUB_URL:-https://github.com}
api=${UPGRADE_API_URL:-https://api.github.com}

# the upgrade watcher (every minute) and the nightly backup (03:15), each added once to this user's
# crontab; also put back on upgrades in case one went missing
add_cron() { # add_cron <script> <schedule> <log>
  line="$2 $root/scripts/$1 >> $3 2>&1"
  if crontab -l 2>/dev/null | grep -qF "$root/scripts/$1"; then return 0; fi
  if { crontab -l 2>/dev/null || true; echo "$line"; } | crontab -; then
    echo "added to $(id -un)'s crontab: $line"
  else
    echo "couldn't edit the crontab; add this line yourself: $line"
  fi
}
ensure_cron() {
  mkdir -p backups
  add_cron upgrade-watch.sh '* * * * *' "$root/.upgrade/watch.log"
  add_cron backup.sh '15 3 * * *' "$root/backups/backup.log"
}

# the app runs as uid 1000 in its container and writes to data/; the watcher (this user) and the app
# both write to data/upgrade/. Also run on upgrades, since a git checkout being migrated has never
# had it set up.
ensure_upgrade_dir() {
  mkdir -p data/upgrade 2>/dev/null || true
  chmod 770 data/upgrade 2>/dev/null || true
  if [ "$(id -u)" = 0 ]; then
    chown 1000:1000 data data/upgrade
  elif [ "$(id -u)" != 1000 ]; then
    if [ "$(stat -c %u data 2>/dev/null)" != 1000 ] || [ "$(stat -c %u data/upgrade 2>/dev/null)" != 1000 ] || [ ! -w data/upgrade ]; then
      echo "the app (uid 1000) and this user both need to write to data/upgrade; run once: sudo chown 1000:1000 data && sudo chown 1000:$(id -gn) data/upgrade && sudo chmod 770 data/upgrade"
    fi
  fi
}

# what is here now: a release (VERSION), a deployment from a git checkout (.env and a database but no
# VERSION, which gets the same backup and rollback as an upgrade), or nothing
old=$(cat VERSION 2>/dev/null || true)
mode=fresh
if [ -n "$old" ]; then mode=upgrade; elif [ -f .env ] && [ -f data/puppypad.db ]; then mode=migrate; fi
target=${1:-}
if [ -z "$target" ]; then
  target=$(fetch "$api/repos/$repo/releases/latest" | jq -r .tag_name)
fi
is_tag "$target" || { echo "not a release tag: $target"; exit 1; }
# a first install writes README.md, LICENSE, docker-compose.yml and scripts/ here, so only into a folder holding nothing else
if [ "$mode" = fresh ] && ls -A | grep -vqxE '\.env|\.env\.caddy|\.upgrade'; then
  echo "$root has other files in it; run this in an empty folder (README.md, \"Deploy on a VPS\")"; exit 1
fi
# VERSION is written last, but an install wedged by an older installer can have the new VERSION with
# the old images, so .env has to agree too
if [ "$old" = "$target" ] && [ "$(env_val PUPPYPAD_VERSION)" = "$target" ]; then ensure_cron; echo "already on $target"; exit 0; fi

echo "== downloading $target"
new=.upgrade/new
rm -rf "$new"; mkdir -p "$new/files"
fetch -o "$new/puppypad-$target.tar.gz" "$web/$repo/releases/download/$target/puppypad-$target.tar.gz"
fetch -o "$new/SHA256SUMS" "$web/$repo/releases/download/$target/SHA256SUMS"
(cd "$new" && grep " puppypad-$target.tar.gz\$" SHA256SUMS | sha256sum -c --quiet -) || { echo "the download doesn't match its checksum"; exit 1; }
tar -xzf "$new/puppypad-$target.tar.gz" -C "$new/files" --no-same-owner
[ "$(cat "$new/files/VERSION" 2>/dev/null)" = "$target" ] || { echo "the bundle isn't $target"; exit 1; }
files=$(cd "$new/files" && find . -type f | sed 's|^\./||' | sort)

# the release's own installer does the rest: a fix to how upgrades work then applies to the upgrade
# that brings it, not only to the one after. Its copy came with the checksummed bundle; it downloads
# and checks again, then finds itself identical and carries on. Once per run, so two releases can't
# hand back and forth.
if [ "${PUPPYPAD_HANDED_OFF:-}" != "$target" ] && ! cmp -s "$new/files/scripts/install.sh" scripts/install.sh; then
  echo "== handing over to $target's installer"
  copy=$(mktemp .upgrade/install-XXXXXX)
  cp "$new/files/scripts/install.sh" "$copy"
  PUPPYPAD_INSTALL_COPY=1 PUPPYPAD_HANDED_OFF=$target exec sh "$copy" "$target"
fi

# the images the release pushed, by digest (releases from v0.1.2 on). A tag can be pushed again; a
# digest can't, so pulling by digest is what ties the code to the checksummed bundle. Older bundles
# have no IMAGES and run by tag, so the variables are emptied for them.
img_val() { sed -n "s/^$1=//p" "$new/files/IMAGES" | grep -Ex '[a-z0-9./_-]+@sha256:[0-9a-f]{64}' | tail -n 1; }
app_img="" shots_img="" caddy_img=""
if [ -f "$new/files/IMAGES" ]; then
  app_img=$(img_val app) shots_img=$(img_val shots) caddy_img=$(img_val caddy)
  [ -n "$app_img" ] && [ -n "$shots_img" ] && [ -n "$caddy_img" ] || { echo "the bundle's IMAGES file is malformed"; exit 1; }
fi
set_images() { set_env PUPPYPAD_APP_IMAGE "$1"; set_env PUPPYPAD_SHOTS_IMAGE "$2"; set_env PUPPYPAD_CADDY_IMAGE "$3"; }

# copies the release's files into place, each renamed in so a running script keeps its old copy.
# VERSION is left for put_version, once the switch has worked: it is what says "already on".
put_files() {
  for f in $files; do
    [ "$f" = VERSION ] && continue
    mkdir -p "$(dirname "$f")"
    cp -p "$new/files/$f" "$f.new" && mv -f "$f.new" "$f"
  done
}
put_version() { cp -p "$new/files/VERSION" VERSION.new && mv -f VERSION.new VERSION; }

# ---------- first install ----------
if [ "$mode" = fresh ]; then
  put_files
  [ -f .env ] || cp .env.example .env
  [ -f .env.caddy ] || { cp .env.caddy.example .env.caddy; chmod 600 .env.caddy; }
  set_env PUPPYPAD_VERSION "$target"
  set_images "$app_img" "$shots_img" "$caddy_img"
  put_version
  rm -rf "$new"
  ensure_cron
  ensure_upgrade_dir
  cat <<EOF

PuppyPad $target is installed in $root. Next:
  1. Fill in .env (BASE_DOMAIN, ACME_EMAIL, ADMIN_EMAILS, SMTP_*, SHOT_TOKEN) and .env.caddy (CF_API_TOKEN).
  2. docker compose up -d
  3. Optional: set BACKUP_REMOTE in .env to copy the nightly backups off this server (README.md, "Backups").
EOF
  exit 0
fi

# ---------- upgrade ----------
[ -f .env ] || { echo "no .env here"; exit 1; }

# fetch the new images before touching anything, so a missing image stops here with nothing changed
echo "== pulling images"
PUPPYPAD_VERSION=$target PUPPYPAD_APP_IMAGE=$app_img PUPPYPAD_SHOTS_IMAGE=$shots_img PUPPYPAD_CADDY_IMAGE=$caddy_img \
  timeout 1200 docker compose -f "$new/files/docker-compose.yml" --project-directory "$root" pull --quiet

echo "== backing up before the upgrade"
scripts/backup.sh

# keep what a rollback puts back: the files this release replaces, the ones it adds, and the .env
# values it changes. prev.env is written last and removed once the upgrade is settled, so if it is
# still here an earlier attempt died after switching, and what it kept is still the last working
# state; saving again now would keep that attempt's half-done files instead.
prev=.upgrade/prev.tar prevenv=.upgrade/prev.env
if [ ! -f "$prevenv" ]; then
  existing=$(for f in $files; do [ -f "$f" ] && echo "$f"; done; true)
  if [ -n "$existing" ]; then tar -cf "$prev" $existing; else tar -cf "$prev" -T /dev/null; fi
  for f in $files; do [ -f "$f" ] || echo "$f"; done > .upgrade/prev.added
  for k in PUPPYPAD_VERSION PUPPYPAD_APP_IMAGE PUPPYPAD_SHOTS_IMAGE PUPPYPAD_CADDY_IMAGE; do env_val $k; done > "$prevenv.tmp"
  mv -f "$prevenv.tmp" "$prevenv"
else
  # the attempt that died may have been for another release: cover whatever paths this one adds to
  # the list (neither that attempt nor the working release touched them, so they can be saved now)
  known=$({ tar -tf "$prev"; cat .upgrade/prev.added; } | sort -u)
  for f in $files; do
    echo "$known" | grep -qxF "$f" && continue
    if [ -f "$f" ]; then tar -rf "$prev" "$f"; else echo "$f" >> .upgrade/prev.added; fi
  done
fi
added=$(cat .upgrade/prev.added)
prev_env() { sed -n "$1p" "$prevenv"; }
echo "== switching ${old:-the git checkout} -> $target"
put_files
set_env PUPPYPAD_VERSION "$target"
set_images "$app_img" "$shots_img" "$caddy_img"
ensure_cron
ensure_upgrade_dir

# waits for /healthz inside the app container; true once it answers 200. Asks with the public hostname
# as Host (fetch() can't set it), since releases up to v0.1.0 only serve /healthz on that name.
healthy() {
  i=0
  while [ $i -lt 30 ]; do
    if timeout 20 docker compose exec -T app node -e "require('http').get({ host: 'localhost', port: 3000, path: '/healthz', headers: { host: new URL(process.env.BASE_URL || 'http://localhost').host } }, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)).setTimeout(5000, () => process.exit(1))" 2>/dev/null; then
      return 0
    fi
    i=$((i + 1)); sleep 3
  done
  return 1
}

# the app answering isn't enough: Caddy or shots crash-looping (a Caddyfile the new Caddy rejects, say)
# still passes `up -d` and /healthz. Every service has to be running for 15 seconds without a restart
# in between (restart count and start time unchanged), so one that crashes and comes back between
# two looks still counts as down.
starts() { docker compose ps -q | xargs -r docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' | sort; }
all_running() {
  want=$(docker compose config --services | sort)
  first=$(starts) i=0
  while [ $i -lt 3 ]; do
    sleep 5
    if [ "$(docker compose ps --status running --services | sort)" != "$want" ] || [ "$(starts)" != "$first" ]; then
      echo "not every service stayed up:"; docker compose ps --all; return 1
    fi
    i=$((i + 1))
  done
}

if docker compose up -d --remove-orphans && healthy && all_running; then
  put_version
  rm -rf "$new" "$prevenv"
  echo "== upgraded to $target"
  [ "$mode" = upgrade ] || echo "this folder now runs releases; the git checkout's other files are no longer used"
  exit 0
fi

echo "== $target did not come up healthy; going back"
tar -xf "$prev"
for f in $added; do rm -f "$f"; done
set_env PUPPYPAD_VERSION "$(prev_env 1)"
set_images "$(prev_env 2)" "$(prev_env 3)" "$(prev_env 4)"
rm -f "$prevenv" # back on the last working state, so the next attempt starts from here
docker compose up -d --remove-orphans || true
# the database stays as the new release left it: schema changes are new tables and columns, which
# older code ignores. If a release ever needs more, backups/latest still holds the database from before the upgrade.
if healthy; then echo "$target failed its health check; went back to ${old:-the git checkout}"
else echo "went back to ${old:-the git checkout}, but it is not healthy either; check docker compose logs app"; fi
exit 1
}

main "$@"
