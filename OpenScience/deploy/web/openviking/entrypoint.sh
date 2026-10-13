#!/bin/sh
# Entrypoint of the `evimed-openviking` service: the identity shim beside the
# server, then the image's own entrypoint as PID 1.
#
# The shim is what lets the built-in VikingBot run Compile while the server is
# in trusted auth mode (identity_shim.py says why). It keeps no state, so the
# loop that starts it again if it ever exits loses nothing; the container's
# health check and the control plane's `compileShim` fact both say when it is
# not answering. Delete this file with the shim.
set -eu
(
  while :; do
    python /opt/evimed-shim/identity_shim.py || true
    sleep 2
  done
) &
exec openviking-entrypoint "$@"
