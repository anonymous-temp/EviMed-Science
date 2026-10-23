import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RuntimeManager, readOnlyWorkspaceViews } from "../src/runtimeManager.mjs";
import { AgentBayRuntimeProvider } from "../src/agentbay/runtimeProvider.mjs";

const project = { userId: "u", id: "p", baseDir: "/project/workspace", workspaceDir: "/project/workspace/study", runtimeDir: "/project/runtime" };
const bytes = Buffer.from("published");
const sha256 = createHash("sha256").update(bytes).digest("hex");
function manager(provider, name = "agentbay") {
  const instance = Object.create(RuntimeManager.prototype);
  Object.assign(instance, { config: { runtimeProvider: name }, provider, runtimes: new Map() });
  return instance;
}

test("runtime upload receipts distinguish local, deferred and remote failure and map base knowledge files into the runtime view", async () => {
  const local = manager({}, "docker");
  assert.equal((await local.mirrorWorkspaceUploadReceipt(project, `${project.baseDir}/knowledge-base/a.txt`, bytes)).state, "not-needed");
  const remote = manager({ mirrorUpload: async () => false });
  assert.equal((await remote.mirrorWorkspaceUploadReceipt(project, `${project.baseDir}/knowledge-base/a.txt`, bytes)).state, "deferred");
  remote.runtimes.set(remote.key(project), { containerName: "session-1" });
  let seen;
  remote.provider.mirrorUpload = async (_project, relative) => { seen = relative; return false; };
  const failed = await remote.mirrorWorkspaceUploadReceipt(project, `${project.baseDir}/knowledge-base/a.txt`, bytes);
  assert.equal(failed.state, "retryable-failure");
  assert.equal(seen, "knowledge-base/a.txt");
  remote.provider.mirrorUpload = async () => true;
  const receipt = await remote.mirrorWorkspaceUploadReceipt(project, `${project.baseDir}/knowledge-base/a.txt`, bytes);
  assert.equal(receipt.state, "acknowledged");
  assert.equal(receipt.runtimeIdentity, "session-1");
  assert.equal(receipt.sha256, sha256);
  assert.equal(await remote.mirrorWorkspaceUpload(project, `${project.baseDir}/knowledge-base/a.txt`, bytes), true);
});

test("new runtimes include the base knowledge view when the active workspace is a subdirectory", async t => {
  const root = await mkdtemp("/tmp/evimed-runtime-views-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = { ...project, baseDir: root, workspaceDir: path.join(root, "study") };
  await mkdir(path.join(root, "knowledge-base"));
  const provider = new AgentBayRuntimeProvider({ config: { dataDir: root }, key: () => "p" }, { client: {} });
  assert.equal(provider.views(nested).kb?.host, path.join(root, "knowledge-base"));
  assert.equal(readOnlyWorkspaceViews({}, nested).knowledgeBase, path.join(root, "knowledge-base"));
});

test("remote acknowledgments require a matching digest from the same AgentBay session", async () => {
  const owner = { config: {}, key: () => "p" };
  const provider = new AgentBayRuntimeProvider(owner, { client: {} });
  const live = { sessionId: "session-1", session: {} };
  provider.live.set("p", live);
  provider.mirrorUpload = async () => true;
  provider.command = async () => ({ ok: true, stdout: "wrong-digest  file", stderr: "", exitCode: 0 });
  assert.equal((await provider.mirrorUploadReceipt(project, "knowledge-base/a.txt", bytes)).state, "retryable-failure");
  provider.command = async () => ({ ok: true, stdout: `${sha256}  file`, stderr: "", exitCode: 0 });
  assert.equal((await provider.mirrorUploadReceipt(project, "knowledge-base/a.txt", bytes)).runtimeIdentity, "session-1");
  provider.command = async () => {
    provider.live.set("p", { sessionId: "session-2", session: {} });
    return { ok: true, stdout: `${sha256}  file`, stderr: "", exitCode: 0 };
  };
  assert.equal((await provider.mirrorUploadReceipt(project, "knowledge-base/a.txt", bytes)).code, "runtime_replica_changed");
});

test("a remote replica timeout releases the caller without claiming acknowledgment", async () => {
  const remote = manager({ mirrorUpload: async () => new Promise(() => {}) });
  remote.config.runtimeProxyConnectTimeoutMs = 20;
  remote.runtimes.set(remote.key(project), { containerName: "session-1" });
  const receipt = await remote.mirrorWorkspaceUploadReceipt(project, `${project.baseDir}/knowledge-base/a.txt`, bytes);
  assert.equal(receipt.state, "retryable-failure");
  assert.equal(receipt.code, "runtime_replica_timeout");
});
