#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
: "${VCR_PROVIDER_KEY_FILE:?}" "${VCR_LINUX_DOCKER_CLI:?}" "${VCR_UI_OUTPUT_DIR:?}"
context=colima-evimed-extension-acceptance; dc=(docker --context "$context"); tag="vcr-ui-fixture-$(date +%s)-$$"; net="$tag-net"; out="$tag-egress"; volume="$tag-data"; pg="$tag-pg"; engine="$tag-engine"; holder="$tag-holder"; cp="$tag-cp"
umask 077
mkdir -m 700 "$VCR_UI_OUTPUT_DIR"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({context:process.argv[2],container:process.argv[3],postgres:process.argv[4],engine:process.argv[5],holder:process.argv[6],volume:process.argv[7],network:process.argv[8],egress:process.argv[9]})+"\n",{mode:0o600,flag:"wx"})' "$VCR_UI_OUTPUT_DIR/resources.json" "$context" "$cp" "$pg" "$engine" "$holder" "$volume" "$net" "$out"
secrets=$(mktemp -d "${TMPDIR:-/tmp}/vcr-ui-secrets.XXXXXXXX"); chmod 700 "$secrets"; trap 'rm -rf "$secrets"' EXIT
openssl rand -hex 32 > "$secrets/engine-token"; openssl rand -hex 32 > "$secrets/engine-receipt"
"${dc[@]}" network create --internal "$net" >/dev/null; "${dc[@]}" network create "$out" >/dev/null
"${dc[@]}" volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1g,mode=0755 "$volume" >/dev/null
"${dc[@]}" run -d --name "$pg" --network "$net" --tmpfs /var/lib/postgresql/data:rw,size=512m -e POSTGRES_USER=native -e POSTGRES_PASSWORD=temporary-ui-only -e POSTGRES_DB=evimed_test_native postgres:16-bookworm >/dev/null
for _ in $(seq 1 60); do if "${dc[@]}" exec "$pg" pg_isready -U native -d evimed_test_native >/dev/null 2>&1; then break; fi; sleep 1; done
"${dc[@]}" run -d --name "$holder" --network none --user root --entrypoint sh --mount "type=volume,src=$volume,dst=/data" codex-vcr-professional-runtime:20261105-r11 -c 'mkdir -p /data/vcr-data-plane; chmod 755 /data/vcr-data-plane; exec sleep 86400' >/dev/null
for _ in $(seq 1 20); do if "${dc[@]}" exec "$holder" test -d /data/vcr-data-plane; then break; fi; sleep 1; done
"${dc[@]}" create --name "$engine" --network "$net" --network-alias vcr-ui-engine --user root --entrypoint sh --tmpfs /tmp:rw,nosuid,nodev,size=128m --tmpfs /jobs:rw,nosuid,nodev,size=256m,uid=10001,gid=10001 --mount "type=volume,src=$volume,dst=/data-plane/vcr-data-plane,volume-subpath=vcr-data-plane,readonly" -e VCR_ENGINE_ROOT=/engine -e VCR_R_LIBS=/opt/vcr-rlib -e VCR_ENGINE_WORK_DIR=/jobs -e VCR_ENGINE_DATA_ROOT=/data-plane/vcr-data-plane -e VCR_ENGINE_TOKEN_FILE=/run/engine-token -e VCR_ENGINE_RECEIPT_KEY_FILE=/run/engine-receipt codex-vcr-plugin-engine:20261105-v14 -ec 'chown 10001:10001 /run/engine-token /run/engine-receipt; chmod 400 /run/engine-token /run/engine-receipt; exec setpriv --reuid 10001 --regid 10001 --clear-groups python3 -m uvicorn service.app:app --host 0.0.0.0 --port 8000 --log-level warning' >/dev/null
for n in engine-token engine-receipt; do "${dc[@]}" cp "$secrets/$n" "$engine:/run/$n"; done; "${dc[@]}" start "$engine" >/dev/null
"${dc[@]}" create --name "$cp" --network "$net" --network-alias vcr-ui-cp --user root --entrypoint sh -p 127.0.0.1:59273:8787 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount "type=volume,src=$volume,dst=/data" -e VCR_TEST_IMAGE=codex-vcr-professional-runtime:20261105-r11 -e "VCR_TEST_NETWORK=$net" -e "VCR_TEST_VOLUME=$volume" -e "VCR_TEST_DATABASE=postgresql://native:temporary-ui-only@$pg:5432/evimed_test_native" -w /app/OpenScience codex-vcr-professional-runtime:20261105-r11 -ec 'chmod 600 /run/vcr-provider-key; exec node evals/vcr-hosted-native/ui-fixture.mjs' >/dev/null
"${dc[@]}" cp "$repo/OpenScience" "$cp:/app/"; "${dc[@]}" cp "$VCR_LINUX_DOCKER_CLI" "$cp:/usr/local/bin/docker"; "${dc[@]}" cp "$VCR_PROVIDER_KEY_FILE" "$cp:/run/vcr-provider-key"
for n in engine-token engine-receipt; do "${dc[@]}" cp "$secrets/$n" "$cp:/run/$n"; done
"${dc[@]}" network connect "$out" "$cp"; "${dc[@]}" start "$cp" >/dev/null
printf 'Owned test environment: %s\n' "$cp"
