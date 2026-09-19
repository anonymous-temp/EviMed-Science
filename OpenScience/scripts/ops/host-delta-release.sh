#!/usr/bin/env bash
# Build one release on the serving host as a delta on the live one: seed the
# tree from the live release, overlay the changed files, rewrite the identity,
# build both images (web in full, runtime as the dependency-preserving delta of
# deploy/runtime-dsh/Dockerfile.delta, or in full with EVIMED_RUNTIME_BUILD=full
# when the kernel profile's composition changed), and stop. Putting it in front is a
# separate step, host-release-switch.sh, so the images can be inspected first.
#
#   host-delta-release.sh <OLD_SHORT> <NEW_SHORT> <NEW_FULL_REV> <BUILD_CREATED> <DELTA_TGZ>
#
# The delta archive is made on the developer's box, rooted at `src/`:
#
#   git archive --format=tar --prefix=src/ HEAD -- \
#     $(git diff --name-only --diff-filter=d <OLD>..HEAD | grep -E '^(OpenScience|项目代码)/')
#   git diff --name-only --diff-filter=D <OLD>..HEAD | grep '^OpenScience/' \
#     | sed 's|^OpenScience/||' > src/DELETED
#
# `--diff-filter=d` and `src/DELETED` exist because an overlay cannot delete:
# `git archive` refuses a path the range removed, and a removed web source that
# lingers in the seeded tree is still compiled by `tsc --noEmit && vite build`
# (2026-09-17, two dead files).
#
# This lived in /tmp on the host until 2026-09-17, which is how three releases
# were cut from a script nobody could read, diff or review.
set -euo pipefail
OLD="$1"; NEW="$2"; REV="$3"; CREATED="$4"; DELTA="$5"
ROOT="${EVIMED_ROOT:-/srv/evimed-science}"
BUILD="${ROOT}/build/${NEW}"
DST="${ROOT}/releases/${NEW}"
ENVF="${DST}/OpenScience/deploy/web/.env"
OPS_OLD="${ROOT}/shared/ops-source-${OLD}"
OPS_NEW="${ROOT}/shared/ops-source-${NEW}"

[ -d "${ROOT}/releases/${OLD}" ] || { echo "live release ${ROOT}/releases/${OLD} does not exist; refusing"; exit 1; }
[ -d "$DST" ] && { echo "release dir $DST already exists; refusing"; exit 1; }

echo "=== seed from the live release ==="
# As root and with cp -a: a copy made as another user drops the 0600 receipt,
# and compose then creates a directory where the file should be.
cp -a "${ROOT}/releases/${OLD}" "$DST"
mkdir -p "$BUILD" && tar -xzf "$DELTA" -C "$BUILD"
cp -a "$BUILD/src/OpenScience/." "$DST/OpenScience/"
# The specialist engines' sources live beside OpenScience (项目代码/), in the
# same build context their images are built from; a release that changed one
# carries it under src/项目代码 (host-engine-delta.sh rebuilds those images).
if [ -d "$BUILD/src/项目代码" ]; then cp -a "$BUILD/src/项目代码/." "$DST/项目代码/"; fi
if [ -f "$BUILD/src/DELETED" ]; then
  while IFS= read -r rel; do
    case "$rel" in ''|/*|*..*) echo "refusing deletion path: '$rel'"; exit 1 ;; esac
    rm -f -- "$DST/OpenScience/$rel" && echo "deleted $rel"
  done < "$BUILD/src/DELETED"
fi

echo "=== identity ==="
# The runtime image is tagged `<kernel and uv pins>-<release>`. The pins are
# read off the live release's own image name rather than written here: a delta
# keeps the base's pins by definition, and a second copy of a pin is one more
# place an upgrade misses (deps-version.json is the only place it is written).
OLD_RUNTIME_IMAGE=$(sed -n 's/^OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE=//p' "$ENVF")
case "$OLD_RUNTIME_IMAGE" in
  open-science-runtime:*-"${OLD}") RUNTIME_TAG_PREFIX="${OLD_RUNTIME_IMAGE#open-science-runtime:}"; RUNTIME_TAG_PREFIX="${RUNTIME_TAG_PREFIX%-"${OLD}"}" ;;
  *) echo "the live release's runtime image '${OLD_RUNTIME_IMAGE}' is not tagged for ${OLD}; refusing"; exit 1 ;;
esac
cp -a "$ENVF" "${ROOT}/shared/env-backup-.env.$(date -u +%Y%m%dT%H%M%SZ)"
sed -i \
  -e "s|^OPEN_SCIENCE_RELEASE_ID=.*|OPEN_SCIENCE_RELEASE_ID=evimed-${NEW}-1|" \
  -e "s|^OPEN_SCIENCE_SOURCE_REVISION=.*|OPEN_SCIENCE_SOURCE_REVISION=${REV}|" \
  -e "s|^OPEN_SCIENCE_BUILD_CREATED=.*|OPEN_SCIENCE_BUILD_CREATED=${CREATED}|" \
  -e "s|^OPEN_SCIENCE_WEB_CONTAINER_IMAGE=.*|OPEN_SCIENCE_WEB_CONTAINER_IMAGE=open-science-web:${NEW}|" \
  -e "s|^OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE=.*|OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE=open-science-runtime:${RUNTIME_TAG_PREFIX}-${NEW}|" \
  -e "s|releases/${OLD}/|releases/${NEW}/|g" \
  "$ENVF"
cp -a "$OPS_OLD" "$OPS_NEW"
sed -i "s|releases/${OLD}/|releases/${NEW}/|g" "$OPS_NEW/compose.builtin.override.yml"
echo "stale ${OLD} references in .env: $(grep -c "${OLD}" "$ENVF" || true)"
grep -E "^OPEN_SCIENCE_(RELEASE_ID|SOURCE_REVISION|BUILD_CREATED)=" "$ENVF"

echo "=== build ==="
cd "$DST/OpenScience"
docker build -f deploy/web/Dockerfile \
  --build-arg NODE_BASE_IMAGE="${EVIMED_NODE_BASE_IMAGE:-docker.m.daocloud.io/library/node:22.22.0-alpine}" \
  --build-arg NPM_REGISTRY="${EVIMED_NPM_REGISTRY:-https://registry.npmmirror.com}" \
  --build-arg APK_MIRROR="${EVIMED_APK_MIRROR:-https://mirrors.aliyun.com/alpine}" \
  --build-arg APP_VERSION="${EVIMED_APP_VERSION:-0.1.3}" \
  --build-arg RELEASE_ID="evimed-${NEW}-1" --build-arg SOURCE_REVISION="${REV}" --build-arg BUILD_CREATED="${CREATED}" \
  -t "open-science-web:${NEW}" . > "/tmp/build-web-${NEW}.log" 2>&1
echo "web built"
if [ "${EVIMED_RUNTIME_BUILD:-delta}" = "full" ]; then
  # A release that changes what the kernel profile is made of — a community
  # bundle added (dsh-annotation and dsh-mermaid, 2026-09-20), a dependency, the
  # install steps themselves — cannot be a delta: the delta re-dumps the
  # composition and refuses any difference from the committed baseline, by
  # design. The full build fetches everything again, so every fetch goes to a
  # mirror this host can reach (the direct routes stall for hours).
  docker build -f deploy/runtime-dsh/Dockerfile \
    --build-arg APT_MIRROR="${EVIMED_APT_MIRROR:-http://mirrors.cloud.tencent.com/debian}" \
    --build-arg DEBIAN_SECURITY_MIRROR="${EVIMED_DEBIAN_SECURITY_MIRROR:-http://mirrors.cloud.tencent.com/debian-security}" \
    --build-arg NODE_DIST_BASE="${EVIMED_NODE_DIST_BASE:-https://cdn.npmmirror.com/binaries/node}" \
    --build-arg NPM_REGISTRY="${EVIMED_NPM_REGISTRY:-https://registry.npmmirror.com}" \
    --build-arg GITHUB_DOWNLOAD_PREFIX="${EVIMED_GITHUB_DOWNLOAD_PREFIX:-https://ghfast.top/}" \
    --build-arg PIP_INDEX_URL="${EVIMED_PIP_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple}" \
    --build-arg RELEASE_ID="evimed-${NEW}-1" --build-arg SOURCE_REVISION="${REV}" --build-arg BUILD_CREATED="${CREATED}" \
    -t "open-science-runtime:${RUNTIME_TAG_PREFIX}-${NEW}" . > "/tmp/build-runtime-${NEW}.log" 2>&1
else
  # A delta stacks about twenty layers on the live image, so the chain only
  # grows; at 422 layers the delta's first COPY failed with `mount options is too
  # long` (2026-09-19). Past 300 the base is flattened into one layer first, with
  # the same files and configuration (host-flatten-runtime-image.sh).
  BASE_IMAGE="open-science-runtime:${RUNTIME_TAG_PREFIX}-${OLD}"
  if [ "$(docker image inspect -f '{{len .RootFS.Layers}}' "$BASE_IMAGE")" -gt 300 ]; then
    bash "$DST/OpenScience/scripts/ops/host-flatten-runtime-image.sh" "$BASE_IMAGE" "${BASE_IMAGE}-flat"
    BASE_IMAGE="${BASE_IMAGE}-flat"
  fi
  docker build -f deploy/runtime-dsh/Dockerfile.delta \
    --build-arg RUNTIME_BASE_IMAGE="$BASE_IMAGE" \
    --build-arg RELEASE_ID="evimed-${NEW}-1" --build-arg SOURCE_REVISION="${REV}" --build-arg BUILD_CREATED="${CREATED}" \
    -t "open-science-runtime:${RUNTIME_TAG_PREFIX}-${NEW}" . > "/tmp/build-runtime-${NEW}.log" 2>&1
fi
echo "runtime built; smoke: $(grep -c 'booted with every entry applied' "/tmp/build-runtime-${NEW}.log")"

for img in "open-science-web:${NEW}" "open-science-runtime:${RUNTIME_TAG_PREFIX}-${NEW}"; do
  docker image inspect "$img" --format "$img id={{.Id}} created={{index .Config.Labels \"org.opencontainers.image.created\"}} rev={{index .Config.Labels \"org.opencontainers.image.revision\"}}"
done
echo "=== done: generate the manifest for these image ids, copy it to ${DST}/OpenScience/deploy/web/release-manifest.json, then run host-release-switch.sh ${NEW} ==="
