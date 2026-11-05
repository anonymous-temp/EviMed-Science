#!/usr/bin/env bash
set -euo pipefail
if [[ ${VCR_STABLE_SCRIPT:-0} != 1 ]]; then
  script_bytes=$(cat "$0"); export VCR_STABLE_SCRIPT=1
  export VCR_RUNNER_SHA="$(printf '%s' "$script_bytes" | shasum -a 256 | cut -d ' ' -f 1)"
  exec bash -c "$script_bytes" "$0" "$@"
fi
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
validator_dir=$(mktemp -d "${TMPDIR:-/tmp}/vcr-export-validator.XXXXXXXX")
cp "$repo/OpenScience/evals/vcr-hosted-native/validate-export.mjs" "$repo/OpenScience/evals/vcr-hosted-native/artifact-export.mjs" "$validator_dir/"
: "${VCR_REUSE_RESOURCES:?Owned resource JSON required}" "${VCR_CASE_OUTPUT:?Fresh output file required}" "${VCR_LINUX_DOCKER_CLI:?Audited Linux Docker client required}"
readarray=(); while IFS= read -r line; do readarray+=("$line"); done < <(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const k of ["context","container","postgres","engine","holder","volume","network","egress"])console.log(x[k])' "$VCR_REUSE_RESOURCES")
context=${readarray[0]}; oldcp=${readarray[1]}; pg=${readarray[2]}; engine=${readarray[3]}; holder=${readarray[4]}; volume=${readarray[5]}; network=${readarray[6]}; egress=${readarray[7]}
[[ "$context" == colima-evimed-extension-acceptance && "$oldcp" =~ ^vcr-native-eval-[0-9]+-[0-9]+-cp$ ]] || { echo 'Unexpected ownership identity' >&2; exit 1; }
base=${oldcp%-cp}; [[ "$pg" == "$base-pg" && "$engine" == "$base-engine" && "$holder" == "$base-holder" && "$volume" == "$base-data" && "$network" == "$base-net" && "$egress" == "$base-egress" ]] || exit 1
cpname="$base-resume-$$"; docker_cmd=(docker --context "$context"); secret_dir=$(mktemp -d "${TMPDIR:-/tmp}/vcr-resume-secrets.XXXXXXXX"); chmod 700 "$secret_dir"; umask 077
retain=true
cleanup(){ rm -rf "$secret_dir" "$validator_dir"; if [[ "$retain" == true ]]; then node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({context:process.argv[2],container:process.argv[3],priorContainer:process.argv[4],postgres:process.argv[5],engine:process.argv[6],holder:process.argv[7],volume:process.argv[8],network:process.argv[9],egress:process.argv[10]})+"\n",{mode:0o600})' "${VCR_CASE_OUTPUT%.json}.resources.json" "$context" "$cpname" "$oldcp" "$pg" "$engine" "$holder" "$volume" "$network" "$egress"; echo 'Owned environment retained; see resources JSON.' >&2; return; fi; "${docker_cmd[@]}" rm -f "$cpname" "$oldcp" "$pg" "$engine" "$holder" >/dev/null 2>&1 || true; "${docker_cmd[@]}" volume rm "$volume" >/dev/null 2>&1 || true; "${docker_cmd[@]}" network rm "$network" "$egress" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM
for suffix in '' '.snapshot.json' '.usage.json' '.cost.json' '.budget.json' '.watchdog.jsonl' '.resources.json' '.artifacts' '.completion.json' '.completion-observations.jsonl'; do target="$VCR_CASE_OUTPUT"; [[ -z $suffix ]] || target="${VCR_CASE_OUTPUT%.json}$suffix"; [[ ! -e $target ]] || { echo 'Output path already exists' >&2; exit 1; }; done
for name in "$pg" "$engine" "$holder"; do [[ $("${docker_cmd[@]}" inspect --format '{{.State.Running}}' "$name") == true ]] || { echo "Owned service unavailable: $name" >&2; exit 1; }; done
for name in vcr-provider-key engine-token engine-receipt; do "${docker_cmd[@]}" cp "$oldcp:/run/$name" "$secret_dir/$name"; chmod 600 "$secret_dir/$name"; done
"${docker_cmd[@]}" exec "$holder" sh -ec 'mkdir -p /data/previous-completion; for p in snapshot.json conversation-results.json conversation-budget.json conversation-budget.json.exhausted conversation-cost.json conversation-usage.json conversation-watchdog.jsonl conversation-artifacts completion-snapshots.json completion-observations.jsonl watchdog-target.txt; do if [ -e "/data/$p" ]; then mv "/data/$p" /data/previous-completion/; fi; done'
image=codex-vcr-professional-runtime:20261105-r10
"${docker_cmd[@]}" create --name "$cpname" --network "$network" --network-alias vcr-native-cp --user root --entrypoint sh \
 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount "type=volume,src=$volume,dst=/data" \
 -e "VCR_TEST_IMAGE=$image" -e "VCR_TEST_NETWORK=$network" -e "VCR_TEST_VOLUME=$volume" -e VCR_RUN_CONVERSATIONS=1 -e VCR_CASE_SUITE=completion -e VCR_BUDGET_REMAINING=1.5 -e "VCR_RUNNER_SHA=$VCR_RUNNER_SHA" \
 -e VCR_TEST_ENGINE=codex-vcr-plugin-engine:20261105-v14 -e "VCR_TEST_DATABASE=postgresql://native:temporary-test-only@$pg:5432/evimed_test_native" \
 -w /app/OpenScience "$image" -ec 'chmod 600 /run/vcr-provider-key; exec node evals/vcr-hosted-native/hosted-test.mjs' >/dev/null
"${docker_cmd[@]}" cp "$repo/OpenScience" "$cpname:/app/"
"${docker_cmd[@]}" cp "$VCR_LINUX_DOCKER_CLI" "$cpname:/usr/local/bin/docker"
for name in vcr-provider-key engine-token engine-receipt; do "${docker_cmd[@]}" cp "$secret_dir/$name" "$cpname:/run/$name"; done
"${docker_cmd[@]}" network connect "$egress" "$cpname"
mkdir -m 700 "${VCR_CASE_OUTPUT%.json}.artifacts"
export_json(){ local source=$1 destination=$2 temporary="${2}.next.$$"; "${docker_cmd[@]}" cp "$holder:/data/$source" "$temporary" 2>/dev/null || return 1; node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$temporary" >/dev/null 2>&1 || { rm -f "$temporary"; return 1; }; mv "$temporary" "$destination"; }
"${docker_cmd[@]}" start -a "$cpname" & child=$!
while kill -0 "$child" 2>/dev/null; do
 for spec in 'conversation-results.json:' 'completion-snapshots.json:.completion.json' 'conversation-budget.json:.budget.json' 'conversation-usage.json:.usage.json' 'conversation-cost.json:.cost.json' 'snapshot.json:.snapshot.json'; do src=${spec%%:*}; suffix=${spec#*:}; target="$VCR_CASE_OUTPUT"; [[ -z $suffix ]] || target="${VCR_CASE_OUTPUT%.json}$suffix"; export_json "$src" "$target" || true; done
 "${docker_cmd[@]}" cp "$holder:/data/conversation-artifacts/." "${VCR_CASE_OUTPUT%.json}.artifacts/" 2>/dev/null || true
 sleep 5
done
status=0; wait "$child" || status=$?
for spec in 'conversation-results.json:' 'completion-snapshots.json:.completion.json' 'conversation-budget.json:.budget.json' 'conversation-usage.json:.usage.json' 'conversation-cost.json:.cost.json' 'snapshot.json:.snapshot.json'; do src=${spec%%:*}; suffix=${spec#*:}; target="$VCR_CASE_OUTPUT"; [[ -z $suffix ]] || target="${VCR_CASE_OUTPUT%.json}$suffix"; export_json "$src" "$target" || { echo "Required evidence export failed: $src" >&2; exit 1; }; done
"${docker_cmd[@]}" cp "$holder:/data/conversation-watchdog.jsonl" "${VCR_CASE_OUTPUT%.json}.watchdog.jsonl"
"${docker_cmd[@]}" cp "$holder:/data/completion-observations.jsonl" "${VCR_CASE_OUTPUT%.json}.completion-observations.jsonl"
"${docker_cmd[@]}" cp "$holder:/data/conversation-artifacts/." "${VCR_CASE_OUTPUT%.json}.artifacts/"
node "$validator_dir/validate-export.mjs" "$VCR_CASE_OUTPUT" '' completion "${VCR_CASE_OUTPUT%.json}.artifacts" '' || { echo 'Artifact coverage or hash check failed; retaining environment.' >&2; exit 1; }
node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1])),s=JSON.parse(fs.readFileSync(process.argv[2]));if(x.denominator!==1||x.results.length!==1||x.results[0].status!=="completed"||!s.snapshots.some(v=>v.phase==="root-turn-ended"&&v.jobs?.length>0)||!s.snapshots.some(v=>v.phase==="after-stop-11"))process.exit(1)' "$VCR_CASE_OUTPUT" "${VCR_CASE_OUTPUT%.json}.completion.json" || { echo 'No complete bounded completion observation; retaining environment.' >&2; exit 1; }
if "${docker_cmd[@]}" exec "$holder" test -e /data/conversation-budget.json.exhausted; then echo 'Budget gate fired; retaining environment.' >&2; exit 1; fi
[[ "$status" == 0 ]] || exit "$status"
retain=false
