#!/bin/sh
# Nightly backup of ./data: a consistent copy of the SQLite database plus every member's files.
# Run from the host, next to docker-compose.yml. Example crontab line (03:15 every night):
#   15 3 * * * /srv/puppypad/scripts/backup.sh >> /var/log/puppypad-backup.log 2>&1
# Keeps the last 14 archives in ./backups. To also copy them off this server, install rclone,
# configure a remote (Backblaze B2, Cloudflare R2, S3, ...) and set BACKUP_REMOTE, e.g. "b2:my-bucket/puppypad".
set -eu
cd "$(dirname "$0")/.."
stamp=$(date -u +%Y%m%d-%H%M)
mkdir -p backups

# Copying puppypad.db while the app writes to it can give a broken file. SQLite's online backup can't.
docker compose exec -T app node -e "require('better-sqlite3')('/data/puppypad.db').backup('/data/backup.db').then(() => console.log('database copied'))"

tar -czf "backups/puppypad-$stamp.tar.gz" -C data backup.db sites
rm -f data/backup.db
echo "wrote backups/puppypad-$stamp.tar.gz"

ls -1t backups/puppypad-*.tar.gz | tail -n +15 | xargs -r rm --

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone sync backups "$BACKUP_REMOTE"
  echo "synced to $BACKUP_REMOTE"
fi
