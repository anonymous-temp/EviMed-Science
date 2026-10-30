# The hosted agent runtime.
#
# It is the OpenCode runtime image with the kernel swapped: same Debian base,
# same uv, same R, same Chromium, same scientific stack, same curated-skill
# smoke — because none of that was about OpenCode. What changed is the agent
# kernel (DeepSeek Harness instead of OpenCode), the socket bundle that plugs
# into it, and a pre-initialized profile so the container starts without
# writing to its own installation at run time.
#
# Layer order is release cost. CI builds with a layer cache (the gha cache in
# .github/ci/docker-compose.build-cache.yml), and a layer is reused only while
# everything before it is unchanged — the files copied in, and every build ARG
# declared above it, because BuildKit hands each declared ARG to every later RUN
# as its environment. A reused layer keeps its diff ID, and the serving host
# already holds it; a rebuilt one is new bytes a release must load. So the
# stable, heavy phases come first (system packages, Pandoc, Node and uv, the
# Python stack, the browser, the methods libraries), each ARG is declared just
# above the phase that reads it, each phase copies only its own cut of the
# install script, and what changes often comes last: the kernel pin, the skill
# trees, the socket, the profile seed, and the release identity at the very end.
ARG RUNTIME_BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim

# One script per install phase, cut from install-runtime.sh (see
# split-install-phases.awk). This stage runs again whenever the script changes,
# in a second; each `COPY --from=install-phases` below is cached by the bytes of
# its own cut, so an edit to one phase rebuilds that phase and what follows it,
# never the phases before it.
FROM ${RUNTIME_BASE_IMAGE} AS install-phases
COPY deploy/runtime-dsh/install-runtime.sh deploy/runtime-dsh/split-install-phases.awk /usr/local/src/evimed/
RUN mkdir /phases && awk -v out=/phases -f /usr/local/src/evimed/split-install-phases.awk /usr/local/src/evimed/install-runtime.sh

FROM ${RUNTIME_BASE_IMAGE}

ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Every install step is a phase of one script, which Dockerfile.agentbay runs
# too (in the same order — deploy.test.mjs holds the two lists equal), so the
# Docker and AgentBay runtimes install the same things the same way. Each phase
# is its own RUN, and so its own cached layer, and is preceded by the copy of
# its own cut of the script.
#
# Every version below is derived from OpenScience/deps-version.json. A test
# asserts they are equal, so a pin bump is one edit in one file.
#
# The refresh key. The layers above the kernel are reused from the cache for as
# long as nothing they are built from changes, and nothing they are built from
# names a date: `apt-get install` takes the archive as it is on the day it runs.
# Full releases used to build with --no-cache for that reason; CI passes the
# month (YYYY-MM) here, so every image is rebuilt from upstream at least once a
# month, security updates included, and a new base image (the tag above
# resolves to its current digest on every build) rebuilds everything at once.
# A build that passes nothing keeps the default and reuses what it has.
ARG BASE_REFRESH=unset
ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
COPY --from=install-phases /phases/system.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh system

ARG GITHUB_DOWNLOAD_PREFIX=
ARG PANDOC_VERSION=2.17.1.1
ARG PANDOC_SHA256_AMD64=2efe7a91a77be4248f8a2e38fb4e89f9b4d44b1d5be8200349c49d23d9f9bf4e
ARG PANDOC_SHA256_ARM64=c3e589625476c130862e2ae4dc3309e8ef752d9258da1f4fa734904f4342459e
COPY --from=install-phases /phases/renderer.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh renderer

# Node and uv, each fetched and verified against the pins below.
#
# Where to fetch the Node tarball. The default is upstream; a deployment behind
# a slow or broken route to nodejs.org passes its own mirror. Trust does not
# move with the URL: the sha256 pins below verify whatever host served it.
#
# Both architectures carry a pin, and an empty one now fails the build. It used
# to be skipped: the arm64 pin was blank and the verification sat behind
# `if [ -n "$NODE_SHA256" ]`, so an arm64 image fetched Node over the network
# and untarred it into /usr/local unverified -- and did so silently, because a
# skipped check and a passed one look identical in a build log.
ARG NODE_VERSION=22.22.3
ARG NODE_DIST_BASE=https://nodejs.org/dist
ARG NODE_SHA256_AMD64=2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f
ARG NODE_SHA256_ARM64=1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7
ARG UV_VERSION=0.11.26
ARG UV_SHA256_AMD64=6426a73c3837e6e2483ee344cbc00f36394d179afcba6183cb77437e67db4af0
ARG UV_SHA256_ARM64=befa1a59c91e96eb601b0fd9a97c03dd666f17baba644b2b4db9c59a767e387e
ARG UV_LICENSE_MIT_SHA256=860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c
COPY --from=install-phases /phases/toolchain.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh toolchain

# The scientific stack every run executes in, pinned so a green image build is
# evidence that production has the same Python/R capabilities tested in CI.
# ipykernel and jupyterlab serve the runs, not a notebook page: the curated
# skills have a run execute its analysis as a notebook and deliver the .ipynb.
# (The computational notebook page that also executed cells in this image was
# deleted on 2026-09-19.)
ENV VIRTUAL_ENV=/opt/evimed/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY deploy/runtime-dsh/verify-legacy-spreadsheet.py /usr/local/lib/evimed/verify-legacy-spreadsheet.py
COPY deploy/runtime-dsh/fixtures/legacy-spreadsheet.xls /usr/local/lib/evimed/fixtures/legacy-spreadsheet.xls
COPY --from=install-phases /phases/python.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh python
COPY --from=install-phases /phases/browser.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh browser

# The libraries the curated skills' full methods import (RDKit, Biopython,
# gseapy, Scanpy, AnnData, lifelines), installed on top of the stack above
# without moving any of its pins. It sits before the skill trees are copied so
# a SKILL.md edit does not reinstall them, and before the kernel so a kernel pin
# bump does not either; the smoke below runs in the environment the skills ship in.
COPY --from=install-phases /phases/python-methods.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh python-methods

# The kernel, and its whole subpackage tree, at one version: resolved with
# `--before` and then verified package by package. It is the first phase a
# kernel pin bump reaches; everything above is reused.
#
# Registry cutoff of the pinned closure: the latest publish instant of its
# `@deepseek-ai/dsh*` packages plus a minute, computed by
# `node scripts/ops/kernel-install.mjs cutoff` and written once in
# deps-version.json. CI verifies that every required subpackage is available and
# resolves to the exact same version. npm's cutoff bounds dependency resolution;
# the whole-tree version assertion below verifies the resulting kernel closure
# rather than trusting the date.
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG DSH_VERSION=0.2.1-rc.2
ARG DSH_CORDIS_VERSION=4.0.5
ARG DSH_PUBLISHED_BEFORE=2026-10-17T08:52:11.767Z
COPY --from=install-phases /phases/kernel.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh kernel

# The pnpm `dsh plugin` manages a profile with, as a real global package.
ARG PNPM_VERSION=11.7.0
COPY --from=install-phases /phases/pnpm.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh pnpm

# The tools a run is promised, each proven to run — after the kernel, because
# the LibreOffice Kit the Office skills render through ships in its closure.
COPY --from=install-phases /phases/verify-tools.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh verify-tools

COPY runtime/skills/curated-scientific /usr/local/share/evimed/skills/curated-scientific
COPY runtime/skills/office /usr/local/share/evimed/skills/office

# Smoke every shared curated-skill implementation in the production dependency image.
# The two dedicated matplotlib/statistical-power chains and the office
# generators are exercised in the phase after it.
COPY --from=install-phases /phases/curated-smoke.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh curated-smoke
COPY --from=install-phases /phases/office-smoke.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh office-smoke

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
# The owner's GEO method pack, a private skill root: gitignored except its
# README, unpacked on the build machine by scripts/build/vendor-geo-skills.mjs
# and carried to the release host in the delta archive. The directory always
# exists (the README is tracked), so a clone without the pack builds an image
# whose GEO capabilities say the pack is missing.
COPY runtime/skills/geo-private /opt/evimed/skills/geo-private
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
# Generated assets are absent from a clean Git context. Verify pinned upstream
# bytes and execute offline queries before sealing the runtime filesystem.
COPY --from=install-phases /phases/sider-cache.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh sider-cache
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
COPY scripts/runtime/validate-personal-skill.mjs /opt/evimed/socket/scripts/validate-personal-skill.mjs
# `design-tokens` joined them on 2026-09-26: the frame bundle draws the study-
# type badges and hands the kernel its theme, and both come from that table now
# that it is its own package. It is the same shape as `domain` — source only,
# no dependencies, browser-safe — so it is copied the same way, and the failure
# it caused was identical in kind: the delta's `build-client.mjs` stopped with
# ERR_MODULE_NOT_FOUND while every test upstream was green.
COPY packages/design-tokens /opt/evimed/socket/node_modules/@evimed/design-tokens
COPY --from=install-phases /phases/socket-client.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh socket-client

# The preset ships inside the bundle as a *system*-trusted root, so a copy a
# user made into their own root cannot shadow it: the first root wins on a name
# collision, and system roots come first.
COPY --from=install-phases /phases/preset-skills.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh preset-skills

# The preset the control plane asks for, where the kernel reads it: since DSH
# 0.1.7 a preset is a row of the composition — the socket's own bundle patch
# `presets/evimed-universal.patch.yml` — and there is no preset directory or
# root to install. Until 0.1.5 this step copied the preset into a root the
# profile patch named; that root is gone with `dsh-agent-presets`. The phase
# checks the name on both sides, because the control plane asks for this exact
# string and a rename on either side would otherwise show up only as a failed
# session in production.
COPY --from=install-phases /phases/preset-row.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh preset-row

# Pre-initialize the profile at build time so a container never has to install
# its own plugins over the network while serving — built at a path outside
# `/runtime` on purpose. `/runtime` is bind-mounted per project at container
# start, so a project's DSH session logs land on that project's own host
# volume instead of inside the image layer; a bind mount replaces everything
# under its target, which means a profile built at `/runtime/dsh-home` would
# be baked into the image and then be invisible to every container that ever
# actually starts. The boot helper projects managed package roots from this
# immutable seed into each volume-backed profile and reconciles them by digest
# on an image change, without replacing user profile or session state.
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
COPY deploy/runtime-dsh/profile-seed.mjs /usr/local/bin/evimed-profile-seed.mjs
COPY deploy/runtime-dsh/profile-kernel-pins.mjs /usr/local/bin/evimed-profile-kernel-pins.mjs
# Late security backport preserves every preceding tool/kernel cache layer.
COPY deps-version.json /opt/evimed/runtime-deps-version.json
COPY deploy/runtime-dsh/runtime-yaml-security.mjs /usr/local/bin/runtime-yaml-security.mjs
COPY deploy/runtime-dsh/profile-seed.mjs /usr/local/bin/profile-seed.mjs
RUN node /usr/local/bin/runtime-yaml-security.mjs global

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

# The profile seed: the harness bundles at the kernel pin, the community bundles
# at the versions runtime/skills/community/plugin-support.json records they
# booted at (dsh-cite; the selection-annotation and Mermaid client bundles),
# and the socket as `file:` so the seed stays relocatable. Each community
# bundle's own peer outside the kernel closure is pinned too. A test holds
# these values, that record and deps-version.json equal. The phase then proves
# the seed four ways — a loadable native binding, a --dump-config equal to the
# committed baseline, a relocated copy that still composes, and (the `smoke`
# phase below) a boot.
ARG DSH_CITE_BUNDLE="dsh-cite@0.3.5"
ARG DSH_ANNOTATION_BUNDLE="@changfenhuang/dsh-annotation@1.4.11"
ARG DSH_MERMAID_BUNDLE="dsh-mermaid@0.4.2"
ARG DSH_COMMUNITY_PEER_PINS="cordis@4.0.0-rc.10"
COPY deploy/runtime-dsh/install-loopx.mjs /usr/local/lib/evimed/install-loopx.mjs
COPY packages/contracts/loopx/workflow-skills.json /usr/local/lib/evimed/loopx-workflow-skills.json
COPY deploy/runtime-dsh/loopx-compat.mjs /usr/local/lib/evimed/loopx-compat.mjs
COPY deploy/runtime-dsh/annotation-compat.mjs /usr/local/lib/evimed/annotation-compat.mjs
ENV LOOPX_USAGE_PING=0 DO_NOT_TRACK=1 LOOPX_BIN=/opt/evimed/venv/bin/loopx
COPY --from=install-phases /phases/loopx.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh loopx
COPY deploy/runtime-dsh/install-openviking-plugin.mjs /usr/local/lib/evimed/install-openviking-plugin.mjs
COPY --from=install-phases /phases/openviking-plugin.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh openviking-plugin
COPY --from=install-phases /phases/profile-seed.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh profile-seed
RUN node /usr/local/bin/runtime-yaml-security.mjs verify

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
# after the seed is sealed read-only: the smoke uses the same managed-package
# migration as startup and proves the native loader can import that immutable
# closure while profile/session state stays on its writable runtime volume.
ARG SOCKET_VERSION=0.1.0
COPY deploy/runtime-dsh/build-smoke.sh /usr/local/bin/evimed-build-smoke
COPY deploy/runtime-dsh/build-smoke-patch.yml /usr/local/share/evimed/build-smoke-patch.yml
COPY --from=install-phases /phases/smoke.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh smoke


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
COPY --from=install-phases /phases/serve.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh serve

# The whole install script, as the image has always carried it; the cuts above
# replaced one another at this path, one phase at a time.
COPY deploy/runtime-dsh/install-runtime.sh /usr/local/lib/evimed/install-runtime.sh

WORKDIR /workspace
VOLUME ["/workspace", "/runtime"]

CMD ["dsh", "--version"]

# The image's metadata. A LABEL is configuration, not a layer, and it reads the
# version ARGs declared above at their phases; it sits here so that no ARG has
# to be declared ahead of the layers it would otherwise invalidate.
ARG APP_VERSION=0.1.3
LABEL org.opencontainers.image.title="EviMed agent runtime"
LABEL org.opencontainers.image.description="Server-managed DeepSeek Harness runtime image for hosted EviMed workspaces."
LABEL org.opencontainers.image.source="https://github.com/ai4s-research/open-science"
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

# Release identity, last on purpose.
#
# These three change on every release and nothing else in the image depends on
# them. Declared up with the other ARGs, they invalidated the build cache from
# the first LABEL that read one — which sat above the apt install, the R
# packages, Chromium, the npm closure and the profile build. A release that
# changed one line of server code therefore paid for a forty-minute rebuild of
# the whole runtime, every time, and the tax fell hardest on the releases that
# should be cheapest to ship.
ARG RELEASE_ID=untracked
ARG SOURCE_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00.000Z
LABEL org.opencontainers.image.version="${RELEASE_ID}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_CREATED}"
