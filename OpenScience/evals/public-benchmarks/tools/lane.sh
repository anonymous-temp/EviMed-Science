#!/bin/bash
# Benchmark lanes on the production host. A lane runs the queues listed in <B>/lane/pending.txt one after another (one
# driver process, one throwaway account per queue), so a queue can be inserted or appended while it runs. A queue that exits
# non-zero stops the lane for inspection. B is /srv/evimed-science/shared/benchmarks (BENCH_LANE_ROOT overrides it).
#
#   lane.sh                  the default lane: exactly the single lane of baseline v1 (lane/lane.log, lane/STOP, container
#                            bench-<queue>). `touch lane/STOP` ends it after the current queue.
#   lane.sh <id>             a named lane, for running several lanes on one host (ids: letters, digits, _ and -; not "default").
#                            lane/lane-<id>.log, `touch lane/STOP-<id>` ends only this lane after its current queue, container
#                            bench-<queue>-<id>. Start as many as the host and the runtime slots allow; how many is a decision
#                            of the operator, not of this script.
#   lane.sh --status         pending queues with their claims, and which lanes are running
#   lane.sh --release-stale  remove the claims of lanes that are not running (never a running lane's claim)
#
# Shared by all lanes
#   lane/pending.txt   the one list of queues, in order; each lane takes the first queue nobody has claimed. Edit it under
#                      `flock lane/pending.lock` while lanes run (the lanes update it under the same lock).
#   lane/done.txt      a queue is appended when it finished, and removed from pending.txt in the same locked step.
#   lane/claims/<queue>/holder   the claim: `mkdir` is atomic, so two lanes never take one queue. It holds the lane id.
#                      Released when the queue finishes or is paused. A queue that made its lane stop (non-zero exit) keeps
#                      its claim, so no other lane repeats a failing queue unseen: look at the log, fix, then restart the same
#                      lane id (it resumes the queue it still holds) or `--release-stale`. A claim is stale when its lane is
#                      not running (the lane holds lane/lane[-<id>].lock for as long as it lives); stale claims are only ever
#                      removed by `--release-stale`, never taken over silently.
#   lane/STOP-ALL      ends every lane after its current queue, and keeps lanes from starting while it exists. No lane removes
#                      it: remove it to let lanes run again.
#   results/<queue>/   one driver --out per queue, so lanes never share one. results/<queue>/STOP is the driver's own stop
#                      (it finishes the item in hand and exits 0): the queue is then paused, its claim released, and it stays
#                      pending. To pause a queue for good also touch the lane's STOP file, or the lane takes it up again.
#
# Test seams (production sets none of them): BENCH_LANE_ROOT (B), BENCH_LANE_IDLE_S (seconds to wait when nothing is
# pending, default 60), BENCH_LANE_RUN (an executable run instead of docker as `$BENCH_LANE_RUN <queue> <lane> <container>`,
# with BENCH_QUEUE_FILE, BENCH_OUT_DIR and BENCH_LANE_ID in its environment; its exit status is the driver's).
set -u
B="${BENCH_LANE_ROOT:-/srv/evimed-science/shared/benchmarks}"
IDLE="${BENCH_LANE_IDLE_S:-60}"
RUN="${BENCH_LANE_RUN:-}"
L="$B/lane"

usage() { sed -n '2,/^set -u/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

lane_lock_file() { if [ "$1" = default ]; then echo "$L/lane.lock"; else echo "$L/lane-$1.lock"; fi; }
# A lane is running while it holds its lock; a free lock (or none) means it is gone.
lane_alive() {
  local f; f=$(lane_lock_file "$1")
  [ -e "$f" ] || return 1
  if ( flock -n 9 ) 9>"$f" 2>/dev/null; then return 1; fi
  return 0
}
holder_of() { sed -n 's/^lane=//p' "$L/claims/$1/holder" 2>/dev/null | head -n 1; }
claim_age() { local m; m=$(stat -c %Y "$L/claims/$1" 2>/dev/null) || m=0; echo $(( $(date +%s) - m )); }

status() {
  echo "pending ($L/pending.txt):"
  local name holder state
  while IFS= read -r name || [ -n "$name" ]; do
    [ -z "${name//[[:space:]]/}" ] && continue
    holder=$(holder_of "$name")
    if [ -d "$L/claims/$name" ]; then
      if [ -n "$holder" ] && lane_alive "$holder"; then state="claimed by lane $holder (running)"
      else state="claim of lane ${holder:-?} is STALE"; fi
    else state="unclaimed"; fi
    echo "  $name: $state"
  done < "$L/pending.txt"
  echo "lanes:"
  local f id
  for f in "$L"/lane.lock "$L"/lane-*.lock; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .lock); id=${id#lane-}; [ "$id" = lane ] && id=default
    if lane_alive "$id"; then echo "  $id: running"; else echo "  $id: not running"; fi
  done
}

release_stale() {
  local d name holder n=0
  for d in "$L"/claims/*; do
    [ -d "$d" ] || continue
    name=$(basename "$d"); holder=$(holder_of "$name")
    if [ -z "$holder" ]; then
      # mkdir done, holder not written yet: a claim in the making, unless it has been like that for a while
      [ "$(claim_age "$name")" -gt 10 ] || continue
    elif lane_alive "$holder"; then continue; fi
    rm -rf "$d"; echo "released $name (lane ${holder:-?} is not running)"; n=$((n + 1))
  done
  echo "$n stale claim(s) released"
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --status) mkdir -p "$L/claims"; touch "$L/pending.txt"; status; exit 0 ;;
  --release-stale) mkdir -p "$L/claims"; release_stale; exit 0 ;;
  "") LANE=""; TAG=default; LOG="$L/lane.log"; STOP="$L/STOP" ;;
  -*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
  *)
    if ! [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]] || [ "$1" = default ]; then
      echo "lane id must be letters, digits, _ or - (at most 32), and not \"default\"" >&2; exit 2
    fi
    LANE="$1"; TAG="$1"; LOG="$L/lane-$1.log"; STOP="$L/STOP-$1" ;;
esac

mkdir -p "$L/claims"; touch "$L/pending.txt" "$L/done.txt"
log() { echo "$(date -u +%FT%TZ) ${LANE:+lane $LANE: }$*" >> "$LOG"; }

# One lane per id: a second start of the same lane would run its queue twice.
exec 9>"$(lane_lock_file "$TAG")"
if ! flock -n 9; then echo "lane $TAG is already running" >&2; exit 3; fi

if [ -n "$RUN" ]; then IMAGE="(BENCH_LANE_RUN)"; else IMAGE=$(docker inspect web-open-science-web-1 --format '{{.Config.Image}}'); fi

pending_locked() { ( flock 8 && "$@" ) 8>"$L/pending.lock"; }

# Take the claim of a queue: ours already (this lane id held it before it stopped or was restarted), or a new one.
try_claim() {
  local d="$L/claims/$1"
  if mkdir "$d" 2>/dev/null; then
    printf 'lane=%s\npid=%s\nsince=%s\n' "$TAG" "$$" "$(date -u +%FT%TZ)" > "$d/holder"
    return 0
  fi
  [ "$(holder_of "$1")" = "$TAG" ] && return 0
  return 1
}
release_claim() { [ "$(holder_of "$1")" = "$TAG" ] && rm -rf "$L/claims/$1"; return 0; }

# The queue this lane runs next: the first one it already holds, else the first one nobody holds. Run under the pending lock.
pick_queue() {
  local name
  while IFS= read -r name || [ -n "$name" ]; do
    case "$name" in ""|*/*|.*) continue ;; esac
    [ -z "${name//[[:space:]]/}" ] && continue
    if [ "$(holder_of "$name")" = "$TAG" ]; then echo "$name"; return 0; fi
  done < "$L/pending.txt"
  while IFS= read -r name || [ -n "$name" ]; do
    case "$name" in ""|*/*|.*) continue ;; esac
    [ -z "${name//[[:space:]]/}" ] && continue
    if try_claim "$name"; then echo "$name"; return 0; fi
  done < "$L/pending.txt"
  return 1
}

# A finished queue leaves pending.txt, joins done.txt and only then drops its claim (so no lane picks it up in between).
finish_queue() {
  grep -v -x -F "$1" "$L/pending.txt" > "$L/pending.tmp"; mv "$L/pending.tmp" "$L/pending.txt"
  echo "$1" >> "$L/done.txt"
  release_claim "$1"
}

run_driver() {
  if [ -n "$RUN" ]; then
    BENCH_LANE_ID="$TAG" BENCH_QUEUE_FILE="$B/queue/$1.jsonl" BENCH_OUT_DIR="$B/results/$1" "$RUN" "$1" "$TAG" "$2" >> "$LOG" 2>&1 9>&-
  else
    docker rm -f "$2" >/dev/null 2>&1
    docker run --rm --name "$2" --network host --user 0:0 --stop-timeout 180 \
      -v "$B":/bench --entrypoint node "$IMAGE" /bench/tools/bench-driver.mjs \
      --queue "/bench/queue/$1.jsonl" --out "/bench/results/$1" >> "$LOG" 2>&1 9>&-
  fi
}

log "lane start image=$IMAGE"
while true; do
  if [ -e "$L/STOP-ALL" ]; then log "STOP-ALL file: lane ends"; exit 0; fi
  if [ -e "$STOP" ]; then log "STOP file: lane ends"; rm -f "$STOP"; exit 0; fi
  name=$(pending_locked pick_queue) || name=""
  if [ -z "$name" ]; then sleep "$IDLE"; continue; fi
  log "queue $name start"
  container="bench-$name${LANE:+-$LANE}"
  run_driver "$name" "$container"
  code=$?
  log "queue $name exit=$code"
  # The claim stays: the queue is parked under this lane until it is looked at (restart this lane id, or --release-stale).
  if [ "$code" -ne 0 ]; then log "lane stops on non-zero exit"; exit "$code"; fi
  # A driver stopped by its STOP file exits 0 with items left: keep the queue pending so the next start resumes it.
  if [ -e "$B/results/$name/STOP" ]; then
    rm -f "$B/results/$name/STOP"; log "queue $name paused by STOP; stays pending"; release_claim "$name"; continue
  fi
  pending_locked finish_queue "$name"
done
