#!/usr/bin/env bash
# Entry of the docker stand-in: node reads `--env-file` as its own option wherever it stands in argv, so the flag is renamed on the way in.
args=("${@/--env-file/--ENVFILE}")
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/fake_docker.mjs" "${args[@]}"
