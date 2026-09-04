import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { assertDockerDataVolumeSupport } from "../src/dockerMounts.mjs";
import {
  RUNTIME_KERNEL_NAME,
  RuntimeManager,
  buildRuntimeLaunchPlan,
  cleanupDockerContainer,
  requestRuntime,
  runtimeContainerName,
  parseByteSize,
  recordPidSample,
  runtimeDshHome,
  runtimeTmpDir,
  syncRuntimeDshProfile,
} from "../src/runtimeManager.mjs";
import { readRuntimeResponseBody } from "../src/runtimeManager.mjs";
import { releaseManifestFixture, runtimeReleaseConfig } from "./releaseFixture.mjs";

/**
 * The two provenance rows `runtimeReleasePolicyError` compares that
 * `runtimeReleaseConfig` does not carry: it still exports the retired kernel's
 * version field, which is now `undefined`, so a production launch built from it
 * alone fails on `dshVersion` before it reaches whatever the test is about.
 */
const dshReleaseConfig = Object.freeze({
  ...runtimeReleaseConfig,
  dshVersion: releaseManifestFixture.runtime.dshVersion,
  socketBundleVersion: releaseManifestFixture.runtime.socketVersion,
});

const project = {
  id: "paper1",
  userId: "alice",
  workspaceDir: "/srv/open-science/users/alice/projects/paper1/workspace",
  runtimeDir: "/srv/open-science/users/alice/projects/paper1/runtime",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRuntime(projectId, workspaceDir = project.workspaceDir) {
  return {
    kind: RUNTIME_KERNEL_NAME,
    url: `http://127.0.0.1/${projectId}`,
    close: async () => {},
    password: null,
    sandboxMode: "host",
    networkMode: null,
    workspaceDir,
    proxyWorkspaceDir: workspaceDir,
    startedAt: new Date().toISOString(),
    pid: 123,
    exitedAt: null,
  };
}

async function fakeDockerRmBin(root) {
  const bin = path.join(root, "docker-rm-stub.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "rm" || args[1] !== "-f") {
  console.error("unexpected command: " + args.join(" "));
  process.exit(2);
}

if (process.env.RM_MODE === "removed") {
  console.log(args[2]);
  process.exit(0);
}
if (process.env.RM_MODE === "missing") {
  console.error("Error: No such container: " + args[2]);
  process.exit(1);
}
console.error("permission denied while connecting to the container socket");
process.exit(125);
`,
    { mode: 0o755 },
  );
  return bin;
}

async function fakeDockerInfoBin(root, version) {
  const bin = path.join(root, `docker-info-${version.replace(/[^0-9]/g, "-")}.mjs`);
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "info") {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  return bin;
}


/** Records, at the moment `docker run` is invoked, whether the control plane
 *  had already written the generated profile into the host directory that
 *  becomes `$DSH_HOME`. The container is built from an image that carries no
 *  gateway address, no MCP command and no model: if the patch is not on disk
 *  before the container starts, the kernel boots and can satisfy nothing. */
async function fakeDockerProfileOrderBin(root) {
  const bin = path.join(root, "docker-profile-order-stub.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "rm") {
  process.stderr.write("Error: No such container: " + args[2] + "\\n");
  process.exit(1);
}
if (args[0] !== "run") process.exit(2);
const mount = args.find((arg) => arg.includes(",dst=/runtime"));
const runtimeRoot = mount.slice(mount.indexOf("src=") + 4, mount.indexOf(",dst="));
const patch = path.join(runtimeRoot, "dsh-home", "control-plane-patch.yml");
fs.writeFileSync(process.env.RUNTIME_ORDER_LOG, fs.existsSync(patch) ? "present" : "absent");
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

async function fakeDockerBootstrapOrderBin(root) {
  const bin = path.join(root, "docker-bootstrap-order-stub.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUNTIME_ORDER_LOG, args[0] + "\\n");
if (args[0] === "rm") process.exit(0);
if (args[0] === "run") process.exit(0);
process.exit(2);
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Logs every subcommand and refuses to remove the container, the way a docker
 *  socket the server may not write to does. */
async function fakeDockerCleanupFailureBin(root) {
  const bin = path.join(root, "docker-cleanup-failure-stub.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUNTIME_ORDER_LOG, args[0] + "\\n");
if (args[0] === "rm") {
  process.stderr.write("permission denied while connecting to the container socket\\n");
  process.exit(125);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

async function fakeUnixRuntimeDockerBin(root) {
  const bin = path.join(root, "docker-unix-runtime.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "info") {
  process.stdout.write("26.0.0\\n");
  process.exit(0);
}
if (args[0] === "rm") process.exit(0);
if (args[0] !== "run") process.exit(2);

const mount = args.find((arg) => arg.includes(",dst=/runtime-control"));
if (!mount) process.exit(3);
const fields = Object.fromEntries(mount.split(",").map((part) => {
  const index = part.indexOf("=");
  return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
}));
const runtimeRoot = fields.type === "volume"
  ? path.join(process.env.FAKE_VOLUME_ROOT, fields["volume-subpath"])
  : fields.src;
const socketPath = path.join(runtimeRoot, "dsh.sock");
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });

const server = http.createServer((req, res) => {
  // The readiness probe is one real wire call now: DSH serves no /config, and
  // a probe that accepted a 404 hid both that and the race where the port is
  // bound before /api is mounted.
  if (req.url.startsWith("/api/session/list")) {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", result: { ok: true, value: { items: [] } } }));
    return;
  }
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
  process.exit(0);
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(socketPath);
`,
    { mode: 0o755 },
  );
  return bin;
}

test("buildRuntimeLaunchPlan generates a container sandbox launch command", () => {
  const plan = buildRuntimeLaunchPlan(
    {
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeTransport: "unix",
      runtimeNetworkMode: "bridge",
      runtimeCpuLimit: "1.5",
      runtimeMemoryLimit: "2g",
      runtimePidsLimit: 128,
      runtimeNoNewPrivileges: true,
      runtimeCapDrop: "ALL",
      runtimeReadOnlyRoot: true,
      runtimeTmpfs: "/tmp:rw,nosuid,nodev,size=64m",
      runtimeContainerUser: "1000:1000",
      allowRuntimeHostNetwork: false,
    },
    project,
    49152,
  );

  assert.equal(plan.command, "docker");
  assert.equal(plan.sandboxMode, "docker");
  assert.equal(plan.containerName, runtimeContainerName(project));
  assert.equal(plan.proxyWorkspaceDir, "/workspace");
  // No `--rm`, deliberately. Docker deletes the container the instant it dies,
  // so `docker inspect` finds nothing and the exit code, the OOM flag and the
  // last output are gone before anything asks. A 19-minute run ended with no
  // explanation available from any source — the corpse was already deleted and
  // this host's `docker events` keeps no history. Removal moved into the exit
  // handler, after the record is written.
  assert.deepEqual(plan.args.slice(0, 6), ["run", "--init", "--name", plan.containerName, "--label", "open-science.web.runtime=true"]);
  assert.equal(plan.args.includes("--rm"), false, "a container deleted on death cannot be asked why it died");
  assert.ok(plan.args.includes(`open-science.user=${project.userId}`));
  assert.ok(plan.args.includes(`open-science.project=${project.id}`));
  assert.ok(plan.args.includes("--security-opt"));
  assert.ok(plan.args.includes("no-new-privileges"));
  assert.ok(plan.args.includes("--cap-drop"));
  assert.ok(plan.args.includes("ALL"));
  assert.ok(plan.args.includes("--pids-limit"));
  assert.ok(plan.args.includes("128"));
  assert.ok(plan.args.includes("--read-only"));
  assert.ok(plan.args.includes("--tmpfs"));
  assert.ok(plan.args.includes("/tmp:rw,nosuid,nodev,size=64m"));
  assert.ok(plan.args.includes("--user"));
  assert.ok(plan.args.includes("1000:1000"));
  assert.ok(plan.args.includes("--network"));
  assert.ok(plan.args.includes("bridge"));
  assert.ok(plan.args.includes("--cpus"));
  assert.ok(plan.args.includes("1.5"));
  assert.ok(plan.args.includes("--memory"));
  assert.ok(plan.args.includes("2g"));
  // Nothing is published. The kernel's web host binds loopback inside the
  // container, so a published port maps to an interface nothing listens on; the
  // port travels as environment and the control plane dials the unix socket.
  assert.equal(plan.args.includes("--publish"), false);
  assert.ok(plan.args.includes("OPEN_SCIENCE_RUNTIME_PORT=49152"));
  assert.ok(plan.args.includes(`type=bind,src=${project.workspaceDir},dst=/workspace`));
  assert.ok(plan.args.includes("HOME=/runtime/home"));
  assert.equal(plan.args.at(-2), "evimed-runtime-dsh:test");
  assert.equal(plan.args.at(-1), "open-science-dsh-serve");
  assert.ok(plan.runtimeDirs.includes(path.join(project.runtimeDir, "container-runtime")));
  assert.ok(plan.runtimeDirs.includes(path.join(project.runtimeDir, "container-runtime/home")));
});

test("buildRuntimeLaunchPlan shares only project volume subpaths over a Unix socket", () => {
  const dataDir = "/data";
  const volumeProject = {
    ...project,
    rootDir: "/data/users/alice/projects/paper1",
    workspaceDir: "/data/users/alice/projects/paper1/workspace/session-1",
    runtimeDir: "/data/users/alice/projects/paper1/runtime",
  };
  const plan = buildRuntimeLaunchPlan(
    {
      dataDir,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeDataVolume: "open-science-data",
      runtimeTransport: "unix",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
    },
    volumeProject,
    4096,
  );

  assert.equal(plan.runtimeUrl, "http://dsh.runtime");
  assert.equal(plan.socketPath, "/data/.runtime-sockets/810502d24441cfd45914a2ac/dsh.sock");
  assert.equal(plan.args.includes("--publish"), false);
  assert.ok(
    plan.args.includes(
      "type=volume,src=open-science-data,dst=/workspace,volume-subpath=users/alice/projects/paper1/workspace/session-1",
    ),
  );
  assert.ok(
    plan.args.includes(
      "type=volume,src=open-science-data,dst=/runtime,volume-subpath=users/alice/projects/paper1/runtime/container-runtime",
    ),
  );
  assert.ok(
    plan.args.includes(
      "type=volume,src=open-science-data,dst=/runtime-control,volume-subpath=.runtime-sockets/810502d24441cfd45914a2ac",
    ),
  );
  assert.ok(plan.args.includes("OPEN_SCIENCE_RUNTIME_SOCKET=/runtime-control/dsh.sock"));
  assert.equal(plan.args.at(-1), "open-science-dsh-serve");
});

test("buildRuntimeLaunchPlan rejects unsafe volume names and paths outside the data volume", () => {
  const base = {
    dataDir: "/data",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: "docker",
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeDataVolume: "open-science-data",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
  };
  assert.throws(
    () => buildRuntimeLaunchPlan({ ...base, runtimeDataVolume: "unsafe/volume" }, project, 4096),
    (error) => error?.code === "invalid_runtime_data_volume",
  );
  assert.throws(
    () => buildRuntimeLaunchPlan(base, project, 4096),
    (error) => error?.code === "runtime_data_path_outside_volume",
  );
});

test("Unix runtime sockets use a bounded hashed path for long tenant and project identifiers", () => {
  const userId = "u".repeat(64);
  const projectId = "p".repeat(64);
  const dataDir = "/data";
  const rootDir = path.join(dataDir, "users", userId, "projects", projectId);
  const plan = buildRuntimeLaunchPlan(
    {
      dataDir,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeDataVolume: "open-science-data",
      runtimeTransport: "unix",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
    },
    {
      id: projectId,
      userId,
      rootDir,
      workspaceDir: path.join(rootDir, "workspace"),
      runtimeDir: path.join(rootDir, "runtime"),
    },
    4096,
  );

  assert.ok(Buffer.byteLength(plan.socketPath) < 108);
  assert.match(plan.socketPath, /^\/data\/\.runtime-sockets\/[a-f0-9]{24}\/dsh\.sock$/);
  assert.equal(plan.socketPath.includes(userId), false);
  assert.equal(plan.socketPath.includes(projectId), false);
});

test("named-volume subpaths require Docker Engine 26 or newer", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-docker-version-"));
  try {
    const oldDocker = await fakeDockerInfoBin(tmp, "25.0.5");
    const currentDocker = await fakeDockerInfoBin(tmp, "26.0.0");
    assert.throws(
      () =>
        assertDockerDataVolumeSupport({
          runtimeDataVolume: "open-science-data",
          runtimeContainerBin: oldDocker,
        }),
      (error) => error?.code === "runtime_volume_subpath_unsupported",
    );
    assert.deepEqual(
      assertDockerDataVolumeSupport({
        runtimeDataVolume: "open-science-data",
        runtimeContainerBin: currentDocker,
      }),
      { version: "26.0.0", major: 26 },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("requestRuntime carries HTTP and streaming bodies over a Unix socket", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-runtime-socket-"));
  const socketPath = path.join(tmp, "dsh.sock");
  const server = createServer((req, res) => {
    assert.equal(req.url, "/event?directory=%2Fworkspace");
    assert.equal(req.headers.authorization, "Basic test");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: ready\n\n");
    res.end("data: done\n\n");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const response = await requestRuntime(
      { url: "http://dsh.runtime", socketPath },
      "http://dsh.runtime/event?directory=%2Fworkspace",
      { headers: { authorization: "Basic test" } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await new Response(response.body).text(), "data: ready\n\ndata: done\n\n");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager reads authoritative kernel session status without waking a stopped runtime", async () => {
  // The retired kernel answered `GET /session/status` with a typed status per
  // session, and this test pinned three of them plus the refusal to invent one
  // for a type it did not know. DSH has no such endpoint: `session/list` says
  // which sessions are running, and everything else is idle. The two halves
  // worth keeping are unchanged — a status is read from the kernel rather than
  // guessed, and an answer that cannot be read is an error rather than a
  // fabricated `idle`.
  let running = ["ses_busy"];
  let malformed = false;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/session/list");
    req.resume();
    if (malformed) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "server-response",
      result: { ok: true, value: { items: running.map((sessionId) => ({ sessionId, running: true })) } },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const runtimeProject = { ...project, rootDir: "/srv/open-science/users/alice/projects/paper1" };
  const manager = new RuntimeManager({ maxJsonBytes: 1024 * 1024, runtimeIdleTimeoutMs: 0 });
  const runtime = {
    ...fakeRuntime(runtimeProject.id, runtimeProject.workspaceDir),
    url: `http://127.0.0.1:${address.port}`,
    project: runtimeProject,
  };
  manager.runtimes.set(manager.key(runtimeProject), runtime);
  try {
    assert.equal(await manager.sessionStatus(runtimeProject, "ses_busy", { wake: false }), "busy");
    assert.equal(await manager.sessionStatus(runtimeProject, "ses_idle", { wake: false }), "idle");
    running = [];
    assert.equal(await manager.sessionStatus(runtimeProject, "ses_busy", { wake: false }), "idle");

    malformed = true;
    await assert.rejects(
      () => manager.sessionStatus(runtimeProject, "ses_busy", { wake: false }),
      (error) => error?.code === "runtime_wire_protocol_mismatch",
    );

    // And a stopped runtime is never woken to answer a monitoring read.
    malformed = false;
    manager.runtimes.delete(manager.key(runtimeProject));
    let starts = 0;
    manager.start = async () => { starts += 1; throw new Error("must not start"); };
    await assert.rejects(
      () => manager.sessionStatus(runtimeProject, "ses_busy", { wake: false }),
      (error) => error?.code === "runtime_not_running",
    );
    assert.equal(starts, 0);
  } finally {
    await manager.closeAll();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("RuntimeManager retries when an individual readiness probe stalls", { timeout: 3_000 }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-runtime-readiness-"));
  const socketPath = path.join(tmp, "dsh.sock");
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    if (requests === 1) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true }));
  });
  const manager = new RuntimeManager({ runtimeProxyConnectTimeoutMs: 1_500 });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await manager.waitUntilReady({
      url: "http://dsh.runtime",
      socketPath,
      password: null,
      child: { exitCode: null, signalCode: null },
      spawnError: null,
    });
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager starts and stops a volume-backed Docker runtime over a Unix socket", async () => {
  const tmp = await mkdtemp("/tmp/osrt-");
  const dataDir = path.join(tmp, "data");
  const projectRoot = path.join(dataDir, "users", "alice", "projects", "paper1");
  const runtimeProject = {
    id: "paper1",
    userId: "alice",
    rootDir: projectRoot,
    baseDir: path.join(projectRoot, "workspace"),
    workspaceDir: path.join(projectRoot, "workspace"),
    runtimeDir: path.join(projectRoot, "runtime"),
    metaDir: path.join(projectRoot, ".openscience"),
  };
  await Promise.all([
    mkdir(runtimeProject.workspaceDir, { recursive: true }),
    mkdir(runtimeProject.runtimeDir, { recursive: true }),
    mkdir(runtimeProject.metaDir, { recursive: true }),
  ]);
  const docker = await fakeUnixRuntimeDockerBin(tmp);
  const previousRoot = process.env.FAKE_VOLUME_ROOT;
  process.env.FAKE_VOLUME_ROOT = dataDir;
  const manager = new RuntimeManager({
    dataDir,
    production: false,
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: docker,
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeDataVolume: "open-science-data",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    runtimeNoNewPrivileges: true,
    runtimeCapDrop: "ALL",
    runtimeReadOnlyRoot: true,
    runtimeTmpfs: "/tmp:rw,nosuid,nodev,size=16m",
    runtimeSkillDirs: [],
    allowRuntimeHostNetwork: false,
    runtimeProxyConnectTimeoutMs: 3_000,
    runtimeQuotaCheckIntervalMs: 0,
    runtimeIdleTimeoutMs: 0,
    maxProjectBytes: 1024 * 1024,
    maxProjectUsageScanEntries: 100,
    maxLogFileBytes: 1024 * 1024,
  });
  try {
    const runtime = await manager.start(runtimeProject);
    assert.equal(runtime.kind, RUNTIME_KERNEL_NAME);
    assert.equal(runtime.url, "http://dsh.runtime");
    assert.match(runtime.socketPath, /[/\\]\.runtime-sockets[/\\][a-f0-9]{24}[/\\]dsh\.sock$/);
    const response = await requestRuntime(runtime, `${runtime.url}/config`);
    assert.equal(response.status, 200);
    assert.deepEqual(await new Response(response.body).json(), { ready: true });

    await manager.stop(runtimeProject);
    await assert.rejects(() => readFile(runtime.socketPath), (error) => error?.code === "ENOENT");
  } finally {
    await manager.closeAll();
    if (previousRoot == null) delete process.env.FAKE_VOLUME_ROOT;
    else process.env.FAKE_VOLUME_ROOT = previousRoot;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager refuses a symlinked project runtime socket", async () => {
  const tmp = await mkdtemp("/tmp/osrt-link-");
  const dataDir = path.join(tmp, "data");
  const projectRoot = path.join(dataDir, "users", "alice", "projects", "paper1");
  const runtimeDir = path.join(projectRoot, "runtime");
  const socketPath = path.join(dataDir, ".runtime-sockets", "810502d24441cfd45914a2ac", "dsh.sock");
  const socketTarget = path.join(tmp, "outside.sock");
  await Promise.all([
    mkdir(path.join(projectRoot, "workspace"), { recursive: true }),
    mkdir(path.dirname(socketPath), { recursive: true }),
    mkdir(path.join(projectRoot, ".openscience"), { recursive: true }),
  ]);
  await symlink(socketTarget, socketPath);
  const docker = await fakeDockerInfoBin(tmp, "26.0.0");
  const manager = new RuntimeManager({
    dataDir,
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: docker,
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeDataVolume: "open-science-data",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    runtimeSkillDirs: [],
    allowRuntimeHostNetwork: false,
  });
  try {
    await assert.rejects(
      () =>
        manager.startKernel({
          id: "paper1",
          userId: "alice",
          rootDir: projectRoot,
          workspaceDir: path.join(projectRoot, "workspace"),
          runtimeDir,
          metaDir: path.join(projectRoot, ".openscience"),
        }),
      (error) => error?.code === "runtime_socket_symlink",
    );
  } finally {
    await manager.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildRuntimeLaunchPlan can disable read-only root for incompatible images", () => {
  const plan = buildRuntimeLaunchPlan(
    {
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeNetworkMode: "bridge",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      runtimeReadOnlyRoot: false,
      runtimeTmpfs: "",
      allowRuntimeHostNetwork: false,
    },
    project,
    49152,
  );

  assert.equal(plan.args.includes("--read-only"), false);
  assert.equal(plan.args.includes("--tmpfs"), false);
});

test("cleanupDockerContainer distinguishes removed, missing, and failed containers", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-docker-rm-"));
  try {
    const docker = await fakeDockerRmBin(tmp);
    const plan = {
      command: docker,
      containerName: "open-science-test-container",
      cwd: tmp,
      env: { ...process.env, RM_MODE: "removed" },
    };

    let result = await cleanupDockerContainer(plan);
    assert.equal(result.cleaned, true);
    assert.equal(result.failed, false);
    assert.equal(result.reason, "removed");

    result = await cleanupDockerContainer({ ...plan, env: { ...process.env, RM_MODE: "missing" } });
    assert.equal(result.cleaned, false);
    assert.equal(result.missing, true);
    assert.equal(result.failed, false);
    assert.equal(result.reason, "missing");

    result = await cleanupDockerContainer({ ...plan, env: { ...process.env, RM_MODE: "failed" } });
    assert.equal(result.cleaned, false);
    assert.equal(result.missing, false);
    assert.equal(result.failed, true);
    assert.equal(result.reason, "rm_failed");
    assert.match(result.error, /permission denied/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager startup cleanup removes stale docker runtime state", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-orphan-"));
  try {
    const docker = await fakeDockerRmBin(tmp);
    const projectRoot = path.join(tmp, "users", "alice", "projects", "paper1");
    const currentProject = {
      id: "paper1",
      userId: "alice",
      rootDir: projectRoot,
      workspaceDir: path.join(projectRoot, "workspace"),
      runtimeDir: path.join(projectRoot, "runtime"),
      metaDir: path.join(projectRoot, ".openscience"),
    };
    await mkdir(currentProject.workspaceDir, { recursive: true });
    await mkdir(currentProject.runtimeDir, { recursive: true });
    await mkdir(currentProject.metaDir, { recursive: true });
    await writeFile(
      path.join(currentProject.metaDir, "runtime-state.json"),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        userId: "alice",
        projectId: "paper1",
        event: "started",
        running: true,
        kind: RUNTIME_KERNEL_NAME,
        startedAt: "2026-07-09T00:00:00.000Z",
        pid: null,
        exitedAt: null,
        sandboxMode: "docker",
        networkMode: "bridge",
        containerName: "open-science-stale",
        skillsCopied: 1,
      }),
      "utf8",
    );

    const manager = new RuntimeManager({
      runtimeMode: "kernel",
      runtimeContainerBin: docker,
      runtimeNetworkMode: "bridge",
      maxLogFileBytes: 1024 * 1024,
    });
    const previousMode = process.env.RM_MODE;
    process.env.RM_MODE = "removed";
    let summary;
    try {
      summary = await manager.cleanupOrphanedRuntimes([currentProject]);
    } finally {
      if (previousMode == null) delete process.env.RM_MODE;
      else process.env.RM_MODE = previousMode;
    }

    assert.deepEqual(summary, { scanned: 1, skipped: 0, cleaned: 1, missing: 0, failed: 0 });
    const state = JSON.parse(await readFile(path.join(currentProject.metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.event, "orphan_cleanup");
    assert.equal(state.running, false);
    assert.equal(state.containerName, "open-science-stale");
    assert.equal(state.error, null);
    const logs = (await readFile(path.join(currentProject.metaDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(logs.some((row) => row.event === "startup_orphan_cleanup" && row.result === "removed"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager startup cleanup records failed stale docker cleanup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-orphan-fail-"));
  try {
    const docker = await fakeDockerRmBin(tmp);
    const projectRoot = path.join(tmp, "users", "alice", "projects", "paper1");
    const currentProject = {
      id: "paper1",
      userId: "alice",
      rootDir: projectRoot,
      workspaceDir: path.join(projectRoot, "workspace"),
      runtimeDir: path.join(projectRoot, "runtime"),
      metaDir: path.join(projectRoot, ".openscience"),
    };
    await mkdir(currentProject.workspaceDir, { recursive: true });
    await mkdir(currentProject.runtimeDir, { recursive: true });
    await mkdir(currentProject.metaDir, { recursive: true });
    await writeFile(
      path.join(currentProject.metaDir, "runtime-state.json"),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        userId: "alice",
        projectId: "paper1",
        event: "starting",
        running: false,
        kind: RUNTIME_KERNEL_NAME,
        startedAt: null,
        pid: null,
        exitedAt: null,
        sandboxMode: "docker",
        networkMode: "bridge",
        containerName: "open-science-stale",
      }),
      "utf8",
    );

    const manager = new RuntimeManager({
      runtimeMode: "kernel",
      runtimeContainerBin: docker,
      runtimeNetworkMode: "bridge",
      maxLogFileBytes: 1024 * 1024,
    });
    const previousMode = process.env.RM_MODE;
    delete process.env.RM_MODE;
    let summary;
    try {
      summary = await manager.cleanupOrphanedRuntimes([currentProject]);
    } finally {
      if (previousMode == null) delete process.env.RM_MODE;
      else process.env.RM_MODE = previousMode;
    }

    assert.deepEqual(summary, { scanned: 1, skipped: 0, cleaned: 0, missing: 0, failed: 1 });
    const state = JSON.parse(await readFile(path.join(currentProject.metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.event, "failed");
    assert.equal(state.running, false);
    assert.equal(state.error, "runtime_cleanup_failed");
    const logs = (await readFile(path.join(currentProject.metaDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(logs.some((row) => row.event === "startup_orphan_cleanup_failed" && /permission denied/.test(row.error)));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});



test("the runtime bootstrap refuses a symlinked $DSH_HOME instead of writing credentials through it", async () => {
  // What is left of "reject a symlinked deployment target" now that nothing is
  // copied into a project. The kernel's whole per-project configuration is one
  // directory the control plane writes before the container starts, and it
  // holds the gateway token and the workload token: a symlink anywhere along
  // that path would place both outside the project.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-dsh-home-link-"));
  try {
    const projectRoot = path.join(tmp, "project");
    const outside = path.join(tmp, "outside");
    await mkdir(path.join(projectRoot, "runtime"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(projectRoot, "runtime", "dsh-home"));

    await assert.rejects(
      () => syncRuntimeDshProfile(
        {
          deepseekProviderEnabled: true,
          deepseekModel: "deepseek-v4-pro",
          modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
          modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
          evimedWorkloadSigningSecret: "evimed-workload-signing-secret-with-32-bytes",
          evimedWorkloadTokenTtlSeconds: 300,
          runtimeSandboxEnforcement: "full",
          production: false,
        },
        { id: "paper1", userId: "alice", rootDir: projectRoot, workspaceDir: path.join(projectRoot, "workspace") },
        {
          sandboxMode: "docker",
          dshHomeDir: path.join(projectRoot, "runtime", "dsh-home"),
          proxyWorkspaceDir: "/workspace",
        },
      ),
      /symbolic links are not allowed/,
    );
    assert.deepEqual(await readdir(outside), [], "nothing may be written through the link");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});








test("RuntimeManager cleans stale containers before bootstrap and records bootstrap failures without spawning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-rt-boot-fail-"));
  const projectRoot = path.join(tmp, "project");
  const runtimeProject = {
    ...project,
    rootDir: projectRoot,
    baseDir: path.join(projectRoot, "workspace"),
    workspaceDir: path.join(projectRoot, "workspace"),
    runtimeDir: path.join(projectRoot, "runtime"),
    metaDir: path.join(projectRoot, ".openscience"),
  };
  const docker = await fakeDockerBootstrapOrderBin(tmp);
  const orderLog = path.join(tmp, "runtime-order.log");
  await Promise.all([
    mkdir(runtimeProject.workspaceDir, { recursive: true }),
    mkdir(runtimeProject.runtimeDir, { recursive: true }),
    mkdir(runtimeProject.metaDir, { recursive: true }),
  ]);
  const previousOrderLog = process.env.RUNTIME_ORDER_LOG;
  process.env.RUNTIME_ORDER_LOG = orderLog;
  const manager = new RuntimeManager({
    production: false,
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: docker,
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
    runtimeProxyConnectTimeoutMs: 1_000,
    maxLogFileBytes: 1024 * 1024,
    // The bootstrap failure: a model the gateway does not certify. The
    // retired kernel reached the same point through a skill directory that
    // would not copy; nothing is copied any more, and the profile sync is what
    // stands between cleanup and spawn now.
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v9-imaginary",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
  });
  try {
    // The specific cause reaches the caller; the ledger keeps recording the
    // stage, so an operator can see both what failed and where.
    await assert.rejects(
      () => manager.startKernel(runtimeProject),
      (error) => error?.code === "runtime_model_gateway_model_invalid",
    );
    assert.equal(await readFile(orderLog, "utf8"), "rm\n");
    const state = JSON.parse(await readFile(path.join(runtimeProject.metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.event, "failed");
    assert.equal(state.running, false);
    assert.equal(state.error, "runtime_bootstrap_failed");
    const events = (await readFile(path.join(runtimeProject.metaDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "bootstrap_failed"));
  } finally {
    if (previousOrderLog == null) delete process.env.RUNTIME_ORDER_LOG;
    else process.env.RUNTIME_ORDER_LOG = previousOrderLog;
    await manager.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});


test("RuntimeManager records cleanup failure and stops before bootstrap or spawn", async () => {
  // The retired kernel could also run as a bare host process, and this test
  // covered the kill of a host pid that would not die. There is no host
  // runtime now -- the launch plan refuses every mode but `docker` -- so the
  // surviving half is the one that always mattered: a cleanup that failed must
  // stop the start, before the profile is written and before anything spawns.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-rt-clean-fail-"));
  const projectRoot = path.join(tmp, "project");
  const runtimeProject = {
    ...project,
    rootDir: projectRoot,
    baseDir: path.join(projectRoot, "workspace"),
    workspaceDir: path.join(projectRoot, "workspace"),
    runtimeDir: path.join(projectRoot, "runtime"),
    metaDir: path.join(projectRoot, ".openscience"),
  };
  await Promise.all([
    mkdir(runtimeProject.workspaceDir, { recursive: true }),
    mkdir(runtimeProject.runtimeDir, { recursive: true }),
    mkdir(runtimeProject.metaDir, { recursive: true }),
  ]);
  const orderLog = path.join(tmp, "runtime-order.log");
  const previousOrderLog = process.env.RUNTIME_ORDER_LOG;
  process.env.RUNTIME_ORDER_LOG = orderLog;
  const manager = new RuntimeManager({
    production: false,
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: await fakeDockerCleanupFailureBin(tmp),
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
    maxLogFileBytes: 1024 * 1024,
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
    evimedWorkloadSigningSecret: "evimed-workload-signing-secret-with-32-bytes",
    evimedWorkloadTokenTtlSeconds: 300,
    runtimeSandboxEnforcement: "full",
  });
  try {
    await assert.rejects(
      () => manager.startKernel(runtimeProject),
      (error) => error?.code === "runtime_cleanup_failed",
    );
    assert.equal(await readFile(orderLog, "utf8"), "rm\n", "a failed cleanup must not be followed by a run");
    await assert.rejects(
      () => readFile(path.join(runtimeProject.runtimeDir, "container-runtime", "dsh-home", "control-plane-patch.yml")),
      (error) => error?.code === "ENOENT",
      "and the kernel's credentials must not be written for a start that was refused",
    );
    const state = JSON.parse(await readFile(path.join(runtimeProject.metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.event, "failed");
    assert.equal(state.error, "runtime_cleanup_failed");
    const events = (await readFile(path.join(runtimeProject.metaDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "cleanup_failed" && /permission denied/.test(event.error)));
  } finally {
    if (previousOrderLog == null) delete process.env.RUNTIME_ORDER_LOG;
    else process.env.RUNTIME_ORDER_LOG = previousOrderLog;
    await manager.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager writes the generated profile before the container is started", async () => {
  // The retired kernel read its specialty packages out of a per-project config
  // tree that had to be materialized before it spawned, and this test watched
  // that ordering. Nothing is copied per project any more -- the image carries
  // the skills and the capability catalogue read-only -- but the ordering
  // survives intact and matters more: the image alone carries no gateway
  // address, no MCP command and no model, so a container started before the
  // generated patch is on disk boots, answers its own health probe, and can
  // satisfy nothing a run needs.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-rt-profile-order-"));
  const projectRoot = path.join(tmp, "project");
  const runtimeProject = {
    ...project,
    rootDir: projectRoot,
    baseDir: path.join(projectRoot, "workspace"),
    workspaceDir: path.join(projectRoot, "workspace"),
    runtimeDir: path.join(projectRoot, "runtime"),
    metaDir: path.join(projectRoot, ".openscience"),
  };
  await Promise.all([
    mkdir(runtimeProject.workspaceDir, { recursive: true }),
    mkdir(runtimeProject.runtimeDir, { recursive: true }),
    mkdir(runtimeProject.metaDir, { recursive: true }),
  ]);
  const orderLog = path.join(tmp, "profile-order.log");
  const previousOrderLog = process.env.RUNTIME_ORDER_LOG;
  process.env.RUNTIME_ORDER_LOG = orderLog;
  const manager = new RuntimeManager({
    production: false,
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: await fakeDockerProfileOrderBin(tmp),
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
    runtimeProxyConnectTimeoutMs: 1_000,
    runtimeReadyTimeoutMs: 1_000,
    maxLogFileBytes: 1024 * 1024,
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
    modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
    evimedWorkloadSigningSecret: "evimed-workload-signing-secret-with-32-bytes",
    evimedWorkloadTokenTtlSeconds: 300,
    runtimeSandboxEnforcement: "full",
  });
  try {
    // The stub exits as soon as it has answered the question, so the start
    // itself fails -- that is the container dying, not the ordering.
    await assert.rejects(() => manager.startKernel(runtimeProject), (error) => error?.code === "runtime_exited");
    assert.equal(
      await readFile(orderLog, "utf8"),
      "present",
      "the container was started before the control plane wrote its profile",
    );

    // Negative control: the probe above is only evidence if it can say `absent`.
    // A stub that reported `present` unconditionally would pass while the
    // ordering was reversed — the exact "execution without assertion" this
    // ordering test exists to rule out.
    const empty = path.join(tmp, "empty-runtime-root");
    await mkdir(empty, { recursive: true });
    await new Promise((resolve, reject) => {
      const probe = spawn(
        process.execPath,
        [manager.config.runtimeContainerBin, "run", "--mount", `type=bind,src=${empty},dst=/runtime`],
        { env: { ...process.env, RUNTIME_ORDER_LOG: orderLog }, stdio: "ignore" },
      );
      probe.once("error", reject);
      probe.once("exit", () => resolve(undefined));
    });
    assert.equal(await readFile(orderLog, "utf8"), "absent");
    const dshHome = path.join(runtimeProject.runtimeDir, "container-runtime", "dsh-home");
    assert.match(await readFile(path.join(dshHome, "control-plane-patch.yml"), "utf8"), /baseURL: /);
    assert.match(await readFile(path.join(dshHome, ".credentials.yaml"), "utf8"), /EVIMED_WORKLOAD_TOKEN: /);
  } finally {
    if (previousOrderLog == null) delete process.env.RUNTIME_ORDER_LOG;
    else process.env.RUNTIME_ORDER_LOG = previousOrderLog;
    await manager.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runtime guard stops await one terminal AgentRun transition and history monitoring never wakes a stopped runtime", async () => {
  for (const scenario of [
    { name: "workload-refresh", expected: "failed" },
    { name: "idle-timeout", expected: "canceled" },
    { name: "quota-guard", expected: "failed" },
  ]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), `open-science-runtime-stop-${scenario.name}-`));
    const runtimeProject = {
      id: scenario.name,
      userId: "alice",
      rootDir: tmp,
      baseDir: path.join(tmp, "workspace"),
      workspaceDir: path.join(tmp, "workspace"),
      runtimeDir: path.join(tmp, "runtime"),
      metaDir: path.join(tmp, ".openscience"),
    };
    await Promise.all([
      mkdir(runtimeProject.workspaceDir, { recursive: true }),
      mkdir(runtimeProject.runtimeDir, { recursive: true }),
      mkdir(runtimeProject.metaDir, { recursive: true }),
    ]);
    const binding = {
      sessionId: `ses_${scenario.name}`,
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const runs = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    await runs.start(runtimeProject, { sessionId: binding.sessionId });
    const callbacks = [];
    let closeCalls = 0;
    const manager = new RuntimeManager({
      runtimeIdleTimeoutMs: 1,
      runtimeQuotaCheckIntervalMs: 0,
      maxProjectBytes: 1024,
      maxLogFileBytes: 1024 * 1024,
    }, {
      workloadTokenWriter: async () => { throw new Error("refresh failed"); },
      onRuntimeStop: async (stoppedProject, status) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        callbacks.push(status);
        await runs.closeProject(stoppedProject, status);
      },
    });
    const runtime = {
      ...fakeRuntime(runtimeProject.id, runtimeProject.workspaceDir),
      project: runtimeProject,
      workloadTokenFile: scenario.name === "workload-refresh" ? path.join(tmp, "token") : null,
      close: async () => { closeCalls += 1; },
    };
    const key = manager.key(runtimeProject);
    manager.runtimes.set(key, runtime);
    try {
      if (scenario.name === "workload-refresh") {
        const monitor = { timer: null };
        manager.evimedWorkloadRefreshTimers.set(key, monitor);
        await manager.refreshEviMedRuntimeToken(runtimeProject, monitor);
      } else if (scenario.name === "idle-timeout") {
        manager.runtimeActivity.set(key, { activeProxies: 0, idleTimer: null });
        await manager.stopIdleRuntime(runtimeProject);
      } else {
        await manager.stopQuotaGuardRuntime(runtimeProject, "quota_exceeded", "project_quota_exceeded");
      }

      assert.deepEqual(callbacks, [scenario.expected], scenario.name);
      assert.equal(closeCalls, 1, scenario.name);
      assert.equal((await runs.list(runtimeProject))[0].status, scenario.expected, scenario.name);
      await manager.stop(runtimeProject);
      assert.deepEqual(callbacks, [scenario.expected], `${scenario.name} callback must be single-shot`);
      let starts = 0;
      manager.start = async () => { starts += 1; throw new Error("must not start"); };
      await assert.rejects(
        () => manager.sessionMessages(runtimeProject, binding.sessionId, { wake: false }),
        (error) => error?.code === "runtime_not_running",
      );
      assert.equal(starts, 0, `${scenario.name} history read must not wake runtime`);
    } finally {
      await manager.closeAll();
      await runs.closeAll();
      await rm(tmp, { recursive: true, force: true });
    }
  }
});

test("buildRuntimeLaunchPlan rejects host networking unless explicitly allowed", () => {
  assert.throws(
    () =>
      buildRuntimeLaunchPlan(
        {
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "docker",
          runtimeContainerImage: "evimed-runtime-dsh:test",
          runtimeNetworkMode: "host",
          runtimeCpuLimit: "1",
          runtimeMemoryLimit: "1g",
          runtimePidsLimit: 64,
          allowRuntimeHostNetwork: false,
        },
        project,
        49152,
      ),
    /Host or shared-container networking is disabled/,
  );
});

test("buildRuntimeLaunchPlan rejects production network egress unless explicitly allowed", () => {
  assert.throws(
    () =>
      buildRuntimeLaunchPlan(
        {
          production: true,
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "docker",
          runtimeContainerImage: "evimed-runtime-dsh:test",
          runtimeNetworkMode: "bridge",
          runtimeCpuLimit: "1",
          runtimeMemoryLimit: "1g",
          runtimePidsLimit: 64,
          allowRuntimeHostNetwork: false,
          allowRuntimeNetworkEgress: false,
        },
        project,
        49152,
      ),
    /OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true/,
  );
});

test("buildRuntimeLaunchPlan rejects production network egress without policy acknowledgement", () => {
  assert.throws(
    () =>
      buildRuntimeLaunchPlan(
        {
          production: true,
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "docker",
          runtimeContainerImage: "evimed-runtime-dsh:test",
          runtimeNetworkMode: "bridge",
          runtimeCpuLimit: "1",
          runtimeMemoryLimit: "1g",
          runtimePidsLimit: 64,
          allowRuntimeHostNetwork: false,
          allowRuntimeNetworkEgress: true,
          runtimeNetworkEgressPolicyAck: false,
        },
        project,
        49152,
      ),
    /OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true/,
  );
});

test("buildRuntimeLaunchPlan allows production network egress with opt-in and policy acknowledgement", () => {
  const plan = buildRuntimeLaunchPlan(
    {
      production: true,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      ...dshReleaseConfig,
      runtimeNetworkMode: "bridge",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
      allowRuntimeNetworkEgress: true,
      runtimeNetworkEgressPolicyAck: true,
    },
    project,
    49152,
  );

  assert.ok(plan.args.includes("--network"));
  assert.ok(plan.args.includes("bridge"));
});

test("buildRuntimeLaunchPlan requires matching release provenance in production", () => {
  const base = {
    production: true,
    runtimeSandboxMode: "docker",
    runtimeContainerBin: "docker",
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
  };
  assert.throws(
    () => buildRuntimeLaunchPlan(base, project, 49152),
    (err) => err?.code === "release_manifest_missing",
  );
  assert.throws(
    () =>
      buildRuntimeLaunchPlan(
        { ...base, ...dshReleaseConfig, runtimeContainerImage: "evimed-runtime-dsh:mismatch" },
        project,
        49152,
      ),
    (err) => err?.code === "release_manifest_mismatch",
  );
});

test("buildRuntimeLaunchPlan refuses a host runtime in production despite the opt-in", () => {
  // The host launch plan handed the child the server's own environment, which
  // holds the upstream API key, so production had to refuse it whatever the
  // operator set. It is refused for a second reason now: the kernel's EviMed
  // composition — the preset, the research MCP, the capability trees — is baked
  // into the runtime image, and the generated profile names those paths. A
  // kernel started from a host binary finds none of them, boots, answers its
  // own health probe and can satisfy nothing.
  assert.throws(
    () =>
      buildRuntimeLaunchPlan(
        {
          production: true,
          runtimeSandboxMode: "host",
          allowUnsandboxedRuntime: true,
        },
        project,
        49152,
      ),
    (error) => error?.code === "invalid_runtime_sandbox"
      && /requires OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker|set OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker/.test(error.message),
  );
});

test("buildRuntimeLaunchPlan rejects an unsandboxed host runtime, opt-in or not", () => {
  for (const allowUnsandboxedRuntime of [false, true]) {
    assert.throws(
      () =>
        buildRuntimeLaunchPlan(
          {
            runtimeSandboxMode: "host",
            allowUnsandboxedRuntime,
          },
          project,
          49152,
        ),
      (error) => error?.code === "invalid_runtime_sandbox",
      `allowUnsandboxedRuntime=${allowUnsandboxedRuntime}`,
    );
  }
});

test("there is no launch plan but the container one: every other sandbox mode is refused by name", () => {
  // This slot used to assert the shape of the host plan — its command, its cwd,
  // and that proxying used the host workspace path rather than a container one.
  // There is no host plan to describe: the function returns a docker plan or
  // throws. Refusing by name is the point. A mode that fell through to a host
  // launch would produce a runtime that starts, serves, and finds none of the
  // composition the image carries — a failure that looks exactly like nothing
  // having happened.
  for (const runtimeSandboxMode of ["host", "none", "process", "", undefined]) {
    assert.throws(
      () => buildRuntimeLaunchPlan({ runtimeSandboxMode, allowUnsandboxedRuntime: true }, project, 49152),
      (error) => error?.code === "invalid_runtime_sandbox",
      String(runtimeSandboxMode),
    );
  }
});

test("RuntimeManager serializes concurrent starts for the same project", async () => {
  const manager = new RuntimeManager({
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
  });
  let starts = 0;
  const fake = {
    kind: RUNTIME_KERNEL_NAME,
    url: "http://127.0.0.1:49152",
    close: async () => {},
    password: null,
    sandboxMode: "host",
    networkMode: null,
    workspaceDir: project.workspaceDir,
    proxyWorkspaceDir: project.workspaceDir,
    startedAt: new Date().toISOString(),
    pid: 123,
    exitedAt: null,
  };
  manager.startKernel = async () => {
    starts += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return fake;
  };

  const [a, b] = await Promise.all([manager.start(project), manager.start(project)]);

  assert.equal(a, fake);
  assert.equal(b, fake);
  assert.equal(starts, 1);
});

test("RuntimeManager stops an in-flight start after stop is requested", async () => {
  const manager = new RuntimeManager({
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
  });
  let releaseStart;
  let closed = false;
  manager.startKernel = async () => {
    await new Promise((resolve) => {
      releaseStart = resolve;
    });
    return {
      ...fakeRuntime(project.id),
      close: async () => {
        closed = true;
      },
    };
  };

  const started = manager.start(project);
  for (let i = 0; i < 20 && manager.starts.size === 0; i++) await sleep(1);
  await manager.stop(project);
  assert.equal(closed, false);

  releaseStart();
  await started;
  for (let i = 0; i < 20 && !closed; i++) await sleep(1);

  assert.equal(closed, true);
  assert.equal(manager.runtimes.size, 0);
});

test("RuntimeManager enforces global runtime capacity including in-flight starts", async () => {
  const manager = new RuntimeManager({
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    maxRunningRuntimes: 1,
    maxRunningRuntimesPerUser: 10,
  });
  let releaseFirst;
  const projectB = { ...project, id: "paper2" };
  manager.startKernel = async (currentProject) => {
    if (currentProject.id === project.id) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    return fakeRuntime(currentProject.id);
  };

  const first = manager.start(project);
  for (let i = 0; i < 20 && manager.starts.size === 0; i++) await sleep(1);

  await assert.rejects(
    () => manager.start(projectB),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, "runtime_limit_exceeded");
      assert.match(err.message, /server/);
      return true;
    },
  );

  releaseFirst();
  await first;
  await manager.closeAll();
});

test("RuntimeManager enforces per-user runtime capacity across projects", async () => {
  const manager = new RuntimeManager({
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    maxRunningRuntimes: 10,
    maxRunningRuntimesPerUser: 1,
  });
  manager.startKernel = async (currentProject) => fakeRuntime(`${currentProject.userId}-${currentProject.id}`);
  const projectB = { ...project, id: "paper2" };
  const bobProject = { ...project, userId: "bob", id: "paper2" };

  await manager.start(project);
  await assert.rejects(
    () => manager.start(projectB),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, "runtime_limit_exceeded");
      assert.match(err.message, /user/);
      return true;
    },
  );

  const bobRuntime = await manager.start(bobProject);
  assert.equal(bobRuntime.url, "http://127.0.0.1/bob-paper2");
  await manager.closeAll();
});

test("the kernel names the entrypoint, the socket and the authority — and nothing about the isolation", () => {
  // This used to build two plans, one per kernel, and assert that only the
  // entrypoint differed. There is one kernel, so the comparison has no second
  // side; the property it protected survives as a pinned set. Everything below
  // is EviMed's isolation rather than the kernel's, and it is enumerated
  // exhaustively so that a widened blast radius fails here instead of shipping.
  const dataDir = "/data";
  const volumeProject = {
    ...project,
    rootDir: "/data/users/alice/projects/paper1",
    workspaceDir: "/data/users/alice/projects/paper1/workspace/session-1",
    runtimeDir: "/data/users/alice/projects/paper1/runtime",
  };
  const dsh = buildRuntimeLaunchPlan(
    {
      dataDir,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeDataVolume: "open-science-data",
      runtimeTransport: "unix",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      runtimeNoNewPrivileges: true,
      runtimeCapDrop: "ALL",
      runtimeReadOnlyRoot: true,
      runtimeTmpfs: "/tmp:rw,nosuid,nodev,size=64m",
      runtimeContainerUser: "1000:1000",
      allowRuntimeHostNetwork: false,
    },
    volumeProject,
    4096,
  );

  // The three places the kernel's name is allowed to appear, all derived from
  // one binding so a ledger record, a socket name and an authority cannot
  // drift apart.
  assert.equal(dsh.runtimeUrl, `http://${RUNTIME_KERNEL_NAME}.runtime`);
  assert.ok(dsh.socketPath.endsWith(`/${RUNTIME_KERNEL_NAME}.sock`), dsh.socketPath);
  assert.equal(dsh.args.at(-1), `open-science-${RUNTIME_KERNEL_NAME}-serve`);

  assert.ok(dsh.args.includes("DSH_TELEMETRY_DISABLED=1"), "telemetry has no redaction rules and must be off in the container too");
  assert.ok(dsh.args.includes("DSH_PERMISSION_MODE=workspace-write"));
  assert.ok(dsh.args.includes(`DSH_HOME=${runtimeDshHome}`), "session logs belong on the project volume, not in the container");

  // The Host the control plane will send has to be a host the container will
  // accept. DSH's /api fence refuses any request whose Host is neither loopback
  // nor a declared trusted host — every request, not only ones with browser
  // markers — so a container that declares a different authority starts cleanly
  // and then refuses every call. The mock kernel cannot catch this: it does not
  // enforce the fence.
  assert.ok(
    dsh.args.includes(`OPEN_SCIENCE_RUNTIME_AUTHORITY=${new URL(dsh.runtimeUrl).host}`),
    "the container must be told the authority the control plane will send",
  );

  // The isolation, pinned. Named exhaustively rather than compared against a
  // second plan: every flag here is a bound the container is confined by, and
  // one that quietly stops being emitted is exactly the change this test
  // exists to catch.
  const isolationArgs = dsh.args.filter((arg) => /^(--cap-drop|--security-opt|--read-only|--pids-limit|--network|--mount|--user|--memory|--cpus)$|^type=volume/.test(String(arg)));
  assert.ok(dsh.args.includes("--tmpfs"), "the 64 MiB /tmp bound is part of the isolation");
  assert.deepEqual(isolationArgs, [
    "--security-opt",
    "--cap-drop",
    "--pids-limit",
    "--read-only",
    "--user",
    "--network",
    "--cpus",
    "--memory",
    "--mount",
    "type=volume,src=open-science-data,dst=/workspace,volume-subpath=users/alice/projects/paper1/workspace/session-1",
    "--mount",
    "type=volume,src=open-science-data,dst=/runtime,volume-subpath=users/alice/projects/paper1/runtime/container-runtime",
    "--mount",
    "type=volume,src=open-science-data,dst=/runtime-control,volume-subpath=.runtime-sockets/810502d24441cfd45914a2ac",
  ]);
});

// Both defects below were invisible to every test in this suite until the real
// launcher was run: the fake kernel accepts any argv and enforces no fence, so
// a container that could never have started looked perfectly healthy.
test("the launcher is invoked in a form dsh accepts", async () => {
  const { readFile } = await import("node:fs/promises");
  const serve = await readFile(new URL("../../../deploy/runtime-dsh/open-science-dsh-serve.sh", import.meta.url), "utf8");

  // `web` is an alias for `--profile web`; the launcher refuses both at once
  // with "web takes none of parent --profile, --patch, --dump-config, or
  // --dump-default-config", so the container exits on its first line.
  const invocation = serve.split("\n").find((line) => line.startsWith("dsh --profile"));
  assert.ok(invocation, "the serve script must launch the kernel");
  assert.equal(/\bweb\b/.test(invocation), false, invocation);
  assert.match(invocation, /--trusted-host "\$\{authority\}"/);

  const plan = buildRuntimeLaunchPlan(
    {
      dataDir: "/tmp/os-dsh-argv",
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeTransport: "unix",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
    },
    {
      id: "p1",
      userId: "u1",
      rootDir: "/tmp/os-dsh-argv/p1",
      workspaceDir: "/tmp/os-dsh-argv/p1/workspace",
      runtimeDir: "/tmp/os-dsh-argv/p1/runtime",
    },
    4096,
  );
  // The plan names the script above and passes it nothing. It used to hand the
  // launcher its own argv on the TCP transport; that transport is refused now,
  // because the entrypoint that seeds the profile is the same script that runs
  // the socat bridge and a TCP runtime skipped it and died during boot saying
  // it had no profile.
  const argv = plan.args.slice(plan.args.indexOf("evimed-runtime-dsh:test") + 1);
  assert.deepEqual(argv, ["open-science-dsh-serve"]);
  assert.equal(
    new URL("../../../deploy/runtime-dsh/open-science-dsh-serve.sh", import.meta.url).pathname.split("/").at(-1),
    `${argv[0]}.sh`,
    "the entrypoint the plan names must be the script that was just read",
  );
  assert.throws(
    () => buildRuntimeLaunchPlan(
      {
        dataDir: "/tmp/os-dsh-argv",
        runtimeSandboxMode: "docker",
        runtimeContainerBin: "docker",
        runtimeContainerImage: "evimed-runtime-dsh:test",
        runtimeTransport: "tcp",
        runtimeNetworkMode: "none",
        runtimeCpuLimit: "1",
        runtimeMemoryLimit: "1g",
        runtimePidsLimit: 64,
        allowRuntimeHostNetwork: false,
      },
      { id: "p1", userId: "u1", rootDir: "/tmp/os-dsh-argv/p1", workspaceDir: "/tmp/os-dsh-argv/p1/workspace", runtimeDir: "/tmp/os-dsh-argv/p1/runtime" },
      4096,
    ),
    (error) => error?.code === "invalid_runtime_transport",
  );
});

// The plugin side has no other way to learn the ledger's run id — the wire
// protocol's session.create/session.prompt only ever carry a session id — so
// without this file `evimed-run-policy`'s own runId stays empty, every write
// it makes to the run-mirror tables is gated on that id, and
// .evimed-run/state.json (what the control plane and browser read for
// evidence/plan/gate state) is never produced. Found while wiring the SSE
// event pump: nothing exercised this path before.
async function dshDispatchFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "os-dsh-brief-index-"));
  const project = {
    id: "paper-brief",
    userId: "alice",
    rootDir,
    metaDir: path.join(rootDir, ".openscience"),
    workspaceDir: path.join(rootDir, "workspace"),
    runtimeDir: path.join(rootDir, "runtime"),
  };
  const manager = new RuntimeManager({ runtimeMode: "mock", allowMockRuntime: true, production: false });
  return { rootDir, project, manager };
}

test("dispatching a DSH prompt writes the run's own id into the workspace brief", async (t) => {
  const { rootDir, project, manager } = await dshDispatchFixture();
  t.after(async () => {
    await manager.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  await manager.start(project);
  await manager.dispatchPrompt(project, "ses_brief", { text: "hello", runId: "run_brief_1" });
  const written = JSON.parse(await readFile(path.join(project.workspaceDir, ".evimed-brief", "index.json"), "utf8"));
  assert.deepEqual(written, { runId: "run_brief_1" });
});

test("dispatching a DSH prompt without a run id leaves the brief index unwritten", async (t) => {
  const { rootDir, project, manager } = await dshDispatchFixture();
  t.after(async () => {
    await manager.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  await manager.start(project);
  await manager.dispatchPrompt(project, "ses_no_id", { text: "hello" });
  await assert.rejects(() => readFile(path.join(project.workspaceDir, ".evimed-brief", "index.json"), "utf8"), { code: "ENOENT" });
});

test("dispatchPrompt materializes the research context beside the run id", async (t) => {
  // There is one dispatcher now — the kernel-specific one merged into it — so
  // the property worth keeping at this slot is the other half of what it
  // writes. The context does not travel with the prompt: the protocol has no
  // `system` field, and inventing a side channel for it would break the
  // runtime's own invariant that everything the model sees is in the log. It
  // goes into the workspace and the socket injects it at session start.
  const { rootDir, project, manager } = await dshDispatchFixture();
  t.after(async () => {
    await manager.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  await manager.start(project);
  await manager.dispatchPrompt(project, "ses_general", { text: "hello", system: "# Brief\n", runId: "run_brief_2" });
  const written = JSON.parse(await readFile(path.join(project.workspaceDir, ".evimed-brief", "index.json"), "utf8"));
  assert.deepEqual(written, { runId: "run_brief_2" });
  assert.equal(await readFile(path.join(project.workspaceDir, ".evimed-brief", "context.md"), "utf8"), "# Brief\n");
});

test("the kernel spills onto the project volume, not into the 64 MiB tmpfs", async () => {
  // `--tmpfs /tmp:...size=64m` is a security bound. Both spill writers resolve
  // their directory from `os.tmpdir()` — `dsh-spill-local` writes the FULL text
  // of every tool result over `maxInlineBytes`, `dsh-subprocess-local` writes
  // captured bash output — and TMPDIR was set nowhere, so both landed on that
  // 64 MiB. Neither is pruned and the container is long-lived per project, so
  // it accumulates across a whole session history.
  //
  // What happens when it fills is the part worth a test: `spill-policy` catches
  // the failed write, warns INSIDE the container where nothing reads it, and
  // returns — which keeps the full untruncated text inline. The cap stops
  // applying silently and every oversized result enters the model's context
  // whole.
  const plan = buildRuntimeLaunchPlan(
    {
      dataDir: "/tmp/os-dsh-tmpdir",
      runtimeKernel: "dsh",
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeTransport: "unix",
      runtimeNetworkMode: "none",
      runtimeCpuLimit: "1",
      runtimeMemoryLimit: "1g",
      runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false,
      // The production default, spelled out: without it the plan emits no
      // `--tmpfs` at all and the control below would pass by absence rather
      // than because the bound survived.
      runtimeTmpfs: "/tmp:rw,nosuid,nodev,size=64m",
    },
    {
      id: "p1",
      userId: "u1",
      rootDir: "/tmp/os-dsh-tmpdir/p1",
      workspaceDir: "/tmp/os-dsh-tmpdir/p1/workspace",
      runtimeDir: "/tmp/os-dsh-tmpdir/p1/runtime",
    },
    4096,
  );

  assert.ok(plan.args.includes(`TMPDIR=${runtimeTmpDir}`), "the kernel's temp root must be off the tmpfs");

  // The container path has to resolve to a host directory this plan creates,
  // or the container starts with a TMPDIR it cannot write to — which fails the
  // same way the tmpfs did, only sooner. Derived from the mount rather than
  // matched as a string: the host path ends in `container-runtime/tmp` while
  // the container sees `/runtime/tmp`, and an assertion on either spelling
  // alone would pass while they pointed at different places.
  const mount = plan.args.find((arg) => typeof arg === "string" && arg.includes(",dst=/runtime"));
  assert.ok(mount, "the project volume must be mounted at /runtime");
  const hostRuntimeRoot = mount.slice(mount.indexOf("src=") + 4, mount.indexOf(",dst="));
  const expectedHostTmp = path.join(hostRuntimeRoot, runtimeTmpDir.slice("/runtime/".length));
  assert.ok(
    plan.runtimeDirs.includes(expectedHostTmp),
    `the plan must create ${expectedHostTmp}; it creates ${JSON.stringify(plan.runtimeDirs)}`,
  );

  // Negative controls.
  // The tmpfs itself must stay: it is a security bound, and moving the spill
  // off it is not a reason to stop bounding /tmp.
  assert.ok(plan.args.includes("--tmpfs"), "the tmpfs bound must survive the fix");
  // And the spill must not be pointed anywhere the project cannot own: this is
  // per-project state, quota-accounted, deleted with the project.
  assert.match(runtimeTmpDir, /^\/runtime\//, "the spill belongs on the project volume");
  assert.notEqual(runtimeTmpDir, runtimeDshHome, "and not inside the kernel's home, which holds credentials");
});

test("a container that dies on its own is asked why, and only then removed", async () => {
  // Two halves that must both hold. Recording the cause is useless if the
  // container leaks; removing it first is what made the cause unavailable.
  const source = await readFile(new URL("../src/runtimeManager.mjs", import.meta.url), "utf8");
  // Comments stripped: they name the very things being checked, and a check
  // that matches its own explanation proves nothing — a mistake this audit has
  // now made three times.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The runtime's own exit handler, not the two unrelated ones earlier in the
  // file — `indexOf` found `waitForProcess`'s first and the assertions below
  // then measured the wrong function.
  const marker = 'appendRuntimeEvent(project, "exited"';
  const at = code.indexOf(marker);
  assert.ok(at > 0, "the runtime exit handler must record an `exited` event");
  const handlerStart = code.lastIndexOf('once("exit"', at);
  assert.ok(handlerStart > 0, "that record must live inside an exit handler");
  const body = code.slice(handlerStart, code.indexOf("recordRuntimeState", at));

  // The exit status is an argument, not something to go looking for. It was
  // discarded by a `()` parameter list for the life of this handler.
  // Asserted on the assignments, not on the parameter list or the field names.
  // `once("exit", () => {` also matches a pattern looking for an open paren,
  // and `exitCode` still appears in the record even when nothing sets it — the
  // first version of this control stayed green with the status discarded.
  for (const [field, from] of [["exitCode", "code"], ["exitSignal", "signal"]]) {
    const assignment = new RegExp(`runtime\\.${field}\\s*=[^;]*\\b${from}\\b`);
    assert.match(body, assignment, `${field} must be taken from the callback's own ${from} argument`);
  }
  assert.match(body, /runtime\.exitOutput\s*=/, "the container's last words must be captured onto the record");
  for (const field of ["exitCode", "exitSignal", "exitOutput"]) {
    assert.ok(body.includes(`${field}: runtime.${field}`) || body.includes(`${field}: runtime.exitOutput`), `the exited record must carry ${field}`);
  }
  // Removal comes after the record, or the evidence is gone again.
  const recordAt = body.indexOf(marker);
  const removeAt = body.indexOf("cleanupDockerContainer(plan)");
  assert.ok(recordAt >= 0, "the exit must be recorded");
  assert.ok(removeAt >= 0, "a container that dies on its own must still be removed, or dropping --rm leaks it");
  assert.ok(removeAt > recordAt, "ask, then remove — the other order is what deleted the evidence");

  // And the controller reports what a code alone cannot distinguish.
  const controller = await readFile(new URL("../src/runtimeControllerServer.mjs", import.meta.url), "utf8");
  assert.match(controller, /\{\{\.State\.OOMKilled\}\}/, "137 with and without an OOM kill lead to opposite fixes");
  assert.match(controller, /oomKilled:/);
});

test("every runtime record names the kernel through the one binding, not a literal", async () => {
  // Twelve literals said `opencode`, so every `exited`, `cleanup_failed` and
  // state record a DSH container produced was labelled with the other kernel.
  // Harmless alone, and kernel-blind for any reader that branches on it —
  // the same family as the image-label and release-manifest comparisons that
  // each had to learn the switch separately. One kernel does not retire the
  // property: a name written out by hand is a name that drifts from the socket
  // and the authority derived from the binding.
  const source = await readFile(new URL("../src/runtimeManager.mjs", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const literals = code.match(/kind: "(?:opencode|dsh)"/g) ?? [];
  assert.deepEqual(literals, [], `${literals.length} runtime records still hardcode the kernel name`);
  const bound = code.match(/kind: RUNTIME_KERNEL_NAME/g) ?? [];
  assert.ok(bound.length >= 9, `only ${bound.length} records ask the binding which kernel is running`);
  // And the binding is what the socket and the authority are built from, so the
  // three cannot drift apart.
  assert.match(code, /RUNTIME_AUTHORITY = `\$\{RUNTIME_KERNEL_NAME\}\.runtime`/);
  assert.match(code, /RUNTIME_SOCKET_FILE_NAME = `\$\{RUNTIME_KERNEL_NAME\}\.sock`/);
});

test("pid pressure is reported while the run is alive, and only once", () => {
  // The ceiling that killed three runs left one line of container output as its
  // only trace, readable solely after the fact. This says it during the run.
  //
  // Asserted against the real `recordPidSample`. The first version of this test
  // substituted the manager's method with a reimplementation of the same rule
  // and passed — proving the copy in the test, which is the exact defect this
  // audit has spent the day removing, committed while removing it.
  const runtime = {};
  assert.equal(recordPidSample(runtime, 40, 100), false, "well under the ceiling is not pressure");
  assert.equal(recordPidSample(runtime, 79, 100), false, "one below four fifths is still not pressure");
  assert.equal(recordPidSample(runtime, 80, 100), true, "four fifths of the ceiling is worth saying out loud");
  assert.equal(recordPidSample(runtime, 95, 100), false, "said once per runtime, not once per poll");

  // The peak is kept regardless, because "how close did it get" is the question
  // a raised ceiling has to answer, and a run that never crossed the threshold
  // still has an answer to it.
  assert.equal(runtime.peakPids, 95);

  // Negative controls: a missing or nonsensical limit must not report pressure,
  // and must not claim a peak it did not measure.
  const bare = {};
  assert.equal(recordPidSample(bare, 500, 0), false, "no ceiling means no pressure to report");
  assert.equal(recordPidSample(bare, Number.NaN, 100), false);
  assert.equal(bare.peakPids, undefined, "a rejected sample is not a measurement");
});

test("the memory ceiling is read in docker's own grammar, and an unreadable one disables the check", () => {
  // `runtimeMemoryLimit` is a string because `docker run --memory` takes one.
  // Comparing a byte count against "8g" without parsing it is how a pressure
  // check reports nothing forever — the shape of defect this whole audit is
  // about, and the reason this tiny function has a test at all.
  assert.equal(parseByteSize("4g"), 4 * 1024 ** 3);
  assert.equal(parseByteSize("8g"), 8 * 1024 ** 3);
  assert.equal(parseByteSize("512m"), 512 * 1024 ** 2);
  assert.equal(parseByteSize("2G"), 2 * 1024 ** 3, "docker accepts either case");
  assert.equal(parseByteSize("1024"), 1024, "a bare number is bytes");

  // Negative controls: anything unreadable must return 0, which the caller
  // treats as "no ceiling to compare against" rather than as a ceiling of zero
  // — the latter would report pressure on every sample of every run.
  for (const bad of ["bad", "", null, undefined, "-1g", "g", "4x"]) {
    assert.equal(parseByteSize(bad), 0, `${JSON.stringify(bad)} is not a size`);
  }
  // A zero the pattern accepts is the case the positivity guard exists for:
  // these reach the arithmetic and come out 0, and a caller that read 0 as a
  // real ceiling would report pressure on every sample of every run. The first
  // version of this control removed that guard and stayed green, because every
  // input it tried was already rejected by the pattern one line earlier —
  // a mutation that changed no behaviour rather than a weak assertion.
  for (const zero of ["0g", "0", "0.0m", "00"]) {
    assert.equal(parseByteSize(zero), 0, `${JSON.stringify(zero)} must not read as a ceiling`);
  }
  // The case the guard is actually for, and it took two failed controls to
  // find: the pattern puts no bound on digit count, so a long enough literal
  // overflows to Infinity. An infinite ceiling makes the pressure check
  // unreachable — every real reading is below it — which is the "reports
  // nothing forever" failure in its purest form.
  assert.equal(parseByteSize(`${"9".repeat(400)}g`), 0, "an overflowed ceiling is not a ceiling");
});

// --- abandoned response bodies -------------------------------------------

test("a body read abandoned over the size limit kills the stream, not just the reader lock", async () => {
  // `releaseLock()` alone detaches the reader and leaves the response paused
  // forever. On a unix-socket runtime that is one leaked fd here and one live
  // socat fork inside the container — measured at 1368 fds on the control
  // plane after a run whose transcript outgrew maxJsonBytes, because every
  // history poll threw 413 here and retried.
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readRuntimeResponseBody(body, 4096),
    (error) => error?.code === "runtime_proxy_response_too_large",
  );

  assert.equal(cancelled, true, "the underlying stream must be cancelled, or its socket never closes");
});

test("an over-limit response releases its socket, proven at the socket, not at the API", async () => {
  // The unit test above can be satisfied by calling cancel() on a stream whose
  // socket stays open anyway. This one watches the server side of a real
  // connection: the server must observe the close. It fails on the unfixed
  // code by timing out — which is exactly how the leak behaved in production.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-leak-"));
  const socketPath = path.join(tmp, "runtime.sock");
  /** @type {(value: void) => void} */
  let sawClose;
  const closed = new Promise((resolve) => { sawClose = resolve; });
  const server = createServer((req, res) => {
    res.socket?.once("close", () => sawClose());
    res.writeHead(200, { "content-type": "application/octet-stream" });
    // More than the read limit below, in several chunks, then never end: a
    // transcript endpoint mid-stream. The close must come from the client.
    for (let i = 0; i < 8; i += 1) res.write(Buffer.alloc(64 * 1024));
  });
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)));
  try {
    const runtime = { socketPath, url: "http://runtime.local", password: null };
    const response = await requestRuntime(runtime, "http://runtime.local/session/history", {});
    assert.equal(response.status, 200);

    await assert.rejects(
      readRuntimeResponseBody(response.body, 128 * 1024),
      (error) => error?.code === "runtime_proxy_response_too_large",
    );

    /** @type {NodeJS.Timeout | undefined} */
    let guard;
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error("the server never saw the connection close: the socket leaked")), 5_000);
        guard.unref?.();
      }),
    ]);
    clearTimeout(guard);
  } finally {
    // Force-close whatever is still open. When this test FAILS, the leaked
    // socket itself would otherwise keep the event loop alive and hang the
    // whole test process — the bug preventing its own test run from ending.
    server.closeAllConnections?.();
    server.close();
    await rm(tmp, { recursive: true, force: true });
  }
});


test("the path form of the kernel's browser application is retired by name", async (t) => {
  // It could serve the document and every asset and still not work: the
  // application's plugin bundles and method calls are absolute paths built
  // from `location.origin`, so under a prefix they arrived at this control
  // plane and were answered with its own single-page document. Every request
  // read 200 and the page died at boot with "bootstrap facade is missing".
  // 410 rather than 404 because the path was linked to.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-ui-path-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime-ui/default/`);
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, "runtime_ui_path_retired");
});

test("the retired pass-through stays retired when the browser application is enabled", async (t) => {
  // Enabling one surface must not resurrect the other: `/api/opencode/` is the
  // route already-deployed clients type, and it has to keep saying what
  // replaced it rather than starting to work again.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-ui-on-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true, runtimeUiProxyEnabled: true,
  });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const retired = await fetch(`http://127.0.0.1:${address.port}/api/opencode/default/session`, {
    headers: { "x-open-science-project": "default" },
  });
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).code, "runtime_passthrough_retired");
});

/**
 * An app with the browser-application origin bound, and a logged-in cookie for
 * it. The cookie is the same one the control plane issued: ports are not part
 * of a site, so the browser sends it to both.
 */
async function uiSurfaceFixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-ui-origin-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: true,
    runtimeUiProxyEnabled: true,
    runtimeUiPort: 0,
    publicUrl: "https://science.example",
    runtimeUiPublicOrigin: "https://science.example:8443",
    ...overrides,
  });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seeded = await fetch(`http://127.0.0.1:${address.port}/api/projects`);
  const cookie = (seeded.headers.getSetCookie?.() ?? []).map((item) => item.split(";")[0]).join("; ");
  assert.ok(cookie, "the fixture needs a session cookie");
  const ui = app.runtimeUi.address();
  assert.ok(ui, "the browser-application origin must be bound when the surface is on");
  return { app, address, cookie, uiBase: `http://127.0.0.1:${ui.port}` };
}

test("the browser application's origin is bound only when the deployment serves it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-ui-off-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true });
  await app.listen(0, "127.0.0.1");
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(app.runtimeUi.address(), null, "an unserved surface must not hold a port open");
});

test("the browser application's origin refuses anyone who is not logged in", async (t) => {
  const { uiBase } = await uiSurfaceFixture(t);
  const anonymous = await fetch(`${uiBase}/`, { redirect: "manual" });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("content-type") ?? "", /text\/html/, "a frame shows a page, not JSON");
});

test("the hosted browser application cannot reach the methods that change the deployment", async (t) => {
  // The panels that call these are hidden in the profile, but hiding a panel
  // hides a button: the page is JavaScript and can call anything. Each of
  // these either rewrites the runtime's own configuration, chooses a model the
  // release receipt does not certify, swaps the composition every gate
  // assumes, or reaches outside the project.
  const { uiBase, cookie } = await uiSurfaceFixture(t);
  const denied = [
    "settings/update",
    "settings/describe",
    "credentials/set",
    "llm/discoverModels",
    "directoryPicker/pick",
    "goals/create",
    "agentTeams/createTask",
    "cordis/dynamic-package",
    "messageFeedback/put",
    "agentPresets/select",
    "session/selectModel",
    "session/openWorkspacePath",
    "workspace/delete",
  ];
  for (const method of denied) {
    const response = await fetch(`${uiBase}/api/${method}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403, `${method} must be refused`);
    const body = await response.json();
    assert.equal(body.error.code, "runtime_ui_method_denied");
    assert.match(body.error.message, new RegExp(method.replace("/", "\\/")), "the refusal names the method");
  }

  // And the conversation itself is not collateral damage: whatever the kernel
  // answers, it is not this surface refusing the call.
  const allowed = await fetch(`${uiBase}/api/session/create`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  const body = await allowed.json().catch(() => ({}));
  assert.notEqual(body?.error?.code, "runtime_ui_method_denied");
});

test("the frame is pinned to a project by cookie, and only to a project its viewer owns", async (t) => {
  const { uiBase, cookie, address } = await uiSurfaceFixture(t);
  const created = await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "second", name: "Second" }),
  });
  assert.ok([200, 201].includes(created.status), `creating the second project answered ${created.status}`);

  const pinned = await fetch(`${uiBase}/?project=second`, { headers: { cookie }, redirect: "manual" });
  assert.equal(pinned.status, 302);
  assert.equal(pinned.headers.get("location"), "/", "the parameter must not survive into the application");
  const setCookie = (pinned.headers.getSetCookie?.() ?? []).join("; ");
  assert.match(setCookie, /evimed_ui_project=second/);
  assert.match(setCookie, /HttpOnly/);

  // A project the viewer does not own is refused rather than quietly replaced
  // by their default one: a frame showing a different project than the shell
  // asked for is worse than an error.
  const foreign = await fetch(`${uiBase}/?project=someone-elses`, { headers: { cookie }, redirect: "manual" });
  assert.ok(foreign.status >= 400, `a foreign project answered ${foreign.status}`);
  assert.ok(foreign.status !== 302, "a foreign project must not be pinned");
});

test("an unauthenticated browser-application socket is refused", async (t) => {
  const { uiBase } = await uiSurfaceFixture(t);
  const port = Number(new URL(uiBase).port);
  const result = await new Promise((resolve) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/remote.mux",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ upgraded: true, status: res.statusCode }); });
    req.on("response", (res) => { res.resume(); resolve({ upgraded: false, status: res.statusCode }); });
    req.on("error", () => resolve({ upgraded: false, status: 0 }));
    req.end();
  });
  assert.equal(result.upgraded, false);
  assert.equal(result.status, 401);
});

test("a production deployment cannot serve the application at an address nobody can reach", async () => {
  // Switched on with no port is a listener on an arbitrary free one; switched
  // on with no public origin is a page that cannot name what to frame. Both
  // read, from the outside, exactly like the product having no session surface.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-ui-readiness-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    allowMockRuntime: true,
    production: true,
    runtimeUiProxyEnabled: true,
    runtimeUiPort: 0,
    publicUrl: "https://science.example",
  });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const ready = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
    const body = await ready.json();
    const runtime = body?.data?.checks?.runtime ?? body?.checks?.runtime ?? {};
    assert.equal(runtime.ok, false, "readiness must refuse the pair");
    assert.equal(runtime.code, "runtime_ui_port_required");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("starting a runtime is refused for an account over its spend cap", async () => {
  // The other surface. A run begun inside the kernel's own browser application
  // never passes through `/api/agent-runs/dispatch`, and that application is
  // the primary one — a cap that only guarded dispatch would be a cap the
  // product's main path walks around.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-spend-"));
  try {
    await mkdir(path.join(dataDir, ".openscience"), { recursive: true });
    await writeFile(
      path.join(dataDir, ".openscience", "usage.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        resourceType: "model",
        userId: "alice",
        projectId: "paper1",
        model: "deepseek-v4-pro",
        cacheHit: 0,
        cacheMiss: 1000,
        output: 500,
        cost: 40,
        currency: "CNY",
        priced: true,
      })}\n`,
      "utf8",
    );

    const manager = new RuntimeManager({ dataDir, userDailySpendLimit: 10, maxLogReadBytes: 1024 * 1024 });
    // Bounded on purpose: "refused before anything starts" is the property, so
    // a build that stopped refusing must fail here as a wrong answer rather
    // than as a test that hangs on a real container start.
    const refusal = await Promise.race([
      manager.start(project).then(() => null, (error) => error),
      sleep(5_000).then(() => "no refusal within 5s; start() got past the cap"),
    ]);
    assert.notEqual(refusal, "no refusal within 5s; start() got past the cap");
    assert.equal(refusal?.status, 402);
    assert.equal(refusal?.code, "credits_daily_limit_reached");

    // "No cap set refuses nothing" is a property of the check itself and is
    // covered where the check lives; asserting it here would mean waiting for
    // a real container start to fail for its own unrelated reasons.
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
