#!/usr/bin/env bash
# Put a built release in front on the serving host.
#
#   host-release-switch.sh <NEW_SHORT> [--no-prune | --plan]
#
# `--plan` moves `current`, prints which services would be recreated, and stops:
# the list is the thing to read before a switch that might touch PostgreSQL.
#
# What it holds, each line of it learnt the hard way (2026-09-14 .. 09-17):
#
#   1. `current` is moved first, and compose runs THROUGH it. Every relative
#      bind mount then reads `/srv/.../current/...`, docker resolves the link
#      each time a container starts, and a long-lived container (Prometheus,
#      Grafana, the search proxy) survives any number of later releases. Run
#      from the release directory instead, those mounts named one release by
#      absolute path, that release was pruned three cutovers later, and the
#      containers kept running on files that no longer existed — one restart
#      from not starting at all.
#   2. Only the services whose configuration differs from their running
#      container are recreated, found by comparing compose's config hash with
#      the container's label. After the first run through `current` that is
#      the four that carry release identity; PostgreSQL and the engines are
#      left alone unless their definition really changed.
#   3. The DeepSeek release receipt is minted again once web answers as the new
#      release. Recreated together with web, its first mint races web's start,
#      fails, and is not retried for twelve hours: readiness sits at 23/24.
#      And only after the backup container's start-up backup has ended: a mint
#      creates and removes a `gate-<hex>` project, the backup refuses a data
#      tree that changes under it (by design), and the two were being started
#      in the same minute — `backup_scheduler_unhealthy` for the five minutes
#      until its retry (first run of this script, 2026-09-17).
#   4. Nothing is left referring to a path that is not there. Checked, not
#      assumed, and the switch fails loudly if it is.
#   5. Old releases and their images go through release-retention.mjs, which
#      refuses anything a container still names. Never `rm -rf`: that is how
#      item 1 happened.
set -euo pipefail
NEW="${1:?usage: host-release-switch.sh <NEW_SHORT> [--no-prune | --plan]}"
PRUNE=1; [ "${2:-}" = "--no-prune" ] && PRUNE=0
PLAN=0; [ "${2:-}" = "--plan" ] && PLAN=1
ROOT="${EVIMED_ROOT:-/srv/evimed-science}"
PROJECT="${EVIMED_COMPOSE_PROJECT:-web}"
REL="${ROOT}/releases/${NEW}"
OVERRIDE="${ROOT}/shared/ops-source-${NEW}/compose.builtin.override.yml"
WEB_CONTAINER="${PROJECT}-open-science-web-1"
RECEIPT_CONTAINER="${PROJECT}-open-science-release-receipt-1"
BACKUP_CONTAINER="${PROJECT}-open-science-backup-1"
# Compose reads `.env` from the project directory itself. Sourcing it in bash
# must not be attempted: `OPEN_SCIENCE_OIDC_SCOPES=openid profile email` is a
# legal compose value and an illegal shell assignment.
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-backup,monitoring,receipt,web-search}"

[ -f "${REL}/OpenScience/deploy/web/release-manifest.json" ] || { echo "no release manifest under ${REL}; generate it first"; exit 1; }
[ -f "$OVERRIDE" ] || { echo "no compose override at ${OVERRIDE}"; exit 1; }

echo "=== current -> ${NEW} ==="
ln -sfn "$REL" "${ROOT}/current.next" && mv -T "${ROOT}/current.next" "${ROOT}/current"
readlink -f "${ROOT}/current"

cd "${ROOT}/current/OpenScience/deploy/web"
COMPOSE=(docker compose -p "$PROJECT"
  -f docker-compose.yml -f docker-compose.ingestion.yml -f docker-compose.local-auth.yml
  -f docker-compose.backup.yml -f docker-compose.receipt.yml -f docker-compose.monitoring.yml
  -f "$OVERRIDE")

echo "=== which services differ from what is running ==="
# Captured first: a composition that does not resolve must stop the switch
# here, not read as "nothing changed" and wait five minutes for a web
# container nobody recreated.
hashes=$("${COMPOSE[@]}" config --hash '*')
[ -n "$hashes" ] || { echo "compose resolved no services; refusing"; exit 1; }
changed=()
while read -r service hash; do
  [ -n "$service" ] || continue
  container=$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=${service}" --format '{{.Names}}' | head -1)
  have=""
  [ -n "$container" ] && have=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")
  if [ "$have" != "$hash" ]; then changed+=("$service"); echo "  changed: ${service}"; fi
done <<< "$hashes"
echo "  ${#changed[@]} service(s) to recreate"
[ "$PLAN" -eq 0 ] || { echo "=== plan only: nothing recreated; current now names ${NEW} ==="; exit 0; }

if [ "${#changed[@]}" -gt 0 ]; then
  echo "=== recreate them ==="
  "${COMPOSE[@]}" up -d --no-deps "${changed[@]}"
fi

echo "=== mint the release receipt once web serves evimed-${NEW}-1 ==="
for _ in $(seq 1 60); do
  docker exec "$WEB_CONTAINER" node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(j=>process.exit(j.data&&j.data.releaseId==='evimed-${NEW}-1'?0:1)).catch(()=>process.exit(1))" && break
  sleep 5
done
# The backup's start-up cycle, if that container was recreated: wait for it to
# say how it ended, so the mint below does not change the tree under it.
if printf '%s\n' "${changed[@]:-}" | grep -qx "open-science-backup"; then
  since=$(docker inspect -f '{{.State.StartedAt}}' "$BACKUP_CONTAINER")
  for _ in $(seq 1 60); do
    docker logs --since "$since" "$BACKUP_CONTAINER" 2>&1 | grep -qE '"event":"backup\.(completed|failed)"' && break
    sleep 5
  done
fi
docker restart "$RECEIPT_CONTAINER" >/dev/null
# Eight minutes: long enough for the backup scheduler's own five-minute retry,
# should its start-up cycle have failed on the first mint attempt after all.
for _ in $(seq 1 80); do
  ready=$(docker exec "$WEB_CONTAINER" node -e "fetch('http://127.0.0.1:8787/api/ready').then(r=>r.json()).then(j=>{const c=j.data.checks;const bad=Object.keys(c).filter(k=>c[k]&&c[k].ok===false);console.log((j.data.ok?'ok ':'notok ')+Object.keys(c).length+' '+bad.join(','))}).catch(()=>console.log('unreachable'))" 2>/dev/null || echo unreachable)
  case "$ready" in ok*) break ;; esac
  sleep 6
done
echo "readiness: ${ready}"

echo "=== nothing refers to a path that is not there ==="
# A bind source, and the compose directory a container was created from: the
# second is what it would be recreated from, and a container whose definition
# is gone can be restarted but not rebuilt as it was.
missing=0
for container in $(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}'); do
  created_from=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
  if [ -n "$created_from" ] && [ ! -d "$created_from" ]; then echo "  MISSING ${container}: created from ${created_from}"; missing=$((missing + 1)); fi
  while IFS= read -r source; do
    [ -n "$source" ] || continue
    if [ ! -e "$source" ]; then echo "  MISSING ${container}: ${source}"; missing=$((missing + 1)); fi
  done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{println}}{{end}}{{end}}' "$container")
done
[ "$missing" -eq 0 ] || { echo "${missing} bind source(s) do not exist; fix before pruning anything"; exit 1; }
echo "  every bind source and compose directory exists"

case "$ready" in ok*) ;; *) echo "readiness is not ok; leaving old releases in place"; exit 1 ;; esac

if [ "$PRUNE" -eq 1 ]; then
  echo "=== retention ==="
  (cd "${ROOT}/current/OpenScience" && node scripts/ops/release-retention.mjs prune "${ROOT}/releases" --keep 2 --images --apply)
  rm -rf -- "${ROOT}/build/${NEW}"
  for ops in "${ROOT}"/shared/ops-source-*; do
    [ -d "$ops" ] || continue
    rev="${ops##*ops-source-}"
    [ -d "${ROOT}/releases/${rev}" ] || { rm -rf -- "$ops"; echo "removed ${ops}"; }
  done
fi
echo "=== switched to evimed-${NEW}-1 ==="
