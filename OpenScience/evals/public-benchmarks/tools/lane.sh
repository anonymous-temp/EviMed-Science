#!/bin/bash
# One benchmark lane on the production host: runs the queues listed in /srv/evimed-science/shared/benchmarks/lane/pending.txt
# one after another (one driver process, one throwaway account per queue), so a queue can be inserted or appended while the
# lane runs. A queue that exits non-zero stops the lane for inspection; `touch lane/STOP` stops it after the current queue.
set -u
B=/srv/evimed-science/shared/benchmarks
IMAGE=$(docker inspect web-open-science-web-1 --format '{{.Config.Image}}')
mkdir -p "$B/lane"; touch "$B/lane/pending.txt" "$B/lane/done.txt"
log() { echo "$(date -u +%FT%TZ) $*" >> "$B/lane/lane.log"; }
log "lane start image=$IMAGE"
while true; do
  [ -e "$B/lane/STOP" ] && { log "STOP file: lane ends"; rm -f "$B/lane/STOP"; exit 0; }
  name=$(grep -v '^\s*$' "$B/lane/pending.txt" | head -1)
  if [ -z "$name" ]; then sleep 60; continue; fi
  log "queue $name start"
  docker rm -f "bench-$name" >/dev/null 2>&1
  docker run --rm --name "bench-$name" --network host --user 0:0 --stop-timeout 180 \
    -v "$B":/bench --entrypoint node "$IMAGE" /bench/tools/bench-driver.mjs \
    --queue "/bench/queue/$name.jsonl" --out "/bench/results/$name" >> "$B/lane/lane.log" 2>&1
  code=$?
  log "queue $name exit=$code"
  if [ "$code" -ne 0 ]; then log "lane stops on non-zero exit"; exit "$code"; fi
  # A driver stopped by its STOP file exits 0 with items left: keep the queue pending so the next start resumes it.
  if [ -e "$B/results/$name/STOP" ]; then rm -f "$B/results/$name/STOP"; log "queue $name paused by STOP; stays pending"; continue; fi
  grep -v -x -F "$name" "$B/lane/pending.txt" > "$B/lane/pending.tmp"; mv "$B/lane/pending.tmp" "$B/lane/pending.txt"
  echo "$name" >> "$B/lane/done.txt"
done
