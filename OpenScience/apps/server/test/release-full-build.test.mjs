import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runFullWebBuild, verifyVmDiskTopology, commitInventory, LOG_LIMIT, WEB_DOCKERFILE, WEB_DOCKERFILE_SHA256, WEB_INPUTS } from "../../../scripts/ops/release-full-build.mjs";
import { runReleaseImages, releaseImageSafety } from "../../../scripts/ops/release-images.mjs";

const GiB = 1024 ** 3;
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const baseId = `sha256:${"c".repeat(64)}`;
const resultId = `sha256:${"d".repeat(64)}`;
const baseReference = `example.invalid/library/node@sha256:${"e".repeat(64)}`;
const layer = `sha256:${"f".repeat(64)}`;
const nextLayer = `sha256:${"1".repeat(64)}`;

function topology() {
  return {
    status: { driver: "macOS Virtualization.Framework", disk: 20 * GiB, docker_socket: releaseImageSafety.BUILDER_ENDPOINT.slice(7) },
    devices: { blockdevices: [{ name: "vda", type: "disk", size: 8 * GiB, ro: false },
      { name: "vdb", type: "disk", size: 20 * GiB, ro: false }, { name: "vdc", type: "disk", size: 20_000_000, ro: true }] },
    mounts: { root: "/dev/vda1", tmp: "/dev/vda1", docker: "/dev/vdb1[/docker]", containerd: "/dev/vdb1[/containerd]" },
    backing: [8, 20].map((size, index) => ({ file: `/fixture/${index}`, bytes: size * GiB, allocatedBytes: GiB,
      regular: true, links: 1, unchangedPath: true, filesystem: "host:1", identity: `1:${index}` })),
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "full-web-unit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, "source");
  const sourceRoot = path.join(repository, "OpenScience");
  fs.mkdirSync(path.join(sourceRoot, "deploy/web"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, WEB_DOCKERFILE), fs.readFileSync(new URL(`../../../${WEB_DOCKERFILE}`, import.meta.url)));
  for (const relative of WEB_INPUTS) {
    const file = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative === "scripts/dev/fetch-skills.sh"
      ? 'AI4S_SKILLS_COMMIT="${AI4S_SKILLS_COMMIT:-8fa2ab0523082c135598909b227ed8feb48263ad}"\nURL="https://codeload.github.com/ai4s-research/ai4s-skills/tar.gz/${AI4S_SKILLS_COMMIT}"\n'
      : `fixed ${relative}\n`);
  }
  fs.writeFileSync(path.join(repository, "sibling-must-not-enter.txt"), "outside OpenScience\n");
  fs.writeFileSync(path.join(sourceRoot, "source-value.txt"), "committed source\n");
  fs.chmodSync(path.join(sourceRoot, "scripts/dev/fetch-skills.sh"), 0o755);
  fs.symlinkSync("source-value.txt", path.join(sourceRoot, "source-link"));
  const git = args => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Release fixture", "-c", "user.email=release@example.test", ...args], { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "Immutable fixture"]);
  const sourceRevision = git(["rev-parse", "HEAD"]);
  const sourceTree = git(["rev-parse", "HEAD^{tree}"]);
  const smokeFile = path.join(root, "platform-smoke.json");
  fs.writeFileSync(smokeFile, JSON.stringify({ endpoint: releaseImageSafety.BUILDER_ENDPOINT, engineId: "builder-engine",
    platform: "linux/amd64", baseReference, nodeVersion: "v22.22.0", nodeExitCode: 0, buildRunExitCode: 0 }));
  const plan = { operation: "build-web-full", component: "web", mode: "calibration", platform: "linux/amd64",
    sourceRoot, sourceRevision, sourceTree, floorBytes: 5 * GiB, growthReserveBytes: GiB,
    target: { context: releaseImageSafety.BUILDER, endpoint: releaseImageSafety.BUILDER_ENDPOINT,
      engineId: "builder-engine", engineName: "isolated-engine", hostName: os.hostname(), servingHostName: "serving-host" },
    base: { reference: baseReference, imageId: baseId }, image: "evimed-web:calibration-unit",
    platformSmoke: { file: smokeFile, sha256: digest(fs.readFileSync(smokeFile)) }, evidenceDir: path.join(root, "evidence") };
  const state = { built: false, dirty: false, free: 100 * GiB, engineFree: 16 * GiB, changedEngine: false, changedResult: false };
  const hostFilesystem = `host:${fs.statSync(root).dev}`;
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      if (args.includes("status")) return state.dirty ? "!! ignored-generated-artifact\n" : "";
      return git(args);
    }
    if (command === "docker" && args.includes("context")) return releaseImageSafety.BUILDER_ENDPOINT;
    if (args.includes("info")) return JSON.stringify({ ID: state.changedEngine ? "other-engine" : "builder-engine", Name: "isolated-engine", OSType: "linux", DockerRootDir: "/var/lib/docker" });
    if (args.includes("buildx")) return JSON.stringify({ Driver: "docker", Nodes: [{ Endpoint: releaseImageSafety.BUILDER }] });
    if (args.includes("ls")) return state.built ? resultId : "";
    if (args.includes("inspect")) return JSON.stringify([args.at(-1) === baseReference
      ? { Id: baseId, Os: "linux", Architecture: "amd64", RepoDigests: [baseReference], RootFS: { Layers: [layer] }, Config: { Env: ["NODE_VERSION=22.22.0"] } }
      : { Id: resultId, Os: "linux", Architecture: "amd64", RootFS: { Layers: state.changedResult ? [nextLayer] : [layer, nextLayer] }, Config: { Labels: { "org.opencontainers.image.revision": sourceRevision } } }]);
    throw new Error("Unexpected fixture probe");
  };
  const sample = () => releaseImageSafety.BUILD_ROLES.map(role => ({ role, filesystem: role.startsWith("host") ? hostFilesystem : "engine:1",
    availableBytes: role.startsWith("host") ? state.free : state.engineFree }));
  const value = topology();
  for (const file of value.backing) file.filesystem = hostFilesystem;
  const probeDisks = () => verifyVmDiskTopology(value.status, value.devices, value.mounts, value.backing);
  const options = { plan, checkOnly: true, execute, sample, probeDisks, platform: "darwin", hostName: os.hostname() };
  const spawn = args => {
    calls.push(["write", ...args]);
    fs.writeFileSync(path.join(plan.evidenceDir, "buildkit.json"), JSON.stringify({ "containerimage.config.digest": resultId, "containerimage.digest": resultId }));
    state.built = true;
    state.free -= GiB;
    state.engineFree -= 2 * GiB;
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  return { root, plan, options, state, calls, value, spawn, hostFilesystem, git };
}

test("the only accepted full-Web recipe is the reviewed in-image dependency and artifact flow", () => {
  const dockerfile = fs.readFileSync(new URL(`../../../${WEB_DOCKERFILE}`, import.meta.url), "utf8");
  assert.equal(digest(dockerfile), WEB_DOCKERFILE_SHA256);
  assert.match(dockerfile, /RUN pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /env -u AI4S_SKILLS_COMMIT bash scripts\/dev\/fetch-skills\.sh/);
  assert.match(dockerfile, /RUN pnpm --filter @evimed\/dsh-socket prepack/);
  assert.match(dockerfile, /RUN pnpm --filter @ai4s\/web build/);
  assert.match(dockerfile, /RUN pnpm --filter @ai4s\/server deploy --prod \/server/);
  assert.match(dockerfile, /COPY --from=build \/app\/apps\/web\/dist/);
});

test("calibration verifies hard disk sizes and the existing storage mappings", () => {
  const f = topology();
  assert.equal(verifyVmDiskTopology(f.status, f.devices, f.mounts, f.backing).virtualCapacityBytes, 28 * GiB);
  for (const mutate of [
    value => { value.status.disk = 40 * GiB; }, value => { value.devices.blockdevices[0].size = 9 * GiB; },
    value => { value.devices.blockdevices[1].size = 40 * GiB; }, value => { value.devices.blockdevices[2].ro = false; },
    value => { value.mounts.docker = "/dev/vda1"; }, value => { value.mounts.tmp = "virtiofs"; },
    value => { value.backing[0].unchangedPath = false; }, value => { value.backing[1].links = 2; },
  ]) {
    const changed = structuredClone(f); mutate(changed);
    assert.throws(() => verifyVmDiskTopology(changed.status, changed.devices, changed.mounts, changed.backing), { code: "release_vm_disks_unverified" });
  }
});

test("check-build is read-only and names only fixed full-Web build arguments", async t => {
  const f = fixture(t);
  const result = await runFullWebBuild(f.options);
  assert.equal(result.measuredPeakAvailable, false);
  assert.equal(result.disks.virtualCapacityBytes, 28 * GiB);
  assert.deepEqual(Object.keys(result.inputs), WEB_INPUTS);
  assert.equal(result.ai4sCommit, "8fa2ab0523082c135598909b227ed8feb48263ad");
  assert.equal(fs.existsSync(f.plan.evidenceDir), false);
  assert.ok(result.args.includes("--load") && result.args.includes("--pull=false"));
  assert.deepEqual(result.args.slice(0, 6), ["--context", releaseImageSafety.BUILDER, "buildx", "build", "--builder", releaseImageSafety.BUILDER]);
  assert.equal(result.args.includes("--host"), false);
  for (const call of f.calls.filter(call => call[0] === "docker" && (call.includes("info") || call.includes("image")))) {
    assert.deepEqual(call.slice(1, 3), ["--host", releaseImageSafety.BUILDER_ENDPOINT]);
  }
  assert.equal(result.args.some(arg => ["--push", "--target", "--secret", "--ssh", "--allow", "--cache-from"].includes(arg)), false);
  assert.equal(result.args.at(-1), "-");
  assert.equal(result.args[result.args.indexOf("--file") + 1], "deploy/web/Dockerfile");
  assert.ok(result.context.entries.some(item => item.path === "deploy/web/Dockerfile"));
  assert.equal(result.context.entries.some(item => item.path.startsWith("OpenScience/") || item.path.includes("sibling-must-not-enter")), false);
});

test("a full build refuses a context whose live endpoint mapping changed before staging or Docker writes", async t => {
  const f = fixture(t);
  await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false,
    execute: (command, args, cwd) => command === "docker" && args.includes("context")
      ? "unix:///var/run/docker.sock" : f.options.execute(command, args, cwd),
    spawn: () => assert.fail("The wrong context cannot start a build"),
  }), { code: "release_endpoint_changed" });
  assert.equal(fs.existsSync(f.plan.evidenceDir), false);
});

for (const changed of ["context", "engine"]) test(`full build rechecks ${changed} after archive staging before spawning Docker`, async t => {
  const f = fixture(t);
  let archiveFinished = false;
  let dockerSpawns = 0;
  let contextChecks = 0;
  let engineChecks = 0;
  await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false,
    execute: (command, args, cwd) => {
      const result = f.options.execute(command, args, cwd);
      if (command === "docker" && args.includes("context")) {
        contextChecks++;
        if (archiveFinished && changed === "context") return "unix:///var/run/docker.sock";
      }
      if (command === "docker" && args.includes("info")) {
        engineChecks++;
        if (archiveFinished && changed === "engine") return JSON.stringify({ ...JSON.parse(result), ID: "replacement-engine" });
      }
      return result;
    },
    archiveSpawn: command => {
      const child = releaseImageSafety.spawnOwnedProcess("git", command, ["ignore", "pipe", "pipe"]);
      child.once("exit", () => { archiveFinished = true; });
      return child;
    },
    spawn: () => { dockerSpawns++; assert.fail("A remapped builder cannot receive Docker writes"); },
  }), { code: "release_child_failed" });
  assert.equal(archiveFinished, true);
  assert.equal(dockerSpawns, 0);
  assert.ok(contextChecks >= 2);
  if (changed === "engine") assert.ok(engineChecks >= 2);
  const report = JSON.parse(fs.readFileSync(path.join(f.plan.evidenceDir, "calibration.json"), "utf8"));
  assert.equal(report.completed, false);
  assert.equal(report.publicationAllowed, false);
});

test("the full remaining virtual allocation is reserved once per host filesystem", async t => {
  const f = fixture(t);
  f.state.free = 33 * GiB;
  await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false, spawn: () => assert.fail("insufficient full-capacity headroom") }), { code: "release_capacity_insufficient" });
  assert.equal(fs.existsSync(f.plan.evidenceDir), false);
  f.state.free = 35 * GiB;
  const result = await runFullWebBuild(f.options);
  assert.equal(result.capacities.filter(row => row.filesystem === f.hostFilesystem).length, 1);
});

test("4.2 GB VM or host free refuses calibration before any write", async t => {
  for (const plane of ["free", "engineFree"]) {
    const f = fixture(t); f.state[plane] = 4_200_000_000;
    await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false, spawn: () => assert.fail("no build") }), { code: "release_capacity_insufficient" });
    assert.equal(fs.existsSync(f.plan.evidenceDir), false);
  }
});

test("wrong endpoint, serving host, missing smoke, implicit calibration and caller recipe options cannot build", async t => {
  const f = fixture(t);
  for (const mutate of [
    plan => { plan.target.context = "colima"; }, plan => { plan.target.hostName = plan.target.servingHostName; },
    plan => { plan.platform = "linux/arm64"; }, plan => { plan.mode = "measured"; },
    plan => { plan.platformSmoke = null; }, plan => { plan.dockerfile = "/tmp/arbitrary"; },
    plan => { plan.buildArgs = ["--secret"]; }, plan => { plan.base.reference = "node:latest"; },
    plan => { plan.growthReserveBytes = 0; },
  ]) {
    const plan = structuredClone(f.plan); mutate(plan);
    await assert.rejects(runFullWebBuild({ ...f.options, plan, execute: () => assert.fail("No Docker or Git probe is authorized") }));
  }
});

test("ignored input, changed recipe and evidence inside the Git checkout fail closed", async t => {
  const f = fixture(t);
  f.state.dirty = true;
  await assert.rejects(runFullWebBuild(f.options), { code: "release_source_changed" });
  f.state.dirty = false;
  await assert.rejects(runFullWebBuild({ ...f.options, plan: { ...f.plan, evidenceDir: path.join(f.plan.sourceRoot, "evidence") } }), { code: "release_metadata_invalid" });
  fs.appendFileSync(path.join(f.plan.sourceRoot, WEB_DOCKERFILE), "RUN curl https://unreviewed.example\n");
  await assert.rejects(runFullWebBuild(f.options), { code: "release_full_recipe_changed" });
});

test("cold build records actual observations and new image identity without authorizing publication", async t => {
  const f = fixture(t);
  const result = await runFullWebBuild({ ...f.options, checkOnly: false, spawn: f.spawn });
  assert.equal(result.completed, true);
  assert.equal(result.publicationAllowed, false);
  assert.equal(result.requiresReleaseVerification, true);
  const report = JSON.parse(fs.readFileSync(path.join(f.plan.evidenceDir, "calibration.json"), "utf8"));
  assert.equal(report.mode, "calibration");
  assert.equal(report.observed.find(item => item.filesystem === f.hostFilesystem).maximumObservedDecreaseBytes, GiB);
  assert.equal(report.observed.find(item => item.filesystem === "engine:1").maximumObservedDecreaseBytes, 2 * GiB);
  assert.equal(Object.hasOwn(report, "peaks"), false, "sampled filesystem deltas are not invented independent role peaks");
  assert.ok(report.sampleCount >= 3);
  assert.equal(fs.statSync(path.join(f.plan.evidenceDir, "build.log")).mode & 0o777, 0o600);
  assert.equal(f.calls.filter(call => call[0] === "write").length, 1);
});

test("post-build floor crossings, source changes and wrong rootfs never produce a completed calibration", async t => {
  for (const condition of ["capacity", "source", "image"]) {
    const f = fixture(t);
    await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false, spawn: args => {
      const child = f.spawn(args);
      if (condition === "capacity") f.state.free = 4 * GiB;
      if (condition === "source") f.state.dirty = true;
      if (condition === "image") f.state.changedResult = true;
      return child;
    } }));
    const report = JSON.parse(fs.readFileSync(path.join(f.plan.evidenceDir, "calibration.json"), "utf8"));
    assert.equal(report.completed, false);
    assert.equal(report.publicationAllowed, false);
  }
});

test("unreadable hard-cap evidence refuses without creating evidence or starting Docker", async t => {
  const f = fixture(t);
  await assert.rejects(runFullWebBuild({ ...f.options, probeDisks: () => {
    throw Object.assign(new Error("The lsblk probe is unavailable"), { code: "release_vm_disks_unverified" });
  } }), { code: "release_vm_disks_unverified" });
  assert.equal(fs.existsSync(f.plan.evidenceDir), false);
});

test("the existing delta operation still requires measured peak evidence", async t => {
  const f = fixture(t);
  await assert.rejects(runReleaseImages({ ...f.options, plan: { ...f.plan, operation: "build", component: "web" } }));
  assert.equal(f.calls.some(call => call.includes("build") || call.includes("pull")), false);
});

test("a tracked file changed and restored during spawn cannot alter the committed tar supplied to Docker", async t => {
  const f = fixture(t);
  await runFullWebBuild({ ...f.options, checkOnly: false, spawn: (args, contextFd) => {
    const file = path.join(f.plan.sourceRoot, "source-value.txt");
    fs.writeFileSync(file, "working-tree race must not enter image\n");
    try {
      const supplied = fs.readFileSync(contextFd);
      assert.ok(supplied.includes(Buffer.from("committed source\n")));
      assert.equal(supplied.includes(Buffer.from("working-tree race must not enter image")), false);
      assert.equal(args.at(-1), "-");
      assert.equal(args.includes(f.plan.sourceRoot), false);
    } finally { fs.writeFileSync(file, "committed source\n"); }
    return f.spawn(args);
  } });
  const report = JSON.parse(fs.readFileSync(path.join(f.plan.evidenceDir, "calibration.json"), "utf8"));
  assert.equal(report.completed, true);
  assert.equal(report.context.inventory.find(item => item.path === "source-link").mode, "120000");
  assert.equal(report.context.inventory.find(item => item.path === "scripts/dev/fetch-skills.sh").mode, "100755");
  assert.equal(report.context.inventory.some(item => item.path.includes("sibling-must-not-enter")), false);
  assert.equal(fs.statSync(path.join(f.plan.evidenceDir, "context.tar")).mode & 0o777, 0o400);
  assert.equal(digest(fs.readFileSync(path.join(f.plan.evidenceDir, "context.tar"))), report.context.sha256);
});

test("changed or oversized private snapshots fail instead of claiming an image", async t => {
  for (const damage of ["changed", "oversized"]) {
    const f = fixture(t);
    await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false, spawn: args => {
      const file = path.join(f.plan.evidenceDir, "context.tar");
      fs.chmodSync(file, 0o600);
      if (damage === "changed") {
        const bytes = fs.readFileSync(file);
        const offset = bytes.indexOf(Buffer.from("committed source\n"));
        assert.ok(offset >= 0); bytes[offset] = 88; fs.writeFileSync(file, bytes);
      } else fs.truncateSync(file, 128 * 1024 ** 2 + 1);
      fs.chmodSync(file, 0o400);
      return f.spawn(args);
    } }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.plan.evidenceDir, "calibration.json"), "utf8")).completed, false);
  }
});

test("submodule and traversing commit inventory entries are refused", () => {
  for (const entry of [`160000 commit ${"a".repeat(40)}       -\tmodule\0`, `100644 blob ${"a".repeat(40)}       1\t../escape\0`]) {
    assert.throws(() => commitInventory({ sourceRoot: "/fixture" }, () => entry, "b".repeat(40)), { code: "release_context_invalid" });
  }
});

test("actual git replace refs cannot label replacement tree bytes as the original revision", async t => {
  const f = fixture(t);
  const original = f.plan.sourceRevision;
  fs.writeFileSync(path.join(f.plan.sourceRoot, "source-value.txt"), "replacement commit bytes\n");
  f.git(["add", "."]); f.git(["commit", "-qm", "Replacement fixture"]);
  const replacement = f.git(["rev-parse", "HEAD"]);
  f.git(["replace", original, replacement]); f.git(["checkout", "--detach", "-q", original]);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(f.git(["rev-parse", "HEAD"]), original);
  const replacementTree = f.git(["rev-parse", "HEAD^{tree}"]);
  assert.notEqual(replacementTree, f.git(["--no-replace-objects", "rev-parse", "HEAD^{tree}"]));
  const misleading = { ...f.plan, sourceTree: replacementTree };
  assert.throws(() => releaseImageSafety.verifyCleanSource(misleading, f.options.execute), { code: "release_source_changed" });
  await assert.rejects(runFullWebBuild({ ...f.options, plan: misleading }), { code: "release_source_changed" });
  assert.equal(fs.existsSync(f.plan.evidenceDir), false);
});

test("a real 80 MiB child burst hard-caps build.log, terminates its group and preserves unrelated work", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const unrelated = releaseImageSafety.spawnOwnedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], "ignore");
  t.after(() => unrelated.kill("SIGKILL"));
  const signals = [];
  let burst;
  const pidFile = path.join(f.root, "descendant.pid");
  let maximumChunk = 0;
  await assert.rejects(runFullWebBuild({ ...f.options, checkOnly: false, spawn: () => {
    burst = releaseImageSafety.spawnOwnedProcess(process.execPath, ["-e", `
      const fs=require('node:fs'); const cp=require('node:child_process');
      const descendant=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
      fs.writeFileSync(process.argv[1],String(descendant.pid));
      const data=Buffer.alloc(1024*1024,120); for(let i=0;i<80;i++)fs.writeSync(i%2?2:1,data);
      setInterval(()=>{},1000);
    `, pidFile], ["ignore", "pipe", "pipe"]);
    for (const stream of [burst.stdout, burst.stderr]) stream.on("data", bytes => { maximumChunk = Math.max(maximumChunk, bytes.length); });
    const kill = burst.kill;
    burst.kill = signal => { signals.push(signal); return kill(signal); };
    return burst;
  } }), { code: "release_log_limit" });
  assert.equal(fs.statSync(path.join(f.plan.evidenceDir, "build.log")).size, LOG_LIMIT);
  assert.ok(maximumChunk <= 1024 * 1024, "pipe chunks remain bounded before the sink sees them");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(burst.exitCode !== null || burst.signalCode !== null);
  assert.equal(process.kill(unrelated.pid, 0), true);
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  const terminated = () => {
    try {
      process.kill(descendant, 0);
      return process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${descendant}/stat`, "utf8"));
    } catch (error) { if (["ESRCH", "ENOENT"].includes(error.code)) return true; throw error; }
  };
  for (let attempt = 0; attempt < 50 && !terminated(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(terminated(), true);
  const report = JSON.parse(fs.readFileSync(path.join(f.plan.evidenceDir, "calibration.json"), "utf8"));
  assert.equal(report.completed, false); assert.equal(report.publicationAllowed, false);
  assert.equal(report.errorCode, "release_log_limit");
  assert.equal(f.calls.some(call => call.includes(f.plan.image) && call.includes("inspect")), false);
});
