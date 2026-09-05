#!/bin/sh
set -eu
umask 077

password_file=/run/secrets/openlist-admin-password
token_file=/run/openlist-secrets/openlist.token

[ -f "$password_file" ] && [ ! -L "$password_file" ] || { echo "OpenList administrator secret is unavailable" >&2; exit 1; }
[ "$(wc -c < "$password_file")" -le 512 ] || { echo "OpenList administrator secret is oversized" >&2; exit 1; }
password="$(cat "$password_file")"
case "$password" in
  ''|*[!A-Za-z0-9_~.-]*) echo "OpenList administrator secret has invalid characters" >&2; exit 1 ;;
esac
[ "${#password}" -ge 24 ] || { echo "OpenList administrator secret is too short" >&2; exit 1; }

/opt/openlist/openlist admin set "$password" --data /opt/openlist/data >/tmp/openlist-admin-set.log 2>&1
unset password
output="$(/opt/openlist/openlist admin token --data /opt/openlist/data 2>/tmp/openlist-admin-token.log)"
chown -R 1001:1001 /opt/openlist/data
token="$(printf '%s\n' "$output" | sed -n 's/^Admin token:[[:space:]]*//p' | tail -n 1)"
unset output
case "$token" in
  ''|*[!A-Za-z0-9._~-]*) echo "OpenList administrator token is invalid" >&2; exit 1 ;;
esac
[ "${#token}" -ge 24 ] && [ "${#token}" -le 8192 ] || { echo "OpenList administrator token has invalid size" >&2; exit 1; }

mkdir -p "$(dirname "$token_file")"
temporary="${token_file}.tmp"
printf '%s\n' "$token" > "$temporary"
unset token
chmod 600 "$temporary"
chown 0:0 "$temporary"
mv -f "$temporary" "$token_file"
echo "OpenList administrator credential provisioned"
