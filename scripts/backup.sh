#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
task_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec -T db pg_dump -U skillbox -d skillbox -Fc > "backups/skillbox-$task_stamp.dump.part"
mv "backups/skillbox-$task_stamp.dump.part" "backups/skillbox-$task_stamp.dump"
docker compose exec -T db pg_restore --list < "backups/skillbox-$task_stamp.dump" > /dev/null
if [ -f .env ]; then
  cp .env "backups/skillbox-$task_stamp.env"
  chmod 600 "backups/skillbox-$task_stamp.env"
  echo "Protected configuration copy: backups/skillbox-$task_stamp.env (contains secrets; keep private)"
else
  echo 'No .env copied. Preserve external configuration and mounted secret files separately.' >&2
fi
keep="${SKILLBOX_BACKUP_KEEP:-14}"
for ext in dump env; do ls -1t backups/skillbox-*."$ext" 2>/dev/null | tail -n +$((keep + 1)) | xargs rm -f; done
echo "Verified PostgreSQL backup archive: backups/skillbox-$task_stamp.dump (keeping newest $keep)"
echo 'Validate recovery by restoring into a separate instance. Never publish backups or their matching configuration.'
