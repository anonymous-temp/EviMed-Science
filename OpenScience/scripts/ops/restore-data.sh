#!/usr/bin/env bash
# Restore an archive produced by scripts/ops/backup-data.sh.
set -euo pipefail

ARCHIVE="${1:-}"
DATA_DIR="${2:-${OPEN_SCIENCE_DATA_DIR:-.openscience-web-data}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$ARCHIVE" ]; then
  echo "Usage: $0 BACKUP_ARCHIVE [DATA_DIR]" >&2
  exit 2
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "Backup archive does not exist: $ARCHIVE" >&2
  exit 1
fi

archive_dir="$(cd "$(dirname "$ARCHIVE")" && pwd)"
archive_base="$(basename "$ARCHIVE")"
checksum="$ARCHIVE.sha256"
decrypted_archive=""
decrypt_tmp_dir=""
tmp=""

cleanup() {
  rm -rf "$tmp"
  rm -rf "$decrypt_tmp_dir"
}
trap cleanup EXIT

if [ -f "$checksum" ]; then
  (
    cd "$archive_dir"
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c "$archive_base.sha256" >&2
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c "$archive_base.sha256" >&2
    else
      echo "A SHA-256 checksum utility is required." >&2
      exit 1
    fi
  )
fi

archive_for_restore="$ARCHIVE"
if head -n 1 "$ARCHIVE" | grep -qx "OPEN_SCIENCE_BACKUP_ENCRYPTED_V1"; then
  decrypt_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/open-science-backup.XXXXXX")"
  decrypted_archive="$decrypt_tmp_dir/archive.tar.gz"
  node "$SCRIPT_DIR/archive-crypto.mjs" decrypt "$ARCHIVE" "$decrypted_archive"
  archive_for_restore="$decrypted_archive"
fi

if tar -tzf "$archive_for_restore" | awk '
  $0 == "" { next }
  $0 ~ /^\// || $0 ~ /^(\.\.)(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ {
    print "Unsafe archive path: " $0 > "/dev/stderr"
    bad=1
  }
  END { exit bad ? 1 : 0 }
'; then
  :
else
  exit 1
fi

if tar -tvzf "$archive_for_restore" | awk '
  substr($1, 1, 1) == "l" {
    print "Refusing to restore archive containing symbolic links: " $0 > "/dev/stderr"
    bad=1
  }
  END { exit bad ? 1 : 0 }
'; then
  :
else
  exit 1
fi

parent="$(dirname "$DATA_DIR")"
mkdir -p "$parent"
parent="$(cd "$parent" && pwd)"
target="$parent/$(basename "$DATA_DIR")"
tmp="$parent/.open-science-restore.$$"

if [ -e "$target" ] && [ "${OPEN_SCIENCE_RESTORE_REPLACE:-}" != "true" ]; then
  if [ -n "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ]; then
    echo "Target data directory is not empty. Set OPEN_SCIENCE_RESTORE_REPLACE=true to replace it: $target" >&2
    exit 1
  fi
fi

mkdir -m 700 "$tmp"
# Runtime-created files can legitimately carry different numeric owners. The
# hardened backup container has no CAP_CHOWN, so restore as the current user.
tar --no-same-owner -xzf "$archive_for_restore" -C "$tmp"

if find "$tmp" -type l -print -quit | grep -q .; then
  echo "Refusing to restore archive that extracted symbolic links." >&2
  exit 1
fi

if [ -e "$target" ]; then
  rm -rf "$target"
fi
mv "$tmp" "$target"
trap - EXIT

echo "$target"
