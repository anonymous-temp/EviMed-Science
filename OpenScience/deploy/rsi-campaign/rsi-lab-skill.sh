#!/usr/bin/env bash
# The capability-skill campaign on the RSI lab host (2026-10-28): a personal skill measured on MedCalc-Bench rows that ran on
# production (one lane, automated, throwaway accounts). The operator copies the exported runs into the lab inbox under
# skill-<month>/; the lab never connects to production. Two commands, both resumable through $RUN/STATUS:
#
#   rsi-lab-skill.sh <YYYY-MM> improve   the improver (Qwen, lab key, lab budget) reads inbox/skill-<month>/failures.json
#                                        and writes candidates.json to the outbox, for the operator to run as arms
#   rsi-lab-skill.sh <YYYY-MM> run       assemble -> run -> evaluator receipt -> statistics -> signed report
#                                        (waits up to six hours for development.json, confirmation.json, candidates.json,
#                                        registration.json and their .sha256 files in the inbox)
set -euo pipefail
umask 027
MONTH=$1; COMMAND=$2
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
IMAGE=$(cat /etc/rsi-lab/image)
STATE=/srv/rsi-lab/state INBOX=/srv/rsi-lab/inbox OUTBOX=/srv/rsi-lab/outbox
NAME=skill-$MONTH RUN=$STATE/skill-$MONTH C=/srv/rsi-lab/state/skill-$MONTH IN=/srv/rsi-lab/inbox/skill-$MONTH
install -d -o 10001 -g 10001 -m 0750 "$RUN" "$RUN/run" "$OUTBOX/$NAME"
ln -sfn "skill-$MONTH" "$STATE/skill-current"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$RUN/launcher.log" >&2; }
done_step() { grep -q "^$1 ok" "$RUN/STATUS" 2>/dev/null; }
mark() { echo "$1 ok $(date -u +%FT%TZ) ${2:-}" >> "$RUN/STATUS"; }
lab() {
  local network=$1; shift
  docker run --rm --network "$network" --read-only --tmpfs /tmp:size=256m,noexec,nosuid --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 256 --memory 3g --user 10001:10001 --env-file /etc/rsi-lab/secrets/lab.env -e HOME=/tmp \
    -e NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2500 \
    -v /etc/rsi-lab/owner-inputs:/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$INBOX":/srv/rsi-lab/inbox:ro "$@"
}
step() { local name=$1; shift; if done_step "$name"; then return 0; fi; log "step $name"; if "$@" > "$RUN/$name.out" 2> "$RUN/$name.err"; then mark "$name"; else log "step $name failed: $(tail -c 400 "$RUN/$name.err")"; return 1; fi; }
verify() { (cd "$INBOX/$NAME" && for f in "$@"; do [ -s "$f" ] && [ -s "$f.sha256" ] && sha256sum -c --status "$f.sha256" || return 1; done); }
KEYS=(-v /etc/rsi-lab/keys/evaluator.pem:/run/rsi-keys/evaluator.pem:ro)
CRED=(-v /etc/rsi-lab/credentials/dashscope.key:/run/rsi-credentials/dashscope.key:ro)

log "skill campaign $MONTH $COMMAND image $IMAGE"
if [ "$COMMAND" = improve ]; then
  verify failures.json || { log "failures.json missing or checksum mismatch"; exit 3; }
  step bootstrap lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/lab_bootstrap.mjs /run/rsi-lab/config.json || exit 4
  step improve lab rsi-lab-net "${CRED[@]}" "$IMAGE" evals/rsi-campaigns/skill_improver.mjs --failures "$IN/failures.json" \
    --credential /run/rsi-credentials/dashscope.key --config /run/rsi-lab/config.json --campaign "capability-skill-medcalc-$MONTH" --out "$C/candidates.json" || exit 5
  cp -f "$RUN/candidates.json" "$OUTBOX/$NAME/candidates.json"; log "candidates: $(cat "$RUN/improve.out")"; exit 0
fi
[ "$COMMAND" = run ] || { echo "command is improve or run" >&2; exit 2; }
if ! done_step inputs; then
  for _ in $(seq 1 72); do verify development.json confirmation.json candidates.json registration.json && break; sleep 300; done
  verify development.json confirmation.json candidates.json registration.json || { log "inputs missing"; exit 3; }
  mark inputs
fi
SLICE=$(python3 -c 'import json,sys;print(",".join(str(x) for x in json.load(open(sys.argv[1]))["failureCalculators"]))' "$INBOX/$NAME/registration.json")
step assemble lab none "$IMAGE" evals/rsi-campaigns/skill_assemble.mjs --development "$IN/development.json" --confirmation "$IN/confirmation.json" \
  --candidates "$IN/candidates.json" --failure-calculators "$SLICE" --month "$MONTH" --out-dir "$C" || exit 6
ARGS=(--manifest "$C/manifest.json" --inputs "$C/inputs.json" --config /run/rsi-lab/config.json --out-dir "$C/run")
report() {
  lab none "$IMAGE" evals/rsi-campaigns/skill_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  [ -s "$RUN/report.json" ] && docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 "${KEYS[@]}" \
    -v "$STATE":/srv/rsi-lab/state "$IMAGE" evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$RUN/report.signed.json" "$RUN/supply.json" "$OUTBOX/$NAME/" 2>/dev/null || true
  log "report: $(sed -n 3p "$RUN/report.md" 2>/dev/null)"
}
step run lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs run "${ARGS[@]}" || true
STATUS_RUN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("status",""))' "$RUN/run/run.json" 2>/dev/null || echo "")
if [ "$STATUS_RUN" != "awaiting-evaluation" ] && [ "$STATUS_RUN" != "completed" ]; then report; exit 0; fi
step checkpoint lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs report "${ARGS[@]}" || { report; exit 7; }
step receipt docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 "${KEYS[@]}" -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
  evals/rsi-campaigns/evaluator.mjs receipt "$C/manifest.json" "$C/inputs.json" "$C/run/request.json" "$C/run/report.json" /run/rsi-keys/evaluator.pem "$C/receipt.json" || { report; exit 0; }
step resume lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs resume "${ARGS[@]}" --evaluator-profile /run/rsi-lab/evaluator-profile-skill.json || true
report
