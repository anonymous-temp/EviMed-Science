#!/usr/bin/env bash
# Shared bounded CI APT execution; source this file before using attempt.
apt_fetch=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
apt_sources=()
apt_fallback_dir=""
trap 'if [ -n "$apt_fallback_dir" ]; then rm -rf -- "$apt_fallback_dir"; fi' EXIT
prepare_fallback() {
  [ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || return 1
  apt_fallback_dir="$(mktemp -d)"
  chmod 755 "$apt_fallback_dir"
  if ! python3 "$(dirname "${BASH_SOURCE[0]}")/../vcr/ci-apt-fallback.py" /etc/apt "$apt_fallback_dir/apt"; then
    rm -rf -- "$apt_fallback_dir"
    apt_fallback_dir=""
    return 1
  fi
  apt_sources=(-o "Dir::Etc::sourcelist=$apt_fallback_dir/apt/sources.list" -o "Dir::Etc::sourceparts=$apt_fallback_dir/apt/sources.list.d")
  echo "ci-system-deps: retrying with isolated official Ubuntu HTTPS sources" >&2
}
attempt() {
  local try
  for try in 1 2 3; do
    if sudo timeout --signal=TERM --kill-after=30 600 "$@" ${apt_sources[@]+"${apt_sources[@]}"}; then return 0; fi
    echo "ci-system-deps: attempt $try of 3 did not finish: $*" >&2
    if [ "$try" = 1 ] && [ -z "$apt_fallback_dir" ]; then
      if prepare_fallback; then
        # An install failure also needs fresh indexes from the replacement.
        if [ "${*: -1}" != update ]; then
          sudo timeout --signal=TERM --kill-after=30 600 apt-get "${apt_fetch[@]}" ${apt_sources[@]+"${apt_sources[@]}"} update || return 1
        fi
      fi
    fi
    sleep $((try * 10))
  done
  return 1
}

# Known runner mirror failures justify preparing the isolated copy upfront.
prepare_fallback || true
