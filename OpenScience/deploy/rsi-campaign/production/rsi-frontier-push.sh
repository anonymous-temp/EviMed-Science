#!/usr/bin/env bash
# Production side of the monthly RSI campaign (2026-10-26). The export runs read-only inside the serving web container with
# the release's own code (rsi-frontier-export.mjs); its only output is public frontier content. The push goes to the lab's
# write-only inbox with a key whose authorized_keys entry forces `rrsync -wo` and pins this host's address; the lab holds no
# credential for this host. Usage: rsi-frontier-push.sh [YYYY-MM]   (the run month M: the export covers M-2 and M-1)
set -euo pipefail
umask 077
MONTH=${1:-$(TZ=Asia/Shanghai date +%Y-%m)}
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
FROM=$(date -d "$MONTH-01 -2 month" +%Y-%m-01) TO=$(date -d "$MONTH-01 -1 day" +%F)
# The three directories are this host's fixed layout; a test points them elsewhere.
LIB=${RSI_LIB_DIR:-/usr/local/lib/evimed-rsi} OUT=${RSI_EXPORT_DIR:-/var/lib/evimed-rsi/export} CONF=${RSI_CONFIG_DIR:-/etc/evimed-rsi}
LAB=$(cat "$CONF/lab-host")
WEB=${RSI_EXPORT_WEB_CONTAINER:-web-open-science-web-1}
mkdir -p "$OUT"
NAME=frontier-$MONTH.json.gz
# The export is compressed as it streams: no uncompressed copy of it is ever written on this host, and whatever a failed or interrupted
# run leaves (a partial archive, a half-written checksum, or the uncompressed .json.tmp an older version of this script wrote) is removed
# when the script ends, so a retry starts clean.
trap 'rm -f "$OUT/$NAME.tmp" "$OUT/$NAME.sha256.tmp" "$OUT/frontier-$MONTH.json.tmp"' EXIT
if [ ! -s "$OUT/$NAME.sha256" ]; then
  # Inside the serving container the export is niced and held to a capped heap, so it cannot take memory or CPU the web process needs.
  docker exec -i "$WEB" nice -n 10 node --max-old-space-size="${RSI_EXPORT_MAX_HEAP_MB:-512}" --input-type=module - --from "$FROM" --to "$TO" < "$LIB/rsi-frontier-export.mjs" \
    | gzip -n -c > "$OUT/$NAME.tmp"
  mv "$OUT/$NAME.tmp" "$OUT/$NAME"
  (cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256.tmp" && mv "$NAME.sha256.tmp" "$NAME.sha256")
fi
SSH="ssh -i $CONF/push_ed25519 -o UserKnownHostsFile=$CONF/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30"
# The data first, the checksum last: the lab starts only when both are there and they agree.
rsync -e "$SSH" --chmod=F640 --timeout=600 "$OUT/$NAME" "rsi-inbox@$LAB:$NAME"
rsync -e "$SSH" --chmod=F640 --timeout=60 "$OUT/$NAME.sha256" "rsi-inbox@$LAB:$NAME.sha256"
# Keep two months of exports here.
ls -1t "$OUT"/frontier-*.json.gz 2>/dev/null | tail -n +3 | while read -r old; do rm -f "$old" "$old.sha256"; done
echo "$(date -u +%FT%TZ) pushed $NAME $(cut -c1-16 "$OUT/$NAME.sha256") ($FROM..$TO)"
