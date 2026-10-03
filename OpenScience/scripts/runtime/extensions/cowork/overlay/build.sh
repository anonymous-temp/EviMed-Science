#!/usr/bin/env bash
# Trusted operator build only. Vendor code is compiled in disposable Docker state without keys or customer mounts.
set -euo pipefail
SOURCE="${1:?source cache tree required}"
OUTPUT="${2:?new private output directory required}"
PLATFORM="${3:?explicit linux/amd64 or linux/arm64 platform required}"
RUN_ID="${4:?owned preparation UUID required}"
case "$PLATFORM" in
  linux/amd64) BASE_DIGEST=sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2 ;;
  linux/arm64) BASE_DIGEST=sha256:f71fb9ca71b1b47d4d1a009af78147ed6cdc74f9c7cfc36cbde78ff985169051 ;;
  *) echo "Unsupported preparation platform" >&2; exit 1 ;;
esac
[[ "$RUN_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || { echo "Invalid preparation identity" >&2; exit 1; }
NODE_IMAGE="node:22.23.2-bookworm-slim@${BASE_DIGEST}"
IMAGE_TAG="evimed-cowork-acceptance:${RUN_ID}"
if ! docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
  if ! docker pull --platform "$PLATFORM" "$NODE_IMAGE" >/dev/null; then
    NODE_IMAGE="docker.m.daocloud.io/library/node:22.23.2-bookworm-slim@${BASE_DIGEST}"
    if ! docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then docker pull --platform "$PLATFORM" "$NODE_IMAGE" >/dev/null; fi
  fi
fi
[[ "$(docker image inspect "$NODE_IMAGE" --format '{{.Os}}/{{.Architecture}}')" == "$PLATFORM" ]] || exit 1
ADAPTER="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME="evimed-cowork-overlay-${RUN_ID}"
CONTAINER_ID=""
READER_IDS=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for owned in "${READER_IDS[@]}" "$CONTAINER_ID"; do
    [[ -n "$owned" ]] || continue
    local remaining
    remaining="$(docker container ls -aq --no-trunc --filter "id=$owned")" || { printf '%s\n' 'container absence unknown' > "$OUTPUT/recovery-required.txt"; exit 1; }
    if [[ -z "$remaining" ]]; then continue; fi
    [[ "$(docker inspect "$owned" --format '{{.Id}}/{{index .Config.Labels "evimed.preparation"}}')" == "$owned/$RUN_ID" ]] || exit 1
    docker rm -f "$owned" >/dev/null || { printf '%s\n' 'container cleanup unconfirmed' > "$OUTPUT/recovery-required.txt"; exit 1; }
    test -z "$(docker container ls -aq --no-trunc --filter "id=$owned")" || exit 1
  done
  if [[ -z "$CONTAINER_ID" && -f "$OUTPUT/create-requested.txt" ]]; then
    printf '%s\n' 'container creation identity unconfirmed' > "$OUTPUT/recovery-required.txt"; exit 1
  fi
  if [[ -f "$OUTPUT/image-build-requested.txt" ]]; then
    printf '%s\n' 'daemon image build settlement unconfirmed' > "$OUTPUT/recovery-required.txt"; exit 1
  fi
  if [[ -f "$OUTPUT/reader-create-requested.txt" || ( -f "$OUTPUT/volume-create-requested.txt" && ! -f "$OUTPUT/volume-identity.txt" ) ]]; then
    printf '%s\n' 'reader/volume creation identity unconfirmed' > "$OUTPUT/recovery-required.txt"; exit 1
  fi
  if [[ -f "$OUTPUT/recovery-required.txt" ]]; then exit 1; fi
  if [[ -f "$OUTPUT/build-volume.txt" ]]; then
    [[ "$(docker volume inspect "$VOLUME" --format '{{.CreatedAt}}/{{index .Labels "evimed.preparation"}}')" == "$(cat "$OUTPUT/volume-identity.txt")" ]] || exit 1
    docker volume rm "$VOLUME" >/dev/null || { printf '%s\n' 'volume cleanup unconfirmed' > "$OUTPUT/recovery-required.txt"; exit 1; }
  fi
  printf '%s\n' 'joined' > "$OUTPUT/cleanup.txt"
  exit "$status"
}
test ! -e "$OUTPUT"
mkdir "$OUTPUT"
mkdir "$OUTPUT/context"
trap cleanup EXIT INT TERM
printf '%s\n' requested > "$OUTPUT/volume-create-requested.txt"
docker volume create --label "evimed.preparation=$RUN_ID" "$VOLUME" >/dev/null
printf '%s\n' "$VOLUME" > "$OUTPUT/build-volume.txt"
docker volume inspect "$VOLUME" --format '{{.CreatedAt}}/{{index .Labels "evimed.preparation"}}' > "$OUTPUT/volume-identity.txt"
printf '%s\n' requested > "$OUTPUT/create-requested.txt"
CONTAINER_ID="$(docker create --name "$VOLUME" --label "evimed.preparation=$RUN_ID" --platform "$PLATFORM" --network bridge --cpus=1 --memory=1g --memory-swap=1g --pids-limit=256 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /root/.cache:rw,nosuid,nodev,size=128m --tmpfs /root/.local:rw,nosuid,nodev,size=128m \
  --mount "type=volume,source=${VOLUME},target=/work" --mount "type=bind,source=${SOURCE},target=/source,readonly" \
  --mount "type=bind,source=${ADAPTER},target=/adapter,readonly" --workdir /work "$NODE_IMAGE" timeout --kill-after=10 600 sh -ec '
    cp -R /source/. /work/
    node /adapter/verify-source.mjs
    node /adapter/overlay/apply.mjs /work /adapter/overlay/pins.json /adapter/overlay/pnpm-lock.yaml
    npm install --global --ignore-scripts --cache /work/npm-cache --prefix /work/package-manager pnpm@11.8.0
    /work/package-manager/bin/pnpm install --store-dir /work/pnpm-store --frozen-lockfile --ignore-scripts --filter dsh-cowork --filter @dsh-cowork/core --filter @dsh-cowork/mcp
    /work/package-manager/bin/pnpm --filter @dsh-cowork/core build
    /work/package-manager/bin/pnpm --filter @dsh-cowork/mcp build
    /work/package-manager/bin/pnpm --store-dir /work/pnpm-store --filter @dsh-cowork/mcp deploy --prod --legacy --ignore-scripts /work/deploy-publication
    node /adapter/prepare-artifact.mjs
    node /adapter/inventory.mjs
    node /adapter/overlay/attest.mjs
  ')"
[[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
printf '%s\n' "$CONTAINER_ID" > "$OUTPUT/builder-container-id.txt"
node --input-type=module -e '
  import {spawn} from "node:child_process";
  const child=spawn("docker",["start","-a",process.argv[1]],{stdio:["ignore","pipe","pipe"]});let bytes=0,failed=false;
  const kill=()=>{if(failed)return;failed=true;child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),3000).unref();};
  const timer=setTimeout(kill,650000);
  for(const stream of [child.stdout,child.stderr])stream.on("data",chunk=>{bytes+=chunk.length;if(bytes>32*1024*1024)kill();else process.stdout.write(chunk);});
  child.once("error",()=>{failed=true;});child.once("close",code=>{clearTimeout(timer);process.exitCode=failed||code!==0?1:0;});
' "$CONTAINER_ID" > "$OUTPUT/contained-build.log" 2>&1
read_build_file() {
  local output="$1"; shift
  local reader
  printf '%s\n' requested > "$OUTPUT/reader-create-requested.txt"
  reader="$(docker create --label "evimed.preparation=$RUN_ID" --platform "$PLATFORM" --network none --read-only --cpus=1 --memory=512m --memory-swap=512m --pids-limit=32 --cap-drop=ALL --security-opt=no-new-privileges --mount "type=volume,source=${VOLUME},target=/work,readonly" --entrypoint "$1" "$NODE_IMAGE" "${@:2}")"
  [[ "$reader" =~ ^[a-f0-9]{64}$ ]] || { printf '%s\n' 'reader identity unknown' > "$OUTPUT/recovery-required.txt"; exit 1; }
  READER_IDS+=("$reader")
  printf '%s\n' "$reader" >> "$OUTPUT/reader-container-ids.txt"
  rm "$OUTPUT/reader-create-requested.txt"
  node --input-type=module -e '
    import {spawn} from "node:child_process";
    const child=spawn("docker",["start","-a",process.argv[1]],{stdio:["ignore","pipe","inherit"]});
    let bytes=0,failed=false;
    const kill=()=>{failed=true;child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),3000).unref();};
    const timer=setTimeout(kill,120000);
    child.stdout.on("data",chunk=>{bytes+=chunk.length;if(bytes>512*1024*1024)kill();else process.stdout.write(chunk);});
    child.once("close",code=>{clearTimeout(timer);process.exitCode=failed||code!==0?1:0;});
  ' "$reader" > "$output"
}
read_build_file "$OUTPUT/vendor.tar" tar --hard-dereference -cf - -C /work/deploy-publication .
read_build_file "$OUTPUT/context/dependency-closure.json" cat /work/dependency-closure.json
for FILE in overlay-attestation.json pnpm-lock.yaml; do
  read_build_file "$OUTPUT/context/$FILE" cat "/work/${FILE}"
done
cp "$ADAPTER/overlay/pins.json" "$OUTPUT/context/overlay-pins.json"
python3 "$ADAPTER/assemble.py" "$OUTPUT" "$ADAPTER" "$SOURCE"
cp "$ADAPTER/overlay/Dockerfile" "$OUTPUT/context/Dockerfile"
printf '%s\n' requested > "$OUTPUT/image-build-requested.txt"
DOCKER_BUILDKIT=0 docker build --memory 1g --memory-swap 1g --cpu-period 100000 --cpu-quota 100000 --platform "$PLATFORM" --network none --build-arg "NODE_IMAGE=${NODE_IMAGE}" -t "$IMAGE_TAG" "$OUTPUT/context" > "$OUTPUT/image-build.log" 2>&1
rm "$OUTPUT/image-build-requested.txt"
[[ "$(docker image inspect "$IMAGE_TAG" --format '{{.Os}}/{{.Architecture}}')" == "$PLATFORM" ]] || exit 1
docker image inspect "$IMAGE_TAG" --format '{{json .}}' > "$OUTPUT/image-identity.json"
# The named volume is recorded for scoped operator cleanup; no unrelated cache/image is pruned.
