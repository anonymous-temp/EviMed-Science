#!/usr/bin/env bash
# Restore an archive produced by scripts/ops/backup-data.sh.
set -euo pipefail

NUMERIC_OWNER=false
if [ "${1:-}" = "--numeric-owner" ]; then
  NUMERIC_OWNER=true
  shift
fi

ARCHIVE="${1:-}"
DATA_DIR="${2:-${OPEN_SCIENCE_DATA_DIR:-.openscience-web-data}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$ARCHIVE" ]; then
  echo "Usage: $0 [--numeric-owner] BACKUP_ARCHIVE [DATA_DIR]" >&2
  exit 2
fi

if [ "$NUMERIC_OWNER" = true ]; then
  if [ "$#" -ne 2 ]; then
    echo "Usage: $0 --numeric-owner BACKUP_ARCHIVE DATA_DIR" >&2
    exit 2
  fi
  exec python3 "$SCRIPT_DIR/recovery-volume.py" restore --archive "$ARCHIVE" --target "$DATA_DIR"
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

# Inspect decoded members before tar can create links, traverse paths or
# overwrite a duplicate entry. The extraction remains the existing tar path.
python3 "$SCRIPT_DIR/backup_integrity.py" check-archive "$archive_for_restore"

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
# hardened backup container has no CAP_CHOWN, so legacy restores remain owned
# by the current user.
tar --no-same-owner -xzf "$archive_for_restore" -C "$tmp"

if find "$tmp" \( -type l -o \! -type d \! -type f \) -print -quit | grep -q .; then
  echo "Refusing to restore archive that extracted unsupported entries." >&2
  exit 1
fi

# Verify the complete staged tree before installing it; the private manifest
# is removed only after every path, type, size and content hash agrees.
python3 "$SCRIPT_DIR/backup_integrity.py" "$tmp"

if [ -e "$target" ]; then
  rm -rf "$target"
fi
mv "$tmp" "$target"
# `$tmp` has been moved, so cleanup must not remove it — but the decrypted
# archive still has to go. Disarming the whole trap took `decrypt_tmp_dir` with
# it, and only the SUCCESS path reaches this line: a failing restore exited with
# the trap still armed and cleaned up properly, while every successful one left
# 404MB behind.
#
# Five of those filled the backup container's 2GB /tmp between 2026-08-24 and
# 08-28. The run on 08-29 failed with ENOSPC and every run since has failed the
# same way — the restore drill, which exists to prove a backup can be restored,
# consumed the space the backups needed. Clearing the variable instead of the
# trap keeps the one thing that still needs removing.
tmp=""


echo "$target"
