#!/usr/bin/env sh

# Run from any UID: ./scripts/entrypoint_test.sh
# Shims exercise privilege transitions without changing the test user's UID
# or touching /var/opt/memos. Root + su-exec also checks real DAC access.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
ORIGINAL_PATH=$PATH
REAL_CAT=$(command -v cat)
REAL_UID=$(id -u)
REAL_SU_EXEC=$(command -v su-exec || true)
export REAL_CAT
mkdir "$TEMP_DIR/bin"
TRACE="$TEMP_DIR/trace"
export TRACE

cat > "$TEMP_DIR/bin/id" <<'SH'
#!/usr/bin/env sh
test "$1" = -u
printf '%s\n' "${TEST_UID:-10001}"
SH
cat > "$TEMP_DIR/bin/chown" <<'SH'
#!/usr/bin/env sh
# Never alter actual data during these tests.
exit 0
SH
cat > "$TEMP_DIR/bin/su-exec" <<'SH'
#!/usr/bin/env sh
set -eu
test "${MEMOS_ENTRYPOINT_SWITCHED:-}" = 1
test "${MEMOS_DSN_FILE+x}" != x
test "${MEMOS_DSN:-}" = "${TEST_EXPECTED_DSN:-}"
case "$("$REAL_CAT" "$TRACE")" in *switch:*) exit 1 ;; esac
printf 'switch:%s\n' "$1" >> "$TRACE"
export TEST_UID="${1%%:*}"
shift
exec "$@"
SH
cat > "$TEMP_DIR/bin/cat" <<'SH'
#!/usr/bin/env sh
if [ "$1" = "${TEST_PROTECTED_FILE:-}" ]; then
    printf 'read:%s\n' "${TEST_UID:-10001}" >> "$TRACE"
    # Model a root-owned 0600 mount even when this test runs without root.
    if [ "${TEST_UID:-10001}" != 0 ]; then
        exit 1
    fi
fi
if [ "$1" = "${TEST_READ_FAILURE:-}" ]; then
    exit 1
fi
exec "$REAL_CAT" "$@"
SH
chmod 755 "$TEMP_DIR/bin/"*
PATH="$TEMP_DIR/bin:$ORIGINAL_PATH"
export PATH

pass_count=0
pass() {
    printf 'PASS: %s\n' "$1"
    pass_count=$((pass_count + 1))
}
fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}
reset_case() {
    unset MEMOS_DSN MEMOS_DSN_FILE MEMOS_UID MEMOS_GID MEMOS_ENTRYPOINT_SWITCHED
    unset TEST_PROTECTED_FILE TEST_READ_FAILURE
    TEST_UID=10001
    TEST_EXPECTED_DSN='synthetic-dsn-with-password-do-not-log'
    export TEST_UID TEST_EXPECTED_DSN
    : > "$TRACE"
}
assert_no_secret() {
    case "$result" in
        *"$TEST_EXPECTED_DSN"*) fail "DSN appeared in process output" ;;
    esac
}
assert_value_command='test "${MEMOS_DSN:-}" = "$TEST_EXPECTED_DSN" && test "${MEMOS_DSN_FILE+x}" != x && test "${MEMOS_ENTRYPOINT_SWITCHED+x}" != x'

reset_case
export MEMOS_DSN="$TEST_EXPECTED_DSN"
result=$("$SCRIPT_DIR/entrypoint.sh" sh -c "$assert_value_command" 2>&1) || fail "Direct DSN was not preserved"
test ! -s "$TRACE" || fail "Non-root invocation attempted a privilege switch"
assert_no_secret
pass "Direct DSN remains available to the non-root command"

reset_case
printf '%s\n' "$TEST_EXPECTED_DSN" > "$TEMP_DIR/dsn"
chmod 600 "$TEMP_DIR/dsn"
export MEMOS_DSN_FILE="$TEMP_DIR/dsn"
result=$("$SCRIPT_DIR/entrypoint.sh" sh -c "$assert_value_command" 2>&1) || fail "Readable file failed"
assert_no_secret
pass "Readable DSN file is resolved and its reference removed"

reset_case
export TEST_UID=0 TEST_PROTECTED_FILE="$TEMP_DIR/dsn" MEMOS_DSN_FILE="$TEMP_DIR/dsn"
result=$("$SCRIPT_DIR/entrypoint.sh" sh -c "$assert_value_command && test \"\$(id -u)\" = 10001" 2>&1) || fail "Protected DSN was not preserved across the privilege drop"
expected=$(printf 'read:0\nswitch:10001:10001')
test "$("$REAL_CAT" "$TRACE")" = "$expected" || fail "Protected DSN was not read exactly once before su-exec"
assert_no_secret
pass "Root-only DSN is read before dropping to UID 10001 and survives re-exec"

reset_case
export TEST_UID=0 MEMOS_UID=0 MEMOS_GID=0 MEMOS_DSN_FILE="$TEMP_DIR/dsn" TEST_PROTECTED_FILE="$TEMP_DIR/dsn"
result=$("$SCRIPT_DIR/entrypoint.sh" sh -c "$assert_value_command && test \"\$(id -u)\" = 0" 2>&1) || fail "UID 0 re-exec failed"
expected=$(printf 'read:0\nswitch:0:0')
test "$("$REAL_CAT" "$TRACE")" = "$expected" || fail "UID 0 guard did not limit re-exec to once"
assert_no_secret
pass "Explicit UID 0 retains the existing one-time re-exec guard"

reset_case
export TEST_UID=0 MEMOS_DSN="$TEST_EXPECTED_DSN" MEMOS_DSN_FILE="$TEMP_DIR/dsn"
if result=$("$SCRIPT_DIR/entrypoint.sh" sh -c 'exit 0' 2>&1); then
    fail "Conflicting DSN value and file were accepted"
fi
case "$result" in *'are set (but are exclusive)'*) ;; *) fail "Conflict error missing" ;; esac
test ! -s "$TRACE" || fail "Conflict was handled after privileged work"
assert_no_secret
pass "Conflicting value/file fail before reading or dropping privileges without logging DSN"

reset_case
export MEMOS_DSN_FILE="$TEMP_DIR/missing"
if result=$("$SCRIPT_DIR/entrypoint.sh" sh -c 'exit 0' 2>&1); then
    fail "Missing DSN file was accepted"
fi
case "$result" in *'does not exist or is not readable'*) ;; *) fail "Missing file error missing" ;; esac
assert_no_secret
pass "A missing file fails closed"

reset_case
export MEMOS_DSN_FILE="$TEMP_DIR/dsn" TEST_PROTECTED_FILE="$TEMP_DIR/dsn"
if result=$("$SCRIPT_DIR/entrypoint.sh" sh -c 'exit 0' 2>&1); then
    fail "Non-root process accepted an unreadable protected DSN file"
fi
case "$result" in *'could not be read'*) ;; *) fail "Protected-file read error missing" ;; esac
assert_no_secret
pass "A directly started non-root process refuses an unreadable protected file"

reset_case
export MEMOS_DSN_FILE="$TEMP_DIR/dsn" TEST_READ_FAILURE="$TEMP_DIR/dsn"
if result=$("$SCRIPT_DIR/entrypoint.sh" sh -c 'exit 0' 2>&1); then
    fail "A read failure was silently converted into an empty DSN"
fi
assert_no_secret
pass "A failed read after the readability check fails closed"

reset_case
result=$("$SCRIPT_DIR/entrypoint.sh" sh -c 'test "${MEMOS_DSN:-}" = "" && test "${MEMOS_DSN_FILE+x}" != x') || fail "An unset DSN did not remain empty"
pass "An unset DSN stays empty"

if [ "$REAL_UID" = 0 ] && [ -n "$REAL_SU_EXEC" ]; then
    # Use real id/su-exec and root ownership, but keep chown stubbed so no
    # application data or its permissions can change during the test.
    mkdir "$TEMP_DIR/real-bin"
    cp "$TEMP_DIR/bin/chown" "$TEMP_DIR/real-bin/chown"
    cp "$SCRIPT_DIR/entrypoint.sh" "$TEMP_DIR/real-entrypoint.sh"
    chmod 755 "$TEMP_DIR" "$TEMP_DIR/real-entrypoint.sh"
    reset_case
    export MEMOS_DSN_FILE="$TEMP_DIR/dsn"
    PATH="$TEMP_DIR/real-bin:$ORIGINAL_PATH"
    export PATH
    result=$("$TEMP_DIR/real-entrypoint.sh" sh -c "$assert_value_command && test \"\$(id -u)\" = 10001" 2>&1) || fail "Real root-owned 0600 DSN failed during UID drop"
    assert_no_secret
    pass "Real su-exec retains a root-owned 0600 DSN after dropping privileges"
    if result=$("$REAL_SU_EXEC" 10001:10001 "$TEMP_DIR/real-entrypoint.sh" sh -c 'exit 0' 2>&1); then
        fail "Real UID 10001 read a root-owned 0600 DSN file"
    fi
    assert_no_secret
    pass "Real non-root startup refuses the root-owned 0600 DSN file"
else
    printf 'SKIP: real root/su-exec DAC checks require root with su-exec installed\n'
fi

printf 'Entrypoint tests passed: %s\n' "$pass_count"
