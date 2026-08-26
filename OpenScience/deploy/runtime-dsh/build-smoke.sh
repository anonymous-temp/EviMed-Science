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
# The agent preset the control plane asks for by name. Kept beside the profile
# so a rename shows up here rather than in a failed session in production.
profile_preset=evimed-universal
home="$(mktemp -d)"
log="$(mktemp)"
trap 'rm -rf "${home}" "${log}" "${unusable_cache:-}" "${workspace:-}"' EXIT

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
# The skill roots the preset composes into absolute paths. Asserted below,
# because a wrong value here is not an error: the loader simply finds no skills,
# and a run degrades in a way that reads as the model ignoring its instructions.
export EVIMED_PRESET_SKILLS_DIR=/opt/evimed/socket/presets/evimed-universal/skills
for root in core curated-scientific office community; do
  [ -d "${EVIMED_PRESET_SKILLS_DIR}/${root}" ] || {
    echo "build smoke: skill root ${root} is missing under ${EVIMED_PRESET_SKILLS_DIR}" >&2
    exit 1
  }
done
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

port="${SMOKE_PORT:-45999}"
workspace="$(mktemp -d)"

DSH_HOME="${home}" dsh --profile "${profile}" --patch "${patch}" \
  --no-open --port "${port}" --trusted-host dsh.runtime > "${log}" 2>&1 &
kernel=$!

fail() {
  echo "build smoke: $1" >&2
  echo "  (the addon cache was deliberately made unusable; see the note above)" >&2
  grep -vE '^[[:space:]]+at |ExperimentalWarning|--trace-warnings' "${log}" | sed -n '1,60p' >&2
  kill "${kernel}" 2>/dev/null || true
  exit 1
}

# Boot takes about a minute: composing the plugin tree is most of it.
for _ in $(seq 1 90); do
  kill -0 "${kernel}" 2>/dev/null || fail "the seeded profile did not boot"
  grep -q "dsh web: " "${log}" && break
  sleep 2
done
grep -q "failed to apply loader entry" "${log}" && fail "an entry did not apply"
# A patch row naming a target the composition does not have is a WARNING in the
# kernel and the boot continues without it. That is the exact shape of "a plugin
# is silently absent": the row was written, the image was built, the container
# started, and the capability it configures is simply not there. Both spellings
# come from the installed kernel: "patch: entry %C not found" (replace) and
# "patch insert: entry %C not found" (insert).
grep -qE "patch( insert)?: entry .* not found" "${log}" \
  && fail "a patch row names an entry the composition does not have; the kernel warned and carried on without it"
grep -q "dsh web: " "${log}" || fail "the kernel never began serving"

# Creating a session is the second half of the proof, and it is the half that
# matters most.
#
# Booting validates the HOST composition. Our preset is mounted in AGENT scope,
# so none of its rows are touched until a session exists — three defects reached
# a real container through that gap: a preset the kernel could not see, a
# permission pair matching no preset, and a required key on `tool-fs-search`
# with no default. Every one of them was invisible to a boot-only check and
# obvious the instant a session was requested.
#
# Same wire shape the control plane uses: POST /api/<method> with a
# client-request envelope, Host set to the declared trusted host.
session_probe=$(cat <<PROBE
import json, sys, urllib.error, urllib.request
body = json.dumps({
    "type": "client-request",
    "rpcId": "rpc_build_smoke",
    "method": "session.create",
    "payload": {"cwd": "${workspace}", "agentPreset": "${profile_preset}"},
}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:${port}/api/session.create",
    data=body,
    headers={"content-type": "application/json", "Host": "dsh.runtime"},
)
try:
    envelope = json.load(urllib.request.urlopen(request, timeout=60))
except urllib.error.HTTPError as error:
    print("HTTP %s: %s" % (error.code, error.read().decode("utf-8", "replace")[:800]))
    sys.exit(1)
except Exception as error:
    print("%s: %s" % (type(error).__name__, error))
    sys.exit(1)
result = envelope.get("result") or {}
if not result.get("ok"):
    print(json.dumps(result.get("error"), ensure_ascii=False)[:800])
    sys.exit(1)
print("session " + str((result.get("value") or {}).get("sessionId", "?")))
PROBE
)
if ! session_output=$(python3 -c "${session_probe}" 2>&1); then
  echo "build smoke: the preset would not mount a session — ${session_output}" >&2
  kill "${kernel}" 2>/dev/null || true
  exit 1
fi

kill "${kernel}" 2>/dev/null || true
wait "${kernel}" 2>/dev/null || true
rm -rf "${workspace}"
echo "build smoke: profile ${profile} booted with every entry applied, and mounted a ${profile_preset} session (${session_output})"
