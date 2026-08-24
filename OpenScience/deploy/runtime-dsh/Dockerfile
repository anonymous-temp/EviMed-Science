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
ARG DSH_VERSION=0.1.1-rc.2
ARG DSH_CORDIS_VERSION=4.0.1
ARG SOCKET_VERSION=0.1.0
ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.26
ARG NODE_SHA256_AMD64=
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
  curl "${curl_args[@]}" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o "${tmp}/node.tar.xz"; \
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

# The kernel, installed at an exact version. Subpackage `latest` dist-tags still
# point at 0.0.1-rc.1 for most of the tree, so a range here would install a
# mixture of releases that no test has ever seen together.
RUN set -eux; \
  npm config set registry "${NPM_REGISTRY}"; \
  npm install -g --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}"; \
  dsh --version; \
  installed="$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version")"; \
  test "${installed}" = "${DSH_VERSION}" || { echo "installed dsh ${installed} != pinned ${DSH_VERSION}" >&2; exit 1; }; \
  cordis="$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json').version" 2>/dev/null || node -p "require('@deepseek-ai/cordis/package.json').version")"; \
  test "${cordis}" = "${DSH_CORDIS_VERSION}" || { echo "resolved cordis ${cordis} != pinned ${DSH_CORDIS_VERSION}" >&2; exit 1; }

# `dsh plugin add` manages a profile's plugin set with pnpm, so the image has to
# carry it before a profile can be pre-initialised — without it the command
# prints "pnpm not found on PATH" and exits 127, which is what a build that had
# never been run could not have told anyone.
#
# Corepack fetches the pinned release, and COREPACK_NPM_REGISTRY has to be set
# before that fetch: the same ordering defect once failed a production build
# here by falling back to npmjs.org from a China-hosted host (PROGRESS
# 2026-07-23).
#
# The version tracks DSH's own packageManager, not the workspace's. This pnpm
# exists to manage a DSH profile, and `dsh plugin` writes a pnpm-workspace.yaml
# there listing the profile directory as its own package; pnpm 9 refuses to add
# a dependency into a workspace root without -w, so the workspace pin fails here
# with ERR_PNPM_ADDING_TO_ROOT. Two tools, two requirements — deps-version.json
# keeps this one next to the DSH pin that decides it.
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
RUN set -eux; \
  corepack enable; \
  corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
  pnpm config set registry "${NPM_REGISTRY}"; \
  installed="$(pnpm --version)"; \
  test "${installed}" = "${PNPM_VERSION}" || { echo "installed pnpm ${installed} != pinned ${PNPM_VERSION}" >&2; exit 1; }

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
COPY runtime/mcp/evimed-research /opt/evimed/mcp/evimed-research
COPY packages/socket /opt/evimed/socket
COPY deploy/runtime-dsh/capabilities /opt/evimed/capabilities
COPY capability-skills /opt/evimed/capability-skills

# `packages/socket/node_modules` is excluded by `.dockerignore`'s bare
# `node_modules` pattern (it matches at any depth), so the two dev-only
# entries actually installed there today (eslint, typescript) never reach the
# image. The bundle's real runtime dependencies (`@evimed/domain`,
# `@evimed/harness-port`) are bundled by `dsh plugin add` below, which resolves
# them from `packages/socket/package.json`'s own `bundledDependencies`.

# The preset ships inside the bundle as a *system*-trusted root, so a copy a
# user made into their own root cannot shadow it: the first root wins on a name
# collision, and system roots come first.
RUN set -eux; \
  install -d -m 0755 /opt/evimed/socket/presets/evimed-universal/skills; \
  cp -a /opt/evimed/skills/core /opt/evimed/socket/presets/evimed-universal/skills/core; \
  cp -a /usr/local/share/evimed/skills/curated-scientific /opt/evimed/socket/presets/evimed-universal/skills/curated-scientific; \
  cp -a /usr/local/share/evimed/skills/office /opt/evimed/socket/presets/evimed-universal/skills/office; \
  chmod -R a-w /opt/evimed/socket /opt/evimed/capabilities /opt/evimed/capability-skills /opt/evimed/mcp

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
RUN set -eux; \
  install -d -m 0755 "${DSH_HOME_SEED}/profiles/evimed-runtime"; \
  cat > "${DSH_HOME_SEED}/profiles/evimed-runtime/pnpm-workspace.yaml" <<'YAML'; \
packages:
  - .

# pnpm 10+ refuses to run a dependency's install script until it is reviewed
# here, and an unlisted script is a hard install error. The policy is DSH's own,
# because DSH is the one that knows which of its dependencies need to build:
# deny by default, allow only what the runtime cannot work without.
allowBuilds:
  # The persistent shell is a PTY. Without this build the bash tool has no
  # backend, and the failure would surface as a broken tool at run time rather
  # than as a failed image build.
  node-pty: true
  # Write-through publication for the session log.
  koffi: true
  # Restores the executable bit on the spawn helper.
  '@deepseek-ai/dsh-subprocess-local': true
  # Lifecycle scripts that are no-ops for this deployment. Denied rather than
  # unlisted, so the install still succeeds and the decision stays visible.
  '@google/genai': false
  protobufjs: false
YAML
  DSH_HOME="${DSH_HOME_SEED}" dsh plugin --profile evimed-runtime add "@deepseek-ai/dsh-base@${DSH_VERSION}" "@deepseek-ai/dsh-web-app@${DSH_VERSION}" /opt/evimed/socket; \
  test -d "${DSH_HOME_SEED}/profiles/evimed-runtime/node_modules/node-pty/build"; \
  DSH_HOME="${DSH_HOME_SEED}" dsh --profile evimed-runtime --dump-config > /opt/evimed/dump-config.baseline.json; \
  test -s /opt/evimed/dump-config.baseline.json; \
  chmod -R a-w "${DSH_HOME_SEED}"

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
