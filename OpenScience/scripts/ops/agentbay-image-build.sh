#!/usr/bin/env bash
# Build the EviMed runtime as an AgentBay CodeSpace image and register it
# (plan §3.1 #2). The integrator runs this; it is the AgentBay CLI's own
# documented flow, made one command:
#
#   1. `agentbay image init -i <system image>` downloads the Dockerfile
#      template, whose first lines are system-defined and may not be changed;
#   2. those lines, verbatim, replace the stand-in header of
#      deploy/runtime-dsh/Dockerfile.agentbay, and the result is checked
#      against AgentBay's rules (one FROM, in the header; no CMD; ends as root);
#   3. `agentbay docker login` logs local docker into the account's registry;
#   4. `docker build` (linux/amd64 — the only architecture AgentBay runs) and
#      `docker push`;
#   5. `agentbay image create-from-template` registers the pushed image, the
#      script waits for it to become available, and with --activate activates
#      it at the plan's 4 CPU / 8 GB with the lifecycle the provider also sets
#      per session.
#
# The last line printed is the image id to set as OPEN_SCIENCE_AGENTBAY_IMAGE_ID.
#
# The CLI authenticates with the account's AccessKey (`agentbay login`, or
# AGENTBAY_ACCESS_KEY_ID / AGENTBAY_ACCESS_KEY_SECRET in the environment), not
# with the control plane's API key, which this script never reads. It prints no
# credential: of the login output only the registry path is kept.
#
# Usage:
#   scripts/ops/agentbay-image-build.sh --tag <tag> [--base <system image>]
#     [--name <image name>] [--activate]
#     [--release-id <id>] [--source-revision <rev>] [--build-created <rfc3339>]
#
#   --base   code-space-debian-12 (default), code-space-debian-12-enhanced or
#            aio-ubuntu-2404
#
# Build mirrors pass through from the environment when set, under the build
# argument's own name: APT_MIRROR, DEBIAN_SECURITY_MIRROR, UBUNTU_APT_MIRROR,
# NPM_REGISTRY, PIP_INDEX_URL, NODE_DIST_BASE, GITHUB_DOWNLOAD_PREFIX,
# PLAYWRIGHT_DOWNLOAD_HOST.
set -euo pipefail

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-64}"; }

base=code-space-debian-12
tag=""
name=""
activate=0
release_id=untracked
source_revision=unknown
build_created=1970-01-01T00:00:00.000Z
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) base="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    --name) name="${2:?}"; shift 2 ;;
    --activate) activate=1; shift ;;
    --release-id) release_id="${2:?}"; shift 2 ;;
    --source-revision) source_revision="${2:?}"; shift 2 ;;
    --build-created) build_created="${2:?}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
case "${base}" in code-space-debian-12|code-space-debian-12-enhanced|aio-ubuntu-2404) ;; *) echo "unsupported base image: ${base}" >&2; exit 64 ;; esac
[[ "${tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "--tag is required and must be a docker tag" >&2; exit 64; }
name="${name:-evimed-runtime-${tag}}"
for tool in agentbay docker; do
  command -v "${tool}" >/dev/null || { echo "${tool} is not on PATH" >&2; exit 69; }
done

repo="$(cd "$(dirname "$0")/../.." && pwd)"
dockerfile="${repo}/deploy/runtime-dsh/Dockerfile.agentbay"
marker='^# ---- end of the AgentBay template header'
grep -qE "${marker}" "${dockerfile}" || { echo "${dockerfile} has lost its template marker" >&2; exit 65; }
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

echo "=== template: ${base} ==="
(cd "${work}" && agentbay image init --sourceImageId "${base}") > "${work}/init.log" 2>&1 || { cat "${work}/init.log" >&2; exit 1; }
lines="$(sed -nE 's/.*The first ([0-9]+) line\(s\) of the Dockerfile are system-defined.*/\1/p' "${work}/init.log" | head -n 1)"
[ -n "${lines}" ] || { echo "agentbay image init did not say how many lines are system-defined:" >&2; cat "${work}/init.log" >&2; exit 1; }
[ -s "${work}/Dockerfile" ] || { echo "agentbay image init wrote no Dockerfile" >&2; exit 1; }

generated="${work}/Dockerfile.generated"
head -n "${lines}" "${work}/Dockerfile" > "${generated}"
sed -n "/${marker#^}/,\$p" "${dockerfile}" | tail -n +2 >> "${generated}"

# AgentBay's rules, checked on what is about to be built.
header_from="$(head -n "${lines}" "${generated}" | grep -cE '^[[:space:]]*FROM[[:space:]]' || true)"
body_from="$(tail -n +"$((lines + 1))" "${generated}" | grep -cE '^[[:space:]]*FROM[[:space:]]' || true)"
[ "${header_from}" = 1 ] && [ "${body_from}" = 0 ] || { echo "the template must hold the only FROM (header ${header_from}, body ${body_from})" >&2; exit 65; }
! grep -qE '^[[:space:]]*CMD[[:space:]]' "${generated}" || { echo "an AgentBay image may not declare CMD" >&2; exit 65; }
last_user="$(grep -E '^[[:space:]]*USER[[:space:]]' "${generated}" | tail -n 1 | awk '{print $2}')"
[ -z "${last_user}" ] || [ "${last_user}" = root ] || { echo "the image must end as USER root, not ${last_user}" >&2; exit 65; }
echo "template: ${lines} system-defined line(s) kept verbatim"

echo "=== registry login ==="
agentbay docker login > "${work}/login.log" 2>&1 || { grep -v -i -E 'password|token|secret' "${work}/login.log" >&2 || true; exit 1; }
registry="$(sed -nE 's/^Image registry path:[[:space:]]+([^[:space:]]+).*/\1/p' "${work}/login.log" | head -n 1)"
rm -f "${work}/login.log"
[[ "${registry}" == */customer_cli/* ]] || { echo "agentbay docker login did not name the image registry path" >&2; exit 1; }
image="${registry}:${tag}"
short="/${registry#*/}:${tag}"
echo "registry path: ${registry}"

echo "=== build ${image} ==="
build_args=(
  --build-arg "RELEASE_ID=${release_id}"
  --build-arg "SOURCE_REVISION=${source_revision}"
  --build-arg "BUILD_CREATED=${build_created}"
)
for arg in APT_MIRROR DEBIAN_SECURITY_MIRROR UBUNTU_APT_MIRROR NPM_REGISTRY PIP_INDEX_URL NODE_DIST_BASE GITHUB_DOWNLOAD_PREFIX PLAYWRIGHT_DOWNLOAD_HOST; do
  if [ -n "${!arg:-}" ]; then build_args+=(--build-arg "${arg}=${!arg}"); fi
done
docker build --platform linux/amd64 -f "${generated}" "${build_args[@]}" -t "${image}" "${repo}"
docker push "${image}"

echo "=== register ${name} from ${base} ==="
agentbay image create-from-template --source-image "${short}" --name "${name}" --imageId "${base}" > "${work}/create.log" 2>&1 \
  || { cat "${work}/create.log" >&2; exit 1; }
image_id="$(sed -nE 's/^[[:space:]]*ImageId:[[:space:]]+(imgc-[A-Za-z0-9]+).*/\1/p' "${work}/create.log" | head -n 1)"
[ -n "${image_id}" ] || { cat "${work}/create.log" >&2; echo "no custom image id in the answer" >&2; exit 1; }
echo "custom image: ${image_id}"

# Registration builds the image server-side; it is usable once Available.
deadline=$((SECONDS + 3600))
while :; do
  status="$(agentbay image list --output json --size 100 | IMAGE_ID="${image_id}" node -e '
    let text = ""; process.stdin.on("data", (c) => (text += c)); process.stdin.on("end", () => {
      const row = (JSON.parse(text).images ?? []).find((image) => image.imageId === process.env.IMAGE_ID);
      process.stdout.write(row ? String(row.statusDisplay ?? row.status ?? "") : "missing");
    });')"
  case "${status}" in
    Available|Activated|IMAGE_AVAILABLE|IMAGE_ACTIVATED) break ;;
    *Fail*|*FAIL*) echo "${image_id} failed to build server-side: ${status}" >&2; exit 1 ;;
  esac
  [ "${SECONDS}" -lt "${deadline}" ] || { echo "${image_id} is still ${status} after an hour" >&2; exit 1; }
  sleep 30
done
echo "status: ${status}"

if [ "${activate}" = 1 ]; then
  echo "=== activate ${image_id} ==="
  # The plan's 4c8g; the same lifecycle the provider sets on every session
  # (OPEN_SCIENCE_AGENTBAY_IDLE_RELEASE_MINUTES / _MAX_RUNTIME_MINUTES).
  agentbay image activate "${image_id}" --cpu 4 --memory 8 \
    --lifecycle-mode auto --lifecycle-max-runtime 240 --lifecycle-idle-timeout 30
fi

echo "OPEN_SCIENCE_AGENTBAY_IMAGE_ID=${image_id}"
