#!/usr/bin/env bash
# Restores a NetBox database (and media) backup made by backup.sh, replacing what's there now.
#   ./restore.sh backups/netbox-db-20261117-031500.sql.gz [--yes]
# The matching media archive (same timestamp) is restored too if present. Restore env/ and
# secrets/ from the config archive first when moving to a new machine:
#   tar -xzf backups/netbox-config-<timestamp>.tar.gz
set -euo pipefail
cd "$(dirname "$0")"

dump="${1:-}"
[ -n "$dump" ] && [ -f "$dump" ] || { echo "usage: $0 <netbox-db-*.sql.gz> [--yes]" >&2; exit 1; }
gzip -t "$dump"
if [ "${2:-}" != --yes ]; then
  read -r -p "Replace the current NetBox data with $dump? Type 'restore' to continue: " answer
  [ "$answer" = restore ] || { echo "cancelled"; exit 1; }
fi

docker compose up -d postgres redis redis-cache
docker compose stop netbox netbox-worker
gunzip -c "$dump" | docker compose exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
echo "database restored from $dump"

media="${dump/netbox-db-/netbox-media-}"
media="${media%.sql.gz}.tar.gz"
docker compose up -d netbox
if [ -f "$media" ]; then
  docker compose exec -T netbox sh -c 'find /opt/netbox/netbox/media -mindepth 1 -delete && tar -C /opt/netbox/netbox/media -xzf -' <"$media"
  echo "media restored from $media"
fi
docker compose up -d
echo "NetBox is starting with the restored data; ./setup.sh --no-pull re-checks it once it's healthy."
