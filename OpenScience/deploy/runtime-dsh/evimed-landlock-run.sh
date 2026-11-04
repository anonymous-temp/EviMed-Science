#!/bin/sh
# The runner the kernel's sandbox row is told to use (`sandbox` / `runnerCommand` in
# packages/socket/cordis.patch.yml): the kernel's own Landlock launcher, with /dev/shm added to what a
# workspace-write command may write.
#
# Why it exists. DSH's local sandbox runs a command under `landlock-run --ro / --rw /dev/null --rw /tmp --rw
# <workspace>` (dsh-sandbox-local `landlockProfileArgs`; the grants are literals, no setting reaches them). POSIX
# semaphores and shared memory live in /dev/shm, so under that grant Python's multiprocessing (Pool, Queue,
# ProcessPoolExecutor: `SemLock` -> sem_open), joblib/loky and numba's parallel start-up fail with
# `PermissionError: [Errno 13]` and fall back to serial work or stop. The only supported way to change what the
# kernel runs around a command is the sandbox row's `runnerCommand`: the kernel then appends bwrap-dialect profile
# arguments to it, skips its own runner choice and its probes, and records the enforcement as `full`.
#
# What it does: reads exactly the profile the kernel appends, turns it into the launcher's grants, adds
# --rw /dev/shm for a workspace-write command (when the directory exists), and `exec`s the launcher. Nothing
# stays between the kernel and the command: no child process, so the pid, the process group, the signals, the exit
# status, standard input and the bytes of standard output and error are the launcher's own, and the environment
# is the kernel's (this file reads none of it and sets none).
#
# What it will not do: guess. The profile must be one of the two shapes dsh-sandbox-local 0.2.1 builds
# (`bwrapProfileArgs`), word for word; any other argument is refused (exit 125, a line that begins
# `evimed-landlock-run: `, which the row names as a runner-failure signature, so the kernel says "refusing to run
# the command unconfined" and names the cause). A kernel update that changes the profile therefore stops every
# command loudly at the first one; apps/server/test/runtimeLandlockRunner.test.mjs holds this file to the kernel's
# own output on the pinned closure, and deploy/runtime-dsh/check-tool-sandbox.sh runs it on the built image.
#
#   read-only:        --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- <command>...
#   workspace-write:  ... --die-with-parent --tmpfs /tmp --bind <workspace> <workspace> -- <command>...
#
# The kernel's own Landlock runner grants, for the same two shapes: `--ro /` `--rw /dev/null`, and for
# workspace-write also `--rw /tmp` `--rw <workspace>`. This runner grants the same, `--rw /dev/shm` and `--rw $HOME/.loopx`. Nothing the
# launcher denies is allowed by it: it does not unshare a PID namespace or mount anything (neither does the
# launcher path), and it adds no network rule (neither has the launcher).
#
# It also grants LoopX its own directory, $HOME/.loopx, when the serve script has made it. The CLI the model runs keeps its machine registry
# and its goal authority there, the kernel's plugin reads them from there outside the sandbox, and the kernel's grants leave it read-only: the
# CLI's first step answered `blocked-write-denied`, and the model spent most of a goal's first round on inventing another place, a different one
# each time (42 of 49 tool calls for a 200-word answer, 2026-11-03). The directory holds LoopX's state and nothing of the platform's; /runtime
# and the rest of $HOME stay out of reach. The path is written here for the same reason the launcher's is.
#
# Deletable when dsh-sandbox-local grants the platform temp areas the way its own `writableRoots` already says
# (/tmp and os.tmpdir(), plus /dev/shm) or offers a list of extra writable roots: delete this file, the three
# COPY lines and the `sandbox` row, and re-record the composition baseline (deps-version.json
# dsh.upstreamDefects.sandboxWritableRoots).

# Tests replace these three lines with the path of the launcher and the directories under test; the image
# never reads either from its environment, because which binary confines a command must not be decidable by the
# environment a command could influence.
launcher_pattern='/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-*/bin/landlock-run'
shm_dir=/dev/shm
loopx_home=/runtime/home/.loopx

fail() {
  printf 'evimed-landlock-run: %s\n' "$1" >&2
  exit 125
}

launcher=
for candidate in ${launcher_pattern}; do
  if [ -x "${candidate}" ]; then launcher=${candidate}; break; fi
done
[ -n "${launcher}" ] || fail 'the Landlock launcher was not found'

profile_ok=
if [ "${1-}" = --ro-bind ] && [ "${2-}" = / ] && [ "${3-}" = / ] \
  && [ "${4-}" = --dev ] && [ "${5-}" = /dev ] \
  && [ "${6-}" = --unshare-pid ] \
  && [ "${7-}" = --proc ] && [ "${8-}" = /proc ] \
  && [ "${9-}" = --die-with-parent ]; then
  profile_ok=1
fi
[ -n "${profile_ok}" ] || fail 'unsupported sandbox profile (the first nine arguments are not the kernel profile this runner was written for)'
shift 9

if [ "${1-}" = -- ]; then
  shift
  [ $# -gt 0 ] || fail 'no command after --'
  exec "${launcher}" --ro / --rw /dev/null -- "$@"
fi

if [ "${1-}" = --tmpfs ] && [ "${2-}" = /tmp ] && [ "${3-}" = --bind ] \
  && [ -n "${4-}" ] && [ "${4-}" = "${5-}" ] && [ "${6-}" = -- ]; then
  workspace=$4
  shift 6
  [ $# -gt 0 ] || fail 'no command after --'
  if [ -d "${loopx_home}" ]; then set -- --rw "${loopx_home}" -- "$@"; else set -- -- "$@"; fi
  set -- --rw "${workspace}" "$@"
  if [ -d "${shm_dir}" ]; then set -- --rw "${shm_dir}" "$@"; fi
  exec "${launcher}" --ro / --rw /dev/null --rw /tmp "$@"
fi

fail 'unsupported sandbox profile (neither the read-only nor the workspace-write shape)'
