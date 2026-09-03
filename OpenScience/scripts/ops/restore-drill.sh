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

# A present directory is not a restored one.
#
# The drill asserted that `data/` existed and held no symlinks, and stopped
# there — so an archive that unpacked to an empty directory passed, every day,
# and the state file recorded a successful drill. "Restored nothing" and
# "restored everything" looked alike, which is the failure this whole backup
# exists to prevent.
#
# The shape is what a data directory is: per-user project trees. Checked by
# structure and by count, both cheap, and both things an empty or truncated
# unpack fails.
if [ ! -d "$target/users" ]; then
  echo "Restore drill produced no users/ tree: the archive unpacked to something that is not a data directory." >&2
  exit 1
fi

# No `| head`: under `set -o pipefail` the early close sends SIGPIPE to `find`
# and the drill exits 141 having restored the archive perfectly. Counting all of
# them costs milliseconds on twenty thousand files and cannot fail that way.
# `find | wc -l`, not `find -printf '.' | wc -c`. `-printf` is a GNU extension
# and the image this runs in ships BusyBox find, which rejects the option — with
# `2>/dev/null` swallowing the complaint, so the count came back 0 for a tree of
# 21,211 files and the drill failed every single cycle. The backup itself was
# always fine; the ruler was broken.
#
# The count is taken without discarding stderr, and a find that fails is a
# failed drill rather than an empty one: "the archive restored nothing" and "the
# thing that counts could not run" are not the same finding, and only one of
# them is about the backup.
if ! files="$(find "$target" -type f | wc -l)"; then
  echo "Restore drill could not count the restored files; the drill proves nothing." >&2
  exit 1
fi
files="$(printf '%s' "$files" | tr -d '[:space:]')"
if [ "$files" -lt 20 ]; then
  echo "Restore drill recovered only ${files} file(s); an archive of this deployment carries thousands." >&2
  exit 1
fi

echo "restore drill ok: $ARCHIVE (users/ present, ${files} files)"
