#!/usr/bin/env bash
# What a model's shell commands get inside the kernel's sandbox, measured on a built runtime image.
#
#   deploy/runtime-dsh/check-tool-sandbox.sh <image>        (on a host with Docker; needs no network)
#
# It starts the image the way the control plane does (read-only root, no capabilities, no-new-privileges,
# the 64 MiB /tmp, Docker's own 64 MiB /dev/shm, a 512 MB memory limit with no swap, TMPDIR=/runtime/tmp as the
# launch plan sets it) and runs commands the way the kernel's bash tool does: through the image's sandbox runner
# (/usr/local/lib/evimed/evimed-landlock-run, which the sealed profile's `sandbox` row names) with the exact profile
# dsh-sandbox-local hands a custom runner, which wraps the same Landlock launcher the kernel's own runner uses.
# Exit status 0 when every check passes, 1 otherwise. A real memory-cgroup OOM is part of it: the container is
# killed into its limit on purpose, for a few seconds, and nothing outside the container is touched.
#
# Written for the image that carries evimed-tool-env.sh, evimed-oom-guard.sh and tool-bin/timeout (2026-10-31);
# on an image built before them the first three groups fail, which is the point of running it. The paths of
# those files in the image can be overridden (GUARD, TOOL_ENV, RUNNER) to try the repository's copies in an older one.
set -euo pipefail

image="${1:?usage: check-tool-sandbox.sh <image>}"
docker_bin="${DOCKER:-docker}"
guard="${GUARD:-/usr/local/bin/evimed-oom-guard}"
tool_env="${TOOL_ENV:-/usr/local/lib/evimed/evimed-tool-env.sh}"
runner="${RUNNER:-/usr/local/lib/evimed/evimed-landlock-run}"

inner=$(cat <<'INNER'
set -u
launcher="$(ls /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-*/bin/landlock-run | head -n 1)"
# What the kernel's bash tool runs, for a workspace-write command in /workspace: the sandbox row's runner, the profile
# the kernel appends to it (scripts/ops/sandbox-profile.mjs records it from the pinned closure), then the command.
sandboxed() { "${RUNNER}" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace -- "$@"; }
# The kernel's own Landlock runner, as it was before the sandbox row named a runner: what /dev/shm was denied under.
kernel_runner() { "${launcher}" --ro / --rw /dev/null --rw /tmp --rw /workspace -- "$@"; }
# Output with the launcher's note about an older Landlock ABI taken out, for the checks that compare it.
sandboxed_out() { sandboxed "$@" 2>&1 | grep -v 'partial enforcement'; }
failed=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got [$2], want [$3]"; failed=1; fi; }
mkdir -p /runtime/tmp
export TMPDIR=/runtime/tmp BASH_ENV="${TOOL_ENV}" MPLCONFIGDIR=/tmp/matplotlib NUMBA_CACHE_DIR=/tmp/numba-cache

echo "== the commands' environment"
check "TMPDIR is /tmp inside the sandbox" "$(sandboxed_out bash -c 'printf %s "$TMPDIR"')" /tmp
check "Rscript -e runs" "$(sandboxed_out Rscript -e 'cat("ok")')" ok
check "matplotlib keeps its config in /tmp" "$(sandboxed_out python -c 'import matplotlib; print(matplotlib.get_configdir(), end="")')" /tmp/matplotlib
printf 'import numba\n@numba.njit(cache=True)\ndef f(x):\n    return x + 1\nprint(f(1), end="")\n' > /tmp/numba_probe.py
check "numba caches in /tmp" "$(sandboxed_out python /tmp/numba_probe.py)" 2

echo "== the sandbox runner (/dev/shm is writable to a command; nothing else the kernel's runner denies is allowed)"
check "the runner is in the image and executable" "$([ -x "${RUNNER}" ] && echo yes || echo no)" yes
check "/dev/shm is writable to a command" "$(sandboxed bash -c 'touch /dev/shm/.evimed-probe 2> /dev/null && rm -f /dev/shm/.evimed-probe && echo writable || echo denied' 2> /dev/null)" writable
check "multiprocessing.Pool works" "$(sandboxed_out python3 -c 'import multiprocessing as mp; p = mp.Pool(2); print(p.map(abs, [-1, 2]), end=""); p.close(); p.join()')" "[1, 2]"
check "ProcessPoolExecutor works" "$(sandboxed_out python3 -c 'from concurrent.futures import ProcessPoolExecutor as P
with P(2) as e: print(list(e.map(abs, [-3, 4])), end="")')" "[3, 4]"
check "joblib starts worker processes and says nothing about serial mode" "$(sandboxed_out python3 -c 'from joblib import Parallel, delayed; print(Parallel(n_jobs=2)(delayed(abs)(x) for x in [-5, 6]), end="")')" "[5, 6]"
check "the kernel's own runner still denies /dev/shm (the reason the runner exists)" "$(kernel_runner bash -c 'touch /dev/shm/.evimed-probe 2> /dev/null && rm -f /dev/shm/.evimed-probe && echo writable || echo denied' 2> /dev/null)" denied
check "a write outside the grants is still refused" "$(sandboxed bash -c 'touch /usr/local/evimed-probe 2> /dev/null; echo $?' 2> /dev/null)" 1
# The root of this container is read-only, so the refusal above would come with or without Landlock. /runtime is a writable tmpfs here (the
# launch plan's TMPDIR lives in it): a command is kept out of it by the sandbox alone, and a write the same shell makes outside the sandbox shows it was open.
check "/runtime is writable without the sandbox (the control for the next check)" "$(touch /runtime/.evimed-probe 2> /dev/null && rm -f /runtime/.evimed-probe && echo writable || echo denied)" writable
check "a write to /runtime, writable in this container, is refused by Landlock and not by the read-only root" "$(sandboxed bash -c 'touch /runtime/.evimed-probe 2> /dev/null; echo $?' 2> /dev/null)" 1
check "a write to /proc is still refused" "$(sandboxed bash -c 'echo 1 > /proc/self/oom_score_adj 2> /dev/null; echo $?' 2> /dev/null)" 1
out="$(sandboxed bash -c 'echo to-stderr >&2; exit 7' 2>&1)"; status=$?
check "a command's exit status passes through unchanged" "${status}" 7
check "a command's standard error passes through unchanged" "$(printf %s "${out}" | grep -v 'partial enforcement')" to-stderr
check "a profile the runner does not know is refused and nothing runs" "$("${RUNNER}" --ro / -- touch /tmp/evimed-ran 2>&1 | head -c 32; test -e /tmp/evimed-ran && echo RAN)" "evimed-landlock-run: unsupported"
echo "== /dev/shm is Docker's own 64 MiB tmpfs here, as in the runtime container (the launch plan sets no --shm-size)"
df -h /dev/shm | sed -n 2p | awk '{ print "info  /dev/shm size " $2 ", free " $4 }'
shm_mb="$(df -m --output=size /dev/shm | sed -n 2p | tr -d ' ')"
if [ "${shm_mb:-0}" -le 128 ]; then
  check "a write past the end of /dev/shm fails with an error and does not hang" "$(timeout 30 "${RUNNER}" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace -- bash -c 'head -c 200000000 /dev/zero > /dev/shm/.evimed-fill 2> /dev/null; s=$?; rm -f /dev/shm/.evimed-fill; test "${s}" != 0 && echo failed-cleanly || echo no-error' 2> /dev/null)" failed-cleanly
else
  echo "info  /dev/shm is ${shm_mb} MB here, not the container's default; the fill check is skipped"
fi

# DESeq2, edgeR, limma and org.Hs.eg.db are checked below in a container of their own: loading them takes about 650 MB (measured
# 2026-11-01, killed at 512 MB, loaded at 1 GB), more than this one holds and less than the runtime's real limit.
check "pydeseq2, shap, xgboost and lightgbm import" "$(sandboxed_out python -c 'import pydeseq2, shap, xgboost, lightgbm; print("ok", end="")' | tail -n 1)" ok

echo "== a runaway command dies before the kernel does (stand-in kernel of 300 MB, 512 MB container, no swap)"
run_case() {
  node -e 'const b = Buffer.alloc(300e6, 1); setInterval(() => { b[0] ^= 1; }, 1000)' & kernel=$!
  sleep 1.5
  guard_pid=""
  if [ "$1" = guard ]; then bash "${GUARD}" > /dev/null & guard_pid=$!; fi
  DSH_SHELL=1 sandboxed bash -c 'sleep 2.5; python3 -c "
import time
blocks = []
for _ in range(40):
    blocks.append(b\"x\" * (30 << 20)); time.sleep(0.25)"' > /dev/null 2>&1
  tool_status=$?
  kill -0 "${kernel}" 2> /dev/null && alive=yes || alive=no
  kill "${kernel}" ${guard_pid:+"${guard_pid}"} 2> /dev/null; wait 2> /dev/null
  echo "$tool_status $alive"
}
check "the command is killed (137) and the stand-in kernel lives, with the guard" "$(run_case guard)" "137 yes"

echo "== job_kill reaches what a pipeline started"
cat > /tmp/cancel.mjs <<'JS'
import { spawn, execFileSync } from "node:child_process";
const [launcher, command] = process.argv.slice(2);
const child = spawn(launcher, ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--tmpfs", "/tmp", "--bind", "/workspace", "/workspace", "--", "bash", "-c", command], { detached: true, stdio: "ignore", env: { ...process.env, DSH_SHELL: "1" } });
await new Promise((r) => setTimeout(r, 1500));
process.kill(-child.pid, "SIGTERM");
await new Promise((r) => setTimeout(r, 3500));
console.log(execFileSync("bash", ["-c", "ps -eo args | grep -c -E '^(sleep 1000|timeout 3000 sleep 1000)' || true"], { encoding: "utf8" }).trim());
process.exit(0);
JS
check "timeout in a pipeline is stopped with its command (the wrapper comes first on PATH through the tool environment)" "$(node /tmp/cancel.mjs "${RUNNER}" 'timeout 3000 sleep 1000 | cat')" 0
check "a cancel of the process group reaches a command started through the runner (no process in between)" "$(node /tmp/cancel.mjs "${RUNNER}" 'sleep 1000 & sleep 1000')" 0

exit "${failed}"
INNER
)

set +e
"${docker_bin}" run --rm --network none --memory 512m --memory-swap 512m --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --tmpfs /runtime:rw --tmpfs /workspace:rw --workdir /workspace \
  -e TMPDIR=/runtime/tmp -e "GUARD=${guard}" -e "TOOL_ENV=${tool_env}" -e "RUNNER=${runner}" \
  --entrypoint bash "${image}" -c "${inner}"
status=$?

echo "== the analysis libraries (1 GB container)"
library_command=$(cat <<'LIBRARY'
"${RUNNER}" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace -- Rscript -e 'suppressMessages({library(DESeq2); library(edgeR); library(limma); library(org.Hs.eg.db)}); cat("ok")' 2>&1 | grep -v "partial enforcement" | tail -n 1
LIBRARY
)
libraries="$("${docker_bin}" run --rm --network none --memory 1g --memory-swap 1g --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --tmpfs /runtime:rw --tmpfs /workspace:rw --workdir /workspace \
  -e TMPDIR=/tmp -e "RUNNER=${runner}" --entrypoint bash "${image}" -c "${library_command}")"
if [ "${libraries}" = ok ]; then echo "ok    DESeq2, edgeR, limma and org.Hs.eg.db load"; else echo "FAIL  DESeq2, edgeR, limma and org.Hs.eg.db load: got [${libraries}], want [ok]"; status=1; fi
exit "${status}"
