#!/usr/bin/env bash
# The monthly frontier-selection campaign on the RSI lab host (2026-10-26). Run by evimed-rsi-campaign.service on the 1st at
# 02:00 Asia/Shanghai, or by hand: `rsi-lab-monthly.sh [YYYY-MM] [--rehearsal ...assemble window flags]`.
#
# The lab never labels (owner 2026-11-03: every adjudicator is Claude, and the lab has no Anthropic access). The unattended run does the
# deterministic steps and stops at a named wait, exit 0:
#
#   export check -> bootstrap -> plan -> label-items (development) -> "wait labels-development"
#
# The operator's box (deploy/rsi-campaign/operator/rsi-frontier-label.sh) fetches $OUTBOX/<month>/label-items-<phase>.json (with its sha256),
# calibrates and labels it with Claude, uploads calibration.json and labels-<phase>.json with their sha256 into
# $INBOX/frontier-labels-<month>/ and starts this script again. It verifies the digests and goes on:
#
#   decide (does development alone find a candidate?) -> label-items (confirmation) -> "wait labels-confirmation" -> merge -> build
#   -> run -> receipt -> statistics -> report (-> evidence -> finalize when qualified)
#
# A month whose development finds no candidate ends at decide: its confirmation month is never labelled, never opened, no alpha is drawn.
# An export without the incumbent identity (production runs an older export script until its next release) does not stop the month: it is
# measured against an `unbound:` baseline and reported as not importable, and finalize refuses it (campaign_export_incumbent_missing).
#
# Resumable: every finished step appends "<step> ok <time>" to $RUN/STATUS and is skipped on the next start, so an interrupted run continues
# where it stopped; a wait is "wait <name> <time> <month>" (the last line says what the run is waiting for). One run at a time, months and
# rehearsals alike: the lock ($STATE/monthly.lock) is taken before anything changes, and a second start exits 75 having changed nothing (they share
# `current`, the evaluator's receipt path). A resume that fails ends the run with exit 9 and no report (start again once the cause is fixed); a run
# directory begun before 2026-11-03 (steps ids, calibrate, label; a plan without idsByRole) is refused as it is, exit 5
# (campaign_run_directory_legacy), nothing in it changed. A rehearsal is named by `--id-prefix rehearsal-[<a-z0-9->-]`, checked before it names a
# path; any other prefix is refused (exit 2). Steps run in the lab image as uid
# 10001 with a read-only root; only the database steps have a network, the evaluator and signer steps have none and are the only ones that
# see a key, and no step has a provider credential. The lab never connects to production: production pushes its export into the write-only inbox.
#
# RSI_LAB_ROOT (/srv/rsi-lab), RSI_LAB_ETC (/etc/rsi-lab), RSI_LAB_DOCKER (docker), RSI_LAB_OWNER (10001:10001) and RSI_LAB_POLL_SECONDS (300)
# move the host layout and the docker binary: the tests run this script against a stand-in docker. RSI_LAB_DRY_RUN=1 runs it with a docker that
# only prints the command, which shows the steps up to the first wait: it reads the inbox and configuration of the tree it is given (a scratch tree of its own when RSI_LAB_ROOT is
# unset) and writes only into scratch directories it removes at exit — no STATUS, outcome, log, report, lock or link of the tree it reads.
set -euo pipefail
umask 027
MONTH=${1:-$(TZ=Asia/Shanghai date +%Y-%m)}
shift || true
ASSEMBLE_EXTRA=("$@")
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
# The rehearsal's name is its --id-prefix (the plan's own argument), checked before it names any path.
PREFIX="" PREV=""
for arg in "${ASSEMBLE_EXTRA[@]}"; do
  case $arg in --id-prefix=*) PREFIX=${arg#--id-prefix=} ;; esac
  [ "$PREV" != --id-prefix ] || PREFIX=$arg
  PREV=$arg
done
[[ -z $PREFIX || $PREFIX =~ ^rehearsal-([a-z0-9][a-z0-9-]{0,20}-)?$ ]] || { echo "the id prefix is a rehearsal's: rehearsal- or rehearsal-<a-z0-9->-" >&2; exit 2; }
DRY=${RSI_LAB_DRY_RUN:-}
SCRATCH=()
if [ -n "$DRY" ]; then
  trap 'rm -rf "${SCRATCH[@]}"' EXIT
  if [ -z "${RSI_LAB_ROOT:-}" ]; then
    RSI_LAB_ROOT=$(mktemp -d); SCRATCH+=("$RSI_LAB_ROOT"); mkdir -p "$RSI_LAB_ROOT"/{state,inbox,outbox}
    echo dry-run > "$RSI_LAB_ROOT/inbox/frontier-$MONTH.json.gz"; (cd "$RSI_LAB_ROOT/inbox" && sha256sum "frontier-$MONTH.json.gz" > "frontier-$MONTH.json.gz.sha256")
  fi
  [ -n "${RSI_LAB_ETC:-}" ] || { RSI_LAB_ETC=$(mktemp -d); SCRATCH+=("$RSI_LAB_ETC"); }
  RSI_LAB_OWNER=${RSI_LAB_OWNER:-$(id -u):$(id -g)} RSI_LAB_DOCKER=${RSI_LAB_DOCKER:-dry_docker} RSI_LAB_POLL_SECONDS=0
  exec 3>&2
  dry_docker() { echo "[dry-run] docker $*" >&3; }
fi
ROOT=${RSI_LAB_ROOT:-/srv/rsi-lab} ETC=${RSI_LAB_ETC:-/etc/rsi-lab} DOCKER=${RSI_LAB_DOCKER:-docker} OWNER=${RSI_LAB_OWNER:-10001:10001}
if [ -n "$DRY" ] && [ ! -s "$ETC/image" ]; then IMAGE=dry-run-image; else IMAGE=$(cat "$ETC/image"); fi
STATE=$ROOT/state INBOX=$ROOT/inbox OUTBOX=$ROOT/outbox
KEY=${PREFIX}$MONTH
RUN=$STATE/$KEY C=/srv/rsi-lab/state/$KEY
LABELS=$INBOX/frontier-labels-$KEY LABELS_IN=/srv/rsi-lab/inbox/frontier-labels-$KEY
if [ -z "$DRY" ]; then
  # One run at a time, months and rehearsals alike (the timer, the operator's restart, a rehearsal): the lock comes before anything changes.
  mkdir -p "$STATE"
  exec 8> "$STATE/monthly.lock"
  flock -n 8 || { echo "another run holds $STATE/monthly.lock; $KEY changed nothing" >&2; exit 75; }
fi
# A month begun before 2026-11-03, when the lab labelled (steps ids, calibrate, label; a plan without idsByRole), has a signed report a run of this
# script would overwrite before failing at the items step: it is refused as it is.
if grep -qE '^(ids|calibrate|label) ok' "$RUN/STATUS" 2>/dev/null || { [ -s "$RUN/plan.json" ] && ! grep -q '"idsByRole"' "$RUN/plan.json"; }; then
  echo "campaign_run_directory_legacy: $RUN was begun before 2026-11-03 (steps ids, calibrate, label; a plan without idsByRole); nothing in it was changed" >&2; exit 5
fi
if [ -n "$DRY" ]; then
  # What a dry run writes goes to a scratch directory removed at exit; it reads nothing of the run's own state.
  RUN=$(mktemp -d); SCRATCH+=("$RUN"); OUTBOX=$RUN/outbox
fi
install -d -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0750 "$RUN" "$RUN/run" "$OUTBOX/$KEY"
[ -n "$DRY" ] || ln -sfn "$KEY" "$STATE/current"
EXPORT=frontier-$MONTH.json.gz
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$RUN/launcher.log" >&2; }
done_step() { grep -q "^$1 ok" "$RUN/STATUS" 2>/dev/null; }
mark() { echo "$1 ok $(date -u +%FT%TZ) ${2:-}" >> "$RUN/STATUS"; }
outcome() { printf '{"outcome":"%s","reason":"%s"}\n' "$1" "$2" > "$RUN/outcome.json"; chown "$OWNER" "$RUN/outcome.json"; }
jsonfield() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get(sys.argv[2]) or "")' "$1" "$2" 2>/dev/null || true; }
# One containerised step. --network is the caller's; nothing else is shared with the host.
lab() {
  local network=$1; shift
  "$DOCKER" run --rm --network "$network" --read-only --tmpfs /tmp:size=256m,noexec,nosuid --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 256 --memory 3g --user "$OWNER" --env-file "$ETC/secrets/lab.env" -e HOME=/tmp \
    -e NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2500 \
    -v "$ETC/owner-inputs":/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$INBOX":/srv/rsi-lab/inbox:ro "$@"
}
finish() { lab none -v "$OUTBOX":/srv/rsi-lab/outbox "$IMAGE" evals/rsi-campaigns/monthly_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  sign_report; exit "${1:-0}"; }
sign_report() {
  [ -s "$RUN/report.json" ] || return 0
  "$DOCKER" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "$OWNER" \
    -v "$ETC/keys/evaluator.pem":/run/rsi-keys/evaluator.pem:ro -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
    evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$OUTBOX/$KEY/" 2>/dev/null || true
  cp -f "$RUN/report.signed.json" "$OUTBOX/$KEY/" 2>/dev/null || true
  log "report: $(head -3 "$RUN/report.md" | tail -1)"
}
step() { local name=$1; shift; if done_step "$name"; then return 0; fi; log "step $name"; if "$@" > "$RUN/$name.out" 2> "$RUN/$name.err"; then mark "$name"; else log "step $name failed: $(tail -c 400 "$RUN/$name.err")"; return 1; fi; }
reason_of() { grep -o 'campaign_[a-z_]*' "$RUN/$1.err" 2>/dev/null | head -1 || true; }

# A named wait: nothing more can happen until the operator supplies the labels of a phase. STATUS says so once; the run ends with exit 0 and no report.
wait_labels() {
  grep -q "^wait labels-$1 .* $KEY\$" "$RUN/STATUS" 2>/dev/null || echo "wait labels-$1 $(date -u +%FT%TZ) $KEY" >> "$RUN/STATUS"
  outcome waiting "labels-$1"
  log "wait labels-$1: fetch $OUTBOX/$KEY/label-items-$1.json, label it on the operator's box and upload the labels to $LABELS/ (deploy/rsi-campaign/operator/rsi-frontier-label.sh $MONTH)"
  exit 0
}
# The label-items of a phase: written by the lab image from the export and the plan, published to the outbox with its sha256 (idempotent).
publish_items() {
  [ -z "${RSI_LAB_DRY_RUN:-}" ] || { log "[dry-run] would publish label-items-$1.json (+ sha256) to $OUTBOX/$KEY"; return 0; }
  step "items-$1" lab none "$IMAGE" evals/rsi-campaigns/frontier_labels.mjs items --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --phase "$1" --out "$C/label-items-$1.json" \
    || { outcome not-run campaign_label_items_failed; finish 4; }
  cp -f "$RUN/label-items-$1.json" "$OUTBOX/$KEY/label-items-$1.json"
  (cd "$OUTBOX/$KEY" && sha256sum "label-items-$1.json" > "label-items-$1.json.sha256")
}
# ready | missing (the operator has not finished uploading: the data first, the digest last) | bad (the digest does not match the bytes)
labels_state() {
  local f
  for f in "$@"; do [ -s "$LABELS/$f" ] && [ -s "$LABELS/$f.sha256" ] || { echo missing; return; }; done
  (cd "$LABELS" && for f in "$@"; do sha256sum -c --status "$f.sha256" || exit 1; done) && echo ready || echo bad
}
# Verified files are copied into the run's own directory and the copies are what the steps read.
adopt_labels() {
  local f
  for f in "$@"; do cp -f "$LABELS/$f" "$RUN/$f"; chown "$OWNER" "$RUN/$f"; done
}
# The labels of a phase (and the calibration, with the first): wait for them, refuse bytes that do not match their digest.
require_labels() {
  local phase=$1; shift
  case "$(labels_state "$@")" in
    ready) adopt_labels "$@" ;;
    bad) outcome waiting labels-checksum; log "labels checksum mismatch in $LABELS: upload again"; exit 3 ;;
    *) wait_labels "$phase" ;;
  esac
}

log "campaign $KEY image $IMAGE"
# 1. The export production pushed (00:30); wait up to six hours for it.
if ! done_step export; then
  for _ in $(seq 1 72); do [ -s "$INBOX/$EXPORT" ] && [ -s "$INBOX/$EXPORT.sha256" ] && break; sleep "${RSI_LAB_POLL_SECONDS:-300}"; done
  [ -s "$INBOX/$EXPORT" ] || { log "export missing"; outcome not-run campaign_export_missing; finish 3; }
  (cd "$INBOX" && sha256sum -c --status "$EXPORT.sha256") || { log "export checksum mismatch"; outcome not-run campaign_export_checksum; finish 3; }
  mark export "$(cut -c1-16 "$INBOX/$EXPORT.sha256")"
fi
step bootstrap lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/lab_bootstrap.mjs /run/rsi-lab/config.json || { outcome not-run campaign_lab_unavailable; finish 4; }
step plan lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs plan --export "/srv/rsi-lab/inbox/$EXPORT" --month "$MONTH" --out "$C/plan.json" "${ASSEMBLE_EXTRA[@]}" \
  || { REASON=$(reason_of plan); outcome not-run "${REASON:-campaign_plan_failed}"; finish 4; }

# 2. Development: label-items out, labels in, then the registered choice from development alone.
publish_items development
if ! done_step decide; then
  # A calibration that does not qualify ends the campaign (the operator uploads it alone, without spending a label on a month that will not run).
  if [ "$(labels_state calibration.json)" = ready ]; then
    adopt_labels calibration.json
    if ! python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("qualification",{}).get("qualified") is True else 1)' "$RUN/calibration.json" 2>/dev/null; then
      python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));json.dump({"status":"not-run","reason":"campaign_labels_unqualified","calibration":{"qualification":d.get("qualification"),"metrics":d.get("calibration")}},open(sys.argv[2],"w"),indent=1)' "$RUN/calibration.json" "$RUN/refusal.json"
      chown "$OWNER" "$RUN/refusal.json"; outcome not-run campaign_labels_unqualified; finish 0
    fi
  fi
  require_labels development calibration.json labels-development.json
  step decide lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs decide --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --labels "$C/labels-development.json" \
    --calibration "$C/calibration.json" --out "$C/decision.json" \
    || { outcome waiting "$(reason_of decide || true)"; log "development labels refused: $(reason_of decide) — upload corrected labels and start again"; exit 3; }
fi
DECISION=$(jsonfield "$RUN/decision.json" status)
if [ "$DECISION" != confirmation-needed ]; then
  # The month ends here: a calibration that does not qualify, a jury that is not admitted, or no candidate from development. Confirmation was never labelled or opened.
  # Only a development that ran has a supply to report; a refusal is kept apart (refusal.json) so that supply.json is always a supply (the report also reads one that is not as none).
  cp -f "$RUN/labels-development.json" "$RUN/labels.json" 2>/dev/null || true
  if [ "$DECISION" = development-ended ]; then
    python3 -c 'import json,sys;json.dump(json.load(open(sys.argv[1])).get("supply"),open(sys.argv[2],"w"),indent=1)' "$RUN/decision.json" "$RUN/supply.json"
    outcome not-qualified "$(jsonfield "$RUN/decision.json" reason)"
  else
    cp -f "$RUN/decision.json" "$RUN/refusal.json"; outcome not-run "$(jsonfield "$RUN/decision.json" reason)"
  fi
  chown "$OWNER" "$RUN/supply.json" "$RUN/refusal.json" "$RUN/labels.json" 2>/dev/null || true
  finish 0
fi

# 3. Confirmation: only now are its rows labelled.
publish_items confirmation
if ! done_step merge; then
  require_labels confirmation labels-confirmation.json
  step merge lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs merge-labels --plan "$C/plan.json" --labels "$C/labels-development.json" --labels "$C/labels-confirmation.json" --out "$C/labels.json" \
    || { outcome waiting "$(reason_of merge || true)"; log "confirmation labels refused: $(reason_of merge) — upload corrected labels and start again"; exit 3; }
fi
step build lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs build --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --labels "$C/labels.json" \
  --calibration "$C/calibration.json" --out-dir "$C" || { outcome not-run campaign_assembly_failed; finish 6; }
[ -s "$RUN/manifest.json" ] || { REASON=$(jsonfield "$RUN/supply.json" reason); mv -f "$RUN/supply.json" "$RUN/refusal.json" 2>/dev/null || true; outcome not-run "${REASON:-campaign_not_assembled}"; finish 0; }
ARGS=(--manifest "$C/manifest.json" --inputs "$C/inputs.json" --config /run/rsi-lab/config.json --out-dir "$C/run")
step run lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs run "${ARGS[@]}" || true
STATUS_RUN=$(jsonfield "$RUN/run/run.json" status)
if [ "$STATUS_RUN" != "awaiting-evaluation" ] && [ "$STATUS_RUN" != "completed" ]; then outcome not-qualified "$(jsonfield "$RUN/run/run.json" reason)"; finish 0; fi
step checkpoint lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs report "${ARGS[@]}" || { outcome not-run campaign_checkpoint_unreadable; finish 7; }
KEYS=(-v "$ETC/keys/evaluator.pem":/run/rsi-keys/evaluator.pem:ro)
step receipt "$DOCKER" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "$OWNER" "${KEYS[@]}" -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
  evals/rsi-campaigns/evaluator.mjs receipt "$C/manifest.json" "$C/inputs.json" "$C/run/request.json" "$C/run/report.json" /run/rsi-keys/evaluator.pem "$C/receipt.json" \
  || { outcome not-qualified "$(reason_of receipt || true)"; finish 0; }
# A resume that fails gave no verdict: the run ends here, exit 9, and no report says otherwise (start again once the cause is fixed).
step resume lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs resume "${ARGS[@]}" --evaluator-profile /run/rsi-lab/evaluator-profile.json \
  || { log "resume failed ($(jsonfield "$RUN/run/resume.json" reason)): no verdict and no report; start the month again once the cause is fixed"; exit 9; }
VERDICT=$(jsonfield "$RUN/run/resume.json" qualification)
[ -n "$VERDICT" ] || VERDICT=$(jsonfield "$RUN/run/resume.json" status)
log "verdict: ${VERDICT:-unknown}"
if [ "$VERDICT" = "qualified" ] && [ -z "$PREFIX" ]; then
  step evidence lab rsi-lab-net "${KEYS[@]}" "$IMAGE" evals/rsi-campaigns/evaluator.mjs evidence "$C/manifest.json" "$C/inputs.json" "$C/run/resume.json" \
    /run/rsi-lab/statistics-qualification.json /run/rsi-keys/evaluator.pem "$C/evidence.json" || log "evidence refused"
  if done_step evidence; then
    python3 - "$RUN" "$OWNER" <<'PY'
import json, sys, os
run, owner = sys.argv[1], sys.argv[2]
resume = json.load(open(f'{run}/run/resume.json')); evidence = json.load(open(f'{run}/evidence.json'))
json.dump({'completed': resume, 'manifest': json.load(open(f'{run}/manifest.json')), 'inputs': json.load(open(f'{run}/inputs.json')),
           'files': evidence['files'], 'evidenceEnvelope': evidence['evidenceEnvelope'], 'bundleId': f"{resume['checkpoint']['campaignId']}-bundle",
           'expiresAt': evidence['evidenceEnvelope']['payload']['expiresAt']}, open(f'{run}/finalize-input.json', 'w'))
uid, gid = owner.split(':')
os.chown(f'{run}/finalize-input.json', int(uid), int(gid))
PY
    step finalize "$DOCKER" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "$OWNER" \
      -v "$ETC/keys":/run/rsi-keys:ro -v "$ETC/owner-inputs":/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$OUTBOX":/srv/rsi-lab/outbox "$IMAGE" \
      evals/rsi-campaigns/finalize.mjs /run/rsi-lab/finalize.json || log "finalize refused: $(tail -c 300 "$RUN/finalize.err")"
    [ -s "$RUN/bundle.json" ] && cp -f "$RUN/bundle.json" "$OUTBOX/$KEY/bundle.json"
  fi
fi
outcome "${VERDICT:-not-qualified}" "$(jsonfield "$RUN/run/resume.json" reason)"
finish 0
