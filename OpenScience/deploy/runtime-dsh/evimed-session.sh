#!/usr/bin/env bash
# evimed-session: how the control plane drives a runtime inside an AgentBay
# session (plan §3.1). Root-owned, run as root through the session's command
# API, which caps a call at 50 s — so nothing here waits on the kernel: `start`
# launches it in the background and returns.
#
#   start     measure the guest kernel and its Landlock level, apply the egress
#             firewall, put the control plane's files in place with the right
#             owners, and start the kernel (with the session bridge in front of
#             it) as the unprivileged runtime user
#   install   put freshly written control-plane files in place (a renewed
#             workload token, a rewritten credentials file)
#   manifest  list a directory's regular files for the workspace mirror
#   log       the tail of the kernel's output, for a runtime that died
#
# The control plane never passes a secret on a command line or in the command
# API's environment: secrets arrive as files in ${incoming}, written through
# the session file API, and are moved from there by `install`.
set -euo pipefail

runtime_user=evimed
control=/run/evimed
incoming="${control}/incoming"
log_dir="${control}/log"
dsh_home=/runtime/dsh-home
capsule_methods="${control}/capsule-methods"

json_string() {
  python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
}

fail() {
  # One JSON line and a non-zero exit, which the control plane reads as the
  # named reason this session cannot serve.
  printf '{"ok":false,"code":%s,"detail":%s}\n' "$(json_string "$1")" "$(json_string "${2:-}")"
  exit "${3:-2}"
}

require_root() {
  [ "$(id -u)" = 0 ] || fail evimed_session_requires_root "the launcher must run as root to fence the runtime user"
}

# The Landlock ABI the running kernel offers: landlock_create_ruleset(NULL, 0,
# LANDLOCK_CREATE_RULESET_VERSION) is syscall 444 on every architecture, and
# returns the ABI version, or fails where Landlock is absent or disabled. DSH
# grades the same fact: ABI 5 (Linux 6.10, device ioctls) is `full`, 1–4 is
# `partial`, none is nothing its bash tool will run under.
landlock_abi() {
  python3 - <<'PY'
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
abi = libc.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
print(abi if abi > 0 else 0)
PY
}

landlock_level() {
  local abi="$1"
  if [ "${abi}" -ge 5 ]; then echo full; elif [ "${abi}" -ge 1 ]; then echo partial; else echo none; fi
}

# Only DNS and the gateway on 443, for the runtime user alone. Uid-scoped on
# purpose: AgentBay's own agents run as root and must keep their egress — the
# command and file channels, and the Context uploads to OSS, go through them.
apply_firewall() {
  local host="$1" chain=EVIMED_EGRESS
  command -v iptables >/dev/null 2>&1 || { echo "iptables is not installed"; return 1; }
  local addresses nameservers
  addresses="$(getent ahostsv4 "${host}" | awk '{print $1}' | sort -u)"
  [ -n "${addresses}" ] || { echo "the gateway host ${host} does not resolve"; return 1; }
  nameservers="$(awk '/^nameserver/ {print $2}' /etc/resolv.conf | grep -E '^[0-9.]+$' || true)"
  iptables -N "${chain}" 2>/dev/null || iptables -F "${chain}" || return 1
  iptables -A "${chain}" -o lo -j ACCEPT || return 1
  for ns in ${nameservers}; do
    iptables -A "${chain}" -p udp -d "${ns}" --dport 53 -j ACCEPT || return 1
    iptables -A "${chain}" -p tcp -d "${ns}" --dport 53 -j ACCEPT || return 1
  done
  for address in ${addresses}; do
    iptables -A "${chain}" -p tcp -d "${address}" --dport 443 -j ACCEPT || return 1
  done
  iptables -A "${chain}" -j REJECT || return 1
  iptables -C OUTPUT -m owner --uid-owner "${runtime_user}" -j "${chain}" 2>/dev/null \
    || iptables -I OUTPUT 1 -m owner --uid-owner "${runtime_user}" -j "${chain}" || return 1
  # No IPv6 route out for the runtime user at all; loopback stays.
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -C OUTPUT -m owner --uid-owner "${runtime_user}" ! -o lo -j REJECT 2>/dev/null \
      || ip6tables -I OUTPUT 1 -m owner --uid-owner "${runtime_user}" ! -o lo -j REJECT || return 1
  fi
  echo applied
}

# Each control-plane file, from ${incoming} to where its reader looks, with the
# owner and mode its reader needs. A name not listed here is refused: the
# control plane cannot use this to write anywhere else.
install_incoming() {
  local name source
  mkdir -p "${dsh_home}" "${control}"
  for source in "${incoming}"/*; do
    [ -e "${source}" ] || continue
    [ ! -L "${source}" ] || fail evimed_session_install_refused "a symlink in the incoming directory"
    name="$(basename "${source}")"
    case "${name}" in
      bridge.secret)
        install -o "${runtime_user}" -g "${runtime_user}" -m 0400 "${source}" "${control}/bridge.secret" ;;
      kernel.env)
        install -o root -g root -m 0600 "${source}" "${control}/kernel.env" ;;
      control-plane-patch.yml|.credentials.yaml|model-gateway.token|evimed-workload.token)
        install -o "${runtime_user}" -g "${runtime_user}" -m 0600 "${source}" "${dsh_home}/${name}" ;;
      capsule-methods.json)
        # Written by the control plane, readable and never writable by the
        # runtime user: a method the model could edit is one nobody approved.
        # Each path is checked before anything is written.
        rm -rf "${capsule_methods}"
        install -d -o root -g root -m 0755 "${capsule_methods}"
        python3 -c '
import json, os, sys
bundle, root = sys.argv[1], sys.argv[2]
files = json.load(open(bundle, encoding="utf-8")).get("files", {})
for rel, content in files.items():
    parts = rel.split("/")
    if not rel or rel.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise SystemExit("refusing capsule method path %r" % rel)
    target = os.path.join(root, *parts)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(content)
' "${source}" "${capsule_methods}"
        chown -R root:root "${capsule_methods}"
        chmod -R a-w,a+rX "${capsule_methods}" ;;
      *)
        fail evimed_session_install_refused "an unknown incoming file: ${name}" ;;
    esac
    rm -f "${source}"
  done
}

start() {
  require_root
  local port="${OPEN_SCIENCE_RUNTIME_PORT:?}" bridge_port="${OPEN_SCIENCE_SESSION_BRIDGE_PORT:?}"
  local required="${EVIMED_REQUIRED_ENFORCEMENT:-full}" gateway_host="${EVIMED_GATEWAY_HOST:-}"
  local firewall_required="${EVIMED_FIREWALL_REQUIRED:-1}"
  local release abi level firewall="skipped" firewall_detail=""
  release="$(uname -r)"
  abi="$(landlock_abi 2>/dev/null || echo 0)"
  level="$(landlock_level "${abi}")"
  local report
  report="\"kernelRelease\":$(json_string "${release}"),\"landlockAbi\":${abi},\"landlock\":$(json_string "${level}")"
  if [ "${level}" = none ]; then
    printf '{"ok":false,"code":"agentbay_landlock_unavailable",%s}\n' "${report}"
    exit 3
  fi
  if [ "${required}" = full ] && [ "${level}" != full ]; then
    printf '{"ok":false,"code":"agentbay_sandbox_enforcement_insufficient",%s}\n' "${report}"
    exit 3
  fi

  id -u "${runtime_user}" >/dev/null 2>&1 || fail evimed_session_user_missing "the image has no ${runtime_user} user"
  install -d -o root -g root -m 0755 "${control}"
  install -d -o "${runtime_user}" -g "${runtime_user}" -m 0700 "${log_dir}"
  install_incoming

  if [ -n "${gateway_host}" ]; then
    if firewall_detail="$(apply_firewall "${gateway_host}" 2>&1)"; then
      firewall=applied
    else
      firewall=failed
      if [ "${firewall_required}" = 1 ]; then
        printf '{"ok":false,"code":"agentbay_firewall_unavailable","detail":%s,%s}\n' "$(json_string "${firewall_detail}")" "${report}"
        exit 4
      fi
    fi
  fi

  # The workspace is the runtime user's; the two read-only views are not.
  install -d -o "${runtime_user}" -g "${runtime_user}" -m 0755 /workspace
  find /workspace -xdev \( -path /workspace/knowledge-base -o -path /workspace/library \) -prune \
    -o ! -user "${runtime_user}" -exec chown -h "${runtime_user}:${runtime_user}" {} +
  for view in /workspace/knowledge-base /workspace/library; do
    if [ -d "${view}" ]; then
      chown -R root:root "${view}"
      chmod -R a-w,a+rX "${view}"
    fi
  done
  install -d -o "${runtime_user}" -g "${runtime_user}" -m 0700 "${dsh_home}" "${dsh_home}/sessions" "${dsh_home}/storages" /runtime/tmp /runtime/home /runtime/xdg-config /runtime/xdg-data /runtime/xdg-cache /runtime/xdg-state
  chown -R "${runtime_user}:${runtime_user}" "${dsh_home}/sessions" "${dsh_home}/storages"

  # The kernel's environment, from the file the control plane wrote (root-only),
  # into the process started as the runtime user. `setsid -f` detaches it from
  # this call, which returns while the kernel composes.
  set -a
  # shellcheck disable=SC1091
  . "${control}/kernel.env"
  set +a
  export OPEN_SCIENCE_RUNTIME_PORT="${port}" OPEN_SCIENCE_SESSION_BRIDGE_PORT="${bridge_port}"
  export OPEN_SCIENCE_RUNTIME_BRIDGE=session OPEN_SCIENCE_SESSION_BRIDGE_SECRET_FILE="${control}/bridge.secret"
  export DSH_HOME="${dsh_home}" HOME=/runtime/home TMPDIR=/runtime/tmp
  export XDG_CONFIG_HOME=/runtime/xdg-config XDG_DATA_HOME=/runtime/xdg-data XDG_CACHE_HOME=/runtime/xdg-cache XDG_STATE_HOME=/runtime/xdg-state
  export DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE=workspace-write
  pkill -u "${runtime_user}" -f open-science-dsh-serve 2>/dev/null || true
  cd /workspace
  setsid -f runuser -u "${runtime_user}" --preserve-environment -- /usr/local/bin/open-science-dsh-serve \
    >>"${log_dir}/kernel.log" 2>&1 </dev/null
  printf '{"ok":true,%s,"firewall":%s,"firewallDetail":%s}\n' "${report}" "$(json_string "${firewall}")" "$(json_string "${firewall_detail}")"
}

# Regular files only, never through a link, as "<mtime seconds> <size> <path>"
# gzipped and base64-encoded on one line: a workspace of ten thousand files
# stays a small answer.
manifest() {
  local root="$1"; shift
  if [ ! -d "${root}" ]; then printf '' | gzip -c | base64 -w0; echo; return 0; fi
  local args=(. -xdev)
  for excluded in "$@"; do args+=( -path "./${excluded}" -prune -o ); done
  args+=( -type f -printf '%T@ %s %P\n' )
  (cd "${root}" && find "${args[@]}") | gzip -c | base64 -w0
  echo
}

case "${1:-}" in
  start) start ;;
  install) require_root; install_incoming; echo '{"ok":true}' ;;
  manifest) shift; manifest "$@" ;;
  log) tail -c 4096 "${log_dir}/kernel.log" 2>/dev/null || true ;;
  *) fail evimed_session_usage "usage: evimed-session start|install|manifest <dir> [excluded…]|log" 64 ;;
esac
