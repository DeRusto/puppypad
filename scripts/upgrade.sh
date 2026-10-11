#!/bin/sh
# Upgrade this checkout in place: back up, fast-forward to a commit on the deploy branch, rebuild,
# and roll the code back if the app doesn't come up healthy. Run from the host as the user that owns
# the checkout and can run docker (not inside a container). scripts/upgrade-watch.sh calls it when
# an admin presses the button on /admin; you can also run it by hand:
#   scripts/upgrade.sh            # newest commit on the deploy branch
#   scripts/upgrade.sh <sha>      # a specific commit, which must already be on that branch
# The branch is UPGRADE_BRANCH (in .env or the environment), "main" by default. Only fast-forwards:
# a checkout with local edits or local commits is left alone.
set -eu
cd "$(dirname "$0")/.."

# one upgrade at a time, whether started by hand or by the watcher, so one run's rollback can't undo another
mkdir -p .upgrade
exec 8>.upgrade/upgrade.lock
flock -n 8 || { echo "another upgrade is already running"; exit 1; }

if [ -z "${UPGRADE_BRANCH:-}" ] && [ -f .env ]; then
  UPGRADE_BRANCH=$(sed -n 's/^UPGRADE_BRANCH=//p' .env | tail -n 1 | tr -d "\"'\r")
fi
branch=${UPGRADE_BRANCH:-main}
case "$branch" in *[!A-Za-z0-9._/-]*|-*|'') echo "bad UPGRADE_BRANCH: $branch"; exit 1 ;; esac

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "the checkout has local edits; commit or discard them, then upgrade"; exit 1
fi

git fetch --quiet origin "$branch"
remote=$(git rev-parse "origin/$branch")
target=${1:-$remote}
case "$target" in *[!0-9a-f]*|'') echo "not a commit id: $target"; exit 1 ;; esac
target=$(git rev-parse --verify --quiet "$target^{commit}") || { echo "unknown commit: $1"; exit 1; }
old=$(git rev-parse HEAD)

if [ "$old" = "$target" ]; then echo "already at $target"; exit 0; fi
# the target must be on the deploy branch, and reachable from what runs now (a fast-forward)
git merge-base --is-ancestor "$target" "$remote" || { echo "$target is not on origin/$branch"; exit 1; }
git merge-base --is-ancestor "$old" "$target" || { echo "HEAD $old is not behind $target (local commits?)"; exit 1; }

echo "== backing up before the upgrade"
scripts/backup.sh

echo "== $old -> $target"
git log --format='%h %s' "$old..$target"
git merge --ff-only --quiet "$target"

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

echo "== rebuilding"
if docker compose up -d --build --remove-orphans && healthy; then
  echo "== upgraded to $target"
  exit 0
fi

echo "== the new version did not come up healthy; putting $old back"
git reset --hard --quiet "$old"
docker compose up -d --build --remove-orphans || true
# the database stays as the new version left it: schema changes are new tables and columns, which the
# old code ignores. If a release ever needs more, the backup from before the upgrade is the newest archive in ./backups.
if healthy; then echo "the new version failed its health check; rolled back to $(echo "$old" | cut -c1-7)"
else echo "rolled back to $(echo "$old" | cut -c1-7), but it is not healthy either; check docker compose logs app"; fi
exit 1
