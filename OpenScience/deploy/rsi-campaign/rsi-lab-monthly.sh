#!/usr/bin/env bash
# The monthly frontier-selection campaign on the RSI lab host (2026-10-26). Run by evimed-rsi-campaign.service on the 1st at
# 02:00 Asia/Shanghai, or by hand: `rsi-lab-monthly.sh [YYYY-MM] [--rehearsal ...assemble window flags]`.
#
# The whole month runs unattended, with no operator in it (owner 2026-11-03: the frontier jury alone stays Qwen 3.8 Max, which the lab calls itself):
#
#   export check -> bootstrap -> plan -> calibrate -> label development -> decide (does development alone find a candidate?)
#   -> (only when one froze) label confirmation -> merge -> build -> run -> receipt -> resume -> statistics -> report (-> evidence -> finalize when qualified)
#
# A month whose development finds no candidate ends at decide: its confirmation month is never labelled, never opened, no alpha is drawn.
# A qualified month publishes its signed bundle (outbox/bundles/<digest>.json) and the report names it; production imports it only where the import layer is installed. A refused evidence or finalize is
# outcome `finalize-refused`, exit 8, and the next start signs the evidence anew; a month measured against no baseline or another consumer is `not-importable`, exit 0, and asks nothing of the signers.
# An export without the incumbent identity (production runs an older export script until its next release) does not stop the month: it is
# measured against an `unbound:` baseline and reported as not importable, and finalize refuses it (campaign_export_incumbent_missing).
#
# The jury is the only step that spends: `calibrate` and `label` mount the lab's one provider credential ($ETC/credentials/dashscope.key, read-only, network
# rsi-lab-net) and go through the lab's budget ledger one batch at a time; every answer is cached, the labelling's in $STATE/jury-cache.jsonl and the calibration's in the month's own
# $RUN/calibration-cache.jsonl (so the jury is measured afresh each month), and a month that stopped is resumed without paying twice. What ends a month, each with a named outcome (`outcome.json`), a report and no build: the key missing
# (campaign_jury_credential_missing), a calibration that does not qualify (campaign_labels_unqualified: it stops the campaign instead of lowering the
# bar), a calibration or a labelling that stopped (the budget's own code, e.g. campaign_budget_exceeded, else campaign_jury_unavailable /
# campaign_labelling_incomplete; exit 5). Start the month again once the cause is gone: finished steps are skipped and the cache serves what was answered.
#
# Resumable: every finished step appends "<step> ok <time>" to $RUN/STATUS and is skipped on the next start, so an interrupted run continues
# where it stopped. One run at a time, months and rehearsals alike: the lock ($STATE/monthly.lock) is taken before anything changes, and a second
# start exits 75 having changed nothing (they share `current`, the evaluator's receipt path). A resume that fails ends the run with exit 9 and no
# report (start again once the cause is fixed); a run directory begun before 2026-11-03 (a plan without idsByRole, or the legacy step `ids`) is
# refused as it is, exit 5 (campaign_run_directory_legacy), nothing in it changed. A rehearsal is named by `--id-prefix rehearsal-[<a-z0-9->-]`, checked
# before it names a path; any other prefix is refused (exit 2). Steps run in the lab image as uid 10001 with a read-only root; the jury and the database
# steps have a network, the evaluator and signer steps have none and are the only ones that see a signing key, and only the jury steps see the provider
# credential. The lab never connects to production: production pushes its export into the write-only inbox and pulls a signed bundle from the read-only outbox/bundles.
#
# RSI_LAB_ROOT (/srv/rsi-lab), RSI_LAB_ETC (/etc/rsi-lab), RSI_LAB_DOCKER (docker), RSI_LAB_OWNER (10001:10001) and RSI_LAB_POLL_SECONDS (300) move the host layout and the docker
# binary: the tests run this script against a stand-in docker. RSI_LAB_DRY_RUN=1 runs it with a docker that only prints the command, which shows the steps up to the
# first one that needs what a real step wrote: it reads the inbox and configuration of the tree it is given (a scratch tree of its own when RSI_LAB_ROOT is
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
JURY_KEY=$ETC/credentials/dashscope.key CACHE=/srv/rsi-lab/state/jury-cache.jsonl CAMPAIGN=${PREFIX}frontier-selection-$MONTH
if [ -z "$DRY" ]; then
  # One run at a time, months and rehearsals alike (the timer, a start by hand, a rehearsal): the lock comes before anything changes.
  mkdir -p "$STATE"
  exec 8> "$STATE/monthly.lock"
  flock -n 8 || { echo "another run holds $STATE/monthly.lock; $KEY changed nothing" >&2; exit 75; }
fi
# A month begun before 2026-11-03 has a signed report that a run of this script would overwrite before it failed: it is refused as it is. What identifies
# it is its plan, which lists no phases (no idsByRole), and the step `ids` only its script had; not `calibrate`, which is a step of this script too.
if grep -q '^ids ok' "$RUN/STATUS" 2>/dev/null || { [ -s "$RUN/plan.json" ] && ! grep -q '"idsByRole"' "$RUN/plan.json"; }; then
  echo "campaign_run_directory_legacy: $RUN was begun before 2026-11-03 (a plan without idsByRole, or the step ids); nothing in it was changed" >&2; exit 5
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
# One containerised step. --network is the caller's; nothing else is shared with the host. --cpu-shares 256 yields to the products sharing this host whenever it is
# contended (a 4-vCPU economy instance, 2026-11-03: a plan at the evening peak took the top of the host for over 30 minutes and rxai-delivery's health checks timed
# out); it limits nothing on an idle host. --init because node as PID 1 ignores SIGTERM: a stopped month's container would go on
# calling the provider after the lock is released.
lab() {
  local network=$1; shift
  "$DOCKER" run --rm --init --cpu-shares 256 --network "$network" --read-only --tmpfs /tmp:size=256m,noexec,nosuid --cap-drop ALL --security-opt no-new-privileges \
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
# The carrier: a signed bundle goes under the name of its own bytes into the one directory production's pull reads (forced `rrsync -ro`), whole or not at all
# (a hidden name, then a rename), never over a bundle already there, so a restarted month changes nothing. Only the bundle is world-readable: a month's directory stays the lab's.
publish_bundle() {
  [ -s "$RUN/bundle.json" ] || return 0
  local name dir=$OUTBOX/bundles
  name=$(sha256sum "$RUN/bundle.json" | cut -d' ' -f1).json
  install -d -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0755 "$dir"
  if [ ! -e "$dir/$name" ]; then
    install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0644 "$RUN/bundle.json" "$dir/.$name.tmp"
    mv -f "$dir/.$name.tmp" "$dir/$name"
  fi
  log "bundle published: outbox/bundles/$name"
}

# A step that calls the jury: the only steps that mount the provider credential. The key is checked first (docker would create a directory at a missing bind-mount source),
# and a step that did not finish ends the month with a named reason: the stop its output file records when it is a campaign code (the budget's), else the code the
# command named on its error output, else the step's own. A step that wrote to its error output crashed, and the output file it left is an earlier start's.
JURY=(-v "$JURY_KEY":/run/rsi-credentials/dashscope.key:ro)
jury_step() {
  local name=$1 fallback=$2 out=$3 cache=$4 reason=""; shift 4
  done_step "$name" && return 0
  if [ -z "$DRY" ] && ! { [ -r "$JURY_KEY" ] && grep -q '[^[:space:]]' "$JURY_KEY"; }; then
    log "the jury's key $JURY_KEY is missing or empty"; outcome not-run campaign_jury_credential_missing; finish 5
  fi
  step "$name" lab rsi-lab-net "${JURY[@]}" "$IMAGE" evals/rsi-campaigns/frontier_labels.mjs "$@" --credential /run/rsi-credentials/dashscope.key --cache "$cache" --campaign "$CAMPAIGN" --config /run/rsi-lab/config.json \
    --out "$C/$out" && return 0
  [ -s "$RUN/$name.err" ] || reason=$(jsonfield "$RUN/$out" stopped)
  [[ $reason == campaign_* ]] || reason=$(reason_of "$name")
  [[ $reason == campaign_* ]] || reason=$fallback
  log "the jury's work stopped ($reason): the answers are cached; start the month again to continue"; outcome not-run "$reason"; finish 5
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

# 2. The jury is calibrated on the human anchor every month (about ¥5, from a cache of the month's own: a resume pays nothing twice, the next month asks the provider again, so a moved model
# alias shows here), and a calibration that does not qualify ends the campaign before a single item of the month is labelled.
jury_step calibrate campaign_jury_unavailable calibration.json "$C/calibration-cache.jsonl" calibrate --gold evals/frontier-selection/gold.jsonl
if [ -z "$DRY" ] && ! python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("qualification",{}).get("qualified") is True else 1)' "$RUN/calibration.json" 2>/dev/null; then
  python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
json.dump({"status":"not-run","reason":"campaign_labels_unqualified","calibration":{"qualification":d.get("qualification"),"metrics":d.get("calibration")}},open(sys.argv[2],"w"),indent=1)' "$RUN/calibration.json" "$RUN/refusal.json"
  chown "$OWNER" "$RUN/refusal.json"; outcome not-run campaign_labels_unqualified; finish 0
fi

# 3. Development: its rows are labelled, then the registered choice is made from development alone.
jury_step label-development campaign_labelling_incomplete labels-development.json "$CACHE" label --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --phase development
# A dry run writes none of what the next steps read: it ends with the commands it has shown.
[ -z "$DRY" ] || { log "[dry-run] the steps from decide on read files that only a real run writes: stop"; exit 0; }
step decide lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs decide --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --labels "$C/labels-development.json" \
  --calibration "$C/calibration.json" --out "$C/decision.json" \
  || { REASON=$(reason_of decide); outcome not-run "${REASON:-campaign_decide_failed}"; log "development labels refused: ${REASON:-unknown}"; finish 6; }
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

# 4. Confirmation: only now are its rows labelled; the two phases are joined into the one labels file the build reads.
jury_step label-confirmation campaign_labelling_incomplete labels-confirmation.json "$CACHE" label --export "/srv/rsi-lab/inbox/$EXPORT" --plan "$C/plan.json" --phase confirmation
step merge lab none "$IMAGE" evals/rsi-campaigns/frontier_assemble.mjs merge-labels --plan "$C/plan.json" --labels "$C/labels-development.json" --labels "$C/labels-confirmation.json" --out "$C/labels.json" \
  || { REASON=$(reason_of merge); outcome not-run "${REASON:-campaign_merge_failed}"; log "the phases' labels were refused: ${REASON:-unknown}"; finish 6; }
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
  # Measured against no baseline production serves, or another consumer: the month has its verdict and no bundle of it could be imported, so nothing is asked of the signers.
  BASELINE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["target"]["baselineRevision"])' "$RUN/manifest.json" 2>/dev/null || true)
  case $BASELINE in
    unbound-consumer:*) outcome not-importable campaign_export_consumer_changed; finish 0 ;;
    unbound:*) outcome not-importable campaign_export_incumbent_missing; finish 0 ;;
  esac
  FAILED=""
  step evidence lab rsi-lab-net "${KEYS[@]}" "$IMAGE" evals/rsi-campaigns/evaluator.mjs evidence "$C/manifest.json" "$C/inputs.json" "$C/run/resume.json" \
    /run/rsi-lab/statistics-qualification.json /run/rsi-keys/evaluator.pem "$C/finalize-input.json" || { FAILED=evidence; log "evidence refused: $(tail -c 300 "$RUN/evidence.err")"; }
  if [ -z "$FAILED" ]; then
    step finalize "$DOCKER" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "$OWNER" \
      -v "$ETC/keys":/run/rsi-keys:ro -v "$ETC/owner-inputs":/run/rsi-lab:ro -v "$STATE":/srv/rsi-lab/state -v "$OUTBOX":/srv/rsi-lab/outbox "$IMAGE" \
      evals/rsi-campaigns/finalize.mjs /run/rsi-lab/finalize.json || { FAILED=finalize; log "finalize refused: $(tail -c 300 "$RUN/finalize.err")"; }
  fi
  if [ -n "$FAILED" ] || [ ! -s "$RUN/bundle.json" ]; then
    # A qualified month that published nothing is no success: an outcome of its own, the report says it, the unit fails. The evidence is signed for a week and is not left marked done, or a later
    # start would find it expired and refuse for ever: the next start signs it anew and finalizes again.
    REASON=$(reason_of "${FAILED:-finalize}")
    sed -i '/^evidence ok/d;/^finalize ok/d' "$RUN/STATUS"
    outcome finalize-refused "${REASON:-campaign_finalization_failed}"; finish 8
  fi
  cp -f "$RUN/bundle.json" "$OUTBOX/$KEY/bundle.json"
  publish_bundle
fi
outcome "${VERDICT:-not-qualified}" "$(jsonfield "$RUN/run/resume.json" reason)"
finish 0
