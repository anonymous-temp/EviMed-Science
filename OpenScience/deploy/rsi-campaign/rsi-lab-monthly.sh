#!/usr/bin/env bash
# The monthly frontier-selection campaign on the RSI lab host (2026-10-26). Run by evimed-rsi-campaign.service on the 1st at
# 02:00 Asia/Shanghai, or by hand: `rsi-lab-monthly.sh [YYYY-MM] [--rehearsal ...assemble window flags]`.
#
# Resumable: every finished step appends "<step> ok <time>" to $RUN/STATUS and is skipped on the next start, so an interrupted
# run continues where it stopped. Steps run in the lab image as uid 10001 with a read-only root; only the jury and the database
# steps have a network, the evaluator and signer steps have none and are the only ones that see a key. The lab never connects
# to production: production pushes its export into the write-only inbox.
set -euo pipefail
umask 027
MONTH=${1:-$(TZ=Asia/Shanghai date +%Y-%m)}
shift || true
ASSEMBLE_EXTRA=("$@")
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
IMAGE=$(cat /etc/rsi-lab/image)
STATE=/srv/rsi-lab/state INBOX=/srv/rsi-lab/inbox OUTBOX=/srv/rsi-lab/outbox
PREFIX=""; for arg in "${ASSEMBLE_EXTRA[@]}"; do [[ $arg == rehearsal-* ]] && PREFIX=$arg; done
RUN=$STATE/${PREFIX}$MONTH C=/srv/rsi-lab/state/${PREFIX}$MONTH
install -d -o 10001 -g 10001 -m 0750 "$RUN" "$RUN/run" "$OUTBOX/${PREFIX}$MONTH"
ln -sfn "${PREFIX}$MONTH" "$STATE/current"
EXPORT=frontier-$MONTH.json.gz
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$RUN/launcher.log" >&2; }
done_step() { grep -q "^$1 ok" "$RUN/STATUS" 2>/dev/null; }
mark() { echo "$1 ok $(date -u +%FT%TZ) ${2:-}" >> "$RUN/STATUS"; }
outcome() { printf '{"outcome":"%s","reason":"%s"}\n' "$1" "$2" > "$RUN/outcome.json"; chown 10001:10001 "$RUN/outcome.json"; }
# One containerised step. --network is the caller's; nothing else is shared with the host.
lab() {
  local network=$1; shift
  docker run --rm --network "$network" --read-only --tmpfs /tmp:size=256m,noexec,nosuid --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 256 --memory 3g --user 10001:10001 --env-file /etc/rsi-lab/secrets/lab.env -e HOME=/tmp \
    -e NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2500 \
    -v /etc/rsi-lab/owner-inputs:/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$INBOX":/srv/rsi-lab/inbox:ro "$@"
}
finish() { lab none -v "$OUTBOX":/srv/rsi-lab/outbox "$IMAGE" evals/rsi-campaigns/monthly_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  sign_report; exit "${1:-0}"; }
sign_report() {
  [ -s "$RUN/report.json" ] || return 0
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 \
    -v /etc/rsi-lab/keys/evaluator.pem:/run/rsi-keys/evaluator.pem:ro -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
    evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$OUTBOX/${PREFIX}$MONTH/" 2>/dev/null || true
  cp -f "$RUN/report.signed.json" "$OUTBOX/${PREFIX}$MONTH/" 2>/dev/null || true
  log "report: $(head -3 "$RUN/report.md" | tail -1)"
}

log "campaign $MONTH ${PREFIX:+($PREFIX)} image $IMAGE"
# 1. The export production pushed (00:30); wait up to six hours for it.
if ! done_step export; then
  for _ in $(seq 1 72); do [ -s "$INBOX/$EXPORT" ] && [ -s "$INBOX/$EXPORT.sha256" ] && break; sleep 300; done
  [ -s "$INBOX/$EXPORT" ] || { log "export missing"; outcome not-run campaign_export_missing; finish 3; }
  (cd "$INBOX" && sha256sum -c --status "$EXPORT.sha256") || { log "export checksum mismatch"; outcome not-run campaign_export_checksum; finish 3; }
  mark export "$(cut -c1-16 "$INBOX/$EXPORT.sha256")"
fi
step() { local name=$1; shift; if done_step "$name"; then return 0; fi; log "step $name"; if "$@" > "$RUN/$name.out" 2> "$RUN/$name.err"; then mark "$name"; else log "step $name failed: $(tail -c 400 "$RUN/$name.err")"; return 1; fi; }
step bootstrap lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/lab_bootstrap.mjs /run/rsi-lab/config.json || { outcome not-run campaign_lab_unavailable; finish 4; }
step plan lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs plan --export "/srv/rsi-lab/inbox/$EXPORT" --month "$MONTH" --out "$C/plan.json" "${ASSEMBLE_EXTRA[@]}" || { outcome not-run campaign_plan_failed; finish 4; }
if ! done_step ids; then python3 -c 'import json,sys;json.dump(json.load(open(sys.argv[1]))["ids"],open(sys.argv[2],"w"))' "$RUN/plan.json" "$RUN/ids.json" && chown 10001:10001 "$RUN/ids.json" && mark ids; fi
JURY=(-v /etc/rsi-lab/credentials/dashscope.key:/run/rsi-credentials/dashscope.key:ro)
step calibrate lab rsi-lab-net "${JURY[@]}" "$IMAGE" evals/rsi-campaigns/frontier_labels.mjs calibrate --gold evals/frontier-selection/gold.jsonl \
  --credential /run/rsi-credentials/dashscope.key --out "$C/calibration.json" --cache /srv/rsi-lab/state/jury-cache.jsonl --campaign "${PREFIX}frontier-selection-$MONTH" --config /run/rsi-lab/config.json \
  || { outcome not-run campaign_jury_unavailable; finish 5; }
step label lab rsi-lab-net "${JURY[@]}" "$IMAGE" evals/rsi-campaigns/frontier_labels.mjs label --export "/srv/rsi-lab/inbox/$EXPORT" --ids "$C/ids.json" \
  --credential /run/rsi-credentials/dashscope.key --out "$C/labels.json" --cache /srv/rsi-lab/state/jury-cache.jsonl --campaign "${PREFIX}frontier-selection-$MONTH" --config /run/rsi-lab/config.json \
  || { outcome not-run campaign_labelling_incomplete; finish 5; }
step build lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs build --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --labels "$C/labels.json" \
  --calibration "$C/calibration.json" --out-dir "$C" || { outcome not-run campaign_assembly_failed; finish 6; }
[ -s "$RUN/manifest.json" ] || { outcome not-run "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("reason","campaign_not_assembled"))' "$RUN/supply.json" 2>/dev/null || echo campaign_not_assembled)"; finish 0; }
ARGS=(--manifest "$C/manifest.json" --inputs "$C/inputs.json" --config /run/rsi-lab/config.json --out-dir "$C/run")
step run lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs run "${ARGS[@]}" || true
STATUS_RUN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("status",""))' "$RUN/run/run.json" 2>/dev/null || echo "")
if [ "$STATUS_RUN" != "awaiting-evaluation" ] && [ "$STATUS_RUN" != "completed" ]; then outcome not-qualified "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("reason",""))' "$RUN/run/run.json" 2>/dev/null)"; finish 0; fi
step checkpoint lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs report "${ARGS[@]}" || { outcome not-run campaign_checkpoint_unreadable; finish 7; }
KEYS=(-v /etc/rsi-lab/keys/evaluator.pem:/run/rsi-keys/evaluator.pem:ro)
step receipt docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 "${KEYS[@]}" -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
  evals/rsi-campaigns/evaluator.mjs receipt "$C/manifest.json" "$C/inputs.json" "$C/run/request.json" "$C/run/report.json" /run/rsi-keys/evaluator.pem "$C/receipt.json" \
  || { outcome not-qualified "$(tail -c 300 "$RUN/receipt.err" | grep -o 'campaign_[a-z_]*' | head -1)"; finish 0; }
step resume lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs resume "${ARGS[@]}" --evaluator-profile /run/rsi-lab/evaluator-profile.json || true
VERDICT=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("qualification") or d.get("status",""))' "$RUN/run/resume.json" 2>/dev/null || echo "")
log "verdict: ${VERDICT:-unknown}"
if [ "$VERDICT" = "qualified" ] && [ -z "$PREFIX" ]; then
  step evidence lab rsi-lab-net "${KEYS[@]}" "$IMAGE" evals/rsi-campaigns/evaluator.mjs evidence "$C/manifest.json" "$C/inputs.json" "$C/run/resume.json" \
    /run/rsi-lab/statistics-qualification.json /run/rsi-keys/evaluator.pem "$C/evidence.json" || log "evidence refused"
  if done_step evidence; then
    python3 - "$RUN" <<'PY'
import json, sys, os
run = sys.argv[1]
resume = json.load(open(f'{run}/run/resume.json')); evidence = json.load(open(f'{run}/evidence.json'))
json.dump({'completed': resume, 'manifest': json.load(open(f'{run}/manifest.json')), 'inputs': json.load(open(f'{run}/inputs.json')),
           'files': evidence['files'], 'evidenceEnvelope': evidence['evidenceEnvelope'], 'bundleId': f"{resume['checkpoint']['campaignId']}-bundle",
           'expiresAt': evidence['evidenceEnvelope']['payload']['expiresAt']}, open(f'{run}/finalize-input.json', 'w'))
os.chown(f'{run}/finalize-input.json', 10001, 10001)
PY
    step finalize docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 \
      -v /etc/rsi-lab/keys:/run/rsi-keys:ro -v /etc/rsi-lab/owner-inputs:/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$OUTBOX":/srv/rsi-lab/outbox "$IMAGE" \
      evals/rsi-campaigns/finalize.mjs /run/rsi-lab/finalize.json || log "finalize refused: $(tail -c 300 "$RUN/finalize.err")"
    [ -s "$RUN/bundle.json" ] && cp -f "$RUN/bundle.json" "$OUTBOX/${PREFIX}$MONTH/bundle.json"
  fi
fi
outcome "${VERDICT:-not-qualified}" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("reason") or "")' "$RUN/run/resume.json" 2>/dev/null)"
finish 0
