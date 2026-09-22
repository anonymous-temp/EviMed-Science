#!/usr/bin/env bash
# Prepare the serving host for the knowledge-source plugin, once; safe to run
# again (every step checks before it acts).
#
#   sudo host-knowledge-plugin-setup.sh
#
# What the plugin needs from the host, and nothing more (plan ch.14):
#
#   1. Its own database in the platform's PostgreSQL instance: role and
#      database `evimed_knowledge`, which can connect to that database only.
#      The host is short of memory (swap full, 2026-09-22), so a second
#      database engine is not an option; two databases in one instance share
#      nothing but the process, and the platform never connects to this one.
#   2. The shared bearer token both containers read (`knowledge-plugin.token`)
#      and the database password only the plugin reads. Both are generated
#      here, on the host, and never printed; a file that already exists is
#      kept, so running this again does not rotate anything. To rotate, delete
#      the file and run it again, then recreate both containers.
#
# Ownership: the web container runs as root with every capability dropped, so
# it reads a root-owned 0440 file as its owner; the plugin runs as uid:gid
# 10002:10002 and reads it through the group. The other secret files the plugin
# is given later (the EviMed API key, the Tokyo proxy credentials) are shared
# with the web container the same way — group 10002, mode 0440 — which adds a
# reader and takes none away.
set -euo pipefail
ROOT="${EVIMED_ROOT:-/srv/evimed-science}"
SECRETS="${ROOT}/shared/secrets"
PG_CONTAINER="${EVIMED_POSTGRES_CONTAINER:-web-evimed-postgres-1}"
PG_SUPERUSER="${EVIMED_POSTGRES_SUPERUSER:-evimed}"
PLUGIN_GID="${EVIMED_KNOWLEDGE_PLUGIN_GID:-10002}"
TOKEN="${SECRETS}/knowledge-plugin.token"
DBPW="${SECRETS}/knowledge-plugin-db.password"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -d "$SECRETS" ] || { echo "no secrets directory at ${SECRETS}"; exit 1; }
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || { echo "no PostgreSQL container ${PG_CONTAINER}"; exit 1; }

umask 077
# 48 random bytes, URL-safe, no padding: a bearer token has no reason to be
# shorter, and a file with a trailing newline is read the same by both sides.
if [ ! -s "$TOKEN" ]; then
  head -c 48 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_' > "$TOKEN"
  echo "created ${TOKEN}"
fi
# Hex, so it can be written into SQL between single quotes without escaping.
if [ ! -s "$DBPW" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DBPW"
  echo "created ${DBPW}"
fi
chown "root:${PLUGIN_GID}" "$TOKEN" "$DBPW"
chmod 0440 "$TOKEN" "$DBPW"

psql_super() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -qAt -U "$PG_SUPERUSER" -d "$1"; }

# The password travels on stdin, never on a command line another process
# could read.
if [ "$(echo "SELECT 1 FROM pg_roles WHERE rolname='evimed_knowledge'" | psql_super postgres)" = "1" ]; then
  printf "ALTER ROLE evimed_knowledge WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$(cat "$DBPW")" | psql_super postgres
  echo "role evimed_knowledge: password kept in step with the file"
else
  printf "CREATE ROLE evimed_knowledge WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$(cat "$DBPW")" | psql_super postgres
  echo "role evimed_knowledge: created"
fi
if [ "$(echo "SELECT 1 FROM pg_database WHERE datname='evimed_knowledge'" | psql_super postgres)" != "1" ]; then
  echo "CREATE DATABASE evimed_knowledge OWNER evimed_knowledge ENCODING 'UTF8' TEMPLATE template0;" | psql_super postgres
  echo "database evimed_knowledge: created"
fi
# Connect to its own database only. Every database grants CONNECT to PUBLIC by
# default; the platform's and the maintenance database stop doing so here. The
# platform's own role is the superuser and is not affected.
cat <<'SQL' | psql_super postgres
REVOKE CONNECT ON DATABASE evimed_knowledge FROM PUBLIC;
GRANT CONNECT ON DATABASE evimed_knowledge TO evimed_knowledge;
REVOKE CONNECT ON DATABASE evimed FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL
echo "connect grants: evimed_knowledge -> evimed_knowledge only"
echo "done"
