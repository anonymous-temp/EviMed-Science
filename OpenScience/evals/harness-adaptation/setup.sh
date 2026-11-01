#!/usr/bin/env bash
# Fetch the pinned upstream Harness2 commit into a work directory and apply this directory's patch set to it.
#
#   setup.sh            fetch (if needed), check out the pin, apply patches/*.patch, write <workdir>/.h2-setup.json
#   setup.sh --check    verify an existing work directory (pin, patches, clean tree) and change nothing
#
#   H2_WORKDIR        work directory (default /tmp/rsi1-scratch/harness2)
#   H2_SOURCE         a local clone or URL to fetch from instead of GitHub (offline work)
#
# Upstream is Apache-2.0 (Google LLC) and is never vendored into this repository: only the patches are. See PATCHES.md.
set -euo pipefail

PIN="1cfe254e8d25b15f37048c3730134686abe60335"
URL="https://github.com/google-research/harness2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${H2_WORKDIR:-/tmp/rsi1-scratch/harness2}"
SOURCE="${H2_SOURCE:-$URL}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

python3 - <<'PY' || { echo "setup: Python 3.12 or newer is required (upstream's floor)" >&2; exit 1; }
import sys
sys.exit(0 if sys.version_info >= (3, 12) else 1)
PY

patch_files() { ls "$HERE"/patches/*.patch 2>/dev/null | sort || true; }

marker() {
  python3 - "$WORK" "$PIN" $(patch_files) <<'PY'
import hashlib, json, pathlib, sys, time
work, pin, *patches = sys.argv[1:]
rows = [{"name": pathlib.Path(p).name, "sha256": hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()} for p in patches]
pathlib.Path(work, ".h2-setup.json").write_text(
    json.dumps({"pin": pin, "patches": rows, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, indent=2) + "\n")
PY
}

if [ "$CHECK" = 1 ]; then
  [ -d "$WORK/.git" ] || { echo "setup --check: no work directory at $WORK" >&2; exit 1; }
  [ "$(git -C "$WORK" rev-parse HEAD)" = "$PIN" ] || { echo "setup --check: $WORK is not at the pin" >&2; exit 1; }
  for p in $(patch_files); do
    git -C "$WORK" apply --reverse --check "$p" 2>/dev/null || { echo "setup --check: $(basename "$p") is not applied" >&2; exit 1; }
  done
  echo "setup --check: ok ($WORK at ${PIN:0:12}, $(patch_files | wc -l) patch(es) applied)"
  exit 0
fi

mkdir -p "$WORK"
if [ ! -d "$WORK/.git" ]; then
  git init -q "$WORK"
  git -C "$WORK" remote add origin "$SOURCE"
fi
if [ "$(git -C "$WORK" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$PIN" ]; then
  # A dirty tree here would be somebody's work; refuse rather than overwrite it.
  if [ -n "$(git -C "$WORK" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "setup: $WORK has local changes and is not at the pin; move it aside" >&2
    exit 1
  fi
  git -C "$WORK" fetch -q --depth 1 origin "$PIN"
  git -C "$WORK" checkout -q --detach "$PIN"
fi
[ "$(git -C "$WORK" rev-parse HEAD)" = "$PIN" ] || { echo "setup: fetched commit is not the pin" >&2; exit 1; }

for p in $(patch_files); do
  if git -C "$WORK" apply --reverse --check "$p" 2>/dev/null; then
    echo "setup: $(basename "$p") already applied"
  elif git -C "$WORK" apply --check "$p" 2>/dev/null; then
    git -C "$WORK" apply "$p"
    echo "setup: applied $(basename "$p")"
  else
    echo "setup: $(basename "$p") neither applies nor is applied; the work directory is not the pin" >&2
    exit 1
  fi
done
marker
echo "setup: ready $WORK at ${PIN:0:12}"
