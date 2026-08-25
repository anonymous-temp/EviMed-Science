#!/usr/bin/env bash
# Drive a full analysis through the local EviMed stack, the same way the hosted
# API is driven: create a project, put the dataset in its workspace, open an
# open-domain session, dispatch, and wait.
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:8798}
USER_NAME=${OPEN_SCIENCE_BOOTSTRAP_USER:-evimed}
PASS_FILE=${PASS_FILE:-../.evimed-local/secrets/bootstrap-password}
LABEL=${1:?label}
QFILE=${2:?question file}
DATAFILE=${3:-}
JAR=$(mktemp)

api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$method" "${BASE}${path}" \
      -H "Content-Type: application/json" -H "X-Open-Science-CSRF: $CSRF" -d "$body"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "${BASE}${path}" -H "X-Open-Science-CSRF: $CSRF"
  fi
}

echo "== 登录 =="
CSRF=$(curl -s -c "$JAR" "${BASE}/api/auth/csrf" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('token',''))")
[ -n "$CSRF" ] || { echo "CSRF 获取失败"; exit 1; }
LOGIN=$(api POST /api/auth/login "{\"username\":\"${USER_NAME}\",\"password\":$(python3 -c "import json,sys;print(json.dumps(open(sys.argv[1]).read().strip()))" "$PASS_FILE")}")
echo "$LOGIN" | grep -q '"error"' && { echo "登录失败: $LOGIN"; exit 1; }
CSRF=$(curl -s -b "$JAR" -c "$JAR" "${BASE}/api/auth/csrf" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('token',''))")
echo "已登录"

TAG=$(date -u +%m%d-%H%M%S)
PROJ_ID="local-${LABEL}-${TAG}"
echo "== 建项目 ${PROJ_ID} =="
OUT=$(api POST /api/projects "{\"id\":\"${PROJ_ID}\",\"name\":\"本地分析 ${LABEL}\"}")
PROJ=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('id',''))" 2>/dev/null)
[ -n "$PROJ" ] || { echo "建项目失败: $OUT"; exit 1; }

if [ -n "$DATAFILE" ]; then
  echo "== 放入数据集 =="
  WS=$(node -e "
const {resolve}=require('path');
console.log(resolve(process.env.OPEN_SCIENCE_DATA_DIR || '../.evimed-local/run/data', 'users', process.argv[1], 'projects', process.argv[2], 'workspace'));
" "$USER_NAME" "$PROJ" 2>/dev/null)
  # The server owns the layout; find the workspace it actually created.
  WS=$(find "${OPEN_SCIENCE_DATA_DIR:-$HOME}" -maxdepth 8 -type d -path "*/projects/${PROJ}/workspace" 2>/dev/null | head -1)
  [ -n "$WS" ] || WS=$(find / -maxdepth 10 -type d -path "*/projects/${PROJ}/workspace" 2>/dev/null | head -1)
  [ -n "$WS" ] || { echo "找不到工作区"; exit 1; }
  cp "$DATAFILE" "$WS/" && echo "已放入 $WS"
fi

echo "== 开会话 =="
OUT=$(api POST "/api/opencode/${PROJ}/session" '{}')
SID=$(printf '%s' "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id') or (d.get('data') or {}).get('id',''))" 2>/dev/null)
[ -n "$SID" ] || { echo "开会话失败: $OUT"; exit 1; }
api PUT "/api/research-sessions/${SID}" '{"mode":"open-domain"}' >/dev/null
echo "会话 ${SID}（open-domain）"

echo "== 派发 =="
BODY=$(SID="$SID" LABEL="$LABEL" QFILE="$QFILE" python3 -c "
import json, os
print(json.dumps({'sessionId': os.environ['SID'], 'dispatchId': os.environ['LABEL'],
                  'text': open(os.environ['QFILE'], encoding='utf-8').read().strip()}))")
OUT=$(api POST /api/agent-runs/dispatch "$BODY")
RUN=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('id',''))" 2>/dev/null)
AGENT=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('effectiveAgentId','?'))" 2>/dev/null)
[ -n "$RUN" ] || { echo "派发失败: $OUT"; exit 1; }
echo "run ${RUN}"
echo "agent ${AGENT}"

echo "== 等待 =="
for i in $(seq 1 240); do
  ST=$(api GET /api/agent-runs | RUN="$RUN" python3 -c "
import json, os, sys
runs = json.load(sys.stdin).get('data') or []
r = [x for x in runs if x.get('id') == os.environ['RUN']]
print('missing|-|0' if not r else f\"{r[0].get('status')}|{r[0].get('errorCode') or '-'}|{len(r[0].get('artifacts') or [])}\")")
  case "$ST" in succeeded*|failed*|canceled*) echo "FINAL: $ST（${i}0 秒后）"; break ;; esac
  [ $((i % 6)) -eq 0 ] && echo "  ... $ST"
  sleep 15
done
echo "PROJECT=$PROJ"
echo "RUN=$RUN"
echo "SESSION=$SID"
rm -f "$JAR"
