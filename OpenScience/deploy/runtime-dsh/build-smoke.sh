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

# Prove the image works as an unprivileged runtime user. Root can read a
# private manifest that the deployed container cannot (the plugin manager
# writes package.json with mode 0600).
if [ "$(id -u)" -eq 0 ]; then
  exec runuser -u nobody -- "$0" "$@"
fi

profile=evimed-runtime
# The agent preset the control plane asks for by name. Kept beside the profile
# so a rename shows up here rather than in a failed session in production.
profile_preset=evimed-universal
smoke_home="$(mktemp -d)"
log="$(mktemp)"
trap 'rm -rf "${smoke_home}" "${log}" "${unusable_cache:-}" "${workspace:-}"' EXIT
export HOME="${smoke_home}/home" XDG_CONFIG_HOME="${smoke_home}/xdg-config" XDG_DATA_HOME="${smoke_home}/xdg-data"
export XDG_CACHE_HOME="${smoke_home}/xdg-cache" XDG_STATE_HOME="${smoke_home}/xdg-state"
mkdir -p "${HOME}" "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${XDG_CACHE_HOME}" "${XDG_STATE_HOME}"

node /usr/local/bin/evimed-profile-seed.mjs sync "${DSH_HOME_SEED}" "${smoke_home}" "${profile}"

# Not a credential: the boot must reach the plugin tree, and the credentials
# provider refuses to load a file it cannot parse. Nothing here is ever used to
# reach a model — the smoke creates a session but never submits a prompt.
#
# The browser-session grant is a real one, minted here for this boot only. Since
# 0.1.2-alpha.5 the web surface refuses an unauthenticated call — the probe
# below returned "HTTP 401: unauthorized" and the whole build stopped on it —
# where alpha.3 accepted a request whose Host matched `--trusted-host`. The
# control plane has always authenticated with this cookie in production, so
# minting one here makes the smoke resemble a real session rather than a
# special case that stopped working the moment upstream tightened the surface.
#
# Shapes must match apps/server/src/dshBrowserAuth.mjs and the file layout
# `dshProfilePatch.mjs` writes. They are re-derived rather than imported because
# this script runs inside the image, where the control plane's source is not
# present; the wire is the contract, and `apps/server/test/deploy.test.mjs`
# holds the two spellings together.
#
# The grant is a `records:` entry, not a top-level key. Written at the top level
# it fails the whole plugin tree at boot with `unknown top-level key` — which is
# the credential store refusing loudly rather than ignoring what it cannot
# place, and is the behaviour that caught this.
smoke_secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
smoke_cookie="$(SMOKE_SECRET="${smoke_secret}" SMOKE_AUTHORITY=dsh.runtime node -e '
  const c = require("node:crypto");
  const b64 = (b) => Buffer.from(b).toString("base64url");
  const authority = process.env.SMOKE_AUTHORITY;
  const name = "dsh-auth-" + b64(c.createHash("sha256").update(authority).digest());
  const now = Date.now();
  const body = b64(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 86400000 })));
  const sig = b64(c.createHmac("sha256", Buffer.from(process.env.SMOKE_SECRET, "base64url")).update(body).digest());
  process.stdout.write(name + "=v1." + body + "." + sig);
')"

cat > "${smoke_home}/.credentials.yaml" <<CRED
version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: '${smoke_secret}'
refs:
  EVIMED_WORKLOAD_TOKEN: 'build-smoke-not-a-credential'
CRED
chmod 600 "${smoke_home}/.credentials.yaml"

# The deployment-owned settings the preset rows read. Values are the shipped
# defaults; this proves the rows bind, not that a particular deployment is
# configured.
# The skill roots the preset composes into absolute paths. Asserted below,
# because a wrong value here is not an error: the loader simply finds no skills,
# and a run degrades in a way that reads as the model ignoring its instructions.
export EVIMED_PRESET_SKILLS_DIR=/opt/evimed/socket/presets/evimed-universal/skills
for root in core curated-scientific office community evimed geo-private; do
  [ -d "${EVIMED_PRESET_SKILLS_DIR}/${root}" ] || {
    echo "build smoke: skill root ${root} is missing under ${EVIMED_PRESET_SKILLS_DIR}" >&2
    exit 1
  }
done

# And one curated skill actually RUNS, from the declared root, the way a skill
# body now says to reach it.
#
# The loop above asserts a mechanism: the directory is there. That is the exact
# class of check this whole file was written to replace — every skill root
# existed on the day 45 skill bodies were pointing at
# $XDG_CONFIG_HOME/opencode, a path this image has never had. Existence proved
# nothing, because nothing here had ever executed one.
#
# Skill bodies reference `../_runtime/execute_skill.py` relative to their own
# directory; the roots are declared in @evimed/domain and stated to the run in
# the guidance block. This resolves that reference the same way and runs it.
curated_root=/usr/local/share/evimed/skills/curated-scientific
[ -x "$(command -v python3)" ] || { echo "build smoke: python3 missing" >&2; exit 1; }
[ -f "${curated_root}/_runtime/execute_skill.py" ] || {
  echo "build smoke: ${curated_root}/_runtime/execute_skill.py is absent — the shared executor every curated skill calls as ../_runtime/execute_skill.py" >&2
  exit 1
}
# Resolved exactly as a skill would: from the skill's own directory, relatively.
smoke_skill="${curated_root}/exploratory-data-analysis"
[ -d "${smoke_skill}" ] || { echo "build smoke: ${smoke_skill} is absent" >&2; exit 1; }
if ! (cd "${smoke_skill}" && python3 ../_runtime/execute_skill.py --help >/dev/null 2>&1); then
  echo "build smoke: a curated skill could not run its shared executor from the declared root." >&2
  echo "  tried: cd ${smoke_skill} && python3 ../_runtime/execute_skill.py --help" >&2
  echo "  this is the reference every curated SKILL.md now carries; if it fails here it fails in every run." >&2
  exit 1
fi

export EVIMED_CAPABILITIES_DIR=/opt/evimed/capabilities
export EVIMED_CAPABILITY_SKILLS_DIR=/opt/evimed/capability-skills
# The evidence method. It is no longer a persona the guidance plugin injects
# into every session (2026-10-12): it is a skill the model loads when the
# question is medical, and the guidance names it. The Dockerfile copies exactly
# this one package out of `runtime/skills/evimed`; an image without it tells
# every medical question to load a skill that is not there.
evidence_method_dir=/opt/evimed/skills/evimed/open-domain-answer
[ -r "${evidence_method_dir}/SKILL.md" ] || {
  echo "build smoke: the evidence method skill is missing at ${evidence_method_dir}/SKILL.md" >&2
  echo "  the guidance names it for every medical question, and the model would find nothing to load." >&2
  exit 1
}
export EVIMED_CAPSULE_METHODS_DIR="" EVIMED_CAPSULE_GATEWAY_URL="" EVIMED_REVISION_AUTHORIZE_URL="" EVIMED_DISABLED_TOOLS_FILE=""
export EVIMED_PUBLIC_SOURCE_GATEWAY_URL="" EVIMED_WEB_SEARCH_GATEWAY_URL="" EVIMED_MODEL_GATEWAY_TOKEN_FILE=""
export EVIMED_PERSONAL_SKILLS_DIR=/opt/evimed/personal-skills
export EVIMED_EXTENSION_PROJECTION_FILE="" EVIMED_EXTENSION_GATEWAY_URL=""
export EVIMED_PLATFORM_SKILLS_DIR="" EVIMED_EVOLUTION_GATEWAY_URL=""
export EVIMED_WORKLOAD_TOKEN_FILE="${smoke_home}/evimed-workload.token"
export EVIMED_BUNDLE_VERSION="${SOCKET_VERSION:-0.1.0}"
export EVIMED_ASK_USER=0 EVIMED_CAPSULE_ACTIVE=0 EVIMED_REVIEW_ENABLED=1
export EVIMED_CITE_ENABLED=1 EVIMED_CITE_TIMEOUT_MS=15000 EVIMED_CITE_CONFIG_REVISION=0
export EVIMED_LOOPX_ENABLED=1 EVIMED_LOOPX_ROOT=/opt/evimed/loopx
export LOOPX_BIN=/opt/evimed/venv/bin/loopx LOOPX_USAGE_PING=0 DO_NOT_TRACK=1
export EVIMED_DELIVERY_ATTEMPT_LIMIT=3 EVIMED_MAX_CHILDREN_TOTAL=30 EVIMED_MAX_CONCURRENT_CHILDREN=30
export EVIMED_MAX_STEPS=0 EVIMED_MAX_TOKENS=0
export EVIMED_EVIDENCE_STALE_MINUTES=10 EVIMED_SCREENING_BATCH_SIZE=50
# Every socket plugin on, as a run gets it unless the deployment switches one off.
export EVIMED_DUPLICATE_LINES_ENABLED=1
export EVIMED_GUIDANCE_ENABLED=1 EVIMED_RUN_POLICY_ENABLED=1 EVIMED_EVIDENCE_ENABLED=1
export EVIMED_CAPSULE_ENABLED=1 EVIMED_CAPSULE_MEMORY_ENABLED=1 EVIMED_SCREENING_ENABLED=1 EVIMED_COMPACTION_ENABLED=1
# The compaction group reads all five, and the boot proof has to boot under
# the same environment a run gets. `basic` here is the shipped default: the
# provider swap registers nothing on it, so this proves the row loads
# without asserting a policy the deployment has not chosen. The byte guard is
# three quarters of the model gateway's default 2 MiB body limit.
export EVIMED_COMPACTION_POLICY=basic EVIMED_COMPACTION_THRESHOLD_RATIO=0.8
export EVIMED_COMPACTION_RETAIN_RATIO=0.16 EVIMED_COMPACTION_MAX_TOKENS=8192
export EVIMED_COMPACTION_MAX_REQUEST_BYTES=1572864
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
# The fixture's session store names a deployed volume. Keep the smoke's
# session data in its own scratch home so it is writable by this user and
# removed after the check instead of being baked into the image.
patch="${smoke_home}/build-smoke-patch.yml"
sed "s|'/runtime/dsh-home/sessions'|'${smoke_home}/sessions'|" \
  /usr/local/share/evimed/build-smoke-patch.yml > "${patch}"

port="${SMOKE_PORT:-45999}"

# One boot of the composition and one session on it, as a function: the proof
# runs twice, once as an ordinary account's runtime is started and once as an
# account on the native memory engine's is (below).
boot_and_probe() {
  label="$1"
  workspace="$(mktemp -d)"
  : > "${log}"
  DSH_HOME="${smoke_home}" dsh --profile "${profile}" --patch "${patch}" \
    --no-open --port "${port}" --trusted-host dsh.runtime > "${log}" 2>&1 &
  kernel=$!

  fail() {
    echo "build smoke (${label}): $1" >&2
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
  # The same failure in the kernel's other words: a row that applied but threw on activation (2026-10-12: the LoopX
  # bootstrap row on every project volume older than LoopX, `command "loopx-init" is already registered`).
  grep -q "did not activate" "${log}" && fail "an entry did not activate"
  # A patch row naming a target the composition does not have is a WARNING in the
  # kernel and the boot continues without it. That is the exact shape of "a plugin
  # is silently absent": the row was written, the image was built, the container
  # started, and the capability it configures is simply not there. Both spellings
  # come from the installed kernel: "patch: entry %C not found" (replace) and
  # "patch insert: entry %C not found" (insert).
  grep -qE "patch( insert)?: entry .* not found" "${log}" \
    && fail "a patch row names an entry the composition does not have; the kernel warned and carried on without it"
  # A bundle whose patch file cannot be read is skipped whole, and the kernel serves without it.
  grep -q "skipping profile bundle" "${log}" && fail "a profile bundle was skipped"
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
  #
  # `session/create`, slashed, and the arguments nested under `args.request` —
  # the shape `dshRuntimeAdapter` uses. 0.1.2 renamed every method from dotted to
  # slashed (the seam manifest records it), and this script kept the old spelling
  # because nothing here had ever reached a method: the boot failed earlier, so
  # `session.create` was never called until the auth above started working. It
  # then answered 404, which is the honest reply to a route that no longer
  # exists.
  #
  # The kernel's own plugin inventory, read on the same wire, says whether the
  # two memory rows are what this boot's environment asks for: the official
  # OpenViking plugin's row present and off for an ordinary account, and on and
  # active, behind an active bridge, for an account on the native engine.
  session_probe=$(cat <<PROBE
import json, sys, urllib.error, urllib.request
def call(method, args):
    body = json.dumps({"type": "client-request", "rpcId": "rpc_build_smoke", "method": method, "payload": {"args": args}}).encode()
    request = urllib.request.Request(
        "http://127.0.0.1:${port}/api/" + method,
        data=body,
        headers={"content-type": "application/json", "Host": "dsh.runtime", "Cookie": "${smoke_cookie}"},
    )
    envelope = json.load(urllib.request.urlopen(request, timeout=60))
    result = envelope.get("result") or {}
    if not result.get("ok"):
        raise RuntimeError(json.dumps(result.get("error"), ensure_ascii=False)[:800])
    return result.get("value") or {}
try:
    session = call("session/create", {"request": {"cwd": "${workspace}", "agentPreset": "${profile_preset}"}})
    entries = {entry.get("entryId"): entry for entry in call("pluginInventory/list", {}).get("entries", [])}
except urllib.error.HTTPError as error:
    print("HTTP %s: %s" % (error.code, error.read().decode("utf-8", "replace")[:800]))
    sys.exit(1)
except Exception as error:
    print("%s: %s" % (type(error).__name__, error))
    sys.exit(1)
memory = entries.get("include:openviking-memory-runtime")
bridge = entries.get("include:evimed-memory-bridge")
if memory is None or bridge is None:
    print("the OpenViking memory row or the memory bridge row is not in the composition")
    sys.exit(1)
native = "${EVIMED_MEMORY_GATEWAY_URL:-}" != ""
if native and not (memory.get("enabled") and memory.get("fiberPhase") == "active" and bridge.get("fiberPhase") == "active"):
    print("native memory: the OpenViking row is %s/%s behind a bridge %s" % (memory.get("enabled"), memory.get("fiberPhase"), bridge.get("fiberPhase")))
    sys.exit(1)
if not native and memory.get("enabled"):
    print("an ordinary account's runtime mounted the OpenViking memory row")
    sys.exit(1)
print("session " + str(session.get("sessionId", "?")) + ", OpenViking memory row " + ("active" if native else "off"))
PROBE
)
  if ! session_output=$(python3 -c "${session_probe}" 2>&1); then
    fail "the preset would not mount a session, or the memory rows are not what this boot asks for — ${session_output}"
  fi

  kill "${kernel}" 2>/dev/null || true
  wait "${kernel}" 2>/dev/null || true
  rm -rf "${workspace}"
  echo "build smoke (${label}): profile ${profile} booted with every entry applied, and mounted a ${profile_preset} session (${session_output})"
}

boot_and_probe "ordinary account"

# The same proof for an account on the native memory engine: the launch plan
# gives such a runtime its memory gateway's base, and the socket's patch then
# mounts the official OpenViking plugin behind the loopback bridge. The address
# below refuses connections (the discard port), which is what a runtime meets
# while the memory service is down: memory degrades, nothing fails to activate,
# and the session still mounts.
export EVIMED_MEMORY_GATEWAY_URL="http://127.0.0.1:9/internal/memory/v1"
boot_and_probe "native memory account"
unset EVIMED_MEMORY_GATEWAY_URL
