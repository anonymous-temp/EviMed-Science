#!/usr/bin/env bash
# Resolve every specialist engine's requirements into a fully pinned
# requirements.lock beside them, for the Python its image runs, through the
# PyPI mirror the production host builds from — so every pinned version is one
# that build can fetch.
#
#   compile-engine-locks.sh [engine ...]
#     engine: mr bibliometric topic peer-review drug-safety meta adapter
#     (default: all of them)
#
# Why: the images resolved their requirements at build time, so a rebuild
# took whatever a dependency had released since; on 2026-09-27 an unpinned
# openai 3.x broke the topic engine at import. The Dockerfiles install the lock
# when one is present (deploy/specialist-adapter/Dockerfile and
# Dockerfile.evidence, 项目代码/meta/Dockerfile.evimed), and
# host-engine-delta.sh refuses a delta whose lock differs from the one the
# running image was built with.
#
# What each lock is the resolution of:
#   - the five engines deploy/specialist-adapter/Dockerfile builds (python
#     3.10): the engine's requirements.txt and the adapter's, the adapter's exact
#     pins overriding the engine's own — the image installs the engine's and
#     then the adapter's, so the adapter's pins are what it runs — with the
#     extras the engine asked for kept (uvicorn[standard]);
#   - the MetaAgent (项目代码/meta/Dockerfile.evimed, python 3.11): its
#     pyproject's dependencies, which `pip install .` installs;
#   - the drug-evidence adapter (Dockerfile.evidence, python 3.11): the
#     adapter's requirements.txt.
#
# Re-run after changing any of those requirements and commit the locks with
# the change (test/engineLocks.test.mjs fails on a lock that no longer covers
# its requirements). uv keeps the versions a lock already holds wherever the
# requirements still allow them, so a re-run moves a pin only when a
# requirement forces it; to take newer releases deliberately, delete the lock,
# re-run, and run the engine's suite against the result. The first locks
# (2026-09-28) were seeded with the versions each engine's own development
# venv held, so they pin what its suite passes with. uv resolves from package
# metadata; nothing is installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
INDEX_URL="${EVIMED_LOCK_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple}"
# The images are Debian bookworm (glibc 2.36) on x86_64.
PLATFORM=x86_64-manylinux_2_36
ADAPTER=OpenScience/deploy/specialist-adapter/requirements.txt
SELF=OpenScience/scripts/ops/compile-engine-locks.sh

command -v uv > /dev/null || { echo "uv is required: https://docs.astral.sh/uv/"; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

compile() { # output python-version inputs-and-options...
  local output="$1" python="$2"
  shift 2
  uv pip compile "$@" --python-version "$python" --python-platform "$PLATFORM" \
    --index-url "$INDEX_URL" --custom-compile-command "$SELF" --quiet -o "$output"
}

engine() { # engine directory
  local overrides="$work/overrides.txt"
  # The adapter's pins, each carrying the extras the engine's own requirement
  # names: an override replaces the whole requirement, and a bare
  # `uvicorn==0.30.6` would drop the uvloop/httptools/watchfiles the engine's
  # `uvicorn[standard]` installs today.
  python3 - "$1/requirements.txt" "$ADAPTER" > "$overrides" <<'PY'
import re
import sys

def name_of(text):
    return re.sub(r"[-_.]+", "-", text).lower()

extras = {}
for line in open(sys.argv[1], encoding="utf-8"):
    match = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*\[([^\]]+)\]", line.split("#", 1)[0])
    if match:
        extras[name_of(match.group(1))] = match.group(2).replace(" ", "")
for line in open(sys.argv[2], encoding="utf-8"):
    requirement = line.split("#", 1)[0].strip()
    if not requirement:
        continue
    match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$", requirement)
    name, rest = match.group(1), match.group(2)
    print(f"{name}[{extras[name_of(name)]}]{rest}" if name_of(name) in extras else requirement)
PY
  compile "$1/requirements.lock" 3.10 "$1/requirements.txt" "$ADAPTER" --override "$overrides"
  # The override file is scratch; say what it was.
  sed -i "s|--override ${overrides}|--override ${ADAPTER} (with this engine's extras)|" "$1/requirements.lock"
}

build() { # engine name
  case "$1" in
    mr) engine 项目代码/孟德尔随机化 ;;
    bibliometric) engine 项目代码/文献剂量分析 ;;
    topic) engine 项目代码/科研选题 ;;
    peer-review) engine 项目代码/论文审稿 ;;
    drug-safety) engine 项目代码/药物安全分析agent ;;
    meta) compile 项目代码/meta/requirements.lock 3.11 项目代码/meta/pyproject.toml ;;
    adapter) compile OpenScience/deploy/specialist-adapter/requirements.lock 3.11 "$ADAPTER" ;;
    *) echo "unknown engine: $1"; exit 2 ;;
  esac
  echo "locked: $1"
}

if [ "$#" -eq 0 ]; then set -- mr bibliometric topic peer-review drug-safety meta adapter; fi
for name in "$@"; do build "$name"; done
