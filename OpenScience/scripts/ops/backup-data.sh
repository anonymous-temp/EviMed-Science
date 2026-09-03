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
# --exclude removes the reasons tar had to complain about things that are not
# data. What is left is tar's own distinction, and it is the one that matters:
# exit 2 is fatal — it could not read, could not write, ran out of space — and
# exit 1 means the archive was written and something moved underneath it.
#
# "file changed as we read it" is exit 1, and on a live multi-tenant data
# directory it happens whenever anyone is working: the first cycle after this
# stack came up failed on `./users`. Failing the whole backup for that is a
# backup system that stops working exactly when the system is in use, and the
# archive it threw away was complete apart from one file's inconsistency —
# which is what a point-in-time copy of a running system always is.
#
# So exit 1 is accepted only when every line tar printed is that warning, the
# count is reported on stdout for the scheduler to record, and anything else —
# including a single unrecognised line at exit 1 — still fails.
set +e
tar_stderr="$(mktemp)"
tar --exclude=".runtime-sockets" --exclude="*.sock" --exclude="./users/*/projects/*/${RUNTIME_SCRATCH}" \
  -czf "$tmp" -C "$DATA_DIR" . 2> "$tar_stderr"
tar_status=$?
set -e
if [ "$tar_status" -ne 0 ]; then
  unexpected="$(grep -v 'file changed as we read it' < "$tar_stderr" | grep -v '^tar: Exiting with failure status due to previous errors$' || true)"
  changed="$(grep -c 'file changed as we read it' < "$tar_stderr" || true)"
  if [ "$tar_status" -ne 1 ] || [ -n "$unexpected" ]; then
    echo "Backup archive failed (tar exit ${tar_status}):" >&2
    sed -n '1,20p' "$tar_stderr" >&2
    rm -f "$tar_stderr"
    exit 1
  fi
  echo "backup note: ${changed} file(s) changed while being read; the archive is a point-in-time copy of a running system" >&2
fi
rm -f "$tar_stderr"
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
