import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { RuntimeManager, requestRuntime } from "../src/runtimeManager.mjs";
import { RuntimeControllerClient } from "../src/runtimeControllerClient.mjs";
import { createRuntimeController } from "../src/runtimeControllerServer.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { runtimeReleaseConfig } from "./releaseFixture.mjs";

/**
 * Removes a test's temp tree, tolerating a child that is still exiting.
 *
 * `rm` does not retry by default, so a controller subprocess that writes its
 * last socket file between the recursive walk and the final `rmdir` fails the
 * whole test with `ENOTEMPTY` — a cleanup race reported as a product failure,
 * which is the kind of flake people learn to rerun past.
 *
 * @param {string} dir
 */
function removeTree(dir) {
  return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}


async function shortTempDir(prefix) {
  const compactPrefix = `${prefix.at(0) ?? "o"}-`;
  return realpath(await mkdtemp(path.join(await realpath("/tmp"), compactPrefix)));
}

async function supportsRuntimeSocket(project) {
  const socketPath = path.join(project.runtimeDir, "container-runtime", "control", "opencode.sock");
  await mkdir(path.dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });
  const server = net.createServer();
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    listening = true;
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (error) => {
        socket.destroy();
        if (error?.code === "EINVAL" && error?.syscall === "connect") {
          resolve(false);
          return;
        }
        reject(error);
      });
    });
  } catch (error) {
    if (error?.code === "EINVAL" && error?.syscall === "connect") {
      return false;
    }
    throw error;
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
}

async function skipUnsupportedRuntimeSocket(t, project) {
  if (await supportsRuntimeSocket(project)) return false;
  t.skip("This host rejects the temporary Unix runtime socket path with EINVAL.");
  return true;
}

async function fakeDocker(root) {
  const bin = path.join(root, "fake-controller-docker.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";


async function main() {
const args = process.argv.slice(2);
const stateRoot = process.env.FAKE_DOCKER_STATE;
const volumeRoot = process.env.FAKE_VOLUME_ROOT;
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
fs.mkdirSync(stateRoot, { recursive: true });
const nameAt = args.indexOf("--name");
const name = nameAt >= 0 ? args[nameAt + 1] : "";
const owner = args.find((arg) => arg.startsWith("open-science.user="))?.slice("open-science.user=".length) ?? "";
const stateFile = (containerName) => path.join(stateRoot, encodeURIComponent(containerName) + ".json");
const readState = (containerName) => {
  try { return JSON.parse(fs.readFileSync(stateFile(containerName), "utf8")); } catch { return null; }
};
const writeState = (containerName, value) => fs.writeFileSync(stateFile(containerName), JSON.stringify(value));

if (args[0] === "info") {
  process.stdout.write("26.1.4\\n");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  // Answers per placeholder, as docker does. A fixed field count misaligns the
  // moment the reader asks for one more, and then every assertion downstream
  // measures the misalignment instead of the thing under test.
  //
  // This image publishes both labels: it stands for an image built after the
  // neutral label landed, so the controller's preferred reading is the one
  // exercised here while server.test.mjs covers the rollback fallback.
  // (No backticks in this comment: it lives inside a template literal, and the
  // first version of it terminated the string that generates this file.)
  const labels = {
    "io.open-science.runtime.version": "1.17.13",
    "io.open-science.runtime.kernel": "opencode",
    "io.open-science.opencode.version": "1.17.13",
    "io.open-science.uv.version": "0.11.26",
  };
  const format = args[args.indexOf("--format") + 1] ?? "";
  process.stdout.write(format.split("|").map((token) => {
    if (token === "{{.Id}}") return "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const label = token.match(/"([^"]+)"/)?.[1];
    return label && Object.hasOwn(labels, label) ? labels[label] : "";
  }).join("|") + "\\n");
  process.exit(0);
}
if (args[0] === "ps") {
  const filterAt = args.indexOf("--filter");
  const filter = filterAt >= 0 ? args[filterAt + 1] : "";
  for (const file of fs.readdirSync(stateRoot)) {
    if (!file.endsWith(".json")) continue;
    const state = readState(decodeURIComponent(file.slice(0, -5)));
    const selected = filter === "label=open-science.web.runtime=true"
      ? state?.runtime
      : filter === "label=open-science.web.kernel=true"
        ? state?.kernel
        : false;
    if (!selected || !state.pid || !state.containerName || !state.userId) continue;
    try {
      process.kill(state.pid, 0);
      process.stdout.write(state.containerName + "|" + state.userId + "\\n");
    } catch {}
  }
  process.exit(0);
}
if (args[0] === "rm" && args[1] === "-f") {
  const delayMs = Number(process.env.FAKE_DOCKER_RM_DELAY_MS) || 0;
  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  const containerName = args[2];
  if (process.env.FAKE_DOCKER_RM_FAIL_NAME === containerName) {
    process.stderr.write("Error: forced container cleanup failure\\n");
    process.exit(3);
  }
  const state = readState(containerName);
  if (!state?.pid) {
    process.stderr.write("Error: No such container: " + containerName + "\\n");
    process.exit(1);
  }
  try { process.kill(state.pid, "SIGTERM"); } catch {}
  writeState(containerName, { state: "missing", exitCode: 0 });
  process.stdout.write(containerName + "\\n");
  process.exit(0);
}
if (args[0] === "container" && args[1] === "inspect") {
  const containerName = args.at(-1);
  const state = readState(containerName);
  if (!state?.pid) {
    process.stderr.write("Error: No such container: " + containerName + "\\n");
    process.exit(1);
  }
  try {
    process.kill(state.pid, 0);
    process.stdout.write("running|0\\n");
    process.exit(0);
  } catch {
    process.stderr.write("Error: No such container: " + containerName + "\\n");
    process.exit(1);
  }
}
if (args[0] !== "run" || !name) process.exit(2);

if (args.includes("open-science.web.kernel=true")) {
  let code = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { code += chunk; });
  process.stdin.on("end", () => {
    writeState(name, { pid: process.pid, state: "running", kernel: true, containerName: name, userId: owner });
    if (code.startsWith("SLEEP")) {
      setTimeout(() => process.stdout.write("late\\n"), 30_000);
      return;
    }
    process.stdout.write("kernel:" + code.trim() + "\\n");
  });
  const stop = () => process.exit(137);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return;
}

const mount = args.find((arg) => arg.includes(",dst=/runtime-control"));
if (!mount) process.exit(3);
const fields = Object.fromEntries(mount.split(",").map((part) => {
  const index = part.indexOf("=");
  return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
}));
const runtimeRoot = fields.type === "volume"
  ? path.join(volumeRoot, fields["volume-subpath"])
  : fields.src;
const socketPath = path.join(runtimeRoot, "opencode.sock");
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
writeState(name, { pid: process.pid, state: "running", runtime: true, containerName: name, userId: owner });
// A container that says something and dies, which is the only case whose
// output is a diagnosis. Both streams, because the kernel's startup failures
// come out on stdout as often as stderr.
if (process.env.FAKE_RUNTIME_DIES) {
  process.stdout.write("dsh: seeded profile failed to boot\\n");
  process.stderr.write("Error: mount denied for /workspace\\n");
  writeState(name, { state: "exited", exitCode: 9, containerName: name, userId: owner });
  setTimeout(() => process.exit(9), 50);
  return;
}
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/config")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
const stop = () => server.close(() => {
  fs.rmSync(socketPath, { force: true });
  writeState(name, { state: "missing", exitCode: 0 });
  process.exit(0);
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(socketPath);
}
await main();
`,
    { mode: 0o755 },
  );
  return bin;
}

async function projectTree(dataDir, userId = "alice", projectId = "paper1") {
  const rootDir = path.join(dataDir, "users", userId, "projects", projectId);
  const baseDir = path.join(rootDir, "workspace");
  const runtimeDir = path.join(rootDir, "runtime");
  const metaDir = path.join(rootDir, ".openscience");
  await Promise.all([
    mkdir(baseDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(metaDir, { recursive: true }),
  ]);
  return {
    id: projectId,
    userId,
    activeWorkspace: "",
    rootDir,
    baseDir,
    workspaceDir: baseDir,
    runtimeDir,
    metaDir,
  };
}

function controllerConfig({ dataDir, socketPath, dockerBin, enableKernel = true }) {
  return {
    ...runtimeReleaseConfig,
    production: true,
    releaseId: runtimeReleaseConfig.releaseManifest.app.releaseId,
    sourceRevision: runtimeReleaseConfig.releaseManifest.source.revision,
    buildCreatedAt: runtimeReleaseConfig.releaseManifest.source.createdAt,
    webContainerImage: runtimeReleaseConfig.releaseManifest.web.image,
    dataDir,
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    runtimeControllerMode: "direct",
    runtimeControllerSocket: socketPath,
    runtimeContainerBin: dockerBin,
    runtimeDataVolume: "controller-test-data",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    runtimeNoNewPrivileges: true,
    runtimeCapDrop: "ALL",
    runtimeReadOnlyRoot: true,
    runtimeTmpfs: "/tmp:rw,nosuid,nodev,size=16m",
    runtimeContainerUser: "",
    runtimeRequireImageLocal: true,
    allowRuntimeHostNetwork: false,
    allowRuntimeNetworkEgress: false,
    runtimeNetworkEgressPolicyAck: false,
    enableKernel,
    kernelSandboxMode: "docker",
    maxJsonBytes: 1024 * 1024,
    maxKernelOutputBytes: 64 * 1024,
    kernelTimeoutMs: 1_000,
    maxConcurrentKernels: 2,
    maxConcurrentKernelsPerUser: 1,
    maxRunningRuntimes: 8,
    maxRunningRuntimesPerUser: 4,
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for runtime controller state.");
}

test("isolated runtime controller starts, probes, and stops a project runtime", async (t) => {
  const tmp = await shortTempDir("osrc-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const project = await projectTree(dataDir);
  if (await skipUnsupportedRuntimeSocket(t, project)) {
    await removeTree(tmp);
    return;
  }
  const previousState = process.env.FAKE_DOCKER_STATE;
  const previousVolume = process.env.FAKE_VOLUME_ROOT;
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    const manager = new RuntimeManager({
      ...controllerConfig({ dataDir, socketPath, dockerBin }),
      runtimeControllerMode: "socket",
      runtimeControllerTimeoutMs: 2_000,
      runtimeControllerPollMs: 100,
      allowDirectDockerControl: false,
      runtimeProxyConnectTimeoutMs: 3_000,
      runtimeSkillDirs: [],
      maxProjectBytes: 1024 * 1024,
      maxProjectUsageScanEntries: 1_000,
      runtimeIdleTimeoutMs: 0,
      runtimeQuotaCheckIntervalMs: 0,
      maxLogFileBytes: 1024 * 1024,
    });
    const runtime = await manager.start(project);
    assert.equal(runtime.sandboxMode, "docker");
    assert.equal(runtime.pid, null);
    const response = await requestRuntime(runtime, "/config");
    assert.equal(response.status, 200);
    assert.deepEqual(await new Response(response.body).json(), { ready: true });
    await manager.stop(project);
    const status = await manager.runtimeController.runtimeStatus(project);
    assert.equal(status.running, false);
    assert.equal(status.state, "missing");
    await manager.closeAll();
  } finally {
    await controller.close().catch(() => {});
    if (previousState == null) delete process.env.FAKE_DOCKER_STATE;
    else process.env.FAKE_DOCKER_STATE = previousState;
    if (previousVolume == null) delete process.env.FAKE_VOLUME_ROOT;
    else process.env.FAKE_VOLUME_ROOT = previousVolume;
    await removeTree(tmp);
  }
});

test("runtime controller cannot replace an active controller socket", async () => {
  const tmp = await shortTempDir("osra-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  await mkdir(dataDir, { recursive: true });
  const first = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  const second = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await first.listen();
    await assert.rejects(
      second.listen(),
      (error) => error?.status === 409 && error?.code === "runtime_controller_already_running",
    );
    await second.close();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 2_000,
    });
    const health = await client.health();
    assert.equal(health.protocolVersion, 2);
  } finally {
    await second.close().catch(() => {});
    await first.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("runtime controller cleans a runtime when the start client disconnects", async (t) => {
  const tmp = await shortTempDir("osrd-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerLog = path.join(tmp, "docker.log");
  const dockerBin = await fakeDocker(tmp);
  const project = await projectTree(dataDir);
  if (await skipUnsupportedRuntimeSocket(t, project)) {
    await removeTree(tmp);
    return;
  }
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.FAKE_DOCKER_RM_DELAY_MS = "250";
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 2_000,
      maxJsonBytes: 1024 * 1024,
    });
    const abort = new AbortController();
    const pending = client.request(
      "POST",
      "/v1/runtime/start",
      {
        userId: project.userId,
        projectId: project.id,
        activeWorkspace: project.activeWorkspace,
        port: 49152,
        password: "pw_abcdefghijklmnopqrstuvwxyz",
      },
      { signal: abort.signal },
    );
    await waitFor(async () => {
      const log = await readFile(dockerLog, "utf8").catch(() => "");
      return log.split("\n").some((line) => line && JSON.parse(line)[0] === "rm");
    });
    abort.abort();
    await assert.rejects(
      pending,
      (error) => error?.name === "AbortError",
    );
    await waitFor(async () => {
      const log = await readFile(dockerLog, "utf8").catch(() => "");
      const invocations = log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const runCount = invocations.filter((args) => args[0] === "run").length;
      const cleanupCount = invocations.filter((args) => args[0] === "rm" && args[1] === "-f").length;
      return runCount === 1 && cleanupCount >= 2;
    });
    let status;
    await waitFor(async () => {
      status = await client.runtimeStatus(project);
      return !status.running;
    });
    assert.equal(status.state, "missing");
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    delete process.env.FAKE_DOCKER_LOG;
    delete process.env.FAKE_DOCKER_RM_DELAY_MS;
    await removeTree(tmp);
  }
});

test("runtime controller serializes start and cleanup for the same project", async (t) => {
  const tmp = await shortTempDir("osrs-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerLog = path.join(tmp, "docker.log");
  const dockerBin = await fakeDocker(tmp);
  const project = await projectTree(dataDir);
  if (await skipUnsupportedRuntimeSocket(t, project)) {
    await removeTree(tmp);
    return;
  }
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.FAKE_DOCKER_RM_DELAY_MS = "250";
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 3_000,
    });
    const starting = client.startRuntime(project, 49152, "pw_abcdefghijklmnopqrstuvwxyz");
    await waitFor(async () => {
      const log = await readFile(dockerLog, "utf8").catch(() => "");
      return log.split("\n").some((line) => line && JSON.parse(line)[0] === "rm");
    });
    const cleaning = client.cleanupRuntime(project);
    await Promise.all([starting, cleaning]);
    const status = await client.runtimeStatus(project);
    assert.equal(status.running, false);
    assert.equal(status.state, "missing");
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    delete process.env.FAKE_DOCKER_LOG;
    delete process.env.FAKE_DOCKER_RM_DELAY_MS;
    await removeTree(tmp);
  }
});

test("runtime controller independently enforces global and per-user runtime limits", async (t) => {
  const tmp = await shortTempDir("osrl-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const aliceOne = await projectTree(dataDir, "alice", "paper1");
  const aliceTwo = await projectTree(dataDir, "alice", "paper2");
  const bobOne = await projectTree(dataDir, "bob", "paper1");
  if (await skipUnsupportedRuntimeSocket(t, aliceOne)) {
    await removeTree(tmp);
    return;
  }
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const config = {
    ...controllerConfig({ dataDir, socketPath, dockerBin }),
    maxRunningRuntimes: 2,
    maxRunningRuntimesPerUser: 1,
  };
  const controller = createRuntimeController(config);
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 3_000,
    });
    const health = await client.health();
    assert.equal(health.maxRunningRuntimes, 2);
    assert.equal(health.maxRunningRuntimesPerUser, 1);
    await client.startRuntime(aliceOne, 49152, "pw_abcdefghijklmnopqrstuvwxyz");
    await assert.rejects(
      client.startRuntime(aliceTwo, 49153, "pw_abcdefghijklmnopqrstuvwxyz"),
      (error) => error?.status === 429 && error?.code === "runtime_limit_exceeded",
    );
    await client.startRuntime(bobOne, 49154, "pw_abcdefghijklmnopqrstuvwxyz");
    await assert.rejects(
      client.startRuntime(aliceTwo, 49155, "pw_abcdefghijklmnopqrstuvwxyz"),
      (error) => error?.status === 429 && error?.code === "runtime_limit_exceeded",
    );
    await client.cleanupRuntime(aliceOne);
    await client.cleanupRuntime(bobOne);

    const mismatchedManager = new RuntimeManager({
      ...config,
      runtimeControllerMode: "socket",
      allowDirectDockerControl: false,
      maxRunningRuntimes: 3,
    });
    await assert.rejects(
      mismatchedManager.controllerHealth(),
      (error) => error?.status === 503 && error?.code === "runtime_controller_limit_mismatch",
    );
    await mismatchedManager.closeAll();
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("runtime controller counts Docker-discovered runtimes left by an earlier controller", async () => {
  const tmp = await shortTempDir("osri-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const stateRoot = path.join(tmp, "docker-state");
  const project = await projectTree(dataDir, "bob", "paper1");
  const existingName = "open-science-alice-existing-runtime";
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    path.join(stateRoot, `${encodeURIComponent(existingName)}.json`),
    JSON.stringify({
      pid: process.pid,
      state: "running",
      runtime: true,
      containerName: existingName,
      userId: "alice",
    }),
  );
  process.env.FAKE_DOCKER_STATE = stateRoot;
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const controller = createRuntimeController({
    ...controllerConfig({ dataDir, socketPath, dockerBin }),
    maxRunningRuntimes: 1,
    maxRunningRuntimesPerUser: 1,
  });
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 3_000,
    });
    await assert.rejects(
      client.startRuntime(project, 49152, "pw_abcdefghijklmnopqrstuvwxyz"),
      (error) => error?.status === 429 && error?.code === "runtime_limit_exceeded",
    );
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("runtime controller executes and cancels a bounded Docker kernel", async () => {
  const tmp = await shortTempDir("oskc-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const project = await projectTree(dataDir);
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    const manager = new RuntimeManager({
      ...controllerConfig({ dataDir, socketPath, dockerBin }),
      runtimeControllerMode: "socket",
      runtimeControllerTimeoutMs: 2_000,
      allowDirectDockerControl: false,
    });
    const result = await manager.runControlledKernel(project, "print(42)");
    assert.equal(result.ok, true);
    assert.match(result.stdout, /kernel:print\(42\)/);

    const rResult = await manager.runControlledKernel(project, "cat(mean(c(1, 2, 3)))", undefined, "r");
    assert.equal(rResult.ok, true);
    assert.match(rResult.stdout, /kernel:cat\(mean\(c\(1, 2, 3\)\)\)/);

    const abort = new AbortController();
    const pending = manager.runControlledKernel(project, "SLEEP", abort.signal);
    setTimeout(() => abort.abort(), 50);
    await assert.rejects(pending, (error) => error?.name === "AbortError");
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("runtime controller independently enforces global and per-user kernel limits", async () => {
  const tmp = await shortTempDir("oskl-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerLog = path.join(tmp, "docker.log");
  const dockerBin = await fakeDocker(tmp);
  const aliceOne = await projectTree(dataDir, "alice", "paper1");
  const aliceTwo = await projectTree(dataDir, "alice", "paper2");
  const bobOne = await projectTree(dataDir, "bob", "paper1");
  const carolOne = await projectTree(dataDir, "carol", "paper1");
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  process.env.FAKE_DOCKER_LOG = dockerLog;
  const controller = createRuntimeController({
    ...controllerConfig({ dataDir, socketPath, dockerBin }),
    kernelTimeoutMs: 5_000,
    maxConcurrentKernels: 2,
    maxConcurrentKernelsPerUser: 1,
  });
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 3_000,
      kernelTimeoutMs: 5_000,
    });
    const health = await client.health();
    assert.equal(health.maxConcurrentKernels, 2);
    assert.equal(health.maxConcurrentKernelsPerUser, 1);

    const aliceAbort = new AbortController();
    const aliceKernel = client.runKernel(aliceOne, "SLEEP alice", aliceAbort.signal);
    await waitFor(async () => {
      const log = await readFile(dockerLog, "utf8").catch(() => "");
      return log.includes("open-science.web.kernel=true");
    });
    await assert.rejects(
      client.runKernel(aliceTwo, "print('second')"),
      (error) => error?.status === 429 && error?.code === "kernel_limit_exceeded",
    );

    const bobAbort = new AbortController();
    const bobKernel = client.runKernel(bobOne, "SLEEP bob", bobAbort.signal);
    await waitFor(async () => {
      const log = await readFile(dockerLog, "utf8").catch(() => "");
      return log.split("\n").filter((line) => line.includes("open-science.web.kernel=true")).length >= 2;
    });
    await assert.rejects(
      client.runKernel(carolOne, "print('third')"),
      (error) => error?.status === 429 && error?.code === "kernel_limit_exceeded",
    );

    aliceAbort.abort();
    bobAbort.abort();
    await assert.rejects(aliceKernel, (error) => error?.name === "AbortError");
    await assert.rejects(bobKernel, (error) => error?.name === "AbortError");
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    delete process.env.FAKE_DOCKER_LOG;
    await removeTree(tmp);
  }
});

test("runtime controller removes orphaned kernel containers before listening", async () => {
  const tmp = await shortTempDir("osko-");
  const dataDir = path.join(tmp, "data");
  const stateRoot = path.join(tmp, "docker-state");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const containerName = "open-science-kernel-alice-orphan";
  await mkdir(dataDir, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => sleeper.once("exit", resolve));
  await new Promise((resolve, reject) => {
    sleeper.once("spawn", resolve);
    sleeper.once("error", reject);
  });
  await writeFile(
    path.join(stateRoot, `${encodeURIComponent(containerName)}.json`),
    JSON.stringify({
      pid: sleeper.pid,
      state: "running",
      kernel: true,
      containerName,
      userId: "alice",
    }),
  );
  process.env.FAKE_DOCKER_STATE = stateRoot;
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    await exited;
    const state = JSON.parse(await readFile(path.join(stateRoot, `${encodeURIComponent(containerName)}.json`), "utf8"));
    assert.equal(state.state, "missing");
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 2_000,
    });
    await client.health();
  } finally {
    sleeper.kill("SIGKILL");
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("runtime controller fails closed when orphaned kernel cleanup fails", async () => {
  const tmp = await shortTempDir("oskf-");
  const dataDir = path.join(tmp, "data");
  const stateRoot = path.join(tmp, "docker-state");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const containerName = "open-science-kernel-alice-stuck";
  await mkdir(dataDir, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    sleeper.once("spawn", resolve);
    sleeper.once("error", reject);
  });
  await writeFile(
    path.join(stateRoot, `${encodeURIComponent(containerName)}.json`),
    JSON.stringify({
      pid: sleeper.pid,
      state: "running",
      kernel: true,
      containerName,
      userId: "alice",
    }),
  );
  process.env.FAKE_DOCKER_STATE = stateRoot;
  process.env.FAKE_VOLUME_ROOT = dataDir;
  process.env.FAKE_DOCKER_RM_FAIL_NAME = containerName;
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await assert.rejects(
      controller.listen(),
      (error) => error?.status === 503 && error?.code === "kernel_orphan_cleanup_failed",
    );
    const socketStat = await lstat(socketPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    assert.equal(socketStat, null);
  } finally {
    sleeper.kill("SIGKILL");
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    delete process.env.FAKE_DOCKER_RM_FAIL_NAME;
    await removeTree(tmp);
  }
});

test("runtime controller rejects arbitrary routes and non-canonical project identifiers", async () => {
  const tmp = await shortTempDir("oscp-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const project = await projectTree(dataDir);
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 2_000,
      maxJsonBytes: 1024 * 1024,
    });
    await assert.rejects(
      client.request("POST", "/v1/runtime/start", {
        userId: "../root",
        projectId: "paper1",
        activeWorkspace: "",
        port: 49152,
        password: "pw_abcdefghijklmnopqrstuvwxyz",
      }),
      (error) => error?.status === 400,
    );
    await symlink(await realpath("/tmp"), path.join(project.baseDir, "linked"));
    await assert.rejects(
      client.request("POST", "/v1/runtime/start", {
        userId: "alice",
        projectId: "paper1",
        activeWorkspace: "linked",
        port: 49152,
        password: "pw_abcdefghijklmnopqrstuvwxyz",
      }),
      (error) => error?.status === 403 && error?.code === "path_forbidden",
    );
    await assert.rejects(
      client.request("POST", "/v1/docker/raw", {}),
      (error) => error?.status === 404 && error?.code === "runtime_controller_route_not_found",
    );
    await assert.rejects(
      client.request("POST", "/v1/runtime/start", {
        userId: "alice",
        projectId: "paper1",
        activeWorkspace: "",
        port: 49152,
        password: "pw_abcdefghijklmnopqrstuvwxyz",
        args: ["run", "--privileged"],
      }),
      (error) => error?.status === 400 && error?.code === "runtime_controller_payload_invalid",
    );
    const alias = path.join(tmp, "controller-alias");
    await symlink(path.dirname(socketPath), alias);
    const symlinkClient = new RuntimeControllerClient({
      runtimeControllerSocket: path.join(alias, path.basename(socketPath)),
      runtimeControllerTimeoutMs: 2_000,
    });
    await assert.rejects(
      symlinkClient.health(),
      (error) => error?.code === "runtime_controller_socket_symlink",
    );
    const stateFiles = await readFile(dockerBin, "utf8");
    assert.equal(stateFiles.includes("exec"), false);
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("production readiness verifies the isolated controller and runtime image provenance", async () => {
  const tmp = await shortTempDir("oscr-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  await mkdir(dataDir, { recursive: true });
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  let app;
  try {
    await controller.listen();
    app = createWebApiApp({
      ...controllerConfig({ dataDir, socketPath, dockerBin }),
      port: 0,
      runtimeControllerMode: "socket",
      runtimeControllerTimeoutMs: 2_000,
      allowDirectDockerControl: false,
      devAuth: false,
      authMode: "local",
      bootstrapUser: "alice",
      bootstrapPassword: "correct horse battery staple",
      publicUrl: "https://science.example.com",
      operatorMetricsToken: "controller-readiness-metrics-token-1234567890",
      backupMode: "external",
      backupExternalAck: true,
      restoreDrillAck: true,
      trustProxy: true,
    });
    const address = await app.listen(0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
    assert.equal(response.status, 200);
    const readiness = (await response.json()).data;
    assert.equal(readiness.checks.runtime.ok, true);
    assert.equal(readiness.checks.runtime.controlPlane, "controller_socket");
    assert.equal(readiness.checks.runtime.imageVerified, true);
    assert.equal(readiness.checks.kernel.ok, true);
    assert.equal(readiness.checks.kernel.controlPlane, "controller_socket");
  } finally {
    await app?.close().catch(() => {});
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    await removeTree(tmp);
  }
});

test("a container that dies noisily hands its last words back through the controller", async (t) => {
  // The capture existed and nothing asserted it: both `child.stdout.on` lines
  // could be deleted and every test stayed green. It is the only diagnosis an
  // operator gets for a container that failed to boot — the container is gone,
  // its logs went with it, and telemetry is off — so "output was dropped" and
  // "the container said nothing" are the same observation.
  const tmp = await shortTempDir("osrco-");
  const dataDir = path.join(tmp, "data");
  const socketPath = path.join(tmp, "control", "controller.sock");
  const dockerBin = await fakeDocker(tmp);
  const project = await projectTree(dataDir);
  if (await skipUnsupportedRuntimeSocket(t, project)) {
    await removeTree(tmp);
    return;
  }
  process.env.FAKE_DOCKER_STATE = path.join(tmp, "docker-state");
  process.env.FAKE_VOLUME_ROOT = dataDir;
  process.env.FAKE_RUNTIME_DIES = "1";
  const controller = createRuntimeController(controllerConfig({ dataDir, socketPath, dockerBin }));
  try {
    await controller.listen();
    const client = new RuntimeControllerClient({
      runtimeControllerSocket: socketPath,
      runtimeControllerTimeoutMs: 3_000,
    });
    await client.startRuntime(project, 49160, "pw_abcdefghijklmnopqrstuvwxyz").catch(() => {});
    let status;
    await waitFor(async () => {
      status = await client.runtimeStatus(project).catch(() => null);
      return Boolean(status && !status.running);
    });

    assert.ok(status, "the controller must report a status for a container that exited");
    assert.match(status.output, /seeded profile failed to boot/, "stdout must survive");
    assert.match(status.output, /mount denied/, "and stderr too — startup failures use both");
    // Newlines intact: the reader's filters are line-based, and collapsing the
    // capture to one line is what previously destroyed it on the way out.
    assert.ok(status.output.includes("\n"), "the tail must keep its line breaks");

    // Negative control: a running container's output is not a diagnosis, and
    // shipping it on every poll would put the runtime's chatter through the
    // socket several times a second.
    delete process.env.FAKE_RUNTIME_DIES;
    const live = await projectTree(dataDir, "alice", "paper2");
    await client.startRuntime(live, 49161, "pw_abcdefghijklmnopqrstuvwxyz").catch(() => {});
    const liveStatus = await client.runtimeStatus(live).catch(() => null);
    if (liveStatus?.running) assert.equal(liveStatus.output, "", "a running container reports no tail");
    await client.cleanupRuntime(live).catch(() => {});
  } finally {
    await controller.close().catch(() => {});
    delete process.env.FAKE_DOCKER_STATE;
    delete process.env.FAKE_VOLUME_ROOT;
    delete process.env.FAKE_RUNTIME_DIES;
    await removeTree(tmp);
  }
});
