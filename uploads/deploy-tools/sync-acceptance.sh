#!/usr/bin/env bash
# Push the working tree (not HEAD — the point is to test what is in front of
# you) into the isolated acceptance checkout, leaving node_modules alone.
#
# Syncing HEAD instead was how an afternoon went into diagnosing a control
# plane that turned out to be running code from the previous day.
set -euo pipefail
HOST=${HOST:-ubuntu@82.156.128.153}
KEY=${KEY:-$HOME/.ssh/evimed_deploy}
DEST=${DEST:-/srv/evimed-science/acceptance/dsh-p0-20260824/OpenScience}
SRC=${SRC:-/home/coder/workspace/EviMedScience/OpenScience}

# `git ls-files` rather than a tar exclude list: the tree carries 1.5G of
# node_modules and build output, and an exclude pattern that silently fails to
# match ships all of it. What git tracks plus what git says is modified is
# exactly the code under test.
( cd "$(dirname "$SRC")" && git ls-files -z --cached --others --exclude-standard "$(basename "$SRC")" ) \
| tar -C "$(dirname "$SRC")" --null -T - -cz \
| ssh -i "$KEY" -o BatchMode=yes "$HOST" "sudo tar -xz -C $(dirname "$DEST")"

# Proof the bytes arrived, for EVERY file shipped — not a hand-picked few.
#
# A hand-picked list was the earlier version, and it let a sync that was killed
# mid-stream report success on the three files it happened to name while the
# file that mattered stayed a day old. `tar` exiting 0 says nothing here,
# because it is the *pipe* that gets cut.
manifest=$(mktemp)
( cd "$(dirname "$SRC")" && git ls-files -z --cached --others --exclude-standard "$(basename "$SRC")" ) \
  | tr '\0' '\n' > "$manifest"

# `sudo` on the remote side, because the extraction runs as root and leaves
# root-owned files the login user cannot read. Without it every such file
# reported "FAILED open or read" and the check failed a sync that was in fact
# complete — a checker that cannot tell "differs" from "cannot read" is worse
# than no checker, because the first true mismatch reads like more of the same.
report=$(
  ( cd "$(dirname "$SRC")" && xargs -a "$manifest" -d '\n' md5sum ) \
  | ssh -i "$KEY" -o BatchMode=yes "$HOST" "cd $(dirname "$DEST") && sudo md5sum -c --quiet - 2>&1"
) || true
rm -f "$manifest"

unreadable=$(printf '%s\n' "$report" | grep -c 'open or read' || true)
differing=$(printf '%s\n' "$report" | grep 'FAILED' | grep -vc 'open or read' || true)

if [ "$unreadable" -gt 0 ]; then
  echo "sync unverifiable — $unreadable file(s) could not be read on the host even with sudo:" >&2
  printf '%s\n' "$report" | grep 'open or read' | head -10 >&2
  exit 1
fi
if [ "$differing" -gt 0 ]; then
  echo "sync incomplete — $differing file(s) differ on the host:" >&2
  printf '%s\n' "$report" | grep 'FAILED' | head -20 >&2
  exit 1
fi
echo "sync verified: every tracked file under $(basename "$SRC") matches"
