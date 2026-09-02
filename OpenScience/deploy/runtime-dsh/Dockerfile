# The hosted agent runtime.
#
# It is the OpenCode runtime image with the kernel swapped: same Debian base,
# same uv, same R, same Chromium, same scientific stack, same curated-skill
# smoke — because none of that was about OpenCode. What changed is the agent
# kernel (DeepSeek Harness instead of OpenCode), the socket bundle that plugs
# into it, and a pre-initialized profile so the container starts without
# writing to its own installation at run time.
ARG RUNTIME_BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim
FROM ${RUNTIME_BASE_IMAGE}

ARG TARGETARCH
# Every version below is derived from OpenScience/deps-version.json. A test
# asserts they are equal, so a pin bump is one edit in one file.
ARG DSH_VERSION=0.1.2-alpha.3
ARG DSH_CORDIS_VERSION=4.0.2
# The instant the pin was published. `@deepseek-ai/dsh` declares all 61 of its
# subpackages as `^0.1.2-alpha.3`, so naming an exact version pins one package
# and floats the other 214: installing the pin on 2026-09-02 resolved 213 of
# them to 0.1.2-alpha.4, published the day before. npm's `--before` resolves
# every dependency to what existed at this instant, which is the only way to
# ask the registry for the tree this pin was tested against.
ARG DSH_PUBLISHED_BEFORE=2026-09-01T00:00:00.000Z
ARG SOCKET_VERSION=0.1.0
ARG NODE_VERSION=22.22.0
# Where to fetch the Node tarball. The default is upstream; a deployment behind
# a slow or broken route to nodejs.org passes its own mirror. Trust does not
# move with the URL: the sha256 pins below verify whatever host served it.
ARG NODE_DIST_BASE=https://nodejs.org/dist
ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.26
ARG NODE_SHA256_AMD64=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37
ARG NODE_SHA256_ARM64=
ARG UV_SHA256_AMD64=6426a73c3837e6e2483ee344cbc00f36394d179afcba6183cb77437e67db4af0
ARG UV_SHA256_ARM64=befa1a59c91e96eb601b0fd9a97c03dd666f17baba644b2b4db9c59a767e387e
ARG UV_LICENSE_MIT_SHA256=860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c
ARG GITHUB_DOWNLOAD_PREFIX=
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APP_VERSION=0.1.3
ARG RELEASE_ID=untracked
ARG SOURCE_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00.000Z
ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG PIP_INDEX_URL=https://pypi.org/simple

LABEL org.opencontainers.image.title="EviMed agent runtime"
LABEL org.opencontainers.image.description="Server-managed DeepSeek Harness runtime image for hosted EviMed workspaces."
LABEL org.opencontainers.image.source="https://github.com/ai4s-research/open-science"
LABEL org.opencontainers.image.version="${RELEASE_ID}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_CREATED}"
LABEL io.open-science.app.version="${APP_VERSION}"
LABEL io.open-science.dsh.version="${DSH_VERSION}"
# Kernel-neutral pair. The readiness gate used to read
# `io.open-science.opencode.version`, which a DSH image does not publish,
# so production readiness failed `runtime_image_metadata_missing` on every
# DSH deployment — the check could not survive the kernel it was gating.
LABEL io.open-science.runtime.kernel="dsh"
LABEL io.open-science.runtime.version="${DSH_VERSION}"
LABEL io.open-science.socket.version="${SOCKET_VERSION}"
LABEL io.open-science.uv.version="${UV_VERSION}"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
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
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Node and uv. Node is here because DSH is a Node program; the sandbox backend
# it will actually use inside a container is Landlock, which needs no package.
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) NODE_ARCH="x64"; NODE_SHA256="${NODE_SHA256_AMD64}"; UV_TRIPLE="x86_64-unknown-linux-gnu"; UV_SHA256="${UV_SHA256_AMD64}" ;; \
    arm64) NODE_ARCH="arm64"; NODE_SHA256="${NODE_SHA256_ARM64}"; UV_TRIPLE="aarch64-unknown-linux-gnu"; UV_SHA256="${UV_SHA256_ARM64}" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  tmp="$(mktemp -d)"; \
  curl_args=(--http1.1 --fail --show-error --location --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 600 --speed-limit 1024 --speed-time 60 --continue-at -); \
  curl "${curl_args[@]}" "${NODE_DIST_BASE}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o "${tmp}/node.tar.xz"; \
  if [ -n "${NODE_SHA256}" ]; then printf '%s  %s\n' "${NODE_SHA256}" "${tmp}/node.tar.xz" | sha256sum -c -; fi; \
  tar -xJf "${tmp}/node.tar.xz" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=README.md; \
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TRIPLE}.tar.gz" -o "${tmp}/uv.tar.gz"; \
  printf '%s  %s\n' "${UV_SHA256}" "${tmp}/uv.tar.gz" | sha256sum -c -; \
  tar -xzf "${tmp}/uv.tar.gz" -C "${tmp}"; \
  install -m 0755 "$(find "${tmp}" -type f -name uv | head -n 1)" /usr/local/bin/uv; \
  curl "${curl_args[@]}" "${GITHUB_DOWNLOAD_PREFIX}https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/LICENSE-MIT" -o "${tmp}/uv-LICENSE-MIT"; \
  printf '%s  %s\n' "${UV_LICENSE_MIT_SHA256}" "${tmp}/uv-LICENSE-MIT" | sha256sum -c -; \
  install -d -m 0755 /usr/share/licenses/uv; \
  install -m 0644 "${tmp}/uv-LICENSE-MIT" /usr/share/licenses/uv/LICENSE-MIT; \
  rm -rf "${tmp}"; \
  node --version; \
  uv --version

# The kernel, and its whole subpackage tree, at one version.
#
# Naming an exact version here is not enough and the comment that used to sit
# here said why without noticing it was describing this build: a range installs
# "a mixture of releases that no test has ever seen together". The ranges are
# inside `@deepseek-ai/dsh`'s own dependencies — 61 of them at
# `^0.1.2-alpha.3` — so `npm install @deepseek-ai/dsh@0.1.2-alpha.3` on
# 2026-09-02 produced a root at alpha.3 and 213 subpackages at alpha.4, while
# the version assertion below it passed. An image labelled with one kernel
# containing another, reporting success: the failure looked exactly like
# nothing having happened.
#
# So the resolution is fixed by `--before` and then *verified across the whole
# tree*, because a date filter is a request and the assertion is the guarantee.
# The scan fails when it finds implausibly few packages, so a broken readdir
# reports a broken scan rather than a clean tree.
RUN set -eux; \
  npm config set registry "${NPM_REGISTRY}"; \
  npm install -g --no-fund --no-audit --before="${DSH_PUBLISHED_BEFORE}" "@deepseek-ai/dsh@${DSH_VERSION}"; \
  dsh --version; \
  installed="$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version")"; \
  test "${installed}" = "${DSH_VERSION}" || { echo "installed dsh ${installed} != pinned ${DSH_VERSION}" >&2; exit 1; }; \
  node -e '\
    const fs = require("fs"), path = require("path"); \
    const [pin] = process.argv.slice(1); \
    const dir = "/usr/local/lib/node_modules/@deepseek-ai"; \
    const names = fs.readdirSync(dir).filter((n) => n.startsWith("dsh")); \
    if (names.length < 50) { console.error("only " + names.length + " @deepseek-ai/dsh* packages found; the scan, not the tree, is wrong"); process.exit(2); } \
    const drifted = names.map((n) => [n, JSON.parse(fs.readFileSync(path.join(dir, n, "package.json"), "utf8")).version]).filter(([, v]) => v !== pin); \
    if (drifted.length) { console.error(drifted.length + " of " + names.length + " @deepseek-ai/dsh* packages are not " + pin + "; the registry resolved newer subpackages, which usually means NPM_REGISTRY is a mirror that does not honour --before (its packuments carry no publish times). Point NPM_REGISTRY at a registry that does, or vendor the tree."); for (const [n, v] of drifted.slice(0, 8)) console.error("  " + n + " = " + v); process.exit(1); } \
    console.log("all " + names.length + " @deepseek-ai/dsh* packages are " + pin); \
  ' "${DSH_VERSION}"; \
  cordis="$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json').version" 2>/dev/null || node -p "require('@deepseek-ai/cordis/package.json').version")"; \
  test "${cordis}" = "${DSH_CORDIS_VERSION}" || { echo "resolved cordis ${cordis} != pinned ${DSH_CORDIS_VERSION}" >&2; exit 1; }

# `dsh plugin add` manages a profile's plugin set with pnpm, so the image has to
# carry it before a profile can be pre-initialised — without it the command
# prints "pnpm not found on PATH" and exits 127, which is what a build that had
# never been run could not have told anyone.
#
# It is installed as a real global package rather than through Corepack. A
# Corepack shim resolves its version at every invocation and reaches the
# registry to do it, so in the runtime container — which has no route off the
# host by design — `pnpm` fails with EAI_AGAIN instead of running. The web image
# may use Corepack because it only ever runs during a build with a network.
#
# The version tracks DSH's own packageManager, not the workspace's. This pnpm
# exists to manage a DSH profile, and `dsh plugin` writes a pnpm-workspace.yaml
# there listing the profile directory as its own package; pnpm 9 refuses to add
# a dependency into a workspace root without -w, so the workspace pin fails here
# with ERR_PNPM_ADDING_TO_ROOT. Two tools, two requirements — deps-version.json
# keeps this one next to the DSH pin that decides it.
RUN set -eux; \
  npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"; \
  pnpm config set registry "${NPM_REGISTRY}"; \
  installed="$(pnpm --version)"; \
  test "${installed}" = "${PNPM_VERSION}" || { echo "installed pnpm ${installed} != pinned ${PNPM_VERSION}" >&2; exit 1; }; \
  env -u COREPACK_NPM_REGISTRY npm_config_registry=http://127.0.0.1:1 pnpm --version > /dev/null

# The hosted notebook kernel and the agent runtime intentionally share one
# reviewed image. Keep the scientific stack pinned so a green image build is
# evidence that production has the same Python/R capabilities tested in CI.
ENV VIRTUAL_ENV=/opt/evimed/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"
RUN uv venv "${VIRTUAL_ENV}" --python /usr/bin/python3 \
  && uv pip install --python "${VIRTUAL_ENV}/bin/python" --index-url "${PIP_INDEX_URL}" --no-cache \
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
    statsmodels==0.14.6 \
  && python - <<'PY'
import importlib

for package in ("ipykernel", "jupyterlab", "matplotlib", "numpy", "openpyxl", "pandas", "PIL", "playwright", "pypdf", "sklearn", "scipy", "statsmodels"):
    importlib.import_module(package)
PY
RUN test -x /usr/bin/chromium && rg --version && python -m playwright --version
RUN Rscript -e 'stopifnot(getRversion() >= "4.0.0", abs(mean(c(1, 2, 3)) - 2) < 1e-12)'

COPY runtime/skills/curated-scientific /usr/local/share/evimed/skills/curated-scientific
COPY runtime/skills/office /usr/local/share/evimed/skills/office

# Smoke every shared curated-skill implementation in the production dependency image.
# The two dedicated matplotlib/statistical-power chains are exercised below.
RUN python3 - <<'PY'
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

RUN set -eux; \
  export MPLBACKEND=Agg; \
  tmp="$(mktemp -d)"; \
  python3 /usr/local/share/evimed/skills/curated-scientific/matplotlib/scripts/plot_template.py --plot-type line --output "${tmp}/figure.png"; \
  python3 /usr/local/share/evimed/skills/curated-scientific/matplotlib/scripts/plot_template.py --plot-type line --output "${tmp}/figure.svg"; \
  test -s "${tmp}/figure.png"; \
  test -s "${tmp}/figure.svg"; \
  python3 /usr/local/share/evimed/skills/curated-scientific/statistical-power/scripts/export_power_analysis.py --output-dir "${tmp}/power"; \
  test -s "${tmp}/power/power-analysis.md"; \
  test -s "${tmp}/power/power-curve.csv"; \
  test -s "${tmp}/power/power-curve.png"; \
  python3 /usr/local/share/evimed/skills/office/docx/scripts/create_docx.py --text "EviMed" --output "${tmp}/document.docx"; \
  python3 /usr/local/share/evimed/skills/office/pdf/scripts/create_pdf.py --text "EviMed" --output "${tmp}/document.pdf"; \
  python3 /usr/local/share/evimed/skills/office/pptx/scripts/create_pptx.py --title "EviMed" --body "Evidence" --output "${tmp}/presentation.pptx"; \
  printf 'name,value\ncontrol,1\n' > "${tmp}/input.csv"; \
  python3 /usr/local/share/evimed/skills/office/xlsx/scripts/create_xlsx.py --input "${tmp}/input.csv" --output "${tmp}/workbook.xlsx"; \
  python3 -c 'import pathlib,sys,zipfile; files=[pathlib.Path(sys.argv[1])/name for name in ("document.docx","presentation.pptx","workbook.xlsx")]; [zipfile.ZipFile(file).testzip() for file in files]' "${tmp}"; \
  rm -rf "${tmp}"

# The socket bundle, the capability manifests, the general skills and the MCP
# server. All four are read-only at run time: a capability a user could write
# into the workspace would be a capability a user could invent, and a SKILL.md
# a user could upload would be an instruction a user could inject.
#
# The socket bundle and the skill bodies are copied straight from where they
# live in the repository (`packages/socket`, `capability-skills`); only the
# capability manifests go through `deploy/runtime-dsh/capabilities`, because
# that directory is not source — it is `capabilities/*/capability.yaml`
# compiled to the JSON the runtime reads (`pnpm build:capabilities`), and it is
# committed for the same reason the curated-skill digest ledger is: so
# `check:capabilities` in CI can tell "someone edited a manifest and forgot to
# regenerate" from "nothing changed", rather than generating fresh and being
# unable to tell the difference.
COPY runtime/skills/core /opt/evimed/skills/core
COPY runtime/skills/community /opt/evimed/skills/community
# The agent packages under `runtime/skills/evimed` that are NOT delegated
# capabilities. The eleven specialists reach a run through
# `capability-skills`, which delegation injects; `open-domain-answer` is
# neither a capability nor a preset root, so its skill body reached no DSH
# container by any route -- and its agent.yaml requires `skillsLoaded`. Every
# open-domain answer, the default line for an unrouted question, came back
# stamped "unverified": a deployment fault shown to the reader as doubt about
# the answer. Copied one package at a time rather than the whole directory,
# because the specialists are already shipped as capability bodies and a
# second copy of the same instruction text is what this tree forbids.
COPY runtime/skills/evimed/open-domain-answer /opt/evimed/skills/evimed/open-domain-answer
COPY runtime/mcp/evimed-research /opt/evimed/mcp/evimed-research
COPY packages/socket /opt/evimed/socket
COPY deploy/runtime-dsh/capabilities /opt/evimed/capabilities
COPY capability-skills /opt/evimed/capability-skills

# The bundle's two runtime dependencies, placed where the packer will find
# them.
#
# `packages/socket/node_modules` is excluded by `.dockerignore`'s `**/node_modules`
# — the bare `node_modules` above it does not match at depth, which is how the
# workspace's own symlinks reached the image and quietly redirected this COPY.
#
# `packages/socket/package.json` declares them `workspace:*` and lists them in
# `bundledDependencies`. Neither fact installs anything on its own:
# `bundledDependencies` is a *packing* instruction — it tells the packer to
# include `node_modules/<name>` in the tarball — and `workspace:*` cannot
# resolve at all outside a workspace, which a standalone profile is not. With
# `packages/socket/node_modules` excluded by `.dockerignore`, both dependencies
# were simply absent from the image, and the failure surfaced only at the first
# `import` inside a running container: "Cannot find package '@evimed/domain'".
# The build was green throughout, because nothing it asserted ever imported the
# bundle.
#
# Copying them here makes the packing instruction true. `harness-port` depends
# on `domain` in turn and resolves it by walking up to this same directory.
COPY packages/domain /opt/evimed/socket/node_modules/@evimed/domain
COPY packages/harness-port /opt/evimed/socket/node_modules/@evimed/harness-port

# The preset ships inside the bundle as a *system*-trusted root, so a copy a
# user made into their own root cannot shadow it: the first root wins on a name
# collision, and system roots come first.
RUN set -eux; \
  install -d -m 0755 /opt/evimed/socket/presets/evimed-universal/skills; \
  cp -a /opt/evimed/skills/core /opt/evimed/socket/presets/evimed-universal/skills/core; \
  cp -a /opt/evimed/skills/evimed /opt/evimed/socket/presets/evimed-universal/skills/evimed; \
  cp -a /usr/local/share/evimed/skills/curated-scientific /opt/evimed/socket/presets/evimed-universal/skills/curated-scientific; \
  cp -a /usr/local/share/evimed/skills/office /opt/evimed/socket/presets/evimed-universal/skills/office; \
  cp -a /opt/evimed/skills/community /opt/evimed/socket/presets/evimed-universal/skills/community; \
  chmod -R a-w /opt/evimed/socket /opt/evimed/capabilities /opt/evimed/capability-skills /opt/evimed/mcp

# The preset also goes into the kernel's OWN preset root, because that is the
# only root the kernel reads.
#
# The bundle mounts an `agent-presets` row whose `roots` names the bundle's
# preset directory, and the control plane's patch names it again. Neither
# survives: `composeProfile` pushes a final overlay that REPLACES
# `agent-presets.config.roots` with the shipped root on every boot, keeping the
# rest of the row. So the row's `default: evimed-universal` was honoured while
# the directory it names was invisible, and every session creation failed with
# `preset "evimed-universal" not found (available: standard, code, minimal,
# cordis)` — the kernel listing its own four and none of ours.
#
# This is the same shape as the profile patch not reaching a preset's rows: a
# configuration target that DSH silently overrides. The answer is the same —
# put the thing where the kernel actually looks, rather than configuring a
# location it will discard.
# The two assertions below check the name on both sides: the control plane asks
# for this exact string, and a rename on either side would otherwise show up
# only as a failed session in production. (No comments inside the RUN: a
# backslash-continued line and a `#` comment do not mix, and the silent result
# is the rest of the command disappearing.)
ARG DSH_PRESET_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh/config/agent-presets
RUN set -eux; \
  test -d "${DSH_PRESET_ROOT}"; \
  cp -a /opt/evimed/socket/presets/evimed-universal "${DSH_PRESET_ROOT}/evimed-universal"; \
  chmod -R a-w "${DSH_PRESET_ROOT}/evimed-universal"; \
  grep -q "^name: evimed-universal$" "${DSH_PRESET_ROOT}/evimed-universal/preset.yml"; \
  test -f "${DSH_PRESET_ROOT}/evimed-universal/agent.cordis.yml"

# Pre-initialize the profile at build time so a container never has to install
# its own plugins over the network while serving — built at a path outside
# `/runtime` on purpose. `/runtime` is bind-mounted per project at container
# start, so a project's DSH session logs land on that project's own host
# volume instead of inside the image layer; a bind mount replaces everything
# under its target, which means a profile built at `/runtime/dsh-home` would
# be baked into the image and then be invisible to every container that ever
# actually starts. `open-science-dsh-serve.sh` copies this seed into the real,
# volume-backed `$DSH_HOME` once, the first time a project's runtime volume is
# empty — the container still never writes to its own *image*, only to the
# volume that was always its own to write to.
# Every bundle carries the same exact version as the harness. Most DSH
# sub-packages still publish a `latest` dist-tag pointing at 0.0.1-rc.1, so an
# unpinned `add` resolves the first release ever cut and then fails on a
# dependency that release named and later versions do not — which is what a
# build proves and a version range hides.
ENV DSH_HOME_SEED=/opt/evimed/dsh-home-seed

# The allowBuilds policy is a file rather than an inline heredoc: a heredoc
# cannot be spliced into a backslash-continued RUN, and keeping it beside the
# Dockerfile makes the decision reviewable on its own.
COPY deploy/runtime-dsh/profile-pnpm-workspace.yaml /opt/evimed/profile-pnpm-workspace.yaml

# The committed composition snapshot, brought in so the build can compare it to
# the one this image actually produces.
#
# `dshProfilePatch.test.mjs` checks that every row the profile patch names is a
# row the composition has, and it reads that snapshot from the repository — a
# file a human updates. Nothing compared it to the image, so the test could
# vouch for a composition that had drifted, which is the same shape as a patch
# naming a row the kernel does not have: the check passes and the effect never
# happens. The build now refuses when the two differ, and the diff says which
# rows moved.
COPY deploy/runtime-dsh/dump-config.baseline.json /opt/evimed/committed-dump-config.baseline.json

# The socket is added as `file:` rather than as a bare path, and the difference
# decides whether the image works at all. A bare path makes pnpm link the source
# directory, and the link it writes is relative to the profile — so the moment
# the boot script copies this seed onto a project volume, `../../../socket`
# resolves under /runtime and the profile cannot compose. `file:` copies the
# package into the profile's own store, which is what makes the seed relocatable.
#
# The seed then proves itself four ways: a loadable native binding shows the
# build permission took effect (node-pty ships prebuilds and never creates
# build/, so asserting that directory would fail on a working image); a
# non-empty --dump-config shows the composition resolves; composing again from
# a copy at a different path shows it will still resolve after the boot script
# relocates it, which is the one thing a test in place cannot show; and
# `build-smoke.sh` BOOTS the relocated copy, which is the only one of the four
# that imports a plugin. The first three all passed on an image whose bundle
# could not be imported at all — see that script's header.
RUN set -eux; \
  install -d -m 0755 "${DSH_HOME_SEED}/profiles/evimed-runtime"; \
  cp /opt/evimed/profile-pnpm-workspace.yaml "${DSH_HOME_SEED}/profiles/evimed-runtime/pnpm-workspace.yaml"; \
  DSH_HOME="${DSH_HOME_SEED}" dsh plugin --profile evimed-runtime add "@deepseek-ai/dsh-base@${DSH_VERSION}" "@deepseek-ai/dsh-web-app@${DSH_VERSION}" file:/opt/evimed/socket; \
  test -n "$(find "${DSH_HOME_SEED}/profiles/evimed-runtime/node_modules" -name "*.node" -path "*node-pty*" -print -quit)"; \
  DSH_HOME="${DSH_HOME_SEED}" dsh --profile evimed-runtime --dump-config > /opt/evimed/dump-config.baseline.json; \
  test -s /opt/evimed/dump-config.baseline.json; \
  diff -u /opt/evimed/committed-dump-config.baseline.json /opt/evimed/dump-config.baseline.json; \
  relocated="$(mktemp -d)"; \
  cp -a "${DSH_HOME_SEED}/." "${relocated}/"; \
  DSH_HOME="${relocated}" dsh --profile evimed-runtime --dump-config > /dev/null; \
  rm -rf "${relocated}"; \
  chmod -R a-w "${DSH_HOME_SEED}"

# Load the loader's native binding from the package it is installed in, rather
# than from a copy the addon makes under /tmp.
#
# `node-addon-require-builtin` is what lets Cordis's loader reach Node's own
# module loader, and the loader uses it to resolve every plugin's bare specifier
# against the profile directory. Without it the loader falls back to resolving
# bare names against its own directory — the global DSH install — where our
# bundle does not exist, and every one of our plugins reports "Cannot find
# package '@evimed/dsh-socket'" with nothing said about the addon at all.
#
# The addon's default is to copy its `.node` into a cache under `/tmp` and
# dlopen it there. Docker's `--tmpfs` mounts `noexec` by default, so in the
# runtime container that dlopen fails — and `noexec` on /tmp is a property worth
# keeping, since /tmp is one of the few writable paths a read-only container
# has. Disabling the cache keeps the binding on the executable root filesystem
# and makes the whole question moot.
ENV NARB_DISABLE_NATIVE_CACHE=1

# The boot proof. Separate RUN so its failure names itself in the build log, and
# after the seed is sealed read-only, because the boot script copies the seed
# exactly the way the runtime entrypoint does — including the copy's read-only
# bits, which is the failure that only appears once capabilities are dropped.
COPY deploy/runtime-dsh/build-smoke.sh /usr/local/bin/evimed-build-smoke
COPY deploy/runtime-dsh/build-smoke-patch.yml /usr/local/share/evimed/build-smoke-patch.yml
RUN set -eux; \
  chmod 0755 /usr/local/bin/evimed-build-smoke; \
  SOCKET_VERSION="${SOCKET_VERSION}" /usr/local/bin/evimed-build-smoke


ENV DSH_HOME=/runtime/dsh-home

ENV PYTHONUNBUFFERED=1
ENV XDG_CONFIG_HOME=/runtime/xdg-config
ENV XDG_DATA_HOME=/runtime/xdg-data
ENV XDG_CACHE_HOME=/runtime/xdg-cache
ENV XDG_STATE_HOME=/runtime/xdg-state
ENV HOME=/runtime/home
# DSH telemetry has no redaction rules and its FULL mode ships message bodies,
# tool arguments and workspace paths off the box. The patch disables the row as
# well; both, because either alone is one mistake away from being undone.
ENV DSH_TELEMETRY_DISABLED=1
ENV DSH_PERMISSION_MODE=workspace-write

COPY deploy/runtime-dsh/open-science-dsh-serve.sh /usr/local/bin/open-science-dsh-serve
RUN chmod 0755 /usr/local/bin/open-science-dsh-serve

WORKDIR /workspace
VOLUME ["/workspace", "/runtime"]

CMD ["dsh", "--version"]
