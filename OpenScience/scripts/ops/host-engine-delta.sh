#!/usr/bin/env bash
# Rebuild the specialist engine images of one release as deltas of the images
# the services run now, and point the release's .env at them.
#
#   host-engine-delta.sh <RELEASE_DIR> <NEW_SHORT>
#
# Why a delta: an engine release that changes only Python sources (the
# 2026-09-20 usage report every engine now sends) does not need R, the CRAN
# packages and the scientific wheels fetched and compiled again — and with the
# build cache pruned, a full build of the MR engine alone is the longest build
# this host does. Each delta is FROM the running image and COPYs the engine
# directory and the adapter package over the same paths the full Dockerfiles
# write (/agent and /adapter/evimed_specialist_adapter; /app/new_meta for the
# MetaAgent; /mcp for the drug-evidence adapter). A requirements file that
# differs from what the running image was built with is refused by name: that
# is a full build, not a delta. A requirements.lock (the pinned set a full
# build installs, compile-engine-locks.sh) that the running image does not hold
# byte for byte is installed over it in the delta: pip moves only the packages
# whose pinned version differs, from the mirror, so the first release after the
# locks landed (2026-09-28) did not have to rebuild R and the CRAN packages of
# the MR engine to adopt a pin. The lock stays in the image, so the next delta
# compares against it.
#
# Run after host-delta-release.sh has seeded <RELEASE_DIR> (with the engine
# sources in the delta archive) and before host-release-switch.sh; the switch
# recreates the services whose image changed.
set -euo pipefail
REL="${1:?release directory}"; NEW="${2:?new short revision}"
ENVF="${REL}/OpenScience/deploy/web/.env"
COMPOSE="${REL}/OpenScience/deploy/web/docker-compose.yml"
[ -f "$ENVF" ] && [ -f "$COMPOSE" ] || { echo "not a seeded release: ${REL}"; exit 1; }
cd "$REL"

# service | .env variable | compose default | engine directory (or - ) | extra COPY lines
ENGINES=$(cat <<'EOF'
evimed-mr-agent|EVIMED_MR_AGENT_IMAGE|evimed-mr-agent:1.0.0|项目代码/孟德尔随机化|
evimed-bibliometric-agent|EVIMED_BIBLIOMETRIC_AGENT_IMAGE|evimed-bibliometric-agent:1.0.0|项目代码/文献剂量分析|
evimed-research-topic-agent|EVIMED_RESEARCH_TOPIC_AGENT_IMAGE|evimed-research-topic-agent:1.0.0|项目代码/科研选题|
evimed-peer-review-agent|EVIMED_PEER_REVIEW_AGENT_IMAGE|evimed-peer-review-agent:1.0.0|项目代码/论文审稿|
evimed-drug-safety-agent|EVIMED_DRUG_SAFETY_AGENT_IMAGE|evimed-drug-safety-agent:1.0.0|项目代码/药物安全分析agent|
evimed-drug-evidence-adapter|EVIMED_DRUG_EVIDENCE_ADAPTER_IMAGE|evimed-drug-evidence-adapter:1.0.0|-|COPY OpenScience/runtime/mcp/evimed-research /mcp
EOF
)

current_image() { # variable default
  local value
  value=$(sed -n "s/^$1=//p" "$ENVF" | tail -1)
  printf '%s' "${value:-$2}"
}

next_tag() { # image → <repo>:<version>-<NEW>
  local repo="${1%:*}" tag="${1##*:}"
  printf '%s:%s-%s' "$repo" "${tag%%-*}" "$NEW"
}

same_requirements() { # image path-in-image path-in-release: unreadable counts as different
  local tmp status=1; tmp=$(mktemp)
  if docker run --rm --entrypoint cat "$1" "$2" > "$tmp" 2>/dev/null && cmp -s "$tmp" "$3"; then status=0; fi
  rm -f "$tmp"; return "$status"
}

same_inputs() { # image dir-in-image dir-in-release: requirements.txt; a differing lock is installed, not refused
  same_requirements "$1" "$2/requirements.txt" "$3/requirements.txt"
}

lock_differs() { # image dir-in-image dir-in-release: the release carries a lock the image does not hold
  [ -f "$3/requirements.lock" ] || return 1
  ! same_requirements "$1" "$2/requirements.lock" "$3/requirements.lock"
}

PIP_INDEX_URL="${EVIMED_PIP_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple}"

set_env() { # variable value
  if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else printf '%s=%s\n' "$1" "$2" >> "$ENVF"; fi
}

while IFS='|' read -r service variable fallback agent extra; do
  [ -n "$service" ] || continue
  base=$(current_image "$variable" "$fallback")
  docker image inspect "$base" > /dev/null || { echo "${service}: running image ${base} is not on this host; refusing"; exit 1; }
  target=$(next_tag "$base")
  # The full builds install from /tmp copies and delete them; the copies that
  # stay are the ones under /agent and /adapter.
  if [ "$agent" != "-" ]; then
    same_inputs "$base" /agent "${agent}" \
      || { echo "${service}: ${agent}/requirements.txt differs from the running image's; build it in full"; exit 1; }
    same_requirements "$base" /adapter/requirements.txt OpenScience/deploy/specialist-adapter/requirements.txt \
      || { echo "${service}: the adapter's requirements differ from the running image's; build it in full"; exit 1; }
  else
    # The drug-evidence adapter installs the adapter's lock itself.
    same_inputs "$base" /adapter OpenScience/deploy/specialist-adapter \
      || { echo "${service}: the adapter's requirements differ from the running image's; build it in full"; exit 1; }
  fi
  agent_lock=0; adapter_lock=0
  if [ "$agent" != "-" ] && lock_differs "$base" /agent "${agent}"; then agent_lock=1; fi
  if [ "$agent" = "-" ] && lock_differs "$base" /adapter OpenScience/deploy/specialist-adapter; then adapter_lock=1; fi
  {
    printf 'FROM %s\n' "$base"
    if [ "$service" = "evimed-mr-agent" ]; then
      # Code-only deltas previously left PLINK absent in an otherwise current
      # MR image. Derive the package pin from the full build's single source.
      mr_plink_version=$(sed -n 's/^ARG MR_PLINK_VERSION=//p' OpenScience/deploy/specialist-adapter/Dockerfile)
      [[ "$mr_plink_version" =~ ^[0-9A-Za-z.+:~_-]+$ ]] || { echo 'invalid MR PLINK package pin' >&2; exit 1; }
      printf 'RUN apt-get update && apt-get install -y --no-install-recommends plink1.9=%s && plink1.9 --version && rm -rf /var/lib/apt/lists/*\n' "$mr_plink_version"
    fi
    if [ "$agent" != "-" ]; then printf 'COPY %s /agent\n' "$agent"; fi
    printf 'COPY OpenScience/deploy/specialist-adapter/evimed_specialist_adapter /adapter/evimed_specialist_adapter\n'
    # Re-pin the adapter manifest for the package this delta ships, as the full
    # build does: the MR engine compares the two before admitting a job, and a
    # changed package under the base image's manifest refuses every MR start
    # with audit_adapter_manifest_changed.
    if [ "$agent_lock" = 1 ]; then printf 'RUN pip install --index-url %s --no-cache-dir -r /agent/requirements.lock\n' "$PIP_INDEX_URL"; fi
    printf 'COPY OpenScience/deploy/specialist-adapter/Dockerfile OpenScience/deploy/specialist-adapter/Dockerfile.evidence OpenScience/deploy/specialist-adapter/requirements.txt /adapter/\n'
    if [ "$adapter_lock" = 1 ]; then
      printf 'COPY OpenScience/deploy/specialist-adapter/requirements.lock /adapter/requirements.lock\n'
      printf 'RUN pip install --index-url %s --no-cache-dir -r /adapter/requirements.lock\n' "$PIP_INDEX_URL"
    fi
    printf 'RUN rm -f /adapter/adapter-evidence.json && python -m evimed_specialist_adapter.audit_receipt --write-adapter-manifest /adapter/adapter-evidence.json\n'
    if [ -n "$extra" ]; then printf '%s\n' "$extra"; fi
  } > "/tmp/engine-delta-${service}.Dockerfile"
  docker build -q -f "/tmp/engine-delta-${service}.Dockerfile" -t "$target" . > /dev/null
  set_env "$variable" "$target"
  echo "${service}: ${base} -> ${target} ($(docker image inspect -f '{{.Id}}' "$target" | cut -c1-19))$([ "$agent_lock$adapter_lock" != 00 ] && echo ' lock installed')"
done <<< "$ENGINES"

# The MetaAgent is its own image (项目代码/meta, Dockerfile.evimed): only its
# package is replaced.
base=$(current_image EVIMED_META_AGENT_IMAGE evimed-meta-agent:0.9.0)
docker image inspect "$base" > /dev/null || { echo "evimed-meta-agent: running image ${base} is not on this host; refusing"; exit 1; }
same_inputs "$base" /app 项目代码/meta \
  || { echo "evimed-meta-agent: requirements.txt differs from the running image's; build it in full"; exit 1; }
target=$(next_tag "$base")
printf 'FROM %s\nCOPY new_meta /app/new_meta\n' "$base" > /tmp/engine-delta-evimed-meta-agent.Dockerfile
if lock_differs "$base" /app 项目代码/meta; then
  printf 'COPY requirements.lock /app/requirements.lock\nRUN pip install --index-url %s --no-cache-dir -r /app/requirements.lock\n' "$PIP_INDEX_URL" >> /tmp/engine-delta-evimed-meta-agent.Dockerfile
fi
docker build -q -f /tmp/engine-delta-evimed-meta-agent.Dockerfile -t "$target" 项目代码/meta > /dev/null
set_env EVIMED_META_AGENT_IMAGE "$target"
echo "evimed-meta-agent: ${base} -> ${target} ($(docker image inspect -f '{{.Id}}' "$target" | cut -c1-19))"
echo "=== engine images point at ${NEW}; the switch recreates their services ==="
