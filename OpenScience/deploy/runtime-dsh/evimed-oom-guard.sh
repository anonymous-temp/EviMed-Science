#!/usr/bin/env bash
# Makes the model's shell processes the OOM killer's first choice, so a runaway analysis script dies
# before the kernel does.
#
# Why this runs beside the kernel instead of inside the command. A memory-cgroup OOM kills the process
# with the highest score (resident size plus its `oom_score_adj`), and a tool script that grows to
# 1.7 GB in a 2 GB container is exactly the process that should go. Twice (bix-6, BioXArena EGFR) the
# kernel's node process went with it and the session ended. Raising a process's own `oom_score_adj`
# needs no privilege and children inherit it, so the first design was one line in the shell's startup
# file. It cannot work: the bash tool runs every command inside a Landlock domain (dsh-sandbox-local)
# that allows writing only /tmp, the workspace and /dev/null, and /proc/self/oom_score_adj is none of
# those — measured on the runtime image, `echo 1000 > /proc/self/oom_score_adj` answers "Permission
# denied" there. A process outside the domain, with the same user as the kernel, can write another
# process's score, so this does.
#
# What it does. About once a second it looks at every process it has not looked at yet, and for each
# one whose environment carries DSH_SHELL=1 (the kernel gives exactly the processes of a model shell
# call that variable; MCP servers, socat and the kernel itself do not have it) raises the score to
# 1000. Children inherit the score at fork, so only the root of a command's process tree needs to be
# caught, and a command that runs for seconds is. A process is looked at again when its name changes
# (the launcher it was started through becomes bash by exec). A pid that dies and is handed to a process
# of the same name within one second would be taken for the old one; the pids do not wrap that fast.
#
# It changes who dies, never what a command may use: nothing is limited, nothing is killed here. It
# exits when its parent (the serve script) does, and a failure to write a score is noted once and
# otherwise ignored: without the guard the OOM killer picks by size alone, as before.
set -u
unset BASH_ENV

score=1000
interval=1
parent=${PPID}
warned=0
declare -A seen=()

echo "evimed-oom-guard: model shell processes are raised to oom_score_adj ${score}"

while kill -0 "${parent}" 2>/dev/null; do
  declare -A next=()
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    comm=
    { read -r comm < "${dir}/comm"; } 2>/dev/null || continue
    key="${pid}:${comm}"
    if [ -n "${seen[${key}]:-}" ]; then
      next[${key}]=1
      continue
    fi
    adj=
    { read -r adj < "/proc/${pid}/oom_score_adj"; } 2>/dev/null || continue
    if [ "${adj:-0}" -lt "${score}" ]; then
      tool=0
      while IFS= read -r -d '' entry; do
        if [ "${entry}" = "DSH_SHELL=1" ]; then tool=1; break; fi
      done 2>/dev/null < "/proc/${pid}/environ"
      if [ "${tool}" = 1 ] && ! { printf '%s' "${score}" > "/proc/${pid}/oom_score_adj"; } 2>/dev/null && [ "${warned}" = 0 ]; then
        warned=1
        echo "evimed-oom-guard: could not raise the score of process ${pid} (${comm}); the OOM killer picks by size alone" >&2
      fi
    fi
    # Only a process that is still there is remembered, so the table does not grow with the pids that came and went.
    next[${key}]=1
  done
  seen=()
  for key in "${!next[@]}"; do seen[${key}]=1; done
  unset next
  sleep "${interval}"
done
