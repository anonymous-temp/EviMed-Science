#!/usr/bin/env bash
# Drive many analyses through the deployed stack, one project reused across all
# of them, and collect every artifact.
#
#   host-batch.sh <project-label> <brief-dir> <out-dir> [<glob>]
#
# One project rather than one per question: a fresh project starts its own
# OpenCode container, and thirty containers is thirty cold starts plus thirty
# idle runtimes. The runtime is warmed once and every question lands on it.
#
# Runs are sequential by design — the server refuses a second run in a session
# ("agent_run_active"), and the deployment sizes its model concurrency for one
# heavy analysis at a time. Each question gets its own session so a failure
# leaves the next one a clean slate.
#
# Restartable: a question whose output directory already holds a report is
# skipped, so re-running after an interruption resumes rather than repeats.
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:8798}
USER_NAME=${USER_NAME:-tdm-scoping}
PASS_FILE=${PASS_FILE:-/srv/evimed-science/shared/secrets/bootstrap-password.txt}
LABEL=${1:?project label}
BRIEF_DIR=${2:?brief dir}
OUT_DIR=${3:?output dir}
GLOB=${4:-*.md}
POLL_LIMIT=${POLL_LIMIT:-720}     # 720 * 15s = 3 hours per question
JAR=$(mktemp)
PROJ=""

api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$method" "${BASE}${path}" \
      -H "Content-Type: application/json" -H "X-Open-Science-CSRF: $CSRF" \
      ${PROJ:+-H "X-Open-Science-Project: $PROJ"} -d "$body"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "${BASE}${path}" \
      -H "X-Open-Science-CSRF: $CSRF" ${PROJ:+-H "X-Open-Science-Project: $PROJ"}
  fi
}

login() {
  CSRF=""
  local out
  out=$(curl -s -c "$JAR" -X POST "${BASE}/api/auth/login" -H "Content-Type: application/json" \
    -d "{\"username\":\"${USER_NAME}\",\"password\":$(sudo cat "$PASS_FILE" | python3 -c "import json,sys;print(json.dumps(sys.stdin.read().strip()))")}")
  CSRF=$(printf '%s' "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d.get('data') or d;print(d.get('csrfToken',''))" 2>/dev/null)
  [ -n "$CSRF" ] || { echo "登录失败: $(printf '%s' "$out" | head -c 200)"; return 1; }
}

login || exit 1
echo "已登录 ${USER_NAME}"

mkdir -p "$OUT_DIR"
PROJ_FILE="${OUT_DIR}/.project"
if [ -s "$PROJ_FILE" ]; then
  PROJ=$(cat "$PROJ_FILE")
  echo "复用项目 ${PROJ}"
else
  TAG=$(date -u +%m%d-%H%M%S)
  PROJ_ID="${LABEL}-${TAG}"
  OUT=$(api POST /api/projects "{\"id\":\"${PROJ_ID}\",\"name\":\"${LABEL} ${TAG}\"}")
  PROJ=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('id',''))" 2>/dev/null)
  [ -n "$PROJ" ] || { echo "建项目失败: $(printf '%s' "$OUT" | head -c 200)"; exit 1; }
  printf '%s' "$PROJ" > "$PROJ_FILE"
  echo "已建项目 ${PROJ}"
fi

TOTAL=0; DONE=0; SKIP=0; FAIL=0
for BRIEF in "${BRIEF_DIR}"/${GLOB}; do
  [ -f "$BRIEF" ] || continue
  TOTAL=$((TOTAL + 1))
  NAME=$(basename "$BRIEF" .md)
  DEST="${OUT_DIR}/${NAME}"
  # Completion is what the ledger recorded, not the presence of a file with a
  # name we guessed. Different specialists write different artifacts — a
  # pharmacovigilance run produces safety-report.md and no evidence report — so
  # keying on one filename skips nothing and re-runs everything.
  if grep -q "^succeeded" "${DEST}/.status" 2>/dev/null; then
    echo "[$NAME] 已成功，跳过"; SKIP=$((SKIP + 1)); continue
  fi
  mkdir -p "$DEST"
  echo "=== [$NAME] 派发 ==="

  # The session id is what the runtime knows; a session opened while its
  # container is still binding yields one the runtime has never heard of.
  RUN=""; SID=""
  for attempt in 1 2 3 4 5 6; do
    login || true
    OUT=$(api POST "/api/opencode/${PROJ}/session" '{}')
    SID=$(printf '%s' "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id') or (d.get('data') or {}).get('id',''))" 2>/dev/null)
    if [ -z "$SID" ]; then echo "  第 ${attempt} 次开会话失败，等待运行时…"; sleep 20; continue; fi
    api PUT "/api/research-sessions/${SID}" '{"mode":"open-domain"}' >/dev/null
    # The dispatch id must satisfy the server's id grammar. Brief filenames are
    # Chinese ("RQ-01_研究任务"), so anything outside [a-z0-9-] has to go or every
    # dispatch is rejected with invalid_id — six times over, per question.
    BODY=$(SID="$SID" NAME="$NAME" BRIEF="$BRIEF" python3 -c "
import json, os, re
slug = re.sub(r'[^a-z0-9-]+', '-', os.environ['NAME'].lower()).strip('-') or 'run'
print(json.dumps({'sessionId': os.environ['SID'],
                  'dispatchId': f\"{slug}-{os.environ['SID'][-6:]}\",
                  'text': open(os.environ['BRIEF'], encoding='utf-8').read().strip()}))")
    OUT=$(api POST /api/agent-runs/dispatch "$BODY")
    RUN=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('id',''))" 2>/dev/null)
    AGENT=$(printf '%s' "$OUT" | python3 -c "import json,sys;d=(json.load(sys.stdin).get('data') or {});print(d.get('effectiveAgentId','?'), d.get('effectiveRouteReason','-'))" 2>/dev/null)
    if [ -n "$RUN" ]; then echo "  run ${RUN} | agent ${AGENT}"; break; fi
    echo "  第 ${attempt} 次派发失败: $(printf '%s' "$OUT" | head -c 200)"
    sleep 20
  done
  if [ -z "$RUN" ]; then echo "[$NAME] 派发始终失败"; FAIL=$((FAIL + 1)); continue; fi
  printf '%s' "$RUN" > "${DEST}/.run"

  STATUS=""
  for i in $(seq 1 "$POLL_LIMIT"); do
    # The cookie outlives a short run but not a three-hour one.
    [ $((i % 40)) -eq 0 ] && login
    ST=$(api GET /api/agent-runs | RUN="$RUN" python3 -c "
import json, os, sys
try: runs = json.load(sys.stdin).get('data') or []
except Exception: print('unreadable|-|0'); raise SystemExit
r = [x for x in runs if x.get('id') == os.environ['RUN']]
print('missing|-|0' if not r else f\"{r[0].get('status')}|{r[0].get('errorCode') or '-'}|{len(r[0].get('artifacts') or [])}\")" 2>/dev/null)
    case "$ST" in
      succeeded*|failed*|canceled*) STATUS=$ST; echo "  FINAL: $ST（约 $((i / 4)) 分钟）"; break ;;
    esac
    [ $((i % 20)) -eq 0 ] && echo "  ... $ST"
    sleep 15
  done
  [ -n "$STATUS" ] || { STATUS="timeout|-|0"; echo "  轮询超时"; }
  printf '%s' "$STATUS" > "${DEST}/.status"

  echo "  取产物"
  api GET /api/agent-runs | RUN="$RUN" python3 -c "
import json, os, sys
runs = json.load(sys.stdin).get('data') or []
r = [x for x in runs if x.get('id') == os.environ['RUN']]
print(json.dumps(r[0] if r else {}, ensure_ascii=False, indent=1))" > "${DEST}/run.json" 2>/dev/null

  # Copy exactly what THIS run declared, and nothing else. One project means one
  # workspace, so "every file touched recently" also matches the previous
  # question's output: three questions that routed to a pharmacovigilance agent
  # were collected carrying the chest-pain evidence report of the question before
  # them, byte-identical, and it took comparing checksums to notice.
  WS=$(sudo find /var/lib/docker/volumes/evimed-science-data/_data -maxdepth 8 -type d -path "*/projects/${PROJ}/workspace" 2>/dev/null | head -1)
  ARTIFACTS=$(python3 -c "
import json, sys
try: run = json.load(open('${DEST}/run.json', encoding='utf-8'))
except Exception: raise SystemExit
for name in (run.get('artifacts') or []):
    if '/' not in name and not name.startswith('.'): print(name)
" 2>/dev/null)
  COUNT=0
  if [ -n "$WS" ] && [ -n "$ARTIFACTS" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if sudo test -f "${WS}/${f}"; then
        sudo cp "${WS}/${f}" "${DEST}/" && COUNT=$((COUNT + 1))
        # Remove it from the shared workspace so the next question cannot
        # inherit it when its own run writes nothing under that name.
        sudo rm -f "${WS}/${f}"
      fi
    done <<< "$ARTIFACTS"
    sudo chown -R "$(id -u):$(id -g)" "$DEST" 2>/dev/null
  fi
  echo "[$NAME] 完成，取回声明产物 ${COUNT} 个"
  case "$STATUS" in succeeded*) DONE=$((DONE + 1)) ;; *) FAIL=$((FAIL + 1)) ;; esac
done

echo "=== 批次结束：共 ${TOTAL}，成功 ${DONE}，跳过 ${SKIP}，失败 ${FAIL} ==="
echo "PROJECT=$PROJ"
rm -f "$JAR"
