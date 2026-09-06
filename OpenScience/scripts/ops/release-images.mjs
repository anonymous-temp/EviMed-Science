#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SERVING_FLOOR_BYTES = 5 * 1024 ** 3;
const BUILDER = "colima-evimed-builder";
const PROFILE = "evimed-builder";
const BUILDER_DIR = path.join(os.homedir(), ".colima", PROFILE);
const BUILDER_ENDPOINT = `unix://${path.join(BUILDER_DIR, "docker.sock")}`;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const BUILD_ROLES = ["host-source", "host-builder", "host-tmp", "engine-root", "engine-docker", "engine-containerd", "engine-tmp"];
const PULL_ROLES = ["engine-root", "engine-docker", "engine-containerd", "engine-tmp"];

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function requireValue(condition, code, message) { if (!condition) throw fail(code, message); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function hash(body) { return `sha256:${createHash("sha256").update(body).digest("hex")}`; }
function safeEnv() {
  // Do not inherit alternate daemon/buildkit selectors, credentials or debug flags.
  return Object.fromEntries(["PATH", "HOME", "DOCKER_CONFIG", "SSH_AUTH_SOCK", "TMPDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}
function executeRead(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: safeEnv(), encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] });
  requireValue(!result.error && result.status === 0, "release_probe_failed", "A bounded release identity or filesystem probe failed.");
  return result.stdout.trim();
}
function readFile(file) {
  requireValue(typeof file === "string" && path.isAbsolute(file), "release_metadata_invalid", "Evidence and input paths must be absolute.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireValue(stat.isFile() && stat.size <= 2 * 1024 ** 2, "release_metadata_invalid", "Evidence must be a bounded regular file.");
    // The file can grow after fstat. Read at most the limit plus one byte, not
    // until an unbounded EOF; O_NONBLOCK also makes FIFO rejection immediate.
    const buffer = Buffer.alloc(2 * 1024 ** 2 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    requireValue(bytes < buffer.length, "release_metadata_invalid", "Evidence exceeded the bounded file size.");
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}
function artifact(ref, json = true) {
  requireValue(ref && SHA256.test(ref.sha256), "release_metadata_missing", "A digest-bound evidence or input file is required.");
  const body = readFile(ref.file);
  requireValue(hash(body) === ref.sha256, "release_metadata_digest", "Evidence or build input changed after measurement.");
  return json ? JSON.parse(body.toString("utf8")) : body.toString("utf8");
}
function imageInfo(output) {
  const values = JSON.parse(output);
  requireValue(Array.isArray(values) && values.length === 1, "release_image_invalid", "Expected exactly one inspected image.");
  return values[0];
}

function assertIsolatedBuilderTarget(target, platform, hostName) {
  requireValue(target && target.hostName === hostName && typeof target.engineId === "string" && target.engineId
    && typeof target.engineName === "string" && target.engineName, "release_target_invalid", "The recorded host and engine identities are required.");
  requireValue(platform === "darwin" && target.context === BUILDER && target.endpoint === BUILDER_ENDPOINT
    && target.hostName !== target.servingHostName && typeof target.servingHostName === "string" && target.servingHostName,
  "release_builder_forbidden", "Builds require the isolated colima-evimed-builder endpoint on its recorded non-serving host.");
}

function verifyCleanSource(plan, execute) {
  requireValue(execute("git", ["--no-replace-objects", "rev-parse", "HEAD"], plan.sourceRoot) === plan.sourceRevision
    && execute("git", ["--no-replace-objects", "rev-parse", "HEAD^{tree}"], plan.sourceRoot) === plan.sourceTree
    && execute("git", ["--no-replace-objects", "status", "--porcelain", "--untracked-files=all", "--ignored"], plan.sourceRoot) === "",
  "release_source_changed", "The build needs its exact clean, immutable checkout, without ignored or untracked context inputs.");
}

function inspectReleaseEngine(target, execute) {
  const engine = JSON.parse(execute("docker", ["--host", target.endpoint, "info", "--format", "{{json .}}"]));
  requireValue(engine.ID === target.engineId && engine.Name === target.engineName && engine.OSType === "linux"
    && typeof engine.DockerRootDir === "string" && path.posix.isAbsolute(engine.DockerRootDir),
  "release_engine_changed", "The live Docker engine does not match the recorded operation target.");
  return engine;
}

function inspectBuildBase(plan, execute) {
  const docker = ["--host", plan.target.endpoint];
  const base = imageInfo(execute("docker", [...docker, "image", "inspect", plan.base.reference]));
  requireValue(base.Id === plan.base.imageId && base.Os === "linux" && base.Architecture === "amd64" && base.RepoDigests?.includes(plan.base.reference) && Array.isArray(base.RootFS?.Layers) && base.RootFS.Layers.length > 0 && !base.Config?.OnBuild?.length, "release_base_unverified", "The installed base does not match its manifest, local identity or platform.");
  requireValue(execute("docker", [...docker, "image", "ls", "--quiet", "--no-trunc", plan.image]) === "", "release_tag_exists", "The candidate tag already exists; preserve existing and rollback references and choose a new tag.");
  const builder = JSON.parse(execute("docker", [...docker, "buildx", "inspect", BUILDER, "--format", "{{json .}}"]));
  requireValue(builder.Driver === "docker" && builder.Nodes?.length === 1 && [BUILDER, BUILDER_ENDPOINT].includes(builder.Nodes[0].Endpoint), "release_builder_changed", "Buildx must use the verified single-node Docker driver on the isolated endpoint.");
  return base;
}

function assertBuilderContext(execute) {
  requireValue(execute("docker", ["context", "inspect", BUILDER, "--format", "{{.Endpoints.docker.Host}}"]) === BUILDER_ENDPOINT,
    "release_endpoint_changed", "The isolated context no longer resolves to its recorded endpoint.");
}

function verifyBuiltImage(plan, base, result, metadata) {
  requireValue(result.Os === "linux" && result.Architecture === "amd64"
    && result.Config?.Labels?.["org.opencontainers.image.revision"] === plan.sourceRevision,
  "release_result_invalid", "The resulting image does not match the release platform and source.");
  requireValue(SHA256.test(metadata["containerimage.config.digest"]) && SHA256.test(metadata["containerimage.digest"]) && result.Id !== base.Id && result.RootFS?.Layers?.length > base.RootFS.Layers.length && base.RootFS.Layers.every((layer, index) => result.RootFS.Layers[index] === layer), "release_result_invalid", "BuildKit output must identify an actual new layer over the verified base; retag-only results are refused.");
  const manifestDigest = metadata["containerimage.digest"];
  const configDigest = metadata["containerimage.config.digest"];
  const descriptor = metadata["containerimage.descriptor"];
  requireValue((!descriptor || descriptor.digest === manifestDigest) && (result.Id === configDigest || result.Descriptor?.digest === manifestDigest || result.RepoDigests?.some((reference) => reference.endsWith(`@${manifestDigest}`))), "release_result_invalid", "The daemon result must link to the native BuildKit export descriptor or classic config ID.");
  return { manifestDigest, configDigest };
}

// Free capacity is counted once per filesystem. Independent write footprints
// on that filesystem are added, with one floor and one explicit growth reserve.
export function aggregateCapacity(samples, peaks, floorBytes, growthReserveBytes, admission = true) {
  const floorOnly = peaks === null && admission === false;
  requireValue(Array.isArray(samples) && samples.length > 0 && positive(floorBytes) && positive(growthReserveBytes), "release_budget_invalid", "A finite capacity floor and explicit growth reserve are required.");
  const seen = new Set();
  const groups = new Map();
  for (const sample of samples) {
    requireValue(typeof sample.role === "string" && !seen.has(sample.role) && typeof sample.filesystem === "string" && sample.filesystem && Number.isSafeInteger(sample.availableBytes) && sample.availableBytes >= 0 && (floorOnly || positive(peaks[sample.role])), "release_budget_invalid", "Every distinct storage plane requires measured peak bytes and a live filesystem sample.");
    seen.add(sample.role);
    const group = groups.get(sample.filesystem) ?? { filesystem: sample.filesystem, availableBytes: sample.availableBytes, peakBytes: 0, roles: [] };
    group.availableBytes = Math.min(group.availableBytes, sample.availableBytes);
    group.peakBytes += floorOnly ? 0 : peaks[sample.role];
    group.roles.push(sample.role);
    groups.set(sample.filesystem, group);
  }
  requireValue(floorOnly || (Object.keys(peaks).length === seen.size && Object.keys(peaks).every((role) => seen.has(role))), "release_budget_invalid", "Measured and observed storage planes must agree exactly.");
  return [...groups.values()].map((group) => {
    const reserveBytes = Math.max(floorBytes, SERVING_FLOOR_BYTES) + growthReserveBytes;
    const requiredBytes = reserveBytes + (admission ? group.peakBytes : 0);
    requireValue(Number.isSafeInteger(requiredBytes), "release_budget_invalid", "Capacity budget overflowed.");
    requireValue(group.availableBytes >= requiredBytes, "release_capacity_insufficient", "Storage cannot retain the serving floor, operation peak and explicit growth reserve.");
    return { ...group, requiredBytes, reserveBytes };
  });
}

function validatePlan(plan, platform, hostName) {
  requireValue(plan && ["build", "pull"].includes(plan.operation), "release_operation_invalid", "Only isolated build and digest pull operations are supported.");
  requireValue(["web", "runtime"].includes(plan.component), "release_component_invalid", "Only the reviewed Web and runtime release components are supported.");
  requireValue(plan.platform === "linux/amd64" && REVISION.test(plan.sourceRevision), "release_platform_invalid", "An immutable source revision and verified linux/amd64 target are required.");
  requireValue(positive(plan.floorBytes) && positive(plan.growthReserveBytes), "release_budget_invalid", "Explicit positive floor and growth reserve bytes are required.");
  const target = plan.target;
  requireValue(target && typeof target.engineId === "string" && target.engineId.length > 0 && typeof target.engineName === "string" && target.engineName.length > 0 && target.hostName === hostName, "release_target_invalid", "The recorded host and engine identities are required.");
  if (plan.operation === "build") {
    assertIsolatedBuilderTarget(target, platform, hostName);
    requireValue(PINNED_IMAGE.test(plan.base?.reference) && SHA256.test(plan.base?.imageId), "release_base_unverified", "The verified base must include a manifest digest and daemon-local image ID.");
    requireValue(REVISION.test(plan.sourceTree) && typeof plan.sourceRoot === "string" && path.isAbsolute(plan.sourceRoot) && Array.isArray(plan.inputs) && plan.inputs.length > 0, "release_source_invalid", "A clean source tree and hashed dependency inputs are required.");
    requireValue(/^[a-z0-9][a-z0-9/._-]*:[a-z0-9][a-z0-9._-]*$/.test(plan.image) && !/:(?:latest|current|rollback)$/.test(plan.image), "release_image_invalid", "Use a new explicit local release tag.");
    requireValue(typeof plan.metadataFile === "string" && path.isAbsolute(plan.metadataFile) && !fs.lstatSync(plan.metadataFile, { throwIfNoEntry: false }), "release_metadata_invalid", "BuildKit metadata requires a new absolute output file, including no dangling link.");
    const smoke = artifact(plan.platformSmoke);
    requireValue(smoke.endpoint === target.endpoint && smoke.engineId === target.engineId && smoke.platform === plan.platform && smoke.baseReference === plan.base.reference && smoke.nodeVersion === "v22.22.0" && smoke.nodeExitCode === 0 && smoke.buildRunExitCode === 0, "release_platform_unverified", "A recorded successful Node process and Dockerfile RUN for this endpoint, base and target platform are required; advertised platforms are not evidence.");
    artifact(plan.dockerfile, false);
    requireValue(plan.base.dependencyInputs && Object.keys(plan.base.dependencyInputs).length === plan.inputs.length, "release_dependency_changed", "The verified base must record every dependency input.");
    for (const input of plan.inputs) artifact(input, false);
  } else {
    requireValue(platform === "linux" && target.endpoint === "unix:///var/run/docker.sock" && target.context == null, "release_pull_target_invalid", "Digest transfer must run locally on the recorded serving Docker host.");
    requireValue(/^127\.0\.0\.1:[1-9]\d{0,4}\/[a-z0-9][a-z0-9/._-]*@sha256:[a-f0-9]{64}$/.test(plan.image) && Number(plan.image.split(":")[1].split("/")[0]) <= 65535, "release_registry_invalid", "Transfer requires a manifest-digest-pinned image from an existing loopback registry forward.");
    const transfer = artifact(plan.transferEvidence);
    requireValue(PINNED_IMAGE.test(transfer.registryImage) && /(?:^|\/)registry@/.test(transfer.registryImage) && transfer.bindAddress === "127.0.0.1" && transfer.forwardBindAddress === "127.0.0.1" && transfer.reverseForwardVerified === true && transfer.image === plan.image && transfer.sourceRevision === plan.sourceRevision && transfer.engineId === target.engineId, "release_registry_unverified", "Digest-pinned Distribution registry and verified SSH loopback forwarding evidence are required.");
    const smoke = artifact(plan.releaseSmoke);
    requireValue(smoke.sourceRevision === plan.sourceRevision && smoke.configDigest === plan.configDigest && smoke.originalSmokePassed === true && smoke.rootFsPrefixVerified === true && (plan.component === "web" || (smoke.profileSeedCopiesVerified === true && smoke.resealed === true)), "release_smoke_unverified", "The exact candidate needs original smoke, actual profile seed-copy, reseal and base-prefix evidence before transfer.");
    requireValue(SHA256.test(plan.configDigest), "release_image_invalid", "The expected config/image digest is required.");
  }
  const measurement = artifact(plan.measurement);
  requireValue(measurement.operation === plan.operation && measurement.sourceRevision === plan.sourceRevision && measurement.engineId === target.engineId && measurement.peaks && typeof measurement.peaks === "object", "release_budget_invalid", "Peak measurements must bind this operation, revision and engine.");
  requireValue(measurement.platform === plan.platform && measurement.component === plan.component && (plan.operation === "build"
    ? measurement.recipeSha256 === plan.dockerfile.sha256 && measurement.baseReference === plan.base.reference && JSON.stringify(measurement.dependencyInputs) === JSON.stringify(plan.base.dependencyInputs)
    : measurement.image === plan.image && measurement.configDigest === plan.configDigest), "release_budget_invalid", "Peak evidence must identify the exact recipe/base/dependencies or transfer manifest/config, and target platform.");
  const roles = plan.operation === "build" ? BUILD_ROLES : PULL_ROLES;
  requireValue(Object.keys(measurement.peaks).length === roles.length && roles.every((role) => positive(measurement.peaks[role])), "release_budget_invalid", "Measure every host, Docker, containerd and temporary storage plane before the operation.");
  return measurement.peaks;
}

function verifySource(plan, execute) {
  verifyCleanSource(plan, execute);
  const root = fs.realpathSync(plan.sourceRoot);
  const relativeInput = (file) => {
    const relative = path.relative(root, fs.realpathSync(file));
    requireValue(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "release_source_invalid", "Every build input must be inside the verified context.");
    return relative.split(path.sep).join("/");
  };
  relativeInput(plan.dockerfile.file);
  const inputs = new Map();
  for (const input of plan.inputs) {
    const relative = relativeInput(input.file);
    requireValue(!inputs.has(relative), "release_dependency_changed", "Canonical dependency input paths must be unique.");
    inputs.set(relative, input.sha256);
  }
  requireValue(plan.base.dependencyInputs && Object.keys(plan.base.dependencyInputs).length === inputs.size && Object.keys(plan.base.dependencyInputs).every((key) => inputs.has(key)), "release_dependency_changed", "The base and candidate must contain exactly the same canonical dependency input paths.");
  for (const [relative, digest] of inputs) requireValue(plan.base.dependencyInputs[relative] === digest, "release_dependency_changed", "Dependencies changed; a dependency-preserving delta is not admissible.");
  validateRecipe(artifact(plan.dockerfile, false), plan.base.reference);
}

// This deliberately supports a small recipe grammar, not all Dockerfile
// frontends. Every instruction is consumed so an unsupported FROM/flag cannot
// disappear from a regex match while BuildKit still fetches its external image.
function validateRecipe(dockerfile, baseReference) {
  const invalid = (condition) => requireValue(condition, "release_delta_invalid", "Use one literal verified FROM, local COPY and fixed RUN instructions; external resources and unsupported recipe syntax are refused.");
  invalid(!/[\0\uFEFF]/.test(dockerfile));
  const lines = [];
  let continued = "";
  for (const physical of dockerfile.split(/\r?\n/)) {
    const line = physical.trim();
    invalid(!physical.includes("\r"));
    if (line.startsWith("#")) {
      invalid(!/^#\s*(?:syntax|escape|check)\s*=/i.test(line));
      continue;
    }
    if (!line) continue;
    if (line.endsWith("\\")) {
      invalid(!line.endsWith("\\\\"));
      continued += `${line.slice(0, -1)} `;
    } else {
      lines.push(continued + line);
      continued = "";
    }
  }
  invalid(!continued);
  let fromCount = 0;
  let copyCount = 0;
  const metadataInstructions = new Set(["WORKDIR", "USER", "ENV", "LABEL", "ENTRYPOINT", "CMD", "SHELL", "EXPOSE", "STOPSIGNAL", "HEALTHCHECK"]);
  for (const [index, line] of lines.entries()) {
    const match = /^([a-z]+)[ \t]+(.+)$/i.exec(line);
    invalid(Boolean(match));
    const instruction = match[1].toUpperCase();
    const body = match[2].trim();
    invalid(!body.includes("<<"));
    if (instruction === "FROM") {
      fromCount += 1;
      invalid(index === 0 && body === baseReference);
    } else if (instruction === "COPY") {
      copyCount += 1;
      let argumentsText = body;
      while (argumentsText.startsWith("--")) {
        const flag = /^(--(?:chown=[a-z0-9_.:-]+|chmod=0?[0-7]{3,4}))[ \t]+/i.exec(argumentsText);
        invalid(Boolean(flag));
        argumentsText = argumentsText.slice(flag[0].length);
      }
      let args;
      if (argumentsText.startsWith("[")) {
        try { args = JSON.parse(argumentsText); } catch { invalid(false); }
      } else {
        invalid(!/["'\\]/.test(argumentsText));
        args = argumentsText.split(/[ \t]+/);
      }
      invalid(Array.isArray(args) && args.length >= 2 && args.every((arg) => typeof arg === "string" && arg.length > 0 && !/[\r\n\0$]/.test(arg)));
      invalid(args.slice(0, -1).every((source) => !source.startsWith("--") && !source.startsWith("/") && !source.includes(":") && !source.includes("\\") && !source.split("/").includes("..")));
    } else if (instruction === "RUN") {
      // RUN --mount/--network/--security can add resources outside the checked
      // base/context or override the CLI network policy. Fixed shell/exec RUNs
      // can instead invoke the checked source's seed/reseal/smoke scripts.
      invalid(!body.startsWith("--"));
    } else {
      invalid(metadataInstructions.has(instruction));
    }
  }
  invalid(fromCount === 1 && copyCount > 0);
}

function liveSamples(plan, engine, execute) {
  const locations = [["engine-root", "/"], ["engine-docker", engine.DockerRootDir], ["engine-containerd", "/var/lib/containerd"], ["engine-tmp", "/tmp"]];
  const samples = locations.map(([role, location]) => {
    let output;
    if (plan.operation === "build") output = execute("colima", ["ssh", "--profile", PROFILE, "--", "stat", "-f", "-c", "%i|%S|%a", location]);
    else output = execute("stat", ["-f", "-c", "%i|%S|%a", location]);
    const [id, blockSize, availableBlocks] = output.split("|");
    requireValue(/^[a-f0-9]+$/i.test(id ?? "") && /^\d+$/.test(blockSize ?? "") && /^\d+$/.test(availableBlocks ?? ""), "release_capacity_unreadable", "Could not identify a required engine filesystem.");
    return { role, filesystem: `engine:${id}`, availableBytes: Number(BigInt(blockSize) * BigInt(availableBlocks)) };
  });
  if (plan.operation === "build") {
    for (const [role, location] of [["host-source", plan.sourceRoot], ["host-builder", BUILDER_DIR], ["host-tmp", os.tmpdir()]]) {
      const stat = fs.statSync(location, { bigint: true });
      const space = fs.statfsSync(location, { bigint: true });
      samples.push({ role, filesystem: `host:${stat.dev}`, availableBytes: Number(space.bavail * space.bsize) });
    }
  }
  return samples;
}

function spawnOwnedProcess(command, args, stdio = "ignore") {
  const child = spawnChild(command, args, { env: safeEnv(), stdio, detached: true });
  // Docker invokes the buildx plugin as a child. Signal only this owned process
  // group so cancellation reaches that plugin, never another release/container.
  return Object.assign(child, { kill: (signal = "SIGTERM") => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; } catch { return false; }
  } });
}

function defaultSpawn(args, stdio = "ignore") { return spawnOwnedProcess("docker", args, stdio); }

export async function runMonitoredOperation({ args, check, spawn = defaultSpawn, intervalMs = 1000, stopGraceMs = 5000, timeoutMs = 60 * 60 * 1000 }) {
  check();
  return new Promise((resolve, reject) => {
    let child;
    let failure;
    let interval;
    let timeout;
    let escalation;
    let deadline;
    let childExited = false;
    let escalated = false;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      for (const timer of [interval, timeout, escalation, deadline]) clearTimeout(timer);
      process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
      if (error) reject(error); else resolve(undefined);
    };
    const stop = (error) => {
      if (failure || finished) return;
      failure = error;
      child.releaseDiscardOutput?.();
      clearTimeout(interval);
      clearTimeout(timeout);
      // A group leader may exit on TERM while its buildx descendant ignores
      // it. Keep escalation alive independently of the leader's exit event.
      escalation = setTimeout(() => {
        escalated = true;
        child.kill("SIGKILL");
        if (childExited) finish(failure);
      }, stopGraceMs);
      deadline = setTimeout(() => finish(failure), stopGraceMs * 2);
      child.kill("SIGTERM");
    };
    const interrupted = () => stop(fail("release_interrupted", "The owned image operation was interrupted; verify daemon cancellation before retrying."));
    try { child = spawn(args); } catch { finish(fail("release_child_failed", "The image operation could not start.")); return; }
    const exited = (error) => {
      childExited = true;
      Promise.resolve(child.releaseOutputDone).then(() => {
        if (!failure || escalated) finish(failure ?? child.releaseFailure ?? error);
      }, () => stop(fail("release_output_failed", "The bounded output streams failed.")));
    };
    child.once("release-failure", error => stop(error));
    child.once("error", () => exited(fail("release_child_failed", "The image operation failed to start.")));
    child.once("exit", (code) => exited(code === 0 ? undefined : fail("release_child_failed", "The image operation failed; inspect restricted operator logs separately.")));
    interval = setInterval(() => {
      try { check(); } catch (error) { stop(error?.code === "release_capacity_insufficient" ? error : fail("release_capacity_unreadable", "Live capacity became unreadable; stopping the owned image operation.")); }
    }, intervalMs);
    timeout = setTimeout(() => stop(fail("release_timeout", "The image operation reached its bounded time limit.")), timeoutMs);
    process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
    if (child.releaseFailure) stop(child.releaseFailure);
  });
}

async function registryBlob(plan, suffix, expectedDigest, fetchImpl) {
  const reference = plan.image.split("@")[0];
  const slash = reference.indexOf("/");
  const url = `http://${reference.slice(0, slash)}/v2/${reference.slice(slash + 1)}/${suffix}`;
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" } });
  requireValue(response.ok && response.body, "release_registry_unavailable", "The verified loopback registry is not ready.");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireValue(bytes <= 2 * 1024 ** 2, "release_registry_invalid", "Registry metadata exceeded the bounded size.");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  requireValue(hash(body) === expectedDigest, "release_registry_digest", "Registry bytes do not match the immutable digest.");
  return JSON.parse(body.toString("utf8"));
}

export async function runReleaseImages({ plan, checkOnly = false, execute = executeRead, sample = liveSamples, spawn = defaultSpawn, platform = process.platform, hostName = os.hostname(), fetchImpl = fetch, onCheck = (_name) => {} }) {
  const peaks = validatePlan(plan, platform, hostName);
  const docker = ["--host", plan.target.endpoint];
  if (plan.operation === "build") {
    verifySource(plan, execute);
    assertBuilderContext(execute);
  }
  const engine = inspectReleaseEngine(plan.target, execute);
  const check = (admission = false) => aggregateCapacity(sample(plan, engine, execute), peaks, plan.floorBytes, plan.growthReserveBytes, admission);
  const capacities = check(true);
  let args;
  let base;
  let config;
  if (plan.operation === "build") {
    base = inspectBuildBase(plan, execute);
    args = [...docker, "buildx", "build", "--builder", BUILDER, "--platform", plan.platform, "--network", "none", "--pull=false", "--load", "--metadata-file", plan.metadataFile, "--label", `org.opencontainers.image.revision=${plan.sourceRevision}`, "--file", plan.dockerfile.file, "--tag", plan.image, plan.sourceRoot];
  } else {
    requireValue(["amd64", "x86_64"].includes(engine.Architecture), "release_platform_invalid", "The serving engine must be linux/amd64.");
    const manifest = await registryBlob(plan, `manifests/${plan.image.split("@")[1]}`, plan.image.split("@")[1], fetchImpl);
    requireValue(manifest.schemaVersion === 2 && manifest.config?.digest === plan.configDigest && Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.every((layer) => SHA256.test(layer.digest) && positive(layer.size)), "release_registry_invalid", "A single-platform standard manifest with the expected config and layers is required.");
    config = await registryBlob(plan, `blobs/${plan.configDigest}`, plan.configDigest, fetchImpl);
    requireValue(config.os === "linux" && config.architecture === "amd64" && config.config?.Labels?.["org.opencontainers.image.revision"] === plan.sourceRevision && Array.isArray(config.rootfs?.diff_ids) && config.rootfs.diff_ids.length === manifest.layers.length && config.rootfs.diff_ids.every((value) => SHA256.test(value)), "release_image_invalid", "Registry config must match the candidate platform, source and root filesystem.");
    args = [...docker, "pull", "--platform", plan.platform, plan.image];
  }
  onCheck("image-operation-admitted");
  if (checkOnly) return { checked: true, operation: plan.operation, capacities, args };
  // Repeat admission after the identity/registry probes, immediately before writes.
  if (plan.operation === "build") verifySource(plan, execute);
  check(true);
  await runMonitoredOperation({ args, check, spawn });
  check();
  if (plan.operation === "build") {
    verifySource(plan, execute);
    for (const input of plan.inputs) artifact(input, false);
  }
  const result = imageInfo(execute("docker", [...docker, "image", "inspect", plan.image]));
  requireValue(result.Os === "linux" && result.Architecture === "amd64" && result.Config?.Labels?.["org.opencontainers.image.revision"] === plan.sourceRevision, "release_result_invalid", "The resulting image does not match the release platform and source.");
  let manifestDigest = plan.image.split("@")[1];
  let configDigest = plan.configDigest;
  if (plan.operation === "build") {
    const metadata = JSON.parse(readFile(plan.metadataFile).toString("utf8"));
    ({ manifestDigest, configDigest } = verifyBuiltImage(plan, base, result, metadata));
  } else {
    requireValue(SHA256.test(result.Id) && result.RepoDigests?.includes(plan.image) && JSON.stringify(result.RootFS?.Layers) === JSON.stringify(config.rootfs.diff_ids), "release_result_invalid", "Received config, manifest and root filesystem identities differ from the candidate.");
  }
  return { checked: true, completed: true, operation: plan.operation, localImageId: result.Id, ...(plan.operation === "build" ? { exportDigest: manifestDigest } : { manifestDigest }), configDigest, requiresReleaseVerification: true };
}

// The separately reviewed full-build entry reuses these exact safety operations;
// it does not feed invented measurements into the dependency-preserving delta.
export const releaseImageSafety = Object.freeze({
  BUILDER, PROFILE, BUILDER_DIR, BUILDER_ENDPOINT, BUILD_ROLES, SHA256, REVISION, PINNED_IMAGE,
  requireValue, positive, hash, readFile, artifact, imageInfo, executeRead, liveSamples, defaultSpawn, spawnOwnedProcess,
  assertIsolatedBuilderTarget, verifyCleanSource, inspectReleaseEngine, inspectBuildBase, assertBuilderContext, verifyBuiltImage,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, flag, file, ...extra] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    requireValue(["check-build", "build", "check-pull", "pull"].includes(command) && flag === "--plan" && file && extra.length === 0, "release_argument_invalid", "Usage: release-images.mjs check-build|build|check-pull|pull --plan /absolute/operation.json");
    const plan = JSON.parse(readFile(path.resolve(file)).toString("utf8"));
    requireValue(plan.operation === command.replace("check-", ""), "release_operation_invalid", "CLI operation and plan must agree.");
    const result = await runReleaseImages({ plan, checkOnly: command.startsWith("check-") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    // No child output, raw environment or arbitrary parser/path error is printed.
    process.stderr.write(`${String(error?.code ?? "release_failed").replace(/[^a-zA-Z0-9_]/g, "")}: image operation refused or failed; preserve current and rollback images and inspect restricted evidence.\n`);
    process.exitCode = 1;
  });
}
