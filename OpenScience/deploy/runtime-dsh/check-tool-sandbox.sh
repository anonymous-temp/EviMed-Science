#!/usr/bin/env bash
# What a model's shell commands get inside the kernel's sandbox, measured on a built runtime image.
#
#   deploy/runtime-dsh/check-tool-sandbox.sh <image>        (on a host with Docker; needs no network)
#
# It starts the image the way the control plane does (read-only root, no capabilities, no-new-privileges,
# the 64 MiB /tmp, a 512 MB memory limit with no swap, TMPDIR=/runtime/tmp as the launch plan sets it) and runs
# commands under the same Landlock launcher the kernel's bash tool uses, with the same grants. Exit status 0
# when every check passes, 1 otherwise. A real memory-cgroup OOM is part of it: the container is killed into its
# limit on purpose, for a few seconds, and nothing outside the container is touched.
#
# Written for the image that carries evimed-tool-env.sh, evimed-oom-guard.sh and tool-bin/timeout (2026-10-31);
# on an image built before them the first three groups fail, which is the point of running it. The paths of
# those files in the image can be overridden (GUARD, TOOL_ENV) to try the repository's copies in an older one.
set -euo pipefail

image="${1:?usage: check-tool-sandbox.sh <image>}"
docker_bin="${DOCKER:-docker}"
guard="${GUARD:-/usr/local/bin/evimed-oom-guard}"
tool_env="${TOOL_ENV:-/usr/local/lib/evimed/evimed-tool-env.sh}"

inner="$(cat <<'INNER'
set -u
launcher="$(ls /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-*/bin/landlock-run | head -n 1)"
sandboxed() { "${launcher}" --ro / --rw /dev/null --rw /tmp --rw /workspace -- "$@"; }
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

echo "== the analysis libraries"
check "DESeq2, edgeR, limma and org.Hs.eg.db load" "$(sandboxed_out Rscript -e 'suppressMessages({library(DESeq2); library(edgeR); library(limma); library(org.Hs.eg.db)}); cat("ok")' | tail -n 1)" ok
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
const child = spawn(launcher, ["--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", "/workspace", "--", "bash", "-c", command], { detached: true, stdio: "ignore", env: { ...process.env, DSH_SHELL: "1" } });
await new Promise((r) => setTimeout(r, 1500));
process.kill(-child.pid, "SIGTERM");
await new Promise((r) => setTimeout(r, 3500));
console.log(execFileSync("bash", ["-c", "ps -eo args | grep -c -E '^(sleep 1000|timeout 3000 sleep 1000)' || true"], { encoding: "utf8" }).trim());
process.exit(0);
JS
check "timeout in a pipeline is stopped with its command (the wrapper comes first on PATH through the tool environment)" "$(node /tmp/cancel.mjs "${launcher}" 'timeout 3000 sleep 1000 | cat')" 0

exit "${failed}"
INNER
)"

"${docker_bin}" run --rm --network none --memory 512m --memory-swap 512m --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --tmpfs /runtime:rw --tmpfs /workspace:rw --workdir /workspace \
  -e TMPDIR=/runtime/tmp -e "GUARD=${guard}" -e "TOOL_ENV=${tool_env}" \
  --entrypoint bash "${image}" -c "${inner}"
