#!/usr/bin/env bash
# Build the knowledge-source plugin's image on the serving host, from the
# plugin directory of a release tree, and say which tag to pin.
#
#   sudo host-knowledge-plugin-build.sh <RELEASE_SHORT>
#
# The plugin is its own service with its own release cadence (plan ch.14): it
# is built here only because this host has no registry to pull a team image
# from yet. The tag carries the plugin's own version and the source revision it
# was built from, so `.env`'s `EVIMED_KNOWLEDGE_PLUGIN_IMAGE` names exactly one
# build, and the platform release that ships beside it does not rebuild it.
#
# Every fetch goes to a mirror this host can reach; the direct routes stall for
# hours (tencent-host-build-mirrors).
set -euo pipefail
REL_SHORT="${1:?usage: host-knowledge-plugin-build.sh <RELEASE_SHORT>}"
ROOT="${EVIMED_ROOT:-/srv/evimed-science}"
DIR="${ROOT}/releases/${REL_SHORT}/项目代码/knowledge-plugin"
[ -f "${DIR}/Dockerfile" ] || { echo "no plugin Dockerfile under ${DIR}"; exit 1; }
VERSION=$(sed -n 's/^version *= *"\(.*\)"/\1/p' "${DIR}/pyproject.toml" | head -1)
[ -n "$VERSION" ] || { echo "no version in ${DIR}/pyproject.toml"; exit 1; }
TAG="evimed-knowledge-plugin:${VERSION}-${REL_SHORT}"
docker build -f "${DIR}/Dockerfile" \
  --build-arg PYTHON_BASE_IMAGE="${EVIMED_PYTHON_BASE_IMAGE:-docker.m.daocloud.io/library/python:3.12-slim-bookworm}" \
  --build-arg PIP_INDEX_URL="${EVIMED_PIP_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple}" \
  --build-arg PLUGIN_BUILD="${REL_SHORT}" \
  -t "$TAG" "$DIR" > "/tmp/build-knowledge-plugin-${REL_SHORT}.log" 2>&1 \
  || { echo "build failed; see /tmp/build-knowledge-plugin-${REL_SHORT}.log"; exit 1; }
docker image inspect "$TAG" --format "${TAG} id={{.Id}} size={{.Size}}"
echo "pin it: EVIMED_KNOWLEDGE_PLUGIN_IMAGE=${TAG}"
