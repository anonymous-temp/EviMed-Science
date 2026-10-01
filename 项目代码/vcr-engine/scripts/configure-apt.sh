#!/bin/sh
# Keep Ubuntu's suites and components, replacing only repository endpoints.
# Both classic sources.list/*.list and deb822 *.sources are in use upstream.
set -eu

apt_root="${1:-/etc/apt}"
[ "$#" -le 1 ] && [ -d "$apt_root" ] || {
  echo "vcr-configure-apt: expected an existing APT directory" >&2
  exit 1
}
archive="${APT_MIRROR:-http://archive.ubuntu.com/ubuntu}"
security="${UBUNTU_SECURITY_MIRROR:-http://security.ubuntu.com/ubuntu}"
ports="${UBUNTU_PORTS_MIRROR:-http://ports.ubuntu.com/ubuntu-ports}"
for mirror in "$archive" "$security" "$ports"; do
  # Repository URLs have no credentials, query, fragment or shell/sed syntax.
  if ! printf '%s\n' "$mirror" | LC_ALL=C grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' ||
      [ "$mirror" != "$(printf '%s' "$mirror" | LC_ALL=C tr -d '[:space:]')" ]; then
    echo "vcr-configure-apt: expected a public HTTP(S) repository URL" >&2
    exit 1
  fi
done

found=0
for source in "$apt_root/sources.list" "$apt_root"/sources.list.d/*.list "$apt_root"/sources.list.d/*.sources; do
  [ -f "$source" ] || continue
  found=1
  # A suffix works with GNU and BSD sed; APT never sees the transient backup.
  sed -i.vcr-original \
    -e "s|https\{0,1\}://archive\.ubuntu\.com/ubuntu|${archive%/}|g" \
    -e "s|https\{0,1\}://security\.ubuntu\.com/ubuntu|${security%/}|g" \
    -e "s|https\{0,1\}://ports\.ubuntu\.com/ubuntu-ports|${ports%/}|g" \
    "$source"
  rm "$source.vcr-original"
done
[ "$found" -eq 1 ] || {
  echo "vcr-configure-apt: no APT source files found" >&2
  exit 1
}
