#!/usr/bin/env bash
# The capability-skill campaign on the RSI lab host (2026-10-28): a personal skill measured on MedCalc-Bench rows that ran on
# production (one lane, automated, throwaway accounts). The lab has no improver and this script mounts no provider credential (owner 2026-11-03: every improver is
# Claude, and Claude runs on the operator's box; the one model the lab calls is the frontier jury's, in rsi-lab-monthly.sh): the candidates are written there, by the operator's Claude session, registered with
# `skill_assemble.mjs --register` (content-addressed, the improvers named) and arrive with the runs. The operator copies the exported runs and the
# candidates into the lab inbox under skill-<month>/; the lab never connects to production. One command, resumable through $RUN/STATUS:
#
#   rsi-lab-skill.sh <YYYY-MM> run   assemble -> run -> evaluator receipt -> statistics -> signed report
#                                    (waits up to six hours for development.json, confirmation.json, candidates.json,
#                                    registration.json and their .sha256 files in the inbox; with `mode` = development-only it recomputes
#                                    the development choice and signs a report, opening nothing)
#
# One skill campaign at a time: the lock ($STATE/skill.lock) is taken before anything changes, and a second start exits 75 having changed nothing
# (`skill-current` is the evaluator's receipt path for the month being signed). A resume that fails gave no verdict: the run ends with exit 9 and
# writes no report (start it again once the cause is fixed).
#
# RSI_LAB_ROOT (/srv/rsi-lab), RSI_LAB_ETC (/etc/rsi-lab), RSI_LAB_DOCKER (docker), RSI_LAB_OWNER (10001:10001) and RSI_LAB_POLL_SECONDS (300) move the host layout and
# the docker binary; RSI_LAB_DRY_RUN=1 runs with a docker that prints the command: it reads the inbox and configuration of the tree it is given (a scratch tree of its own when
# RSI_LAB_ROOT is unset) and writes only into scratch directories it removes at exit — no STATUS, log, report, lock or link of the tree it reads.
set -euo pipefail
umask 027
MONTH=${1:?month YYYY-MM}; COMMAND=${2:-run}
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
[ "$COMMAND" = run ] || { echo "the command is run (the improver is gone: candidates come from the operator's Claude session)" >&2; exit 2; }
DRY=${RSI_LAB_DRY_RUN:-}
SCRATCH=()
if [ -n "$DRY" ]; then
  trap 'rm -rf "${SCRATCH[@]}"' EXIT
  [ -n "${RSI_LAB_ROOT:-}" ] || { RSI_LAB_ROOT=$(mktemp -d); SCRATCH+=("$RSI_LAB_ROOT"); mkdir -p "$RSI_LAB_ROOT"/{state,inbox,outbox,inbox/skill-$MONTH}; }
  [ -n "${RSI_LAB_ETC:-}" ] || { RSI_LAB_ETC=$(mktemp -d); SCRATCH+=("$RSI_LAB_ETC"); }
  RSI_LAB_OWNER=${RSI_LAB_OWNER:-$(id -u):$(id -g)} RSI_LAB_DOCKER=${RSI_LAB_DOCKER:-dry_docker} RSI_LAB_POLL_SECONDS=0
  exec 3>&2
  dry_docker() { echo "[dry-run] docker $*" >&3; }
fi
ROOT=${RSI_LAB_ROOT:-/srv/rsi-lab} ETC=${RSI_LAB_ETC:-/etc/rsi-lab} DOCKER=${RSI_LAB_DOCKER:-docker} OWNER=${RSI_LAB_OWNER:-10001:10001}
if [ -n "$DRY" ] && [ ! -s "$ETC/image" ]; then IMAGE=dry-run-image; else IMAGE=$(cat "$ETC/image"); fi
STATE=$ROOT/state INBOX=$ROOT/inbox OUTBOX=$ROOT/outbox
NAME=skill-$MONTH RUN=$STATE/skill-$MONTH C=/srv/rsi-lab/state/skill-$MONTH IN=/srv/rsi-lab/inbox/skill-$MONTH
if [ -z "$DRY" ]; then
  mkdir -p "$STATE"
  exec 8> "$STATE/skill.lock"
  flock -n 8 || { echo "another skill campaign holds $STATE/skill.lock; $NAME changed nothing" >&2; exit 75; }
else
  # What a dry run writes goes to a scratch directory removed at exit.
  RUN=$(mktemp -d); SCRATCH+=("$RUN"); OUTBOX=$RUN/outbox
fi
install -d -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0750 "$RUN" "$RUN/run" "$OUTBOX/$NAME"
[ -n "$DRY" ] || ln -sfn "skill-$MONTH" "$STATE/skill-current"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$RUN/launcher.log" >&2; }
done_step() { grep -q "^$1 ok" "$RUN/STATUS" 2>/dev/null; }
mark() { echo "$1 ok $(date -u +%FT%TZ) ${2:-}" >> "$RUN/STATUS"; }
# --init: node as PID 1 ignores SIGTERM, and a stopped run's container would go on working after the lock is released.
# --cpu-shares 256: yields to the products sharing this host whenever it is contended (see rsi-lab-monthly.sh).
lab() {
  local network=$1; shift
  "$DOCKER" run --rm --init --cpu-shares 256 --network "$network" --read-only --tmpfs /tmp:size=256m,noexec,nosuid --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 256 --memory 3g --user "$OWNER" --env-file "$ETC/secrets/lab.env" -e HOME=/tmp \
    -e NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2500 \
    -v "$ETC/owner-inputs":/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$INBOX":/srv/rsi-lab/inbox:ro "$@"
}
sealed() { "$DOCKER" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "$OWNER" "$@"; }
step() { local name=$1; shift; if done_step "$name"; then return 0; fi; log "step $name"; if "$@" > "$RUN/$name.out" 2> "$RUN/$name.err"; then mark "$name"; else log "step $name failed: $(tail -c 400 "$RUN/$name.err")"; return 1; fi; }
verify() { (cd "$INBOX/$NAME" && for f in "$@"; do [ -s "$f" ] && [ -s "$f.sha256" ] && sha256sum -c --status "$f.sha256" || return 1; done); }
KEYS=(-v "$ETC/keys/evaluator.pem":/run/rsi-keys/evaluator.pem:ro)
POLL=${RSI_LAB_POLL_SECONDS:-300}

log "skill campaign $MONTH $COMMAND image $IMAGE"
# No candidate earned a confirmation (the operator writes mode=development-only): recompute the registered development
# choice in the lab image, sign the report, open nothing.
if [ -s "$INBOX/$NAME/mode" ] && grep -qx development-only "$INBOX/$NAME/mode"; then
  verify development.json candidates.json registration.json || { log "development inputs missing or checksum mismatch"; exit 3; }
  SLICE=$(python3 -c 'import json,sys;print(",".join(str(x) for x in json.load(open(sys.argv[1]))["failureCalculators"]))' "$INBOX/$NAME/registration.json")
  step develop lab none "$IMAGE" evals/rsi-campaigns/skill_assemble.mjs --development-only --development "$IN/development.json" --candidates "$IN/candidates.json" \
    --failure-calculators "$SLICE" --month "$MONTH" --out-dir "$C" || exit 6
  lab none "$IMAGE" evals/rsi-campaigns/skill_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  [ -s "$RUN/report.json" ] && sealed "${KEYS[@]}" \
    -v "$STATE":/srv/rsi-lab/state "$IMAGE" evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$RUN/report.signed.json" "$RUN/supply.json" "$RUN/development-only.json" "$OUTBOX/$NAME/" 2>/dev/null || true
  log "report: $(sed -n 3p "$RUN/report.md" 2>/dev/null)"; exit 0
fi
if ! done_step inputs; then
  for _ in $(seq 1 72); do verify development.json confirmation.json candidates.json registration.json && break; sleep "$POLL"; done
  verify development.json confirmation.json candidates.json registration.json || { log "inputs missing"; exit 3; }
  mark inputs
fi
SLICE=$(python3 -c 'import json,sys;print(",".join(str(x) for x in json.load(open(sys.argv[1]))["failureCalculators"]))' "$INBOX/$NAME/registration.json")
step assemble lab none "$IMAGE" evals/rsi-campaigns/skill_assemble.mjs --development "$IN/development.json" --confirmation "$IN/confirmation.json" \
  --candidates "$IN/candidates.json" --failure-calculators "$SLICE" --month "$MONTH" --out-dir "$C" || exit 6
ARGS=(--manifest "$C/manifest.json" --inputs "$C/inputs.json" --config /run/rsi-lab/config.json --out-dir "$C/run")
report() {
  lab none "$IMAGE" evals/rsi-campaigns/skill_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  [ -s "$RUN/report.json" ] && sealed "${KEYS[@]}" \
    -v "$STATE":/srv/rsi-lab/state "$IMAGE" evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$RUN/report.signed.json" "$RUN/supply.json" "$OUTBOX/$NAME/" 2>/dev/null || true
  log "report: $(sed -n 3p "$RUN/report.md" 2>/dev/null)"
}
step run lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs run "${ARGS[@]}" || true
STATUS_RUN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("status",""))' "$RUN/run/run.json" 2>/dev/null || echo "")
if [ "$STATUS_RUN" != "awaiting-evaluation" ] && [ "$STATUS_RUN" != "completed" ]; then report; exit 0; fi
step checkpoint lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs report "${ARGS[@]}" || { report; exit 7; }
step receipt sealed "${KEYS[@]}" -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
  evals/rsi-campaigns/evaluator.mjs receipt "$C/manifest.json" "$C/inputs.json" "$C/run/request.json" "$C/run/report.json" /run/rsi-keys/evaluator.pem "$C/receipt.json" || { report; exit 0; }
step resume lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs resume "${ARGS[@]}" --evaluator-profile /run/rsi-lab/evaluator-profile-skill.json \
  || { log "resume failed: no verdict and no report; start run again once the cause is fixed"; exit 9; }
report
