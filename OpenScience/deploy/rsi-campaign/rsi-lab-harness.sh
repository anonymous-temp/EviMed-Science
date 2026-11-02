#!/usr/bin/env bash
# The harness-patch campaign on the RSI lab host (2026-11-01), one family at a time: a patched runtime image (a guidance
# supplement and a few skills) measured on benchmark runs that happened on a lane stack — baseline on the unmodified image, each
# candidate on a delta image, an A/A control on the unmodified image again. The operator copies the exported runs and the
# pre-registration into the lab inbox under harness-<family>-<month>/; the lab never connects to the lane or to production. The
# candidates are written outside the lab (the invariant editor, composer and selector are Claude on the dev box), so the lab has
# no improver step: it recomputes, opens, evaluates and signs. Two commands, both resumable through $RUN/STATUS:
#
#   rsi-lab-harness.sh <YYYY-MM> <family> develop   the development gate alone: recompute the registered choice (A/A noise floor
#                                                    included) from development.json, sign the report, open nothing
#   rsi-lab-harness.sh <YYYY-MM> <family> run       assemble -> run -> evaluator receipt -> statistics -> signed report; waits up
#                                                    to six hours for the inbox files below
#   rsi-lab-harness.sh <YYYY-MM> <family> close     a campaign whose receipt the evaluator refused with campaign_cost_measurement_missing
#                                                    (runs without a settled cost): the signed closure of evals/rsi-campaigns/harness_closure.mjs,
#                                                    then the signed report. It reads cost-closure.json (below), recomputes the campaign's scores
#                                                    and the registered statistics with those costs, signs a record that states the deviation and
#                                                    touches neither the error-budget ledger nor the corpus record. It runs in the image the
#                                                    campaign ran in (the registered consumer identity pins that image's scoring code), with
#                                                    harness_closure.mjs taken from the current image.
#
# Inbox harness-<family>-<month>/ (every file with its .sha256 in `sha256sum -c` format, checked here and again by the assembler):
#   registration.json                the pre-registration (register_round.py): rows, scorer, failure slice, margin, K, alpha, control, judge
#   development.json                 a harness-arms source, role development (gold in its rows; the verdict records apart for a judged family)
#   confirmation.json                a harness-arms source, role confirmation, SEALED: answers and costs, no gold, no scores
#   confirmation.gold.json           the gold of the sealed rows (deterministic scorers); joined only by the assembly, below
#   development.verdicts.jsonl       the judge's verdict records of the development runs (judged-verdicts)
#   confirmation.verdicts.jsonl      the judge's verdict records of the confirmation runs (judged-verdicts)
#   improvement.json                 optional: who wrote the candidates (provenance, recorded in the registration the campaign digests)
#   cost-closure.json                `close` only: the usage ledger's record of each run without a settled cost (make_cost_closure.py)
# Only development data is read by `develop`. The confirmation files are read by the assembly of `run`, which joins the gold and the
# records the export kept apart and builds the manifest; nothing scores them before the runner has frozen the policy and reserved the
# quarter's error budget and the corpus.
set -euo pipefail
umask 027
MONTH=$1; FAMILY=$2; COMMAND=$3
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
[[ $FAMILY =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "family must be lower-case letters, digits and hyphens" >&2; exit 2; }
[ "$COMMAND" = develop ] || [ "$COMMAND" = run ] || [ "$COMMAND" = close ] || { echo "command is develop, run or close" >&2; exit 2; }
IMAGE=$(cat /etc/rsi-lab/image)
STATE=/srv/rsi-lab/state INBOX=/srv/rsi-lab/inbox OUTBOX=/srv/rsi-lab/outbox
NAME=harness-$FAMILY-$MONTH RUN=$STATE/harness-$FAMILY-$MONTH C=/srv/rsi-lab/state/harness-$FAMILY-$MONTH IN=/srv/rsi-lab/inbox/harness-$FAMILY-$MONTH
install -d -o 10001 -g 10001 -m 0750 "$RUN" "$RUN/run" "$OUTBOX/$NAME"
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
jsonfield() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get(sys.argv[2],""))' "$1" "$2" 2>/dev/null || true; }

# The files this family needs depend on its scorer, which the pre-registration names.
needs() {
  if [ "$1" = close ]; then printf '%s\n' cost-closure.json; return 0; fi
  local scorer; scorer=$(jsonfield "$INBOX/$NAME/registration.json" scorer)
  local files=(registration.json development.json)
  [ -s "$INBOX/$NAME/improvement.json" ] && files+=(improvement.json)
  [ "$scorer" = judged-verdicts ] && files+=(development.verdicts.jsonl)
  if [ "$1" = run ]; then
    files+=(confirmation.json)
    if [ "$scorer" = judged-verdicts ]; then files+=(confirmation.verdicts.jsonl); else files+=(confirmation.gold.json); fi
  fi
  printf '%s\n' "${files[@]}"
}
await_inputs() {
  for _ in $(seq 1 72); do
    [ -s "$INBOX/$NAME/registration.json" ] && mapfile -t FILES < <(needs "$1") && verify "${FILES[@]}" && return 0
    [ "$1" = close ] && break
    sleep 300
  done
  [ -s "$INBOX/$NAME/registration.json" ] && mapfile -t FILES < <(needs "$1") && verify "${FILES[@]}"
}
# Signed report, whatever the verdict: report.md/report.json from the campaign directory, then the evaluator's signature over report.json.
report() {
  lab none "$IMAGE" evals/rsi-campaigns/harness_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  [ -s "$RUN/report.json" ] && docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 "${KEYS[@]}" \
    -v "$STATE":/srv/rsi-lab/state "$IMAGE" evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$RUN/report.signed.json" "$RUN/supply.json" "$RUN/development-only.json" "$RUN/closure.signed.json" "$IN/cost-closure.json" "$OUTBOX/$NAME/" 2>/dev/null || true
  log "report: $(sed -n 3p "$RUN/report.md" 2>/dev/null)"
}
verdict_args() {
  local scorer; scorer=$(jsonfield "$INBOX/$NAME/registration.json" scorer)
  [ "$scorer" = judged-verdicts ] || return 0
  printf '%s\n' --development-verdicts "$IN/development.verdicts.jsonl"
  [ "$1" = run ] && printf '%s\n' --confirmation-verdicts "$IN/confirmation.verdicts.jsonl"
  return 0
}

log "harness campaign $FAMILY $MONTH $COMMAND image $IMAGE"

# The signed closure of a campaign whose receipt was refused for costs: only after the run reached its checkpoint, only while there is no
# receipt, no statistics and no verdict, and only with the cost records the inbox holds (checked against the campaign's own sources).
if [ "$COMMAND" = close ]; then
  done_step checkpoint && ! done_step receipt && ! done_step resume || { log "close needs a campaign that reached its checkpoint and has neither a receipt nor a verdict"; exit 3; }
  [ -s "$RUN/run/report.json" ] || { log "close needs $RUN/run/report.json (the checkpoint)"; exit 3; }
  if ! done_step closure-inputs; then
    await_inputs close || { log "cost-closure.json missing or checksum mismatch"; exit 3; }
    mark closure-inputs
  fi
  # The image the campaign ran in: its files are what the registered consumer identity digests.
  RAN_IN=$(sed -n 's/.* harness campaign .* run image \(.*\)$/\1/p' "$RUN/launcher.log" | tail -1)
  [ -n "$RAN_IN" ] && docker image inspect "$RAN_IN" >/dev/null 2>&1 || { log "the image the campaign ran in ($RAN_IN) is no longer on this host"; exit 3; }
  CLOSURE_JS=/opt/evimed/OpenScience/evals/rsi-campaigns/harness_closure.mjs MOUNT=()
  if [ "$RAN_IN" != "$IMAGE" ]; then
    docker run --rm --network none --read-only --user 10001:10001 --entrypoint cat "$IMAGE" "$CLOSURE_JS" > "$RUN/harness_closure.mjs" || { log "harness_closure.mjs is not in $IMAGE"; exit 3; }
    chown 10001:10001 "$RUN/harness_closure.mjs" # written by root under umask 027; the closure runs as the lab user
    MOUNT=(-v "$RUN/harness_closure.mjs:$CLOSURE_JS:ro")
  fi
  log "closure runs in $RAN_IN (current image $IMAGE)"
  step closure docker run --rm --network none --read-only --tmpfs /tmp:size=64m,noexec,nosuid --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 3g --user 10001:10001 "${KEYS[@]}" "${MOUNT[@]}" \
    -v "$STATE":/srv/rsi-lab/state -v "$INBOX":/srv/rsi-lab/inbox:ro "$RAN_IN" \
    evals/rsi-campaigns/harness_closure.mjs "$C/manifest.json" "$C/inputs.json" "$C/run/report.json" "$IN/cost-closure.json" /run/rsi-keys/evaluator.pem "$C/closure.signed.json" || { report; exit 8; }
  report; exit 0
fi

if ! done_step inputs; then
  await_inputs "$COMMAND" || { log "inputs missing or checksum mismatch"; exit 3; }
  mark inputs
fi
mapfile -t VERDICTS < <(verdict_args "$COMMAND")
[ -s "$INBOX/$NAME/improvement.json" ] && VERDICTS+=(--improvement "$IN/improvement.json")

# The development gate alone: the registered choice recomputed in the lab image from development data, nothing opened.
if [ "$COMMAND" = develop ]; then
  step develop lab none "$IMAGE" evals/rsi-campaigns/harness_assemble.mjs --development-only --development "$IN/development.json" "${VERDICTS[@]}" \
    --registration "$IN/registration.json" --month "$MONTH" --out-dir "$C" || { report; exit 6; }
  report; exit 0
fi

step bootstrap lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/lab_bootstrap.mjs /run/rsi-lab/config.json || exit 4
RATIONALE="RSI round 1 $MONTH, family $FAMILY: the registered failure slice of the baseline on the pinned image; pre-registration $(jsonfield "$INBOX/$NAME/registration.json" digest | cut -c1-16)."
GOLD=(); [ -s "$INBOX/$NAME/confirmation.gold.json" ] && GOLD=(--confirmation-gold "$IN/confirmation.gold.json")
# The assembly is where the sealed confirmation export meets its gold and its verdict records; it refuses an export that is not sealed.
step assemble lab none "$IMAGE" evals/rsi-campaigns/harness_assemble.mjs --development "$IN/development.json" --confirmation "$IN/confirmation.json" "${GOLD[@]}" "${VERDICTS[@]}" \
  --registration "$IN/registration.json" --month "$MONTH" --out-dir "$C" --pilot-rationale "$RATIONALE" || { report; exit 6; }
ARGS=(--manifest "$C/manifest.json" --inputs "$C/inputs.json" --config /run/rsi-lab/config.json --out-dir "$C/run")
step run lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs run "${ARGS[@]}" || true
STATUS_RUN=$(jsonfield "$RUN/run/run.json" status)
if [ "$STATUS_RUN" != "awaiting-evaluation" ] && [ "$STATUS_RUN" != "completed" ]; then report; exit 0; fi
step checkpoint lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs report "${ARGS[@]}" || { report; exit 7; }
# The evaluator's profile names one receipt path (`state/harness-current/receipt.json`), shared by every family of the host: the receipt and the
# resume run under one lock with the link pointing at this family, so two families never read each other's receipt.
exec 9> "$STATE/harness.lock"
flock 9
ln -sfn "harness-$FAMILY-$MONTH" "$STATE/harness-current"
step receipt docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 "${KEYS[@]}" -v "$STATE":/srv/rsi-lab/state "$IMAGE" \
  evals/rsi-campaigns/evaluator.mjs receipt "$C/manifest.json" "$C/inputs.json" "$C/run/request.json" "$C/run/report.json" /run/rsi-keys/evaluator.pem "$C/receipt.json" || { report; exit 0; }
step resume lab rsi-lab-net "$IMAGE" evals/rsi-campaigns/run.mjs resume "${ARGS[@]}" --evaluator-profile /run/rsi-lab/evaluator-profile-harness.json || true
flock -u 9
report
