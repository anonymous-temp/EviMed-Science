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
#
# Inbox harness-<family>-<month>/ (every file with its .sha256 in `sha256sum -c` format, checked here and again by the assembler):
#   registration.json                the pre-registration (register_round.py): rows, scorer, failure slice, margin, K, alpha, control, judge
#   development.json                 a harness-arms source, role development (gold in its rows; the verdict records apart for a judged family)
#   confirmation.json                a harness-arms source, role confirmation, SEALED: answers and costs, no gold, no scores
#   confirmation.gold.json           the gold of the sealed rows (deterministic scorers); joined only by the assembly, below
#   development.verdicts.jsonl       the judge's verdict records of the development runs (judged-verdicts)
#   confirmation.verdicts.jsonl      the judge's verdict records of the confirmation runs (judged-verdicts)
#   improvement.json                 optional: who wrote the candidates (provenance, recorded in the registration the campaign digests)
# Only development data is read by `develop`. The confirmation files are read by the assembly of `run`, which joins the gold and the
# records the export kept apart and builds the manifest; nothing scores them before the runner has frozen the policy and reserved the
# quarter's error budget and the corpus.
set -euo pipefail
umask 027
MONTH=$1; FAMILY=$2; COMMAND=$3
[[ $MONTH =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM" >&2; exit 2; }
[[ $FAMILY =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "family must be lower-case letters, digits and hyphens" >&2; exit 2; }
[ "$COMMAND" = develop ] || [ "$COMMAND" = run ] || { echo "command is develop or run" >&2; exit 2; }
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
    sleep 300
  done
  [ -s "$INBOX/$NAME/registration.json" ] && mapfile -t FILES < <(needs "$1") && verify "${FILES[@]}"
}
# Signed report, whatever the verdict: report.md/report.json from the campaign directory, then the evaluator's signature over report.json.
report() {
  lab none "$IMAGE" evals/rsi-campaigns/harness_report.mjs "$C" "$MONTH" >> "$RUN/launcher.log" 2>&1 || true
  [ -s "$RUN/report.json" ] && docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 "${KEYS[@]}" \
    -v "$STATE":/srv/rsi-lab/state "$IMAGE" evals/rsi-campaigns/evaluator.mjs report "$C/report.json" /run/rsi-keys/evaluator.pem "$C/report.signed.json" >> "$RUN/launcher.log" 2>&1 || true
  cp -f "$RUN/report.md" "$RUN/report.json" "$RUN/report.signed.json" "$RUN/supply.json" "$RUN/development-only.json" "$OUTBOX/$NAME/" 2>/dev/null || true
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
