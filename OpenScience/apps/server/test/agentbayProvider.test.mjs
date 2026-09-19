import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentBayRuntimeProvider } from "../src/agentbay/runtimeProvider.mjs";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager, requestRuntime } from "../src/runtimeManager.mjs";
import { fakeAgentBay, fakeOss, linkProxy } from "./helpers/agentbayFakes.mjs";

// The AgentBay provider end to end against a fake AgentBay (plan §3.1): the
// SDK client is the only thing replaced. The session bridge, the link tunnel,
// the launcher's manifest, the sync and the manager around them are the
// shipped code, and the kernel in each fake session authenticates the way DSH
// does, with the secret the control plane wrote into the session.

const launcher = fileURLToPath(new URL("../../../deploy/runtime-dsh/evimed-session.sh", import.meta.url));

/** @param {string} dataDir @param {Record<string, any>} [overrides] */
function configFor(dataDir, overrides = {}) {
  return {
    dataDir,
    production: false,
    runtimeMode: "kernel",
    runtimeProvider: "agentbay",
    runtimeTransport: "wss",
    // Named on purpose: an AgentBay deployment builds no Docker controller
    // whatever this says.
    runtimeControllerMode: "socket",
    releaseId: "rel-1",
    deepseekProviderEnabled: true,
    deepseekModel: "deepseek-v4-pro",
    modelGatewaySigningSecret: "m".repeat(48),
    evimedWorkloadSigningSecret: "w".repeat(48),
    publicSourceGatewayInternalUrl: "http://open-science-web:8787/internal/sources/v1/fetch",
    agentbayImageId: "imgc-test",
    agentbayBridgePort: 30100,
    agentbayBridgeSecretMode: "header",
    agentbaySandboxEnforcement: "full",
    agentbayFirewallRequired: true,
    agentbayHeartbeatMs: 3_600_000,
    agentbayWorkloadTokenTtlSeconds: 900,
    agentbayWorkloadTokenRefreshSeconds: 300,
    agentbaySyncIntervalMs: 0,
    agentbaySyncMaxFileBytes: 1024 * 1024,
    agentbayContextPrefix: "evimed",
    agentbayIdleReleaseMinutes: 30,
    agentbayMaxRuntimeMinutes: 240,
    runtimeGatewayPublicUrl: "https://evimed.example/runtime-gateway",
    runtimeProxyConnectTimeoutMs: 3_000,
    runtimeReadyTimeoutMs: 5_000,
    runtimeQuotaCheckIntervalMs: 0,
    runtimeIdleTimeoutMs: 0,
    maxLogFileBytes: 1024 * 1024,
    ...overrides,
  };
}

/** @param {string} dataDir @param {string} userId @param {string} id */
async function projectIn(dataDir, userId, id) {
  const rootDir = path.join(dataDir, "users", userId, "projects", id);
  const baseDir = path.join(rootDir, "workspace");
  const project = {
    id, userId, tenantId: userId, rootDir, baseDir, workspaceDir: baseDir,
    runtimeDir: path.join(rootDir, "runtime"), metaDir: path.join(rootDir, ".openscience"),
  };
  await Promise.all([baseDir, project.runtimeDir, project.metaDir].map((dir) => mkdir(dir, { recursive: true })));
  return project;
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{ config?: Record<string, any>, report?: any }} [options]
 */
async function fixture(t, { config: overrides = {}, report = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-ab-"));
  const dataDir = path.join(root, "data");
  const oss = await fakeOss();
  const fake = fakeAgentBay({ root: path.join(root, "sessions"), oss, report });
  const project = await projectIn(dataDir, "alice", "paper1");
  const config = configFor(dataDir, overrides);
  /** @type {RuntimeManager[]} */
  const managers = [];
  const managerFor = () => {
    const manager = new RuntimeManager(config, { agentbayClient: fake.client });
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    for (const manager of managers) {
      await manager.closeAll().catch(() => {});
      await manager.provider.settled?.();
    }
    await fake.closeAll();
    await oss.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, oss, fake, project, config, managerFor };
}

/** A control plane that died without a word: no release, no record removed. */
async function crash(manager) {
  for (const key of [...manager.evimedWorkloadRefreshTimers.keys()]) manager.clearEviMedWorkloadRefresh(key);
  for (const live of manager.provider.live.values()) {
    clearInterval(live.mirrorTimer);
    clearInterval(live.child.timer);
    await live.tunnel.close();
  }
  manager.provider.live.clear();
  manager.runtimes.clear();
}

/** One unary call through the runtime's transport, as the ledger makes it. */
async function sessionList(runtime) {
  const response = await requestRuntime(runtime, `${runtime.url}/api/session/list`, {
    method: "POST",
    headers: { cookie: runtime.cookie, "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ type: "client-request", rpcId: "rpc_1", method: "session/list", payload: { args: { _request: {} } } })),
  });
  await response.body?.cancel().catch(() => {});
  return response.status;
}

/** @param {Record<string, any>} project */
async function runtimeEvents(project) {
  const text = await readFile(path.join(project.metaDir, "runtime.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** @param {() => boolean | Promise<boolean>} predicate */
async function eventually(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition not reached in time");
}

const SECRET_FILES = [".credentials.yaml", "model-gateway.token", "evimed-workload.token", "control-plane-patch.yml", "bridge.secret", "kernel.env"];

test("a project's session: its labels, lifecycle and Contexts, credentials only through the file API, the kernel reached through its link", async (t) => {
  const { dataDir, oss, fake, project, managerFor } = await fixture(t);
  await writeFile(path.join(project.workspaceDir, "notes.md"), "hello");
  await mkdir(path.join(project.baseDir, "knowledge-base"), { recursive: true });
  await writeFile(path.join(project.baseDir, "knowledge-base", "kb.txt"), "a source");
  const library = path.join(dataDir, "users", "alice", "library");
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, "book.txt"), "a chapter");
  const outside = path.join(dataDir, "host-only.txt");
  await writeFile(outside, "a file of this host");
  await symlink(outside, path.join(project.workspaceDir, "leak.txt"));

  const manager = managerFor();
  assert.equal(manager.runtimeController, null, "an AgentBay deployment has no container on this host to control");
  const runtime = await manager.start(project);

  assert.equal(fake.calls.create.length, 1);
  const [created] = fake.calls.create;
  assert.equal(created.imageId, "imgc-test");
  assert.deepEqual(created.labels, { evimed: "runtime", user: "alice", project: "paper1", release: "rel-1" });
  assert.deepEqual(created.lifecycle, { idleMinutes: 30, maxRuntimeMinutes: 240 });
  assert.equal(created.policyId, undefined);
  const attached = Object.fromEntries(created.contextSync.map((entry) => [entry.path, entry]));
  assert.deepEqual(Object.keys(attached).sort(), [
    "/runtime/dsh-home/sessions", "/runtime/dsh-home/storages", "/workspace", "/workspace/knowledge-base", "/workspace/library",
  ]);
  for (const mount of ["/workspace", "/runtime/dsh-home/sessions", "/runtime/dsh-home/storages"]) {
    assert.equal(attached[mount].policy.uploadPolicy.autoUpload, true, mount);
  }
  for (const mount of ["/workspace/knowledge-base", "/workspace/library"]) {
    assert.equal(attached[mount].policy.uploadPolicy.autoUpload, false, `${mount} is download-only`);
  }
  assert.deepEqual(attached["/workspace"].policy.bwList.whiteLists[0].excludePaths, ["/knowledge-base", "/library"]);

  // What the session received, and what it did not.
  assert.equal(await readFile(fake.sessionFile("s-1", "/workspace/notes.md"), "utf8"), "hello");
  assert.equal(await readFile(fake.sessionFile("s-1", "/workspace/knowledge-base/kb.txt"), "utf8"), "a source");
  assert.equal(await readFile(fake.sessionFile("s-1", "/workspace/library/book.txt"), "utf8"), "a chapter");
  await assert.rejects(lstat(fake.sessionFile("s-1", "/workspace/leak.txt")), { code: "ENOENT" }, "a link on the host is never followed into a Context");

  const credentials = await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/.credentials.yaml"), "utf8");
  const browserSecret = /secret: '([^']+)'/.exec(credentials)?.[1] ?? "";
  const bridgeSecret = (await readFile(fake.sessionFile("s-1", "/run/evimed/bridge.secret"), "utf8")).trim();
  const modelToken = (await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/model-gateway.token"), "utf8")).trim();
  const workloadToken = (await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/evimed-workload.token"), "utf8")).trim();
  const secrets = [browserSecret, bridgeSecret, modelToken, workloadToken];
  assert.ok(secrets.every((secret) => secret.length >= 32));
  assert.ok(oss.everything().length >= 3, "the Contexts were written");
  for (const object of oss.everything()) {
    assert.ok(!SECRET_FILES.includes(path.posix.basename(object.file)), `${object.file} reached a Context`);
    for (const secret of secrets) assert.ok(!object.text.includes(secret), `a secret reached ${object.id}${object.file}`);
  }
  const written = new Set(fake.calls.writes.filter((write) => write.file.startsWith("/run/evimed/incoming/")).map((write) => path.posix.basename(write.file)));
  for (const name of SECRET_FILES) assert.ok(written.has(name), `${name} arrives through the file API`);

  const start = fake.calls.commands.find((call) => call.line === "/usr/local/bin/evimed-session start");
  assert.deepEqual(start?.envs, {
    OPEN_SCIENCE_RUNTIME_PORT: "4096",
    OPEN_SCIENCE_SESSION_BRIDGE_PORT: "30100",
    EVIMED_REQUIRED_ENFORCEMENT: "full",
    EVIMED_GATEWAY_HOST: "evimed.example",
    EVIMED_FIREWALL_REQUIRED: "1",
  }, "nothing secret travels on a command");
  assert.ok(fake.calls.commands.every((call) => call.timeoutMs <= 50_000), "no command asks for more than the API's 50 s");
  assert.deepEqual([...new Set(fake.sessions.get("s-1").linkPorts)], [30100]);

  const patch = await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/control-plane-patch.yml"), "utf8");
  assert.match(patch, /baseURL: 'https:\/\/evimed\.example\/runtime-gateway\/model\/v1'/);
  assert.match(patch, /https:\/\/evimed\.example\/runtime-gateway\/sources\/v1\/fetch/);
  assert.doesNotMatch(patch, /open-science-web/, "a session is never handed a name only this host resolves");
  assert.match(patch, /requiredEnforcement: 'full'/);
  const kernelEnv = await readFile(fake.sessionFile("s-1", "/run/evimed/kernel.env"), "utf8");
  assert.match(kernelEnv, /^OPEN_SCIENCE_RUNTIME_AUTHORITY='dsh\.runtime'$/m);
  assert.match(kernelEnv, /^EVIMED_PUBLIC_SOURCE_GATEWAY_URL='https:\/\/evimed\.example\/runtime-gateway\/sources\/v1\/fetch'$/m);
  for (const secret of secrets) assert.ok(!kernelEnv.includes(secret), "the kernel's environment carries no secret");

  assert.equal(runtime.url, "http://dsh.runtime");
  assert.equal(runtime.sandboxMode, "agentbay");
  assert.equal(runtime.containerName, "s-1");
  assert.deepEqual(runtime.sandbox, { kernelRelease: "6.12.0-agentbay", landlockAbi: 6, landlock: "full", firewall: "applied" });
  assert.equal(await sessionList(runtime), 200);
  const kernelCalls = fake.sessions.get("s-1").kernel.calls;
  assert.ok(kernelCalls.length >= 2 && kernelCalls.every((call) => call.host === "dsh.runtime"), "the kernel sees the Host it has always seen");

  const state = JSON.parse(await readFile(path.join(project.metaDir, "runtime-state.json"), "utf8"));
  assert.equal(state.running, true);
  assert.equal(state.sandboxMode, "agentbay");
  assert.deepEqual(state.sandbox, runtime.sandbox, "the guest's kernel and Landlock level are on the record");
  const record = JSON.parse(await readFile(path.join(project.runtimeDir, "agentbay", "session.json"), "utf8"));
  assert.equal(record.sessionId, "s-1");
  assert.equal(record.release, "rel-1");
  assert.equal(record.imageId, "imgc-test");
  assert.equal(record.bridgeSecret, bridgeSecret);
  assert.equal(record.modelGateway.jti, manager.assertActiveModelGatewayToken(modelToken).jti, "the kernel's model token is the active one");

  const claims = await manager.assertActiveEviMedWorkloadToken(workloadToken);
  assert.equal(claims.exp - claims.iat, 900, "a remote runtime's workload token lives 900 s");
  assert.equal(runtime.workloadTokenRefreshMs, 300_000, "and is renewed every 300 s");
  assert.equal((await manager.status(project)).provider, "agentbay");
});

test("a stop brings the run's work home, releases the session with its Context upload, and records what the Context holds", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  await writeFile(path.join(project.workspaceDir, "notes.md"), "hello");
  const manager = managerFor();
  const runtime = await manager.start(project);
  await fake.writeInSession("s-1", "/workspace/report.md", "the result");
  await fake.writeInSession("s-1", "/runtime/dsh-home/sessions/ses_1.jsonl", "{}\n");
  await fake.removeInSession("s-1", "/workspace/notes.md");
  // Written on the host while the run worked (an upload): the session never
  // had it, so its release cannot have uploaded it.
  await writeFile(path.join(project.workspaceDir, "upload.csv"), "a,b\n");

  await manager.stop(project);

  assert.equal(await readFile(path.join(project.workspaceDir, "report.md"), "utf8"), "the result");
  await assert.rejects(lstat(path.join(project.workspaceDir, "notes.md")), { code: "ENOENT" }, "what the run deleted is deleted at home");
  assert.equal(await readFile(path.join(project.workspaceDir, "upload.csv"), "utf8"), "a,b\n", "a host-only file is never touched");
  assert.equal(await readFile(path.join(project.runtimeDir, "container-runtime", "dsh-home", "sessions", "ses_1.jsonl"), "utf8"), "{}\n");
  assert.deepEqual(fake.calls.delete, [{ sessionId: "s-1", syncContext: true }]);
  await assert.rejects(lstat(path.join(project.runtimeDir, "agentbay", "session.json")), { code: "ENOENT" });
  await assert.rejects(lstat(runtime.socketPath), { code: "ENOENT" }, "the tunnel went with the session");
  const manifest = JSON.parse(await readFile(path.join(project.runtimeDir, "agentbay", "manifest-workspace.json"), "utf8"));
  assert.equal(manifest.clean, true);
  assert.ok(manifest.files["report.md"]);
  assert.ok(manifest.files["notes.md"], "the Context may still hold what the run deleted, so the next push deletes it");
  assert.ok(!manifest.files["upload.csv"], "the Context is not recorded as holding the upload");

  // The next session gets both: the run's result, and the upload.
  await manager.start(project);
  assert.equal(fake.calls.create.length, 2);
  assert.equal(await readFile(fake.sessionFile("s-2", "/workspace/report.md"), "utf8"), "the result");
  assert.equal(await readFile(fake.sessionFile("s-2", "/workspace/upload.csv"), "utf8"), "a,b\n");
  await assert.rejects(lstat(fake.sessionFile("s-2", "/workspace/notes.md")), { code: "ENOENT" });
});

test("the delivery gate reads the session's files, and the control plane's run files reach the session", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const manager = managerFor();
  await manager.start(project);
  await fake.writeInSession("s-1", "/workspace/deliverables/report.md", "# Report\n");
  assert.equal(await manager.workspaceRootForDelivery(project), "/workspace", "the root the kernel names its files by");
  assert.equal(await readFile(path.join(project.workspaceDir, "deliverables", "report.md"), "utf8"), "# Report\n",
    "the host copy the gate reads is brought up to date first");

  await manager.writeRunContextFile(project, "the research context", { sessionId: "ses_abc", required: true });
  assert.equal(await readFile(fake.sessionFile("s-1", "/workspace/.evimed-brief/sessions/ses_abc/context.md"), "utf8"), "the research context");
  assert.equal(await readFile(path.join(project.workspaceDir, ".evimed-brief", "sessions", "ses_abc", "context.md"), "utf8"), "the research context");
});

test("a control plane that restarted takes its session back: the same session, the same kernel, the same credentials", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const before = managerFor();
  await before.start(project);
  const modelToken = (await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/model-gateway.token"), "utf8")).trim();
  const credentials = async () => /secret: '([^']+)'/.exec(await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/.credentials.yaml"), "utf8"))?.[1];
  const browserSecret = await credentials();
  await crash(before);

  const after = managerFor();
  const summary = await after.cleanupOrphanedRuntimes([project]);
  assert.equal(summary.reattached, 1);
  assert.equal(summary.failed, 0);
  assert.equal(fake.calls.create.length, 1, "no second session");
  assert.equal(fake.sessions.get("s-1").starts, 1, "the kernel that was running is the one still running");
  assert.ok(fake.sessions.get("s-1").installs >= 1, "its files were renewed in place");
  const runtime = after.runtimes.get(after.key(project));
  assert.equal(runtime.containerName, "s-1");
  assert.equal(await credentials(), browserSecret, "the kernel's browser-session secret was kept");
  assert.equal((await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/model-gateway.token"), "utf8")).trim(), modelToken,
    "the kernel's model token is rendered again byte for byte");
  assert.equal(after.assertActiveModelGatewayToken(modelToken).userId, "alice", "and is active in the new control plane");
  assert.equal(await sessionList(runtime), 200);
});

test("a session released while its control plane was away is brought home from its Context", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  await writeFile(path.join(project.workspaceDir, "kept.md"), "kept");
  const before = managerFor();
  await before.start(project);
  await fake.writeInSession("s-1", "/workspace/late.md", "written after the last mirror");
  await fake.removeInSession("s-1", "/workspace/kept.md");
  await crash(before);
  await fake.releaseOnItsOwn("s-1");

  const after = managerFor();
  const summary = await after.cleanupOrphanedRuntimes([project]);
  assert.equal(summary.missing, 1);
  assert.equal(await readFile(path.join(project.workspaceDir, "late.md"), "utf8"), "written after the last mirror");
  assert.equal(await readFile(path.join(project.workspaceDir, "kept.md"), "utf8"), "kept", "recovery never deletes from the copy of record");
  await assert.rejects(lstat(path.join(project.runtimeDir, "agentbay", "session.json")), { code: "ENOENT" });
  assert.equal(fake.calls.create.length, 1);

  // The next session is consistent with the host: the file the lost session
  // deleted comes back rather than silently differing.
  await after.start(project);
  assert.equal(await readFile(fake.sessionFile("s-2", "/workspace/kept.md"), "utf8"), "kept");
  assert.equal(await readFile(fake.sessionFile("s-2", "/workspace/late.md"), "utf8"), "written after the last mirror");
});

test("a session labelled as the project's that no record names is released before another starts", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const stray = await fake.client.createSession({ labels: { evimed: "runtime", user: "alice", project: "paper1", release: "rel-0" } });
  const other = await fake.client.createSession({ labels: { evimed: "runtime", user: "bob", project: "paper1", release: "rel-1" } });
  const manager = managerFor();
  await manager.start(project);
  assert.deepEqual(fake.calls.delete, [{ sessionId: stray.sessionId, syncContext: true }], "another account's session is never touched");
  assert.ok(await fake.client.getSession(other.sessionId));
  assert.ok((await runtimeEvents(project)).some((event) => event.event === "agentbay_strays_released" && event.sessions === 1));
});

test("a guest kernel without Landlock is refused by name, and its session let go", async (t) => {
  const { fake, project, managerFor } = await fixture(t, {
    report: () => ({ ok: false, code: "agentbay_landlock_unavailable", kernelRelease: "5.10.134-agentbay", landlockAbi: 0, landlock: "none" }),
  });
  const manager = managerFor();
  await assert.rejects(manager.start(project), (error) => {
    assert.equal(error.code, "agentbay_landlock_unavailable");
    assert.equal(error.status, 503);
    assert.match(error.message, /kernel 5\.10\.134-agentbay; Landlock none \(ABI 0\)/);
    return true;
  });
  assert.deepEqual(fake.calls.delete, [{ sessionId: "s-1", syncContext: false }], "a session nothing ran in is let go without an upload");
  await assert.rejects(lstat(path.join(project.runtimeDir, "agentbay", "session.json")), { code: "ENOENT" });
  assert.equal((await manager.status(project)).startError?.code, "agentbay_landlock_unavailable", "the waiting shell is told why");
  const state = JSON.parse(await readFile(path.join(project.metaDir, "runtime-state.json"), "utf8"));
  assert.equal(state.event, "failed");
  assert.equal(state.error, "agentbay_landlock_unavailable");
  assert.equal(manager.runtimes.size, 0);
});

test("partial Landlock runs where the deployment accepted it by name, and says so on the record", async (t) => {
  const { fake, project, managerFor } = await fixture(t, {
    config: { agentbaySandboxEnforcement: "partial" },
    report: (envs) => ({ ok: envs.EVIMED_REQUIRED_ENFORCEMENT === "partial", kernelRelease: "6.8.0-agentbay", landlockAbi: 4, landlock: "partial", firewall: "applied", firewallDetail: "applied" }),
  });
  const manager = managerFor();
  const runtime = await manager.start(project);
  assert.equal(runtime.sandbox.landlock, "partial");
  assert.equal(runtime.sandbox.landlockAbi, 4);
  const patch = await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/control-plane-patch.yml"), "utf8");
  assert.match(patch, /requiredEnforcement: 'partial'/, "the kernel's own fence is told the same level");
  const state = JSON.parse(await readFile(path.join(project.metaDir, "runtime-state.json"), "utf8"));
  assert.equal(state.sandbox.landlock, "partial");
});

test("the launcher measures the kernel it runs on and refuses a level below the one required", { skip: process.platform !== "linux" }, async (t) => {
  if (spawnSync("id", ["-u", "evimed"]).status === 0) return t.skip("this machine has a user named evimed");
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Only `id -u` is answered as root, so the launcher's first check passes and
  // nothing after the Landlock decision can run: the next step is the runtime
  // user, and there is none here.
  await writeFile(path.join(root, "id"), "#!/bin/sh\nif [ \"$#\" = 1 ] && [ \"$1\" = -u ]; then echo 0; else exec /usr/bin/id \"$@\"; fi\n");
  await chmod(path.join(root, "id"), 0o755);
  const run = (required) => {
    const result = spawnSync("bash", [launcher, "start"], {
      encoding: "utf8",
      env: { PATH: `${root}:${process.env.PATH}`, OPEN_SCIENCE_RUNTIME_PORT: "4096", OPEN_SCIENCE_SESSION_BRIDGE_PORT: "30100", EVIMED_REQUIRED_ENFORCEMENT: required },
    });
    return { status: result.status, said: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") };
  };
  for (const required of ["full", "partial"]) {
    const { status, said } = run(required);
    assert.notEqual(status, 0);
    assert.equal(said.ok, false);
    if (said.code === "evimed_session_user_missing") continue;
    assert.equal(said.kernelRelease, os.release());
    const expected = said.landlockAbi >= 5 ? "full" : said.landlockAbi >= 1 ? "partial" : "none";
    assert.equal(said.landlock, expected);
    if (expected === "none") assert.equal(said.code, "agentbay_landlock_unavailable");
    else assert.equal(said.code, "agentbay_sandbox_enforcement_insufficient", `${expected} against ${required}`);
    assert.ok(expected === "none" || (required === "full" && expected === "partial"), "a sufficient level goes on to the runtime user");
  }
});

test("workload tokens are renewed through the file API, the one replaced stays valid, and a failed renewal is waited out while it can be", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const manager = managerFor();
  const runtime = await manager.start(project);
  const key = manager.key(project);
  const read = async () => (await readFile(fake.sessionFile("s-1", "/runtime/dsh-home/evimed-workload.token"), "utf8")).trim();
  const first = await read();

  assert.equal(await manager.refreshEviMedRuntimeToken(project, manager.evimedWorkloadRefreshTimers.get(key)), true);
  const second = await read();
  assert.notEqual(second, first);
  await manager.assertActiveEviMedWorkloadToken(first);
  await manager.assertActiveEviMedWorkloadToken(second);
  assert.equal(await manager.refreshEviMedRuntimeToken(project, manager.evimedWorkloadRefreshTimers.get(key)), true);
  await assert.rejects(manager.assertActiveEviMedWorkloadToken(first), { code: "evimed_workload_token_invalid" },
    "two renewals on, the first token is no longer accepted");
  await manager.assertActiveEviMedWorkloadToken(second);

  // The session's file API failing for a moment: the installed token still
  // outlives the next attempt, so the runtime keeps running.
  const session = fake.sessions.get("s-1").session;
  const writeFileOnce = session.fileSystem.writeFile;
  session.fileSystem.writeFile = async () => ({ success: false, errorMessage: "busy" });
  assert.equal(await manager.refreshEviMedRuntimeToken(project, manager.evimedWorkloadRefreshTimers.get(key)), true);
  assert.equal(manager.runtimes.get(key), runtime);
  assert.ok((await runtimeEvents(project)).some((event) => event.event === "workload_token_refresh_failed" && event.stopping === false));

  // Failing when the installed token would lapse before the next attempt:
  // the runtime is stopped rather than left to fail its calls.
  runtime.workloadTokenInstalledAt = Date.now() - 700_000;
  assert.equal(await manager.refreshEviMedRuntimeToken(project, manager.evimedWorkloadRefreshTimers.get(key)), false);
  assert.equal(manager.runtimes.has(key), false);
  session.fileSystem.writeFile = writeFileOnce;
  await eventually(() => fake.calls.delete.length === 1);
});

test("the heartbeat keeps the session, replaces an expired link, and ends a runtime whose kernel died with its last words", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const manager = managerFor();
  const runtime = await manager.start(project);
  const child = runtime.child;
  const keepAlive = fake.calls.keepAlive;
  await child.beat();
  assert.equal(fake.calls.keepAlive, keepAlive + 1, "the session's idle clock counts SDK calls, so every beat is one");
  assert.equal(child.failures, 0);

  // AgentBay issues new links: the old one stops answering.
  const state = fake.sessions.get("s-1");
  await state.proxy.close();
  state.proxy = await linkProxy({ port: () => state.bridgePort, token: "tok-renewed", alive: () => state.alive });
  await child.beat();
  assert.equal(child.failures, 1, "one failed beat is not yet a verdict");
  await child.beat();
  assert.equal(await sessionList(runtime), 200, "the next call goes through the new link");
  await child.beat();
  assert.equal(child.failures, 0);

  // The kernel dies inside a session that lives on.
  await fake.killKernel("s-1");
  await child.beat();
  assert.equal(child.exitCode, null);
  await child.beat();
  assert.equal(child.exitCode, 1);
  await eventually(async () => (await runtimeEvents(project)).some((event) => event.event === "exited"));
  const exited = (await runtimeEvents(project)).find((event) => event.event === "exited");
  assert.equal(exited.exitOutput, "the kernel's last words");
  assert.equal(manager.runtimes.has(manager.key(project)), false);
  await manager.provider.settled();
  assert.ok(fake.calls.delete.some((call) => call.sessionId === "s-1" && call.syncContext === true), "the session is released with its upload");
  await assert.rejects(lstat(path.join(project.runtimeDir, "agentbay", "session.json")), { code: "ENOENT" });
});

test("a session AgentBay released on its own clock ends the runtime as a kill", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const manager = managerFor();
  const runtime = await manager.start(project);
  await fake.writeInSession("s-1", "/workspace/progress.md", "half done");
  await fake.releaseOnItsOwn("s-1");
  await runtime.child.beat();
  await runtime.child.beat();
  assert.equal(runtime.child.exitCode, 137);
  assert.equal(runtime.child.signalCode, "SIGKILL");
  assert.equal(manager.provider.exiting.size, 1, "the exit's aftermath is tracked, not fired and forgotten");
  await manager.provider.settled();
  assert.equal(await readFile(path.join(project.workspaceDir, "progress.md"), "utf8"), "half done",
    "what the session held when AgentBay released it comes home from its Context");

  // A start right after waits for that homecoming instead of pushing over it.
  await manager.start(project);
  assert.equal(await readFile(fake.sessionFile("s-2", "/workspace/progress.md"), "utf8"), "half done");
});

test("a session's memory is sampled from its metrics", async (t) => {
  const { fake, project, managerFor } = await fixture(t);
  const manager = managerFor();
  const runtime = await manager.start(project);
  fake.sessions.get("s-1").memUsed = 7_000;
  await manager.recordRuntimePidPressure(project);
  assert.equal(runtime.peakMemoryBytes, 7_000);
  assert.equal(runtime.memoryPressureReported, true);
  assert.ok((await runtimeEvents(project)).some((event) => event.event === "memory_pressure" && event.memoryLimitBytes === 8192));
});

test("an AgentBay deployment that cannot serve says which setting is missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-ab-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = { configured: true, region: "cn-hangzhou", sdkVersion: async () => "0.22.0" };
  const refused = (overrides, clientOverrides = {}) => {
    const provider = new AgentBayRuntimeProvider({ config: configFor(root, overrides) }, { client: /** @type {any} */ ({ ...client, ...clientOverrides }) });
    try {
      provider.assertConfigured();
      return null;
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(refused({}), null);
  assert.equal(refused({}, { configured: false }), "agentbay_unconfigured");
  assert.equal(refused({ agentbayImageId: "" }), "agentbay_image_unconfigured");
  assert.equal(refused({ agentbayBridgePort: 8080 }), "agentbay_bridge_port_invalid");
  assert.equal(refused({ agentbayBridgeSecretMode: "query" }), "agentbay_bridge_secret_mode_invalid");
  assert.equal(refused({ agentbaySandboxEnforcement: "none" }), "agentbay_sandbox_enforcement_invalid");
  assert.equal(refused({ runtimeGatewayPublicUrl: "" }), "agentbay_gateway_unconfigured");
  assert.equal(refused({ runtimeGatewayPublicUrl: "http://evimed.example/runtime-gateway" }), "agentbay_gateway_unconfigured");
  assert.equal(refused({ agentbayWorkloadTokenTtlSeconds: 600, agentbayWorkloadTokenRefreshSeconds: 300 }), "agentbay_workload_token_timing_invalid");
  assert.equal(refused({ agentbayWorkloadTokenTtlSeconds: 1800 }), "agentbay_workload_token_timing_invalid");

  const provider = new AgentBayRuntimeProvider({ config: configFor(root) }, { client: /** @type {any} */ (client) });
  const readiness = await provider.readiness();
  assert.equal(readiness.controlPlane, "agentbay_api", "readiness never asks a Docker controller");
  assert.equal(readiness.transport, "wss");
  assert.equal(readiness.gateway, "https://evimed.example");
  assert.equal(readiness.sdkVersion, "0.22.0");
});

test("the AgentBay provider takes its own defaults: caps 100 and 2, the wss transport; Docker keeps 8, 4 and unix", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-ab-caps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  for (const key of ["OPEN_SCIENCE_RUNTIME_PROVIDER", "OPEN_SCIENCE_RUNTIME_TRANSPORT", "OPEN_SCIENCE_MAX_RUNNING_RUNTIMES", "OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER"]) {
    delete process.env[key];
  }
  const agentbay = loadConfig({ dataDir: root, runtimeProvider: "agentbay" });
  assert.equal(agentbay.runtimeProvider, "agentbay");
  assert.equal(agentbay.runtimeTransport, "wss");
  assert.equal(agentbay.maxRunningRuntimes, 100);
  assert.equal(agentbay.maxRunningRuntimesPerUser, 2);
  assert.equal(agentbay.agentbayIdleReleaseMinutes, 30);
  assert.equal(agentbay.agentbayMaxRuntimeMinutes, 240);
  assert.equal(agentbay.agentbayWorkloadTokenTtlSeconds, 900);
  assert.equal(agentbay.agentbayWorkloadTokenRefreshSeconds, 300);
  const docker = loadConfig({ dataDir: root });
  assert.equal(docker.runtimeProvider, "docker");
  assert.equal(docker.runtimeTransport, "unix");
  assert.equal(docker.maxRunningRuntimes, 8);
  assert.equal(docker.maxRunningRuntimesPerUser, 4);
  // The switch is the provider alone: the compose files pass the Docker
  // transport to every service, and an AgentBay runtime has only its links.
  assert.equal(loadConfig({ dataDir: root, runtimeProvider: "agentbay", runtimeTransport: "unix" }).runtimeTransport, "wss");
  assert.throws(() => loadConfig({ dataDir: root, runtimeTransport: "wss" }), /does not fit/);
  assert.throws(() => loadConfig({ dataDir: root, runtimeTransport: "tcp" }), /must be "unix" or "wss"/);
  assert.throws(() => loadConfig({ dataDir: root, runtimeProvider: "kubernetes" }), /OPEN_SCIENCE_RUNTIME_PROVIDER/);
  // An operator's explicit number still wins on either provider.
  process.env.OPEN_SCIENCE_MAX_RUNNING_RUNTIMES = "12";
  assert.equal(loadConfig({ dataDir: root, runtimeProvider: "agentbay" }).maxRunningRuntimes, 12);
});
