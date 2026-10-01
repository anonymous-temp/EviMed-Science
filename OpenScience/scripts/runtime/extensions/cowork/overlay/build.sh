#!/usr/bin/env bash
# Trusted operator build only. Vendor code is compiled in disposable Docker state without keys or customer mounts.
set -euo pipefail
SOURCE="${1:?source cache tree required}"
OUTPUT="${2:?new private output directory required}"
NODE_IMAGE="node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9"
ADAPTER="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME="evimed-cowork-overlay-build-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
test ! -e "$OUTPUT"
mkdir -p "$OUTPUT/context"
docker volume create "$VOLUME" >/dev/null
printf '%s\n' "$VOLUME" > "$OUTPUT/build-volume.txt"
docker run --rm --name "$VOLUME" --network bridge --cpus=1 --memory=1g --pids-limit=256 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
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
  ' > "$OUTPUT/contained-build.log" 2>&1
docker run --rm --network none --read-only --mount "type=volume,source=${VOLUME},target=/work,readonly" --entrypoint tar "$NODE_IMAGE" --hard-dereference -cf - -C /work/deploy-publication . > "$OUTPUT/vendor.tar"
docker run --rm --network none --read-only --mount "type=volume,source=${VOLUME},target=/work,readonly" --entrypoint cat "$NODE_IMAGE" /work/dependency-closure.json > "$OUTPUT/context/dependency-closure.json"
for FILE in overlay-attestation.json pnpm-lock.yaml; do
  docker run --rm --network none --read-only --mount "type=volume,source=${VOLUME},target=/work,readonly" --entrypoint cat "$NODE_IMAGE" "/work/${FILE}" > "$OUTPUT/context/${FILE}"
done
cp "$ADAPTER/overlay/pins.json" "$OUTPUT/context/overlay-pins.json"
python3 "$ADAPTER/assemble.py" "$OUTPUT" "$ADAPTER" "$SOURCE"
cp "$ADAPTER/overlay/Dockerfile" "$OUTPUT/context/Dockerfile"
docker build --network none --build-arg "NODE_IMAGE=${NODE_IMAGE}" -t evimed-cowork-portable:2ae5cf755c42-unzipper0123 "$OUTPUT/context" > "$OUTPUT/image-build.log" 2>&1
docker image inspect evimed-cowork-portable:2ae5cf755c42-unzipper0123 --format '{{json .}}' > "$OUTPUT/image-identity.json"
# The named volume is recorded for scoped operator cleanup; no unrelated cache/image is pruned.
