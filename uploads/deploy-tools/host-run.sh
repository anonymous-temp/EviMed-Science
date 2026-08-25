#!/usr/bin/env bash
# Drive one analysis through the deployed stack, from the host itself.
#
#   host-run.sh <label> <question-file> [<data-file>]
#
# The same sequence local-run.sh uses, with the two differences that matter on a
# deployed host: the bootstrap credential is read from the shared secrets
# directory rather than a checkout, and the project workspace lives inside a
# Docker volume, so placing the dataset needs root.
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:8798}
USER_NAME=${USER_NAME:-tdm-scoping}
PASS_FILE=${PASS_FILE:-/srv/evimed-science/shared/secrets/bootstrap-password.txt}
DATA_ROOT=${DATA_ROOT:-/var/lib/docker/volumes/evimed-science-data/_data}
LABEL=${1:?label}
QFILE=${2:?question file}
DATAFILE=${3:-}
JAR=$(mktemp)

# PROJ is empty until the project exists; every later call carries it, because
# the dispatch endpoint reads the project from this header and falls back to
# "default" without it.
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

# There is no /api/auth/csrf route: the token comes back from the login
# response itself, and the older local-run.sh still asks for the endpoint,
# which the SPA fallback answers with HTML.
echo "== 登录 =="
CSRF=""
LOGIN=$(curl -s -c "$JAR" -X POST "${BASE}/api/auth/login" -H "Content-Type: application/json" \
  -d "{\"username\":\"${USER_NAME}\",\"password\":$(sudo cat "$PASS_FILE" | python3 -c "import json,sys;print(json.dumps(sys.stdin.read().strip()))")}")
echo "$LOGIN" | grep -q '"error"' && { echo "登录失败: $(echo "$LOGIN" | head -c 200)"; exit 1; }
CSRF=$(printf '%s' "$LOGIN" | python3 -c "
import json,sys
d=json.load(sys.stdin); d=d.get('data') or d
print(d.get('csrfToken',''))")
[ -n "$CSRF" ] || { echo "登录响应没有 csrfToken"; exit 1; }
echo "已登录 ${USER_NAME}"

TAG=$(date -u +%m%d-%H%M%S)
PROJ_ID="${LABEL}-${TAG}"
echo "== 建项目 ${PROJ_ID} =="
OUT=$(api POST /api/projects "{\"id\":\"${PROJ_ID}\",\"name\":\"${LABEL} ${TAG}\"}")
PROJ=$(printf '%s' "$OUT" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data') or {}).get('id',''))" 2>/dev/null)
[ -n "$PROJ" ] || { echo "建项目失败: $OUT"; exit 1; }

if [ -n "$DATAFILE" ]; then
  echo "== 放入数据集 =="
  WS=$(sudo find "$DATA_ROOT" -maxdepth 8 -type d -path "*/projects/${PROJ}/workspace" 2>/dev/null | head -1)
  [ -n "$WS" ] || { echo "找不到工作区"; exit 1; }
  sudo cp "$DATAFILE" "$WS/" || { echo "放入失败"; exit 1; }
  echo "已放入 $WS/$(basename "$DATAFILE")"
fi

# A fresh project starts its own OpenCode container, and a session created while
# that container is still binding its port yields an id the runtime does not yet
# know. Hand over to the dispatcher, which retries against a warm runtime.
echo "== 等待运行时就绪并派发 =="
exec bash "$(dirname "$0")/host-dispatch.sh" "$PROJ" "$QFILE" "$LABEL"
