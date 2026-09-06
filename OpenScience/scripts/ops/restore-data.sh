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
  if ! python3 - <<'PY'
import os
import pathlib

if os.geteuid() != 0:
    raise SystemExit(1)
status = pathlib.Path("/proc/self/status")
if status.exists():
    effective = next((line.split()[1] for line in status.read_text().splitlines() if line.startswith("CapEff:")), "0")
    if int(effective, 16) & 1 == 0:  # CAP_CHOWN
        raise SystemExit(1)
PY
  then
    echo "numeric_owner_requires_root" >&2
    exit 1
  fi
  if [ "${DATA_DIR#/}" = "$DATA_DIR" ]; then
    echo "numeric_owner_target_must_be_absolute" >&2
    exit 1
  fi
  # Numeric ownership is a recovery-set-only operation. Its parent must already
  # exist, and every existing component must be a real directory rather than a
  # link. This validation runs before decryption or target mutation.
  if ! python3 - "$DATA_DIR" <<'PY'
import os
import stat
import sys

target = os.path.abspath(sys.argv[1])
parent = os.path.dirname(target)
current = os.path.sep
for part in parent.split(os.path.sep)[1:]:
    current = os.path.join(current, part)
    try:
        metadata = os.lstat(current)
    except FileNotFoundError:
        print("numeric_owner_target_parent_missing", file=sys.stderr)
        raise SystemExit(1)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        print("numeric_owner_target_path_invalid", file=sys.stderr)
        raise SystemExit(1)
try:
    metadata = os.lstat(target)
except FileNotFoundError:
    raise SystemExit(0)
if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or os.listdir(target):
    print("numeric_owner_target_not_blank", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    exit 1
  fi
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

if [ "$NUMERIC_OWNER" = true ]; then
  if [ "${ARCHIVE#/}" = "$ARCHIVE" ] || [ -L "$ARCHIVE" ] || [ ! -f "$checksum" ] || [ -L "$checksum" ]; then
    echo "numeric_owner_archive_identity_invalid" >&2
    exit 1
  fi
  if ! python3 - "$ARCHIVE" "$checksum" <<'PY'
import hashlib
import os
import re
import stat
import sys

archive, checksum = sys.argv[1:]
for target in (archive, checksum):
    metadata = os.lstat(target)
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(1)
line = open(checksum, encoding="ascii").read()
match = re.fullmatch(r"([0-9a-f]{64})  ([^/\n]+)\n", line)
if not match or match.group(2) != os.path.basename(archive):
    raise SystemExit(1)
digest = hashlib.sha256()
with open(archive, "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != match.group(1):
    raise SystemExit(1)
PY
  then
    echo "numeric_owner_archive_identity_invalid" >&2
    exit 1
  fi
fi

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

if [ "$NUMERIC_OWNER" = true ]; then
  # Work from one private immutable copy. Validation and extraction therefore
  # see the same bytes even if the caller's unencrypted archive is replaced.
  if [ -z "$decrypt_tmp_dir" ]; then
    decrypt_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/open-science-backup.XXXXXX")"
    numeric_archive="$decrypt_tmp_dir/archive.tar.gz"
    cp "$ARCHIVE" "$numeric_archive"
    archive_for_restore="$numeric_archive"
  fi
  if ! python3 - "$archive_for_restore" <<'PY'
import posixpath
import sys
import tarfile

seen = set()
try:
    with tarfile.open(sys.argv[1], "r:gz") as archive:
        members = archive.getmembers()
        if not members:
            raise ValueError("empty")
        for member in members:
            name = member.name.rstrip("/") or "."
            normalized = posixpath.normpath(name)
            if (not name or "\x00" in name or name.startswith("/") or normalized != name
                    or normalized == ".." or normalized.startswith("../") or name in seen
                    or not (member.isfile() or member.isdir())
                    or not 0 <= member.uid <= 0xffffffff or not 0 <= member.gid <= 0xffffffff
                    or member.mode < 0 or member.mode > 0o7777):
                raise ValueError("entry")
            seen.add(name)
except (OSError, tarfile.TarError, ValueError):
    print("numeric_owner_archive_invalid", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    exit 1
  fi
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
if [ "$NUMERIC_OWNER" = false ]; then
  mkdir -p "$parent"
fi
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
if [ "$NUMERIC_OWNER" = true ]; then
  python3 - "$archive_for_restore" "$tmp" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    archive.extractall(sys.argv[2], numeric_owner=True)
PY
else
  # Runtime-created files can legitimately carry different numeric owners. The
  # hardened backup container has no CAP_CHOWN, so legacy restores remain owned
  # by the current user.
  tar --no-same-owner -xzf "$archive_for_restore" -C "$tmp"
fi

if find "$tmp" \( -type l -o \! -type d \! -type f \) -print -quit | grep -q .; then
  echo "Refusing to restore archive that extracted unsupported entries." >&2
  exit 1
fi

if [ "$NUMERIC_OWNER" = true ]; then
  # os.rename replaces only an absent or empty directory on this filesystem. A
  # target populated after preflight therefore fails instead of being deleted.
  python3 - "$tmp" "$target" <<'PY'
import os
import sys

os.rename(sys.argv[1], sys.argv[2])
PY
else
  if [ -e "$target" ]; then
    rm -rf "$target"
  fi
  mv "$tmp" "$target"
fi
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
