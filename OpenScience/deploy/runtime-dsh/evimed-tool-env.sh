# shellcheck shell=bash
# What a model's shell command needs set that the kernel's own environment cannot say.
#
# `open-science-dsh-serve` exports BASH_ENV=<this file>, and bash sources it at the start of every
# non-interactive shell the kernel starts: the bash tool's `bash -c`, a script the model writes with a
# bash shebang, R's launcher. It must stay fast, silent, free of side effects beyond two variables,
# and safe under `set -eu` (it is read after the command line's own options are in force). Debian's
# bash skips BASH_ENV when its standard input is a socket (it takes that for rshd); the bash tool gives
# its commands /dev/null, so the file applies to all of them.
#
# Why the kernel's environment cannot say it. The bash tool runs every command inside a Landlock
# domain whose only writable places are /tmp, the workspace and /dev/null (dsh-sandbox-local's
# landlockProfileArgs, fixed: they do not follow TMPDIR or any setting). The kernel itself is not in
# that domain, and its spill files must stay on the project volume (TMPDIR=/runtime/tmp,
# runtimeManager.mjs `runtimeTmpDir`), so the one environment holds a TMPDIR the commands it starts
# cannot write to: `Rscript -e` died with "creating temporary file for '-e' failed", and LibreOffice
# Kit's render with EACCES on mkdtemp. Only the kernel's own value is replaced; a TMPDIR the command
# set itself (`TMPDIR=/workspace/tmp python ...`) is left alone, which also keeps a nested bash from
# undoing it.
case "${TMPDIR:-}" in
  /runtime/tmp | /runtime/tmp/) TMPDIR=/tmp; export TMPDIR ;;
esac

# `timeout` first, so that a signal to the command's process group reaches what it started (see
# tool-bin/timeout). Added once: a nested shell finds it already there.
# shellcheck disable=SC2123 # prepending to PATH is the point
case ":${PATH:-}:" in
  *:/usr/local/lib/evimed/tool-bin:*) ;;
  *) PATH="/usr/local/lib/evimed/tool-bin${PATH:+:${PATH}}"; export PATH ;;
esac
