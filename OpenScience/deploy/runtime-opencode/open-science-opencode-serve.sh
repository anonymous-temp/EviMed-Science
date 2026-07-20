#!/usr/bin/env bash
set -euo pipefail

port="${OPEN_SCIENCE_RUNTIME_PORT:-4096}"
socket="${OPEN_SCIENCE_RUNTIME_SOCKET:-/runtime/control/opencode.sock}"

mkdir -p "$(dirname "${socket}")"
rm -f "${socket}"

opencode serve --hostname 127.0.0.1 --port "${port}" &
opencode_pid=$!
socat "UNIX-LISTEN:${socket},fork,unlink-early,mode=0600" "TCP:127.0.0.1:${port}" &
socat_pid=$!

cleanup() {
  kill "${opencode_pid}" "${socat_pid}" 2>/dev/null || true
  wait "${opencode_pid}" "${socat_pid}" 2>/dev/null || true
  rm -f "${socket}"
}

trap cleanup EXIT INT TERM
set +e
wait -n "${opencode_pid}" "${socat_pid}"
status=$?
set -e
exit "${status}"
