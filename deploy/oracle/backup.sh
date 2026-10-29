#!/bin/bash
# FORK: daily backup of the app database and the uploaded media. setup.sh
# runs it from cron. Keeps the last 14 days in /var/backups/alpine-socials.
# Restore: see deploy/oracle/README.md.

set -o errexit
set -o nounset
set -o pipefail

BACKUP_DIR="/var/backups/alpine-socials"
KEEP_DAYS=14
STAMP="$(date +%Y%m%d-%H%M)"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

docker exec postiz-postgres pg_dump -U postiz -d postiz -Fc \
  >"${BACKUP_DIR}/postiz-${STAMP}.dump"

docker run --rm -v alpine-socials_postiz-uploads:/uploads:ro -v "${BACKUP_DIR}":/backup \
  alpine tar czf "/backup/uploads-${STAMP}.tar.gz" -C /uploads .

find "${BACKUP_DIR}" -type f -mtime +"${KEEP_DAYS}" -delete

echo "$(date -Is) backup ${STAMP} done"
