#!/bin/sh
# Nightly backup of ./data into ./backups/latest: a consistent copy of the SQLite database plus every member's
# files, screenshots and file history. Run from the host, next to docker-compose.yml. scripts/install.sh adds
# this crontab line (03:15 every night):
#   15 3 * * * /srv/puppypad/scripts/backup.sh >> /srv/puppypad/backups/backup.log 2>&1
# There is one copy, brought up to date by rsync, so each night only writes what changed. Older versions of
# members' text files live in data/history, which the copy includes.
# To copy it off this server, install rclone, configure a remote (Backblaze B2, Cloudflare R2, S3, ...) and set
# BACKUP_REMOTE (in .env or the environment), e.g. "b2:my-bucket/puppypad". The remote mirrors latest/ and
# keeps whatever each night changed or deleted in old/<date> for 14 days.
# One backup at a time (cron, the installer's pre-upgrade backup, by hand): a run holds .upgrade/backup.lock
# from the database copy to the end of the remote sync. A run that finds it held waits up to BACKUP_LOCK_WAIT
# seconds (default 3600, longer than a backup with its sync), then fails rather than skip, so the installer stops.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .upgrade
exec 7>.upgrade/backup.lock
flock -w "${BACKUP_LOCK_WAIT:-3600}" 7 || { echo "another backup is still running after ${BACKUP_LOCK_WAIT:-3600}s; no backup was taken" >&2; exit 1; }
# cron doesn't load .env, so read BACKUP_REMOTE from it unless it was set by the caller
if [ -z "${BACKUP_REMOTE:-}" ] && [ -f .env ]; then
  BACKUP_REMOTE=$(sed -n 's/^BACKUP_REMOTE=//p' .env | tail -n 1 | tr -d "\"'\r")
fi
stamp=$(date -u +%Y%m%d-%H%M)
mkdir -p backups/latest

# Copying puppypad.db while the app writes to it can give a broken file. SQLite's online backup can't.
# A throwaway container from the app's image, not exec, so this also works while the app is down (an upgrade that fixes it backs up first)
docker compose run --rm -T --no-deps app node -e "require('better-sqlite3')('/data/puppypad.db').backup('/data/backup.db').then(() => console.log('database copied'))"

# rsync exits 24 when a file vanished while it ran (a member deleting one): the copy is still whole. Other errors are real.
src="data/backup.db data/sites data/shots"
[ -d data/history ] && src="$src data/history" # made by the app once it runs a release with file history
# shellcheck disable=SC2086 # the paths have no spaces
rsync -a --delete $src backups/latest/ || [ $? -eq 24 ]
# data/ belongs to the app's user (uid 1000), so remove the copy from inside a container
docker compose run --rm -T --no-deps app rm -f /data/backup.db
echo "updated backups/latest"
rm -f backups/puppypad-*.tar.gz # the full archives made before latest/ took over

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone sync backups/latest "$BACKUP_REMOTE/latest" --backup-dir "$BACKUP_REMOTE/old/$stamp"
  # moved files keep their own dates, so old/ rolls over by the night in each folder's name, not by --min-age
  cutoff=$(date -u -d '14 days ago' +%Y%m%d-%H%M)
  rclone lsf --dirs-only "$BACKUP_REMOTE/old" 2>/dev/null | tr -d / | awk -v c="$cutoff" '$0 < c' | while read -r d; do rclone purge "$BACKUP_REMOTE/old/$d"; done
  rclone delete "$BACKUP_REMOTE" --include '/puppypad-*.tar.gz' --min-age 14d # archives from before latest/
  echo "synced to $BACKUP_REMOTE"
fi
