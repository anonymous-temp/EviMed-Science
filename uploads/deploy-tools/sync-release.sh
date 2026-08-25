#!/usr/bin/env bash
# Put a commit's changed files into a release directory, and prove they arrived.
# Run from the repo root.
#
#   sync-release.sh <release-id> [<git-ref>] [<base-ref>]
#
# Piping a whole 81MB `git archive` over ssh once exited 0 having left files
# untouched, which is worse than failing: the release then looks deployed and
# behaves like the previous commit. Only the changed files are sent, and every
# one is checksummed on both sides afterwards.
#
# The base ref matters. A release directory is copied from a predecessor, so
# what it is missing is everything since the commit that predecessor was built
# from — not just the last commit. With two commits since, sending only HEAD's
# files left a release running the older UI while reporting the new revision.
#
# Kept in the repo rather than /tmp, which gets cleaned between sessions.
set -euo pipefail

REL=$1
REF=${2:-HEAD}
BASE=${3:-}
HOST=ubuntu@82.156.128.153
KEY=~/.ssh/evimed_deploy
ROOT=/srv/evimed-science/releases/${REL}

if [ -n "$BASE" ]; then
  mapfile -t FILES < <(git diff --name-only "$BASE" "$REF")
  echo "sending everything changed between ${BASE} and ${REF}"
else
  mapfile -t FILES < <(git diff-tree --no-commit-id --name-only -r "$REF")
fi
[ "${#FILES[@]}" -gt 0 ] || { echo "no files changed in ${REF}"; exit 1; }
printf 'sending %d file(s) to %s\n' "${#FILES[@]}" "$REL"

git archive --format=tar "$REF" -- "${FILES[@]}" \
  | ssh -i "$KEY" "$HOST" "sudo tar -x -C ${ROOT}"

mismatch=0
for f in "${FILES[@]}"; do
  local_sum=$(git show "${REF}:${f}" | md5sum | cut -d' ' -f1)
  remote_sum=$(ssh -i "$KEY" "$HOST" "sudo md5sum ${ROOT}/${f} 2>/dev/null" | cut -d' ' -f1)
  if [ "$local_sum" = "$remote_sum" ]; then
    printf '  ok   %s\n' "$f"
  else
    printf '  FAIL %s (local %s, remote %s)\n' "$f" "${local_sum:0:8}" "${remote_sum:0:8}"
    mismatch=$((mismatch + 1))
  fi
done
[ "$mismatch" -eq 0 ] || { echo "${mismatch} file(s) did not arrive"; exit 1; }
echo "every changed file verified in ${REL}"
