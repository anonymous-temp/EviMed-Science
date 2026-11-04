#!/usr/bin/env bash
# Stage the real-kernel stack the product runner (run_product.mjs) drives: the pinned DSH kernel, a sealed profile seed, and the
# socket of the tree under test staged into it. Scratch only: nothing here is the repository or production.
#
#   LIVE_ROOT=<dir> OS=<tree>/OpenScience KERNEL_FROM=<dir with node_modules/.bin/dsh at the pin> SEED_FROM=<sealed dsh-seed dir> ./live_stack.sh
#
# The kernel and the seed are copied from a stack another session already built (they are about 1.4 GB together and take the
# network to build); this script builds neither. It refuses to start when the copy would leave less than MIN_FREE_GB (default 4)
# free on the disk, and checks the kernel's version against deps-version.json, the one place the pin is written. Run again, it
# re-stages the socket from the tree and seals the seed again, so an edited tree is what runs. Adapted from the general-tasks
# seed.sh and the 0.2.1-rc.5 live-check seed (the Landlock runner row is pointed at a copy of the runner, because the image's
# path does not exist on this host; LoopX, the memory plugin and the search-topics bundle are left out on purpose).
#
# Prints, last, the two paths the harness is given:  TREE_DIR=<dir>  DSH_BIN=<path>
set -euo pipefail
LIVE_ROOT=${LIVE_ROOT:?set LIVE_ROOT to the directory the stack lives in}
OS=${OS:?set OS to the OpenScience tree under test}
KERNEL_FROM=${KERNEL_FROM:?set KERNEL_FROM to a directory holding node_modules/.bin/dsh at the pinned version}
SEED_FROM=${SEED_FROM:?set SEED_FROM to a sealed dsh-seed directory}
MIN_FREE_GB=${MIN_FREE_GB:-4}
L=$(mkdir -p "$LIVE_ROOT" && cd "$LIVE_ROOT" && pwd)
KERNEL=$L/kernel
SEED=$L/dsh-seed
SOCK=$L/opt/socket
PROFILE=$SEED/profiles/evimed-runtime
step() { echo "$(date -u +%FT%TZ) live_stack: $*" >&2; }
die() { echo "live_stack: $*" >&2; exit 3; }
pin() { node -p 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.argv[2].split(".").reduce((a,k)=>a?.[k],p)' "$OS/deps-version.json" "$1"; }
version_of() { node -p 'require(process.argv[1]).version' "$1/node_modules/@deepseek-ai/dsh/package.json" 2>/dev/null || echo none; }
WANT=$(pin dsh.version)

# 1. the kernel at the pin
[ "$(version_of "$KERNEL_FROM")" = "$WANT" ] || [ "$(version_of "$KERNEL")" = "$WANT" ] || die "no kernel at $WANT: $KERNEL_FROM has $(version_of "$KERNEL_FROM")"
need=0
[ "$(version_of "$KERNEL")" = "$WANT" ] || need=$((need + $(du -sb "$KERNEL_FROM" | cut -f1)))
[ -d "$PROFILE/node_modules/@evimed/dsh-socket" ] || need=$((need + $(du -sb "$SEED_FROM" | cut -f1)))
avail=$(df -B1 --output=avail "$L" | tail -1 | tr -d ' ')
left=$((avail - need))
step "needs $((need / 1048576)) MB, $((avail / 1048576)) MB free, $((left / 1048576)) MB would be left (floor $((MIN_FREE_GB * 1024)) MB)"
[ "$left" -ge $((MIN_FREE_GB * 1073741824)) ] || die "the copy would leave less than ${MIN_FREE_GB} GB free; nothing was copied"
if [ "$(version_of "$KERNEL")" != "$WANT" ]; then step "copy the kernel ($WANT)"; rm -rf "$KERNEL"; cp -a "$KERNEL_FROM" "$KERNEL"; fi
if [ ! -d "$PROFILE/node_modules/@evimed/dsh-socket" ]; then step "copy the profile seed"; rm -rf "$SEED"; cp -a "$SEED_FROM" "$SEED"; chmod -R u+w "$SEED"; rm -f "$SEED/.evimed-profile-seed.json"; fi
DSH_BIN=$KERNEL/node_modules/.bin/dsh
[ -x "$DSH_BIN" ] || die "no kernel binary at $DSH_BIN"

# 2. the tree's socket, in the staged directory and as the profile's own copy of it
runner() {
  sed "s#^launcher_pattern=.*#launcher_pattern='$KERNEL/node_modules/@deepseek-ai/node-addon-system-*/bin/landlock-run'#" \
    "$OS/deploy/runtime-dsh/evimed-landlock-run.sh" > "$L/evimed-landlock-run"
  chmod 0755 "$L/evimed-landlock-run"
}
stage_socket_files() {
  chmod -R u+w "$SOCK" 2>/dev/null || true
  rm -rf "$SOCK"; mkdir -p "$L/opt"
  (cd "$OS/packages" && tar --exclude=node_modules -cf - socket) | tar -xf - -C "$L/opt"
  mkdir -p "$SOCK/node_modules/@evimed"
  for p in domain harness-port design-tokens; do
    (cd "$OS/packages" && tar --exclude=node_modules -cf - "$p") | tar -xf - -C "$SOCK/node_modules/@evimed"
  done
  mkdir -p "$SOCK/scripts"
  cp "$OS/scripts/runtime/validate-personal-skill.mjs" "$SOCK/scripts/validate-personal-skill.mjs"
  node "$SOCK/scripts/build-client.mjs" >&2
  test -s "$SOCK/dist/client.js"
  install -d -m 0755 "$SOCK/presets/evimed-universal/skills"
  for s in core community curated-scientific office geo-private; do [ -d "$OS/runtime/skills/$s" ] && cp -a "$OS/runtime/skills/$s" "$SOCK/presets/evimed-universal/skills/$s"; done
  mkdir -p "$SOCK/presets/evimed-universal/skills/evimed"
  cp -a "$OS/runtime/skills/evimed/open-domain-answer" "$SOCK/presets/evimed-universal/skills/evimed/open-domain-answer"
  grep -q "^        id: evimed-universal$" "$SOCK/presets/evimed-universal.patch.yml"
  runner
  grep -rl "/usr/local/lib/evimed/evimed-landlock-run" "$SOCK/cordis.patch.yml" "$SOCK/presets" 2>/dev/null | while read -r f; do sed -i "s#/usr/local/lib/evimed/evimed-landlock-run#$L/evimed-landlock-run#g" "$f"; done
}
step "stage the socket from $OS ($(git -C "$OS" rev-parse --short HEAD 2>/dev/null || echo untracked))"
stage_socket_files
target="$(readlink -f "$PROFILE/node_modules/@evimed/dsh-socket")"
case "$target" in "$SEED"/*) ;; *) die "the profile's socket copy is outside the seed: $target" ;; esac
chmod -R u+w "$SEED"
# Delete-and-copy rather than write-through: pnpm hard-links package files from its store.
find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
(cd "$SOCK" && tar -cf - .) | tar -xf - -C "$target"
rm -f "$SEED/.evimed-profile-seed.json"
chmod 0644 "$PROFILE/package.json"
node "$OS/deploy/runtime-dsh/profile-seed.mjs" seal "$SEED" evimed-runtime >&2
step "sealed: $(du -sh "$SEED" | cut -f1); the stack is $(du -sh "$L" | cut -f1) in all"
echo "TREE_DIR=$L"
echo "DSH_BIN=$DSH_BIN"
