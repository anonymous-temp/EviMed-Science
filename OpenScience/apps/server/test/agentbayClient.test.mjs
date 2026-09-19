import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REDACTED, createAgentBayClient, readAgentBayKeyFile, scrubAgentBayText } from "../src/agentbay/client.mjs";

const KEY = "akm-test.key.with-dots_0123456789";

async function keyFile(t, contents = `${KEY}\n`, mode = 0o600) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentbay-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agentbay.api-key");
  await writeFile(file, contents);
  await chmod(file, mode);
  return { dir, file };
}

/** The SDK's surface, as far as the client uses it, recording every call. */
function fakeSdk({ onCreate, onGet, onDelete, onList } = {}) {
  const calls = { logger: [], constructed: [], create: [], get: [], delete: [], list: [] };
  class ContextSync {
    constructor(contextId, mountPath, policy) { Object.assign(this, { contextId, path: mountPath, policy }); }
  }
  class LifecyclePolicy {
    constructor(options) { Object.assign(this, options); }
  }
  class AgentBay {
    constructor(options) {
      calls.constructed.push(options);
      this.context = {
        get: async (name, create) => ({ success: true, context: { id: `ctx-${name}`, name }, contextId: `ctx-${name}`, create }),
        getFileUploadUrl: async () => ({ success: true, url: "https://oss.example/upload?sig=1" }),
        getFileDownloadUrl: async () => ({ success: true, url: "https://oss.example/download?sig=1" }),
        listFiles: async () => ({ success: true, entries: [{ filePath: "/a.txt", fileType: "file", size: 3, gmtModified: "2026-09-20T00:00:00Z" }] }),
        deleteFile: async () => ({ success: true }),
      };
    }
    async create(params) { calls.create.push(params); return onCreate ? onCreate(params) : { success: true, session: { sessionId: "s-1" } }; }
    async get(id) { calls.get.push(id); return onGet ? onGet(id) : { success: true, session: { sessionId: id } }; }
    async delete(session, sync) { calls.delete.push([session.sessionId, sync]); return onDelete ? onDelete(session, sync) : { success: true }; }
    async list(labels, page, limit, status) { calls.list.push([labels, page, limit, status]); return onList ? onList(labels, page) : { success: true, sessionIds: [] }; }
  }
  return { calls, module: { AgentBay, ContextSync, LifecyclePolicy, VERSION: "0.22.0-fake", setupLogger: (options) => calls.logger.push(options) } };
}

test("importing the real SDK leaves this process's environment as it found it", async (t) => {
  // The SDK walks upward from the working directory to the first `.env` and
  // copies its keys into process.env, once at import and again per client.
  const { dir, file } = await keyFile(t);
  await writeFile(path.join(dir, ".env"), "EVIMED_AGENTBAY_ENV_PROBE=leaked\nAGENTBAY_API_KEY=from-a-stray-file\n");
  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(previous));
  const client = createAgentBayClient({ agentbayApiKeyFile: file });
  assert.equal(await client.sdkVersion(), "0.22.0");
  assert.equal(process.env.EVIMED_AGENTBAY_ENV_PROBE, undefined);
  assert.equal(process.env.AGENTBAY_API_KEY, undefined);

  // The control: imported bare, from the same directory, the SDK does load that
  // file — so the check above proves the restoration, not an absent side effect.
  const { execFileSync } = await import("node:child_process");
  const sdkUrl = import.meta.resolve("wuying-agentbay-sdk");
  const bare = execFileSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(sdkUrl)}); process.stdout.write(String(process.env.EVIMED_AGENTBAY_ENV_PROBE))`],
  { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  assert.equal(bare, "leaked");
});

test("no key file is a named refusal, and a key file is held to the secret-file rules", async (t) => {
  await assert.rejects(() => createAgentBayClient({ agentbayApiKeyFile: "" }).getSession("s"), (error) => error.code === "agentbay_unconfigured");
  const open = await keyFile(t, `${KEY}\n`, 0o644);
  assert.equal(readAgentBayKeyFile(open.file).error, "agentbay_api_key_file_permissions");
  const linked = await keyFile(t);
  const link = path.join(linked.dir, "link");
  await symlink(linked.file, link);
  assert.equal(readAgentBayKeyFile(link).error, "agentbay_api_key_file_symlink");
  const good = await keyFile(t);
  assert.deepEqual(readAgentBayKeyFile(good.file), { value: KEY, error: null });
  // A refusal to read is not cached: fixing the file must not need a restart.
  const { module } = fakeSdk();
  let reads = 0;
  const client = createAgentBayClient({ agentbayApiKeyFile: good.file }, {
    sdk: module,
    readKey: (file) => (++reads === 1 ? { value: "", error: "agentbay_api_key_file_unavailable" } : readAgentBayKeyFile(file)),
  });
  await assert.rejects(() => client.getSession("s-1"), (error) => error.code === "agentbay_api_key_file_unavailable");
  assert.deepEqual(await client.getSession("s-1"), { sessionId: "s-1", session: { sessionId: "s-1" } });
});

test("the SDK is configured quietly, for one region, without reading a .env of its own", async (t) => {
  const { file } = await keyFile(t);
  const { calls, module } = fakeSdk();
  const client = createAgentBayClient({ agentbayApiKeyFile: file, agentbayRegion: "cn-hangzhou" }, { sdk: module });
  await client.getSession("s-1");
  assert.deepEqual(calls.logger, [{ enableConsole: false, logFile: "", level: "ERROR" }]);
  assert.deepEqual(calls.constructed, [{ apiKey: KEY, config: { region_id: "cn-hangzhou" }, envFile: "/dev/null" }]);
  const explicit = fakeSdk();
  await createAgentBayClient({ agentbayApiKeyFile: file, agentbayEndpoint: "agentbay.example.com" }, { sdk: explicit.module }).getSession("s-2");
  assert.deepEqual(explicit.calls.constructed[0].config, { endpoint: "agentbay.example.com" });
});

test("a session is created with its image, labels, lifecycle and contexts, and found, listed and deleted by id", async (t) => {
  const { file } = await keyFile(t);
  const { calls, module } = fakeSdk({
    onList: (_labels, page) => ({ success: true, sessionIds: page === 1 ? [{ sessionId: "s-9", sessionStatus: "RUNNING" }] : [] }),
    onGet: (id) => (id === "gone" ? { success: false, errorMessage: "session not found" } : { success: true, session: { sessionId: id } }),
  });
  const client = createAgentBayClient({ agentbayApiKeyFile: file }, { sdk: module });
  const created = await client.createSession({
    imageId: "imgc-1", labels: { user: "alice", project: "paper1", release: "r1" }, policyId: "pol-1",
    lifecycle: { idleMinutes: 30, maxRuntimeMinutes: 240 },
    contextSync: [{ contextId: "ctx-w", path: "/workspace", policy: { uploadPolicy: { autoUpload: true } } }],
  });
  assert.equal(created.sessionId, "s-1");
  const params = calls.create[0];
  assert.equal(params.imageId, "imgc-1");
  assert.deepEqual(params.labels, { user: "alice", project: "paper1", release: "r1" });
  assert.equal(params.policyId, "pol-1");
  assert.deepEqual({ ...params.lifecyclePolicy }, { idleReleaseTimeout: 30, maxRuntime: 240 });
  assert.equal(params.contextSync[0].constructor.name, "ContextSync");
  assert.deepEqual({ ...params.contextSync[0] }, { contextId: "ctx-w", path: "/workspace", policy: { uploadPolicy: { autoUpload: true } } });
  assert.deepEqual(await client.listSessions({ labels: { project: "paper1" } }), [{ sessionId: "s-9", status: "RUNNING" }]);
  assert.equal(await client.getSession("gone"), null);
  assert.deepEqual(await client.deleteSession("s-9", { syncContext: true }), { deleted: true, missing: false });
  assert.deepEqual(calls.delete, [["s-9", true]]);
  assert.deepEqual(await client.deleteSession("gone"), { deleted: false, missing: true });
  assert.deepEqual(await client.contexts.get("evimed-w", { create: true }), { id: "ctx-evimed-w", name: "evimed-w" });
  const listed = await client.contexts.listFiles("ctx-w", "/");
  assert.deepEqual(listed.entries, [{ path: "/a.txt", type: "file", size: 3, modified: "2026-09-20T00:00:00Z" }]);
});

test("nothing that leaves the client carries the key or a link token", async (t) => {
  const { file } = await keyFile(t);
  const { module } = fakeSdk({
    onCreate: () => { throw new Error(`InvalidParameter.Authorization: invalid apiKey or token: ${KEY}`); },
    onGet: () => ({ success: false, errorMessage: `denied for Bearer ${KEY} at wss://gw.example:8008/websocket_ai/tok-123456` }),
  });
  const client = createAgentBayClient({ agentbayApiKeyFile: file }, { sdk: module });
  const created = await client.createSession({ imageId: "imgc-1" }).catch((error) => error);
  assert.equal(created.code, "agentbay_request_failed");
  assert.ok(!created.message.includes(KEY), created.message);
  assert.ok(created.message.includes(REDACTED));
  assert.equal(created.cause, undefined, "the original error is not carried along");
  const guarded = await client.guard("session link", async () => {
    throw new Error(`link https://gw.example:8008/request_ai/tok-abcdef/path/ rejected ${KEY}`);
  }).catch((error) => error);
  assert.ok(!guarded.message.includes(KEY) && !guarded.message.includes("tok-abcdef"), guarded.message);
  assert.equal(scrubAgentBayText(`wss://gw/websocket_ai/abc?x=1 ${KEY}`, [KEY]), `wss://gw/websocket_ai/${REDACTED}?x=1 ${REDACTED}`);
});
