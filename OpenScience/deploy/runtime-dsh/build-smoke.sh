#!/usr/bin/env bash
# Build-time proof that the seeded profile BOOTS — not merely that it composes.
#
# Every check this step replaced asserted a mechanism: a native binding exists,
# `--dump-config` is non-empty, a relocated copy still dumps. All three passed
# on an image whose bundle could not be imported at all, because none of them
# ever imports a plugin. `--dump-config` reads configuration; booting is what
# runs code. Five separate defects reached a real container behind that gap —
# a credentials file one schema out of date, two missing runtime dependencies,
# a storage domain named with a hyphen the harness rejects, and a probe calling
# the shell executor with a raw request instead of a resolved spec.
#
# So this boots the real composition against a throwaway credentials file and a
# scratch DSH_HOME, and fails the build on any entry that did not apply.
set -euo pipefail

profile=evimed-runtime
home="$(mktemp -d)"
log="$(mktemp)"
trap 'rm -rf "${home}" "${log}" "${unusable_cache:-}"' EXIT

cp -a "${DSH_HOME_SEED}/." "${home}/"
chmod -R u+w "${home}"

# Not a credential: the boot must reach the plugin tree, and the credentials
# provider refuses to load a file it cannot parse. Nothing here is ever used to
# reach a network — the smoke boot is killed before a session exists.
cat > "${home}/.credentials.yaml" <<'CRED'
version: 1
refs:
  EVIMED_WORKLOAD_TOKEN: 'build-smoke-not-a-credential'
CRED
chmod 600 "${home}/.credentials.yaml"

# The deployment-owned settings the preset rows read. Values are the shipped
# defaults; this proves the rows bind, not that a particular deployment is
# configured.
export EVIMED_CAPABILITIES_DIR=/opt/evimed/capabilities
export EVIMED_CAPABILITY_SKILLS_DIR=/opt/evimed/capability-skills
export EVIMED_CAPSULE_METHODS_DIR="" EVIMED_CAPSULE_GATEWAY_URL=""
export EVIMED_WORKLOAD_TOKEN_FILE="${home}/evimed-workload.token"
export EVIMED_BUNDLE_VERSION="${SOCKET_VERSION:-0.1.0}"
export EVIMED_ASK_USER=0 EVIMED_CAPSULE_ACTIVE=0 EVIMED_REVIEW_ENABLED=1
export EVIMED_DELIVERY_ATTEMPT_LIMIT=3 EVIMED_MAX_PARALLEL_CHILDREN=30
export EVIMED_MAX_STEPS=0 EVIMED_MAX_TOKENS=0
export EVIMED_EVIDENCE_STALE_MINUTES=10 EVIMED_SCREENING_BATCH_SIZE=50
export DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE=workspace-write
: > "${EVIMED_WORKLOAD_TOKEN_FILE}"

# The runtime mounts a tmpfs over /tmp, and Docker's `--tmpfs` implies `noexec`.
# A build cannot mount one, so this reproduces the consequence directly: point
# the loader addon's native cache at a directory it cannot use, which is what a
# noexec mount amounts to from its side. With `NARB_DISABLE_NATIVE_CACHE=1` the
# cache is not consulted at all and this changes nothing; without it, the addon
# fails to load, the plugin loader loses its resolver, and every plugin of ours
# becomes "Cannot find package '@evimed/dsh-socket'" — which is exactly the
# failure that reached a real container while three build-time checks stayed
# green.
unusable_cache="$(mktemp -d)"
chmod 0500 "${unusable_cache}"
export NARB_NATIVE_CACHE_DIR="${unusable_cache}"

# The fixture already sets `requiredEnforcement: partial` (see its header): the
# shipped default is `full`, and relaxing it for the smoke keeps the assertion
# about "every entry applied" rather than about the kernel of whatever machine
# built the image. A builder that happens to have full Landlock still passes.
patch=/usr/local/share/evimed/build-smoke-patch.yml

set +e
DSH_HOME="${home}" timeout 60 dsh --profile "${profile}" --patch "${patch}" \
  --no-open --port "${SMOKE_PORT:-45999}" --trusted-host dsh.runtime > "${log}" 2>&1
status=$?
set -e


# A clean boot serves until `timeout` kills it: exit 124. Any other exit means
# it died on its own, and the log says why.
if grep -q "failed to apply loader entry" "${log}" || [ "${status}" -ne 124 ]; then
  echo "build smoke: the seeded profile did not boot (exit ${status})" >&2
  echo "  (the addon cache was deliberately made unusable; see the note above)" >&2
  sed -n '1,80p' "${log}" >&2
  exit 1
fi
echo "build smoke: profile ${profile} booted with every entry applied"
