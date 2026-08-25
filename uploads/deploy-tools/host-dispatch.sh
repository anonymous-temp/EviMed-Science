#!/usr/bin/env bash
# Dispatch into an EXISTING project whose runtime is already warm.
#
#   host-dispatch.sh <project-id> <question-file> [<label>]
#
# Splitting this out of host-run.sh exists for a reason: a fresh project starts
# its own OpenCode container, and creating the session while that container is
# still binding its port yields a session id the runtime does not yet know, so
# the dispatch fails with "Session not found". Here the session is created and
# then dispatched with retries, against a runtime that is already listening.
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:8798}
USER_NAME=${USER_NAME:-tdm-scoping}
PASS_FILE=${PASS_FILE:-/srv/evimed-science/shared/secrets/bootstrap-password.txt}
PROJ=${1:?project id}
QFILE=${2:?question file}
LABEL=${3:-dispatch}
JAR=$(mktemp)

# Every call carries the project. Only /api/opencode/<proj>/session names it in
# the path; the rest — dispatch included — read it from this header and fall
# back to "default" otherwise. Omitting it creates the session in the project's
# runtime and then dispatches against the default project's runtime, which has
# never heard of that session: "Session not found", six times out of six.
api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$method" "${BASE}${path}" \
      -H "Content-Type: application/json" -H "X-Open-Science-CSRF: $CSRF" \
      -H "X-Open-Science-Project: $PROJ" -d "$body"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "${BASE}${path}" \
      -H "X-Open-Science-CSRF: $CSRF" -H "X-Open-Science-Project: $PROJ"
  fi
}

CSRF=""
LOGIN=$(curl -s -c "$JAR" -X POST "${BASE}/api/auth/login" -H "Content-Type: application/json" \
  -d "{\"username\":\"${USER_NAME}\",\"password\":$(sudo cat "$PASS_FILE" | python3 -c "import json,sys;print(json.dumps(sys.stdin.read().strip()))")}")
echo "$LOGIN" | grep -q '"error"' && { echo "登录失败"; exit 1; }
CSRF=$(printf '%s' "$LOGIN" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d.get('data') or d;print(d.get('csrfToken',''))")
[ -n "$CSRF" ] || { echo "无 csrfToken"; exit 1; }
echo "已登录 ${USER_NAME}，项目 ${PROJ}"

RUN=""
for attempt in 1 2 3 4 5 6; do
  OUT=$(api POST "/api/opencode/${PROJ}/session" '{}')
  SID=$(printf '%s' "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id') or (d.get('data') or {}).get('id',''))" 2>/dev/null)
  if [ -z "$SID" ]; then echo "  第 ${attempt} 次开会话失败，等待运行时…"; sleep 20; continue; fi
  api PUT "/api/research-sessions/${SID}" '{"mode":"open-domain"}' >/dev/null
  BODY=$(SID="$SID" LABEL="$LABEL" QFILE="$QFILE" python3 -c "
import json, os
print(json.dumps({'sessionId': os.environ['SID'], 'dispatchId': os.environ['LABEL'] + '-' + os.environ['SID'][-6:],
                  'text': open(os.environ['QFILE'], encoding='utf-8').read().strip()}))")
  OUT=$(api POST /api/agent-runs/dispatch "$BODY")
  RUN=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('id',''))" 2>/dev/null)
  AGENT=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('effectiveAgentId','?'))" 2>/dev/null)
  if [ -n "$RUN" ]; then echo "run ${RUN}"; echo "agent ${AGENT}"; break; fi
  echo "  第 ${attempt} 次派发失败: $(printf '%s' "$OUT" | head -c 160)"
  sleep 20
done
[ -n "$RUN" ] || { echo "派发始终失败"; exit 1; }

echo "== 等待 =="
for i in $(seq 1 480); do
  ST=$(api GET /api/agent-runs | RUN="$RUN" python3 -c "
import json, os, sys
runs = json.load(sys.stdin).get('data') or []
r = [x for x in runs if x.get('id') == os.environ['RUN']]
print('missing|-|0' if not r else f\"{r[0].get('status')}|{r[0].get('errorCode') or '-'}|{len(r[0].get('artifacts') or [])}\")")
  case "$ST" in succeeded*|failed*|canceled*) echo "FINAL: $ST（约 $((i/4)) 分钟）"; break ;; esac
  [ $((i % 8)) -eq 0 ] && echo "  ... $ST"
  sleep 15
done
echo "PROJECT=$PROJ"
echo "RUN=$RUN"
rm -f "$JAR"
