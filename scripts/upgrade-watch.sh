#!/bin/sh
# The host half of the "Server version" box on /admin. Run it every minute from cron, as the user
# that owns this checkout and can run docker, e.g.:
#   * * * * * /srv/puppypad/scripts/upgrade-watch.sh >> /var/log/puppypad-upgrade.log 2>&1
# Each run it tells the app it is alive, looks for new commits on the deploy branch every
# UPGRADE_CHECK_MINUTES (60 by default), and acts on a request the admin page left in
# data/upgrade/request: "check" fetches now, "upgrade <sha>" runs scripts/upgrade.sh <sha>.
#
# data/upgrade is writable by the app container, which serves untrusted member files, so nothing
# read from it is trusted: the request must match a fixed pattern, upgrade.sh only accepts a commit
# that is already on origin/UPGRADE_BRANCH, the request is moved out into .upgrade/ before it is
# looked at, and every file published there is written in .upgrade/ and renamed in, so a planted
# symlink is replaced rather than followed.
set -eu
cd "$(dirname "$0")/.."

mkdir -p .upgrade
exec 9>.upgrade/lock
flock -n 9 || exit 0 # an upgrade is still running

env_val() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d "\"'\r"; }
[ -n "${UPGRADE_BRANCH:-}" ] || UPGRADE_BRANCH=$(env_val UPGRADE_BRANCH)
[ -n "${UPGRADE_CHECK_MINUTES:-}" ] || UPGRADE_CHECK_MINUTES=$(env_val UPGRADE_CHECK_MINUTES)
branch=${UPGRADE_BRANCH:-main}
every=${UPGRADE_CHECK_MINUTES:-60}
case "$every" in *[!0-9]*|'') every=60 ;; esac
export UPGRADE_BRANCH="$branch"

shared=data/upgrade
# the app creates this folder when it starts; until then there is nobody to talk to
if [ ! -d "$shared" ] || [ -L "$shared" ] || [ -L data ]; then exit 0; fi
if [ ! -w "$shared" ]; then
  echo "$(date -u) can't write to $shared; see \"Upgrades\" in the README for the permissions it needs"; exit 1
fi
# renames between .upgrade/ and data/upgrade/ are only atomic (and only replace links instead of
# following them) on one filesystem
if [ "$(stat -c %d .upgrade)" != "$(stat -c %d "$shared")" ]; then
  echo "$(date -u) .upgrade and $shared are on different filesystems; keep ./data inside the checkout"; exit 1
fi

# host-side memory lives in .upgrade/, out of the app's reach
get() { cat ".upgrade/$1" 2>/dev/null || true; }
put() { printf '%s\n' "$2" > ".upgrade/$1"; }

publish() { # publish <name> < content
  tmp=$(mktemp .upgrade/publish-XXXXXX)
  cat > "$tmp"
  chmod 644 "$tmp"
  mv -fT "$tmp" "$shared/$1"
}
publish_state() {
  current=$(git rev-parse HEAD)
  latest=$(git rev-parse --verify --quiet "origin/$branch" || echo "$current")
  publish state <<EOF
status=$(get status)
branch=$branch
current=$current
latest=$latest
checked_at=$(get checked_at)
finished_at=$(get finished_at)
seen_at=$(date +%s)
message=$(get message | tr -d '\n' | cut -c1-300)
EOF
  # only commits ahead of what runs now; empty when up to date or when HEAD isn't behind
  if git merge-base --is-ancestor "$current" "$latest" 2>/dev/null; then
    git log --format='%h %s' -n 50 "$current..$latest" | publish pending
  else
    : | publish pending
  fi
}
check() {
  if git fetch --quiet origin "$branch"; then put checked_at "$(date +%s)"; else echo "$(date -u) git fetch failed"; fi
}

[ -n "$(get status)" ] || put status idle
# a run that died without finishing (reboot, kill) leaves "running" behind
if [ "$(get status)" = running ]; then
  put status failed; put message "the last upgrade was interrupted; see .upgrade/last.log"; put finished_at "$(date +%s)"
fi

# claim the request by moving it out of the app's reach first: the app can't swap it for a link
# after the checks below, and a request written after this point waits for the next run
request=""
rm -rf .upgrade/request
if mv -T "$shared/request" .upgrade/request 2>/dev/null; then
  if [ -f .upgrade/request ] && [ ! -L .upgrade/request ]; then
    request=$(head -c 200 .upgrade/request | head -n 1 | tr -d '\r')
  fi
  rm -rf .upgrade/request
fi

case "$request" in
  check)
    check ;;
  "upgrade "*)
    sha=${request#upgrade }
    if printf '%s' "$sha" | grep -Eqx '[0-9a-f]{40}'; then
      put status running; put message ""; publish_state
      echo "$(date -u) upgrading to $sha"
      if scripts/upgrade.sh "$sha" > .upgrade/last.log 2>&1; then
        put status ok; put message "upgraded to $(echo "$sha" | cut -c1-7)"
      else
        put status failed; put message "$(tail -n 1 .upgrade/last.log)"
      fi
      put finished_at "$(date +%s)"
      tail -n 200 .upgrade/last.log | publish log
      cat .upgrade/last.log
    else
      echo "$(date -u) ignored a malformed request"
    fi ;;
  "") ;;
  *) echo "$(date -u) ignored a malformed request" ;;
esac

last=$(get checked_at)
case "$last" in *[!0-9]*|'') last=0 ;; esac
if [ $(( $(date +%s) - last )) -ge $(( every * 60 )) ]; then check; fi

publish_state
