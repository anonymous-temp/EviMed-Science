#!/usr/bin/env bash
# A stand-in for `ssh <lab> <command>` as rsi-frontier-label.sh calls it: the command runs here, against a fake lab tree (FAKE_LAB_ROOT replaces /srv/rsi-lab), with
# the lab's privileged helpers faked (sudo, chown, install). `systemctl start` and `systemd-run` run the lab's script the way the service would
# (FAKE_LAB_SCRIPT, with the environment the test gave it), synchronously, and are logged to FAKE_SSH_LOG.
while [ "${1:-}" = -o ]; do shift 2; done
host=$1; shift
cmd="$*"
echo "$host :: $cmd" >> "$FAKE_SSH_LOG"
cmd=${cmd//\/srv\/rsi-lab/$FAKE_LAB_ROOT}
sudo() { if [ "$1" = sh ]; then shift; bash "$@"; else "$@"; fi; }
chown() { :; }
install() { local args=(); while [ $# -gt 0 ]; do case $1 in -m|-o|-g) shift 2 ;; -d) shift ;; *) args+=("$1"); shift ;; esac; done; mkdir -p "${args[@]}"; }
# `--no-block` returns at once on the real host: the lab's own exit code is recorded, not returned.
lab_run() { "$FAKE_LAB_SCRIPT" "$@" > "$FAKE_LAB_ROOT/lab-run.out" 2>&1; echo "lab exit $?" >> "$FAKE_SSH_LOG"; }
systemctl() { echo "systemctl $*" >> "$FAKE_SSH_LOG"; lab_run; }
systemd-run() { echo "systemd-run $*" >> "$FAKE_SSH_LOG"; while [[ ${1:-} == --* ]]; do shift; done; shift; lab_run "$@"; }
export -f sudo chown install lab_run systemctl systemd-run
exec bash -c "$cmd"
