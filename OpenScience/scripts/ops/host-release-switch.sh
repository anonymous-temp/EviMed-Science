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
#   6. Item 1 had a second half (2026-09-26 audit, I3-1). Docker resolves
#      `current` once, when a container starts, so a container item 2 leaves
#      alone keeps reading the release that was current when it started —
#      and retention, which saw only `current/...` in its mounts, deleted that
#      release two switches later. Prometheus's rules and targets, Grafana's
#      dashboards and the blackbox and search configs sat at link count 0 for
#      days while every target reported up. So every running container that
#      binds through `current` and started before the move is restarted, and
#      then every bind of every running container is stat'ed from inside:
#      link count 0 means it still reads a deleted file, and the switch stops.
#   7. The probe targets follow `.env` (configure-monitoring.mjs --targets):
#      the public certificate probe was empty for as long as nobody re-ran the
#      generator with OPEN_SCIENCE_PUBLIC_HEALTH_URL set. Alertmanager's route
#      to the control plane's alert receiver is written the same way
#      (--alert-receiver, 2026-09-28): until then its only receiver was a
#      public path nginx answered 204, and every alert was dropped. Written only
#      where it changes; a changed configuration restarts an Alertmanager the
#      recreate step left running, which would otherwise read the old inode.
#   8. The runtime image carries the skill trees the manifest records
#      (check-runtime-skill-digests.mjs): a delta that forgot a tree shipped
#      the base's copy under a manifest that said otherwise.
#   9. The pages are walked after the switch (ui-walk.mjs), when the operator
#      has configured the walk; a failure says the release is live and which
#      pages regressed.
#  10. An unhealthy backup never holds the release (2026-09-26 and 09-27). Web
#      used to wait for the backup container to be healthy; a run's symlink in
#      its workspace failed the backup's start-up cycle, compose gave up on
#      web, and the site answered 502 until someone started web by hand. Web
#      now waits only for the backup to be started (docker-compose.backup.yml),
#      and the readiness wait below reads `backup` apart from every other
#      check: the switch finishes each step, prints BACKUP IS UNHEALTHY at once
#      and again as its last line, and exits non-zero — the readiness check and
#      its alert keep saying so until the backup is fixed.
#  11. A switch does not reap work in flight unless told to (2026-09-29). The
#      recreate step stops the runtimes, and a run in one of them dies: a GEO
#      run was lost mid-step on 2026-09-25, and the acceptance battery lost one
#      on 2026-09-28. Before `current` moves, the live release is asked what is
#      running (`/api/ops/maintenance?activity=1`, loopback and the operator
#      token, from inside its own container); agent runs, product jobs or busy
#      runtimes stop the switch with their counts. `--allow-active` switches
#      anyway. An unanswered question is a warning, not a stop: a release must
#      still be possible when the old one is the thing that is broken.
set -euo pipefail
NEW="${1:?usage: host-release-switch.sh <NEW_SHORT> [--no-prune | --plan | --allow-active] [--maintenance-request-id=ID]}"
PRUNE=1; [ "${2:-}" = "--no-prune" ] && PRUNE=0
PLAN=0; [ "${2:-}" = "--plan" ] && PLAN=1
ALLOW_ACTIVE=0; for arg in "$@"; do [ "$arg" = "--allow-active" ] && ALLOW_ACTIVE=1; done
MAINTENANCE_REQUEST_ID=""
for arg in "$@"; do
  case "$arg" in --maintenance-request-id=*) MAINTENANCE_REQUEST_ID="${arg#*=}" ;; esac
done
if [ -n "$MAINTENANCE_REQUEST_ID" ]; then
  [[ "$MAINTENANCE_REQUEST_ID" =~ ^[a-zA-Z0-9._:-]{1,200}$ ]] || { echo "invalid maintenance request id"; exit 1; }
  [ "$ALLOW_ACTIVE" = 0 ] && [ "$PLAN" = 0 ] || { echo "maintenance switches require a real drained release"; exit 1; }
fi
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
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-$(env -u COMPOSE_PROFILES node --env-file="${REL}/OpenScience/deploy/web/.env" -e 'process.stdout.write(process.env.COMPOSE_PROFILES || "backup,monitoring,receipt,web-search")')}"

# The backup's readiness code once the switch has read it (item 10); `ok`
# until then. Every way the switch ends after the release is live goes
# through `finish`, so an unhealthy backup is its last word and its exit.
backup_state=ok
finish() {
  if [ "$backup_state" != ok ]; then
    echo "=== RELEASE evimed-${NEW}-1 IS LIVE, BUT THE BACKUP IS UNHEALTHY (${backup_state}): fix it before the next backup window (docs/WEB_OPERATIONS_RUNBOOK.md, \"Evidence and Recovery\") ==="
    exit 1
  fi
  exit "$1"
}

[ -f "${REL}/OpenScience/deploy/web/release-manifest.json" ] || { echo "no release manifest under ${REL}; generate it first"; exit 1; }
[ -f "$OVERRIDE" ] || { echo "no compose override at ${OVERRIDE}"; exit 1; }

# Validate the optional executor before moving current or changing host state.
RESULT_REPLAY=$(node --env-file="${REL}/OpenScience/deploy/web/.env" --input-type=module -e '
  const { resultReplayDeployment } = await import(process.argv[1]);
  process.stdout.write(resultReplayDeployment(process.env) ? "enabled" : "disabled");
' "${REL}/OpenScience/scripts/ops/result-replay-deployment.mjs")

echo "=== probe targets follow .env ==="
# In the new release's own tree and before anything moves: an invalid URL in
# `.env` stops the switch while the old release is still in front.
node --env-file="${REL}/OpenScience/deploy/web/.env" "${REL}/OpenScience/scripts/ops/configure-monitoring.mjs" --targets
echo "=== alert receiver follows the release ==="
ALERT_RECEIVER_RESULT=$(node --env-file="${REL}/OpenScience/deploy/web/.env" "${REL}/OpenScience/scripts/ops/configure-monitoring.mjs" --alert-receiver --json)
echo "  ${ALERT_RECEIVER_RESULT}"
alert_config_changed=0
if printf '%s' "$ALERT_RECEIVER_RESULT" | grep -q '"changed":\[".*alertmanager\.json'; then alert_config_changed=1; fi

echo "=== work in flight (item 11) ==="
ACTIVITY=$(docker exec "$WEB_CONTAINER" node -e '
  const fs = require("node:fs");
  const file = process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE;
  const token = (file ? fs.readFileSync(file, "utf8") : process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN || "").trim();
  fetch("http://127.0.0.1:8787/api/ops/maintenance?activity=1", { headers: { authorization: "Bearer " + token } })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
    .then((body) => {
      const a = body.data.activity;
      const counts = ["activeMutations", "activeCommands", "activeTasks", "backgroundOperations", "runningAgentRuns",
        "runningProductJobs", "pendingPromptAdmissions", "activeDatabaseSessions", "busyRuntimes", "unknownRuntimes", "unknown"];
      const drained = (values) => values && counts.every((key) => values[key] === 0)
        && Object.values(values).every((value) => Number.isSafeInteger(value) && value === 0);
      const expiresAt = Date.parse(body.data.lease?.expiresAt);
      if (process.argv[1] && (body.data.state !== "idle" || body.data.lease?.requestId !== process.argv[1]
        || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
        || !drained(a) || !drained(body.data.blockers))) throw new Error("maintenance is not owned and drained");
      console.log([a.runningAgentRuns, a.runningProductJobs, a.busyRuntimes].join(" "));
    })
    .catch((error) => { console.log("unknown " + error.message); });' "$MAINTENANCE_REQUEST_ID" 2>/dev/null || echo "unknown no-web-container")
if ! [[ "$ACTIVITY" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ || "$ACTIVITY" == unknown\ * ]]; then ACTIVITY="unknown ${ACTIVITY:-no answer}"; fi
case "$ACTIVITY" in
  unknown*)
    if [ -n "$MAINTENANCE_REQUEST_ID" ]; then
      echo "  REFUSED: maintenance activity is unknown; current has not moved"
      exit 3
    fi
    echo "  WARNING: could not read the live release's activity (${ACTIVITY#unknown }); switching without the check" ;;
  "0 0 0") echo "  nothing in flight" ;;
  *)
    read -r active_runs active_jobs busy_runtimes <<<"$ACTIVITY"
    if [ "$ALLOW_ACTIVE" = 1 ]; then
      echo "  ${active_runs} agent run(s), ${active_jobs} product job(s), ${busy_runtimes} busy runtime(s) in flight; --allow-active: switching anyway"
    else
      echo "  REFUSED: ${active_runs} agent run(s), ${active_jobs} product job(s), ${busy_runtimes} busy runtime(s) in flight would be reaped."
      echo "  Wait for them, or pass --allow-active. Nothing has moved; ${NEW} is still staged."
      exit 3
    fi
    ;;
esac
echo "=== current -> ${NEW} ==="
ln -sfn "$REL" "${ROOT}/current.next"
# Both names are in the same directory: rename replaces the link atomically
# without following it, on the Linux host and in local macOS release tests.
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "${ROOT}/current.next" "${ROOT}/current"
readlink -f "${ROOT}/current"
# Whole seconds, floored: a container started in the same second as the move
# counts as started after it, and it did resolve the new link.
SWITCHED_AT=$(date -u +%s)

# The running containers that bind a path through `current` and started before
# it moved: each still reads the release that was current when it started.
# The receipt container is left to the mint below, which restarts it anyway
# and must not race web's start (item 3).
stale_binders() {
  local container started
  for container in $(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}'); do
    [ "$container" = "$RECEIPT_CONTAINER" ] && continue
    docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{println}}{{end}}{{end}}' "$container" \
      | grep -q "^${ROOT}/current/" || continue
    # A start time that does not parse reads as "before": restarting is the
    # safe answer, reading a deleted file is not.
    started=$(date -u -d "$(docker inspect -f '{{.State.StartedAt}}' "$container")" +%s 2>/dev/null || echo 0)
    [ "$started" -lt "$SWITCHED_AT" ] && echo "$container"
  done
  return 0
}

cd "${ROOT}/current/OpenScience/deploy/web"
COMPOSE=(docker compose -p "$PROJECT"
  -f docker-compose.yml -f docker-compose.ingestion.yml -f docker-compose.local-auth.yml
  -f docker-compose.backup.yml -f docker-compose.receipt.yml -f docker-compose.monitoring.yml)
# The knowledge-source plugin (plan ch.14) runs only where the deployment names
# its image. Read off `.env` with grep for the reason given above; before the
# private override; the keyless security overlay must follow that override.
if grep -qE '^EVIMED_KNOWLEDGE_PLUGIN_IMAGE=.+' .env; then COMPOSE+=(-f docker-compose.knowledge.yml); fi
COMPOSE+=(-f "$OVERRIDE")
if [ "$RESULT_REPLAY" = enabled ]; then COMPOSE+=(-f docker-compose.result-replay.yml); fi
if node --env-file=.env -e 'process.exit(["1","true","yes"].includes(String(process.env.OPEN_SCIENCE_MANAGED_BROWSER_ENABLED || "").toLowerCase()) ? 0 : 1)'; then
  COMPOSE+=(-f docker-compose.browser.yml)
fi
if grep -qE '^OPEN_SCIENCE_VCR_BACKUP_STATUS_HOST_DIR=.+' .env; then COMPOSE+=(-f docker-compose.vcr-backup.yml); fi
if node --env-file=.env -e 'process.exit(["1","true","yes"].includes(String(process.env.OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED || "").toLowerCase()) ? 0 : 1)'; then
  COMPOSE+=(-f docker-compose.engine-keyless.yml)
fi

echo "=== which services differ from what is running ==="
# Captured first: a composition that does not resolve must stop the switch
# here, not read as "nothing changed" and wait five minutes for a web
# container nobody recreated.
hashes=$("${COMPOSE[@]}" config --hash '*')
[ -n "$hashes" ] || { echo "compose resolved no services; refusing"; exit 1; }
changed=()
receipt_changed=0
while read -r service hash; do
  [ -n "$service" ] || continue
  container=$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=${service}" --format '{{.Names}}' | head -1)
  have=""
  [ -n "$container" ] && have=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")
  if [ "$have" != "$hash" ]; then
    if [ "$service" = "open-science-release-receipt" ]; then
      receipt_changed=1
      echo "  deferred until admission resumes: ${service}"
    else
      changed+=("$service")
      echo "  changed: ${service}"
    fi
  fi
done <<< "$hashes"
echo "  ${#changed[@]} service(s) to recreate"
if [ "$PLAN" -eq 1 ]; then
  echo "=== running containers that bind through current (restarted unless recreated above) ==="
  stale_binders | sed 's/^/  /'
  echo "=== plan only: nothing recreated; current now names ${NEW} ==="
  exit 0
fi

if [ "${#changed[@]}" -gt 0 ]; then
  echo "=== recreate them ==="
  "${COMPOSE[@]}" up -d --no-build --pull never --no-deps "${changed[@]}"
fi

echo "=== restart what still reads the previous release through current ==="
restarted=()
while read -r container; do
  [ -n "$container" ] || continue
  docker restart "$container" >/dev/null
  restarted+=("$container")
  echo "  restarted: ${container}"
done < <(stale_binders)
echo "  ${#restarted[@]} container(s) restarted"
# Alertmanager reads its configuration from the shared secrets directory, not
# through `current`, so the loop above never sees it: a configuration the
# receiver step rewrote reaches a container that was not recreated only by a
# restart.
if [ "$alert_config_changed" -eq 1 ] && ! printf '%s\n' "${changed[@]:-}" | grep -qx alertmanager; then
  alertmanager_container=$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=alertmanager" --format '{{.Names}}' | head -1)
  if [ -n "$alertmanager_container" ]; then
    docker restart "$alertmanager_container" >/dev/null
    restarted+=("$alertmanager_container")
    echo "  restarted: ${alertmanager_container} (its configuration changed)"
  fi
fi

echo "=== mint the release receipt once web serves evimed-${NEW}-1 ==="
web_healthy=0
for _ in $(seq 1 60); do
  if docker exec "$WEB_CONTAINER" node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.ok?r.json():Promise.reject()).then(j=>process.exit(j.data&&j.data.releaseId==='evimed-${NEW}-1'?0:1)).catch(()=>process.exit(1))"; then web_healthy=1; break; fi
  sleep 5
done
[ "$web_healthy" = 1 ] || { echo "new release did not become healthy; keeping maintenance and old releases"; exit 1; }
# The backup's start-up cycle, if that container was recreated or restarted:
# wait for it to say how it ended, so the mint below does not change the tree
# under it.
if printf '%s\n' "${changed[@]:-}" "${restarted[@]:-}" | grep -qxE "open-science-backup|${BACKUP_CONTAINER}"; then
  since=$(docker inspect -f '{{.State.StartedAt}}' "$BACKUP_CONTAINER")
  for _ in $(seq 1 60); do
    docker logs --since "$since" "$BACKUP_CONTAINER" 2>&1 | grep -qE '"event":"backup\.(completed|failed)"' && break
    sleep 5
  done
fi
# A deployment wrapper acquires and drains this durable lease before moving
# current. Release only its own lease, after the new application is healthy,
# so the live model receipt and page walk can use normal task admission.
if [ -n "$MAINTENANCE_REQUEST_ID" ]; then
  echo "=== resume admission after the drained switch ==="
  docker exec "$WEB_CONTAINER" node -e '
    const fs = require("node:fs");
    const file = process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE;
    const token = (file ? fs.readFileSync(file, "utf8") : process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN || "").trim();
    (async () => {
      const manifest = JSON.parse(fs.readFileSync(process.env.OPEN_SCIENCE_RELEASE_MANIFEST_FILE, "utf8"));
      if (manifest.app.releaseId !== process.argv[2] || manifest.source.revision !== process.env.OPEN_SCIENCE_SOURCE_REVISION) throw new Error();
      const endpoint = "http://127.0.0.1:8787/api/ops/maintenance";
      const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
      const beforeResponse = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
      const before = await beforeResponse.json();
      const expiresAt = Date.parse(before.data?.lease?.expiresAt);
      if (!beforeResponse.ok || !["idle", "draining"].includes(before.data?.state) || before.data.lease?.requestId !== process.argv[1]
        || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error();
      const response = await fetch(endpoint, {
        method: "POST", headers, body: JSON.stringify({ action: "release", requestId: process.argv[1] }), signal: AbortSignal.timeout(10000)
      });
      const body = await response.json();
      if (!response.ok || body.data?.state !== "open" || body.data?.lease !== null) process.exit(1);
    })().catch(() => process.exit(1));' "$MAINTENANCE_REQUEST_ID" "evimed-${NEW}-1" || { echo "maintenance lease release failed; receipt was not minted"; exit 1; }
fi
# The receipt scheduler mints immediately when it starts. Recreate it only
# after admission resumes, not with the initial batch of changed services.
if [ "$receipt_changed" = 1 ]; then
  "${COMPOSE[@]}" up -d --no-build --pull never --no-deps open-science-release-receipt
fi
# Two mints at most. The receipt is a live kernel chain against the provider,
# and one chain can fail for a reason that is not the release: on 2026-09-21
# two of three releases needed the receipt container restarted by hand, each
# time because a call the kernel had read whole was booked `uncertain` (the
# gateway waited for DeepSeek to close a body the kernel had already dropped;
# fixed in modelGateway.mjs). A second mint is what a person did then; a
# second failure is a real one and stops the switch before retention.
for mint in 1 2; do
  if [ "$mint" != 1 ] || [ "$receipt_changed" != 1 ]; then docker restart "$RECEIPT_CONTAINER" >/dev/null; fi
  # Eight minutes: long enough for the backup scheduler's own five-minute retry,
  # should its start-up cycle have failed on the first mint attempt after all.
  # The line reads `<ok|notok> <checks> <failing checks but backup, or -> backup=<ok|code>`:
  # `ok` is every check but the backup (item 10), which is read on its own.
  for _ in $(seq 1 80); do
    ready=$(docker exec "$WEB_CONTAINER" node -e "fetch('http://127.0.0.1:8787/api/ready').then(r=>r.json()).then(j=>{const c=j.data.checks;const bad=Object.keys(c).filter(k=>k!=='backup'&&c[k]&&c[k].ok===false);const b=c.backup&&c.backup.ok===false?(c.backup.code||'failed'):'ok';console.log([bad.length?'notok':'ok',Object.keys(c).length,bad.join(',')||'-','backup='+b].join(' '))}).catch(()=>console.log('unreachable'))" 2>/dev/null || echo unreachable)
    case "$ready" in "ok "*" backup=ok") break ;; esac
    sleep 6
  done
  # Only the receipt (`modelGateway`) earns the second mint; anything else
  # failing is not something minting again can change.
  case "$ready" in "notok "*" modelGateway backup="*) [ "$mint" -eq 1 ] && echo "receipt did not mint (${ready}); minting once more" && continue ;; esac
  break
done
echo "readiness: ${ready}"
case "$ready" in *" backup="*) backup_state="${ready##* backup=}" ;; esac
if [ "$backup_state" != ok ]; then
  echo "=== BACKUP IS UNHEALTHY (${backup_state}): the site is served regardless and the switch goes on; readiness and OpenScienceReadinessCheckFailed{check=\"backup\"} keep saying so until it is fixed ==="
fi

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

echo "=== no running container reads a deleted file ==="
# The path existing on the host is not the question (item 6): a container
# holds the file it resolved at start, and a deleted one still reads — as the
# old bytes, or as an empty directory. Link count 0, asked inside, is that.
deleted=0; verified=0; unverified=0
for container in $(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}'); do
  while IFS= read -r destination; do
    [ -n "$destination" ] || continue
    links=$(docker exec "$container" stat -c %h "$destination" 2>/dev/null || true)
    case "$links" in
      0) echo "  DELETED ${container}: ${destination} (link count 0 — it still reads a release that is gone; restart it)"; deleted=$((deleted + 1)) ;;
      ''|*[!0-9]*) echo "  unverified ${container}: ${destination} (no stat in the container)"; unverified=$((unverified + 1)) ;;
      *) verified=$((verified + 1)) ;;
    esac
  done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}{{println}}{{end}}{{end}}' "$container")
done
[ "$deleted" -eq 0 ] || { echo "${deleted} bind(s) read a deleted file; the switch is not done until those containers are restarted"; exit 1; }
echo "  ${verified} bind(s) verified live inside their containers, ${unverified} unverified"

# `ok` here is every check but the backup (item 10): a failing backup is
# reported, not a reason to keep the old releases or skip the walk.
case "$ready" in ok*) ;; *) echo "readiness is not ok; leaving old releases in place"; exit 1 ;; esac

echo "=== the runtime image carries the skill trees the manifest records ==="
(cd "${ROOT}/current/OpenScience" && node scripts/ops/check-runtime-skill-digests.mjs deploy/web/release-manifest.json) \
  || { echo "the runtime image does not match this release's manifest; leaving old releases in place"; exit 1; }

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

# The post-release walk of the live pages (item 9), as the account
# `shared/ui-walk.env` names, in a throwaway container of the release's own
# runtime image: it has the Node, Chromium and the Playwright driver the walk
# needs, and the host has none of them. The walk aborts every
# `start_runtime`, logs out, and writes its report and screenshots to
# `shared/ui-walk/<release>/`. After retention on purpose: the walk judges the
# pages, not whether the switch may finish, and its failure leaves the release
# in front — it says so, and exits non-zero.
WALK_ENV="${ROOT}/shared/ui-walk.env"
if [ ! -f "$WALK_ENV" ]; then
  echo "=== UI WALK NOT RUN: ${WALK_ENV} is missing (docs/WEB_OPERATIONS_RUNBOOK.md, \"Post-release UI walk\") ==="
  finish 0
fi
echo "=== walk the live pages ==="
walk_password=$(sed -n 's/^OPEN_SCIENCE_WALK_PASSWORD_HOST_FILE=//p' "$WALK_ENV")
[ -f "$walk_password" ] || { echo "UI WALK NOT RUN: OPEN_SCIENCE_WALK_PASSWORD_HOST_FILE in ${WALK_ENV} names no file; evimed-${NEW}-1 is live"; finish 1; }
walk_image=$(docker exec "$WEB_CONTAINER" printenv OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE)
walk_out="${ROOT}/shared/ui-walk/${NEW}"
mkdir -p "$walk_out"
set +e
docker run --rm --network host --env-file "$WALK_ENV" \
  -e OPEN_SCIENCE_WALK_PASSWORD_FILE=/run/walk/password -e OPEN_SCIENCE_WALK_OUT=/walk-out \
  -e OPEN_SCIENCE_WALK_CHROMIUM=/usr/bin/chromium \
  -v "${walk_password}:/run/walk/password:ro" -v "${walk_out}:/walk-out" \
  -v "${ROOT}/current/OpenScience/scripts/ops/ui-walk.mjs:/walk/ui-walk.mjs:ro" \
  --entrypoint sh "$walk_image" -c \
  'OPEN_SCIENCE_PLAYWRIGHT_CORE="$(python -c "import os, playwright; print(os.path.join(os.path.dirname(playwright.__file__), \"driver\", \"package\"))")" exec node /walk/ui-walk.mjs'
walked=$?
set -e
case "$walked" in
  0) echo "=== UI walk passed; report in ${walk_out} ===" ;;
  1) echo "=== RELEASE evimed-${NEW}-1 IS LIVE, BUT THE UI WALK FAILED: the FAIL lines above name each page; report and screenshots in ${walk_out} ==="; finish 1 ;;
  *) echo "=== RELEASE evimed-${NEW}-1 IS LIVE, BUT THE UI WALK COULD NOT RUN (exit ${walked}); nothing was judged ==="; finish 1 ;;
esac
finish 0
