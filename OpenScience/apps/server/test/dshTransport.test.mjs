import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { buildRuntimeLaunchPlan, DockerRuntimeProvider } from "../src/runtimeManager.mjs";

const bindProject = (dataDir, userId, id) => {
  const rootDir = path.join(dataDir, "users", userId, "projects", id);
  return { userId, id, dataDir, rootDir, workspaceDir: path.join(rootDir, "workspace"), runtimeDir: path.join(rootDir, "runtime") };
};

test("long bind socket paths use only each tenant project's isolated control mount", () => {
  const dataDir = "/data/evimed-science/app-data";
  const config = loadConfig({ dataDir, runtimeSandboxMode: "docker", production: false });
  assert.equal(Boolean(config.runtimeDataVolume), false);
  const sockets = new Set();
  for (const userId of ["u".repeat(64), "v".repeat(64)]) {
    for (const id of ["p".repeat(64), "q".repeat(64)]) {
      const project = bindProject(dataDir, userId, id);
      const plan = buildRuntimeLaunchPlan(config, project, 4096);
      const hash = createHash("sha256").update(`${userId}\0${id}`, "utf8").digest("hex").slice(0, 24);
      const controlDir = path.join(dataDir, ".runtime-sockets", hash);
      assert.equal(plan.socketPath, path.join(controlDir, "dsh.sock"));
      assert.ok(Buffer.byteLength(plan.socketPath, "utf8") + 1 <= 108);
      assert.equal(plan.socketTrustRoot, dataDir);
      const mounts = plan.args.filter((_, i) => plan.args[i - 1] === "--mount");
      assert.ok(mounts.includes(`type=bind,src=${controlDir},dst=/runtime-control`));
      assert.ok(mounts.includes(`type=bind,src=${path.join(project.runtimeDir, "container-runtime")},dst=/runtime`));
      assert.ok(mounts.includes(`type=bind,src=${project.workspaceDir},dst=/workspace`));
      assert.equal(mounts.some(mount => mount.startsWith(`type=bind,src=${dataDir},`)), false);
      assert.ok(plan.args.includes("OPEN_SCIENCE_RUNTIME_SOCKET=/runtime-control/dsh.sock"));
      assert.ok(plan.runtimeDirs.includes(controlDir));
      sockets.add(plan.socketPath);
    }
  }
  assert.equal(sockets.size, 4);
});

test("short bind socket paths retain the existing project mount and socket location", () => {
  const dataDir = "/data";
  const config = loadConfig({ dataDir, runtimeSandboxMode: "docker", production: false });
  const project = bindProject(dataDir, "u", "p");
  const plan = buildRuntimeLaunchPlan(config, project, 4096);
  assert.equal(plan.socketPath, path.join(project.runtimeDir, "container-runtime", "control", "dsh.sock"));
  assert.equal(plan.socketTrustRoot, project.rootDir);
  assert.ok(plan.args.includes("OPEN_SCIENCE_RUNTIME_SOCKET=/runtime/control/dsh.sock"));
  assert.equal(plan.args.some(arg => arg.includes("dst=/runtime-control")), false);
});

test("long bind control directories remain private and reject symlinked sockets", async () => {
  const fs = await import("node:fs/promises");
  const { createServer, createConnection } = await import("node:net");
  const root = await fs.mkdtemp("/tmp/dsh-bind-");
  const config = loadConfig({ dataDir: root, runtimeSandboxMode: "docker", production: false });
  const project = bindProject(root, "u".repeat(64), "p".repeat(64));
  const input = { port: 4096, pluginConfig: { revision: 0, enabled: true, settings: { timeoutMs: 15000 } }, capsuleMethodsMounted: 0 };
  const provider = new DockerRuntimeProvider({
    config, ensureKnowledgeBaseDir: async () => {}, cleanupDocker: async () => ({ missing: true }),
  });
  const server = createServer(socket => socket.end());
  try {
    const plan = await provider.prepare(project, input);
    assert.equal((await fs.stat(path.dirname(plan.socketPath))).mode & 0o777, 0o700);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(plan.socketPath, resolve);
    });
    await new Promise((resolve, reject) => {
      const socket = createConnection(plan.socketPath);
      socket.once("error", reject);
      socket.once("connect", () => { socket.destroy(); resolve(); });
    });
    await new Promise(resolve => server.close(resolve));
    const target = path.join(root, "outside.sock");
    await fs.writeFile(target, "preserved");
    await fs.symlink(target, plan.socketPath);
    await assert.rejects(() => provider.prepare(project, input),
      error => error.code === "runtime_socket_symlink");
    assert.equal(await fs.readFile(target, "utf8"), "preserved");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** The DSH kernel's container entrypoint is the socat bridge script: it seeds
 *  the profile, turns telemetry off and injects the deployment's settings, and
 *  it only runs on the unix transport. The TCP branch launched `dsh` directly
 *  with none of that, and the container died during boot with "profile does not
 *  exist" — a failure nobody could see, because the launch argv is not recorded
 *  anywhere. So the combination is refused where it is chosen, not where it
 *  fails. */
test("the DSH kernel refuses a TCP transport rather than launching a container that cannot work", () => {
  assert.throws(
    () => loadConfig({ runtimeTransport: "tcp" }),
    /OPEN_SCIENCE_RUNTIME_TRANSPORT must be "unix"/,
  );
});

/** The transport default used to be read off a second variable: the kernel
 *  selector. One kernel took TCP, the other unix, so "what transport am I on"
 *  could not be answered from the transport setting alone. There is one kernel
 *  now, so the default is unconditional — and that is what this pins, on both
 *  sides of the production switch, together with the setting it feeds. */
test("the runtime transport defaults to unix, and nothing else moves that default", () => {
  for (const production of [false, true]) {
    const config = loadConfig({ production });
    assert.equal(config.runtimeTransport, "unix", `transport default with production=${production}`);
    // The transport is what chooses the container's network mode. The retired
    // TCP default is what used to make this "bridge" — a published port needs
    // a network to publish on — and a unix runtime needs no network at all.
    assert.equal(config.runtimeNetworkMode, "none", `network mode with production=${production}`);
  }
});

test("a control socket path the kernel cannot connect to is refused at plan time", async () => {
  // `sun_path` is 108 bytes. Past that the container still binds its own short
  // path inside the mount and reports itself healthy, while every connect from
  // the control plane fails — which surfaced as "Runtime exited before it
  // became ready" and, once that message carried the container's output, as a
  // container whose log said `dsh web: http://127.0.0.1:<port>` while nothing
  // could reach it.
  const { buildRuntimeLaunchPlan } = await import("../src/runtimeManager.mjs");
  const deep = `/srv/${"d".repeat(40)}/${"e".repeat(40)}`;
  const config = loadConfig({
    runtimeSandboxMode: "docker",
    runtimeTransport: "unix",
    dataDir: deep,
    production: false,
  });
  const root = `${deep}/users/u/projects/p`;
  const project = {
    userId: "u",
    id: "p",
    rootDir: root,
    workspaceDir: `${root}/workspace`,
    runtimeDir: `${root}/runtime`,
    dataDir: deep,
  };
  assert.throws(
    () => buildRuntimeLaunchPlan(config, project, 4096, "pw_0123456789abcdef0123"),
    /runtime_socket_path_too_long|108/,
  );
});

test("the DSH profile sync hands the gateway token back, not only to the credentials file", async () => {
  // The gateway authenticates on an *active* jti and only the caller can
  // register one. Returning the token solely by writing `.credentials.yaml`
  // left `activateModelGatewayRuntime` with nothing to register, so the
  // runtime's very first model call came back 401 while the file on disk held
  // a valid token — a failure that looks like a credential problem and is a
  // bookkeeping one.
  const { syncRuntimeDshProfile } = await import("../src/runtimeManager.mjs");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sync-"));
  const config = loadConfig({
    runtimeSandboxMode: "docker",
    runtimeTransport: "unix",
    dataDir: root,
    production: false,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-not-a-real-key",
    deepseekModel: "deepseek-v4-pro",
    modelGatewaySigningSecret: "a".repeat(64),
    evimedWorkloadSigningSecret: "b".repeat(64),
  });
  const project = { userId: "u", id: "p", rootDir: root, workspaceDir: path.join(root, "workspace") };
  await fs.mkdir(project.workspaceDir, { recursive: true });
  const plan = {
    sandboxMode: "docker",
    dshHomeDir: path.join(root, "dsh-home"),
    proxyWorkspaceDir: "/workspace",
  };

  const result = await syncRuntimeDshProfile(config, project, plan);
  assert.equal(result.configured, true);
  assert.ok(result.token, "the caller cannot register a token it was not given");
  assert.ok(result.payload?.jti, "the jti is what the gateway matches on");
  await fs.rm(root, { recursive: true, force: true });
});

test("the runtime's dying words keep the end, and survive the trip through the controller", async () => {
  // Two defects in one fix, both found by auditing it rather than by running
  // it. A head-keeping buffer throws away the cause of a container that boots
  // and *then* dies, and the controller used to collapse the capture to a
  // single 512-character line before sending it — which left the reader's
  // line-based filters unable to fire, and able to delete the whole thing when
  // that one line happened to match.
  const { appendTailOutput, appendCappedOutput } = await import("../src/runtimeManager.mjs");

  let tail = "";
  for (const line of ["boot noise\n".repeat(600), "Error: the actual cause\n"]) {
    tail = appendTailOutput(tail, line, 4096);
  }
  assert.ok(tail.includes("Error: the actual cause"), "the end is what explains the exit");
  assert.ok(Buffer.byteLength(tail, "utf8") <= 4096);

  // The head-keeping helper still exists and still keeps the head: it is right
  // for short-lived processes, and this is why the two are separate.
  let head = "";
  for (const line of ["boot noise\n".repeat(600), "Error: the actual cause\n"]) {
    head = appendCappedOutput(head, line, 4096);
  }
  assert.ok(!head.includes("Error: the actual cause"));
});
