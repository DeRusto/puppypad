#!/bin/sh
# The host half of the "Server version" box on /admin. Run it every minute from cron, as a user that
# can run docker, from the install folder (scripts/install.sh adds this line):
#   * * * * * /srv/puppypad/scripts/upgrade-watch.sh >> /srv/puppypad/.upgrade/watch.log 2>&1
# Each run it tells the app it is alive, asks GitHub for the newest release every
# UPGRADE_CHECK_MINUTES (60 by default), and acts on a request the admin page left in
# data/upgrade/request: "check" asks now, "upgrade <tag>" runs scripts/install.sh <tag>.
#
# data/upgrade is writable by the app container, which serves untrusted member files, so nothing
# read from it is trusted: the request must match a fixed pattern and name the newest release, the
# request is moved out into .upgrade/ before it is looked at, and every file published there is
# written in .upgrade/ and renamed in, so a planted symlink is replaced rather than followed.
set -eu
cd "$(dirname "$0")/.."

mkdir -p .upgrade
# the same lock scripts/install.sh takes, so a manual install and the watcher exclude each other. It stays
# held for the whole run and is handed down, open, to the installer started below (PUPPYPAD_UPGRADE_LOCKED),
# so it is held for as long as either is alive
exec 9>.upgrade/upgrade.lock
flock -n 9 || exit 0 # an upgrade is still running

env_val() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d "\"'\r"; }
[ -n "${UPGRADE_REPO:-}" ] || UPGRADE_REPO=$(env_val UPGRADE_REPO)
[ -n "${UPGRADE_CHECK_MINUTES:-}" ] || UPGRADE_CHECK_MINUTES=$(env_val UPGRADE_CHECK_MINUTES)
repo=${UPGRADE_REPO:-DeRusto/puppypad}
api=${UPGRADE_API_URL:-https://api.github.com}
every=${UPGRADE_CHECK_MINUTES:-60}
case "$every" in *[!0-9]*|'') every=60 ;; esac
is_tag() { echo "$1" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+'; }

shared=data/upgrade
# the app creates this folder when it starts; until then there is nobody to talk to
if [ ! -d "$shared" ] || [ -L "$shared" ] || [ -L data ]; then exit 0; fi
if [ ! -w "$shared" ]; then
  echo "$(date -u) can't write to $shared; see \"Upgrades\" in the README for the permissions it needs"; exit 1
fi
# renames between .upgrade/ and data/upgrade/ are only atomic (and only replace links instead of
# following them) on one filesystem
if [ "$(stat -c %d .upgrade)" != "$(stat -c %d "$shared")" ]; then
  echo "$(date -u) .upgrade and $shared are on different filesystems; keep ./data inside the install folder"; exit 1
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
  publish state <<EOF
status=$(get status)
repo=$repo
current=$(env_val PUPPYPAD_VERSION)
latest=$(get latest)
published_at=$(get published_at)
url=$(get url)
checked_at=$(get checked_at)
finished_at=$(get finished_at)
seen_at=$(date +%s)
message=$(get message | tr -d '\n' | cut -c1-300)
EOF
  get notes | publish notes
}
# the newest release (GitHub leaves drafts and pre-releases out of /releases/latest)
check() {
  json=.upgrade/latest.json
  if ! curl -fsSL --max-time 30 -o "$json" "$api/repos/$repo/releases/latest"; then
    echo "$(date -u) could not reach GitHub for the newest release"; return 0
  fi
  tag=$(jq -r '.tag_name // ""' "$json")
  if ! is_tag "$tag"; then echo "$(date -u) the newest release has an unexpected tag: $tag"; return 0; fi
  put latest "$tag"
  put url "$(jq -r '.html_url // ""' "$json" | tr -d '\n')"
  put published_at "$(jq -r '.published_at // "" | if . == "" then "" else fromdateiso8601 end' "$json")"
  jq -r '.body // ""' "$json" | tr -d '\r' | head -c 8000 > .upgrade/notes
  put checked_at "$(date +%s)"
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
    tag=${request#upgrade }
    # only the release the page showed as newest; anything else (an older one) is a job for the shell
    if is_tag "$tag" && [ "$tag" = "$(get latest)" ]; then
      put status running; put message ""; publish_state
      echo "$(date -u) upgrading to $tag"
      if PUPPYPAD_UPGRADE_LOCKED=1 scripts/install.sh "$tag" > .upgrade/last.log 2>&1; then
        put status ok; put message "upgraded to $tag"
      else
        put status failed; put message "$(tail -n 1 .upgrade/last.log)"
      fi
      put finished_at "$(date +%s)"
      tail -n 200 .upgrade/last.log | publish log
      cat .upgrade/last.log
    else
      echo "$(date -u) ignored a request for something other than the newest release"
    fi ;;
  "") ;;
  *) echo "$(date -u) ignored a malformed request" ;;
esac

last=$(get checked_at)
case "$last" in *[!0-9]*|'') last=0 ;; esac
if [ $(( $(date +%s) - last )) -ge $(( every * 60 )) ]; then check; fi

publish_state
