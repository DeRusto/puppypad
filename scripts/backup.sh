#!/bin/sh
# Nightly backup of ./data: a consistent copy of the SQLite database plus every member's files.
# Run from the host, next to docker-compose.yml. scripts/install.sh adds this crontab line (03:15 every night):
#   15 3 * * * /srv/puppypad/scripts/backup.sh >> /srv/puppypad/backups/backup.log 2>&1
# Keeps the last 14 archives in ./backups, or 3 when BACKUP_REMOTE is set (the remote keeps 14 days), since each
# one is a full copy of every member's files on the same disk. To copy them off this server, install rclone,
# configure a remote (Backblaze B2, Cloudflare R2, S3, ...) and set BACKUP_REMOTE (in .env or the environment),
# e.g. "b2:my-bucket/puppypad".
set -eu
cd "$(dirname "$0")/.."
# cron doesn't load .env, so read BACKUP_REMOTE from it unless it was set by the caller
if [ -z "${BACKUP_REMOTE:-}" ] && [ -f .env ]; then
  BACKUP_REMOTE=$(sed -n 's/^BACKUP_REMOTE=//p' .env | tail -n 1 | tr -d "\"'\r")
fi
stamp=$(date -u +%Y%m%d-%H%M)
mkdir -p backups

# Copying puppypad.db while the app writes to it can give a broken file. SQLite's online backup can't.
# A throwaway container from the app's image, not exec, so this also works while the app is down (an upgrade that fixes it backs up first)
docker compose run --rm -T --no-deps app node -e "require('better-sqlite3')('/data/puppypad.db').backup('/data/backup.db').then(() => console.log('database copied'))"

# tar exits 1 when a file changed while it was read (a member saving, a new screenshot): the archive is still
# whole, with that one file as it was at some point. 2 and up are real failures.
tar -czf "backups/puppypad-$stamp.tar.gz" -C data backup.db sites shots || [ $? -eq 1 ]
# data/ belongs to the app's user (uid 1000), so remove the copy from inside a container
docker compose run --rm -T --no-deps app rm -f /data/backup.db
echo "wrote backups/puppypad-$stamp.tar.gz"

keep=${BACKUP_REMOTE:+3}
ls -1t backups/puppypad-*.tar.gz | tail -n +$((${keep:-14} + 1)) | xargs -r rm --

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy backups "$BACKUP_REMOTE" # copy, not sync: a wiped local folder must not delete the remote copies
  rclone delete "$BACKUP_REMOTE" --include 'puppypad-*.tar.gz' --min-age 14d # copy never prunes, so roll the remote over by hand
  echo "copied to $BACKUP_REMOTE"
fi
