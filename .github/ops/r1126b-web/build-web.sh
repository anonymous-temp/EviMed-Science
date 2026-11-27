#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$(git rev-parse HEAD)" = "$PRODUCT_REVISION"
test -z "$(git status --porcelain)"
base=9f31aa798908f80665fe73ea364385170279c7b6
base_run=45826789958
base_artifact=15128377075
base_sha=sha256:554969871efe1d7d9e6e2b6036293af6527dd109331d83d81cddcf4a689dd68d
base_ref="open-science-web:ci-$base_run-1"
release="evimed-${PRODUCT_REVISION:0:12}-$GITHUB_RUN_ATTEMPT"
reference="open-science-web:ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
created="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
export release reference created
work="$RUNNER_TEMP/r1126b-web"
out="$RUNNER_TEMP/evimed-web-delta"
install -d "$out" "$work/context"
gib=$((1024 ** 3))
free() { df -B1 --output=avail "$1" | tail -1; }
need() { test "$(free "$RUNNER_TEMP")" -ge "$1" && test "$(free "$(docker info --format '{{.DockerRootDir}}')")" -ge "$1"; }
need "$((16 * gib))"

# The only tracked changes since the live Web image are the frontend and
# the CI APT helper. None of the runtime and dependency inputs moved.
git fetch --no-tags --depth=1 origin "$base"
git diff --name-only "$base" "$PRODUCT_REVISION" | sort > "$work/changed"
cat > "$work/expected" <<'LIST'
OpenScience/apps/web/src/components/activeResearch/ResearchObservatory.css
OpenScience/apps/web/src/components/charts/ring/ringScene.ts
OpenScience/apps/web/src/components/workspace/WorkspaceSplit.test.tsx
OpenScience/scripts/ops/ci-apt.sh
OpenScience/scripts/vcr/ci-apt-fallback.py
OpenScience/scripts/vcr/test/ci-apt-fallback.test.mjs
LIST
diff -u "$work/expected" "$work/changed"

test "$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$base_run" --jq '.conclusion')" = success
printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" \
  | curl --config - --proto =https -fsS --max-time 15 --dump-header - --output /dev/null \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/artifacts/$base_artifact/zip" \
  | python3 -c 'import sys,urllib.parse; url,=[line.split(":",1)[1].strip() for line in sys.stdin if line.lower().startswith("location:")]; assert urllib.parse.urlsplit(url).hostname.endswith(".blob.core.windows.net"); print("url = \"" + url + "\"")' \
  | curl --config - --proto =https -fsS --max-time 480 --max-filesize 2600000000 -o "$work/base.zip"
python3 "$work/select-web-image.py" "$work/base.zip" "$work/base-web.tar.gz" "$base" "$base_run" 1 "$base_sha"
need "$((12 * gib))"
docker load < "$work/base-web.tar.gz"
docker image inspect "$base_ref" > "$work/base-image.json"
python3 - "$work" <<'PY'
import json, sys
from pathlib import Path
w = Path(sys.argv[1])
receipt = json.loads((w/"base-web.tar.json").read_text())
actual = json.loads((w/"base-image.json").read_text())[0]
assert actual["Id"] == receipt["configDigest"]
assert actual["RootFS"]["Layers"] == receipt["image"]["diffIds"]
assert actual["Config"]["Labels"] == receipt["ciIdentity"]["labels"]
PY
rm -f -- "$work/base.zip" "$work/base-web.tar.gz"

context="$work/context"
cp -a OpenScience/apps/web/dist "$context/dist"
cp OpenScience/scripts/ops/ci-apt.sh "$context/ci-apt.sh"
cp OpenScience/scripts/vcr/ci-apt-fallback.py "$context/ci-apt-fallback.py"
cp OpenScience/scripts/vcr/test/ci-apt-fallback.test.mjs "$context/ci-apt-fallback.test.mjs"
test "$(du -sb "$context" | cut -f1)" -le "$((32 * 1024 ** 2))"
cat > "$context/Dockerfile" <<EOF
FROM $base_ref
RUN rm -rf /app/apps/web/dist
COPY dist /app/apps/web/dist
COPY ci-apt.sh /app/scripts/ops/ci-apt.sh
COPY ci-apt-fallback.py /app/scripts/vcr/ci-apt-fallback.py
COPY ci-apt-fallback.test.mjs /app/scripts/vcr/test/ci-apt-fallback.test.mjs
LABEL org.opencontainers.image.version="$release"
LABEL org.opencontainers.image.revision="$PRODUCT_REVISION"
LABEL org.opencontainers.image.created="$created"
ENV OPEN_SCIENCE_RELEASE_ID="$release"
ENV OPEN_SCIENCE_SOURCE_REVISION="$PRODUCT_REVISION"
ENV OPEN_SCIENCE_BUILD_CREATED="$created"
EOF
need "$((12 * gib))"
docker build --network none --pull=false --platform linux/amd64 --tag "$reference" "$context"
docker image inspect "$reference" > "$work/web-image.json"
docker image inspect "$base_ref" > "$work/base-image-after.json"
test "$(jq -r '.[0].Id' "$work/base-image.json")" = "$(jq -r '.[0].Id' "$work/base-image-after.json")"

name=r1126b-web-smoke
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --name "$name" --detach --publish 127.0.0.1::8787 \
  --env NODE_ENV=development --env OPEN_SCIENCE_RUNTIME_MODE=mock \
  --env OPEN_SCIENCE_AUTH_MODE=development "$reference" >/dev/null
port=$(docker port "$name" 8787/tcp | sed -nE 's/^127\.0\.0\.1:([0-9]+)$/\1/p')
test -n "$port"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 4 "http://127.0.0.1:$port/api/health" > "$work/health-live.json"; then break; fi
  sleep 1
done
jq -e '.data.ok == true and .data.runtimeMode == "mock"' "$work/health-live.json"
smoked_image=$(docker inspect "$name" --format '{{.Image}}')
test "$smoked_image" = "$(jq -r '.[0].Id' "$work/web-image.json")"
jq --arg imageId "$smoked_image" '. + {imageId: $imageId}' "$work/health-live.json" > "$work/health.json"
curl -fsS --max-time 6 "http://127.0.0.1:$port/app/active-research" | grep -F 'id="root"' >/dev/null
docker exec "$name" sh -c 'grep -lF ".obs-ringbox [data-ring-label]" /app/apps/web/dist/assets/ActiveResearchPage-*.css >/dev/null'
docker exec "$name" sh -c 'grep -lF "dataset.ringLabel" /app/apps/web/dist/assets/RingCanvas-*.js >/dev/null'
echo "Web server, SPA route and both built assets verified"

need "$((12 * gib))"
docker save "$reference" | gzip -1 > "$out/images.tar.gz"
python3 "$work/package-web.py" "$work" "$out"
( cd "$out" && sha256sum -c web.tar.gz.sha256 )
