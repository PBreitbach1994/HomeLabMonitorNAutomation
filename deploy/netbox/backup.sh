#!/usr/bin/env bash
# Backs up NetBox: the database, uploaded media, and the env/secrets needed to restore them.
#   ./backup.sh                 writes to deploy/netbox/backups/, keeps the newest 14 of each
#   KEEP=30 ./backup.sh
#   BACKUP_DIR=/mnt/nas/netbox ./backup.sh   (put a copy somewhere other than this machine)
# Schedule it, e.g. in crontab:  15 3 * * *  /path/to/deploy/netbox/backup.sh >/dev/null
set -euo pipefail
cd "$(dirname "$0")"

KEEP="${KEEP:-14}"
DIR="${BACKUP_DIR:-backups}"
umask 077
mkdir -p "$DIR"
ts=$(date +%Y%m%d-%H%M%S)

docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' |
  gzip >"$DIR/netbox-db-$ts.sql.gz"
docker compose exec -T netbox tar -C /opt/netbox/netbox/media -czf - . >"$DIR/netbox-media-$ts.tar.gz"
# The token pepper in env/netbox.env is needed for API tokens to keep working after a restore.
tar -czf "$DIR/netbox-config-$ts.tar.gz" env/*.env secrets .env 2>/dev/null ||
  tar -czf "$DIR/netbox-config-$ts.tar.gz" env/*.env secrets

gzip -t "$DIR/netbox-db-$ts.sql.gz"
echo "backed up to $DIR/netbox-{db,media,config}-$ts.*"

for kind in db media config; do
  # Oldest first beyond the newest $KEEP; names sort by timestamp.
  find "$DIR" -maxdepth 1 -name "netbox-$kind-*" -type f | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f -- "$old"
  done
done
