import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { assertDockerDataVolumeSupport } from "../src/dockerMounts.mjs";
import {
  RuntimeManager,
  buildOpenCodeLaunchPlan,
  cleanupHostRuntimeProcess,
  cleanupDockerContainer,
  requestRuntime,
  runtimeContainerName,
  syncRuntimeAgentPackages,
  syncRuntimeSkills,
} from "../src/runtimeManager.mjs";
import { runtimeReleaseConfig } from "./releaseFixture.mjs";

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
    kind: "opencode",
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

async function createRuntimeAgentFixture(root, id = "test-analysis") {
  const packageRoot = path.join(root, "agent-packages");
  const packageDir = path.join(packageRoot, id);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "agent.yaml"),
    `id: ${id}
version: 1.0.0
title: Test Analysis
category: Test Research
description: Exercise deterministic runtime package bootstrap.
skill: ${id}
companionSkills:
  - deep-research
  - citation-integrity
estimatedMinutes: [5, 10]
starterPrompts:
  - Analyze the test evidence.
requiredInputs:
  - topic
optionalInputs: []
requiredTools:
  - evimed_term_normalize
optionalTools:
  - evimed_literature_search
dataSources:
  - literature
outputs:
  - path: reports/test-analysis.md
    required: true
  - path: artifacts/test-analysis.json
    required: false
completionChecks:
  - requiredOutputsExist
  - citationsResolvable
`,
  );
  await writeFile(
    path.join(packageDir, "SKILL.md"),
    `---
name: ${id}
description: Test-only specialty skill.
---

# Private skill instructions

This sentence must not be copied into the generated custom-agent body.
`,
  );
  return {
    packageRoot,
    packageDir,
    registry: await loadAgentRegistry({ packageDirs: [packageRoot] }),
  };
}

async function fakeHostRuntimeBootstrapBin(root) {
  const bin = path.join(root, "opencode-bootstrap-stub.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const skill = path.join(process.env.XDG_CONFIG_HOME, "opencode", "skills", "test-analysis", "SKILL.md");
const agent = path.join(process.env.XDG_CONFIG_HOME, "opencode", "agents", "evimed-test-analysis.md");
if (!fs.existsSync(skill) || !fs.existsSync(agent)) process.exit(70);

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/config")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true }));
    return;
  }
  res.writeHead(404).end();
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(port, "127.0.0.1");
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

async function fakeHostSpawnMarkerBin(root) {
  const bin = path.join(root, "opencode-spawn-marker.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.RUNTIME_SPAWN_MARKER, "spawned\\n");
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
const socketPath = path.join(runtimeRoot, "opencode.sock");
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });

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

test("buildOpenCodeLaunchPlan generates a container sandbox launch command", () => {
  const plan = buildOpenCodeLaunchPlan(
    {
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "open-science-opencode:test",
      runtimeTransport: "tcp",
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
    "pw-test",
  );

  assert.equal(plan.command, "docker");
  assert.equal(plan.sandboxMode, "docker");
  assert.equal(plan.containerName, runtimeContainerName(project));
  assert.equal(plan.proxyWorkspaceDir, "/workspace");
  assert.deepEqual(plan.args.slice(0, 7), ["run", "--rm", "--init", "--name", plan.containerName, "--label", "open-science.web.runtime=true"]);
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
  assert.ok(plan.args.includes("127.0.0.1:49152:49152"));
  assert.ok(plan.args.includes(`type=bind,src=${project.workspaceDir},dst=/workspace`));
  assert.ok(plan.args.includes("HOME=/runtime/home"));
  assert.ok(plan.args.includes("open-science-opencode:test"));
  assert.equal(plan.args.at(-6), "opencode");
  assert.ok(plan.runtimeDirs.includes(path.join(project.runtimeDir, "container-runtime")));
  assert.ok(plan.runtimeDirs.includes(path.join(project.runtimeDir, "container-runtime/home")));
});

test("buildOpenCodeLaunchPlan shares only project volume subpaths over a Unix socket", () => {
  const dataDir = "/data";
  const volumeProject = {
    ...project,
    rootDir: "/data/users/alice/projects/paper1",
    workspaceDir: "/data/users/alice/projects/paper1/workspace/session-1",
    runtimeDir: "/data/users/alice/projects/paper1/runtime",
  };
  const plan = buildOpenCodeLaunchPlan(
    {
      dataDir,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "open-science-opencode:test",
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
    "pw-test",
  );

  assert.equal(plan.runtimeUrl, "http://opencode.runtime");
  assert.equal(plan.socketPath, "/data/.runtime-sockets/810502d24441cfd45914a2ac/opencode.sock");
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
  assert.ok(plan.args.includes("OPEN_SCIENCE_RUNTIME_SOCKET=/runtime-control/opencode.sock"));
  assert.equal(plan.args.at(-1), "open-science-opencode-serve");
});

test("buildOpenCodeLaunchPlan rejects unsafe volume names and paths outside the data volume", () => {
  const base = {
    dataDir: "/data",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: "docker",
    runtimeContainerImage: "open-science-opencode:test",
    runtimeDataVolume: "open-science-data",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
  };
  assert.throws(
    () => buildOpenCodeLaunchPlan({ ...base, runtimeDataVolume: "unsafe/volume" }, project, 4096, "pw-test"),
    (error) => error?.code === "invalid_runtime_data_volume",
  );
  assert.throws(
    () => buildOpenCodeLaunchPlan(base, project, 4096, "pw-test"),
    (error) => error?.code === "runtime_data_path_outside_volume",
  );
});

test("Unix runtime sockets use a bounded hashed path for long tenant and project identifiers", () => {
  const userId = "u".repeat(64);
  const projectId = "p".repeat(64);
  const dataDir = "/data";
  const rootDir = path.join(dataDir, "users", userId, "projects", projectId);
  const plan = buildOpenCodeLaunchPlan(
    {
      dataDir,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "open-science-opencode:test",
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
    "pw-test",
  );

  assert.ok(Buffer.byteLength(plan.socketPath) < 108);
  assert.match(plan.socketPath, /^\/data\/\.runtime-sockets\/[a-f0-9]{24}\/opencode\.sock$/);
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
  const socketPath = path.join(tmp, "opencode.sock");
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
      { url: "http://opencode.runtime", socketPath },
      "http://opencode.runtime/event?directory=%2Fworkspace",
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

test("RuntimeManager reads authoritative OpenCode session status without waking a stopped runtime", async () => {
  let payload = { ses_busy: { type: "busy" }, ses_retry: { type: "retry", attempt: 1 } };
  const server = createServer((req, res) => {
    assert.match(req.url ?? "", /^\/session\/status\?directory=/);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
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
    assert.equal(await manager.sessionStatus(runtimeProject, "ses_retry", { wake: false }), "retry");
    assert.equal(await manager.sessionStatus(runtimeProject, "ses_idle", { wake: false }), "idle");
    payload = { ses_busy: { type: "unsupported" } };
    await assert.rejects(
      () => manager.sessionStatus(runtimeProject, "ses_busy", { wake: false }),
      (error) => error?.code === "runtime_status_invalid",
    );
    manager.runtimes.delete(manager.key(runtimeProject));
    await assert.rejects(
      () => manager.sessionStatus(runtimeProject, "ses_busy", { wake: false }),
      (error) => error?.code === "runtime_not_running",
    );
  } finally {
    await manager.closeAll();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("RuntimeManager retries when an individual readiness probe stalls", { timeout: 3_000 }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-runtime-readiness-"));
  const socketPath = path.join(tmp, "opencode.sock");
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
      url: "http://opencode.runtime",
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
    runtimeMode: "opencode",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: docker,
    runtimeContainerImage: "open-science-opencode:test",
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
    assert.equal(runtime.kind, "opencode");
    assert.equal(runtime.url, "http://opencode.runtime");
    assert.match(runtime.socketPath, /[/\\]\.runtime-sockets[/\\][a-f0-9]{24}[/\\]opencode\.sock$/);
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
  const socketPath = path.join(dataDir, ".runtime-sockets", "810502d24441cfd45914a2ac", "opencode.sock");
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
    runtimeMode: "opencode",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: docker,
    runtimeContainerImage: "open-science-opencode:test",
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
        manager.startOpenCode({
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

test("buildOpenCodeLaunchPlan can disable read-only root for incompatible images", () => {
  const plan = buildOpenCodeLaunchPlan(
    {
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      runtimeContainerImage: "open-science-opencode:test",
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
    "pw-test",
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
        kind: "opencode",
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
      runtimeMode: "opencode",
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
        kind: "opencode",
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
      runtimeMode: "opencode",
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

test("syncRuntimeSkills deploys only manifest-backed skill directories", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-skills-"));
  const sourceRoot = path.join(tmp, "source");
  const projectRoot = path.join(tmp, "project");
  const runtimeDir = path.join(projectRoot, "runtime");
  const xdgConfigDir = path.join(runtimeDir, "container-runtime", "xdg-config");
  await mkdir(path.join(sourceRoot, "domain-check"), { recursive: true });
  await mkdir(path.join(sourceRoot, "placeholder"), { recursive: true });
  await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
  await writeFile(path.join(sourceRoot, "domain-check", "SKILL.md"), "# Domain Check\n");
  await writeFile(path.join(sourceRoot, "domain-check", "domain_check.py"), "print('ok')\n");

  const result = await syncRuntimeSkills(
    { runtimeSkillDirs: [sourceRoot] },
    {
      id: "paper1",
      userId: "alice",
      rootDir: projectRoot,
      runtimeDir,
    },
    { xdgConfigDir },
  );

  assert.deepEqual(result, { copied: 1, skipped: 1 });
  assert.equal(
    await readFile(path.join(xdgConfigDir, "opencode", "skills", "domain-check", "SKILL.md"), "utf8"),
    "# Domain Check\n",
  );
  await assert.rejects(
    () => readFile(path.join(xdgConfigDir, "opencode", "skills", "placeholder", "SKILL.md"), "utf8"),
    /ENOENT/,
  );
});

test("syncRuntimeSkills deploys only executable skills from a delivery inventory", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-skill-tier-"));
  const sourceRoot = path.join(tmp, "source");
  const projectRoot = path.join(tmp, "project");
  const runtimeDir = path.join(projectRoot, "runtime");
  const xdgConfigDir = path.join(runtimeDir, "container-runtime", "xdg-config");
  await mkdir(path.join(sourceRoot, "ready-skill"), { recursive: true });
  await mkdir(path.join(sourceRoot, "prompt-only"), { recursive: true });
  await mkdir(path.join(sourceRoot, "_runtime"), { recursive: true });
  await mkdir(path.join(xdgConfigDir, "opencode", "skills", "prompt-only"), { recursive: true });
  await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
  await writeFile(path.join(sourceRoot, "ready-skill", "SKILL.md"), "# Ready\n");
  await writeFile(path.join(sourceRoot, "prompt-only", "SKILL.md"), "# Prompt only\n");
  await writeFile(path.join(sourceRoot, "_runtime", "execute.py"), "print('ready')\n");
  await writeFile(
    path.join(xdgConfigDir, "opencode", "skills", "prompt-only", "SKILL.md"),
    "# Stale prompt-only install\n",
  );
  await writeFile(path.join(sourceRoot, "inventory.json"), JSON.stringify({
    policy: {
      delivery: {
        contractVersion: 1,
        defaultEnabledTier: "executable",
        supportDirs: ["_runtime"],
        executable: { "ready-skill": { entrypoints: ["run.py"] } },
        instructionOnly: ["prompt-only"],
      },
    },
  }));

  const result = await syncRuntimeSkills(
    { runtimeSkillDirs: [sourceRoot] },
    { id: "paper1", userId: "alice", rootDir: projectRoot, runtimeDir },
    { xdgConfigDir },
  );

  assert.deepEqual(result, { copied: 1, skipped: 2 });
  assert.equal(
    await readFile(path.join(xdgConfigDir, "opencode", "skills", "ready-skill", "SKILL.md"), "utf8"),
    "# Ready\n",
  );
  assert.equal(
    await readFile(path.join(xdgConfigDir, "opencode", "skills", "_runtime", "execute.py"), "utf8"),
    "print('ready')\n",
  );
  await assert.rejects(
    () => readFile(path.join(xdgConfigDir, "opencode", "skills", "prompt-only", "SKILL.md"), "utf8"),
    /ENOENT/,
  );
});

test("syncRuntimeSkills rejects symlinked deployed skill targets", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-skills-"));
  const sourceRoot = path.join(tmp, "source");
  const projectRoot = path.join(tmp, "project");
  const runtimeDir = path.join(projectRoot, "runtime");
  const xdgConfigDir = path.join(runtimeDir, "container-runtime", "xdg-config");
  const dstRoot = path.join(xdgConfigDir, "opencode", "skills");
  const outside = path.join(tmp, "outside");
  await mkdir(path.join(sourceRoot, "domain-check"), { recursive: true });
  await mkdir(dstRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(sourceRoot, "domain-check", "SKILL.md"), "# Domain Check\n");
  await symlink(outside, path.join(dstRoot, "domain-check"));

  await assert.rejects(
    () =>
      syncRuntimeSkills(
        { runtimeSkillDirs: [sourceRoot] },
        {
          id: "paper1",
          userId: "alice",
          rootDir: projectRoot,
          runtimeDir,
        },
        { xdgConfigDir },
      ),
    /symbolic links are not allowed/,
  );
});

test("syncRuntimeAgentPackages materializes deterministic skills and primary agents", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agents-"));
  try {
    const { registry } = await createRuntimeAgentFixture(tmp);
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
    const runtimeProject = { ...project, rootDir: projectRoot, runtimeDir };

    const first = await syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, registry);
    const agentPath = path.join(xdgConfigDir, "opencode", "agents", "evimed-test-analysis.md");
    const firstAgent = await readFile(agentPath, "utf8");
    const second = await syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, registry);
    const secondAgent = await readFile(agentPath, "utf8");

    assert.deepEqual(first, { skills: 1, agents: 1 });
    assert.deepEqual(second, first);
    assert.equal(secondAgent, firstAgent);
    assert.match(firstAgent, /^---\ndescription: /);
    assert.match(firstAgent, /\nmode: primary\n/);
    assert.match(firstAgent, /permission:\n  bash: allow\n  edit: allow\n  write: allow/);
    assert.match(firstAgent, /1\. `deep-research`/);
    assert.match(firstAgent, /2\. `citation-integrity`/);
    assert.match(firstAgent, /3\. `test-analysis`/);
    assert.match(firstAgent, /Do not claim completion if any required skill was not loaded successfully/);
    assert.match(firstAgent, /`evimed_term_normalize`/);
    assert.match(firstAgent, /`evimed_literature_search`/);
    assert.match(firstAgent, /`reports\/test-analysis\.md` \(required\)/);
    assert.match(firstAgent, /`artifacts\/test-analysis\.json` \(optional\)/);
    assert.doesNotMatch(firstAgent, /This sentence must not be copied/);
    assert.match(
      await readFile(path.join(xdgConfigDir, "opencode", "skills", "test-analysis", "SKILL.md"), "utf8"),
      /# Private skill instructions/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("syncRuntimeAgentPackages rejects symlinks added to a loaded source package", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-source-link-"));
  try {
    const { registry, packageDir } = await createRuntimeAgentFixture(tmp);
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
    await symlink(path.join(packageDir, "SKILL.md"), path.join(packageDir, "linked-skill.md"));

    await assert.rejects(
      () => syncRuntimeAgentPackages({ ...project, rootDir: projectRoot, runtimeDir }, { xdgConfigDir }, registry),
      (error) => error?.code === "runtime_skill_symlink",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("syncRuntimeAgentPackages rejects a symlinked generated-agent target", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-target-link-"));
  try {
    const { registry } = await createRuntimeAgentFixture(tmp);
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    const agentsDir = path.join(xdgConfigDir, "opencode", "agents");
    const outside = path.join(tmp, "outside.md");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(agentsDir, "evimed-test-analysis.md"));

    await assert.rejects(
      () => syncRuntimeAgentPackages({ ...project, rootDir: projectRoot, runtimeDir }, { xdgConfigDir }, registry),
      /symbolic links are not allowed/,
    );
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("syncRuntimeAgentPackages prunes only previously managed packages", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-prune-"));
  try {
    const { registry, packageRoot } = await createRuntimeAgentFixture(tmp);
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    const runtimeProject = { ...project, rootDir: projectRoot, runtimeDir };
    await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
    await syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, registry);

    const coreSkill = path.join(xdgConfigDir, "opencode", "skills", "core-research");
    const unmanagedAgent = path.join(xdgConfigDir, "opencode", "agents", "evimed-unmanaged.md");
    await mkdir(coreSkill, { recursive: true });
    await writeFile(path.join(coreSkill, "SKILL.md"), "# Core research\n");
    await writeFile(unmanagedAgent, "unmanaged\n");
    await rm(path.join(packageRoot, "test-analysis"), { recursive: true, force: true });
    const emptyRegistry = await loadAgentRegistry({ packageDirs: [packageRoot] });

    assert.deepEqual(
      await syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, emptyRegistry),
      { skills: 0, agents: 0 },
    );
    await assert.rejects(
      () => readFile(path.join(xdgConfigDir, "opencode", "skills", "test-analysis", "SKILL.md")),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      () => readFile(path.join(xdgConfigDir, "opencode", "agents", "evimed-test-analysis.md")),
      (error) => error?.code === "ENOENT",
    );
    assert.equal(await readFile(path.join(coreSkill, "SKILL.md"), "utf8"), "# Core research\n");
    assert.equal(await readFile(unmanagedAgent, "utf8"), "unmanaged\n");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("syncRuntimeAgentPackages rejects untrusted inventory without deleting unmanaged entries", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-inventory-"));
  try {
    const packageRoot = path.join(tmp, "agent-packages");
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    const opencodeDir = path.join(xdgConfigDir, "opencode");
    const coreSkill = path.join(opencodeDir, "skills", "core-research");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(coreSkill, { recursive: true });
    await writeFile(path.join(coreSkill, "SKILL.md"), "# Core research\n");
    await writeFile(
      path.join(opencodeDir, ".evimed-agent-packages.json"),
      JSON.stringify({ version: 1, packages: [{ skill: "../core-research", agent: "evimed-core-research" }] }),
    );
    const emptyRegistry = await loadAgentRegistry({ packageDirs: [packageRoot] });

    await assert.rejects(
      () => syncRuntimeAgentPackages(
        { ...project, rootDir: projectRoot, runtimeDir },
        { xdgConfigDir },
        emptyRegistry,
      ),
      (error) => error?.code === "runtime_agent_inventory_invalid",
    );
    assert.equal(await readFile(path.join(coreSkill, "SKILL.md"), "utf8"), "# Core research\n");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("syncRuntimeAgentPackages fails closed when a previously managed package is altered before pruning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-prune-altered-"));
  try {
    const { registry, packageRoot } = await createRuntimeAgentFixture(tmp);
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    const runtimeProject = { ...project, rootDir: projectRoot, runtimeDir };
    const inventoryPath = path.join(xdgConfigDir, "opencode", ".evimed-agent-packages.json");
    const skillPath = path.join(xdgConfigDir, "opencode", "skills", "test-analysis");
    const agentPath = path.join(xdgConfigDir, "opencode", "agents", "evimed-test-analysis.md");
    await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
    await syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, registry);
    const inventory = await readFile(inventoryPath, "utf8");
    const agent = await readFile(agentPath, "utf8");
    await writeFile(path.join(skillPath, ".evimed-package.json"), "{}\n");
    await writeFile(agentPath, agent.replace("<!-- evimed-managed-agent:", "<!-- altered-agent:"));
    await rm(path.join(packageRoot, "test-analysis"), { recursive: true, force: true });
    const emptyRegistry = await loadAgentRegistry({ packageDirs: [packageRoot] });

    await assert.rejects(
      () => syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, emptyRegistry),
      (error) => error?.code === "runtime_agent_prune_ownership_mismatch",
    );
    assert.equal(await readFile(inventoryPath, "utf8"), inventory);
    assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8").then((text) => text.includes("Private skill")), true);
    assert.equal(await readFile(agentPath, "utf8").then((text) => text.includes("altered-agent")), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("syncRuntimeAgentPackages rolls back a partial staged copy and preserves the live skill", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-rollback-"));
  try {
    const { registry, packageDir } = await createRuntimeAgentFixture(tmp);
    const projectRoot = path.join(tmp, "project");
    const runtimeDir = path.join(projectRoot, "runtime");
    const xdgConfigDir = path.join(runtimeDir, "xdg-config");
    const runtimeProject = { ...project, rootDir: projectRoot, runtimeDir };
    await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
    await syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, registry);
    const liveSkill = path.join(xdgConfigDir, "opencode", "skills", "test-analysis", "SKILL.md");
    const original = await readFile(liveSkill, "utf8");
    await writeFile(path.join(packageDir, "SKILL.md"), original.replace("Private skill", "Updated skill"));
    await symlink(path.join(packageDir, "agent.yaml"), path.join(packageDir, "zz-copy-failure.yaml"));

    await assert.rejects(
      () => syncRuntimeAgentPackages(runtimeProject, { xdgConfigDir }, registry),
      (error) => error?.code === "runtime_skill_symlink",
    );
    assert.equal(await readFile(liveSkill, "utf8"), original);
    const skillEntries = await readdir(path.join(xdgConfigDir, "opencode", "skills"));
    assert.equal(skillEntries.some((entry) => entry.includes(".staging.") || entry.includes(".backup.")), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager cleans stale containers before bootstrap and records bootstrap failures without spawning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-bootstrap-failure-"));
  const projectRoot = path.join(tmp, "project");
  const runtimeProject = {
    ...project,
    rootDir: projectRoot,
    baseDir: path.join(projectRoot, "workspace"),
    workspaceDir: path.join(projectRoot, "workspace"),
    runtimeDir: path.join(projectRoot, "runtime"),
    metaDir: path.join(projectRoot, ".openscience"),
  };
  const { registry, packageDir } = await createRuntimeAgentFixture(tmp);
  await symlink(path.join(packageDir, "SKILL.md"), path.join(packageDir, "zz-bootstrap-failure.md"));
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
    runtimeMode: "opencode",
    runtimeSandboxMode: "docker",
    runtimeContainerBin: docker,
    runtimeContainerImage: "open-science-opencode:test",
    runtimeTransport: "tcp",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    runtimeSkillDirs: [],
    allowRuntimeHostNetwork: false,
    runtimeProxyConnectTimeoutMs: 1_000,
    maxLogFileBytes: 1024 * 1024,
  }, { agentRegistry: registry });
  try {
    await assert.rejects(
      () => manager.startOpenCode(runtimeProject),
      (error) => error?.code === "runtime_bootstrap_failed",
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

test("cleanupHostRuntimeProcess fails when a fake host process cannot be confirmed exited", async () => {
  const signals = [];
  const result = await cleanupHostRuntimeProcess(
    { sandboxMode: "host", command: "/opt/opencode" },
    {
      kind: "opencode",
      sandboxMode: "host",
      running: true,
      pid: 4242,
    },
    {
      commandLine: () => "/opt/opencode serve --hostname 127.0.0.1",
      kill: (_pid, signal) => signals.push(signal),
      waitForExit: async () => false,
    },
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, {
    cleaned: false,
    failed: true,
    reason: "kill_unconfirmed",
    error: "Host runtime did not exit after SIGKILL.",
    pid: 4242,
  });
});

test("RuntimeManager records host cleanup failure and stops before bootstrap or spawn", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-host-cleanup-failure-"));
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
  await writeFile(
    path.join(runtimeProject.metaDir, "runtime-state.json"),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      userId: runtimeProject.userId,
      projectId: runtimeProject.id,
      event: "started",
      running: true,
      kind: "opencode",
      startedAt: new Date().toISOString(),
      pid: 4242,
      exitedAt: null,
      sandboxMode: "host",
      networkMode: null,
      containerName: null,
    }),
  );
  const spawnMarker = path.join(tmp, "spawned.txt");
  const previousSpawnMarker = process.env.RUNTIME_SPAWN_MARKER;
  process.env.RUNTIME_SPAWN_MARKER = spawnMarker;
  const manager = new RuntimeManager({
    runtimeMode: "opencode",
    runtimeSandboxMode: "host",
    opencodeBin: await fakeHostSpawnMarkerBin(tmp),
    allowUnsandboxedRuntime: true,
    runtimeSkillDirs: [],
    maxLogFileBytes: 1024 * 1024,
  });
  manager.cleanupHostRuntime = async () => ({
    cleaned: false,
    failed: true,
    reason: "kill_unconfirmed",
    error: "Host runtime did not exit after SIGKILL.",
    pid: 4242,
  });
  try {
    await assert.rejects(
      () => manager.startOpenCode(runtimeProject),
      (error) => error?.code === "runtime_cleanup_failed",
    );
    await assert.rejects(() => readFile(spawnMarker), (error) => error?.code === "ENOENT");
    const state = JSON.parse(await readFile(path.join(runtimeProject.metaDir, "runtime-state.json"), "utf8"));
    assert.equal(state.event, "failed");
    assert.equal(state.error, "runtime_cleanup_failed");
    const events = (await readFile(path.join(runtimeProject.metaDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "cleanup_failed" && event.reason === "kill_unconfirmed"));
  } finally {
    if (previousSpawnMarker == null) delete process.env.RUNTIME_SPAWN_MARKER;
    else process.env.RUNTIME_SPAWN_MARKER = previousSpawnMarker;
    await manager.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("RuntimeManager bootstraps specialty packages before spawning OpenCode", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-agent-order-"));
  const projectRoot = path.join(tmp, "project");
  const runtimeProject = {
    ...project,
    rootDir: projectRoot,
    baseDir: path.join(projectRoot, "workspace"),
    workspaceDir: path.join(projectRoot, "workspace"),
    runtimeDir: path.join(projectRoot, "runtime"),
    metaDir: path.join(projectRoot, ".openscience"),
  };
  const { registry } = await createRuntimeAgentFixture(tmp);
  const opencodeBin = await fakeHostRuntimeBootstrapBin(tmp);
  await Promise.all([
    mkdir(runtimeProject.workspaceDir, { recursive: true }),
    mkdir(runtimeProject.runtimeDir, { recursive: true }),
    mkdir(runtimeProject.metaDir, { recursive: true }),
  ]);
  const manager = new RuntimeManager({
    runtimeMode: "opencode",
    runtimeSandboxMode: "host",
    opencodeBin,
    allowUnsandboxedRuntime: true,
    runtimeSkillDirs: [],
    runtimeProxyConnectTimeoutMs: 2_000,
    runtimeQuotaCheckIntervalMs: 0,
    runtimeIdleTimeoutMs: 0,
    maxProjectBytes: 1024 * 1024,
    maxProjectUsageScanEntries: 100,
    maxLogFileBytes: 1024 * 1024,
  }, { agentRegistry: registry });
  try {
    const runtime = await manager.start(runtimeProject);
    assert.equal(runtime.agentSkillsCopied, 1);
    assert.equal(runtime.agentsGenerated, 1);
    assert.equal((await manager.status(runtimeProject)).agentsGenerated, 1);
  } finally {
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

test("buildOpenCodeLaunchPlan rejects host networking unless explicitly allowed", () => {
  assert.throws(
    () =>
      buildOpenCodeLaunchPlan(
        {
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "docker",
          runtimeContainerImage: "open-science-opencode:test",
          runtimeNetworkMode: "host",
          runtimeCpuLimit: "1",
          runtimeMemoryLimit: "1g",
          runtimePidsLimit: 64,
          allowRuntimeHostNetwork: false,
        },
        project,
        49152,
        "pw-test",
      ),
    /Host or shared-container networking is disabled/,
  );
});

test("buildOpenCodeLaunchPlan rejects production network egress unless explicitly allowed", () => {
  assert.throws(
    () =>
      buildOpenCodeLaunchPlan(
        {
          production: true,
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "docker",
          runtimeContainerImage: "open-science-opencode:test",
          runtimeNetworkMode: "bridge",
          runtimeCpuLimit: "1",
          runtimeMemoryLimit: "1g",
          runtimePidsLimit: 64,
          allowRuntimeHostNetwork: false,
          allowRuntimeNetworkEgress: false,
        },
        project,
        49152,
        "pw-test",
      ),
    /OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true/,
  );
});

test("buildOpenCodeLaunchPlan rejects production network egress without policy acknowledgement", () => {
  assert.throws(
    () =>
      buildOpenCodeLaunchPlan(
        {
          production: true,
          runtimeSandboxMode: "docker",
          runtimeContainerBin: "docker",
          runtimeContainerImage: "open-science-opencode:test",
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
        "pw-test",
      ),
    /OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true/,
  );
});

test("buildOpenCodeLaunchPlan allows production network egress with opt-in and policy acknowledgement", () => {
  const plan = buildOpenCodeLaunchPlan(
    {
      production: true,
      runtimeSandboxMode: "docker",
      runtimeContainerBin: "docker",
      ...runtimeReleaseConfig,
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
    "pw-test",
  );

  assert.ok(plan.args.includes("--network"));
  assert.ok(plan.args.includes("bridge"));
});

test("buildOpenCodeLaunchPlan requires matching release provenance in production", () => {
  const base = {
    production: true,
    runtimeSandboxMode: "docker",
    runtimeContainerBin: "docker",
    runtimeContainerImage: "open-science-opencode:test",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
    runtimePidsLimit: 64,
    allowRuntimeHostNetwork: false,
  };
  assert.throws(
    () => buildOpenCodeLaunchPlan(base, project, 49152, "pw-test"),
    (err) => err?.code === "release_manifest_missing",
  );
  assert.throws(
    () =>
      buildOpenCodeLaunchPlan(
        { ...base, ...runtimeReleaseConfig, runtimeContainerImage: "open-science-opencode:mismatch" },
        project,
        49152,
        "pw-test",
      ),
    (err) => err?.code === "release_manifest_mismatch",
  );
});

test("buildOpenCodeLaunchPlan rejects unsandboxed host runtime without opt-in", () => {
  assert.throws(
    () =>
      buildOpenCodeLaunchPlan(
        {
          runtimeSandboxMode: "host",
          opencodeBin: "/usr/local/bin/opencode",
          allowUnsandboxedRuntime: false,
        },
        project,
        49152,
        "pw-test",
      ),
    /requires OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker/,
  );
});

test("buildOpenCodeLaunchPlan uses the host workspace path for opted-in host runtime proxying", () => {
  const plan = buildOpenCodeLaunchPlan(
    {
      runtimeSandboxMode: "host",
      opencodeBin: "/usr/local/bin/opencode",
      allowUnsandboxedRuntime: true,
    },
    project,
    49152,
    "pw-test",
  );

  assert.equal(plan.sandboxMode, "host");
  assert.equal(plan.command, "/usr/local/bin/opencode");
  assert.equal(plan.cwd, project.workspaceDir);
  assert.equal(plan.proxyWorkspaceDir, project.workspaceDir);
  assert.ok(plan.runtimeDirs.includes(path.join(project.runtimeDir, "xdg-config")));
});

test("RuntimeManager serializes concurrent starts for the same project", async () => {
  const manager = new RuntimeManager({
    runtimeMode: "opencode",
    runtimeSandboxMode: "host",
    opencodeBin: "/bin/echo",
    allowUnsandboxedRuntime: true,
  });
  let starts = 0;
  const fake = {
    kind: "opencode",
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
  manager.startOpenCode = async () => {
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
    runtimeMode: "opencode",
    runtimeSandboxMode: "host",
    opencodeBin: "/bin/echo",
    allowUnsandboxedRuntime: true,
  });
  let releaseStart;
  let closed = false;
  manager.startOpenCode = async () => {
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
    runtimeMode: "opencode",
    runtimeSandboxMode: "host",
    opencodeBin: "/bin/echo",
    allowUnsandboxedRuntime: true,
    maxRunningRuntimes: 1,
    maxRunningRuntimesPerUser: 10,
  });
  let releaseFirst;
  const projectB = { ...project, id: "paper2" };
  manager.startOpenCode = async (currentProject) => {
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
    runtimeMode: "opencode",
    runtimeSandboxMode: "host",
    opencodeBin: "/bin/echo",
    allowUnsandboxedRuntime: true,
    maxRunningRuntimes: 10,
    maxRunningRuntimesPerUser: 1,
  });
  manager.startOpenCode = async (currentProject) => fakeRuntime(`${currentProject.userId}-${currentProject.id}`);
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
