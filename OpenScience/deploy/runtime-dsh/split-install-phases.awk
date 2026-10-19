# Cut install-runtime.sh into one script per install phase, for the image build.
#
#   awk -v out=<directory> -f split-install-phases.awk install-runtime.sh
#
# The runtime Dockerfile runs every phase as its own RUN, and a RUN is cached
# only while every file copied before it is byte-identical. When the one script
# was copied ahead of the first RUN, an edit to any phase -- a comment in the
# office smoke -- rebuilt the system packages, R, Chromium, the Python stack and
# everything above them, and a release loaded all of it onto the serving host
# again. So the build copies each phase's own cut just before its RUN, and an
# edit reaches only the phase it is in and the layers after it.
#
# Each <out>/<phase>.sh is what `bash install-runtime.sh <phase>` runs and
# nothing else: the script's preamble (argument checks, target and base
# distribution) verbatim, any function no phase dispatches to (a helper), the
# phase's own function verbatim, and a dispatch that knows only that phase, so
# a cut copied under the wrong RUN fails with the script's own exit 64. Comments
# between functions are left out: editing one rebuilds nothing.
#
# The parse is the one scripts/ops/runtime-install-phases.mjs makes (a function
# opens with `name() {` and closes at a column-0 brace outside a heredoc; a
# phase is a `  phase) function ;;` line), and runtimeImageBuild.test.mjs holds
# every cut's function equal to the body that parser reads. Executable code
# outside a function and outside the closing dispatch would be lost from every
# cut, so it fails the cut instead.
#
# POSIX awk only (mawk is what debian:bookworm-slim carries).

function fail(message) {
  print "split-install-phases: " message > "/dev/stderr"
  failed = 1
  exit 1
}

BEGIN {
  if (out == "") fail("usage: awk -v out=<directory> -f split-install-phases.awk install-runtime.sh")
  infn = ""; seen_function = 0; in_dispatch = 0; heredoc = ""
  prelude = ""; nfn = 0; nphase = 0
}

# Inside a function: collect until its column-0 closing brace, heredoc-aware.
infn != "" {
  body[infn] = body[infn] "\n" $0
  if (heredoc != "") {
    if ($0 == heredoc) heredoc = ""
    next
  }
  if ($0 == "}") { infn = ""; next }
  if (match($0, /<<-?'?[A-Za-z_]+'?[ \t]*$/)) {
    heredoc = substr($0, RSTART, RLENGTH)
    sub(/^<<-?'?/, "", heredoc)
    sub(/'?[ \t]*$/, "", heredoc)
  }
  next
}

/^[a-z_]+[(][)] [{]$/ {
  infn = substr($0, 1, index($0, "(") - 1)
  if (infn in body) fail("function " infn " is defined twice")
  order[++nfn] = infn
  body[infn] = $0
  seen_function = 1
  next
}

# A phase of the closing dispatch: `  system) system ;;`.
/^  [a-z-]+[)] [a-z_]+ ;;$/ {
  line = $0
  sub(/^  /, "", line)
  phase = substr(line, 1, index(line, ")") - 1)
  fn = substr(line, index(line, ")") + 2)
  sub(/ ;;$/, "", fn)
  if (phase in target) fail("phase " phase " is dispatched twice")
  target[phase] = fn
  phases[++nphase] = phase
  dispatched[fn] = 1
  if (!seen_function) prelude = prelude $0 "\n"
  next
}

!seen_function { prelude = prelude $0 "\n"; next }

/^case "[$][{]phase[}]" in$/ { in_dispatch = 1; next }
in_dispatch && /^esac$/ { in_dispatch = 0; next }
in_dispatch { next }
/^[ \t]*$/ || /^[ \t]*#/ { next }
{ fail("line " NR " is executable code outside every function; a phase cut would lose it: " $0) }

END {
  if (failed) exit 1
  if (infn != "") fail("function " infn " is never closed")
  if (nphase == 0) fail("no phase dispatch found")
  helpers = ""
  for (i = 1; i <= nfn; i++) if (!(order[i] in dispatched)) helpers = helpers body[order[i]] "\n"
  for (i = 1; i <= nphase; i++) {
    phase = phases[i]; fn = target[phase]
    if (!(fn in body)) fail("phase " phase " dispatches to " fn ", which the script does not define")
    file = out "/" phase ".sh"
    printf "%s", prelude > file
    printf "# The %s phase of install-runtime.sh, cut by split-install-phases.awk.\n", phase > file
    printf "%s", helpers > file
    printf "%s\n", body[fn] > file
    printf "case \"${phase}\" in\n  %s) %s ;;\n  *) echo \"unknown phase: ${phase}\" >&2; exit 64 ;;\nesac\n", phase, fn > file
    close(file)
  }
}
