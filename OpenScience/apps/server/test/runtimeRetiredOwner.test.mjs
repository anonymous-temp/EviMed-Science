// An account whose deletion has begun starts no runtime, and a runtime that was starting when the deletion began is closed
// instead of registered (2026-10-27: a walk's throwaway account was deleted while a page of it started a runtime, which then ran,
// unowned, until a restart forgot it).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RUNTIME_KERNEL_NAME, RuntimeManager, issueEviMedWorkloadToken } from "../src/runtimeManager.mjs";

async function projectIn(root, userId, id) {
  const rootDir = path.join(root, userId, id);
  const project = { id, userId, rootDir, baseDir: path.join(rootDir, "workspace"), workspaceDir: path.join(rootDir, "workspace"), metaDir: path.join(rootDir, ".openscience") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  return project;
}
const runtimeOf = (project, close) => ({ kind: RUNTIME_KERNEL_NAME, url: `http://127.0.0.1/${project.id}`, close, password: null, sandboxMode: "host", networkMode: null,
  workspaceDir: project.workspaceDir, proxyWorkspaceDir: project.workspaceDir, startedAt: new Date().toISOString(), pid: 1, exitedAt: null, project });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-retired-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RuntimeManager({ runtimeMode: "kernel", runtimeSandboxMode: "docker", maxRunningRuntimes: 4, maxRunningRuntimesPerUser: 4 }, {});
  manager.runtimeBusy = async () => false;
  t.after(() => manager.closeAll());
  return { manager, project: await projectIn(root, "walk-1", "default") };
}

test("no runtime of an account whose deletion began is started", async (t) => {
  const { manager, project } = await fixture(t);
  let started = 0;
  manager.startKernel = async (p) => { started += 1; return runtimeOf(p, async () => {}); };
  manager.retireOwner("walk-1");
  await assert.rejects(manager.start(project), { code: "account_deleted", status: 410 });
  assert.equal(started, 0);
  // A deletion that failed before the account was gone gives it back.
  manager.retireOwner("walk-1", { undo: true });
  await manager.start(project);
  assert.equal(manager.runtimes.has(manager.key(project)), true);
});

test("a runtime that was booting when the deletion began is closed, not registered, and its start fails by name", async (t) => {
  const { manager, project } = await fixture(t);
  let closed = 0;
  manager.startKernel = async (p) => {
    manager.retireOwner(p.userId); // the account's DELETE arrives while the kernel boots
    return runtimeOf(p, async () => { closed += 1; });
  };
  await assert.rejects(manager.start(project), { code: "account_deleted" });
  assert.equal(manager.runtimes.has(manager.key(project)), false, "nothing is left registered for the deleted account");
  assert.equal(closed, 1, "the container it made is closed");
  assert.equal(manager.startingWorkloads.has(manager.key(project)), false);
});

test("a workload token is refused as soon as its account's deletion begins: a booting kernel's and a registered runtime's alike, and given back with the deletion's undo", async (t) => {
  const { manager } = await fixture(t);
  const secret = "workload-signing-secret-of-at-least-32-bytes";
  manager.config.evimedWorkloadSigningSecret = secret;
  const tokenFile = path.join(os.tmpdir(), `os-retired-owner-token-${process.pid}`);
  const token = issueEviMedWorkloadToken({ secret, userId: "walk-1", projectId: "default", nowSeconds: Math.floor(Date.now() / 1000), ttlSeconds: 300, jti: "jwt_retired" });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  t.after(() => rm(tokenFile, { force: true }));
  const refused = () => manager.assertActiveEviMedWorkloadToken(token).then(() => null, (error) => ({ status: error.status, code: error.code }));
  // A kernel still booting is accepted on the file its start was given...
  manager.starts.set("walk-1:default", Promise.resolve());
  manager.startingWorkloads.set("walk-1:default", { workloadTokenFile: tokenFile });
  assert.equal((await manager.assertActiveEviMedWorkloadToken(token)).userId, "walk-1");
  // ...until the account's deletion has begun, before its start has ended and been closed.
  manager.retireOwner("walk-1");
  assert.deepEqual(await refused(), { status: 401, code: "evimed_workload_token_invalid" });
  assert.equal(manager.workloadTokenRefusals.runtime, 1);
  // A registered runtime of the account is no different.
  manager.starts.delete("walk-1:default");
  manager.startingWorkloads.delete("walk-1:default");
  manager.runtimes.set("walk-1:default", { workloadTokenFile: tokenFile, closedByManager: false, exitedAt: null, modelGatewayTokenJti: "jwt_retired", close: async () => {} });
  assert.deepEqual(await refused(), { status: 401, code: "evimed_workload_token_invalid" });
  // A deletion that failed before the account was gone gives it back.
  manager.retireOwner("walk-1", { undo: true });
  assert.equal((await manager.assertActiveEviMedWorkloadToken(token)).runtimeGeneration, "jwt_retired");
});
