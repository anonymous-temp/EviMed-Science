#!/usr/bin/env bash
# The runtime image's install steps, one phase per image layer.
#
# Two Dockerfiles run this script and nothing else installs anything:
# `Dockerfile` (the Docker provider, on debian:bookworm-slim) and
# `Dockerfile.agentbay` (the AgentBay provider, on the CodeSpace system image
# `agentbay image init` hands out: code-space-debian-12 or aio-ubuntu-2404).
# Each Dockerfile keeps its own ARGs, COPYs, ENVs and LABELs — a Dockerfile
# cannot include another — and calls the phases below in the same order, which
# `deploy.test.mjs` holds equal, so the two images cannot drift apart in what
# they install.
#
#   install-runtime.sh <phase>
#
# Every version and digest arrives from the Dockerfile's ARGs, which the build
# exports to RUN as environment variables; this file writes none down. The
# kernel pin is `deps-version.json`'s, through each Dockerfile's
# `ARG DSH_VERSION`, and a test holds every copy equal to it.
#
# EVIMED_RUNTIME_TARGET is `docker` (default) or `agentbay`. Only the
# `session` phase and the AgentBay-only packages differ between the two; the
# Docker image is what it was before this script existed.
set -euo pipefail

phase="${1:?usage: install-runtime.sh <phase>}"
target="${EVIMED_RUNTIME_TARGET:-docker}"
case "${target}" in docker|agentbay) ;; *) echo "EVIMED_RUNTIME_TARGET must be docker or agentbay, got ${target}" >&2; exit 64 ;; esac

# The base's distribution: debian (bookworm) or ubuntu (noble). Anything else
# is refused rather than guessed at — a package name that differs between the
# two is a failed build here, not a missing tool in a run.
os_id="$(. /etc/os-release && echo "${ID}")"
case "${os_id}" in debian|ubuntu) ;; *) echo "unsupported base distribution: ${os_id}" >&2; exit 64 ;; esac

system() {
  set -x
  if [ "${os_id}" = debian ]; then
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then
      sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources
    fi
  elif [ -n "${UBUNTU_APT_MIRROR:-}" ]; then
    # Ubuntu's own mirror, only when one is named: a CodeSpace image arrives
    # with the sources its vendor chose, and they are left alone otherwise.
    for sources in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
      if [ -f "${sources}" ]; then
        sed -ri "s#https?://(archive|security)\.ubuntu\.com/ubuntu#${UBUNTU_APT_MIRROR}#g" "${sources}"
      fi
    done
  fi
  # Chromium comes from apt on Debian. On Ubuntu 24.04 the `chromium` package
  # is a transitional stub that installs the snap, and snapd does not run in a
  # container or a CodeSpace session — so there it comes from Playwright's own
  # build instead (the `browser` phase).
  local browser=chromium
  if [ "${os_id}" = ubuntu ]; then browser=""; fi
  # The AgentBay image also carries what its session launcher uses: the egress
  # firewall, and the process tools the launcher stops a previous kernel with.
  local session_packages=()
  if [ "${target}" = agentbay ]; then session_packages=(iptables procps); fi
  apt-get update
  apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    ${browser} \
    curl \
    fonts-noto-cjk \
    git \
    gzip \
    python-is-python3 \
    python3 \
    python3-venv \
    r-base-core \
    r-recommended \
    ripgrep \
    socat \
    tar \
    util-linux \
    xz-utils \
    "${session_packages[@]}"
  rm -rf /var/lib/apt/lists/*
}

# Node and uv. Node is here because DSH is a Node program; the sandbox backend
# it will actually use inside a container is Landlock, which needs no package.
toolchain() {
  set -x
  case "${TARGETARCH}" in
    amd64) NODE_ARCH="x64"; NODE_SHA256="${NODE_SHA256_AMD64}"; UV_TRIPLE="x86_64-unknown-linux-gnu"; UV_SHA256="${UV_SHA256_AMD64}" ;;
    arm64) NODE_ARCH="arm64"; NODE_SHA256="${NODE_SHA256_ARM64}"; UV_TRIPLE="aarch64-unknown-linux-gnu"; UV_SHA256="${UV_SHA256_ARM64}" ;;
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  curl_args=(--http1.1 --fail --show-error --location --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 600 --speed-limit 1024 --speed-time 60 --continue-at -)
  curl "${curl_args[@]}" "${NODE_DIST_BASE}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o "${tmp}/node.tar.xz"
  if [ -z "${NODE_SHA256}" ]; then echo "No Node sha256 pinned for TARGETARCH=${TARGETARCH}; refusing to install an unverified runtime." >&2; exit 1; fi
  printf '%s  %s\n' "${NODE_SHA256}" "${tmp}/node.tar.xz" | sha256sum -c -
  tar -xJf "${tmp}/node.tar.xz" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=README.md
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TRIPLE}.tar.gz" -o "${tmp}/uv.tar.gz"
  printf '%s  %s\n' "${UV_SHA256}" "${tmp}/uv.tar.gz" | sha256sum -c -
  tar -xzf "${tmp}/uv.tar.gz" -C "${tmp}"
  install -m 0755 "$(find "${tmp}" -type f -name uv | head -n 1)" /usr/local/bin/uv
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/LICENSE-MIT" -o "${tmp}/uv-LICENSE-MIT"
  printf '%s  %s\n' "${UV_LICENSE_MIT_SHA256}" "${tmp}/uv-LICENSE-MIT" | sha256sum -c -
  install -d -m 0755 /usr/share/licenses/uv
  install -m 0644 "${tmp}/uv-LICENSE-MIT" /usr/share/licenses/uv/LICENSE-MIT
  rm -rf "${tmp}"
  node --version
  uv --version
}

# The kernel, and its whole subpackage tree, at one version.
#
# The CLI declares prerelease ranges for its own subpackages. An exact root
# version can otherwise resolve a mixed tree after a later release appears.
#
# So the resolution is fixed by `--before` and then *verified across the whole
# tree*, because a date filter is a request and the assertion is the guarantee.
# The scan fails when it finds implausibly few packages, so a broken readdir
# reports a broken scan rather than a clean tree. It did, on the alpha.5 build:
# npm placed all 223 subpackages under the pin's own `node_modules` instead of
# hoisting them beside it, and a scan that knew only the hoisted layout found
# one package and said so. Both layouts are searched now, and the one in use is
# printed — a layout change should be visible in the log rather than inferred
# from a count.
kernel() {
  set -x
  npm config set registry "${NPM_REGISTRY}"
  npm install -g --no-fund --no-audit --before="${DSH_PUBLISHED_BEFORE}" "@deepseek-ai/dsh@${DSH_VERSION}"
  dsh --version
  installed="$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version")"
  test "${installed}" = "${DSH_VERSION}" || { echo "installed dsh ${installed} != pinned ${DSH_VERSION}" >&2; exit 1; }
  node -e '
    const fs = require("fs"), path = require("path");
    const [pin] = process.argv.slice(1);
    const roots = ["/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai", "/usr/local/lib/node_modules/@deepseek-ai"];
    const dir = roots.find((candidate) => { try { return fs.readdirSync(candidate).filter((n) => n.startsWith("dsh")).length >= 50; } catch { return false; } });
    if (!dir) { console.error("no @deepseek-ai directory holds 50+ dsh* packages; looked in " + roots.join(" and ") + " — the scan, not the tree, is wrong"); process.exit(2); }
    console.log("scanning " + dir);
    const names = fs.readdirSync(dir).filter((n) => n.startsWith("dsh"));
    const drifted = names.map((n) => [n, JSON.parse(fs.readFileSync(path.join(dir, n, "package.json"), "utf8")).version]).filter(([, v]) => v !== pin);
    if (drifted.length) { console.error(drifted.length + " of " + names.length + " @deepseek-ai/dsh* packages are not " + pin + "; the registry resolved newer subpackages, which usually means NPM_REGISTRY is a mirror that does not honour --before (its packuments carry no publish times). Point NPM_REGISTRY at a registry that does, or vendor the tree."); for (const [n, v] of drifted.slice(0, 8)) console.error("  " + n + " = " + v); process.exit(1); }
    console.log("all " + names.length + " @deepseek-ai/dsh* packages are " + pin);
  ' "${DSH_VERSION}"
  cordis="$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json').version" 2>/dev/null || node -p "require('@deepseek-ai/cordis/package.json').version")"
  test "${cordis}" = "${DSH_CORDIS_VERSION}" || { echo "resolved cordis ${cordis} != pinned ${DSH_CORDIS_VERSION}" >&2; exit 1; }
}

# `dsh plugin add` manages a profile's plugin set with pnpm, so the image has
# to carry it before a profile can be pre-initialised. It is a real global
# package rather than a Corepack shim, which would reach the registry on every
# invocation from a runtime that has no route off the host by design. The
# version tracks DSH's own packageManager (deps-version.json keeps it next to
# the DSH pin), not the workspace's.
pnpm_tool() {
  set -x
  npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"
  pnpm config set registry "${NPM_REGISTRY}"
  installed="$(pnpm --version)"
  test "${installed}" = "${PNPM_VERSION}" || { echo "installed pnpm ${installed} != pinned ${PNPM_VERSION}" >&2; exit 1; }
  env -u COREPACK_NPM_REGISTRY npm_config_registry=http://127.0.0.1:1 pnpm --version > /dev/null
}

# The scientific stack every run executes in, pinned so a green image build is
# evidence that production has the same Python/R capabilities tested in CI.
# ipykernel and jupyterlab serve the runs, not a notebook page: the curated
# skills have a run execute its analysis as a notebook and deliver the .ipynb.
python_stack() {
  set -x
  uv venv "${VIRTUAL_ENV}" --python /usr/bin/python3
  uv pip install --python "${VIRTUAL_ENV}/bin/python" --index-url "${PIP_INDEX_URL}" --no-cache \
    ipykernel==6.29.5 \
    jupyterlab==4.4.3 \
    matplotlib==3.10.3 \
    numpy==2.2.6 \
    openpyxl==3.1.5 \
    pandas==2.2.3 \
    Pillow==10.4.0 \
    playwright==1.58.0 \
    pypdf==6.7.0 \
    scikit-learn==1.6.1 \
    scipy==1.15.3 \
    statsmodels==0.14.6
  python - <<'PY'
import importlib

for package in ("ipykernel", "jupyterlab", "matplotlib", "numpy", "openpyxl", "pandas", "PIL", "playwright", "pypdf", "sklearn", "scipy", "statsmodels"):
    importlib.import_module(package)
PY
}

# A browser that is not a snap. Debian's apt package is already in place; on
# Ubuntu 24.04 Playwright's own Chromium build (the one the pinned `playwright`
# package drives) is installed into a fixed root with its system libraries, and
# linked where the Debian package puts its binary, so `/usr/bin/chromium` means
# the same thing on both bases. PLAYWRIGHT_DOWNLOAD_HOST names a mirror when
# the default CDN is slow from the build host.
browser() {
  set -x
  if [ "${os_id}" = debian ]; then
    test -x /usr/bin/chromium
    return 0
  fi
  export PLAYWRIGHT_BROWSERS_PATH=/opt/evimed/ms-playwright
  apt-get update
  python -m playwright install --with-deps chromium
  rm -rf /var/lib/apt/lists/*
  chrome="$(find "${PLAYWRIGHT_BROWSERS_PATH}" -path '*/chrome-linux*/chrome' -type f -perm -u+x | sort | head -n 1)"
  test -n "${chrome}"
  ln -sf "${chrome}" /usr/bin/chromium
  chmod -R a-w "${PLAYWRIGHT_BROWSERS_PATH}"
  /usr/bin/chromium --version
}

verify_tools() {
  set -x
  test -x /usr/bin/chromium && rg --version && python -m playwright --version
  Rscript -e 'stopifnot(getRversion() >= "4.0.0", abs(mean(c(1, 2, 3)) - 2) < 1e-12)'
}

# Smoke every shared curated-skill implementation in the production dependency
# image. The two dedicated matplotlib/statistical-power chains are exercised in
# the next phase.
curated_smoke() {
  python3 - <<'PY'
import importlib.util
import json
import pathlib
import tempfile

root = pathlib.Path("/usr/local/share/evimed/skills/curated-scientific")
inventory = json.loads((root / "inventory.json").read_text(encoding="utf-8"))
contracts = inventory["policy"]["delivery"]["executable"]
shared = {
    name: contract
    for name, contract in contracts.items()
    if "../_runtime/execute_skill.py" in contract["entrypoints"]
}
if len(contracts) != 38 or len(shared) != 36:
    raise SystemExit("curated delivery inventory is incomplete")

spec = importlib.util.spec_from_file_location("evimed_curated_executor", root / "_runtime/execute_skill.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    output_root = pathlib.Path(temporary)
    for name, contract in sorted(shared.items()):
        output_dir = output_root / name
        output_dir.mkdir()
        receipt = module.execute(name, module.smoke_request(name), output_dir, None)
        (output_dir / "execution-receipt.json").write_text(
            json.dumps(receipt, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if receipt["skill"] != name or receipt["status"] not in {"success", "warning"}:
            raise SystemExit(f"curated smoke failed: {name}")
        for artifact in contract["artifacts"]:
            path = output_dir / artifact
            if not path.is_file() or path.stat().st_size == 0:
                raise SystemExit(f"curated smoke artifact missing: {name}/{artifact}")
print(f"smoked {len(shared)} shared curated skill implementations")
PY
}

office_smoke() {
  set -x
  export MPLBACKEND=Agg
  tmp="$(mktemp -d)"
  python3 /usr/local/share/evimed/skills/curated-scientific/matplotlib/scripts/plot_template.py --plot-type line --output "${tmp}/figure.png"
  python3 /usr/local/share/evimed/skills/curated-scientific/matplotlib/scripts/plot_template.py --plot-type line --output "${tmp}/figure.svg"
  test -s "${tmp}/figure.png"
  test -s "${tmp}/figure.svg"
  python3 /usr/local/share/evimed/skills/curated-scientific/statistical-power/scripts/export_power_analysis.py --output-dir "${tmp}/power"
  test -s "${tmp}/power/power-analysis.md"
  test -s "${tmp}/power/power-curve.csv"
  test -s "${tmp}/power/power-curve.png"
  python3 /usr/local/share/evimed/skills/office/docx/scripts/create_docx.py --text "EviMed" --output "${tmp}/document.docx"
  python3 /usr/local/share/evimed/skills/office/pdf/scripts/create_pdf.py --text "EviMed" --output "${tmp}/document.pdf"
  python3 /usr/local/share/evimed/skills/office/pptx/scripts/create_pptx.py --title "EviMed" --body "Evidence" --output "${tmp}/presentation.pptx"
  printf 'name,value\ncontrol,1\n' > "${tmp}/input.csv"
  python3 /usr/local/share/evimed/skills/office/xlsx/scripts/create_xlsx.py --input "${tmp}/input.csv" --output "${tmp}/workbook.xlsx"
  python3 -c 'import pathlib,sys,zipfile; files=[pathlib.Path(sys.argv[1])/name for name in ("document.docx","presentation.pptx","workbook.xlsx")]; [zipfile.ZipFile(file).testzip() for file in files]' "${tmp}"
  rm -rf "${tmp}"
}

# Generated assets are absent from a clean Git context. Verify pinned upstream
# bytes and execute offline queries before sealing the runtime filesystem.
sider_cache() {
  set -x
  python3 /opt/evimed/mcp/evimed-research/build_sider_cache.py
}

socket_client() {
  set -x
  node /opt/evimed/socket/scripts/build-client.mjs
  test -s /opt/evimed/socket/dist/client.js
}

# The preset ships inside the bundle as a *system*-trusted root, so a copy a
# user made into their own root cannot shadow it: the first root wins on a name
# collision, and system roots come first.
preset_skills() {
  set -x
  install -d -m 0755 /opt/evimed/socket/presets/evimed-universal/skills
  cp -a /opt/evimed/skills/core /opt/evimed/socket/presets/evimed-universal/skills/core
  cp -a /opt/evimed/skills/evimed /opt/evimed/socket/presets/evimed-universal/skills/evimed
  cp -a /usr/local/share/evimed/skills/curated-scientific /opt/evimed/socket/presets/evimed-universal/skills/curated-scientific
  cp -a /usr/local/share/evimed/skills/office /opt/evimed/socket/presets/evimed-universal/skills/office
  cp -a /opt/evimed/skills/community /opt/evimed/socket/presets/evimed-universal/skills/community
  cp -a /opt/evimed/skills/geo-private /opt/evimed/socket/presets/evimed-universal/skills/geo-private
  chmod -R a-w /opt/evimed/socket /opt/evimed/capabilities /opt/evimed/capability-skills /opt/evimed/mcp
}

# A root this image owns, named by the profile patch's `agent-presets.roots`.
# The shipped root is prepended before configured roots, so naming our own root
# works, and a container does not write into its own installation. The two
# assertions check the name on both sides: the control plane asks for this
# exact string.
preset_root() {
  set -x
  mkdir -p "${DSH_PRESET_ROOT}"
  cp -a /opt/evimed/socket/presets/evimed-universal "${DSH_PRESET_ROOT}/evimed-universal"
  chmod -R a-w "${DSH_PRESET_ROOT}/evimed-universal"
  grep -q "^name: evimed-universal$" "${DSH_PRESET_ROOT}/evimed-universal/preset.yml"
  test -f "${DSH_PRESET_ROOT}/evimed-universal/agent.cordis.yml"
}

# The profile, pre-initialized at build time outside `/runtime` (which a
# container mounts per project), so a container never installs its own plugins
# over the network while serving. The boot helper projects the managed package
# roots from this immutable seed into each profile and reconciles them by
# digest on an image change.
#
# Every bundle carries an exact version: the harness's own at the kernel pin,
# and each community bundle at the version recorded in
# runtime/skills/community/plugin-support.json and deps-version.json (tests hold
# the three equal). The socket is added as `file:` rather than as a bare path,
# so pnpm copies it into the profile's own store and the seed stays
# relocatable. The seed then proves itself four ways: a loadable native binding,
# a non-empty --dump-config equal to the committed baseline, a relocated copy
# that still composes, and `build-smoke.sh` booting it (the `smoke` phase).
#
# The kernel closure is pinned into the profile before the add (pnpm resolves
# the profile independently of npm's --before), and so is each community
# bundle's own peer outside that closure (DSH_COMMUNITY_PEER_PINS), which pnpm
# would otherwise install at whatever its range resolves to on the build day.
profile_seed() {
  set -x
  install -d -m 0755 "${DSH_HOME_SEED}/profiles/evimed-runtime"
  cp /opt/evimed/profile-pnpm-workspace.yaml "${DSH_HOME_SEED}/profiles/evimed-runtime/pnpm-workspace.yaml"
  DSH_HOME="${DSH_HOME_SEED}" dsh plugin --profile evimed-runtime list --depth 0
  # shellcheck disable=SC2086
  node /usr/local/bin/evimed-profile-kernel-pins.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json "${DSH_HOME_SEED}/profiles/evimed-runtime" /opt/evimed/profile-pnpm-workspace.yaml "${DSH_VERSION}" "${DSH_CORDIS_VERSION}" ${DSH_COMMUNITY_PEER_PINS}
  DSH_HOME="${DSH_HOME_SEED}" dsh plugin --profile evimed-runtime add --save-prod --save-exact "@deepseek-ai/dsh-base@${DSH_VERSION}" "@deepseek-ai/dsh-web-app@${DSH_VERSION}" "${DSH_CITE_BUNDLE}" "${DSH_ANNOTATION_BUNDLE}" "${DSH_MERMAID_BUNDLE}" file:/opt/evimed/socket
  node -e 'const fs=require("node:fs"),path=require("node:path"); const [root,want]=process.argv.slice(1),seen=new Set(); for(const entry of fs.readdirSync(root,{recursive:true})){const match=entry.match(/(?:^|\/)@deepseek-ai\/(dsh(?:-[^/]+)?)\/package\.json$/); if(!match)continue; const pkg=JSON.parse(fs.readFileSync(path.join(root,entry),"utf8")); if(pkg.name!=="@deepseek-ai/"+match[1]||pkg.version!==want)throw Error("Profile kernel package differs from the pinned CLI: "+pkg.name); seen.add(pkg.name);} if(seen.size<100)throw Error("Profile kernel inventory is incomplete"); console.log("Verified profile kernel packages:",seen.size,want);' "${DSH_HOME_SEED}/profiles/evimed-runtime/node_modules" "${DSH_VERSION}"
  # Each community bundle at exactly its recorded version, read back from what
  # pnpm installed rather than from what was asked for.
  node -e 'const fs=require("node:fs"),path=require("node:path"); const [root,...specs]=process.argv.slice(1); for(const spec of specs){const at=spec.lastIndexOf("@"); const name=spec.slice(0,at),want=spec.slice(at+1); const pkg=JSON.parse(fs.readFileSync(path.join(root,name,"package.json"),"utf8")); if(pkg.name!==name||pkg.version!==want)throw Error("Community bundle "+name+" is "+pkg.version+", not the recorded "+want); console.log("Verified community bundle",spec);}' "${DSH_HOME_SEED}/profiles/evimed-runtime/node_modules" "${DSH_CITE_BUNDLE}" "${DSH_ANNOTATION_BUNDLE}" "${DSH_MERMAID_BUNDLE}"
  pty_platform="$(node -p 'process.platform + "-" + process.arch')"
  pty_binding="$(find "${DSH_HOME_SEED}/profiles/evimed-runtime/node_modules" -path "*/node-pty/prebuilds/${pty_platform}/pty.node" -print -quit)"
  test -n "${pty_binding}"
  node -e 'require(process.argv[1])' "${pty_binding}"
  DSH_HOME="${DSH_HOME_SEED}" dsh --profile evimed-runtime --dump-config > /opt/evimed/dump-config.baseline.json
  test -s /opt/evimed/dump-config.baseline.json
  diff -u /opt/evimed/committed-dump-config.baseline.json /opt/evimed/dump-config.baseline.json
  relocated="$(mktemp -d)"
  cp -a "${DSH_HOME_SEED}/." "${relocated}/"
  DSH_HOME="${relocated}" dsh --profile evimed-runtime --dump-config > /dev/null
  rm -rf "${relocated}"
  node /usr/local/bin/evimed-profile-seed.mjs seal "${DSH_HOME_SEED}" evimed-runtime
  chmod -R a-w "${DSH_HOME_SEED}"
}

# The boot proof: the sealed seed, relocated the way startup relocates it,
# boots with every entry applied and mounts an evimed-universal session.
smoke() {
  set -x
  chmod 0755 /usr/local/bin/evimed-build-smoke
  SOCKET_VERSION="${SOCKET_VERSION}" /usr/local/bin/evimed-build-smoke
}

serve() {
  set -x
  chmod 0755 /usr/local/bin/open-science-dsh-serve
}

# What only an AgentBay session needs (plan §3.1 #3, #6): its launcher and the
# session bridge in front of the kernel, and the unprivileged user the kernel
# runs as. A CodeSpace session is a VM whose root filesystem is writable, so
# what `--read-only` gives a Docker runtime is given here by ownership: every
# installed tree is root's and not writable by the runtime user, which the
# last lines check rather than assume. The user's home, the kernel's DSH_HOME
# and the workspace are created and handed over by `evimed-session start`.
session() {
  set -x
  [ "${target}" = agentbay ] || { echo "the session phase belongs to the AgentBay image" >&2; exit 64; }
  chmod 0755 /usr/local/bin/evimed-session /usr/local/bin/evimed-session-bridge.mjs
  command -v iptables >/dev/null
  command -v runuser >/dev/null && command -v setsid >/dev/null && command -v pkill >/dev/null
  if ! id -u "${EVIMED_RUNTIME_USER}" >/dev/null 2>&1; then
    useradd --system --uid "${EVIMED_RUNTIME_UID}" --user-group --home-dir /runtime/home --no-create-home \
      --shell /usr/sbin/nologin "${EVIMED_RUNTIME_USER}"
  fi
  # /run is a tmpfs in a running session, so the launcher makes /run/evimed
  # itself; /runtime is on the image's disk and stays root's.
  install -d -o root -g root -m 0755 /runtime
  for tree in /opt/evimed /usr/local/share/evimed /usr/local/lib/node_modules /usr/local/bin; do
    chown -R root:root "${tree}"
    chmod -R go-w "${tree}"
  done
  writable="$(runuser -u "${EVIMED_RUNTIME_USER}" -- find /opt/evimed /usr/local/share/evimed /usr/local/lib/node_modules /usr/local/bin -writable -print -quit 2>/dev/null || true)"
  test -z "${writable}" || { echo "the runtime user can write ${writable}" >&2; exit 1; }
}

case "${phase}" in
  system) system ;;
  toolchain) toolchain ;;
  kernel) kernel ;;
  pnpm) pnpm_tool ;;
  python) python_stack ;;
  browser) browser ;;
  verify-tools) verify_tools ;;
  curated-smoke) curated_smoke ;;
  office-smoke) office_smoke ;;
  sider-cache) sider_cache ;;
  socket-client) socket_client ;;
  preset-skills) preset_skills ;;
  preset-root) preset_root ;;
  profile-seed) profile_seed ;;
  smoke) smoke ;;
  serve) serve ;;
  session) session ;;
  *) echo "unknown phase: ${phase}" >&2; exit 64 ;;
esac
