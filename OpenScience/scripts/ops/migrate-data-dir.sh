#!/usr/bin/env bash
# Safely migrate OPEN_SCIENCE_DATA_DIR to a new local directory or mounted volume.
set -euo pipefail

SOURCE_DIR="${1:-${OPEN_SCIENCE_DATA_DIR:-}}"
TARGET_DIR="${2:-}"

if [ -z "$SOURCE_DIR" ] || [ -z "$TARGET_DIR" ]; then
  echo "Usage: $0 SOURCE_DATA_DIR TARGET_DATA_DIR" >&2
  exit 2
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Source data directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

if [ -L "$SOURCE_DIR" ] || find "$SOURCE_DIR" -type l -print -quit | grep -q .; then
  echo "Refusing to migrate data directory containing symbolic links: $SOURCE_DIR" >&2
  exit 1
fi

source_parent="$(cd "$(dirname "$SOURCE_DIR")" && pwd)"
source="$source_parent/$(basename "$SOURCE_DIR")"
target_parent="$(dirname "$TARGET_DIR")"
mkdir -p "$target_parent"
target_parent="$(cd "$target_parent" && pwd)"
target="$target_parent/$(basename "$TARGET_DIR")"

case "$target/" in
  "$source/"*)
    echo "Target data directory must not be inside the source directory: $target" >&2
    exit 1
    ;;
esac

case "$source/" in
  "$target/"*)
    echo "Source data directory must not be inside the target directory: $source" >&2
    exit 1
    ;;
esac

if [ -e "$target" ] && [ -L "$target" ]; then
  echo "Refusing to migrate into a symbolic-link target: $target" >&2
  exit 1
fi

if [ -e "$target" ] && [ ! -d "$target" ]; then
  echo "Target data path exists but is not a directory: $target" >&2
  exit 1
fi

if [ -e "$target" ] && [ "${OPEN_SCIENCE_MIGRATE_REPLACE:-}" != "true" ]; then
  if [ -n "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ]; then
    echo "Target data directory is not empty. Set OPEN_SCIENCE_MIGRATE_REPLACE=true to replace it: $target" >&2
    exit 1
  fi
fi

if [ -e "$target" ] && find "$target" -type l -print -quit | grep -q .; then
  echo "Refusing to replace target data directory containing symbolic links: $target" >&2
  exit 1
fi

tmp="$target_parent/.open-science-migrate.$$"

cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

rm -rf "$tmp"
mkdir -m 700 "$tmp"

tar -cf - -C "$source" . | tar -xf - -C "$tmp"

if find "$tmp" -type l -print -quit | grep -q .; then
  echo "Refusing migrated copy containing symbolic links." >&2
  exit 1
fi

if ! diff -qr "$source" "$tmp" >/dev/null; then
  echo "Migrated copy does not match source. Stop writers and retry." >&2
  exit 1
fi

if [ -e "$target" ]; then
  rm -rf "$target"
fi
mv "$tmp" "$target"
trap - EXIT

echo "$target"
