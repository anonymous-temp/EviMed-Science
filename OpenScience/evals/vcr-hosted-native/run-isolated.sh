#!/usr/bin/env bash
set -euo pipefail
# Bash normally reads scripts incrementally. Freeze the bytes before starting
# so a concurrent workspace edit cannot interrupt final evidence collection.
if [[ ${VCR_STABLE_SCRIPT:-0} != 1 ]]; then
  script_bytes=$(cat "$0")
  export VCR_STABLE_SCRIPT=1
  export VCR_RUNNER_SHA="$(printf '%s' "$script_bytes" | shasum -a 256 | cut -d ' ' -f 1)"
  exec bash -c "$script_bytes" "$0" "$@"
fi
: "${VCR_RUNNER_SHA:?Frozen runner digest required}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
validator_dir=$(mktemp -d "${TMPDIR:-/tmp}/vcr-export-validator.XXXXXXXX")
cp "$repo/OpenScience/evals/vcr-hosted-native/validate-export.mjs" "$repo/OpenScience/evals/vcr-hosted-native/artifact-export.mjs" "$validator_dir/"
context="${VCR_DOCKER_CONTEXT:-colima}"
image="${VCR_TEST_IMAGE:-codex-vcr-professional-runtime:20261105}"
cli="${VCR_LINUX_DOCKER_CLI:?Set VCR_LINUX_DOCKER_CLI to an audited Linux Docker client}"
tag="vcr-native-eval-$(date +%s)-$$"
network="${tag}-net"; egress="${tag}-egress"; volume="${tag}-data"; pg="${tag}-pg"; cp="${tag}-cp"; engine="${tag}-engine"; holder="${tag}-holder"
docker_cmd=(docker --context "$context")
secret_dir=""
retain=false
cleanup() {
  rm -rf "$validator_dir"
  if [[ -n $secret_dir ]]; then rm -rf "$secret_dir"; fi
  if [[ "$retain" == true ]]; then
    if [[ -n ${VCR_CASE_OUTPUT:-} ]]; then node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({context:process.argv[2],container:process.argv[3],postgres:process.argv[4],engine:process.argv[5],holder:process.argv[6],volume:process.argv[7],network:process.argv[8],egress:process.argv[9]})+"\n",{mode:0o600})' "${VCR_CASE_OUTPUT%.json}.resources.json" "$context" "$cp" "$pg" "$engine" "$holder" "$volume" "$network" "$egress"; fi
    echo "Evidence export incomplete; retained test resources: $cp $pg $engine $holder $volume $network $egress" >&2; return
  fi
  "${docker_cmd[@]}" rm -f "$cp" "$pg" "$engine" "$holder" >/dev/null 2>&1 || true; "${docker_cmd[@]}" volume rm "$volume" >/dev/null 2>&1 || true; "${docker_cmd[@]}" network rm "$network" "$egress" >/dev/null 2>&1 || true;
}
trap cleanup EXIT
trap 'retain=true; exit 130' INT TERM
"${docker_cmd[@]}" network create --internal "$network" >/dev/null
"${docker_cmd[@]}" volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1g,mode=0755 "$volume" >/dev/null
"${docker_cmd[@]}" run -d --name "$pg" --network "$network" --tmpfs /var/lib/postgresql/data:rw,size=512m -e POSTGRES_USER=native -e POSTGRES_PASSWORD=temporary-test-only -e POSTGRES_DB=evimed_test_native postgres:16-bookworm >/dev/null
ready=false
for _ in $(seq 1 60); do
  if "${docker_cmd[@]}" exec "$pg" pg_isready -U native -d evimed_test_native >/dev/null 2>&1; then ready=true; break; fi
  if [[ $("${docker_cmd[@]}" inspect --format '{{.State.Running}}' "$pg") != true ]]; then "${docker_cmd[@]}" logs "$pg" >&2; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Isolated PostgreSQL did not become ready.' >&2; exit 1; fi
"${docker_cmd[@]}" create --name "$cp" --network "$network" --network-alias vcr-native-cp --user root --entrypoint sh \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount "type=volume,src=$volume,dst=/data" \
  -e "VCR_TEST_IMAGE=$image" -e "VCR_TEST_NETWORK=$network" -e "VCR_TEST_VOLUME=$volume" \
  -e "VCR_RUN_CONVERSATIONS=${VCR_RUN_CONVERSATIONS:-0}" \
  -e "VCR_RETEST_IDS=${VCR_RETEST_IDS:-}" \
  -e "VCR_CASE_SUITE=${VCR_CASE_SUITE:-formal}" \
  -e "VCR_CHAIN_THEN_FORMAL=${VCR_CHAIN_THEN_FORMAL:-0}" \
  -e "VCR_BUDGET_REMAINING=${VCR_BUDGET_REMAINING:-}" \
  -e "VCR_RUNNER_SHA=$VCR_RUNNER_SHA" \
  -e "VCR_TEST_ENGINE=${VCR_TEST_ENGINE:-}" \
  -e "VCR_TEST_DATABASE=postgresql://native:temporary-test-only@$pg:5432/evimed_test_native" \
  -w /app/OpenScience "$image" -ec 'if [ "$VCR_RUN_CONVERSATIONS" = 1 ]; then chmod 600 /run/vcr-provider-key; fi; exec node evals/vcr-hosted-native/hosted-test.mjs' >/dev/null
"${docker_cmd[@]}" cp "$repo/OpenScience" "$cp:/app/"
"${docker_cmd[@]}" cp "$cli" "$cp:/usr/local/bin/docker"
if [[ ${VCR_RUN_CONVERSATIONS:-0} == 1 ]]; then
  : "${VCR_PROVIDER_KEY_FILE:?A control-plane-only provider key file is required}"
  : "${VCR_CASE_OUTPUT:?A local case result path is required}"
  : "${VCR_TEST_ENGINE:?An isolated real VCR engine image is required}"
  for suffix in '' '.snapshot.json' '.usage.json' '.cost.json' '.budget.json' '.watchdog.jsonl' '.resources.json' '.artifacts' '.chains.json' '.completion.json' '.completion-observations.jsonl' '.jobs.json'; do
    target="$VCR_CASE_OUTPUT"; if [[ -n $suffix ]]; then target="${VCR_CASE_OUTPUT%.json}$suffix"; fi
    if [[ -e $target ]]; then echo 'Evidence output path already exists; choose a fresh path.' >&2; exit 1; fi
  done
  secret_dir=$(mktemp -d "${TMPDIR:-/tmp}/vcr-native-secrets.XXXXXXXX")
  chmod 700 "$secret_dir"
  umask 077
  openssl rand -hex 32 > "$secret_dir/engine-token"
  openssl rand -hex 32 > "$secret_dir/engine-receipt"
  "${docker_cmd[@]}" run -d --name "$holder" --network none --user root --entrypoint sh --mount "type=volume,src=$volume,dst=/data" "$image" -c 'mkdir -p /data/vcr-data-plane; chmod 755 /data/vcr-data-plane; exec sleep 86400' >/dev/null
  for _ in $(seq 1 20); do if "${docker_cmd[@]}" exec "$holder" test -d /data/vcr-data-plane; then break; fi; sleep 1; done
  "${docker_cmd[@]}" create --name "$engine" --network "$network" --network-alias vcr-native-engine --user root --entrypoint sh \
    --tmpfs /tmp:rw,nosuid,nodev,size=128m --tmpfs /jobs:rw,nosuid,nodev,size=256m,uid=10001,gid=10001 \
    --mount "type=volume,src=$volume,dst=/data-plane/vcr-data-plane,volume-subpath=vcr-data-plane,readonly" \
    -e VCR_ENGINE_ROOT=/engine -e VCR_R_LIBS=/opt/vcr-rlib -e VCR_ENGINE_WORK_DIR=/jobs -e VCR_ENGINE_DATA_ROOT=/data-plane/vcr-data-plane \
    -e VCR_ENGINE_TOKEN_FILE=/run/engine-token -e VCR_ENGINE_RECEIPT_KEY_FILE=/run/engine-receipt "$VCR_TEST_ENGINE" \
    -ec 'chown 10001:10001 /run/engine-token /run/engine-receipt; chmod 400 /run/engine-token /run/engine-receipt; exec setpriv --reuid 10001 --regid 10001 --clear-groups python3 -m uvicorn service.app:app --host 0.0.0.0 --port 8000 --log-level warning' >/dev/null
  "${docker_cmd[@]}" cp "$secret_dir/engine-token" "$engine:/run/engine-token"
  "${docker_cmd[@]}" cp "$secret_dir/engine-receipt" "$engine:/run/engine-receipt"
  "${docker_cmd[@]}" cp "$secret_dir/engine-token" "$cp:/run/engine-token"
  "${docker_cmd[@]}" cp "$secret_dir/engine-receipt" "$cp:/run/engine-receipt"
  "${docker_cmd[@]}" start "$engine" >/dev/null
  "${docker_cmd[@]}" network create "$egress" >/dev/null
  "${docker_cmd[@]}" network connect "$egress" "$cp"
  "${docker_cmd[@]}" cp "$VCR_PROVIDER_KEY_FILE" "$cp:/run/vcr-provider-key"
fi
status=0
if [[ ${VCR_RUN_CONVERSATIONS:-0} == 1 ]]; then
  umask 077
  export_json() {
    local source=$1 destination=$2 temporary="${2}.next.$$"
    if ! "${docker_cmd[@]}" cp "$holder:/data/$source" "$temporary" 2>/dev/null; then return 1; fi
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$temporary" >/dev/null 2>&1; then rm -f "$temporary"; return 1; fi
    mv "$temporary" "$destination"
  }
  export_all() {
    if [[ ${VCR_CASE_SUITE:-formal} == post-audit ]]; then
      export_json post-audit-jobs.json "${VCR_CASE_OUTPUT%.json}.jobs.json" || return 1
      node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.records?.length!==3)process.exit(1)' "${VCR_CASE_OUTPUT%.json}.jobs.json" || return 1
    fi
    if [[ ${VCR_CASE_SUITE:-formal} == completion ]]; then
      export_json completion-snapshots.json "${VCR_CASE_OUTPUT%.json}.completion.json" || return 1
      "${docker_cmd[@]}" cp "$holder:/data/completion-observations.jsonl" "${VCR_CASE_OUTPUT%.json}.completion-observations.jsonl" || return 1
      node -e 'for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean))JSON.parse(l)' "${VCR_CASE_OUTPUT%.json}.completion-observations.jsonl" || return 1
    fi
    if [[ ${VCR_CHAIN_THEN_FORMAL:-0} == 1 ]]; then
      export_json native-chain-results.json "${VCR_CASE_OUTPUT%.json}.chains.json" || return 1
      node -e 'let x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.denominator!==4||x.results.length!==4||x.results.some(r=>r.status!=="completed"))process.exit(1)' "${VCR_CASE_OUTPUT%.json}.chains.json" || return 1
    fi
    export_json snapshot.json "${VCR_CASE_OUTPUT%.json}.snapshot.json" &&
      export_json conversation-results.json "$VCR_CASE_OUTPUT" &&
      export_json conversation-usage.json "${VCR_CASE_OUTPUT%.json}.usage.json" &&
      export_json conversation-cost.json "${VCR_CASE_OUTPUT%.json}.cost.json" &&
      export_json conversation-budget.json "${VCR_CASE_OUTPUT%.json}.budget.json" &&
      "${docker_cmd[@]}" cp "$holder:/data/conversation-artifacts/." "${VCR_CASE_OUTPUT%.json}.artifacts/" &&
      node "$validator_dir/validate-export.mjs" "$VCR_CASE_OUTPUT" "${VCR_RETEST_IDS:-}" "${VCR_CASE_SUITE:-formal}" "${VCR_CASE_OUTPUT%.json}.artifacts" "$(if [[ ${VCR_CHAIN_THEN_FORMAL:-0} == 1 ]]; then printf %s "${VCR_CASE_OUTPUT%.json}.chains.json"; fi)"
  }
  retain=true
  mkdir -m 700 "${VCR_CASE_OUTPUT%.json}.artifacts"
  "${docker_cmd[@]}" start -a "$cp" & child=$!
  while kill -0 "$child" 2>/dev/null; do
    export_json conversation-results.json "$VCR_CASE_OUTPUT" || true
    export_json conversation-usage.json "${VCR_CASE_OUTPUT%.json}.usage.json" || true
    export_json conversation-cost.json "${VCR_CASE_OUTPUT%.json}.cost.json" || true
    export_json snapshot.json "${VCR_CASE_OUTPUT%.json}.snapshot.json" || true
    export_json conversation-budget.json "${VCR_CASE_OUTPUT%.json}.budget.json" || true
    if [[ ${VCR_CHAIN_THEN_FORMAL:-0} == 1 ]]; then export_json native-chain-results.json "${VCR_CASE_OUTPUT%.json}.chains.json" || true; fi
    if [[ ${VCR_CASE_SUITE:-formal} == completion ]]; then export_json completion-snapshots.json "${VCR_CASE_OUTPUT%.json}.completion.json" || true; fi
    if [[ ${VCR_CASE_SUITE:-formal} == post-audit ]]; then export_json post-audit-jobs.json "${VCR_CASE_OUTPUT%.json}.jobs.json" || true; fi
    "${docker_cmd[@]}" cp "$holder:/data/conversation-artifacts/." "${VCR_CASE_OUTPUT%.json}.artifacts/" 2>/dev/null || true
    sleep 5
  done
  wait "$child" || status=$?
  exported=false
  for _ in $(seq 1 5); do if export_all; then exported=true; break; fi; sleep 2; done
  if ! "${docker_cmd[@]}" cp "$holder:/data/conversation-watchdog.jsonl" "${VCR_CASE_OUTPUT%.json}.watchdog.jsonl" 2>/dev/null || ! node -e 'const fs=require("fs");for(const line of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean))JSON.parse(line)' "${VCR_CASE_OUTPUT%.json}.watchdog.jsonl"; then exported=false; fi
  if [[ "$exported" != true ]]; then retain=true; echo 'Final evidence export failed; resources are preserved.' >&2; exit 1; fi
  if [[ ${VCR_CASE_SUITE:-formal} == completion ]] && "${docker_cmd[@]}" exec "$holder" test -e /data/conversation-budget.json.exhausted; then retain=true; echo 'Completion test budget was exhausted; resources are preserved.' >&2; exit 1; fi
  retain=false
else
  "${docker_cmd[@]}" start -a "$cp" || status=$?
fi
exit "$status"
