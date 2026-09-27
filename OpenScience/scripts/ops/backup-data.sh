#!/usr/bin/env bash
# Create a point-in-time archive of OPEN_SCIENCE_DATA_DIR.
set -euo pipefail

DATA_DIR="${1:-${OPEN_SCIENCE_DATA_DIR:-.openscience-web-data}}"
BACKUP_DIR="${2:-${OPEN_SCIENCE_BACKUP_DIR:-backups}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$DATA_DIR" ]; then
  echo "Data directory does not exist: $DATA_DIR" >&2
  exit 1
fi

case "${OPEN_SCIENCE_BACKUP_STRICT:-false}" in
  true) strict_backup=true ;;
  false|"") strict_backup=false ;;
  *)
    echo "OPEN_SCIENCE_BACKUP_STRICT must be true or false." >&2
    exit 2
    ;;
esac

mkdir -p "$BACKUP_DIR"
umask 077

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/open-science-data-$timestamp.tar.gz"
tmp="$archive.tmp.$$"
manifest="$(mktemp)"

cleanup() {
  rm -f "$tmp" "$manifest"
}
trap cleanup EXIT

# Native journals are customer data even though the kernel stores them under
# container-runtime. Everything else there (credentials, profile installation,
# caches and control endpoints) is regenerated and must stay out of backups.
# An explicit manifest names only included entries and their inode identities.
# The archive writer reopens them through scoped, no-follow file descriptors;
# it never asks tar to resolve these paths again after the inventory. One
# inventory for both modes (`backup-archive.mjs`): strict also opens and
# hashes every file. It records, rather than refuses, what a run can make in
# its own workspace that an archive cannot carry or must not follow.
if ! node "$SCRIPT_DIR/backup-archive.mjs" inventory "$DATA_DIR" "$manifest" "$strict_backup"; then
  echo "Backup file inventory failed." >&2
  exit 1
fi

if [ -e "$archive" ] || [ -e "$archive.enc" ] || [ -e "$archive.sha256" ] || [ -e "$archive.enc.sha256" ]; then
  echo "Refusing to overwrite an existing backup for timestamp: $timestamp" >&2
  exit 1
fi

# Only same-inode content updates may produce a file-changed warning. A replaced
# ancestor, symlink, unexpected inode, short read, or I/O error is always fatal.
# The writer streams pinned descriptors into gzip; there is no full-data staging
# copy and no second path-based tar read that could follow a replacement link.
set +e
archive_stderr="$(mktemp)"
node "$SCRIPT_DIR/backup-archive.mjs" "$DATA_DIR" "$manifest" "$tmp" "$strict_backup" 2> "$archive_stderr"
archive_status=$?
set -e
if [ "$archive_status" -ne 0 ]; then
  unexpected="$(grep -v -e '^backup archive: file changed as we read it$' -e '^backup note: ' < "$archive_stderr" || true)"
  changed="$(grep -c '^backup archive: file changed as we read it$' < "$archive_stderr" || true)"
  if [ "$archive_status" -ne 1 ] || [ -n "$unexpected" ]; then
    if [ "$strict_backup" = true ]; then
      echo "strict backup refused a changing source or invalid member; no archive was published" >&2
    fi
    echo "Backup archive failed (writer exit ${archive_status}):" >&2
    sed -n '1,20p' "$archive_stderr" >&2
    rm -f "$archive_stderr"
    exit 1
  fi
  if [ "$strict_backup" = true ]; then
    echo "strict backup refused a changing source; no archive was published" >&2
    rm -f "$archive_stderr"
    exit 1
  fi
  echo "backup note: ${changed} file(s) changed while being read; the archive is a point-in-time copy of a running system" >&2
fi
# The writer's notes (the workspace links it recorded) are the backup's report,
# so they reach the caller; the scheduler reads them into its state.
grep '^backup note: ' < "$archive_stderr" >&2 || true
rm -f "$archive_stderr"
mv "$tmp" "$archive"

if [ -n "${OPEN_SCIENCE_BACKUP_PASSPHRASE:-}" ] || [ -n "${OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE:-}" ]; then
  encrypted="$archive.enc"
  node "$SCRIPT_DIR/archive-crypto.mjs" encrypt "$archive" "$encrypted"
  rm -f "$archive"
  archive="$encrypted"
fi

(
  cd "$(dirname "$archive")"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
  else
    echo "A SHA-256 checksum utility is required." >&2
    exit 1
  fi
)

if [ -n "${OPEN_SCIENCE_BACKUP_RETENTION_DAYS:-}" ]; then
  node "$SCRIPT_DIR/backup-retention.mjs" prune "$BACKUP_DIR" "$OPEN_SCIENCE_BACKUP_RETENTION_DAYS" >&2
fi

if [ -n "${OPEN_SCIENCE_OBJECT_BACKUP_URI:-}" ]; then
  node "$SCRIPT_DIR/object-backup.mjs" upload "$archive" "$OPEN_SCIENCE_OBJECT_BACKUP_URI" >&2
fi

echo "$archive"
