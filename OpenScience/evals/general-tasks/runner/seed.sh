#!/usr/bin/env bash
# Stage the tree's socket into a DSH profile seed and seal it, so the kernel the harness starts runs the tree under test.
# Adapted from the WP-PROMPT seed.sh / stage-socket.sh (course correction 2026-10-12). Scratch only (/tmp), never the repo.
#
#   OS=<tree>/OpenScience [L=/tmp/eval/live] [SEED_FROM=<sealed seed dir>] ./seed.sh     prints the staged tree directory
#
# One staged directory per tree path ($L/trees/<key>: opt/socket + dsh-seed). If it has no profile yet, the profile is copied
# from SEED_FROM (or from any seed already staged under $L/trees); only with neither does it build one from the network
# (pnpm + the pinned kernel packages, about 500 MB, so do it once; this branch is adapted from the WP-PROMPT seed.sh and was not
# re-run for this suite). Every call re-stages the socket from the tree and replaces the profile's copy of it, then seals
# again, so an edited tree is what runs.
set -euo pipefail
OS=${OS:?set OS to the OpenScience tree under test}
L=${L:-/tmp/eval/live}
KEY=$(printf %s "$(readlink -f "$OS")" | sha1sum | cut -c1-8)
T=$L/trees/$KEY
SOCK=$T/opt/socket
SEED=$T/dsh-seed
PROFILE=$SEED/profiles/evimed-runtime
DSH_BIN=${DSH_BIN:-/tmp/evimed-openmed-dsh/node_modules/.bin/dsh}
step() { echo "$(date -u +%FT%TZ) seed: $*" >&2; }

stage_socket_files() {
  chmod -R u+w "$SOCK" 2>/dev/null || true
  rm -rf "$SOCK"; mkdir -p "$T/opt"
  (cd "$OS/packages" && tar --exclude=node_modules -cf - socket) | tar -xf - -C "$T/opt"
  mkdir -p "$SOCK/node_modules/@evimed"
  for p in domain harness-port design-tokens; do
    (cd "$OS/packages" && tar --exclude=node_modules -cf - "$p") | tar -xf - -C "$SOCK/node_modules/@evimed"
  done
  mkdir -p "$SOCK/scripts"
  cp "$OS/scripts/runtime/validate-personal-skill.mjs" "$SOCK/scripts/validate-personal-skill.mjs"
  cp "$(dirname "$0")/eval-memory-observer.mjs" "$SOCK/eval-memory-observer.mjs"
  node "$SOCK/scripts/build-client.mjs" >&2
  test -s "$SOCK/dist/client.js"
  # preset skills, as install-runtime.sh preset_skills
  install -d -m 0755 "$SOCK/presets/evimed-universal/skills"
  for s in core community curated-scientific office geo-private; do [ -d "$OS/runtime/skills/$s" ] && cp -a "$OS/runtime/skills/$s" "$SOCK/presets/evimed-universal/skills/$s"; done
  mkdir -p "$SOCK/presets/evimed-universal/skills/evimed"
  cp -a "$OS/runtime/skills/evimed/open-domain-answer" "$SOCK/presets/evimed-universal/skills/evimed/open-domain-answer"
  grep -q "^        id: evimed-universal$" "$SOCK/presets/evimed-universal.patch.yml"
}

mkdir -p "$T/opt" "$T/build"

# 1. a profile to start from
if [ ! -d "$PROFILE/node_modules/@evimed/dsh-socket" ]; then
  FROM=${SEED_FROM:-}
  if [ -z "$FROM" ]; then
    for candidate in "$L"/trees/*/dsh-seed; do [ -d "$candidate/profiles/evimed-runtime/node_modules/@evimed/dsh-socket" ] && FROM=$candidate && break; done
  fi
  if [ -n "$FROM" ]; then
    step "copy the profile seed from $FROM"
    rm -rf "$SEED"; cp -a "$FROM" "$SEED"; chmod -R u+w "$SEED"; rm -f "$SEED/.evimed-profile-seed.json"
  else
    step "build the profile seed from the network (the slow path)"
    export PATH="$L/tools/node_modules/.bin:$(dirname "$DSH_BIN"):$PATH"
    export npm_config_store_dir="$L/pnpm-store" pnpm_config_store_dir="$L/pnpm-store"
    if [ ! -x "$L/tools/node_modules/.bin/pnpm" ]; then mkdir -p "$L/tools"; (cd "$L/tools" && npm init -y >/dev/null && npm i --no-audit --no-fund pnpm@11.7.0 >/dev/null); fi
    LOOPX_TGZ=${LOOPX_TGZ:?set LOOPX_TGZ to the dsh-loopx-plugin archive named by deps-version.json loopx.plugin.filename}
    echo "$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).loopx.plugin.sha256' "$OS/deps-version.json")  $LOOPX_TGZ" | sha256sum -c - >&2
    cp "$OS/deploy/runtime-dsh/profile-kernel-pins.mjs" "$OS/deploy/runtime-dsh/runtime-yaml-security.mjs" "$OS/deploy/runtime-dsh/profile-seed.mjs" "$OS/deploy/runtime-dsh/loopx-compat.mjs" "$T/build/"
    sed -i "s#/opt/evimed/runtime-deps-version.json#$OS/deps-version.json#" "$T/build/runtime-yaml-security.mjs" "$T/build/profile-kernel-pins.mjs"
    stage_socket_files
    mkdir -p "$PROFILE"
    cp "$OS/deploy/runtime-dsh/profile-pnpm-workspace.yaml" "$PROFILE/pnpm-workspace.yaml"
    DSH_HOME="$SEED" "$DSH_BIN" plugin --profile evimed-runtime list --depth 0 >&2
    # Every version is read from deps-version.json, the one place they are written; a literal here is a copy that goes
    # stale in silence the day the pin moves (it did: the kernel, the citation bundle and the two client bundles).
    pin() { node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],p); if(v===undefined) process.exit(3); console.log(typeof v==="object"?Object.entries(v).map(([k,x])=>k+"@"+x).join(" "):v)' "$OS/deps-version.json" "$1"; }
    OPENVIKING_TGZ=$(node --input-type=module - "$OS" "$T" <<'JS'
import { readFileSync } from 'node:fs';
const [os, tree] = process.argv.slice(2);
const { fetchOpenVikingPlugin } = await import(`${os}/deploy/runtime-dsh/install-openviking-plugin.mjs`);
console.log(fetchOpenVikingPlugin({ pins: JSON.parse(readFileSync(`${os}/deps-version.json`)), root: `${tree}/archives` }));
JS
)
    DSH_VERSION=$(pin dsh.version)
    # shellcheck disable=SC2046
    node "$T/build/profile-kernel-pins.mjs" "$(dirname "$DSH_BIN")/../@deepseek-ai/dsh/package.json" "$PROFILE" "$OS/deploy/runtime-dsh/profile-pnpm-workspace.yaml" "$DSH_VERSION" "$(pin dsh.cordis)" $(pin dsh.communityPeerPins)
    DSH_HOME="$SEED" "$DSH_BIN" plugin --profile evimed-runtime add --save-prod --save-exact \
      "@deepseek-ai/dsh-base@$DSH_VERSION" "@deepseek-ai/dsh-web-app@$DSH_VERSION" "dsh-cite@$(pin dsh.citeVersion)" \
      "@changfenhuang/dsh-annotation@$(pin dsh.annotationVersion)" "dsh-mermaid@$(pin dsh.mermaidVersion)" "$LOOPX_TGZ" "$OPENVIKING_TGZ" "file:$SOCK" >&2
    node "$OS/deploy/runtime-dsh/install-openviking-plugin.mjs" order "$PROFILE/package.json" "$OS/deps-version.json"
    EVIMED_OPENVIKING_PLUGIN_ROOT="$T/archives" node "$OS/deploy/runtime-dsh/install-openviking-plugin.mjs" verify "$PROFILE/node_modules/@openviking/dsh-memory-plugin" "$OS/deps-version.json"
    node "$T/build/loopx-compat.mjs" --order-profile "$PROFILE/package.json"
    node "$T/build/loopx-compat.mjs" "$PROFILE/node_modules/dsh-loopx-plugin" "$OS/deps-version.json" "$SOCK/node_modules/@evimed/harness-port/src/loopxEvents.mjs"
  fi
fi

# Refuse an old copied seed rather than silently measuring a run without the memory plugin.
node --input-type=module - "$OS/deps-version.json" "$PROFILE" <<'JS'
import fs from 'node:fs';
const [pinsFile, profile] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(pinsFile)).openviking.plugin;
const installed = JSON.parse(fs.readFileSync(`${profile}/node_modules/${pin.name}/package.json`));
if (installed.version !== pin.version) throw new Error('Copied seed has a different memory plugin pin; rebuild the seed.');
JS

# The image library paths need host equivalents, including the sandbox's pinned launcher.
LIB=$T/lib/evimed
mkdir -p "$LIB"
cp "$OS/deploy/runtime-dsh/evimed-landlock-run.sh" "$LIB/evimed-landlock-run"
cp "$OS/deploy/runtime-dsh/evimed-tool-env.sh" "$LIB/evimed-tool-env.sh"
cp -a "$OS/deploy/runtime-dsh/tool-bin" "$LIB/"
node --input-type=module - "$LIB" "$DSH_BIN" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [lib, bin] = process.argv.slice(2);
const closure = path.resolve(path.dirname(bin), '..');
const file = `${lib}/evimed-landlock-run`;
let text = fs.readFileSync(file, 'utf8').replace('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules', closure);
// The host has no container namespace. Use the HOME the launch plan already maps.
text = text.replace('loopx_home=/runtime/home/.loopx', 'loopx_home=$HOME/.loopx');
fs.writeFileSync(file, text, { mode: 0o755 });
fs.chmodSync(file, 0o755);
const envFile = `${lib}/evimed-tool-env.sh`;
fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replaceAll('/usr/local/lib/evimed', lib)
  .replace('/runtime/tmp | /runtime/tmp/)', '*/runtime/tmp | */runtime/tmp/ | /runtime/tmp | /runtime/tmp/)'));
JS
# LibreOffice Kit is supplied by the pinned host kernel closure (as in the runtime image).
if [ -n "${EVAL_HOST_TOOL_BIN:-}" ]; then cp -a "$EVAL_HOST_TOOL_BIN/." "$LIB/tool-bin/"; fi

# 2. the tree's socket, in the staged directory and as the profile's own copy of it
step "stage the socket from $OS ($(git -C "$OS" rev-parse --short HEAD)$(git -C "$OS" diff --quiet HEAD -- . 2>/dev/null || echo '+dirty'))"
stage_socket_files
target="$(readlink -f "$PROFILE/node_modules/@evimed/dsh-socket")"
case "$target" in "$SEED"/*) ;; *) echo "socket copy is outside the seed: $target" >&2; exit 1;; esac
chmod -R u+w "$SEED"
# Delete-and-copy rather than write-through: pnpm hard-links package files from its store.
# The socket's bundled @evimed/domain, harness-port and design-tokens are part of the copy, so the whole directory is replaced.
find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
(cd "$SOCK" && tar -cf - .) | tar -xf - -C "$target"
rm -f "$SEED/.evimed-profile-seed.json"
chmod 0644 "$PROFILE/package.json"
node "$OS/deploy/runtime-dsh/profile-seed.mjs" seal "$SEED" evimed-runtime >&2
step "sealed: $(du -sh "$SEED" | cut -f1)"
echo "$T"
