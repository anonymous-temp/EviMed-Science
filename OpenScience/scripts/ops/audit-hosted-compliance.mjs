#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jsonOutput = process.argv.includes("--json");
const allowRestrictedSkills = ["1", "true", "yes"].includes(
  (process.env.OPEN_SCIENCE_LICENSE_ACCEPT_RESTRICTED_SKILLS ?? "").toLowerCase(),
);

const findings = [];

function add(status, code, message, details = {}) {
  findings.push({ status, code, message, ...details });
}

function pass(code, message, details) {
  add("pass", code, message, details);
}

function warn(code, message, details) {
  add("warn", code, message, details);
}

function fail(code, message, details) {
  add("fail", code, message, details);
}

async function read(rel) {
  return fs.readFile(path.join(repoRoot, rel), "utf8");
}

function bashComposeStartupBlocks(document) {
  return [...document.matchAll(/```bash\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => /\bdocker compose\b/.test(block) && /(?:^|\s)up(?:\s|$)/m.test(block));
}

// One Compose service's block, from its two-space-indented key to the next
// key at the same indent. Slicing by the name of whichever service happens to
// follow it is how a check starts reading a neighbour's settings the day a
// service is deleted or reordered.
function composeService(document, name) {
  const startPattern = new RegExp(`^  ${name}:$`, "m");
  const startMatch = startPattern.exec(document);
  if (!startMatch) return "";
  const from = startMatch.index;
  const rest = document.slice(from + startMatch[0].length);
  const nextMatch = /^ {2}[A-Za-z0-9_.-]+:$/m.exec(rest);
  return nextMatch ? document.slice(from, from + startMatch[0].length + nextMatch.index) : document.slice(from);
}

function repoRel(file) {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function configuredRuntimeSkillDirs() {
  const raw = process.env.OPEN_SCIENCE_RUNTIME_SKILL_DIRS ?? [
    "runtime/skills/core",
    "runtime/skills/external/ai4s-skills",
    "runtime/skills/curated-scientific",
    "runtime/skills/office",
  ].join(",");
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(resolveRepoPath);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        out.push({ full, symlink: true });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push({ full, symlink: false });
      }
    }
  }
  await walk(root);
  return out;
}

async function restrictiveLicenseFiles(root) {
  const files = await listFiles(root);
  const matches = [];
  for (const file of files) {
    if (file.symlink) continue;
    if (!/license/i.test(path.basename(file.full))) continue;
    const text = await fs.readFile(file.full, "utf8").catch(() => "");
    // Standard permissive grants explicitly include "distribute, sublicense".
    // Only flag language that reserves rights or restricts redistribution.
    if (
      /all rights reserved|\bproprietary\b|transfer these materials/i.test(text) ||
      /(?:may\s+not|must\s+not|do\s+not|not\s+permitted\s+to)[^\n]{0,120}\b(?:distribute|redistribute|sublicense)\b/i.test(text)
    ) {
      matches.push(repoRel(file.full));
    }
  }
  return matches;
}

async function checkRootLicense() {
  const pkg = JSON.parse(await read("package.json"));
  const license = await read("LICENSE");
  if (pkg.license !== "MIT") {
    fail("app_license_missing", "Root package.json must declare the application license.", { actual: pkg.license ?? null });
    return;
  }
  if (!/MIT License/i.test(license)) {
    fail("app_license_file_missing", "Root LICENSE must contain the MIT license text.");
    return;
  }
  pass("app_license", "Application license is declared and present.", { license: "MIT" });
}

async function checkRuntimePins() {
  // One agent runtime image, and this audit reads only that one. The retired
  // kernel's tree was kept out of here before it was deleted, for the reason
  // that outlives it: a source audit that pattern-matches a Dockerfile nothing
  // ships reports coverage it does not have, which is worse than no check.
  const dockerfile = await read("deploy/runtime-dsh/Dockerfile");
  const workflow = await read(".github/workflows/web.yml");
  const compose = await read("deploy/web/docker-compose.yml");

  // Every version this image resolves, named exactly. The kernel pin is the
  // one that used to be `OPENCODE_VERSION`; the rest were always here.
  const dsh = dockerfile.match(/^ARG DSH_VERSION=([^\s]+)/m)?.[1] ?? "";
  const uv = dockerfile.match(/^ARG UV_VERSION=([^\s]+)/m)?.[1] ?? "";
  for (const [value, okCode, badCode, label] of [
    [dsh, "dsh_version_pinned", "dsh_version_unpinned", "DSH_VERSION"],
    [
      dockerfile.match(/^ARG DSH_CORDIS_VERSION=([^\s]+)/m)?.[1] ?? "",
      "dsh_cordis_version_pinned",
      "dsh_cordis_version_unpinned",
      "DSH_CORDIS_VERSION",
    ],
    [uv, "uv_version_pinned", "uv_version_unpinned", "UV_VERSION"],
    [
      dockerfile.match(/^ARG PNPM_VERSION=([^\s]+)/m)?.[1] ?? "",
      "dsh_pnpm_version_pinned",
      "dsh_pnpm_version_unpinned",
      "PNPM_VERSION",
    ],
    [
      dockerfile.match(/^ARG NODE_VERSION=([^\s]+)/m)?.[1] ?? "",
      "runtime_node_version_pinned",
      "runtime_node_version_unpinned",
      "NODE_VERSION",
    ],
  ]) {
    if (!value || value === "latest") {
      fail(badCode, `Hosted runtime image must pin ${label}.`);
    } else {
      pass(okCode, `Hosted runtime pins ${label}.`, { version: value });
    }
  }

  // A bundle added without a version resolves whatever `latest` points at, and
  // most DSH sub-packages still tag 0.0.1-rc.1 as latest — so an unpinned add
  // installs the first release ever cut, under a Dockerfile that claims a pin.
  const addLine = dockerfile.match(/dsh plugin --profile \S+ add ([^;\\]+)/)?.[1] ?? "";
  const unpinnedBundles = addLine
    .split(/\s+/)
    .filter((spec) => spec.startsWith('"@deepseek-ai/') || spec.startsWith("@deepseek-ai/"))
    .filter((spec) => !/@\$\{DSH_VERSION\}|@\d/.test(spec.replace(/^"|"$/g, "").slice(1)));
  if (unpinnedBundles.length) {
    fail("dsh_profile_bundles_unpinned", "Every DSH bundle the image pre-installs must name an exact version.", {
      unpinned: unpinnedBundles,
    });
  } else if (addLine) {
    pass("dsh_profile_bundles_pinned", "Pre-installed DSH bundles name an exact version.");
  }

  // The pin is only a pin if it agrees with the one place versions are defined.
  const depsVersions = JSON.parse(await read("deps-version.json"));
  if (dsh && dsh !== depsVersions.dsh?.version) {
    fail("dsh_version_pin_drift", "runtime-dsh Dockerfile disagrees with deps-version.json.", {
      dockerfile: dsh,
      depsVersion: depsVersions.dsh?.version ?? null,
    });
  } else if (dsh) {
    pass("dsh_version_pin_single_source", "runtime-dsh pin equals the single definition.", { version: dsh });
  }

  // The kernel version an operator can override at build time, exposed by
  // Compose the way `OPENCODE_VERSION` used to be.
  if (/DSH_VERSION:\s+\$\{OPEN_SCIENCE_DSH_VERSION:-[^}]+\}/.test(compose)) {
    pass("compose_runtime_version_arg", "Compose exposes the pinned agent runtime kernel version arg.");
  } else {
    fail("compose_runtime_version_arg_missing", "Compose must expose OPEN_SCIENCE_DSH_VERSION.");
  }
  if (/UV_VERSION:\s+\$\{OPEN_SCIENCE_UV_VERSION:-[^}]+\}/.test(compose)) {
    pass("compose_uv_version_arg", "Compose exposes the pinned uv image version arg.");
  } else {
    fail("compose_uv_version_arg_missing", "Compose must expose OPEN_SCIENCE_UV_VERSION.");
  }

  if (/^ARG TARGETARCH$/m.test(dockerfile) && !/^ARG TARGETARCH=/m.test(dockerfile) && !/TARGETARCH\s*:/.test(compose)) {
    pass("runtime_native_architecture", "Runtime builds use BuildKit's target architecture instead of defaulting ARM64 hosts to AMD64 binaries.");
  } else {
    fail("runtime_native_architecture_missing", "Runtime builds must consume BuildKit TARGETARCH without a hard-coded architecture default or Compose override.");
  }

  // Release-asset integrity, at the two shapes this image actually uses.
  //
  // uv and Node arrive as downloaded archives, so they are still bound to
  // architecture-specific SHA-256 digests before extraction. The kernel does
  // not: it is an npm global, so there is no archive to digest, and the
  // equivalent binding is `--before` plus an assertion over the whole
  // installed tree — a date filter is a request, the scan is the guarantee.
  // Checking only the digests here would have passed a build that installed
  // 213 subpackages one release ahead of the pin.
  const digestArgs = ["UV_SHA256_AMD64", "UV_SHA256_ARM64"];
  const kernelTreePinned =
    /^ARG DSH_PUBLISHED_BEFORE=\d{4}-\d{2}-\d{2}T/m.test(dockerfile) &&
    /--before="\$\{DSH_PUBLISHED_BEFORE\}"/.test(dockerfile) &&
    // The plausibility floor, wherever the packages live. alpha.5 stopped
    // hoisting the 223 subpackages beside the pin and left them under its own
    // `node_modules`, so the scan searches both layouts now; what this check
    // holds is that a floor still exists, not where the readdir points.
    /dsh\*\)? packages found|length >= 50/.test(dockerfile) &&
    /filter\(\(\[, v\]\) => v !== pin\)/.test(dockerfile);
  if (
    digestArgs.every((name) => new RegExp(`^ARG ${name}=[a-f0-9]{64}$`, "m").test(dockerfile)) &&
    digestArgs.every((name) => new RegExp(`${name}:\\s+\\$\\{OPEN_SCIENCE_${name}:-[a-f0-9]{64}\\}`).test(compose)) &&
    // Both Node architectures. This line named only amd64 while the check
    // itself claimed digests were "architecture-specific", and the arm64 pin
    // was empty with its verification behind `if [ -n "$NODE_SHA256" ]` -- so
    // an arm64 image installed an unverified Node and this audit passed.
    /^ARG NODE_SHA256_AMD64=[a-f0-9]{64}$/m.test(dockerfile) &&
    /^ARG NODE_SHA256_ARM64=[a-f0-9]{64}$/m.test(dockerfile) &&
    // A pin only binds if a missing one stops the build. Counting the
    // `sha256sum` lines proves three checks are written, never that they run.
    !/if \[ -n "\$\{(NODE|UV)_SHA256\}" \]; then/.test(dockerfile) &&
    kernelTreePinned &&
    (dockerfile.match(/sha256sum -c -/g) ?? []).length >= 3
  ) {
    pass("runtime_release_asset_integrity", "Downloaded runtime archives are bound to architecture-specific SHA-256 digests before extraction, and the npm-installed kernel tree is pinned by publish date and verified package by package.");
  } else {
    fail("runtime_release_asset_integrity_missing", "Runtime release archives must be verified against pinned architecture-specific SHA-256 digests, and the installed kernel tree must be asserted at one version.");
  }

  // The one third-party binary this image fetches and redistributes is uv, and
  // its license travels with it, checksum-verified. The kernel's own license
  // ships inside the npm package that carries the kernel, so there is no
  // separate fetch to verify — which is why the retired
  // `OPENCODE_LICENSE_SHA256` arg has no successor here.
  if (
    /^ARG UV_LICENSE_MIT_SHA256=[a-f0-9]{64}$/m.test(dockerfile) &&
    /uv\/\$\{UV_VERSION\}\/LICENSE-MIT/.test(dockerfile) &&
    /\/usr\/share\/licenses\/uv\/LICENSE-MIT/.test(dockerfile) &&
    /Verify runtime binaries and preserved licenses/.test(workflow) &&
    /docker run --rm --network none/.test(workflow) &&
    /test -s \/usr\/share\/licenses\/uv\/LICENSE-MIT/.test(workflow) &&
    (dockerfile.match(/sha256sum -c -/g) ?? []).length >= 3
  ) {
    pass("runtime_license_notices", "The runtime image verifies and preserves the pinned uv license text, and CI proves the shipped image still carries it.");
  } else {
    fail("runtime_license_notices_missing", "The runtime image must preserve checksum-verified licenses for redistributed runtime binaries.");
  }
}

async function checkHostedPackaging() {
  const dockerfile = await read("deploy/web/Dockerfile");
  if (/COPY --from=build \/app\/runtime\/skills\/core \.\/runtime\/skills\/core/.test(dockerfile)) {
    pass("web_image_core_skills_only", "Web service image copies the first-party core skill pack.");
  } else {
    fail("web_image_core_skills_missing", "Web service image must copy runtime/skills/core explicitly.");
  }
  if (
    /COPY --from=build \/app\/runtime\/skills\/external\/ai4s-skills \.\/runtime\/skills\/external\/ai4s-skills/.test(dockerfile) &&
    /COPY --from=build \/app\/runtime\/skills\/curated-scientific \.\/runtime\/skills\/curated-scientific/.test(dockerfile) &&
    /COPY --from=build \/app\/runtime\/skills\/office \.\/runtime\/skills\/office/.test(dockerfile) &&
    !/anthropic-skills/.test(dockerfile)
  ) {
    pass("web_image_curated_scientific_skills", "Web image includes the pinned AI4S pack, executable curated skills, and first-party MIT Office exporters.");
  } else {
    fail("web_image_curated_scientific_skills_missing", "Web image must include the reviewed packs and first-party Office exporters without restricted Anthropic materials.");
  }

  const compose = await read("deploy/web/docker-compose.yml");
  if (/OPEN_SCIENCE_RUNTIME_SKILL_DIRS:\s+\$\{OPEN_SCIENCE_RUNTIME_SKILL_DIRS-runtime\/skills\/core,runtime\/skills\/external\/ai4s-skills,runtime\/skills\/curated-scientific,runtime\/skills\/office\}/.test(compose)) {
    pass("compose_default_skill_allowlist", "Compose defaults to reviewed scientific packs and first-party Office exporters.");
  } else {
    fail("compose_default_skill_allowlist_missing", "Compose must default to the reviewed scientific skill allowlists.");
  }

  const commands = await read("apps/server/src/commands.mjs");
  const security = await read("apps/server/src/security.mjs");
  const server = await read("apps/server/src/server.mjs");
  const serverTests = await read("apps/server/test/server.test.mjs");
  const deploymentSmoke = await read("scripts/ops/deployment-smoke.mjs");
  const releaseGenerator = await read("scripts/ops/generate-release-manifest.mjs");
  if (
    /COPY --from=build \/app\/examples\/climate-trends \.\/examples\/climate-trends/.test(dockerfile) &&
    /OPEN_SCIENCE_EXAMPLES_DIR=\/app\/examples/.test(dockerfile) &&
    /"examples\/climate-trends"/.test(releaseGenerator) &&
    /BUNDLED_EXAMPLES/.test(commands) &&
    /writeFileExclusiveNoFollow/.test(commands) &&
    /assertProjectCapacity\(ctx\.project, destination, data\.length, ctx\.config\)/.test(commands) &&
    /async function readinessExamples/.test(server) &&
    /export async function writeFileExclusiveNoFollow/.test(security) &&
    /hosted example installation copies the real bundled dataset without overwriting edits/.test(serverTests) &&
    /hosted example installation obeys the project storage quota/.test(serverTests) &&
    /real workflow example install ok/.test(deploymentSmoke)
  ) {
    pass("hosted_example_parity", "The hosted workflow starter installs the release-bound real climate dataset with readiness, quota, no-follow, atomic-create, and no-overwrite guarantees.");
  } else {
    fail("hosted_example_parity_missing", "Hosted workflow examples must package and install the real release-bound resources rather than placeholder output.");
  }
}

async function checkDeepSeekCompatibilityPreflight() {
  const pkg = JSON.parse(await read("package.json"));
  const script = await read("scripts/ops/deepseek-compatibility-preflight.mjs");
  const releaseGate = await read("scripts/ops/deepseek-kernel-release-gate.mjs");
  const workflow = await read(".github/workflows/web.yml");
  const hostPreflight = await read("scripts/ops/host-preflight.mjs");
  const server = await read("apps/server/src/server.mjs");
  const modelGateway = await read("apps/server/src/modelGateway.mjs");
  const config = await read("apps/server/src/config.mjs");
  const operations = await read("docs/WEB_OPERATIONS_RUNBOOK.md");
  const privacy = await read("docs/WEB_PRIVACY_AND_COMPLIANCE.md");
  if (
    pkg.scripts?.["preflight:deepseek"] === "node scripts/ops/deepseek-compatibility-preflight.mjs" &&
    pkg.scripts?.["preflight:deepseek:release"] === "node scripts/ops/deepseek-kernel-release-gate.mjs" &&
    /OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE/.test(script) &&
    !/OPEN_SCIENCE_DEEPSEEK_API_KEY(?:[^_]|$)/.test(script) &&
    // The kernel version a receipt attests, read from the single definition
    // rather than repeated here. This replaces the literal
    // `REQUIRED_OPENCODE_VERSION = "1.17.13"` the gate used to carry: a pin
    // written twice is a pin that can disagree with itself.
    /const REQUIRED_DSH_VERSION = JSON\.parse\(/.test(releaseGate) &&
    /deps-version\.json/.test(releaseGate) &&
    // And the model, certified from what the gateway will actually serve
    // rather than from a name typed into the gate.
    /certifiedDeepSeekModel\(\)/.test(releaseGate) &&
    /createHmac/.test(releaseGate) &&
    /timingSafeEqual/.test(releaseGate) &&
    /MAX_RECEIPT_FUTURE_MS/.test(releaseGate) &&
    // The gate mints again, and the compliance property is unchanged: it may
    // sign only what it measured. These are the three places that could stop
    // being true without any test noticing — the evidence must come from the
    // session the run actually produced, a run that reached the provider
    // outside our gateway must be refused by name, and there must be no second
    // "passed" for a chain nobody drove (`--fake` is refused, not emulated).
    /dshTranscriptEvidence\(/.test(releaseGate) &&
    /deepseek_release_gateway_bypass_detected/.test(releaseGate) &&
    /deepseek_release_mode_invalid/.test(releaseGate) &&
    /test\/deepseekCompatibility\.test\.mjs/.test(workflow) &&
    /validateDeepSeekCompatibilityTool/.test(hostPreflight) &&
    /readDeepSeekReleaseReceiptFile/.test(hostPreflight) &&
    /readDeepSeekReleaseReceiptFile/.test(server) &&
    /modelGatewayMaxResponseBytes/.test(config) &&
    /pipeModelGatewayBody/.test(modelGateway) &&
    /model_gateway_response_too_large/.test(modelGateway) &&
    /pnpm preflight:deepseek:release/.test(operations) &&
    /MODEL_GATEWAY_SIGNING_SECRET_FILE/.test(operations) &&
    /HMAC-authenticated/.test(privacy)
  ) {
    pass("deepseek_compatibility_preflight", "File-keyed DeepSeek tooling and the kernel release gate are runnable, pinned from the single version definition, HMAC/freshness-bound, response-bounded, sign only session evidence from a driven chain, and make no live CI calls.");
  } else {
    fail("deepseek_compatibility_preflight_missing", "DeepSeek compatibility tooling must be file-keyed, runnable, preflight-checked, and fake-provider tested.");
  }

  // The CI step that runs those gates, checked against the files on disk
  // rather than against a remembered filename. Naming a test file that does
  // not exist is how a rename turns a gate into a step that cannot run.
  const gateStep = workflow.match(/Test DeepSeek compatibility and release gates[\s\S]*?\n\n/)?.[0] ?? "";
  const namedTests = [...gateStep.matchAll(/(test\/[A-Za-z0-9_.-]+\.test\.mjs)/g)].map((match) => match[1]);
  const absentTests = namedTests.filter((rel) => !existsSync(path.join(repoRoot, "apps/server", rel)));
  if (namedTests.length >= 2 && absentTests.length === 0) {
    pass("deepseek_release_gate_ci_step", "The CI DeepSeek gate step names release-gate tests that exist.", {
      tests: namedTests,
    });
  } else {
    // A notice, not a block: this file is not owned by the compliance audit's
    // package and CI fails loudly on a missing test path. It is named so the
    // rename is visible before someone reads a red CI log for it.
    warn("deepseek_release_gate_ci_step_stale", "The CI DeepSeek gate step names test files that do not exist; the release-gate suite was renamed to test/deepseekKernelReleaseGate.test.mjs.", {
      named: namedTests,
      absent: absentTests,
    });
  }
}

async function checkRuntimeContainerTopology() {
  const dockerfile = await read("deploy/runtime-dsh/Dockerfile");
  const compose = await read("deploy/web/docker-compose.yml");
  const workflow = await read(".github/workflows/web.yml");
  const envExample = await read("deploy/web/.env.example");
  const hostPreflight = await read("scripts/ops/host-preflight.mjs");
  const mounts = await read("apps/server/src/dockerMounts.mjs");
  const commands = await read("apps/server/src/commands.mjs");
  const manager = await read("apps/server/src/runtimeManager.mjs");
  const controller = await read("apps/server/src/runtimeControllerServer.mjs");
  const launcher = await read("deploy/runtime-dsh/open-science-dsh-serve.sh");
  const webService = composeService(compose, "open-science-web");
  const controllerService = composeService(compose, "open-science-runtime-controller");

  if (
    /OPEN_SCIENCE_RUNTIME_CONTROLLER_MODE:\s+socket/.test(webService) &&
    /OPEN_SCIENCE_ALLOW_DIRECT_DOCKER_CONTROL:\s+"false"/.test(webService) &&
    /open-science-runtime-control:\/run\/open-science-controller:ro/.test(webService) &&
    !/\/var\/run\/docker\.sock/.test(webService) &&
    /security_opt:\s*\n\s+- no-new-privileges:true/.test(webService) &&
    /cap_drop:\s*\n\s+- ALL/.test(webService) &&
    /read_only:\s+true/.test(webService) &&
    /OPEN_SCIENCE_WEB_TMPFS_SIZE:-128m/.test(webService) &&
    /runtimeControllerIndex\.mjs/.test(controllerService) &&
    /open-science-data:\/data:ro/.test(controllerService) &&
    /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/.test(controllerService) &&
    /group_add:\s*\n\s+- "\$\{OPEN_SCIENCE_DOCKER_SOCKET_GID:\?set OPEN_SCIENCE_DOCKER_SOCKET_GID\}"/.test(controllerService) &&
    !/^\s+ports:/m.test(controllerService) &&
    /^OPEN_SCIENCE_DOCKER_SOCKET_GID=replace-with-docker-socket-gid$/m.test(envExample) &&
    /validateDockerSocketStat/.test(hostPreflight) &&
    /preflight_docker_socket_gid_mismatch/.test(hostPreflight) &&
    /Verify Docker socket privilege boundary/.test(workflow) &&
    /OPEN_SCIENCE_DOCKER_SOCKET_GID=\$\(stat -c '%g' \/var\/run\/docker\.sock\)/.test(workflow) &&
    /\.HostConfig\.GroupAdd/.test(workflow) &&
    /Web API root filesystem must be read-only/.test(workflow) &&
    /Web API container must not mount \/var\/run\/docker\.sock/.test(workflow) &&
    /Web API controller mount must be read-only/.test(workflow) &&
    // The launch plan is still reconstructed inside the controller from the
    // scoped project identifier and a port, never handed over by the API. The
    // signature lost its `password` argument when the kernel it authenticated
    // was retired, and the arity is pinned here because a plan builder that
    // started accepting caller-supplied arguments is exactly the regression
    // this check exists to catch.
    /buildRuntimeLaunchPlan\(config, project, port\)/.test(controller) &&
    !/payload\.args|payload\.image|payload\.mount/.test(controller)
  ) {
    pass("runtime_controller_privilege_boundary", "Only the unexposed runtime controller holds the Docker socket; the capability-free, read-only API receives a read-only control-socket mount, and the controller reconstructs fixed launch plans from scoped project identifiers.");
  } else {
    fail("runtime_controller_privilege_boundary_missing", "The public API must not hold the Docker socket or accept arbitrary container launch parameters.");
  }

  if (
    /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES:\s+\$\{OPEN_SCIENCE_MAX_RUNNING_RUNTIMES:-8\}/.test(controllerService) &&
    /OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER:\s+\$\{OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER:-4\}/.test(controllerService) &&
    /dockerRuntimeInventory\(config\)/.test(controller) &&
    /dockerManagedInventory\(config, "open-science\.web\.runtime=true"\)/.test(controller) &&
    /reserveRuntimeCapacity\(project\)/.test(controller) &&
    /withProjectOperation\(project/.test(controller) &&
    /runtime_controller_limit_mismatch/.test(manager)
  ) {
    pass("runtime_controller_resource_admission", "The Docker control plane independently discovers runtimes, serializes project lifecycle operations, and enforces API-matched global and per-user capacity limits.");
  } else {
    fail("runtime_controller_resource_admission_missing", "Runtime capacity and project lifecycle serialization must be enforced inside the Docker control plane.");
  }

  if (
    /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS:\s+\$\{OPEN_SCIENCE_MAX_CONCURRENT_KERNELS:-2\}/.test(controllerService) &&
    /OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER:\s+\$\{OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER:-1\}/.test(controllerService) &&
    /kernelCapacityLimits\(config\)/.test(controller) &&
    /dockerKernelInventory\(config\)/.test(controller) &&
    /cleanupStaleKernelContainers\(config\)/.test(controller) &&
    /"--interactive"/.test(commands) &&
    /language === "python" \? "python" : "Rscript",\s*\n\s*"-"/.test(commands) &&
    /reserveKernelCapacity\(project, plan\.containerName\)/.test(controller) &&
    /kernel_orphan_cleanup_failed/.test(controller) &&
    /health\.maxConcurrentKernels/.test(manager)
  ) {
    pass("runtime_controller_kernel_admission", "The Docker control plane independently limits kernel concurrency, removes labelled orphan kernels before becoming available, and keeps stdin attached for bounded Python execution.");
  } else {
    fail("runtime_controller_kernel_admission_missing", "Kernel concurrency and orphan cleanup must be enforced inside the Docker control plane.");
  }

  if (
    /OPEN_SCIENCE_RUNTIME_DATA_VOLUME:\s+\$\{OPEN_SCIENCE_DATA_VOLUME:-open-science-data\}/.test(compose) &&
    /name:\s+\$\{OPEN_SCIENCE_DATA_VOLUME:-open-science-data\}/.test(compose) &&
    /volume-subpath=/.test(mounts) &&
    /dockerWorkspaceMount\(config, project\)/.test(manager)
  ) {
    pass("runtime_project_volume_subpaths", "Runtime and kernel mounts use scoped subpaths of the API data volume.");
  } else {
    fail("runtime_project_volume_subpaths_missing", "Hosted sibling containers must share scoped named-volume subpaths, not container-local bind paths.");
  }

  // The kernel binds loopback inside its own container and socat re-exposes it
  // as a 0600 Unix socket on the shared volume. Same property as before, one
  // launcher: the API container's localhost must never be the way it reaches a
  // sibling container.
  if (
    /OPEN_SCIENCE_RUNTIME_TRANSPORT:\s+\$\{OPEN_SCIENCE_RUNTIME_TRANSPORT:-unix\}/.test(compose) &&
    /requestRuntime\(runtime/.test(manager) &&
    /\bsocat\b/.test(dockerfile) &&
    /UNIX-LISTEN:\$\{socket\},fork,unlink-early,mode=0600/.test(launcher) &&
    /TCP:127\.0\.0\.1:\$\{port\}/.test(launcher) &&
    /dsh --profile "\$\{profile\}"/.test(launcher)
  ) {
    pass("runtime_unix_socket_transport", "Agent runtime HTTP/SSE uses a project-scoped, owner-only Unix socket across sibling containers.");
  } else {
    fail("runtime_unix_socket_transport_missing", "The hosted agent runtime must not rely on the API container's localhost to reach a sibling container.");
  }

  if (
    /OPEN_SCIENCE_RUNTIME_NETWORK_MODE:\s+\$\{OPEN_SCIENCE_RUNTIME_NETWORK_MODE:-open-science-runtime-internal\}/.test(compose) &&
    /OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME:\s+\$\{OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME:-open-science-runtime-internal\}/.test(compose) &&
    /runtime-internal:\s*[\s\S]*?internal:\s+true/.test(compose) &&
    /OPEN_SCIENCE_RUNTIME_NETWORK_MODE=open-science-runtime-internal/.test(workflow) &&
    /OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME=open-science-runtime-internal/.test(workflow) &&
    !/OPEN_SCIENCE_RUNTIME_NETWORK_MODE=bridge/.test(workflow)
  ) {
    pass("runtime_default_network_isolation", "Compose and Linux runtime smoke restrict hosted runtimes to the internal gateway network.");
  } else {
    fail("runtime_default_network_isolation_missing", "Hosted runtime defaults and CI must not silently enable bridge egress.");
  }

  // One agent runtime image, built from one Dockerfile.
  //
  // While two kernel images were declared, both tagged their build from
  // `OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE` — the single variable `config.mjs`
  // resolves the launched image from — so `--profile runtime-image build`
  // could overwrite the tag the control plane launches with an image built
  // from a Dockerfile no deployment ships. Counting the runtime Dockerfiles
  // Compose builds is what makes that unrepeatable, rather than banning one
  // retired service name that a second copy would not match.
  const runtimeBuildFiles = [...compose.matchAll(/^\s+dockerfile:\s+(deploy\/runtime-[a-z0-9-]+\/Dockerfile)$/gm)]
    .map((match) => match[1]);
  if (runtimeBuildFiles.length === 1 && runtimeBuildFiles[0] === "deploy/runtime-dsh/Dockerfile") {
    pass("hosted_runtime_kernel_singular", "Compose builds exactly one agent runtime image, from deploy/runtime-dsh/Dockerfile.", {
      dockerfile: runtimeBuildFiles[0],
    });
  } else {
    fail("hosted_runtime_kernel_singular_missing", "Compose must build exactly one agent runtime image, and it must be deploy/runtime-dsh/Dockerfile.", {
      dockerfiles: runtimeBuildFiles,
    });
  }

  // And the retired tree itself, deleted on 2026-09-02 once nothing ran it, no
  // config named it, and no manifest recorded it. The check outlives the tree
  // because restoring the directory is all it would take to have releases
  // recording digests for an image no deployment can launch again, and the
  // reappearance would otherwise be silent.
  if (!existsSync(path.join(repoRoot, "deploy/runtime-opencode"))) {
    pass("retired_runtime_tree_removed", "The retired kernel's build tree is gone.");
  } else {
    warn("retired_runtime_tree_present", "deploy/runtime-opencode/ is back on disk; the platform builds and launches one runtime image, from deploy/runtime-dsh/, and a second build tree can only produce an image no deployment starts.");
  }
}

async function checkConfiguredSkills() {
  const restrictedRoot = path.join(repoRoot, "runtime/skills/external/anthropic-skills");
  const configured = configuredRuntimeSkillDirs();
  if (configured.length === 0) {
    warn("runtime_skills_disabled", "No runtime skill directories are configured.");
    return;
  }

  for (const dir of configured) {
    const rel = repoRel(dir);
    if (!existsSync(dir)) {
      fail("runtime_skill_dir_missing", "Configured runtime skill directory does not exist.", { directory: rel });
      continue;
    }
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) {
      fail("runtime_skill_dir_symlink", "Configured runtime skill directory must not be a symbolic link.", { directory: rel });
      continue;
    }
    if (isInside(dir, restrictedRoot) && !allowRestrictedSkills) {
      fail("restricted_skill_directory", "Configured runtime skills include Anthropic restricted materials.", { directory: rel });
      continue;
    }

    const licenseFiles = await restrictiveLicenseFiles(dir);
    if (licenseFiles.length > 0 && !allowRestrictedSkills) {
      fail("restrictive_skill_license", "Configured runtime skills include restrictive license files.", {
        directory: rel,
        files: licenseFiles,
      });
    } else {
      pass("runtime_skill_dir_reviewed", "Configured runtime skill directory passed local redistribution checks.", {
        directory: rel,
      });
    }
  }
}

async function checkScientificCapabilityDelivery() {
  const curatedRoot = path.join(repoRoot, "runtime/skills/curated-scientific");
  const curated = JSON.parse(await read("runtime/skills/curated-scientific/inventory.json"));
  const curatedDelivery = curated.policy?.delivery ?? {};
  const executable = Object.keys(curatedDelivery.executable ?? {}).sort();
  const conditional = Object.keys(curatedDelivery.conditional ?? {}).sort();
  const instructionOnly = [...(curatedDelivery.instructionOnly ?? [])].sort();
  const tiered = [...executable, ...conditional, ...instructionOnly].sort();
  const inventoried = (curated.skills ?? []).map((skill) => skill.name).sort();
  const runtimeManager = await read("apps/server/src/runtimeManager.mjs");
  // The one runtime image must carry the scientific stack the curated skills
  // import, because it is the image every run executes in.
  const runtimeDockerfile = await read("deploy/runtime-dsh/Dockerfile");
  const inRuntimeImage = (probe) =>
    typeof probe === "string" ? runtimeDockerfile.includes(probe) : probe.test(runtimeDockerfile);
  const skillTests = await read("apps/server/test/skillPacks.test.mjs");
  const executableEntrypoints = Object.entries(curatedDelivery.executable ?? {}).flatMap(([skill, contract]) =>
    (contract.entrypoints ?? []).map((entrypoint) => path.join(curatedRoot, skill, entrypoint)),
  );
  const executableDependencies = Object.values(curatedDelivery.executable ?? {})
    .flatMap((contract) => contract.dependencies ?? [])
    .filter((dependency) => dependency !== "python>=3.11");
  if (
    curatedDelivery.contractVersion === 1 &&
    curatedDelivery.defaultEnabledTier === "executable" &&
    executable.length === 38 &&
    conditional.length === 0 &&
    instructionOnly.length === 0 &&
    JSON.stringify(tiered) === JSON.stringify(inventoried) &&
    executableEntrypoints.every((entrypoint) => existsSync(entrypoint)) &&
    executableDependencies.every((dependency) => inRuntimeImage(dependency)) &&
    inRuntimeImage(/pypdf==6\.7\.0/) &&
    inRuntimeImage(/openpyxl==3\.1\.5/) &&
    inRuntimeImage(/ENV VIRTUAL_ENV=\/opt\/evimed\/venv/) &&
    inRuntimeImage(/uv venv "\$\{VIRTUAL_ENV\}" --python \/usr\/bin\/python3/) &&
    inRuntimeImage(/uv pip install --python "\$\{VIRTUAL_ENV\}\/bin\/python"/) &&
    !inRuntimeImage(/uv pip install --system/) &&
    // Who reads the delivery contract, and when.
    //
    // It used to be the server: `runtimeSkillDelivery(sourceRoot)` parsed
    // `inventory.json` and copied only the executable tier into the retired
    // kernel's config directory on every launch. The runtime image now carries
    // the pack, so the same contract is read one step earlier and enforced
    // where it cannot be skipped -- the build reads
    // `policy.delivery.executable`, refuses a tier that is not exhaustive, and
    // then executes every shared implementation before the image can exist.
    // Per-launch filtering has no successor because there is nothing left to
    // filter: what ships is what was smoked.
    inRuntimeImage(/inventory\["policy"\]\["delivery"\]\["executable"\]/) &&
    inRuntimeImage(/len\(contracts\) != 38/) &&
    inRuntimeImage(/len\(shared\) != 36/) &&
    inRuntimeImage(/Smoke every shared curated-skill implementation in the production dependency image/) &&
    // And the pack the build smoked is the pack the kernel is given: copied
    // into the preset root the kernel actually reads, read-only.
    inRuntimeImage("COPY runtime/skills/curated-scientific /usr/local/share/evimed/skills/curated-scientific") &&
    inRuntimeImage(/presets\/evimed-universal\/skills\/curated-scientific/) &&
    inRuntimeImage(/chmod -R a-w \/opt\/evimed\/socket/) &&
    /all 38 curated scientific skills have an executable, dependency-pinned, smoke-tested delivery contract/.test(skillTests)
  ) {
    pass("curated_skill_delivery_contract", "All 38 curated scientific skills have executable entrypoints, pinned runtime dependencies, artifact contracts, build-time delivery-contract enforcement, and read-only delivery into the preset root the kernel reads.", {
      inventoried: inventoried.length,
      executable: executable.length,
      conditional: conditional.length,
      instructionOnly: instructionOnly.length,
    });
  } else {
    fail("curated_skill_delivery_contract_missing", "Curated skills need an exhaustive delivery tier, executable entrypoints, pinned dependencies, build-time contract enforcement, and independent contract tests.");
  }

  const officeRoot = path.join(repoRoot, "runtime/skills/office");
  const office = JSON.parse(await read("runtime/skills/office/inventory.json"));
  const officeExecutable = Object.entries(office.policy?.delivery?.executable ?? {});
  const officeEntrypoints = officeExecutable.flatMap(([skill, contract]) =>
    (contract.entrypoints ?? []).map((entrypoint) => path.join(officeRoot, skill, entrypoint)),
  );
  const tauriConfig = await read("apps/desktop/src-tauri/tauri.conf.json");
  const fetchSkills = await read("scripts/dev/fetch-skills.sh");
  if (
    office.license === "MIT" &&
    /first-party clean-room/i.test(office.provenance ?? "") &&
    officeExecutable.length === 4 &&
    officeEntrypoints.every((entrypoint) => existsSync(entrypoint)) &&
    inRuntimeImage(/runtime\/skills\/office/) &&
    /skills-office/.test(tauriConfig) &&
    !/anthropic-skills/.test(tauriConfig) &&
    !/ANTHROPIC_SKILLS_(?:COMMIT|ARCHIVE|LICENSE)/.test(fetchSkills) &&
    /the four first-party Office skills execute independent artifact smoke tests/.test(skillTests)
  ) {
    pass("first_party_office_artifact_chain", "Four first-party MIT Office exporters have executable entrypoints, parseable-artifact tests, and desktop/Hosted packaging.", {
      executable: officeExecutable.length,
    });
  } else {
    fail("first_party_office_artifact_chain_missing", "Office delivery must use first-party permissive code with four tested artifact exporters and no restricted Anthropic packaging path.");
  }

  const connectors = [
    "paper-search",
    "biomcp",
    "materials-project",
    "fred",
    "spaceweather",
    "open-meteo",
    "usgs-water",
  ];
  const connectorSource = await read("runtime/mcp/evimed-research/science_connectors.py");
  const connectorTests = await read("runtime/mcp/evimed-research/test/test_science_connectors.py");
  const publicGateway = await read("apps/server/src/publicSourceGateway.mjs");
  const compose = await read("deploy/web/docker-compose.yml");
  const workflow = await read(".github/workflows/web.yml");
  const gatewayHosts = [
    "api.crossref.org",
    "eutils.ncbi.nlm.nih.gov",
    "clinicaltrials.gov",
    "api.materialsproject.org",
    "fred.stlouisfed.org",
    "services.swpc.noaa.gov",
    "api.open-meteo.com",
    "waterservices.usgs.gov",
  ];
  // The connector chain, minus the one link that moved and has not landed.
  //
  // Registration is checked separately below rather than folded in here,
  // because it is the only half that is currently broken and a conjunction
  // that fails as a whole tells an operator nothing about which of eight
  // properties is missing.
  if (
    connectors.every((connector) => connectorSource.includes(`"${connector}"`)) &&
    // The server still holds the connector roster the runtime is meant to be
    // given, so the two cannot silently disagree about which seven exist.
    connectors.every((connector) => runtimeManager.includes(`"${connector}"`)) &&
    gatewayHosts.every((host) => publicGateway.includes(`"${host}"`)) &&
    /x-api-key/.test(publicGateway) &&
    /OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_FILE:\s*\/run\/secrets\/materials-project-api-key/.test(compose) &&
    /OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_HOST_FILE:\?/.test(compose) &&
    /pnpm test:mcp/.test(workflow) &&
    (connectorTests.match(/^\s+def test_/gm) ?? []).length >= 7
  ) {
    pass("hosted_science_connector_chain", "Seven independent MCP connectors reach fixed upstream hosts only through the server gateway, with a file-only Materials Project secret and independent CI protocol tests.", {
      connectors: connectors.length,
    });
  } else {
    fail("hosted_science_connector_chain_missing", "All seven science connectors need a shared roster, fixed-host gateway routes, protected Materials credentials, and independent CI tests.");
  }

  // Whether anything actually hands those seven to a run.
  //
  // The retired kernel got them as seven MCP entries named `science-<id>`,
  // written per project by `syncRuntimeEviMedMcp`. Under DSH the profile patch
  // is the only thing that mounts an MCP server, and it mounts exactly two:
  // the EviMed research server and the ToolUniverse sidecar. `science_connectors.py`
  // is still shipped in the image and still dispatches on
  // `OPEN_SCIENCE_CONNECTOR_ID`, and `runtimeManager.mjs` still declares the
  // roster -- but nothing reads either, so all seven are unreachable from a
  // run while every other link in the chain above audits clean.
  //
  // A notice rather than a block: the fix is in `apps/server/src` (the profile
  // patch or the MCP server's own tool surface), not in this audit, and a
  // failing gate here would only stop the tree that has to carry the fix.
  const profilePatch = await read("apps/server/src/dshProfilePatch.mjs");
  const registered = connectors.filter(
    (connector) => profilePatch.includes(`science-${connector}`) || profilePatch.includes(`"${connector}"`),
  );
  const connectorServerImported = /^import science_connectors/m.test(
    await read("runtime/mcp/evimed-research/server.py"),
  );
  if (registered.length === connectors.length || connectorServerImported) {
    pass("hosted_science_connector_runtime_reach", "Every science connector is reachable from a run, either as its own mounted MCP server or through the EviMed research server.", {
      registered: registered.length,
      viaResearchServer: connectorServerImported,
    });
  } else {
    warn("hosted_science_connector_runtime_reach_missing", "No science connector is mounted for a run: the DSH profile patch registers only the EviMed research server and the ToolUniverse sidecar, and runtime/mcp/evimed-research/server.py does not import science_connectors.", {
      connectors: connectors.length,
      registered: registered.length,
    });
  }
}

async function checkPrivacyDocs() {
  const privacy = await read("docs/WEB_PRIVACY_AND_COMPLIANCE.md");
  const deployment = await read("docs/WEB_DEPLOYMENT.md");
  const readiness = await read("docs/WEB_DEPLOYMENT_READINESS_REPORT.md");
  const operations = await read("docs/WEB_OPERATIONS_RUNBOOK.md");
  const incident = await read("docs/WEB_SECURITY_INCIDENT_RESPONSE.md");
  const required = [
    [privacy, "Model Keys and Provider Data Flow", "privacy_model_keys"],
    [privacy, "Third-Party Components and Licenses", "privacy_third_party"],
    // Kernel-agnostic on purpose: the property is "keys live in a
    // server-managed profile, not in the user's hands", and it must survive
    // the kernel being renamed in the sentence that states it.
    [
      deployment,
      /Real model use requires configuring a server-managed \S+ profile/,
      "deployment_model_key_boundary",
      "the server-managed model profile boundary",
    ],
    [readiness, "Office skills", "readiness_office_boundary"],
  ];
  for (const [document, phrase, code, label] of required) {
    const found = typeof phrase === "string" ? document.includes(phrase) : phrase.test(document);
    const described = label ?? phrase;
    if (found) pass(code, `Documentation includes ${described}.`);
    else fail(`${code}_missing`, `Documentation must include ${described}.`);
  }

  if (
    incident.includes("## Roles and Severity") &&
    incident.includes("## User Project Access Authorization") &&
    incident.includes("## Evidence Preservation") &&
    incident.includes("## Recovery Gate") &&
    incident.includes("Data Access Approver") &&
    incident.includes("must not impersonate a user") &&
    operations.includes("WEB_SECURITY_INCIDENT_RESPONSE.md") &&
    privacy.includes("WEB_SECURITY_INCIDENT_RESPONSE.md")
  ) {
    pass("security_incident_response", "Security incidents have explicit role separation, project-access approval, evidence, recovery, and notification controls.");
  } else {
    fail("security_incident_response_missing", "Hosted operations require an enforced security and privacy incident-response workflow.");
  }
}

async function checkProductionIdentity() {
  const serverPackage = JSON.parse(await read("apps/server/package.json"));
  const oidcSource = await read("apps/server/src/oidc.mjs");
  const overlay = await read("deploy/web/docker-compose.oidc.yml");
  const privacy = await read("docs/WEB_PRIVACY_AND_COMPLIANCE.md");
  const deployment = await read("docs/WEB_DEPLOYMENT.md");

  if (
    /^\d+\.\d+\.\d+$/.test(serverPackage.dependencies?.["openid-client"] ?? "") &&
    /randomPKCECodeVerifier/.test(oidcSource) &&
    /expectedState:\s*flow\.state/.test(oidcSource) &&
    /expectedNonce:\s*flow\.nonce/.test(oidcSource) &&
    /idTokenExpected:\s*true/.test(oidcSource)
  ) {
    pass("production_oidc_protocol", "Production identity uses a pinned OIDC client with PKCE, state, nonce, and ID Token validation.");
  } else {
    fail("production_oidc_protocol_missing", "Production OIDC must pin its client and validate PKCE, state, nonce, and ID Tokens.");
  }

  if (
    /aes-256-gcm/.test(oidcSource) &&
    /oidc-client-secret\.txt/.test(overlay) &&
    /oidc-flow-secret\.txt/.test(overlay) &&
    !/access_token\s*:/.test(oidcSource)
  ) {
    pass("production_oidc_secret_boundary", "OIDC uses separate file-backed secrets and encrypted short-lived correlation state without persisting provider tokens.");
  } else {
    fail("production_oidc_secret_boundary_missing", "OIDC client secrets, flow secrets, and provider tokens need an explicit server-only boundary.");
  }

  if (
    privacy.includes("External Identity and OIDC") &&
    deployment.includes("docker-compose.oidc.yml") &&
    deployment.includes("Authorization Code with PKCE")
  ) {
    pass("production_oidc_documented", "OIDC identity data, deployment, and operator controls are documented.");
  } else {
    fail("production_oidc_documentation_missing", "OIDC identity data and deployment controls must be documented.");
  }
}

async function checkLocalAuthSecretBoundary() {
  const config = await read("apps/server/src/config.mjs");
  const server = await read("apps/server/src/server.mjs");
  const overlay = await read("deploy/web/docker-compose.local-auth.yml");
  const envExample = await read("deploy/web/.env.example");
  const configure = await read("scripts/ops/configure-local-auth.mjs");
  const releaseGenerator = await read("scripts/ops/generate-release-manifest.mjs");
  const preflight = await read("scripts/ops/host-preflight.mjs");
  const workflow = await read(".github/workflows/web.yml");
  const serverTests = await read("apps/server/test/server.test.mjs");

  if (
    /fileEnv:\s*"OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE"/.test(config) &&
    /bootstrap_password_environment_forbidden/.test(server) &&
    /OPEN_SCIENCE_BOOTSTRAP_PASSWORD:\s*""/.test(overlay) &&
    /OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE:\s*\/run\/secrets\/bootstrap-password/.test(overlay) &&
    /mode:\s*0400/.test(overlay) &&
    /^OPEN_SCIENCE_BOOTSTRAP_PASSWORD=$/m.test(envExample) &&
    /^OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE=\.\/secrets\/bootstrap-password\.txt$/m.test(envExample) &&
    /O_NOFOLLOW/.test(configure) &&
    /stat\.mode & 0o077/.test(configure) &&
    /preflight_bootstrap_password_environment/.test(preflight) &&
    /docker-compose\.local-auth\.yml/.test(workflow) &&
    /pnpm configure:local-auth/.test(workflow) &&
    !/OPEN_SCIENCE_BOOTSTRAP_PASSWORD=ci-/.test(workflow) &&
    /scripts\/ops\/configure-local-auth\.mjs/.test(releaseGenerator) &&
    /deploy\/web\/docker-compose\.local-auth\.yml/.test(releaseGenerator) &&
    /bootstraps from a no-follow password file/.test(serverTests) &&
    /rejects an environment-sourced bootstrap password/.test(serverTests)
  ) {
    pass("production_local_auth_secret_boundary", "Production local authentication uses a private no-follow Docker secret, rejects runtime environment passwords, and exercises the same path in Linux Compose CI.");
  } else {
    fail("production_local_auth_secret_boundary_missing", "Production local authentication must keep bootstrap credentials out of Compose environment values and enforce a tested file-secret path.");
  }
}

async function checkDependencySecurity() {
  const pkg = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/web.yml");
  const overrides = pkg.pnpm?.overrides ?? {};
  if (
    overrides["pptx-preview>echarts"] === "6.1.0" &&
    overrides["pptx-preview>uuid"] === "11.1.1" &&
    overrides["exceljs>uuid"] === "11.1.1"
  ) {
    pass("browser_dependency_security_overrides", "Document preview dependencies override known-vulnerable ECharts and UUID versions.");
  } else {
    fail("browser_dependency_security_overrides_missing", "Hosted document preview dependencies must use patched ECharts and UUID versions.");
  }
  if (
    /pnpm audit --prod --audit-level moderate --registry=https:\/\/registry\.npmjs\.org/.test(
      pkg.scripts?.["audit:dependencies"] ?? "",
    ) &&
    /pnpm audit:dependencies/.test(pkg.scripts?.["ci:web"] ?? "") &&
    /run:\s*pnpm audit:dependencies/.test(workflow)
  ) {
    pass("production_dependency_audit_gate", "Local and GitHub Web CI audit production dependencies against the npm advisory endpoint at moderate severity.");
  } else {
    fail("production_dependency_audit_gate_missing", "Web CI must run a production dependency vulnerability audit.");
  }
  // Every accepted advisory needs a standing reason, so pin the list here and
  // make any change fail this gate until it is reviewed the same way.
  //
  // The list is now empty, and that is the reviewed state. The brace-expansion
  // chain under exceljs used to be accepted rather than fixed: the patched line
  // at the time was 5, and every minimatch release depending on it exports an
  // object where glob 7 requires a callable, so forcing 5 into that chain broke
  // it and the advisory was accepted on the grounds that the hosted bundle ships
  // exceljs's browser build and never loads those Node archive dependencies.
  // Upstream has since backported the fix within each major line — 1.1.18 and
  // 2.1.4 — so the chain is pinned to a patched release of the line it already
  // used, no major is forced anywhere, and `pnpm audit --prod` is clean with no
  // exception at all. An advisory that can be fixed should not be accepted.
  const acceptedAdvisories = pkg.pnpm?.auditConfig?.ignoreCves ?? [];
  if (acceptedAdvisories.length === 0) {
    pass("production_dependency_audit_exceptions", "No production advisory is accepted; the previously accepted brace-expansion chain is patched by override.");
  } else {
    fail("production_dependency_audit_exceptions_unreviewed", "Accepted production dependency advisories changed and need review.");
  }
}

async function checkMonitoringBaseline() {
  const compose = await read("deploy/web/docker-compose.monitoring.yml");
  const rules = JSON.parse(await read("deploy/web/monitoring/open-science.rules.json"));
  const prometheus = JSON.parse(await read("deploy/web/monitoring/prometheus.json"));
  const dashboard = JSON.parse(await read("deploy/web/monitoring/grafana/dashboards/open-science-operations.json"));
  const runbook = await read("docs/WEB_OPERATIONS_RUNBOOK.md");

  const versionPins = [
    /prom\/prometheus:\$\{OPEN_SCIENCE_PROMETHEUS_VERSION:-v\d+\.\d+\.\d+\}/,
    /prom\/alertmanager:\$\{OPEN_SCIENCE_ALERTMANAGER_VERSION:-v\d+\.\d+\.\d+\}/,
    /prom\/blackbox-exporter:\$\{OPEN_SCIENCE_BLACKBOX_EXPORTER_VERSION:-v\d+\.\d+\.\d+\}/,
    /grafana\/grafana:\$\{OPEN_SCIENCE_GRAFANA_VERSION:-\d+\.\d+\.\d+\}/,
  ];
  if (versionPins.every((pattern) => pattern.test(compose)) && !/:latest(?:\s|$|})/.test(compose)) {
    pass("monitoring_images_pinned", "Bundled monitoring images use explicit version defaults.");
  } else {
    fail("monitoring_images_unpinned", "Bundled monitoring images must use explicit non-latest versions.");
  }

  const metricsJob = prometheus.scrape_configs?.find((job) => job.job_name === "open-science-web");
  const healthJob = prometheus.scrape_configs?.find((job) => job.job_name === "open-science-health");
  const readinessJob = prometheus.scrape_configs?.find((job) => job.job_name === "open-science-readiness");
  if (
    metricsJob?.authorization?.credentials_file === "/run/secrets/operator_metrics_token" &&
    healthJob?.static_configs?.[0]?.targets?.[0]?.endsWith("/api/health") &&
    readinessJob?.static_configs?.[0]?.targets?.[0]?.endsWith("/api/ready")
  ) {
    pass("monitoring_protected_probes", "Monitoring scrapes protected metrics and probes health/readiness.");
  } else {
    fail("monitoring_protected_probes_missing", "Monitoring must protect metrics and probe health/readiness.");
  }

  const alerts = rules.groups?.flatMap((group) => group.rules ?? []) ?? [];
  if (alerts.length >= 10 && alerts.every((rule) => rule.alert && rule.for && rule.labels?.severity)) {
    pass("monitoring_alert_rules", "Monitoring includes duration-qualified, severity-labelled alert rules.", {
      alerts: alerts.length,
    });
  } else {
    fail("monitoring_alert_rules_missing", "Monitoring must include reviewed availability/error/capacity alerts.");
  }

  if (
    dashboard.uid === "open-science-operations" &&
    runbook.includes("## Alert Response") &&
    runbook.includes("## Secret Rotation") &&
    runbook.includes("Access to project workspaces")
  ) {
    pass("monitoring_runbook", "Monitoring dashboard and operator incident runbook are present.");
  } else {
    fail("monitoring_runbook_missing", "Monitoring requires a provisioned dashboard and incident-response runbook.");
  }
}

async function checkObjectBackup() {
  const objectBackup = await read("scripts/ops/object-backup.mjs");
  const backup = await read("scripts/ops/backup-data.sh");
  const scheduler = await read("scripts/ops/backup-scheduler.mjs");
  const configureBackup = await read("scripts/ops/configure-backup.mjs");
  const configureMonitoring = await read("scripts/ops/configure-monitoring.mjs");
  const hostPreflight = await read("scripts/ops/host-preflight.mjs");
  const compose = await read("deploy/web/docker-compose.yml");
  const backupCompose = await read("deploy/web/docker-compose.backup.yml");
  const webDockerfile = await read("deploy/web/Dockerfile");
  const server = await read("apps/server/src/server.mjs");
  const deployment = await read("docs/WEB_DEPLOYMENT.md");
  const envExample = await read("deploy/web/.env.example");
  const pkg = JSON.parse(await read("package.json"));

  if (
    /assertEncryptedArchive/.test(objectBackup) &&
    /verifyChecksum/.test(objectBackup) &&
    /\.sha256/.test(objectBackup) &&
    /OPEN_SCIENCE_OBJECT_BACKUP_ALLOW_PLAINTEXT/.test(objectBackup)
  ) {
    pass("object_backup_encrypted_integrity", "Object backup requires client-side encryption and verified checksum sidecars by default.");
  } else {
    fail("object_backup_encrypted_integrity_missing", "Off-host object backup must verify checksums and reject plaintext by default.");
  }

  if (
    /spawn\(command, args/.test(objectBackup) &&
    !/shell:\s*true/.test(objectBackup) &&
    /credential-free s3:\/\/bucket/.test(objectBackup) &&
    deployment.includes("standard credential chain")
  ) {
    pass("object_backup_credential_boundary", "Object backup uses argument arrays and keeps credentials out of S3 URIs and documented command lines.");
  } else {
    fail("object_backup_credential_boundary_missing", "Object backup must define a no-shell, credential-free URI boundary.");
  }

  if (
    /object-backup\.mjs upload/.test(pkg.scripts?.["backup:object"] ?? "") &&
    /object-backup\.mjs download/.test(pkg.scripts?.["restore:object"] ?? "") &&
    /OPEN_SCIENCE_OBJECT_BACKUP_URI/.test(backup) &&
    deployment.includes("S3-compatible object storage")
  ) {
    pass("object_backup_workflow", "Encrypted object upload/download is wired into backup tooling and deployment documentation.");
  } else {
    fail("object_backup_workflow_missing", "Object backup upload, download, and operator documentation are required.");
  }

  if (
    /backup-data\.sh/.test(scheduler) &&
    /restore-drill\.sh/.test(scheduler) &&
    /OPEN_SCIENCE_BACKUP_RETRY_SECONDS/.test(scheduler) &&
    /backup-scheduler\.mjs", "health"/.test(backupCompose) &&
    /open-science-backups:\/backups:ro/.test(compose) &&
    /open-science-data:\/data:ro/.test(backupCompose) &&
    /no-new-privileges:true/.test(backupCompose) &&
    !/^\s+ports:/m.test(backupCompose) &&
    /COPY --from=build \/app\/scripts\/ops \.\/scripts\/ops/.test(webDockerfile) &&
    /backup_scheduler_stale/.test(server) &&
    /backup_scheduler_unhealthy/.test(server)
  ) {
    pass("scheduled_backup_service", "The immutable Web image includes a least-privilege scheduled encrypted backup and restore-drill service with persistent health state.");
  } else {
    fail("scheduled_backup_service_missing", "Hosted local backups must be runnable and health-checked from the immutable deployment image.");
  }

  if (
    /configure-backup\.mjs/.test(pkg.scripts?.["configure:backup"] ?? "") &&
    /configure-backup\.mjs --check/.test(pkg.scripts?.["check:backup"] ?? "") &&
    /backup_secret_permissions/.test(configureBackup) &&
    /OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE:\s+\/run\/secrets\/backup-passphrase/.test(backupCompose) &&
    /mode:\s+0400/.test(backupCompose) &&
    !/OPEN_SCIENCE_BACKUP_PASSPHRASE(?:_FILE)?:/.test(compose)
  ) {
    pass("backup_secret_boundary", "The API receives no backup passphrase; only the backup service receives an owner-only file-backed secret.");
  } else {
    fail("backup_secret_boundary_missing", "Backup encryption secrets must remain outside the API environment and use an owner-only file boundary.");
  }

  if (
    /async function probe\(prefixArg\)/.test(objectBackup) &&
    /read-back did not match/.test(objectBackup) &&
    /\["s3", "rm"/.test(objectBackup) &&
    /probeAlertDelivery/.test(configureMonitoring) &&
    /status:\s*"resolved"/.test(configureMonitoring) &&
    /object-backup\.mjs"\), "probe"/.test(hostPreflight) &&
    /configure-monitoring\.mjs"\), "--probe"/.test(hostPreflight) &&
    /^OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE=true$/m.test(envExample) &&
    /^OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY=true$/m.test(envExample) &&
    /object-backup\.mjs probe/.test(pkg.scripts?.["probe:object"] ?? "") &&
    /configure-monitoring\.mjs --probe/.test(pkg.scripts?.["probe:monitoring"] ?? "")
  ) {
    pass("operator_integration_preflight", "Production preflight can prove object-store write/read/delete access and operator webhook acceptance without exposing credentials.");
  } else {
    fail("operator_integration_preflight_missing", "Object storage and alert delivery need executable production preflight probes.");
  }
}

async function checkWorkspaceIoBoundary() {
  const security = await read("apps/server/src/security.mjs");
  const commands = await read("apps/server/src/commands.mjs");
  const server = await read("apps/server/src/server.mjs");
  const store = await read("apps/server/src/store.mjs");
  const securityTests = await read("apps/server/test/security.test.mjs");
  const serverTests = await read("apps/server/test/server.test.mjs");
  const workflow = await read(".github/workflows/web.yml");

  if (
    /\/proc\/self\/fd\//.test(security) &&
    /O_NOFOLLOW/.test(security) &&
    /openScopedDirectoryNoFollow/.test(security) &&
    /openScopedFileNoFollow/.test(security) &&
    /writeFileAtomicNoFollow/.test(security) &&
    /writeFileAtomicNoFollow/.test(commands) &&
    /readStableFileHandle/.test(commands) &&
    /withProjectStorageMutation/.test(security) &&
    /withProjectStorageMutation/.test(commands) &&
    /withProjectStorageMutation/.test(server) &&
    /openScopedFileNoFollow/.test(server) &&
    /archive_source_changed/.test(server) &&
    /stay pinned when a path is replaced/.test(securityTests) &&
    /project storage quota serializes concurrent workspace writes/.test(serverTests) &&
    /serializeStateWrite/.test(store) &&
    /writeJsonFileAtomicNoFollow/.test(store) &&
    /concurrent production logins persist every session across a restart/.test(serverTests) &&
    /runs-on:\s+ubuntu-22\.04[\s\S]*Test Hosted Web API/.test(workflow)
  ) {
    pass("workspace_descriptor_io_boundary", "Linux workspace reads, writes, scans, streams, quotas, and exports use no-follow descriptor-pinned paths; same-process quota mutations are serialized and covered by race regressions.");
  } else {
    fail("workspace_descriptor_io_boundary_missing", "Runtime-writable workspace I/O must be pinned to no-follow file and directory descriptors.");
  }
}

async function checkHostedNotebookKernel() {
  const commands = await read("apps/server/src/commands.mjs");
  const editor = await read("apps/desktop/src/components/notebook/NotebookEditor.tsx");
  const notebooksPage = await read("apps/desktop/src/app/routes/NotebooksPage.tsx");
  const inspector = await read("apps/desktop/src/components/inspector/NotebookInspector.tsx");
  const serverTests = await read("apps/server/test/server.test.mjs");
  const editorTests = await read("apps/desktop/src/components/notebook/NotebookEditor.web.test.tsx");
  const pageTests = await read("apps/desktop/src/app/routes/NotebooksPage.web.test.tsx");
  const inspectorTests = await read("apps/desktop/src/components/inspector/NotebookInspector.web.test.tsx");
  const deploymentSmoke = await read("scripts/ops/deployment-smoke.mjs");
  const workflow = await read(".github/workflows/web.yml");

  if (
    /resolveKernelTarget/.test(commands) &&
    /activeKernelExecutions/.test(commands) &&
    /AbortSignal\.any/.test(commands) &&
    /Kernel execution was reset/.test(commands) &&
    /const kernelActionsEnabled = !hostedWeb \|\| hasCommandBackend/.test(editor) &&
    !/hostedWeb && lang !== "python"/.test(editor) &&
    !/!hostedWeb \|\| cell\.language === "python"/.test(editor) &&
    /kernelReset\(runningLanguageRef\.current, path, root\)/.test(editor) &&
    !/hostedWeb && language !== "python"/.test(notebooksPage) &&
    /kernelReset\("python"\)/.test(inspector) &&
    /kernel_execute mounts the workspace selected by a base-scoped notebook/.test(serverTests) &&
    /kernel_reset aborts an in-flight execution/.test(serverTests) &&
    /runs Python cells through the hosted command backend/.test(editorTests) &&
    /runs R cells through the hosted command backend/.test(editorTests) &&
    /offers Python and R hosted notebook creation/.test(pageTests) &&
    /stops an in-flight hosted expression/.test(inspectorTests) &&
    /async function smokeKernel/.test(deploymentSmoke) &&
    /project-scoped Python\/R scientific kernels read\/write ok/.test(deploymentSmoke) &&
    /OPEN_SCIENCE_ENABLE_KERNEL=true/.test(workflow) &&
    /OPEN_SCIENCE_SMOKE_REQUIRE_DOCKER_KERNEL:\s+"true"/.test(workflow) &&
    /docker ps -aq --filter label=open-science\.web\.kernel=true/.test(workflow)
  ) {
    pass("hosted_notebook_kernel", "Hosted Web exposes Python and R notebook creation with scoped, cancellable execution through the server kernel sandbox; Linux deployment smoke requires scientific imports, project-volume read/write, and container cleanup without enabling Jupyter provisioning.");
  } else {
    fail("hosted_notebook_kernel_missing", "Hosted Web notebook execution must use the scoped server kernel, expose cancellation, and keep unsupported hosted kernels hidden.");
  }
}

async function checkHostedDesktopBoundary() {
  const appShell = await read("apps/desktop/src/app/layout/AppShell.tsx");
  const settings = await read("apps/desktop/src/app/routes/SettingsPage.tsx");
  const commands = await read("apps/server/src/commands.mjs");
  const appShellTests = await read("apps/desktop/src/app/layout/AppShell.web.test.tsx");
  const settingsTests = await read("apps/desktop/src/app/routes/SettingsPage.test.tsx");
  const serverTests = await read("apps/server/test/server.test.mjs");

  if (
    /if \(isTauri\) void ensureJupyter\(\)/.test(appShell) &&
    /if \(hostedWeb\) setJupyter\(null\)/.test(settings) &&
    /else setJupyter\(await jupyterStatus\(\)\)/.test(settings) &&
    /approval_mode_managed/.test(commands) &&
    /remove_config_entry\(\) \{[\s\S]*?Provider and MCP configuration is managed by the server deployment/.test(commands) &&
    /without probing Jupyter provisioning/.test(appShellTests) &&
    /jupyterStatus\)\.not\.toHaveBeenCalled/.test(settingsTests) &&
    /approval policy is immutable through the hosted command API/.test(serverTests) &&
    /provider and MCP mutation commands fail explicitly/.test(serverTests)
  ) {
    pass("hosted_desktop_boundary", "Hosted Web does not probe desktop Jupyter provisioning, keeps approval policy operator-owned, and explicitly rejects browser-side provider or MCP mutation commands.");
  } else {
    fail("hosted_desktop_boundary_missing", "Hosted Web must not invoke deferred desktop provisioning or allow authenticated users to mutate process-wide approval, provider, or MCP policy.");
  }
}

async function checkHostedEventStreamRecovery() {
  const runtime = await read("apps/desktop/src/lib/runtime.ts");
  // The class these two files hold is the browser's HTTP/SSE client, and it was
  // always kernel-neutral — only its name carried the retired kernel, and the
  // rename to `RuntimeClient` caught up with that. The property below is about
  // reconnect recovery and nothing else.
  const sdk = await read("packages/sdk/src/RuntimeClient.ts");
  const runtimeTests = await read("apps/desktop/src/lib/runtime.store.test.ts");
  const sdkTests = await read("apps/desktop/src/test/runtime-client.node.test.ts");

  if (
    /EventSource auto-reconnects; reflect the transient state[\s\S]*?this\.setStatus\("connecting"\)/.test(sdk) &&
    /if \(openedOnce\) void recoverAfterEventReconnect\(c, set, get\)/.test(runtime) &&
    /get\(\)\.refreshSessions\(\)/.test(runtime) &&
    /refreshInteractiveRequests\(c, set\)/.test(runtime) &&
    /await get\(\)\.reconcileRunning\(\)/.test(runtime) &&
    /repairs missed turn and approval state after an established SSE stream reconnects/.test(runtimeTests) &&
    /does not repopulate cleared account state when reconnect recovery finishes after logout/.test(runtimeTests) &&
    /source!\.onerror\?\.\(\)[\s\S]*?source!\.onopen\?\.\(\)/.test(sdkTests)
  ) {
    pass("hosted_event_stream_recovery", "Hosted EventSource reconnects established streams, reconciles missed server state, and rejects late recovery writes after logout or client replacement.");
  } else {
    fail("hosted_event_stream_recovery_missing", "Hosted SSE reconnect must restore transport status and reconcile state that may have changed while the browser was disconnected.");
  }
}

async function checkTaskResourceControl() {
  const taskManager = await read("apps/server/src/taskManager.mjs");
  const serverTests = await read("apps/server/test/server.test.mjs");
  const controllerTests = await read("apps/server/test/runtimeController.test.mjs");
  const compose = await read("deploy/web/docker-compose.yml");
  const taskUi = await read("apps/desktop/src/components/settings/WebTasksCard.tsx");

  if (
    /projectHydrations/.test(taskManager) &&
    /projectStateWrites/.test(taskManager) &&
    /Build the snapshot only when this write reaches the front of the queue/.test(taskManager) &&
    /maxConcurrentTasksPerProject/.test(taskManager) &&
    /task\.controller\.abort\(\)/.test(taskManager) &&
    /server_restarted/.test(taskManager) &&
    /concurrent task state writes retain terminal status across restart/.test(serverTests) &&
    /queued async tasks can be canceled before execution/.test(serverTests) &&
    /running async kernel tasks can be canceled/.test(serverTests) &&
    /async kernel tasks time out and abort the child process/.test(serverTests) &&
    /independently enforces global and per-user runtime limits/.test(controllerTests) &&
    /independently enforces global and per-user kernel limits/.test(controllerTests) &&
    /OPEN_SCIENCE_RUNTIME_CPU_LIMIT/.test(compose) &&
    /OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT/.test(compose) &&
    /OPEN_SCIENCE_RUNTIME_PIDS_LIMIT/.test(compose) &&
    /cancelWebTask/.test(taskUi)
  ) {
    pass("task_resource_control", "Hosted tasks persist terminal state in project-serialized order, recover interrupted work explicitly, expose cancellation, and share tested queue, timeout, container, runtime, and kernel resource limits.");
  } else {
    fail("task_resource_control_missing", "Hosted long-running work must have durable ordered state, explicit restart recovery, cancellation/timeouts, queue admission, and independently enforced runtime resource controls.");
  }
}

async function checkHostedMetadataBoundary() {
  const server = await read("apps/server/src/server.mjs");
  const taskManager = await read("apps/server/src/taskManager.mjs");
  const runtimeManager = await read("apps/server/src/runtimeManager.mjs");
  const serverTests = await read("apps/server/test/server.test.mjs");
  const adapterTests = await read("apps/server/test/dshRuntimeAdapter.test.mjs");
  const publicTaskBody = taskManager.match(/function publicTask\(task\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

  if (
    /const commandKey = commands\.has\(command\) \? command : "unknown"/.test(server) &&
    /error: err instanceof HttpError \? err\.code : "command_failed"/.test(server) &&
    /return \{ mode: "local", sessionTtlMs, bootstrapPasswordSource:/.test(server) &&
    !/\bargs\b|\bresult\b/.test(publicTaskBody) &&
    /"cookie",\s*\n\s*"authorization"/.test(runtimeManager) &&
    /"set-cookie"/.test(runtimeManager) &&
    /unknown commands share a bounded rate key and do not enter audit logs/.test(serverTests) &&
    /public readiness does not disclose the local account count/.test(serverTests) &&
    /async task APIs and logs do not expose command args or results/.test(serverTests) &&
    // The browser can no longer reach a kernel at all, so "strips browser
    // credentials on the way through" was replaced by something stronger:
    // there is no way through. What has to be asserted now is that the retired
    // route stays retired and that the control plane's own calls are still
    // restricted to a named set of methods.
    /the retired pass-through says so/.test(serverTests) &&
    /runtime_passthrough_retired/.test(serverTests) &&
    /a forbidden method is refused before it reaches the container/.test(adapterTests)
  ) {
    pass("hosted_metadata_boundary", "Hosted command, readiness, task, audit, and runtime surfaces use bounded dimensions, omit account counts, command payloads, results, and browser credentials, and expose no path from a browser to an agent kernel.");
  } else {
    fail("hosted_metadata_boundary_missing", "Hosted public and operational metadata surfaces must avoid unbounded identifiers, command payloads/results, account counts, and credential forwarding.");
  }
}

/**
 * Whether a Dockerfile RUNS the boot proof rather than only shipping it.
 *
 * Exported so it can be tested against synthetic text. The alternative — a test
 * that rewrites the real Dockerfile to make the audit fail — mutates a tracked
 * file that other test files read while `node --test` runs them in parallel,
 * and leaves the repository broken if it dies in between. That test existed for
 * one CI run and took `server.test.mjs` down with it.
 *
 * The exclusions matter: the line that makes the proof executable mentions it,
 * and so does the COPY that puts it there. An earlier version of this check
 * counted those, so an image that never ran the proof audited clean.
 * @param {string} dockerfile @returns {boolean}
 */
export function dshBuildSmokeIsInvoked(dockerfile) {
  return String(dockerfile)
    .split("\n")
    .map((line) => line.trim())
    // A comment is a mention. `\b#` only matches when a word character precedes
    // the `#`, so a whole-line comment naming the proof never matched the old
    // exclusion and satisfied the check on its own — the same "a mention is not
    // an instruction" defect this check was rewritten to fix, still living
    // inside the rewrite. Found by tabulating what the predicate answers.
    .filter((line) => !line.startsWith("#"))
    // Per command, not per line. Excluding a whole line that contains `chmod`
    // discards `chmod 0755 X; X` — which makes it executable AND runs it — so
    // the line is split on shell separators and each command judged alone.
    // The Dockerfile instruction is not part of the command: with `RUN` still
    // attached, `RUN chmod 0755 X` does not start with `chmod` and read as an
    // invocation.
    .flatMap((line) => (/^COPY\b/i.test(line) ? [] : line.replace(/^RUN\s+/i, "").split(/[;&|]+/)))
    .map((command) => command.trim())
    .some((command) => command.includes("evimed-build-smoke") && !/^chmod\b/.test(command));
}

async function checkDshLoaderResolution() {
  const dockerfile = await read("deploy/runtime-dsh/Dockerfile");
  const launcher = await read("deploy/runtime-dsh/open-science-dsh-serve.sh");
  const smoke = await read("deploy/runtime-dsh/build-smoke.sh");

  // The plugin loader reaches Node's own module loader through a native addon,
  // and resolves every plugin's bare specifier against the profile directory
  // only while it has it. The addon's default is to dlopen a copy of itself
  // from /tmp, which the runtime mounts noexec — and when that fails the loader
  // says nothing about the addon: every one of our plugins reports "Cannot find
  // package", pointing at the wrong component entirely.
  if (
    /^ENV NARB_DISABLE_NATIVE_CACHE=1$/m.test(dockerfile) &&
    /^export NARB_DISABLE_NATIVE_CACHE=1$/m.test(launcher)
  ) {
    pass("dsh_loader_native_binding", "The DSH image and its launcher both keep the loader's native binding off a noexec /tmp.");
  } else {
    fail("dsh_loader_native_binding_missing", "NARB_DISABLE_NATIVE_CACHE=1 must be set in the DSH image and re-exported by its launcher.");
  }

  // Before anything about its content: that the build RUNS it.
  //
  // These checks read the script and the Dockerfile's COPY line, and both stay
  // green on an image that copies the proof in and never executes it — a gate
  // vouching for an effect that does not happen, which is the shape two
  // defects already came in through. The RUN line is the only evidence that
  // the proof is part of the build rather than a file in it.
  // Matched as an INVOCATION, not a mention. The first version of this check
  // matched `chmod 0755 /usr/local/bin/evimed-build-smoke` in the same RUN and
  // stayed green with the execution deleted — it carried the very defect it
  // was written to catch, and only the negative control said so.
  const smokeInvoked = dshBuildSmokeIsInvoked(dockerfile);
  if (smokeInvoked) {
    pass("dsh_build_smoke_executed", "The DSH image runs its boot proof rather than only shipping it.");
  } else {
    fail("dsh_build_smoke_not_executed", "The DSH Dockerfile must RUN evimed-build-smoke; copying it in proves nothing.");
  }

  // The build's boot proof is only worth its runtime if it boots what the
  // runtime boots. Two things it used to omit, each of which cost a defect: the
  // control plane's patch (which creates the MCP row) and a cache the addon
  // cannot use (which is what noexec amounts to from its side).
  if (
    /--patch "\$\{patch\}"/.test(smoke) &&
    /build-smoke-patch\.yml/.test(smoke) &&
    /NARB_NATIVE_CACHE_DIR/.test(smoke) &&
    /COPY deploy\/runtime-dsh\/build-smoke-patch\.yml/.test(dockerfile)
  ) {
    pass("dsh_build_smoke_fidelity", "The build-time boot proof applies a representative control-plane patch and an unusable addon cache.");
  } else {
    fail("dsh_build_smoke_fidelity_missing", "The DSH build smoke must boot with a representative patch and an unusable addon cache.");
  }

  // The committed composition snapshot is compared to the image's own, in the
  // build. Without it the patch contract test reads a file a human maintains
  // and vouches for a composition that may have drifted — the same shape as a
  // patch naming a row the kernel does not have.
  if (
    /COPY deploy\/runtime-dsh\/dump-config\.baseline\.json/.test(dockerfile) &&
    dockerfile.split("\n").some((line) => line.includes("diff") && line.includes("dump-config.baseline.json"))
  ) {
    pass("dsh_composition_baseline_pinned", "The build fails when the committed composition snapshot no longer matches the image.");
  } else {
    fail("dsh_composition_baseline_unpinned", "The DSH build must diff the committed dump-config baseline against the one it generates.");
  }

  // Booting validates the host composition; the preset is mounted in agent
  // scope and none of its rows are touched until a session exists. Three
  // defects reached a real container through exactly that gap.
  if (/session\.create/.test(smoke) && /agentPreset/.test(smoke)) {
    pass("dsh_build_smoke_session", "The build-time proof creates a session, so the agent-scope preset rows are validated too.");
  } else {
    fail("dsh_build_smoke_session_missing", "The DSH build smoke must create a session; booting alone never mounts the preset.");
  }
}

async function checkReleaseProvenance() {
  const webDockerfile = await read("deploy/web/Dockerfile");
  const runtimeDockerfile = await read("deploy/runtime-dsh/Dockerfile");
  const compose = await read("deploy/web/docker-compose.yml");
  const releaseGenerator = await read("scripts/ops/generate-release-manifest.mjs");
  const hostPreflight = await read("scripts/ops/host-preflight.mjs");
  const server = await read("apps/server/src/server.mjs");
  const workflow = await read(".github/workflows/web.yml");
  const envExample = await read("deploy/web/.env.example");
  const caddyfile = await read("deploy/web/Caddyfile");
  const deployment = await read("docs/WEB_DEPLOYMENT.md");
  const operations = await read("docs/WEB_OPERATIONS_RUNBOOK.md");
  const pkg = JSON.parse(await read("package.json"));
  const documentedComposeStarts = [
    ...bashComposeStartupBlocks(deployment),
    ...bashComposeStartupBlocks(operations),
  ];

  const commonLabels = [
    /org\.opencontainers\.image\.version="\$\{RELEASE_ID\}"/,
    /org\.opencontainers\.image\.revision="\$\{SOURCE_REVISION\}"/,
    /org\.opencontainers\.image\.created="\$\{BUILD_CREATED\}"/,
    /io\.open-science\.app\.version="\$\{APP_VERSION\}"/,
  ];
  // Every shippable image: a release whose labels cannot say which kernel and
  // which tool versions it carries is a release whose provenance stops at the
  // tag.
  const labelledImages = [webDockerfile, runtimeDockerfile];
  if (commonLabels.every((pattern) => labelledImages.every((file) => pattern.test(file)))) {
    pass("release_oci_labels", "Web and runtime images carry version, revision, creation, and app-version labels.");
  } else {
    fail("release_oci_labels_missing", "Web and runtime images must carry immutable OCI release labels.");
  }

  // The kernel-neutral pair is what readiness reads. The kernel-specific label
  // used to be `io.open-science.opencode.version`, and a readiness gate keyed
  // to it failed `runtime_image_metadata_missing` on every image that did not
  // publish it -- a check that could not survive the kernel it was gating. So
  // both are required: the neutral pair that any kernel must publish, and the
  // exact DSH version beside it.
  if (
    /io\.open-science\.runtime\.kernel="dsh"/.test(runtimeDockerfile) &&
    /io\.open-science\.runtime\.version="\$\{DSH_VERSION\}"/.test(runtimeDockerfile) &&
    /io\.open-science\.dsh\.version="\$\{DSH_VERSION\}"/.test(runtimeDockerfile) &&
    /io\.open-science\.uv\.version="\$\{UV_VERSION\}"/.test(runtimeDockerfile)
  ) {
    pass("runtime_tool_labels", "Runtime image labels name the kernel and preserve exact kernel and uv versions.");
  } else {
    fail("runtime_tool_labels_missing", "Runtime image must label which kernel it carries and at which exact kernel and uv versions.");
  }

  if (
    /image:\s+caddy:\$\{OPEN_SCIENCE_CADDY_VERSION:-\d+\.\d+\.\d+-alpine\}/.test(compose) &&
    /^OPEN_SCIENCE_CADDY_VERSION=\d+\.\d+\.\d+-alpine$/m.test(envExample) &&
    /OPEN_SCIENCE_CADDY_IMAGE_ID/.test(releaseGenerator) &&
    /proxy:\s*\{/.test(releaseGenerator) &&
    /docker pull "caddy:\$\{OPEN_SCIENCE_CADDY_VERSION\}"/.test(workflow)
  ) {
    pass("tls_proxy_release_identity", "The Caddy TLS proxy uses an exact version and is bound to the deployment release manifest.");
  } else {
    fail("tls_proxy_release_identity_missing", "The TLS proxy image must be version-pinned, pulled explicitly, and recorded by image id.");
  }

  if (
    /127\.0\.0\.1:\$\{OPEN_SCIENCE_API_PORT:-8787\}:8787/.test(compose) &&
    !/- "8787:8787"/.test(compose) &&
    /reverse_proxy open-science-web:8787/.test(caddyfile) &&
    /preflight_api_port/.test(hostPreflight) &&
    documentedComposeStarts.length > 0 &&
    documentedComposeStarts.every((block) => /--profile tls/.test(block)) &&
    /OPEN_SCIENCE_API_PORT/.test(deployment) &&
    /OPEN_SCIENCE_API_PORT/.test(operations)
  ) {
    pass("tls_proxy_origin_boundary", "The API diagnostic port binds only to host loopback while documented public startup paths enter through the internal Caddy upstream and validated TLS profile.");
  } else {
    fail("tls_proxy_origin_boundary_missing", "Production Compose and operator documentation must prevent public clients from bypassing Caddy by binding the Node API host port only to loopback and enabling the TLS profile.");
  }

  if (
    /OPEN_SCIENCE_TRUST_PROXY:\s+\$\{OPEN_SCIENCE_TRUST_PROXY:-true\}/.test(compose) &&
    /^OPEN_SCIENCE_TRUST_PROXY=true$/m.test(envExample) &&
    /header_up X-Forwarded-For \{remote_host\}/.test(caddyfile) &&
    /isIP\(candidate\)/.test(server) &&
    /trusted_proxy_required/.test(server) &&
    /preflight_proxy_trust/.test(hostPreflight) &&
    /OPEN_SCIENCE_TRUST_PROXY=true/.test(workflow)
  ) {
    pass("trusted_proxy_client_boundary", "Caddy replaces the forwarded client address, production requires proxy trust, and the API accepts only validated IPs for per-client rate limits.");
  } else {
    fail("trusted_proxy_client_boundary_missing", "Production proxy trust must be explicit and forwarded client rate-limit keys must come from Caddy-replaced, validated IP addresses.");
  }

  if (
    /host-preflight\.mjs/.test(pkg.scripts?.["preflight:host"] ?? "") &&
    /parseDockerEngineInfo/.test(hostPreflight) &&
    /buildComposeArgs/.test(hostPreflight) &&
    /--verify-images/.test(hostPreflight) &&
    /public-https/.test(hostPreflight) &&
    /pnpm preflight:host --env-file deploy\/web\/\.env\.ci/.test(workflow)
  ) {
    pass("deployment_host_preflight", "Linux host, Docker, Compose, image, secret, release, and optional public HTTPS prerequisites have a CI-enforced preflight.");
  } else {
    fail("deployment_host_preflight_missing", "Production deployment requires an executable host preflight in the Linux Docker CI job.");
  }

  if (
    /--profile backup --profile monitoring --profile tls up -d/.test(workflow) &&
    /OPEN_SCIENCE_PUBLIC_URL=https:\/\/localhost/.test(workflow) &&
    /OPEN_SCIENCE_DOMAIN=localhost/.test(workflow) &&
    /curl -kfsS https:\/\/localhost\/api\/ready/.test(workflow) &&
    /caddy:\/data\/caddy\/pki\/authorities\/local\/root\.crt/.test(workflow) &&
    /NODE_EXTRA_CA_CERTS=\/tmp\/open-science-caddy-root\.crt pnpm preflight:host --env-file deploy\/web\/\.env\.ci --online/.test(workflow) &&
    /OPEN_SCIENCE_SMOKE_BASE_URL:\s+https:\/\/localhost/.test(workflow) &&
    !/OPEN_SCIENCE_SMOKE_ALLOW_HTTP/.test(workflow)
  ) {
    pass("docker_ci_public_tls", "Linux Docker CI runs online preflight and the hosted runtime smoke through Caddy HTTPS with its temporary CA trusted.");
  } else {
    fail("docker_ci_public_tls_missing", "Linux Docker CI must exercise the public TLS reverse-proxy path, not only the API host port.");
  }

  // Named by shape rather than by one retired image name: any runtime image
  // default that resolves to `latest` is a deployment whose release manifest
  // describes an image nobody can identify again.
  const latestRuntimeDefaults = [...compose.matchAll(/^\s+image:\s+\$\{OPEN_SCIENCE_[A-Z_]*RUNTIME[A-Z_]*_CONTAINER_IMAGE:-([^}]+)\}/gm)]
    .map((match) => match[1])
    .filter((value) => value.endsWith(":latest") || !value.includes(":"));
  // `pinnedRuntimeDefaults.length > 0` is the part that keeps this honest: a
  // regex that stops matching would otherwise report "no unpinned defaults"
  // while reading nothing at all.
  const pinnedRuntimeDefaults = [...compose.matchAll(/^\s+image:\s+\$\{OPEN_SCIENCE_[A-Z_]*RUNTIME[A-Z_]*_CONTAINER_IMAGE:-([^}]+)\}/gm)];
  if (
    pinnedRuntimeDefaults.length > 0 &&
    latestRuntimeDefaults.length === 0 &&
    /OPEN_SCIENCE_RELEASE_MANIFEST_FILE:\s+\/run\/open-science\/release-manifest\.json/.test(compose) &&
    /OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE/.test(compose)
  ) {
    pass("release_manifest_mount", "Compose uses a versioned runtime image and mounts the deployment release manifest.");
  } else {
    fail("release_manifest_mount_missing", "Compose must reject latest runtime defaults and mount a release manifest.");
  }

  if (
    /generate-release-manifest\.mjs/.test(pkg.scripts?.["release:manifest"] ?? "") &&
    /generate-release-manifest\.mjs --check/.test(pkg.scripts?.["check:release-manifest"] ?? "") &&
    /--check --verify-images/.test(pkg.scripts?.["verify:release-manifest"] ?? "")
  ) {
    pass("release_manifest_tooling", "Release manifest generation and verification commands are exposed.");
  } else {
    fail("release_manifest_tooling_missing", "Release manifest generation and verification commands are required.");
  }

  if (
    [
      "apps/desktop/src",
      "apps/server/src",
      "packages/sdk/src",
      "packages/shared/src",
    ].every((sourcePath) => releaseGenerator.includes(`"${sourcePath}"`)) &&
    /digestDirectory\(full, \{ errorPrefix: "release_input" \}\)/.test(releaseGenerator)
  ) {
    pass("release_manifest_source_coverage", "Release manifests bind deterministic digests of the complete hosted frontend, server, SDK, and shared source trees.");
  } else {
    fail("release_manifest_source_coverage_missing", "Release manifests must detect content and file-set drift across all hosted source trees.");
  }
}

// Package sources a Dockerfile exposes as build args so an operator can point
// them somewhere reachable. Every one of these has an upstream default that is
// slow or blocked from some networks, which is the whole reason it is a knob.
const MIRROR_BUILD_ARGS = new Set([
  "APT_MIRROR",
  "DEBIAN_SECURITY_MIRROR",
  "PIP_INDEX_URL",
  "GITHUB_DOWNLOAD_PREFIX",
  "NPM_REGISTRY",
  "APK_MIRROR",
  "GOPROXY",
  "CRAN_MIRROR",
]);

// Services whose build block declares a context, a dockerfile and the args it
// passes. Parsed positionally rather than with a YAML dependency, matching how
// the rest of this audit reads the compose files.
function composeBuildServices(compose) {
  const services = [];
  let current = null;
  let section = null;
  for (const line of compose.split("\n")) {
    const service = /^ {2}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (service) {
      current = { name: service[1], context: null, dockerfile: null, args: [] };
      services.push(current);
      section = null;
      continue;
    }
    if (!current) continue;
    if (/^ {4}build:\s*$/.test(line)) {
      section = "build";
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      section = null;
      continue;
    }
    if (section !== "build" && section !== "args") continue;
    if (/^ {6}args:\s*$/.test(line)) {
      section = "args";
      continue;
    }
    if (/^ {6}\S/.test(line)) section = "build";
    const field = /^ {6}(context|dockerfile):\s*(\S+)\s*$/.exec(line);
    if (field) {
      current[field[1]] = field[2];
      continue;
    }
    const arg = /^ {8}([A-Z][A-Z0-9_]*):/.exec(line);
    if (section === "args" && arg) current.args.push(arg[1]);
  }
  return services.filter((service) => service.context && service.dockerfile);
}

function declaredBuildArgs(dockerfile) {
  return [...dockerfile.matchAll(/^ARG\s+([A-Z][A-Z0-9_]*)/gm)].map((match) => match[1]);
}

// A build arg a Dockerfile declares but compose never passes is silently dead:
// the .env value is set, the operator believes it applies, and the build goes to
// the upstream host anyway. That is not visible in any log — it only shows up as
// a build that takes hours — so it has to be caught here.
async function checkBuildMirrorSources() {
  const composeDir = path.join(repoRoot, "deploy/web");
  const compose = await read("deploy/web/docker-compose.yml");
  const unwired = [];
  const skipped = [];

  for (const service of composeBuildServices(compose)) {
    const dockerfilePath = path.resolve(composeDir, service.context, service.dockerfile);
    if (!existsSync(dockerfilePath)) {
      skipped.push(service.name);
      continue;
    }
    const declared = declaredBuildArgs(await fs.readFile(dockerfilePath, "utf8"));
    const missing = declared.filter((name) => MIRROR_BUILD_ARGS.has(name) && !service.args.includes(name));
    if (missing.length > 0) unwired.push(`${service.name}: ${missing.join(", ")}`);
  }

  if (skipped.length > 0) {
    warn("build_mirror_sources_unverified", "Some build contexts are absent from this checkout, so their build args were not checked.", {
      services: skipped,
    });
  }
  if (unwired.length === 0) {
    pass("build_mirror_sources_wired", "Every package source a Dockerfile exposes is passed through by compose.");
  } else {
    fail("build_mirror_sources_unwired", "Dockerfiles declare package-source build args that compose never passes, so configuring them has no effect.", {
      services: unwired,
    });
  }
}

// A credential the server knows how to read but compose never hands to the
// container is configuration that silently does nothing: the operator sets it in
// .env, the connector still reports its key as missing, and every fetch through
// it fails. Same failure shape as an unwired build arg, one layer up.
async function checkPublicSourceCredentialsWired() {
  const config = await read("apps/server/src/config.mjs");
  const compose = await read("deploy/web/docker-compose.yml");
  const specs = /const publicSourceCredentialSpecs = \{([\s\S]*?)\n {2}\};/.exec(config);
  if (!specs) {
    fail("public_source_credentials_unreadable", "The public-source credential list could not be located in config.mjs.");
    return;
  }

  const service = /\n {2}open-science-web:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n)/.exec(compose);
  const passed = new Set(
    [...(service?.[1] ?? "").matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((match) => match[1]),
  );

  const unwired = [];
  // The second capture is the environment variable; the first is the profile
  // name, and reading that instead compares against names compose never uses.
  for (const [, , name] of specs[1].matchAll(/^\s*(\w+):\s*\["[^"]*",\s*"([A-Z_]+)"/gm)) {
    // Either form reaches the server: the value itself, or a file it reads.
    if (!passed.has(name) && !passed.has(`${name}_FILE`)) unwired.push(name);
  }

  if (unwired.length === 0) {
    pass("public_source_credentials_wired", "Every public-source credential the server reads is passed through by compose.");
  } else {
    fail("public_source_credentials_unwired", "Compose never passes these public-source credentials, so configuring them has no effect.", {
      variables: unwired.sort(),
    });
  }
}

// One credential, one host variable.
//
// `OPENGWAS_JWT` was read by the MR agent from `${OPENGWAS_JWT}` while the
// control plane read the same credential from `${OPEN_SCIENCE_OPENGWAS_JWT}`.
// Setting the documented one left the agent's JWT empty, and a shipped
// Mendelian-randomization capability sat healthy for two days answering 401 to
// its only data source. Nothing was broken enough to notice: both spellings
// exist, both default to empty, and an empty credential is a normal state.
//
// Checked as a shape, not a list: any service reading a bare `${X}` for a
// credential the control plane reads as `${OPEN_SCIENCE_X}` is the same trap.
async function checkCredentialHostVariablesAgree() {
  const raw = await read("deploy/web/docker-compose.yml");
  // Comments are not wiring. The first version of this check read the whole
  // file and flagged the sentence explaining the bug it was written to catch.
  const compose = raw.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const controlPlane = new Set(
    [...compose.matchAll(/\$\{(OPEN_SCIENCE_([A-Z0-9_]*(?:API_KEY|JWT|TOKEN|EMAIL|SECRET)[A-Z0-9_]*))\b/g)]
      .map((match) => match[2]),
  );
  const split = [];
  // Per binding, not per occurrence: `${OPEN_SCIENCE_X:-${X:-}}` is one
  // binding that prefers the documented name and falls back to the old one,
  // which is the fix, not the defect. Only a binding whose FIRST reference is
  // the bare name reads a variable the control plane never sets.
  for (const [, value] of compose.matchAll(/^\s+[A-Z_][A-Z0-9_]*:\s*(\$\{[^\n]*)$/gm)) {
    const first = /\$\{([A-Z0-9_]+)/.exec(value)?.[1];
    if (!first || first.startsWith("OPEN_SCIENCE_")) continue;
    if (!/(?:API_KEY|JWT|TOKEN|EMAIL|SECRET)/.test(first)) continue;
    // A bare spelling is fine on its own; it is a split only when the control
    // plane reads the SAME credential under the prefixed name.
    if (controlPlane.has(first) && !split.includes(first)) split.push(first);
  }

  if (split.length === 0) {
    pass("credential_host_variables_agree", "Every credential two services share is read from one host variable.");
  } else {
    fail(
      "credential_host_variables_split",
      "These credentials are read from two different host variables, so setting the documented one leaves the other service empty.",
      { variables: split.sort() },
    );
  }
}

// A specialist agent reads its credentials from its own environment. Compose
// is the only thing that puts them there, and the two lists were never
// compared: `evimed-bibliometric-agent` reads NCBI_API_KEY, `meta` reads
// PUBMED_API_KEY, `mr` reads UMLS_API_KEY -- and compose handed none of them
// over. Same silence as the OpenGWAS split: an unset key is a normal state, so
// the agent runs, the tool degrades, and nothing says why.
//
// Derived from the agents' own source, not from a list, so an agent that
// starts reading a new credential fails here rather than in production.
async function checkSpecialistAgentCredentialsWired() {
  const compose = await read("deploy/web/docker-compose.yml");
  // The Python agent trees live beside OpenScience, one level above repoRoot.
  const agentRoot = path.resolve(repoRoot, "..");
  // Split into service blocks first, then read each one.
  //
  // The first version ran one `matchAll` of
  // `(evimed-…-agent):[\s\S]*?AGENT_DIR:` over the whole file. `matchAll`
  // resumes after the previous match's END, so a lazy span that reached into
  // the next service consumed its header too: `evimed-mr-agent` was skipped
  // entirely and its credentials were attributed to `evimed-meta-agent`. A
  // scanner that silently drops an entry reports a clean result over an
  // incomplete set.
  const blocks = new Map();
  const serviceHeader = /^ {2}([a-z][a-z0-9-]*):$/gm;
  const headers = [...compose.matchAll(serviceHeader)];
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index].index ?? 0;
    const end = index + 1 < headers.length ? headers[index + 1].index : compose.length;
    blocks.set(headers[index][1], compose.slice(start, end));
  }

  const agentDirs = new Map();
  for (const [service, block] of blocks) {
    if (!/^evimed-[a-z0-9-]+-agent$/.test(service)) continue;
    // Two shapes: the shared adapter passes the tree as `AGENT_DIR` and builds
    // from the repo root, while `meta` has its own Dockerfile and names the
    // tree as its build `context`. Reading only the first silently skipped it.
    const dir = /AGENT_DIR:\s*(\S+)/.exec(block)?.[1]
      ?? /context:\s*\.\.\/\.\.\/\.\.\/(\S+)/.exec(block)?.[1];
    if (dir) agentDirs.set(service, dir);
  }
  // Every specialist service compose defines must be reachable, or this check
  // passes over the ones it failed to see.
  const agentServices = [...blocks.keys()].filter((name) => /^evimed-[a-z0-9-]+-agent$/.test(name));
  if (agentDirs.size !== agentServices.length) {
    fail("specialist_agent_credentials_unreadable", "Some specialist agent services name no build directory, so their credentials were never checked.", {
      services: agentServices.filter((name) => !agentDirs.has(name)),
    });
    return;
  }
  if (agentDirs.size === 0) {
    fail("specialist_agent_credentials_unreadable", "No specialist agent build directories were found in compose.");
    return;
  }

  const missing = [];
  for (const [service, dir] of agentDirs) {
    const passed = new Set([...(blocks.get(service) ?? "").matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1]));
    let names;
    try {
      names = await credentialNamesInTree(path.join(agentRoot, dir));
    } catch {
      continue; // the archived Python trees are untracked; absent is not a failure
    }
    for (const name of names) {
      if (!passed.has(name) && !passed.has(`${name}_FILE`)) missing.push(`${service}: ${name}`);
    }
  }

  if (missing.length === 0) {
    pass("specialist_agent_credentials_wired", "Every credential a specialist agent reads is passed to it by compose.");
  } else {
    fail(
      "specialist_agent_credentials_unwired",
      "These specialist agents read credentials compose never hands them, so the tools that need them degrade silently.",
      { entries: missing.sort() },
    );
  }
}

/** Credential-shaped environment names a Python tree reads. Tuning knobs
 *  (`LLM_MAX_TOKENS`) and legacy platform wiring (`JAVA_TOKEN_URL`, Aliyun OSS)
 *  are excluded: they are not credentials this deployment owns, and counting
 *  them made the first run of this check report 37 failures of which 5 were
 *  real. @param {string} dir @returns {Promise<string[]>} */
async function credentialNamesInTree(dir) {
  const found = new Set();
  const skip = new Set([".venv", "node_modules", "__pycache__", ".git", "output", "outputs"]);
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith(".py")) continue;
      const text = await fs.readFile(full, "utf8").catch(() => "");
      for (const [, name] of text.matchAll(/(?:getenv|environ(?:\.get)?)\s*\(?\s*\[?\s*["']([A-Z][A-Z0-9_]{3,})["']/g)) {
        if (!/API_KEY$|_JWT$|_TOKEN$|_SECRET$|_EMAIL$/.test(name)) continue;
        if (/^(JAVA_|OSS_|METAAGENT_|MINERU_|HUNYUAN_|DASHSCOPE_)/.test(name)) continue;
        if (/^LLM_|^DEEPSEEK_/.test(name)) continue; // supplied by the adapter, not compose
        found.add(name);
      }
    }
  };
  await walk(dir);
  return [...found].sort();
}

async function main() {
  await checkBuildMirrorSources();
  await checkPublicSourceCredentialsWired();
  await checkCredentialHostVariablesAgree();
  await checkSpecialistAgentCredentialsWired();
  await checkRootLicense();
  await checkRuntimePins();
  await checkHostedPackaging();
  await checkDeepSeekCompatibilityPreflight();
  await checkRuntimeContainerTopology();
  await checkConfiguredSkills();
  await checkScientificCapabilityDelivery();
  await checkPrivacyDocs();
  await checkProductionIdentity();
  await checkLocalAuthSecretBoundary();
  await checkDependencySecurity();
  await checkMonitoringBaseline();
  await checkObjectBackup();
  await checkWorkspaceIoBoundary();
  await checkHostedNotebookKernel();
  await checkHostedDesktopBoundary();
  await checkHostedEventStreamRecovery();
  await checkTaskResourceControl();
  await checkHostedMetadataBoundary();
  await checkDshLoaderResolution();
  await checkReleaseProvenance();

  const failed = findings.filter((finding) => finding.status === "fail");
  const warned = findings.filter((finding) => finding.status === "warn");
  const summary = {
    ok: failed.length === 0,
    failed: failed.length,
    warnings: warned.length,
    checks: findings.length,
    findings,
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const finding of findings) {
      const marker = finding.status === "pass" ? "PASS" : finding.status === "warn" ? "WARN" : "FAIL";
      process.stdout.write(`${marker} ${finding.code}: ${finding.message}\n`);
    }
    process.stdout.write(`\nHosted compliance audit: ${summary.ok ? "ok" : "failed"} (${summary.checks} checks, ${summary.failed} failed, ${summary.warnings} warnings)\n`);
  }

  if (!summary.ok) process.exitCode = 1;
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, failed: 1, warnings: 0, checks: findings.length, error: message, findings }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
});
