#!/usr/bin/env bash
# r1128a: the Web image for 研究光环 (PR #24) as one delta on the serving Web image of evimed-633b5b1e6ba2-1.
# Only the frontend and one metadata block of deps-version.json changed since the serving source; the server, runtime,
# dependency and image inputs did not, so the serving image's /app/apps/web/dist and /app/deps-version.json are replaced.
set -euo pipefail
umask 077
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$(git rev-parse HEAD)" = "$PRODUCT_REVISION"
test -z "$(git status --porcelain)"
base=633b5b1e6ba2658d93f96e95d40055e105797ac7
base_run=45935619330
base_artifact=15170865706
base_sha=sha256:982deb0592bf68f0f1df2c888d77231d4e5f74a4b6ba2f2feccd9baaadb75dd8
base_config=sha256:2ce4f8f1aa50964b2bab934000320e0c747841d341194eb8ca331e6e563a8b1c
base_ref="open-science-web:ci-$base_run-1"
release="evimed-${PRODUCT_REVISION:0:12}-$GITHUB_RUN_ATTEMPT"
reference="open-science-web:ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
created="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
export release reference created
work="$RUNNER_TEMP/r1128a-web"
out="$RUNNER_TEMP/evimed-web-delta"
install -d "$out" "$work/context" "$work/base"
gib=$((1024 ** 3))
free() { df -B1 --output=avail "$1" | tail -1; }
need() { test "$(free "$RUNNER_TEMP")" -ge "$1" && test "$(free "$(docker info --format '{{.DockerRootDir}}')")" -ge "$1"; }
need "$((16 * gib))"

git fetch --no-tags --depth=1 origin "$base"
git diff --name-only "$base" "$PRODUCT_REVISION" | LC_ALL=C sort > "$work/changed"
cat > "$work/expected" <<'LIST'
NOTICE
OpenScience/DESIGN.md
OpenScience/PROGRESS.md
OpenScience/apps/web/public/licenses/HALOFLUX.txt
OpenScience/apps/web/public/static/haloflux/sw421k.mp3
OpenScience/apps/web/src/app/designTokens.test.ts
OpenScience/apps/web/src/app/routes/ActiveResearchPage.test.tsx
OpenScience/apps/web/src/app/routes/ActiveResearchPage.tsx
OpenScience/apps/web/src/app/routes/RunFilePage.tsx
OpenScience/apps/web/src/components/activeResearch/ResearchObservatory.css
OpenScience/apps/web/src/components/activeResearch/ResearchObservatory.test.tsx
OpenScience/apps/web/src/components/activeResearch/ResearchObservatory.tsx
OpenScience/apps/web/src/components/activeResearch/ResearchPresentation.tsx
OpenScience/apps/web/src/components/activeResearch/haloflux/HaloFluxConsole.tsx
OpenScience/apps/web/src/components/activeResearch/haloflux/haloFluxPanels.ts
OpenScience/apps/web/src/components/activeResearch/haloflux/haloFluxScene.test.ts
OpenScience/apps/web/src/components/activeResearch/haloflux/haloFluxScene.ts
OpenScience/apps/web/src/components/activeResearch/haloflux/haloflux.css
OpenScience/apps/web/src/components/activeResearch/haloflux/useHaloFluxMusic.ts
OpenScience/apps/web/src/vendor/haloflux/stage.js
OpenScience/deps-version.json
OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md
OpenScience/scripts/dev/vendor-haloflux.mjs
LIST
LC_ALL=C sort "$work/expected" | diff -u - "$work/changed"
# deps-version.json moved only in its $visualizations block, which nothing in the image reads.
python3 - "$base" <<'PY'
import json, subprocess, sys
old = json.loads(subprocess.check_output(["git", "show", f"{sys.argv[1]}:OpenScience/deps-version.json"]))
new = json.load(open("OpenScience/deps-version.json"))
assert {k for k in old.keys() | new.keys() if old.get(k) != new.get(k)} == {"$visualizations"}, "deps-version.json moved beyond $visualizations"
PY

test "$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$base_run" --jq '.conclusion')" = success
printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" \
  | curl --config - --proto =https -fsS --max-time 15 --dump-header - --output /dev/null \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/artifacts/$base_artifact/zip" \
  | python3 -c 'import sys,urllib.parse; url,=[line.split(":",1)[1].strip() for line in sys.stdin if line.lower().startswith("location:")]; assert urllib.parse.urlsplit(url).hostname.endswith(".blob.core.windows.net"); print("url = \"" + url + "\"")' \
  | curl --config - --proto =https -fsS --max-time 480 --max-filesize 400000000 -o "$work/base.zip"
test "sha256:$(sha256sum "$work/base.zip" | cut -d' ' -f1)" = "$base_sha"
python3 - "$work/base.zip" "$work/base" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = {item.filename for item in archive.infolist()}
    assert names == {"web.tar.gz", "web.tar.gz.sha256", "web.tar.json", "manifest.json", "prepared-export.json", "health.json"}, names
    for name in ("web.tar.gz", "web.tar.json"):
        archive.extract(name, sys.argv[2])
PY
mv "$work/base/web.tar.json" "$work/base-web.tar.json"
test "$(jq -r .webArchiveSha256 "$work/base-web.tar.json")" = "sha256:$(sha256sum "$work/base/web.tar.gz" | cut -d' ' -f1)"
test "$(jq -r .sourceRevision "$work/base-web.tar.json")" = "$base"
test "$(jq -r .configDigest "$work/base-web.tar.json")" = "$base_config"
test "$(jq -r .reference "$work/base-web.tar.json")" = "$base_ref"
need "$((12 * gib))"
docker load < "$work/base/web.tar.gz"
docker image inspect "$base_ref" > "$work/base-image.json"
python3 - "$work" <<'PY'
import json, sys
from pathlib import Path
w = Path(sys.argv[1])
receipt = json.loads((w/"base-web.tar.json").read_text())
actual = json.loads((w/"base-image.json").read_text())[0]
assert actual["Id"] == receipt["configDigest"]
assert actual["RootFS"]["Layers"] == receipt["image"]["diffIds"]
assert actual["Config"]["Labels"]["org.opencontainers.image.revision"] == receipt["sourceRevision"]
PY
rm -rf -- "$work/base.zip" "$work/base"
# The frontend in the serving image is apps/web/dist alone, and its deps-version.json is the serving source's.
docker run --rm --network none --entrypoint sh "$base_ref" -c 'ls -A /app/apps/web' | tr -d '\r' > "$work/base-web-entries"
test "$(cat "$work/base-web-entries")" = dist
docker run --rm --network none --entrypoint cat "$base_ref" /app/deps-version.json > "$work/base-deps.json"
git show "$base:OpenScience/deps-version.json" | cmp - "$work/base-deps.json"

context="$work/context"
cp -a OpenScience/apps/web/dist "$context/dist"
cp OpenScience/deps-version.json "$context/deps-version.json"
test "$(du -sb "$context" | cut -f1)" -le "$((48 * 1024 ** 2))"
cat > "$context/Dockerfile" <<EOF
FROM $base_ref
RUN rm -rf /app/apps/web/dist
COPY dist /app/apps/web/dist
COPY deps-version.json /app/deps-version.json
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

name=r1128a-web-smoke
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
# The console's styles, its music key, the vendored stage and the bundled track, served by the server itself.
docker exec "$name" sh -c 'grep -lF ".hf-panels" /app/apps/web/dist/assets/*.css >/dev/null'
docker exec "$name" sh -c 'grep -lF "evimed.haloflux.music" /app/apps/web/dist/assets/*.js >/dev/null'
docker exec "$name" sh -c 'grep -lF "REF.SCENE 07" /app/apps/web/dist/assets/*.js >/dev/null'
docker exec "$name" sh -c 'test -s /app/apps/web/dist/licenses/HALOFLUX.txt'
test "$(curl -fsS --max-time 20 "http://127.0.0.1:$port/static/haloflux/sw421k.mp3" | sha256sum | cut -d' ' -f1)" = \
  "$(sha256sum OpenScience/apps/web/public/static/haloflux/sw421k.mp3 | cut -d' ' -f1)"
docker exec "$name" sh -c 'grep -qF "\"regenerate\"" /app/deps-version.json'
echo "Web server, SPA route, the console assets and the bundled track verified"

need "$((12 * gib))"
docker save "$reference" | gzip -1 > "$out/images.tar.gz"
python3 "$work/package-web.py" "$work" "$out"
( cd "$out" && sha256sum -c web.tar.gz.sha256 )
