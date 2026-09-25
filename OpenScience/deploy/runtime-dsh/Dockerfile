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
ARG DSH_VERSION=0.1.5-rc.2
ARG DSH_CORDIS_VERSION=4.0.2
# Registry cutoff adopted by the rc.2 upgrade; CI verifies that every
# required subpackage is available and resolves to the exact same version.
# npm's cutoff bounds dependency resolution; the whole-tree version assertion
# below verifies the resulting kernel closure rather than trusting the date.
ARG DSH_PUBLISHED_BEFORE=2026-09-10T15:57:10.790Z
ARG SOCKET_VERSION=0.1.0
ARG NODE_VERSION=22.22.0
# Where to fetch the Node tarball. The default is upstream; a deployment behind
# a slow or broken route to nodejs.org passes its own mirror. Trust does not
# move with the URL: the sha256 pins below verify whatever host served it.
#
# Both architectures carry a pin, and an empty one now fails the build. It used
# to be skipped: the arm64 pin was blank and the verification sat behind
# `if [ -n "$NODE_SHA256" ]`, so an arm64 image fetched Node over the network
# and untarred it into /usr/local unverified -- and did so silently, because a
# skipped check and a passed one look identical in a build log.
ARG NODE_DIST_BASE=https://nodejs.org/dist
ARG PNPM_VERSION=11.7.0
ARG UV_VERSION=0.11.26
ARG NODE_SHA256_AMD64=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37
ARG NODE_SHA256_ARM64=1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f
ARG UV_SHA256_AMD64=6426a73c3837e6e2483ee344cbc00f36394d179afcba6183cb77437e67db4af0
ARG UV_SHA256_ARM64=befa1a59c91e96eb601b0fd9a97c03dd666f17baba644b2b4db9c59a767e387e
ARG UV_LICENSE_MIT_SHA256=860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c
ARG GITHUB_DOWNLOAD_PREFIX=
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APP_VERSION=0.1.3
ARG APT_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG PIP_INDEX_URL=https://pypi.org/simple

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

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Every install step is a phase of one script, which Dockerfile.agentbay runs
# too (in the same order — deploy.test.mjs holds the two lists equal), so the
# Docker and AgentBay runtimes install the same things the same way. Each phase
# is still its own RUN, and so its own cached layer, exactly as before.
COPY deploy/runtime-dsh/install-runtime.sh /usr/local/lib/evimed/install-runtime.sh
RUN bash /usr/local/lib/evimed/install-runtime.sh system

# Node and uv, each fetched and verified against the pins above.
RUN bash /usr/local/lib/evimed/install-runtime.sh toolchain

# The kernel, and its whole subpackage tree, at one version: resolved with
# `--before` and then verified package by package.
RUN bash /usr/local/lib/evimed/install-runtime.sh kernel

# The pnpm `dsh plugin` manages a profile with, as a real global package.
RUN bash /usr/local/lib/evimed/install-runtime.sh pnpm

# The scientific stack every run executes in, pinned so a green image build is
# evidence that production has the same Python/R capabilities tested in CI.
# ipykernel and jupyterlab serve the runs, not a notebook page: the curated
# skills have a run execute its analysis as a notebook and deliver the .ipynb.
# (The computational notebook page that also executed cells in this image was
# deleted on 2026-09-19.)
ENV VIRTUAL_ENV=/opt/evimed/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"
RUN bash /usr/local/lib/evimed/install-runtime.sh python
RUN bash /usr/local/lib/evimed/install-runtime.sh browser
RUN bash /usr/local/lib/evimed/install-runtime.sh verify-tools

COPY runtime/skills/curated-scientific /usr/local/share/evimed/skills/curated-scientific
COPY runtime/skills/office /usr/local/share/evimed/skills/office

# Smoke every shared curated-skill implementation in the production dependency image.
# The two dedicated matplotlib/statistical-power chains and the office
# generators are exercised in the phase after it.
RUN bash /usr/local/lib/evimed/install-runtime.sh curated-smoke
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
RUN bash /usr/local/lib/evimed/install-runtime.sh socket-client

# The preset ships inside the bundle as a *system*-trusted root, so a copy a
# user made into their own root cannot shadow it: the first root wins on a name
# collision, and system roots come first.
RUN bash /usr/local/lib/evimed/install-runtime.sh preset-skills

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
# The phase checks the name on both sides: the control plane asks for this
# exact string, and a rename on either side would otherwise show up only as a
# failed session in production.
#
# A root this image owns, named by the profile patch's `agent-presets.roots`.
#
# It used to be copied into the kernel's own preset directory, because at
# 0.1.2-alpha.3 `composeProfile` overwrote the row's `roots` on every boot and
# a configured root was silently discarded. That directory no longer exists at
# alpha.5 — the presets moved inside `@deepseek-ai/dsh-agent-presets` — and the
# behaviour it forced is gone with it: the shipped root is now *prepended*
# before configured roots rather than replacing them, so naming our own root
# works and is documented. Which returns this image to the rule it should never
# have bent: a container does not write into its own installation.
ARG DSH_PRESET_ROOT=/opt/evimed/dsh/presets
RUN bash /usr/local/lib/evimed/install-runtime.sh preset-root

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
ARG DSH_CITE_BUNDLE="dsh-cite@0.3.2"
ARG DSH_ANNOTATION_BUNDLE="@changfenhuang/dsh-annotation@1.4.10"
ARG DSH_MERMAID_BUNDLE="dsh-mermaid@0.4.0"
ARG DSH_COMMUNITY_PEER_PINS="cordis@4.0.0-rc.10"
RUN bash /usr/local/lib/evimed/install-runtime.sh profile-seed

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
COPY deploy/runtime-dsh/build-smoke.sh /usr/local/bin/evimed-build-smoke
COPY deploy/runtime-dsh/build-smoke-patch.yml /usr/local/share/evimed/build-smoke-patch.yml
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
RUN bash /usr/local/lib/evimed/install-runtime.sh serve

WORKDIR /workspace
VOLUME ["/workspace", "/runtime"]

CMD ["dsh", "--version"]

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
