#!/usr/bin/env bash
# The frontier jury's operator step (2026-11-03), run on the dev box that holds the Claude login. The lab never labels: its unattended monthly
# run stops at a named wait ("wait labels-development" / "wait labels-confirmation" in $STATE/<month>/STATUS, exit 0). This script answers that wait:
#
#   rsi-frontier-label.sh <YYYY-MM> [--prefix rehearsal-] [--model claude-sonnet-5-5] [--effort medium] [--concurrency 3] [--phase development|confirmation]
#                         [--dry-run] [-- <flags for rsi-lab-monthly.sh, e.g. --development-days ... --id-prefix rehearsal->]
#
#   1. reads the lab's STATUS over ssh and takes the phase it waits for (--phase names it when the status cannot be read);
#   2. fetches $OUTBOX/<month>/label-items-<phase>.json and its sha256 (read-only: `sudo cat`) and checks them;
#   3. calibrates the jury on the human anchor once per month (frontier_labels.mjs calibrate, the box's `claude` CLI under the subscription: no lab cash,
#      tokens only); a calibration that does not qualify is uploaded alone and stops the campaign;
#   4. labels the phase's items (two passes each) and refuses to upload a run that stopped (a spent usage window above all) or is incomplete: every answer
#      is cached, so the same command after the reset asks only for what is missing;
#   5. uploads calibration.json and labels-<phase>.json, each with a sha256, into $INBOX/frontier-labels-<month>/ (the data first, the digest last, each
#      written under a temporary name and renamed);
#   6. starts the lab's run again (systemctl start evimed-rsi-campaign.service for the current month; systemd-run with the month and the flags otherwise,
#      each flag quoted for the remote shell, and a rehearsal's `--id-prefix` added when --prefix names it and the flags do not).
#
# The lab verifies the digests and continues: development -> decide -> (only if development found a candidate) the confirmation phase, for which this
# script is run again. Month, phase, export digest and jury are all in the files, and the lab refuses labels that do not match its plan.
#
# RSI_LAB_SSH (evimed-test) is the lab's ssh alias; RSI_LABEL_DIR (${XDG_CACHE_HOME:-~/.cache}/evimed-rsi/frontier-labels/<month>) holds the fetched files, the
# jury cache and the outputs; RSI_LAB_ROOT (/srv/rsi-lab) is the lab's tree. --dry-run prints each step instead of doing it.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
MONTH=${1:?month YYYY-MM}; shift
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
PREFIX="" MODEL=claude-sonnet-5-5 EFFORT=medium CONCURRENCY=3 PHASE="" DRY="" LAB_FLAGS=()
while [ $# -gt 0 ]; do
  case $1 in
    --prefix) PREFIX=${2:?}; shift 2 ;;
    --model) MODEL=${2:?}; shift 2 ;;
    --effort) EFFORT=${2:?}; shift 2 ;;
    --concurrency) CONCURRENCY=${2:?}; shift 2 ;;
    --phase) PHASE=${2:?}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --) shift; LAB_FLAGS=("$@"); break ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
# The rehearsal is named by the lab's --id-prefix (rsi-lab-monthly.sh reads it the same way); --prefix and the flags must name the same one.
FLAG_PREFIX="" PREV=""
for arg in "${LAB_FLAGS[@]}"; do
  case $arg in --id-prefix=*) FLAG_PREFIX=${arg#--id-prefix=} ;; esac
  [ "$PREV" != --id-prefix ] || FLAG_PREFIX=$arg
  PREV=$arg
done
[ -z "$FLAG_PREFIX" ] || [ -z "$PREFIX" ] || [ "$FLAG_PREFIX" = "$PREFIX" ] || { echo "--prefix $PREFIX and the lab's --id-prefix $FLAG_PREFIX differ" >&2; exit 2; }
PREFIX=${PREFIX:-$FLAG_PREFIX}
[[ -z $PREFIX || $PREFIX =~ ^rehearsal-([a-z0-9][a-z0-9-]{0,20}-)?$ ]] || { echo "prefix must be empty or a rehearsal's: rehearsal- or rehearsal-<a-z0-9->-" >&2; exit 2; }
# A rehearsal restarted without its flags still names itself to the lab: without the prefix the lab would start the real month.
[ -z "$PREFIX" ] || [ -n "$FLAG_PREFIX" ] || LAB_FLAGS+=(--id-prefix "$PREFIX")
[[ $MODEL =~ ^claude-[a-z0-9-]+$ ]] || { echo "the jury is a pinned claude-* model" >&2; exit 2; }
KEY=${PREFIX}$MONTH
LAB=${RSI_LAB_SSH:-evimed-test} LABROOT=${RSI_LAB_ROOT:-/srv/rsi-lab}
WORK=${RSI_LABEL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/evimed-rsi/frontier-labels/$KEY}
OUTBOX=$LABROOT/outbox/$KEY INBOX=$LABROOT/inbox/frontier-labels-$KEY STATUS=$LABROOT/state/$KEY/STATUS
LABELS_JS=$ROOT/evals/rsi-campaigns/frontier_labels.mjs
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=30)
say() { echo "$(date -u +%FT%TZ) $*" >&2; }
act() { if [ -n "$DRY" ]; then say "[dry-run] $*"; else "$@"; fi; }
remote() { ssh "${SSH_OPTIONS[@]}" "$LAB" "$@"; }
json() { node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],v);console.log(p===undefined||p===null?"":String(p))' "$1" "$2"; }

# 1. Which wait is the lab in?
if [ -z "$PHASE" ]; then
  LAST=$(remote "sudo tail -n 1 $STATUS" 2>/dev/null || true)
  if [[ $LAST =~ ^wait\ labels-(development|confirmation)\  ]]; then PHASE=${BASH_REMATCH[1]}
  else echo "the lab is not waiting for labels for $KEY (last status line: ${LAST:-unreadable})" >&2; exit 3; fi
fi
[ "$PHASE" = development ] || [ "$PHASE" = confirmation ] || { echo "phase must be development or confirmation" >&2; exit 2; }
say "$KEY: the lab waits for the $PHASE labels"
act mkdir -p "$WORK"

# 2. The label-items, with their digest.
for f in "label-items-$PHASE.json" "label-items-$PHASE.json.sha256"; do
  if [ -n "$DRY" ]; then say "[dry-run] ssh $LAB sudo cat $OUTBOX/$f > $WORK/$f"; else remote "sudo cat $OUTBOX/$f" > "$WORK/$f.part" && mv "$WORK/$f.part" "$WORK/$f"; fi
done
[ -n "$DRY" ] || (cd "$WORK" && sha256sum -c --status "label-items-$PHASE.json.sha256") || { echo "the fetched label-items do not match their sha256" >&2; exit 4; }

# 3. The jury's calibration on the human anchor, once per month.
JURY=(--model "$MODEL" --effort "$EFFORT" --concurrency "$CONCURRENCY")
UPLOAD=()
finished() { [ -s "$1" ] && [ -z "$(json "$1" stopped)" ] && [ "$(json "$1" incomplete)" = 0 ]; }
if [ -n "$DRY" ] || ! finished "$WORK/calibration.json"; then
  say "calibrating $MODEL ($EFFORT) on the anchor's calibration rows"
  act node "$LABELS_JS" calibrate --out "$WORK/calibration.json" --cache "$WORK/jury-cache.jsonl" "${JURY[@]}" \
    || { rm -f "$WORK/calibration.json"; echo "calibration stopped (a spent usage window?); the answers are cached, run again after the reset" >&2; exit 2; }
fi
UPLOAD+=(calibration.json)
if [ -z "$DRY" ]; then
  if [ "$(json "$WORK/calibration.json" model)" != "$MODEL" ] || [ "$(json "$WORK/calibration.json" effort)" != "$EFFORT" ]; then
    echo "$WORK/calibration.json was made with $(json "$WORK/calibration.json" model) at $(json "$WORK/calibration.json" effort), not $MODEL at $EFFORT: remove it to calibrate again" >&2; exit 2
  fi
  say "calibration: $(json "$WORK/calibration.json" model) $(json "$WORK/calibration.json" effort): kappa $(json "$WORK/calibration.json" calibration.pickKappa), pick precision $(json "$WORK/calibration.json" calibration.pickPrecision), recall $(json "$WORK/calibration.json" calibration.pickRecall), abstention $(json "$WORK/calibration.json" calibration.abstentionRate), qualified $(json "$WORK/calibration.json" qualification.qualified)"
  if ! finished "$WORK/calibration.json"; then rm -f "$WORK/calibration.json"; echo "the calibration did not finish; run again" >&2; exit 2; fi
fi

# 4. The phase's labels, unless the calibration already ends the campaign.
if [ -n "$DRY" ] || [ "$(json "$WORK/calibration.json" qualification.qualified)" = true ]; then
  act node "$LABELS_JS" label --items "$WORK/label-items-$PHASE.json" --out "$WORK/labels-$PHASE.json" --cache "$WORK/jury-cache.jsonl" "${JURY[@]}" \
    || { echo "labelling stopped (a spent usage window?); the answers are cached, run again after the reset" >&2; exit 2; }
  if [ -z "$DRY" ]; then
    if [ -n "$(json "$WORK/labels-$PHASE.json" stopped)" ] || [ "$(json "$WORK/labels-$PHASE.json" incomplete)" != 0 ]; then echo "labels-$PHASE.json is not complete: not uploaded; run again" >&2; exit 2; fi
    say "labelled $(json "$WORK/labels-$PHASE.json" labelled) items: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).labelCounts))' "$WORK/labels-$PHASE.json"), tokens $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tokens))' "$WORK/labels-$PHASE.json"), cost 0 (subscription)"
  fi
  UPLOAD+=("labels-$PHASE.json")
else
  say "the calibration does not qualify: it is uploaded alone and the lab ends the campaign (campaign_labels_unqualified)"
fi

# 5. Into the lab's inbox: the data first, the digest last, each renamed into place.
act remote "sudo install -d -m 0750 -o root -g rsi-lab $INBOX"
put() { # local file, remote name
  local dest=$INBOX/$2
  if [ -n "$DRY" ]; then say "[dry-run] ssh $LAB sudo (cat > $dest) < $1"; return 0; fi
  remote "sudo sh -c 'cat > \"\$1.part\" && chown root:rsi-lab \"\$1.part\" && chmod 0640 \"\$1.part\" && mv \"\$1.part\" \"\$1\"' sh $dest" < "$1"
}
for f in "${UPLOAD[@]}"; do
  put "$WORK/$f" "$f"
  if [ -z "$DRY" ]; then (cd "$WORK" && sha256sum "$f" > "$f.sha256"); fi
  put "$WORK/$f.sha256" "$f.sha256"
done

# 6. The lab's run again.
CURRENT=$(TZ=Asia/Shanghai date +%Y-%m)
if [ ${#LAB_FLAGS[@]} -eq 0 ] && [ -z "$PREFIX" ] && [ "$MONTH" = "$CURRENT" ]; then
  act remote "sudo systemctl start --no-block evimed-rsi-campaign.service"
else
  # The flags reach a root shell on the lab: each is quoted, so a value is one argument and never a command.
  FLAGS=""; [ ${#LAB_FLAGS[@]} -eq 0 ] || FLAGS=$(printf ' %q' "${LAB_FLAGS[@]}")
  act remote "sudo systemd-run --collect --no-block --unit=evimed-rsi-labels-$KEY-$(date +%s) --property=TimeoutStartSec=12h --property=Nice=10 --property=Requires=docker.service --property=After=docker.service /usr/local/lib/evimed-rsi/rsi-lab-monthly.sh $MONTH$FLAGS"
fi
say "$KEY: $PHASE labels uploaded; the lab continues (journalctl -u evimed-rsi-campaign, or tail $LABROOT/state/$KEY/launcher.log on the lab)"
