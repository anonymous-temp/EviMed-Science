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

# What is NOT data, and therefore neither archived nor scanned.
#
# `container-runtime` is the runtime container's scratch: its XDG directories,
# its DSH home, the pnpm store for the profile, its temp dir. Every one of them
# is rebuilt on the next start, and none of it restores anything. It has to be
# named here because the DSH kernel installs its profile with pnpm, which lays
# out `node_modules/.pnpm` as thousands of relative symlinks — 3,752 for one
# session — inside the project, inside the data directory.
#
# Without this the first project to start a runtime stopped every backup from
# then on, permanently, on the check below. That check is not the problem and is
# not relaxed: a symlink in the archive is how a restore is talked into writing
# outside the tree it restores into. Both the scan and the archive skip the same
# paths, so everything that IS archived is still proven symlink-free.
RUNTIME_SCRATCH="runtime/container-runtime"

if [ -L "$DATA_DIR" ] || find "$DATA_DIR" -type d -name container-runtime -prune -o -type l -print -quit | grep -q .; then
  echo "Refusing to back up data directory containing symbolic links: $DATA_DIR" >&2
  echo "  (the runtime scratch at */${RUNTIME_SCRATCH} is excluded from this scan and from the archive)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
umask 077

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/open-science-data-$timestamp.tar.gz"
tmp="$archive.tmp.$$"

if [ -e "$archive" ] || [ -e "$archive.enc" ] || [ -e "$archive.sha256" ] || [ -e "$archive.enc.sha256" ]; then
  echo "Refusing to overwrite an existing backup for timestamp: $timestamp" >&2
  exit 1
fi

cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

# A running runtime leaves unix sockets in the data directory, and tar warns on
# every one and exits non-zero. The archive is complete and verifies — the
# restore drill passes on it — but the scheduler read that exit code as a failed
# backup, on every single cycle, because a runtime always leaves sockets. They
# are live endpoints, not data, and nothing restores from them.
#
# --exclude removes the only reason tar had to complain, so a non-zero exit
# again means a real failure. Warnings that remain (a file changing as it is
# read) still fail the backup, which is the intended behaviour.
tar --exclude=".runtime-sockets" --exclude="*.sock" --exclude="./users/*/projects/*/${RUNTIME_SCRATCH}" \
  -czf "$tmp" -C "$DATA_DIR" .
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
