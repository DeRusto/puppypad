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
# Needs docker (with compose), curl, jq, flock, sha256sum, tar and crontab. Releases come from
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
for c in docker curl jq flock sha256sum tar crontab; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
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

# what is here now: a release (VERSION), a deployment from a git checkout (.env and a database but no
# VERSION, which gets the same backup and rollback as an upgrade), or nothing
old=$(cat VERSION 2>/dev/null || true)
mode=fresh
if [ -n "$old" ]; then mode=upgrade; elif [ -f .env ] && [ -f data/puppypad.db ]; then mode=migrate; fi
target=${1:-}
if [ -z "$target" ]; then
  target=$(curl -fsSL "$api/repos/$repo/releases/latest" | jq -r .tag_name)
fi
is_tag "$target" || { echo "not a release tag: $target"; exit 1; }
if [ "$old" = "$target" ]; then ensure_cron; echo "already on $target"; exit 0; fi

echo "== downloading $target"
new=.upgrade/new
rm -rf "$new"; mkdir -p "$new/files"
curl -fsSL -o "$new/puppypad-$target.tar.gz" "$web/$repo/releases/download/$target/puppypad-$target.tar.gz"
curl -fsSL -o "$new/SHA256SUMS" "$web/$repo/releases/download/$target/SHA256SUMS"
(cd "$new" && grep " puppypad-$target.tar.gz\$" SHA256SUMS | sha256sum -c --quiet -) || { echo "the download doesn't match its checksum"; exit 1; }
tar -xzf "$new/puppypad-$target.tar.gz" -C "$new/files" --no-same-owner
[ "$(cat "$new/files/VERSION" 2>/dev/null)" = "$target" ] || { echo "the bundle isn't $target"; exit 1; }
files=$(cd "$new/files" && find . -type f | sed 's|^\./||' | sort)

# copies the release's files into place, each renamed in so a running script keeps its old copy
put_files() {
  for f in $files; do
    mkdir -p "$(dirname "$f")"
    cp -p "$new/files/$f" "$f.new" && mv -f "$f.new" "$f"
  done
}

# ---------- first install ----------
if [ "$mode" = fresh ]; then
  put_files
  rm -rf "$new"
  [ -f .env ] || cp .env.example .env
  [ -f .env.caddy ] || { cp .env.caddy.example .env.caddy; chmod 600 .env.caddy; }
  set_env PUPPYPAD_VERSION "$target"
  ensure_cron
  # the app runs as uid 1000 in its container and writes to data/; the watcher (this user) and the
  # app both write to data/upgrade/
  mkdir -p data/upgrade
  chmod 770 data/upgrade
  if [ "$(id -u)" = 0 ]; then
    chown 1000:1000 data data/upgrade
  elif [ "$(id -u)" != 1000 ]; then
    echo "the app (uid 1000) needs to write to data/; run once: sudo chown 1000:1000 data && sudo chown 1000:$(id -gn) data/upgrade"
  fi
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
PUPPYPAD_VERSION=$target docker compose -f "$new/files/docker-compose.yml" --project-directory "$root" pull --quiet

echo "== backing up before the upgrade"
scripts/backup.sh

# keep the files this release replaces, to put back on a rollback, and note the ones it adds
prev=.upgrade/prev.tar
existing=$(for f in $files; do [ -f "$f" ] && echo "$f"; done; true)
added=$(for f in $files; do [ -f "$f" ] || echo "$f"; done; true)
if [ -n "$existing" ]; then tar -cf "$prev" $existing; else tar -cf "$prev" -T /dev/null; fi

echo "== switching ${old:-the git checkout} -> $target"
put_files
set_env PUPPYPAD_VERSION "$target"
ensure_cron

# waits for /healthz inside the app container; true once it answers 200
healthy() {
  i=0
  while [ $i -lt 30 ]; do
    if docker compose exec -T app node -e "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
      return 0
    fi
    i=$((i + 1)); sleep 3
  done
  return 1
}

if docker compose up -d --remove-orphans && healthy; then
  rm -rf "$new"
  echo "== upgraded to $target"
  [ "$mode" = upgrade ] || echo "this folder now runs releases; the git checkout's other files are no longer used"
  exit 0
fi

echo "== $target did not come up healthy; going back"
tar -xf "$prev"
for f in $added; do rm -f "$f"; done
if [ -n "$old" ]; then set_env PUPPYPAD_VERSION "$old"; else set_env PUPPYPAD_VERSION ""; fi
docker compose up -d --remove-orphans || true
# the database stays as the new release left it: schema changes are new tables and columns, which
# older code ignores. If a release ever needs more, the backup from before the upgrade is the newest archive in ./backups.
if healthy; then echo "$target failed its health check; went back to ${old:-the git checkout}"
else echo "went back to ${old:-the git checkout}, but it is not healthy either; check docker compose logs app"; fi
exit 1
}

main "$@"
