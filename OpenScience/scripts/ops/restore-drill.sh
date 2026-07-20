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
DRILL_PARENT="$(cd "$DRILL_PARENT" && pwd)"

cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

tmp="$(mktemp -d "$DRILL_PARENT/open-science-restore-drill.XXXXXX")"
target="$tmp/data"

"$SCRIPT_DIR/restore-data.sh" "$ARCHIVE" "$target" >/dev/null

if [ ! -d "$target" ]; then
  echo "Restore drill did not create a data directory." >&2
  exit 1
fi

if find "$target" -type l -print -quit | grep -q .; then
  echo "Restore drill produced symbolic links." >&2
  exit 1
fi

echo "restore drill ok: $ARCHIVE"
