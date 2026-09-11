#!/usr/bin/env bash
# Verify a backup by restoring it into a disposable temporary directory.
set -euo pipefail

ARCHIVE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL_PARENT="${OPEN_SCIENCE_RESTORE_DRILL_DIR:-${TMPDIR:-/tmp}}"
tmp=""

if [ -z "$ARCHIVE" ]; then
  echo "Usage: $0 BACKUP_ARCHIVE" >&2
  exit 2
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "Backup archive does not exist: $ARCHIVE" >&2
  exit 1
fi

if [ -L "$DRILL_PARENT" ]; then
  echo "Restore drill directory must not be a symbolic link: $DRILL_PARENT" >&2
  exit 1
fi

mkdir -p "$DRILL_PARENT"
DRILL_PARENT="$(cd "$DRILL_PARENT" && pwd -P)"

cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

tmp="$(mktemp -d "$DRILL_PARENT/open-science-restore-drill.XXXXXX")"
target="$tmp/data"

receipt="$tmp/verification.json"
OPEN_SCIENCE_RESTORE_VERIFICATION_FILE="$receipt" "$SCRIPT_DIR/restore-data.sh" "$ARCHIVE" "$target" >/dev/null

if [ ! -d "$target" ]; then
  echo "Restore drill did not create a data directory." >&2
  exit 1
fi

if find "$target" -type l -print -quit | grep -q .; then
  echo "Restore drill produced symbolic links." >&2
  exit 1
fi

# An initialized deployment has a users/ directory even before its first user.
if [ ! -d "$target/users" ]; then
  echo "Restore drill produced no users/ tree: the archive unpacked to something that is not a data directory." >&2
  exit 1
fi

# Complete verification compares every restored path and byte with the embedded
# inventory, not with a deployment-specific file-count guess. A legacy restore
# is still available, but its shape cannot certify completeness for the scheduler.
node - "$receipt" "$ARCHIVE" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.verification !== 'inventory-v1') {
  const shape = report.files === 0 ? 'empty' : `${report.files} files`;
  console.error(`restore drill limited: legacy-shape-only (${shape}); content completeness unverified`);
  process.exitCode = 1;
} else {
  console.log(`restore drill ok: ${process.argv[3]} (users/ present, ${report.files} files, inventory-v1)`);
}
NODE
