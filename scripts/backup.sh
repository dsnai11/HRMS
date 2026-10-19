#!/bin/sh
# Logical backup of the HRMS database to a compressed file.
#   DATABASE_URL=postgres://... scripts/backup.sh [output-dir]
# Needs pg_dump (PostgreSQL client tools). Keep backups somewhere safe and encrypted:
# they contain personal data. Bank, PAN and UAN values are encrypted in the database,
# so a backup is only useful together with DATA_ENCRYPTION_KEY, which must be backed up
# separately.
set -eu
: "${DATABASE_URL:?Set DATABASE_URL}"
dir="${1:-.}"
file="$dir/hrms-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$file"
echo "Wrote $file"
