#!/bin/bash
# A fake driver for lane.test.mjs: lane.sh runs it as `$BENCH_LANE_RUN <queue> <lane> <container>` in place of docker.
# It records start and end in $BENCH_LANE_ROOT/fake/calls.log and is steered by marker files in $BENCH_LANE_ROOT/fake/:
#   hold-<queue>     wait here until release-<queue> exists (so a test can touch a STOP file while a queue is running)
#   fail-<queue>     exit 7 after the pause (the file stays, so the queue fails again until the test removes it)
#   pause-<queue>    act like a driver that found results/<queue>/STOP: leave a STOP file there and exit 0 (once)
set -u
F="$BENCH_LANE_ROOT/fake"
mkdir -p "$F" "$BENCH_OUT_DIR"
name=$1 lane=$2 container=$3
echo "start $name $lane $(date +%s.%N) $container" >> "$F/calls.log"
if [ ! -e "$BENCH_QUEUE_FILE" ]; then echo "no queue file $BENCH_QUEUE_FILE" >&2; exit 9; fi
if [ "$BENCH_LANE_ID" != "$lane" ]; then echo "BENCH_LANE_ID does not match" >&2; exit 9; fi
# a held queue gives up after 30 s, so a failed test never leaves a driver waiting for good
if [ -e "$F/hold-$name" ]; then for _ in $(seq 1500); do [ -e "$F/release-$name" ] && break; sleep 0.02; done; fi
sleep "${FAKE_SLEEP:-0.1}"
if [ -e "$F/fail-$name" ]; then echo "end $name $lane $(date +%s.%N) 7" >> "$F/calls.log"; exit 7; fi
if [ -e "$F/pause-$name" ]; then
  rm -f "$F/pause-$name"; touch "$BENCH_OUT_DIR/STOP"
  echo "end $name $lane $(date +%s.%N) 0 paused" >> "$F/calls.log"; exit 0
fi
echo "end $name $lane $(date +%s.%N) 0" >> "$F/calls.log"
exit 0
