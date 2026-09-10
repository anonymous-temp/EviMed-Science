#!/usr/bin/env node
/** Fixed full-Web build, with explicit first-build capacity calibration. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import { aggregateCapacity, runMonitoredOperation, releaseImageSafety as safety } from "./release-images.mjs";

const { requireValue: require, positive, hash, readFile, artifact, imageInfo, executeRead,
  liveSamples, defaultSpawn, verifyCleanSource, assertIsolatedBuilderTarget, assertBuilderContext,
  inspectReleaseEngine, inspectBuildBase, verifyBuiltImage, BUILD_ROLES } = safety;
const GiB = 1024 ** 3;
export const LOG_LIMIT = 64 * 1024 ** 2;
const SAMPLE_LIMIT = 32 * 1024 ** 2;
const CONTROL_ALLOWANCE = 128 * 1024 ** 2;
const CONTEXT_LIMIT = 128 * 1024 ** 2;

function safeArchivePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\\]/.test(value)
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split("/").some(part => ["", ".", ".."].includes(part));
}

export function commitInventory(plan, execute, subtree) {
  const text = execute("git", ["--no-replace-objects", "ls-tree", "--full-tree", "-r", "-l", "-z", subtree], plan.sourceRoot);
  const entries = text.split("\0").filter(Boolean).map(line => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}) +([0-9]+)\t([\s\S]+)$/.exec(line);
    require(match && safeArchivePath(match[4]), "release_context_invalid", "Git context must contain only scoped regular files and symlinks; submodules and special files are refused.");
    return { path: match[4], mode: match[1], gitBlob: match[2], bytes: Number(match[3]) };
  });
  require(entries.length > 0 && entries.length <= 10000 && new Set(entries.map(item => item.path)).size === entries.length,
    "release_context_invalid", "The immutable Git context inventory is empty, duplicated or oversized.");
  const upperBoundBytes = 1024 ** 2 + entries.reduce((sum, item) => sum + Math.ceil(item.bytes / 512) * 512 + 10240, 0);
  require(Number.isSafeInteger(upperBoundBytes) && upperBoundBytes <= CONTEXT_LIMIT, "release_context_too_large", "The commit-derived context exceeds the bounded private archive allowance.");
  return { entries, upperBoundBytes };
}

function readAt(fd, position, length) {
  const bytes = Buffer.alloc(length);
  require(fs.readSync(fd, bytes, 0, length, position) === length, "release_context_invalid", "The private Git archive was truncated.");
  return bytes;
}

/** Verify every archived blob and executable bit against git ls-tree. */
export function verifyContextArchive(fd, inventory, requiredHashes = {}) {
  const stat = fs.fstatSync(fd);
  require(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o222) === 0 && stat.size > 0 && stat.size <= inventory.upperBoundBytes,
    "release_context_too_large", "The private context archive is not a bounded ordinary file.");
  const wanted = new Map(inventory.entries.map(item => [item.path, item]));
  const found = new Set();
  const sha256 = createHash("sha256");
  for (let at = 0; at < stat.size; at += 65536) sha256.update(readAt(fd, at, Math.min(65536, stat.size - at)));
  let offset = 0;
  let extended = {};
  while (offset + 512 <= stat.size) {
    const header = readAt(fd, offset, 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      for (let at = offset; at < stat.size; at += 65536) require(readAt(fd, at, Math.min(65536, stat.size - at)).every(byte => byte === 0), "release_context_invalid", "Unexpected bytes follow the archive terminator.");
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const kind = field(156, 1) || "0";
    require(Number.isSafeInteger(size) && size >= 0 && offset + size <= stat.size, "release_context_invalid", "Archive size metadata is invalid.");
    const bodyOffset = offset;
    offset += Math.ceil(size / 512) * 512;
    if (kind === "x" || kind === "g") {
      require(size <= 16384, "release_context_invalid", "Archive extended metadata exceeds its bound.");
      const data = readAt(fd, bodyOffset, size);
      const attributes = {};
      for (let at = 0; at < data.length;) {
        const space = data.indexOf(32, at);
        const length = Number(data.subarray(at, space).toString());
        require(space > at && Number.isSafeInteger(length) && length > 0 && at + length <= data.length, "release_context_invalid", "Invalid archive extended metadata.");
        const row = data.subarray(space + 1, at + length - 1).toString("utf8");
        const equals = row.indexOf("="); attributes[row.slice(0, equals)] = row.slice(equals + 1); at += length;
      }
      if (kind === "x") extended = attributes;
      continue;
    }
    const prefix = field(345, 155);
    const name = extended.path ?? `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
    const link = extended.linkpath ?? field(157, 100);
    extended = {};
    if (kind === "5") { require(safeArchivePath(name.replace(/\/$/, "")), "release_context_invalid", "Unsafe archive directory."); continue; }
    const expected = wanted.get(name);
    require(safeArchivePath(name) && expected && !found.has(name), "release_context_invalid", "Archive paths differ from the exact commit inventory.");
    const executable = (Number.parseInt(field(100, 8), 8) & 0o111) !== 0;
    const blob = createHash("sha1");
    const contentHash = createHash("sha256");
    if (kind === "2") {
      require(expected.mode === "120000" && size === 0 && link.length > 0 && !path.posix.isAbsolute(link)
        && safeArchivePath(path.posix.normalize(path.posix.join(path.posix.dirname(name), link))), "release_context_invalid", "A symlink escapes the immutable context.");
      blob.update(`blob ${Buffer.byteLength(link)}\0`).update(link);
      contentHash.update(link);
    } else {
      require(kind === "0" && expected.mode !== "120000" && expected.bytes === size && executable === (expected.mode === "100755"), "release_context_invalid", "Archive file size/type/mode differs from its Git blob.");
      blob.update(`blob ${size}\0`);
      for (let at = 0; at < size; at += 65536) {
        const bytes = readAt(fd, bodyOffset + at, Math.min(65536, size - at));
        blob.update(bytes); contentHash.update(bytes);
      }
    }
    require(blob.digest("hex") === expected.gitBlob, "release_context_changed", "Archived content differs from its immutable Git blob.");
    const contentDigest = `sha256:${contentHash.digest("hex")}`;
    require(!requiredHashes[name] || requiredHashes[name] === contentDigest, "release_context_changed", "Committed build inputs differ from their reviewed recipe or dependency digests.");
    found.add(name);
  }
  require(found.size === wanted.size && offset <= stat.size, "release_context_invalid", `The archive inventory differs (${found.size}/${wanted.size} files; ${offset}/${stat.size} bytes).`);
  return { bytes: stat.size, sha256: `sha256:${sha256.digest("hex")}` };
}

/** Pipe consumers write at most the remaining allowance, including one burst.
 * They continue draining after refusal; no child inherits the evidence file FD. */
export function capChildOutput(child, outputs) {
  const refuse = code => {
    if (child.releaseFailure) return;
    child.releaseFailure = Object.assign(new Error("The bounded child output exceeded its allowance or could not be retained."), { code });
    child.releaseDiscardOutput();
    child.emit("release-failure", child.releaseFailure);
  };
  child.releaseDiscardOutput = () => { for (const { sink } of outputs) sink.discard = true; };
  const streams = outputs.filter(({ stream }) => stream);
  for (const { stream, sink } of streams) {
    stream.on("data", chunk => {
      if (sink.discard) return;
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const count = Math.min(bytes.length, Math.max(0, sink.limit - sink.written));
        let offset = 0;
        while (offset < count) {
          const wrote = fs.writeSync(sink.fd, bytes, offset, count - offset);
          if (!wrote) throw new Error("Output write made no progress");
          offset += wrote; sink.written += wrote;
        }
        if (count !== bytes.length) refuse(sink.code ?? "release_log_limit");
      } catch { refuse("release_output_failed"); }
    });
    stream.on("error", () => refuse("release_output_failed"));
  }
  child.releaseOutputDone = Promise.all(streams.map(({ stream }) => finished(stream).catch(() => {})));
  return child;
}
export const WEB_DOCKERFILE = "deploy/web/Dockerfile";
// A different recipe needs a separate review, not a caller-supplied hash.
// 2026-09-07: repinned for one added line — the image now carries the
// placeholder plugin-availability.json, because apps/server/src reads that
// path at the repository root and deploy.test.mjs derives from the source
// that every such file is in the image. A deployment's bind mount still
// overrides it; the shipped record is deliberately dated 1970 so every
// plugin reads as unknown until the nightly matrix writes a real one.
export const WEB_DOCKERFILE_SHA256 = "sha256:65f0287dc27160ce5530f6e2a3485dbb772a753726fb42926d5982d9958ac570";
export const WEB_INPUTS = Object.freeze([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "deps-version.json",
  "apps/web/package.json", "apps/server/package.json", "packages/shared/package.json",
  "packages/domain/package.json", "packages/harness-port/package.json", "packages/socket/package.json",
  "packages/contracts/package.json", "scripts/dev/fetch-skills.sh", "scripts/dev/patch-ai4s-integrity-auditor.py",
]);

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Validate observed block devices, not the profile's advertised disk size.
 * No new VM sizes, mount layouts, or drivers are admitted by this entry. */
export function verifyVmDiskTopology(status, devices, mounts, backing) {
  const invalid = condition => require(condition, "release_vm_disks_unverified",
    "Verify evimed-builder VZ status, lsblk hard capacities, findmnt storage mapping and its two raw backing files.");
  invalid(status.driver === "macOS Virtualization.Framework" && status.disk === 20 * GiB
    && status.docker_socket === safety.BUILDER_ENDPOINT);
  const writable = devices.blockdevices?.filter(device => device.type === "disk" && (device.ro === false || device.ro === 0));
  invalid(Array.isArray(writable) && writable.length === 2);
  invalid(writable.find(device => device.name === "vda")?.size === 8 * GiB
    && writable.find(device => device.name === "vdb")?.size === 20 * GiB);
  invalid(Array.isArray(devices.blockdevices) && devices.blockdevices.every(device =>
    device.type === "disk" && [false, true, 0, 1].includes(device.ro)));
  invalid(mounts.root === "/dev/vda1" && mounts.tmp === "/dev/vda1"
    && /^\/dev\/vdb1(?:\[\/[^\]]+\])?$/.test(mounts.docker)
    && /^\/dev\/vdb1(?:\[\/[^\]]+\])?$/.test(mounts.containerd));
  invalid(backing.length === 2 && backing[0].bytes === 8 * GiB && backing[1].bytes === 20 * GiB
    && backing.every(file => file.regular && file.links === 1 && file.unchangedPath
      && Number.isSafeInteger(file.allocatedBytes) && file.allocatedBytes >= 0
      && typeof file.filesystem === "string" && file.filesystem.startsWith("host:")
      && typeof file.identity === "string" && file.identity));
  return { backing, virtualCapacityBytes: 28 * GiB, mounts,
    reservationMethod: "full_virtual_capacity_upper_bound",
    note: "The entire virtual capacity is reserved; shared APFS blocks are not subtracted as if exclusively allocated." };
}

function readVmDisks(execute, engine) {
  require(engine.DockerRootDir === "/var/lib/docker", "release_vm_disks_unverified", "The reviewed builder Docker root must remain /var/lib/docker.");
  const vmDir = path.join(os.homedir(), ".colima/_lima/colima-evimed-builder");
  const dataDir = path.join(os.homedir(), ".colima/_lima/_disks/colima-evimed-builder");
  require(path.resolve(dataDir, fs.readlinkSync(path.join(dataDir, "in_use_by"))) === vmDir,
    "release_vm_disks_unverified", "The data disk must be attached to the isolated evimed-builder VM.");
  const backing = [path.join(vmDir, "disk"), path.join(dataDir, "datadisk")].map(file => {
    const stat = fs.lstatSync(file);
    return { file, bytes: stat.size, allocatedBytes: stat.blocks * 512, regular: stat.isFile(), links: stat.nlink,
      unchangedPath: fs.realpathSync(file) === file, filesystem: `host:${stat.dev}`, identity: `${stat.dev}:${stat.ino}` };
  });
  const status = JSON.parse(execute("colima", ["status", "--profile", safety.PROFILE, "--json"]));
  const devices = JSON.parse(execute("colima", ["ssh", "--profile", safety.PROFILE, "--", "lsblk", "--json", "--bytes", "--output", "NAME,TYPE,SIZE,RO"]));
  const mounts = {};
  for (const [role, location] of [["root", "/"], ["docker", engine.DockerRootDir], ["containerd", "/var/lib/containerd"], ["tmp", "/tmp"]]) {
    const result = JSON.parse(execute("colima", ["ssh", "--profile", safety.PROFILE, "--", "findmnt", "--json", "--target", location, "--output", "SOURCE,TARGET,FSTYPE"]));
    require(result.filesystems?.length === 1 && result.filesystems[0].fstype === "ext4", "release_vm_disks_unverified", "A builder write plane is not on a verified ext4 block device.");
    mounts[role] = result.filesystems[0].source;
  }
  return verifyVmDiskTopology(status, devices, mounts, backing);
}

export function probeVmDisks(execute = executeRead, engine) {
  try { return readVmDisks(execute, engine); }
  catch (error) {
    if (error?.code === "release_vm_disks_unverified") throw error;
    throw Object.assign(new Error("Verify colima status, lsblk capacities, findmnt storage mapping and the two VZ raw backing files."),
      { code: "release_vm_disks_unverified" });
  }
}

function validatePlan(plan, platform, hostName) {
  require(exact(plan, ["operation", "component", "mode", "platform", "sourceRoot", "sourceRevision", "sourceTree",
    "target", "base", "platformSmoke", "image", "evidenceDir", "floorBytes", "growthReserveBytes"]),
  "release_full_plan_invalid", "Only the fixed full-Web plan fields are accepted; Dockerfiles, targets, secrets and arbitrary build arguments are not inputs.");
  require(plan.operation === "build-web-full" && plan.component === "web" && plan.mode === "calibration",
    "release_calibration_required", "The first full-Web build requires explicitly declared calibration, not an invented measured peak.");
  require(plan.platform === "linux/amd64" && safety.REVISION.test(plan.sourceRevision) && safety.REVISION.test(plan.sourceTree),
    "release_platform_invalid", "The full Web build requires an exact source revision/tree and linux/amd64.");
  require(positive(plan.floorBytes) && positive(plan.growthReserveBytes), "release_budget_invalid", "Explicit positive floor and growth reserve bytes are required.");
  assertIsolatedBuilderTarget(plan.target, platform, hostName);
  require(exact(plan.base, ["reference", "imageId"]) && safety.PINNED_IMAGE.test(plan.base.reference)
    && /(?:^|\/)node@sha256:/.test(plan.base.reference) && safety.SHA256.test(plan.base.imageId),
  "release_base_unverified", "Use the verified digest-pinned amd64 Node base.");
  require(typeof plan.sourceRoot === "string" && path.isAbsolute(plan.sourceRoot)
    && typeof plan.evidenceDir === "string" && path.isAbsolute(plan.evidenceDir)
    && !fs.lstatSync(plan.evidenceDir, { throwIfNoEntry: false }), "release_metadata_invalid", "Use an existing absolute clean source and a new evidence directory.");
  require(/^[a-z0-9][a-z0-9/._-]*:[a-z0-9][a-z0-9._-]*$/.test(plan.image) && !/:(?:latest|current|rollback)$/.test(plan.image),
    "release_image_invalid", "Use a new explicit local candidate tag.");
  const smoke = artifact(plan.platformSmoke);
  require(smoke.endpoint === plan.target.endpoint && smoke.engineId === plan.target.engineId && smoke.platform === plan.platform
    && smoke.baseReference === plan.base.reference && smoke.nodeVersion === "v22.22.0" && smoke.nodeExitCode === 0 && smoke.buildRunExitCode === 0,
  "release_platform_unverified", "The exact base and isolated endpoint need successful amd64 Node 22.22.0 and Dockerfile RUN evidence.");
}

function sourceInputs(plan, execute) {
  verifyCleanSource(plan, execute);
  const sourceSubtree = execute("git", ["--no-replace-objects", "rev-parse", `${plan.sourceRevision}:OpenScience`], plan.sourceRoot);
  require(safety.REVISION.test(sourceSubtree) && execute("git", ["--no-replace-objects", "rev-parse", "HEAD:OpenScience"], plan.sourceRoot) === sourceSubtree,
    "release_source_changed", "The OpenScience subtree must belong to the exact source revision.");
  const repository = fs.realpathSync(execute("git", ["--no-replace-objects", "rev-parse", "--show-toplevel"], plan.sourceRoot));
  require(fs.realpathSync(plan.sourceRoot) === path.join(repository, "OpenScience"),
    "release_source_invalid", "The fixed Web recipe uses the clean monorepo's OpenScience context.");
  const evidenceParent = fs.realpathSync(path.dirname(plan.evidenceDir));
  require(evidenceParent !== repository && !evidenceParent.startsWith(`${repository}${path.sep}`),
    "release_metadata_invalid", "Build evidence must remain outside the entire clean Git checkout.");
  require(hash(readFile(path.join(plan.sourceRoot, WEB_DOCKERFILE))) === WEB_DOCKERFILE_SHA256,
    "release_full_recipe_changed", "The full Web Dockerfile differs from the separately reviewed recipe.");
  const inputs = Object.fromEntries(WEB_INPUTS.map(relative => [relative, hash(readFile(path.join(plan.sourceRoot, relative)))]));
  const fetcher = readFile(path.join(plan.sourceRoot, "scripts/dev/fetch-skills.sh")).toString("utf8");
  const ai4sCommit = fetcher.match(/^AI4S_SKILLS_COMMIT="\$\{AI4S_SKILLS_COMMIT:-([a-f0-9]{40})\}"$/m)?.[1];
  require(ai4sCommit && fetcher.includes("https://codeload.github.com/ai4s-research/ai4s-skills/tar.gz/${AI4S_SKILLS_COMMIT}"),
    "release_dependency_changed", "AI4S hydration must retain its existing immutable repository commit pin.");
  return { inputs, ai4sCommit, sourceSubtree, repository, evidenceFilesystem: `host:${fs.statSync(evidenceParent).dev}` };
}

function checkFloors(samples, plan, disks, admission, contextBytes = 0) {
  require(samples.length === BUILD_ROLES.length && BUILD_ROLES.every(role => samples.some(sample => sample.role === role)),
    "release_budget_invalid", "Observe every host, Docker, containerd and temporary storage plane.");
  const floors = aggregateCapacity(samples, null, plan.floorBytes, plan.growthReserveBytes, false)
    .map(({ peakBytes: _notMeasured, ...floor }) => floor);
  if (admission) {
    for (const floor of floors.filter(item => item.filesystem.startsWith("host:"))) {
      const virtualBytes = disks.backing.filter(file => file.filesystem === floor.filesystem).reduce((sum, file) => sum + file.bytes, 0);
      require(floor.availableBytes >= floor.reserveBytes + virtualBytes + CONTROL_ALLOWANCE + contextBytes,
        "release_capacity_insufficient", "Host space must cover all remaining VM allocation, bounded build evidence, the serving floor and growth reserve.");
    }
    require(disks.backing.every(file => floors.some(floor => floor.filesystem === file.filesystem)),
      "release_vm_disks_unverified", "Every VM backing disk filesystem must be part of the live host samples.");
  }
  return floors;
}

/** Only local unit fixtures inject probes/spawn. CLI offers no such override. */
export async function runFullWebBuild({ plan, checkOnly = false, execute = executeRead, sample = liveSamples,
  probeDisks = probeVmDisks, spawn, archiveSpawn, platform = process.platform, hostName = os.hostname() }) {
  validatePlan(plan, platform, hostName);
  const source = sourceInputs(plan, execute);
  const inventory = commitInventory(plan, execute, source.sourceSubtree);
  const requiredHashes = { ...source.inputs, [WEB_DOCKERFILE]: WEB_DOCKERFILE_SHA256 };
  assertBuilderContext(execute);
  const engine = inspectReleaseEngine(plan.target, execute);
  const base = inspectBuildBase(plan, execute);
  require(base.Config?.Env?.includes("NODE_VERSION=22.22.0"), "release_base_unverified", "The inspected Node base must match the observed 22.22.0 toolchain.");
  const disks = probeDisks(execute, engine);
  const initial = sample({ ...plan, operation: "build" }, engine, execute);
  require(initial.some(value => value.filesystem === source.evidenceFilesystem), "release_metadata_invalid", "The evidence directory must be on a monitored host filesystem.");
  const capacities = checkFloors(initial, plan, disks, true, inventory.upperBoundBytes);
  const metadataFile = path.join(plan.evidenceDir, "buildkit.json");
  const args = ["--context", safety.BUILDER, "buildx", "build", "--builder", safety.BUILDER,
    "--platform", "linux/amd64", "--network", "default", "--pull=false", "--load", "--progress", "plain",
    "--metadata-file", metadataFile, "--file", WEB_DOCKERFILE, "--tag", plan.image,
    "--build-arg", `NODE_BASE_IMAGE=${plan.base.reference}`, "--build-arg", `SOURCE_REVISION=${plan.sourceRevision}`,
    "--build-arg", `RELEASE_ID=${plan.image.split(":").at(-1)}`, "--build-arg", `BUILD_CREATED=${new Date().toISOString()}`,
    "--build-arg", "VITE_OPEN_SCIENCE_API_URL=/api", "-"];
  if (checkOnly) return { checked: true, operation: plan.operation, mode: "calibration", capacities, disks, ...source,
    recipeSha256: WEB_DOCKERFILE_SHA256, context: { subtree: source.sourceSubtree, ...inventory }, args, measuredPeakAvailable: false, requiresReleaseVerification: true };

  fs.mkdirSync(plan.evidenceDir, { mode: 0o700 });
  const log = fs.openSync(path.join(plan.evidenceDir, "build.log"), "wx", 0o600);
  const samplesLog = fs.openSync(path.join(plan.evidenceDir, "capacity-samples.jsonl"), "wx", 0o600);
  const observations = new Map();
  let count = 0;
  let result;
  let context;
  let contextFd;
  const logSink = { fd: log, limit: LOG_LIMIT, written: 0, discard: false };
  const observe = values => {
    const now = new Date().toISOString();
    for (const value of values) {
      const previous = observations.get(value.filesystem) ?? { initialAvailableBytes: value.availableBytes,
        minimumAvailableBytes: value.availableBytes, roles: [] };
      previous.minimumAvailableBytes = Math.min(previous.minimumAvailableBytes, value.availableBytes);
      if (!previous.roles.includes(value.role)) previous.roles.push(value.role);
      observations.set(value.filesystem, previous);
    }
    count++;
    const line = Buffer.from(`${JSON.stringify({ at: now, samples: values })}\n`);
    require(fs.fstatSync(samplesLog).size + line.length <= SAMPLE_LIMIT, "release_evidence_limit", "The bounded capacity record exceeded its limit.");
    fs.writeSync(samplesLog, line);
    require(fs.fstatSync(log).size <= LOG_LIMIT && fs.fstatSync(samplesLog).size <= SAMPLE_LIMIT,
      "release_evidence_limit", "The bounded build log or capacity record exceeded its limit.");
  };
  const check = (admission = false) => {
    const currentDisks = probeDisks(execute, engine);
    require(JSON.stringify(currentDisks.backing.map(file => [file.identity, file.bytes, file.filesystem]))
      === JSON.stringify(disks.backing.map(file => [file.identity, file.bytes, file.filesystem])),
    "release_vm_disks_unverified", "The verified VM backing disks changed during calibration.");
    const values = sample({ ...plan, operation: "build" }, engine, execute);
    observe(values);
    require(JSON.stringify(values.map(value => [value.role, value.filesystem]).sort())
      === JSON.stringify(initial.map(value => [value.role, value.filesystem]).sort()),
    "release_capacity_unreadable", "A monitored storage plane changed filesystem during calibration.");
    checkFloors(values, plan, currentDisks, admission, inventory.upperBoundBytes);
  };
  try {
    observe(initial);
    sourceInputs(plan, execute);
    check(true);
    const contextFile = path.join(plan.evidenceDir, "context.tar");
    const archiveFd = fs.openSync(contextFile, "wx", 0o600);
    try {
      await runMonitoredOperation({ args: ["--no-replace-objects", "-C", source.repository, "-c", "core.attributesFile=/dev/null", "archive", "--format=tar", `${plan.sourceRevision}:OpenScience`], check,
        spawn: command => {
          const child = archiveSpawn ? archiveSpawn(command) : safety.spawnOwnedProcess("git", command, ["ignore", "pipe", "pipe"]);
          return capChildOutput(child, [{ stream: child.stdout, sink: { fd: archiveFd, limit: inventory.upperBoundBytes, written: 0, discard: false, code: "release_context_too_large" } },
            { stream: child.stderr, sink: logSink }]);
        } });
      fs.fchmodSync(archiveFd, 0o400);
    } finally { fs.closeSync(archiveFd); }
    contextFd = fs.openSync(contextFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const snapshot = () => {
      const named = fs.lstatSync(contextFile);
      const opened = fs.fstatSync(contextFd);
      require(named.isFile() && named.dev === opened.dev && named.ino === opened.ino, "release_context_changed", "The private context archive path was replaced.");
      return verifyContextArchive(contextFd, inventory, requiredHashes);
    };
    context = { subtree: source.sourceSubtree, ...snapshot(), inventory: inventory.entries };
    await runMonitoredOperation({ args, check, spawn: command => {
      require(JSON.stringify(snapshot()) === JSON.stringify({ bytes: context.bytes, sha256: context.sha256 }), "release_context_changed", "The private context snapshot changed before build.");
      assertBuilderContext(execute);
      inspectReleaseEngine(plan.target, execute);
      const child = spawn ? spawn(command, contextFd) : defaultSpawn(command, [contextFd, "pipe", "pipe"]);
      return capChildOutput(child, [{ stream: child.stdout, sink: logSink }, { stream: child.stderr, sink: logSink }]);
    } });
    check();
    require(JSON.stringify(snapshot()) === JSON.stringify({ bytes: context.bytes, sha256: context.sha256 }), "release_context_changed", "The private context snapshot changed during build.");
    require(JSON.stringify(sourceInputs(plan, execute)) === JSON.stringify(source), "release_source_changed", "Source dependency inputs changed during the build.");
    inspectReleaseEngine(plan.target, execute);
    const afterBase = imageInfo(execute("docker", ["--host", plan.target.endpoint, "image", "inspect", plan.base.reference]));
    require(afterBase.Id === base.Id, "release_base_unverified", "The inspected base identity changed during the build.");
    const built = imageInfo(execute("docker", ["--host", plan.target.endpoint, "image", "inspect", plan.image]));
    const metadata = JSON.parse(readFile(metadataFile).toString("utf8"));
    const verified = verifyBuiltImage(plan, base, built, metadata);
    result = { completed: true, localImageId: built.Id, exportDigest: verified.manifestDigest, configDigest: verified.configDigest };
  } catch (error) {
    result = { completed: false, errorCode: typeof error?.code === "string" ? error.code : "release_full_failed" };
    throw error;
  } finally {
    if (contextFd !== undefined) fs.closeSync(contextFd);
    fs.closeSync(log);
    fs.closeSync(samplesLog);
    const observed = [...observations].map(([filesystem, value]) => ({ filesystem, ...value,
      maximumObservedDecreaseBytes: Math.max(0, value.initialAvailableBytes - value.minimumAvailableBytes) }));
    fs.writeFileSync(path.join(plan.evidenceDir, "calibration.json"), `${JSON.stringify({ schemaVersion: 1,
      operation: plan.operation, component: "web", mode: "calibration", platform: plan.platform,
      sourceRevision: plan.sourceRevision, sourceTree: plan.sourceTree, engineId: plan.target.engineId,
      baseReference: plan.base.reference, recipeSha256: WEB_DOCKERFILE_SHA256, ...source, disks, context, sampleCount: count,
      observationKind: "sampled_filesystem_available_space_decrease_not_independent_role_peaks", observed,
      ...result, requiresReleaseVerification: true, publicationAllowed: false,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return { checked: true, operation: plan.operation, ...result, requiresReleaseVerification: true, publicationAllowed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, flag, file, ...extra] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    require(["check-build", "build"].includes(command) && flag === "--plan" && file && !extra.length,
      "release_argument_invalid", "Usage: release-full-build.mjs check-build|build --plan /absolute/full-web.json");
    const result = await runFullWebBuild({ plan: JSON.parse(readFile(path.resolve(file))), checkOnly: command === "check-build" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${String(error?.code ?? "release_full_failed").replace(/[^a-zA-Z0-9_]/g, "")}: full Web build refused or failed; preserve candidates and inspect restricted calibration evidence.\n`);
    if (error?.code === "release_vm_disks_unverified") process.stderr.write("Required probes: colima evimed-builder status, lsblk 8/20 GiB hard capacities, findmnt root/data mappings, and the two VZ raw backing files.\n");
    process.exitCode = 1;
  });
}
