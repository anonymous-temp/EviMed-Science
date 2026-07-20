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
  const dockerfile = await read("deploy/runtime-opencode/Dockerfile");
  const workflow = await read(".github/workflows/web.yml");
  const opencode = dockerfile.match(/^ARG OPENCODE_VERSION=([^\s]+)/m)?.[1] ?? "";
  const uv = dockerfile.match(/^ARG UV_VERSION=([^\s]+)/m)?.[1] ?? "";
  if (!opencode || opencode === "latest") {
    fail("opencode_version_unpinned", "Hosted OpenCode runtime image must pin OPENCODE_VERSION.");
  } else {
    pass("opencode_version_pinned", "Hosted OpenCode runtime pins OPENCODE_VERSION.", { version: opencode });
  }
  if (!uv || uv === "latest") {
    fail("uv_version_unpinned", "Hosted runtime image must pin UV_VERSION.");
  } else {
    pass("uv_version_pinned", "Hosted runtime image pins UV_VERSION.", { version: uv });
  }

  const compose = await read("deploy/web/docker-compose.yml");
  if (/OPENCODE_VERSION:\s+\$\{OPEN_SCIENCE_OPENCODE_VERSION:-[^}]+\}/.test(compose)) {
    pass("compose_runtime_version_arg", "Compose exposes the pinned OpenCode image version arg.");
  } else {
    fail("compose_runtime_version_arg_missing", "Compose must expose OPEN_SCIENCE_OPENCODE_VERSION.");
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

  const digestArgs = [
    "OPENCODE_SHA256_AMD64",
    "OPENCODE_SHA256_ARM64",
    "UV_SHA256_AMD64",
    "UV_SHA256_ARM64",
  ];
  if (
    digestArgs.every((name) => new RegExp(`^ARG ${name}=[a-f0-9]{64}$`, "m").test(dockerfile)) &&
    digestArgs.every((name) => new RegExp(`${name}:\\s+\\$\\{OPEN_SCIENCE_${name}:-[a-f0-9]{64}\\}`).test(compose)) &&
    (dockerfile.match(/sha256sum -c -/g) ?? []).length >= 2
  ) {
    pass("runtime_release_asset_integrity", "OpenCode and uv release archives are bound to architecture-specific SHA-256 digests before extraction.");
  } else {
    fail("runtime_release_asset_integrity_missing", "Runtime release archives must be verified against pinned architecture-specific SHA-256 digests.");
  }

  if (
    /^ARG OPENCODE_LICENSE_SHA256=[a-f0-9]{64}$/m.test(dockerfile) &&
    /^ARG UV_LICENSE_MIT_SHA256=[a-f0-9]{64}$/m.test(dockerfile) &&
    /opencode\/v\$\{OPENCODE_VERSION\}\/LICENSE/.test(dockerfile) &&
    /uv\/\$\{UV_VERSION\}\/LICENSE-MIT/.test(dockerfile) &&
    /\/usr\/share\/licenses\/opencode\/LICENSE/.test(dockerfile) &&
    /\/usr\/share\/licenses\/uv\/LICENSE-MIT/.test(dockerfile) &&
    /Verify runtime binaries and preserved licenses/.test(workflow) &&
    /docker run --rm --network none/.test(workflow) &&
    (dockerfile.match(/sha256sum -c -/g) ?? []).length >= 4
  ) {
    pass("runtime_license_notices", "The runtime image verifies and preserves the pinned OpenCode and uv license texts.");
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
  const releaseGate = await read("scripts/ops/deepseek-opencode-release-gate.mjs");
  const workflow = await read(".github/workflows/web.yml");
  const hostPreflight = await read("scripts/ops/host-preflight.mjs");
  const server = await read("apps/server/src/server.mjs");
  const modelGateway = await read("apps/server/src/modelGateway.mjs");
  const config = await read("apps/server/src/config.mjs");
  const operations = await read("docs/WEB_OPERATIONS_RUNBOOK.md");
  const privacy = await read("docs/WEB_PRIVACY_AND_COMPLIANCE.md");
  if (
    pkg.scripts?.["preflight:deepseek"] === "node scripts/ops/deepseek-compatibility-preflight.mjs" &&
    pkg.scripts?.["preflight:deepseek:release"] === "node scripts/ops/deepseek-opencode-release-gate.mjs" &&
    /OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE/.test(script) &&
    !/OPEN_SCIENCE_DEEPSEEK_API_KEY(?:[^_]|$)/.test(script) &&
    /REQUIRED_OPENCODE_VERSION = "1\.17\.13"/.test(releaseGate) &&
    /syncRuntimeModelProvider/.test(releaseGate) &&
    /createHmac/.test(releaseGate) &&
    /timingSafeEqual/.test(releaseGate) &&
    /MAX_RECEIPT_FUTURE_MS/.test(releaseGate) &&
    /runBoundedProcess/.test(releaseGate) &&
    /SIGKILL/.test(releaseGate) &&
    /test\/deepseekCompatibility\.test\.mjs/.test(workflow) &&
    /test\/deepseekOpenCodeReleaseGate\.test\.mjs/.test(workflow) &&
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
    pass("deepseek_compatibility_preflight", "File-keyed DeepSeek and pinned OpenCode release gates are runnable, fake-chain tested, HMAC/freshness-bound, response-bounded, and do not make live CI calls.");
  } else {
    fail("deepseek_compatibility_preflight_missing", "DeepSeek compatibility tooling must be file-keyed, runnable, preflight-checked, and fake-provider tested.");
  }
}

async function checkRuntimeContainerTopology() {
  const compose = await read("deploy/web/docker-compose.yml");
  const workflow = await read(".github/workflows/web.yml");
  const envExample = await read("deploy/web/.env.example");
  const hostPreflight = await read("scripts/ops/host-preflight.mjs");
  const mounts = await read("apps/server/src/dockerMounts.mjs");
  const commands = await read("apps/server/src/commands.mjs");
  const manager = await read("apps/server/src/runtimeManager.mjs");
  const controller = await read("apps/server/src/runtimeControllerServer.mjs");
  const runtimeDockerfile = await read("deploy/runtime-opencode/Dockerfile");
  const launcher = await read("deploy/runtime-opencode/open-science-opencode-serve.sh");
  const controllerStart = compose.indexOf("\n  open-science-runtime-controller:\n    image:");
  const runtimeImageStart = compose.indexOf("\n  opencode-runtime-image:");
  const webService = compose.slice(
    compose.indexOf("  open-science-web:"),
    controllerStart,
  );
  const controllerService = compose.slice(
    controllerStart,
    runtimeImageStart,
  );

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
    /buildOpenCodeLaunchPlan\(config, project, port, password\)/.test(controller) &&
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

  if (
    /OPEN_SCIENCE_RUNTIME_TRANSPORT:\s+\$\{OPEN_SCIENCE_RUNTIME_TRANSPORT:-unix\}/.test(compose) &&
    /requestRuntime\(runtime/.test(manager) &&
    /\bsocat\b/.test(runtimeDockerfile) &&
    /UNIX-LISTEN:\$\{socket\}/.test(launcher) &&
    /opencode serve --hostname 127\.0\.0\.1/.test(launcher)
  ) {
    pass("runtime_unix_socket_transport", "OpenCode HTTP/SSE uses a project-scoped Unix socket across sibling containers.");
  } else {
    fail("runtime_unix_socket_transport_missing", "Hosted OpenCode must not rely on the API container's localhost to reach a sibling container.");
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
  const runtimeDockerfile = await read("deploy/runtime-opencode/Dockerfile");
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
    executableDependencies.every((dependency) => runtimeDockerfile.includes(dependency)) &&
    /pypdf==6\.7\.0/.test(runtimeDockerfile) &&
    /openpyxl==3\.1\.5/.test(runtimeDockerfile) &&
    /ENV VIRTUAL_ENV=\/opt\/evimed\/venv/.test(runtimeDockerfile) &&
    /uv venv "\$\{VIRTUAL_ENV\}" --python \/usr\/bin\/python3/.test(runtimeDockerfile) &&
    /uv pip install --python "\$\{VIRTUAL_ENV\}\/bin\/python"/.test(runtimeDockerfile) &&
    !/uv pip install --system/.test(runtimeDockerfile) &&
    /runtimeSkillDelivery\(sourceRoot\)/.test(runtimeManager) &&
    /delivery\.executable/.test(runtimeManager) &&
    /all 38 curated scientific skills have an executable, dependency-pinned, smoke-tested delivery contract/.test(skillTests) &&
    /Smoke every shared curated-skill implementation in the production dependency image/.test(runtimeDockerfile) &&
    /len\(shared\) != 36/.test(runtimeDockerfile)
  ) {
    pass("curated_skill_delivery_contract", "All 38 curated scientific skills have executable entrypoints, pinned runtime dependencies, artifact contracts, and production-image smoke coverage.", {
      inventoried: inventoried.length,
      executable: executable.length,
      conditional: conditional.length,
      instructionOnly: instructionOnly.length,
    });
  } else {
    fail("curated_skill_delivery_contract_missing", "Curated skills need an exhaustive delivery tier, executable entrypoints, pinned dependencies, runtime filtering, and independent contract tests.");
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
    /runtime\/skills\/office/.test(runtimeDockerfile) &&
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
  if (
    connectors.every((connector) => runtimeManager.includes(`"${connector}"`) && connectorSource.includes(`"${connector}"`)) &&
    connectors.every((connector) => runtimeManager.includes(`science-${connector}`) || /`science-\$\{connector\}`/.test(runtimeManager)) &&
    gatewayHosts.every((host) => publicGateway.includes(`"${host}"`)) &&
    /x-api-key/.test(publicGateway) &&
    /OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_FILE:\s*\/run\/secrets\/materials-project-api-key/.test(compose) &&
    /OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_HOST_FILE:\?/.test(compose) &&
    /pnpm test:mcp/.test(workflow) &&
    (connectorTests.match(/^\s+def test_/gm) ?? []).length >= 7
  ) {
    pass("hosted_science_connector_chain", "Hosted runtime registers seven independent MCP connectors through a fixed-host server gateway with a file-only Materials Project secret and CI protocol tests.", {
      connectors: connectors.length,
    });
  } else {
    fail("hosted_science_connector_chain_missing", "All seven science connectors need default runtime registration, fixed-host gateway routes, protected Materials credentials, and independent CI tests.");
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
    [deployment, "Real model use requires configuring a server-managed OpenCode profile", "deployment_model_key_boundary"],
    [readiness, "Office skills", "readiness_office_boundary"],
  ];
  for (const [text, phrase, code] of required) {
    if (text.includes(phrase)) pass(code, `Documentation includes ${phrase}.`);
    else fail(`${code}_missing`, `Documentation must include ${phrase}.`);
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
  const sdk = await read("packages/sdk/src/OpenCodeClient.ts");
  const runtimeTests = await read("apps/desktop/src/lib/runtime.store.test.ts");
  const sdkTests = await read("apps/desktop/src/test/opencode-client.node.test.ts");

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
    /OpenCode proxy rewrites workspace directory and strips browser credentials/.test(serverTests)
  ) {
    pass("hosted_metadata_boundary", "Hosted command, readiness, task, audit, and runtime-proxy surfaces use bounded dimensions and omit account counts, command payloads, results, and browser credentials.");
  } else {
    fail("hosted_metadata_boundary_missing", "Hosted public and operational metadata surfaces must avoid unbounded identifiers, command payloads/results, account counts, and credential forwarding.");
  }
}

async function checkReleaseProvenance() {
  const webDockerfile = await read("deploy/web/Dockerfile");
  const runtimeDockerfile = await read("deploy/runtime-opencode/Dockerfile");
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
  if (commonLabels.every((pattern) => pattern.test(webDockerfile) && pattern.test(runtimeDockerfile))) {
    pass("release_oci_labels", "Web and runtime images carry version, revision, creation, and app-version labels.");
  } else {
    fail("release_oci_labels_missing", "Web and runtime images must carry immutable OCI release labels.");
  }

  if (
    /io\.open-science\.opencode\.version="\$\{OPENCODE_VERSION\}"/.test(runtimeDockerfile) &&
    /io\.open-science\.uv\.version="\$\{UV_VERSION\}"/.test(runtimeDockerfile)
  ) {
    pass("runtime_tool_labels", "Runtime image labels preserve exact OpenCode and uv versions.");
  } else {
    fail("runtime_tool_labels_missing", "Runtime image must label exact OpenCode and uv versions.");
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

  if (
    !/open-science-opencode:latest/.test(compose) &&
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

async function main() {
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
