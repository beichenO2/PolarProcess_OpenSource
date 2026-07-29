#!/usr/bin/env bash
# Recover SOTAgent/PolarProcess shared resources.sqlite from a known-good backup.
# Prefer: bash scripts/recover-shared-db.sh [path-to-good.sqlite]
set -euo pipefail

DATA="${HOME}/Polarisor/SOTAgent/data"
LIVE="${DATA}/resources.sqlite"
BACKUP="${1:-}"
STAMP=$(date +%Y%m%d-%H%M%S)
PP_URL="${POLARPROCESS_URL:-http://127.0.0.1:11055}"
LABEL="gui/$(id -u)/com.polarisor.polarprocess"
PP_ROOT="${HOME}/Polarisor/PolarProcess"

die() { echo "FAIL: $*" >&2; exit 1; }

pick_backup() {
  local candidates=(
    "$BACKUP"
    "${DATA}/backups/resources-2026-07-29T13-10-51.sqlite"
    "${DATA}/backups/resources-2026-07-29T13-01-30.sqlite"
  )
  local f ok svc
  for f in "${candidates[@]}"; do
    [[ -n "$f" && -f "$f" ]] || continue
    ok=$(sqlite3 "$f" 'PRAGMA integrity_check;' 2>&1 | head -1)
    [[ "$ok" == "ok" ]] || continue
    svc=$(sqlite3 "$f" 'SELECT COUNT(*) FROM shared_services;' 2>&1 | head -1)
    [[ "$svc" =~ ^[0-9]+$ && "$svc" -gt 0 ]] || continue
    echo "$f"
    return 0
  done
  return 1
}

BACKUP="$(pick_backup)" || die "no intact backup with shared_services found"
svc=$(sqlite3 "$BACKUP" 'SELECT COUNT(*) FROM shared_services;')
echo "== recover-shared-db =="
echo "backup=$BACKUP services=$svc"

echo "-- stop PolarProcess"
launchctl bootout "$LABEL" 2>/dev/null || true
bash "$PP_ROOT/Start/start.sh" stop 2>/dev/null || true
rm -f "$PP_ROOT/Start/.pid"
sleep 2

echo "-- quarantine live + restore"
mkdir -p "${DATA}/recovery-${STAMP}"
if [[ -f "$LIVE" ]]; then
  mv "$LIVE" "${DATA}/recovery-${STAMP}/resources.sqlite.quarantine"
fi
rm -f "${LIVE}-shm" "${LIVE}-wal"
cp -p "$BACKUP" "$LIVE"
cp -p "$BACKUP" "${DATA}/recovery-${STAMP}/resources.sqlite.restored-from"
rm -f "${LIVE}-shm" "${LIVE}-wal"

integrity=$(sqlite3 "$LIVE" 'PRAGMA integrity_check;' | head -1)
[[ "$integrity" == "ok" ]] || die "restored integrity failed: $integrity"

before=$(sqlite3 "$LIVE" 'SELECT COUNT(*) FROM service_events;')
sqlite3 "$LIVE" "DELETE FROM service_events WHERE timestamp < datetime('now', '-7 days');"
sqlite3 "$LIVE" 'PRAGMA wal_checkpoint(TRUNCATE);'
sqlite3 "$LIVE" 'VACUUM;'
after=$(sqlite3 "$LIVE" 'SELECT COUNT(*) FROM service_events;')
echo "events pruned: $before -> $after size=$(stat -f%z "$LIVE")"
sqlite3 "$LIVE" 'PRAGMA integrity_check;' | head -1 | grep -qx ok || die "post-vacuum integrity failed"

# Keep a known-good slot for next time
cp -p "$LIVE" "${DATA}/backups/resources-latest-good.sqlite"

echo "-- bootstrap PolarProcess"
launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/com.polarisor.polarprocess.plist" 2>&1 || true
launchctl kickstart -k "$LABEL" 2>&1 || true

for i in $(seq 1 60); do
  if curl -fsS --max-time 1 "$PP_URL/api/health" >/dev/null 2>&1; then
    echo "PASS: PolarProcess healthy"
    curl -fsS "$PP_URL/api/runtime/proxy" | python3 -m json.tool | head -20
    exit 0
  fi
  sleep 1
done

tail -40 "$PP_ROOT/Start/polarprocess.log" >&2 || true
die "PolarProcess did not become healthy"
