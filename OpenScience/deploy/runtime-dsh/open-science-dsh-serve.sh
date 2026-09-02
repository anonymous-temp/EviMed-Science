#!/usr/bin/env bash
# Starts the agent kernel and bridges it onto a unix socket.
#
# The bridge is what keeps the kernel unreachable from anywhere but the control
# plane: DSH's web host deliberately refuses `--host 0.0.0.0` and exits with a
# usage error, so it listens on loopback and socat exposes a 0600 socket that
# only the control plane's mount can reach. Exit-code semantics are unchanged
# from the deleted OpenCode script this replaced, because the supervisor still
# reads them.
set -euo pipefail

port="${OPEN_SCIENCE_RUNTIME_PORT:-4096}"
socket="${OPEN_SCIENCE_RUNTIME_SOCKET:-/runtime/control/dsh.sock}"
profile="${OPEN_SCIENCE_DSH_PROFILE:-evimed-runtime}"
# The authority the control plane sends as `Host`. DSH's /api fence refuses any
# request whose Host is neither loopback nor a declared trusted host, and it
# applies that to every request rather than only to ones with browser markers —
# so a value that disagrees with the control plane's produces a container that
# starts cleanly and then refuses every call. The control plane exports it.
authority="${OPEN_SCIENCE_RUNTIME_AUTHORITY:-dsh.runtime}"

mkdir -p "$(dirname "${socket}")"
rm -f "${socket}"

# `$DSH_HOME` is on the project's runtime volume, which starts empty. The
# profile the image spent build time pre-installing lives at `$DSH_HOME_SEED`
# instead, precisely so this bind mount does not shadow it — copy it in once,
# the first time this project's volume has never seen a profile. Every later
# boot of the same project (a restart, a resume) finds the profile already
# there and skips the copy, which is what keeps this idempotent rather than
# merely safe-to-run-once.
if [ -n "${DSH_HOME:-}" ] && [ -n "${DSH_HOME_SEED:-}" ] && [ ! -d "${DSH_HOME}/profiles/${profile}" ]; then
  mkdir -p "${DSH_HOME}"
  cp -a "${DSH_HOME_SEED}/." "${DSH_HOME}/"
  # The seed is read-only in the image so nothing can mutate the template, and
  # `cp -a` carries those bits onto the volume — where they are wrong, because
  # composing a profile writes `cordis.yml` into it. Root can ignore a read-only
  # bit while it still holds CAP_DAC_OVERRIDE, so this failure appears only once
  # the container drops capabilities, which is to say only in production.
  chmod -R u+w "${DSH_HOME}"
fi

# Telemetry off, the sandbox mode fixed, and the loader's native binding kept
# off /tmp — all three set here as well as in the image, because a container
# started with an overridden environment must not be able to undo any of them.
#
# The third one is not hardening but survival: `node-addon-require-builtin` is
# what lets the plugin loader resolve bare specifiers against the profile
# directory, and its default is to dlopen a copy of itself from /tmp — which is
# mounted noexec here. When that fails the loader says nothing about the addon
# and every plugin of ours becomes "Cannot find package '@evimed/dsh-socket'".
export NARB_DISABLE_NATIVE_CACHE=1
export DSH_TELEMETRY_DISABLED=1
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"
# The real provider key is never in this container. The workload token is a
# short-lived HMAC the control plane refreshes in place.
unset DEEPSEEK_API_KEY

# No `web` subcommand here: `web` is an alias for `--profile web`, and the
# launcher refuses both at once — "web takes none of parent --profile, --patch,
# --dump-config, or --dump-default-config" — so the container would have exited
# on its first line. A profile's own app receives whatever follows the launcher
# flags, so these reach the web app exactly as they would after `dsh web`.
# The control plane writes the generated profile patch to this fixed path,
# host-side, before the container ever starts — the same file
# `syncRuntimeDshProfile` renders and the same directory the credentials file
# (`$DSH_HOME/.credentials.yaml`, read directly by the kernel with no CLI flag
# needed) lands in. Passed with `--patch` only when it exists, so a deployment
# with the DeepSeek provider disabled — `syncRuntimeDshProfile` returns early
# for one — still boots on the bundle's own defaults rather than failing to
# find a file nothing was ever going to write.
patch_file="${DSH_HOME}/control-plane-patch.yml"
patch_args=()
[ -f "${patch_file}" ] && patch_args=(--patch "${patch_file}")

# `--patch` is a launcher flag, like `--profile` — it has to come before the
# app's own arguments (`--no-open`, `--port`, `--trusted-host`), which begin
# where the launcher's flags end. `dsh --profile web --help`'s own usage line
# confirms the ordering ("dsh [options] [command] [args...]"); putting it after
# the app flags would hand it to the web app instead, which does not know it.
dsh --profile "${profile}" "${patch_args[@]}" --no-open --port "${port}" --trusted-host "${authority}" &
dsh_pid=$!

# Wait for the kernel to bind before bridging.
#
# socat started immediately writes one "connection refused" line per probe for
# the whole minute the kernel spends composing its plugin tree — dozens of
# lines, each unique because it carries a different child pid, so nothing
# deduplicates them. Harmless in themselves, but the control plane now keeps
# only a bounded tail of this output to explain a container that dies, and that
# noise is exactly what would push the real cause out of it.
for _ in $(seq 1 300); do
  kill -0 "${dsh_pid}" 2>/dev/null || break
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && exec 3<&- && break
  sleep 1
done

socat "UNIX-LISTEN:${socket},fork,unlink-early,mode=0600" "TCP:127.0.0.1:${port}" &
socat_pid=$!

cleanup() {
  kill "${dsh_pid}" "${socat_pid}" 2>/dev/null || true
  wait "${dsh_pid}" "${socat_pid}" 2>/dev/null || true
  rm -f "${socket}"
}

trap cleanup EXIT INT TERM
set +e
wait -n "${dsh_pid}" "${socat_pid}"
status=$?
set -e
exit "${status}"
