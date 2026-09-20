#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${PROJECT_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
BACKUP_ROOT="/var/backups/rakazo"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"
install -d -m 700 "${BACKUP_ROOT}"

# The shared command quiesces writers and includes the environment needed to
# decrypt restored credentials. It resumes only containers that were running.
python3 "${PROJECT_DIR}/scripts/deployment-backup.py" backup \
  --project "${COMPOSE_PROJECT_NAME:-rakazo}" \
  --compose "${PROJECT_DIR}/infra/compose/docker-compose.prod.yml" \
  --env-file "${PROJECT_DIR}/.env" --output "${SNAPSHOT_DIR}"

# Rotate only timestamp directories after a successful snapshot. Failed backups
# never remove the last recoverable copy. Keep an encrypted copy off-host too.
find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d \
  -name '????????T??????Z' -mtime +6 -exec rm -rf -- {} +
echo "Verified Deskazo backup written to ${SNAPSHOT_DIR}"
