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

# Proof the bytes arrived, not just that tar exited 0: compare the two files
# whose staleness has actually bitten, by content.
for f in apps/server/src/runtimeManager.mjs apps/server/src/dshProfilePatch.mjs apps/server/src/server.mjs; do
  local_sum=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  remote_sum=$(ssh -i "$KEY" -o BatchMode=yes "$HOST" "md5sum $DEST/$f" | cut -d' ' -f1)
  [ "$local_sum" = "$remote_sum" ] || { echo "MISMATCH $f: $local_sum != $remote_sum"; exit 1; }
  echo "ok $f"
done
