import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn as spawnLocal, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { aggregateCapacity, runReleaseImages, runMonitoredOperation } from "../../../scripts/ops/release-images.mjs";

const GiB = 1024 ** 3;
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const imageId = `sha256:${"c".repeat(64)}`;
const revision = "a".repeat(40);
const tree = "b".repeat(40);
const endpoint = `unix://${path.join(os.homedir(), ".colima/evimed-builder/docker.sock")}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = (name, data) => {
    const file = path.join(root, name);
    const body = typeof data === "string" ? data : JSON.stringify(data);
    fs.writeFileSync(file, body);
    return { file, sha256: digest(body) };
  };
  const base = `example.invalid/runtime@sha256:${"d".repeat(64)}`;
  const input = artifact("package-lock.json", "frozen dependency input");
  const dockerfile = artifact("Dockerfile", `FROM ${base}\nCOPY source.mjs /app/source.mjs\nRUN node --check /app/source.mjs\n`);
  artifact("source.mjs", "export const version = 2;\n");
  const evidence = artifact("smoke.json", {
    endpoint, engineId: "builder-engine", platform: "linux/amd64", baseReference: base,
    nodeVersion: "v22.22.0", nodeExitCode: 0, buildRunExitCode: 0,
  });
  const roles = ["host-source", "host-builder", "host-tmp", "engine-root", "engine-docker", "engine-containerd", "engine-tmp"];
  const peaks = Object.fromEntries(roles.map((role) => [role, 10_000_000]));
  const budget = artifact("measurement.json", { operation: "build", component: "runtime", platform: "linux/amd64", sourceRevision: revision, engineId: "builder-engine", peaks, recipeSha256: dockerfile.sha256, baseReference: base, dependencyInputs: { "package-lock.json": input.sha256 } });
  const plan = {
    operation: "build", component: "runtime", platform: "linux/amd64", sourceRevision: revision,
    target: { context: "colima-evimed-builder", endpoint, engineId: "builder-engine", engineName: "colima-evimed-builder", hostName: os.hostname(), servingHostName: "serving-host" },
    floorBytes: 5 * GiB, growthReserveBytes: 100_000_000, measurement: budget,
    sourceRoot: root, sourceTree: tree, inputs: [input], dockerfile,
    base: { reference: base, imageId, dependencyInputs: { "package-lock.json": input.sha256 } },
    platformSmoke: evidence, image: "evimed/runtime:release-test", metadataFile: path.join(root, "buildkit.json"),
  };
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      if (args.includes("HEAD^{tree}")) return tree;
      if (args.includes("HEAD")) return revision;
      return "";
    }
    if (command === "docker" && args.includes("context")) return endpoint;
    if (command === "docker" && args.includes("info")) return JSON.stringify({ ID: "builder-engine", Name: "colima-evimed-builder", OSType: "linux", DockerRootDir: "/var/lib/docker", Architecture: "aarch64" });
    if (command === "docker" && args.includes("ls")) return "";
    if (command === "docker" && args.includes("buildx")) return JSON.stringify({ Driver: "docker", Nodes: [{ Endpoint: "colima-evimed-builder" }] });
    if (command === "docker" && args.includes("inspect")) return JSON.stringify([{ Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [base], RootFS: { Layers: [`sha256:${"e".repeat(64)}`] } }]);
    throw new Error("Unexpected fixture command");
  };
  const sample = () => roles.map((role) => ({ role, filesystem: role.startsWith("host") ? "host:1" : "engine:1", availableBytes: 20 * GiB }));
  const options = { plan, checkOnly: true, execute, sample, platform: "darwin", hostName: os.hostname(), onCheck: () => {} };
  return { plan, options, calls, artifact, sample, root };
}

test("capacity counts a shared filesystem once and sums its operation footprints", () => {
  const checks = aggregateCapacity([
    { role: "docker", filesystem: "engine:1", availableBytes: 8 * GiB },
    { role: "tmp", filesystem: "engine:1", availableBytes: 8 * GiB },
  ], { docker: GiB, tmp: GiB }, 5 * GiB, GiB);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].availableBytes, 8 * GiB);
  assert.equal(checks[0].requiredBytes, 8 * GiB);
  assert.throws(() => aggregateCapacity([
    { role: "docker", filesystem: "engine:1", availableBytes: 7 * GiB },
    { role: "tmp", filesystem: "engine:1", availableBytes: 7 * GiB },
  ], { docker: GiB, tmp: GiB }, 5 * GiB, GiB), { code: "release_capacity_insufficient" });
});

test("4.2 GB free refuses a build with zero Docker write calls", async (t) => {
  const f = fixture(t);
  await assert.rejects(runReleaseImages({ ...f.options, checkOnly: false,
    sample: () => f.sample().map((item) => ({ ...item, availableBytes: 4_200_000_000 })),
    spawn: () => assert.fail("No write operation is admissible"),
  }), { code: "release_capacity_insufficient" });
  assert.equal(f.calls.some((call) => call.includes("build") || call.includes("pull")), false);
});

test("default context, serving host, wrong platform, absent evidence and invalid budgets refuse before Docker", async (t) => {
  const f = fixture(t);
  for (const mutate of [
    (plan) => { plan.target.context = "colima"; },
    (plan) => { plan.target.endpoint = "unix:///var/run/docker.sock"; },
    (plan) => { plan.target.hostName = "serving-host"; },
    (plan) => { plan.platform = "linux/arm64"; },
    (plan) => { delete plan.platformSmoke; },
    (plan) => { delete plan.measurement; },
    (plan) => { plan.growthReserveBytes = 0; },
    (plan) => { plan.floorBytes = NaN; },
    (plan) => { plan.base.reference = "example.invalid/runtime:latest"; },
  ]) {
    const plan = structuredClone(f.plan);
    mutate(plan);
    await assert.rejects(runReleaseImages({ ...f.options, plan, execute: () => assert.fail("Must refuse before Docker") }));
  }
});

test("engine mismatch and unverified base refuse before an operation starts", async (t) => {
  const f = fixture(t);
  for (const replacement of [
    { ID: "serving-engine", Name: "production", OSType: "linux", DockerRootDir: "/var/lib/docker" },
    [{ Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [] }],
  ]) {
    await assert.rejects(runReleaseImages({ ...f.options, checkOnly: false,
      execute: (command, args) => args.includes(Array.isArray(replacement) ? "inspect" : "info") ? JSON.stringify(replacement) : f.options.execute(command, args),
      spawn: () => assert.fail("A mismatched engine/base cannot build"),
    }));
  }
});

test("a verified isolated delta builds through the checked explicit context and retains native metadata", async (t) => {
  const f = fixture(t);
  const result = await runReleaseImages(f.options);
  assert.equal(result.checked, true);
  assert.deepEqual(result.args.slice(0, 6), ["--context", "colima-evimed-builder", "buildx", "build", "--builder", "colima-evimed-builder"]);
  assert.equal(result.args.includes("--host"), false, "Buildx requires the named context rather than the equivalent --host override");
  for (const call of f.calls.filter(call => call[0] === "docker" && (call.includes("info") || call.includes("image")))) {
    assert.deepEqual(call.slice(1, 3), ["--host", endpoint], "identity reads remain bound to the verified endpoint");
  }
  assert.ok(result.args.includes("--metadata-file"));
  assert.ok(result.args.includes("--load"));
  assert.equal(result.args.some((arg) => /prune|remove|save|load$/.test(arg) && arg !== "--load"), false);
});

test("a delta build refuses a context whose live endpoint mapping changed", async t => {
  const f = fixture(t);
  await assert.rejects(runReleaseImages({ ...f.options, checkOnly: false,
    execute: (command, args, cwd) => command === "docker" && args.includes("context")
      ? "unix:///var/run/docker.sock" : f.options.execute(command, args, cwd),
    spawn: () => assert.fail("The wrong context cannot start a build"),
  }), { code: "release_endpoint_changed" });
});

for (const changed of ["context", "engine"]) test(`delta build rechecks ${changed} synchronously at the child creation boundary`, async t => {
  const f = fixture(t);
  let changedAtLastCheck = false;
  let samples = 0;
  let spawns = 0;
  await assert.rejects(runReleaseImages({ ...f.options, checkOnly: false,
    sample: () => {
      if (++samples === 3) changedAtLastCheck = true;
      return f.sample();
    },
    execute: (command, args, cwd) => {
      const result = f.options.execute(command, args, cwd);
      if (changedAtLastCheck && command === "docker" && changed === "context" && args.includes("context")) return "unix:///var/run/docker.sock";
      if (changedAtLastCheck && command === "docker" && changed === "engine" && args.includes("info")) return JSON.stringify({ ...JSON.parse(result), ID: "replacement-engine" });
      return result;
    },
    spawn: () => { spawns++; assert.fail("Changed builder identity cannot start Docker"); },
  }), { code: "release_child_failed" });
  assert.equal(changedAtLastCheck, true);
  assert.equal(spawns, 0);
});

test("source, dependency and smoke tampering are rejected without a build", async (t) => {
  const f = fixture(t);
  for (const mutate of [
    (plan) => { plan.base.dependencyInputs["package-lock.json"] = `sha256:${"f".repeat(64)}`; },
    (plan) => { plan.sourceTree = "f".repeat(40); },
    (plan) => { plan.platformSmoke.sha256 = `sha256:${"f".repeat(64)}`; },
  ]) {
    const plan = structuredClone(f.plan); mutate(plan);
    await assert.rejects(runReleaseImages({ ...f.options, plan }));
  }
});

test("capacity crossing gracefully stops only the owned child, escalates boundedly, and fails", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.pid = 123;
  child.kill = (signal) => { signals.push(signal); if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, signal)); return true; };
  let samples = 0;
  await assert.rejects(runMonitoredOperation({
    args: ["--context", "colima-evimed-builder", "buildx", "build"], spawn: () => child,
    check: () => { samples += 1; if (samples > 1) throw Object.assign(new Error("Reserve crossed"), { code: "release_capacity_insufficient" }); },
    intervalMs: 5, stopGraceMs: 10, timeoutMs: 1000,
  }), { code: "release_capacity_insufficient" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("monitor also fails closed on unreadable capacity and never exposes child output", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.kill = () => { queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; };
  let samples = 0;
  await assert.rejects(runMonitoredOperation({ args: [], spawn: () => child,
    check: () => { if (++samples > 1) throw new Error("Secret-bearing provider output"); },
    intervalMs: 5, stopGraceMs: 10, timeoutMs: 1000,
  }), (error) => error.code === "release_capacity_unreadable" && !error.message.includes("Secret-bearing"));
});

function pullFixture(t) {
  const f = fixture(t);
  const layer = `sha256:${"e".repeat(64)}`;
  const config = JSON.stringify({ os: "linux", architecture: "amd64", config: { Labels: { "org.opencontainers.image.revision": revision } }, rootfs: { type: "layers", diff_ids: [layer] } });
  const configId = digest(config);
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: configId, size: config.length }, layers: [{ digest: `sha256:${"f".repeat(64)}`, size: 1234 }] });
  const image = `127.0.0.1:5001/evimed/runtime@${digest(manifest)}`;
  const plan = {
    operation: "pull", component: "runtime", platform: "linux/amd64", sourceRevision: revision, image, configDigest: configId,
    target: { endpoint: "unix:///var/run/docker.sock", engineId: "serving-engine", engineName: "serving-host", hostName: "serving-host" },
    floorBytes: GiB, growthReserveBytes: GiB,
    transferEvidence: f.artifact("transfer.json", { registryImage: `docker.m.daocloud.io/library/registry@sha256:${"1".repeat(64)}`, bindAddress: "127.0.0.1", forwardBindAddress: "127.0.0.1", reverseForwardVerified: true, image, sourceRevision: revision, engineId: "serving-engine" }),
    releaseSmoke: f.artifact("release-smoke.json", { sourceRevision: revision, configDigest: configId, originalSmokePassed: true, profileSeedCopiesVerified: true, resealed: true, rootFsPrefixVerified: true }),
    measurement: f.artifact("pull-measurement.json", { operation: "pull", component: "runtime", platform: "linux/amd64", image, configDigest: configId, engineId: "serving-engine", sourceRevision: revision, peaks: Object.fromEntries(["engine-root", "engine-docker", "engine-containerd", "engine-tmp"].map((role) => [role, 1000])) }),
  };
  const writes = [];
  const options = {
    plan, platform: "linux", hostName: "serving-host",
    sample: () => f.sample().filter((item) => item.role.startsWith("engine")),
    fetchImpl: async (url, options) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:5001\/v2\/evimed\/runtime\//);
      assert.equal(options.redirect, "error");
      return new Response(url.includes("/manifests/") ? manifest : config);
    },
    execute: (_command, args) => args.includes("info")
      ? JSON.stringify({ ID: "serving-engine", Name: "serving-host", OSType: "linux", DockerRootDir: "/var/lib/docker", Architecture: "amd64" })
      : JSON.stringify([{ Id: configId, Os: "linux", Architecture: "amd64", RepoDigests: [image], Config: { Labels: { "org.opencontainers.image.revision": revision } }, RootFS: { Layers: [layer] } }]),
    spawn: (args) => { writes.push(args); const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit("exit", 0)); return child; },
  };
  return { ...f, plan, options, writes, config, manifest };
}

test("layer-wise digest pull validates standard registry bytes and received image identities", async (t) => {
  const f = pullFixture(t);
  const result = await runReleaseImages(f.options);
  assert.equal(result.completed, true);
  assert.equal(result.configDigest, f.plan.configDigest);
  assert.deepEqual(f.writes, [["--host", "unix:///var/run/docker.sock", "pull", "--platform", "linux/amd64", f.plan.image]]);
});

test("missing registry metadata, non-loopback references, and corrupt manifests refuse before pull", async (t) => {
  const f = pullFixture(t);
  for (const mutate of [
    (plan) => { delete plan.transferEvidence; },
    (plan) => { delete plan.releaseSmoke; },
    (plan) => { plan.image = plan.image.replace("127.0.0.1", "0.0.0.0"); },
    (plan) => { plan.image = plan.image.split("@")[0] + ":latest"; },
  ]) {
    const plan = structuredClone(f.plan); mutate(plan);
    await assert.rejects(runReleaseImages({ ...f.options, plan }));
  }
  await assert.rejects(runReleaseImages({ ...f.options, fetchImpl: async () => new Response("corrupt manifest") }), { code: "release_registry_digest" });
  assert.equal(f.writes.length, 0);
});

test("a pulled image with the wrong config or rootfs cannot report completion", async (t) => {
  const f = pullFixture(t);
  await assert.rejects(runReleaseImages({ ...f.options, execute: (command, args) => {
    const original = f.options.execute(command, args);
    if (!args.includes("inspect")) return original;
    const images = JSON.parse(original); images[0].RootFS.Layers = [imageId];
    return JSON.stringify(images);
  } }), { code: "release_result_invalid" });
  assert.equal(f.writes.length, 1);
});

test("a higher configured floor, missing planes and invalid observations fail closed", () => {
  assert.throws(() => aggregateCapacity([{ role: "tmp", filesystem: "1", availableBytes: 9 * GiB }], { tmp: GiB }, 10 * GiB, GiB), { code: "release_capacity_insufficient" });
  for (const samples of [
    [], [{ role: "tmp", filesystem: "1", availableBytes: NaN }],
    [{ role: "tmp", filesystem: "1", availableBytes: 20 * GiB }, { role: "tmp", filesystem: "1", availableBytes: 20 * GiB }],
  ]) assert.throws(() => aggregateCapacity(samples, { tmp: GiB }, 5 * GiB, GiB), { code: "release_budget_invalid" });
});

test("child failure and timeout remain bounded without deleting image/cache/volume state", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.kill = (signal) => { signals.push(signal); queueMicrotask(() => child.emit("exit", null, signal)); return true; };
  await assert.rejects(runMonitoredOperation({ args: [], check: () => {}, spawn: () => child, intervalMs: 5, stopGraceMs: 5, timeoutMs: 10 }), { code: "release_timeout" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(runMonitoredOperation({ args: [], check: () => {}, spawn: () => { const failed = new EventEmitter(); queueMicrotask(() => failed.emit("exit", 7)); return failed; } }), { code: "release_child_failed" });
});

test("containerd index IDs are not confused with config IDs during a verified pull", async (t) => {
  const f = pullFixture(t);
  const localIndexId = `sha256:${"9".repeat(64)}`;
  const result = await runReleaseImages({ ...f.options, execute: (command, args) => {
    const original = f.options.execute(command, args);
    if (!args.includes("inspect")) return original;
    const images = JSON.parse(original); images[0].Id = localIndexId;
    return JSON.stringify(images);
  } });
  assert.equal(result.localImageId, localIndexId);
  assert.equal(result.configDigest, f.plan.configDigest);
  assert.notEqual(result.localImageId, result.configDigest);
});

test("a real added layer can complete an isolated build while preserving native metadata", async (t) => {
  const f = fixture(t);
  const localId = `sha256:${"8".repeat(64)}`;
  const configDigest = `sha256:${"7".repeat(64)}`;
  const metadata = { "containerimage.digest": `sha256:${"6".repeat(64)}`, "containerimage.config.digest": configDigest, "buildx.build.ref": "native-build-ref" };
  let built = false;
  const result = await runReleaseImages({ ...f.options, checkOnly: false,
    execute: (command, args) => {
      if (built && args.includes("inspect") && args.includes(f.plan.image)) return JSON.stringify([{ Id: localId, Descriptor: { digest: metadata["containerimage.digest"] }, Os: "linux", Architecture: "amd64", Config: { Labels: { "org.opencontainers.image.revision": revision } }, RootFS: { Layers: [`sha256:${"e".repeat(64)}`, `sha256:${"5".repeat(64)}`] } }]);
      return f.options.execute(command, args);
    },
    spawn: (args) => {
      assert.ok(args.includes("--network"));
      assert.equal(args[args.indexOf("--network") + 1], "none");
      fs.writeFileSync(f.plan.metadataFile, JSON.stringify(metadata)); built = true;
      const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit("exit", 0)); return child;
    },
  });
  assert.equal(result.completed, true);
  assert.equal(result.localImageId, localId);
  assert.equal(result.configDigest, configDigest);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.plan.metadataFile)), metadata);
});

test("an existing candidate tag is preserved, including current/rollback references", async (t) => {
  const f = fixture(t);
  await assert.rejects(runReleaseImages({ ...f.options, checkOnly: false,
    execute: (command, args) => args.includes("ls") ? imageId : f.options.execute(command, args),
    spawn: () => assert.fail("Existing candidate tags are never overwritten"),
  }), { code: "release_tag_exists" });
});

function replaceRecipe(f, recipe) {
  f.plan.dockerfile = f.artifact("Dockerfile", recipe);
  const measurement = JSON.parse(fs.readFileSync(f.plan.measurement.file));
  measurement.recipeSha256 = f.plan.dockerfile.sha256;
  f.plan.measurement = f.artifact("measurement.json", measurement);
}

test("review regression: every extra image/frontend recipe resource refuses before Docker", async (t) => {
  const f = fixture(t);
  for (const recipe of [
    `FROM ${f.plan.base.reference}\nCOPY source.mjs /app/source.mjs\nFROM --platform=linux/amd64 ubuntu:latest\n`,
    `FROM ${f.plan.base.reference}\nCOPY --from=ubuntu:latest /etc/os-release /app/base\n`,
    `# syntax=docker/dockerfile:1\nFROM ${f.plan.base.reference}\nCOPY source.mjs /app/source.mjs\n`,
    `FROM ${f.plan.base.reference}\nRUN --mount=type=bind,from=ubuntu:latest,target=/other cat /other/file\nCOPY source.mjs /app/source.mjs\n`,
    `FROM ${f.plan.base.reference}\nCOPY <<EOF_MARKER /app/file\nhello\nEOF_MARKER\n`,
    `FROM ${f.plan.base.reference}\nCOPY ["https://example.invalid/source", "/app/file"]\n`,
    `FROM ${f.plan.base.reference}\n# ordinary comment \\\nFROM --platform=linux/amd64 ubuntu:latest\nCOPY source.mjs /app/source.mjs\n`,
    `FROM ${f.plan.base.reference}\nCOPY \\\n--from=ubuntu:latest /etc/os-release /app/base\n`,
    `# escape=\x60\nFROM ${f.plan.base.reference}\nCOPY source.mjs /app/source.mjs\n`,
  ]) {
    replaceRecipe(f, recipe);
    const count = f.calls.length;
    await assert.rejects(runReleaseImages(f.options), { code: "release_delta_invalid" });
    assert.equal(f.calls.slice(count).some((call) => call[0] === "docker"), false);
  }
});

test("review regression: canonical duplicate input paths cannot hide an omitted dependency", async (t) => {
  const f = fixture(t);
  const second = f.artifact("deps-version.json", "base dependency B differs from the candidate");
  f.plan.base.dependencyInputs["deps-version.json"] = second.sha256;
  const original = f.plan.inputs[0];
  // These two distinct spellings identify A twice, leaving B unchecked.
  f.plan.inputs = [original, { ...original, file: `${f.root}/./package-lock.json` }];
  const measurement = JSON.parse(fs.readFileSync(f.plan.measurement.file));
  measurement.dependencyInputs = f.plan.base.dependencyInputs;
  f.plan.measurement = f.artifact("measurement.json", measurement);
  await assert.rejects(runReleaseImages(f.options), { code: "release_dependency_changed" });
  assert.equal(f.calls.some((call) => call[0] === "docker"), false);
});

test("review regression: a FIFO plan fails promptly instead of blocking on open", (t) => {
  const f = fixture(t);
  const fifo = path.join(f.root, "plan.fifo");
  const makeFifo = spawnSync("mkfifo", [fifo], { timeout: 1000, stdio: "ignore" });
  assert.equal(makeFifo.status, 0);
  const script = new URL("../../../scripts/ops/release-images.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, "check-build", "--plan", fifo], { timeout: 800, encoding: "utf8" });
  assert.equal(result.error, undefined, "metadata admission must not need the outer timeout");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release_metadata_invalid/);
});

test("review regression: a dangling metadata-output symlink refuses before Docker", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, "missing-output"), f.plan.metadataFile);
  await assert.rejects(runReleaseImages(f.options), { code: "release_metadata_invalid" });
  assert.equal(f.calls.some((call) => call[0] === "docker"), false);
});

test("review regression: cancellation escalates the owned group after its leader exits", { timeout: 4000 }, async (t) => {
  const descendantCode = "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000);";
  const leaderCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio:['ignore','inherit','ignore']}); setInterval(() => {}, 1000);`;
  const leader = spawnLocal(process.execPath, ["-e", leaderCode], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const unrelated = spawnLocal(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); return true; } catch { return false; } };
  t.after(() => { signalGroup(leader.pid, "SIGKILL"); signalGroup(unrelated.pid, "SIGKILL"); });
  const [ready] = await once(leader.stdout, "data");
  const descendantPid = Number(ready.toString().trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
  const signals = [];
  leader.kill = (signal) => { signals.push(signal); return signalGroup(leader.pid, signal); };
  let count = 0;
  await assert.rejects(runMonitoredOperation({
    args: [], spawn: () => leader, intervalMs: 5, stopGraceMs: 50, timeoutMs: 1000,
    check: () => { if (++count > 1) throw Object.assign(new Error("capacity"), { code: "release_capacity_insufficient" }); },
  }), { code: "release_capacity_insufficient" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "leader exit must not cancel descendant escalation");
  const descendantState = spawnSync("ps", ["-o", "stat=", "-p", String(descendantPid)], { encoding: "utf8", timeout: 500 });
  assert.ok(descendantState.status === 1 || /^\s*Z/.test(descendantState.stdout), "the descendant must no longer be running");
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "an unrelated process group must remain alive");
});

test("supported recipe retains multiple local COPY and fixed seed/reseal/smoke RUNs", async (t) => {
  const f = fixture(t);
  f.artifact("patch-seed.mjs", "export const verified = true;\n");
  replaceRecipe(f, `# Local release recipe\nFROM ${f.plan.base.reference}\nWORKDIR /app\nCOPY source.mjs /app/source.mjs\nCOPY --chmod=0755 ["patch-seed.mjs", "/opt/patch-seed.mjs"]\nRUN node /opt/patch-seed.mjs \\\n  && node /opt/reseal.mjs \\\n  && node /opt/build-smoke.mjs\nLABEL io.evimed.purpose=release\n`);
  const result = await runReleaseImages(f.options);
  assert.equal(result.checked, true);
  assert.equal(result.args[result.args.indexOf("--network") + 1], "none");
});

test("regular metadata larger than the file bound is rejected before parsing", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "oversized-plan.json");
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 ** 2 + 1));
  const script = new URL("../../../scripts/ops/release-images.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, "check-build", "--plan", file], { timeout: 800, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release_metadata_invalid/);
});
