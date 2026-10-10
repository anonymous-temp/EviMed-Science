import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { createModelGatewayHandler } from "../src/modelGateway.mjs";
import { createVcrCloudEgress, createVcrSessionResolver } from "../src/vcrCloudEgress.mjs";

// The privacy hook sits on every model call of every project. It must cost a project that never touched clinical data
// nothing it can fail on: the session used to be resolved first, from the whole run ledger, so a damaged or oversized
// ledger refused the model call of a project with no study (`agent_runs_corrupt`, `agent_runs_too_large`) -- and
// every call parsed that ledger twice. Here: the cheap question comes first, the production resolver is pinned, and a
// project that does hold a study is still checked and still fails closed.

const origin = "https://api.example.org";
const caller = { userId: "alice", projectId: "paper-1", sessionId: "kernel-session" };

/** A store that knows nothing but what these tests tell it. @param {{ study?: boolean, rows?: any[] }} [options] */
function storeDouble({ study = false, rows = [] } = {}) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    async holdsStudy(userId, projectId) { calls.push(`holdsStudy:${userId}:${projectId}`); return study; },
    async cloudDependencies(userId, projectId, sessionId, ids) { calls.push(`cloudDependencies:${sessionId}:${ids.length}`); return rows; },
    async inheritCloudDependency() { calls.push("inherit"); },
  };
}

/** A dependency whose source permission was revoked after the conversation read it. */
const revokedRow = { id: "prj_" + "a".repeat(48), study_id: "study-1", deleted_at: null, permission_hash: "x", cloud_permission: { schema: 1, status: "revoked" } };

test("a project that holds no study is allowed before its session or its dependencies are looked at", async () => {
  const store = storeDouble({ study: false });
  let resolved = 0;
  const egress = createVcrCloudEgress({ store, resolveSession: async () => { resolved += 1; return "never"; }, destinations: () => [origin] });
  await egress(caller, { messages: [{ role: "user", content: "an ordinary research question" }] });
  assert.equal(resolved, 0, "the ledger is not read for a project with nothing to revalidate");
  assert.deepEqual(store.calls, ["holdsStudy:alice:paper-1"]);
});

test("a project that holds a study resolves the conversation and revalidates what it read", async () => {
  const store = storeDouble({ study: true, rows: [revokedRow] });
  /** @type {any[]} */
  const resolvedFor = [];
  const egress = createVcrCloudEgress({ store, resolveSession: async (who) => { resolvedFor.push(who); return "ledger-session"; }, destinations: () => [origin] });
  await assert.rejects(egress(caller, { messages: ["cached clinical context"] }), { code: "vcr_cloud_processing_not_authorized" });
  assert.deepEqual(resolvedFor, [caller]);
  assert.deepEqual(store.calls, ["holdsStudy:alice:paper-1", "cloudDependencies:ledger-session:0"], "the dependencies are asked for under the resolved conversation");

  // The control: with nothing recorded against the conversation the same project's call goes through.
  const clean = storeDouble({ study: true, rows: [] });
  await createVcrCloudEgress({ store: clean, resolveSession: async () => "ledger-session", destinations: () => [origin] })(caller, { messages: ["an unrelated question"] });
  assert.deepEqual(clean.calls, ["holdsStudy:alice:paper-1", "cloudDependencies:ledger-session:0"]);
});

/** A project on disk with a run ledger, as the control plane keeps one. */
async function ledgerFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "vcr-egress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "paper-1", userId: "alice", rootDir: root, baseDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  const bindings = new Map();
  const runs = new AgentRunStore({ get: async (_project, id) => bindings.get(id) ?? null }, { model: "deepseek/deepseek-v4-pro", monitorIntervalMs: 60_000 });
  runs.scheduleMonitor = () => {};
  /** A run that is running in this conversation. @param {string} sessionId */
  const start = async (sessionId) => {
    bindings.set(sessionId, { sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null });
    return (await runs.reserveRun(project, bindings.get(sessionId), { dispatchId: `dispatch-${sessionId}`, baselineCursor: null })).run;
  };
  const damage = () => writeFile(path.join(project.metaDir, "runs.jsonl"), "this is not a run ledger\n");
  const resolver = createVcrSessionResolver({ sourceProject: async (who) => {
    assert.deepEqual([who.userId, who.projectId], ["alice", "paper-1"]);
    return project;
  }, agentRuns: runs });
  return { project, runs, start, damage, resolver };
}

test("the production resolver files a call under the conversation its run records", async (t) => {
  const f = await ledgerFixture(t);
  const root = await f.start("conversation-a");
  await f.start("conversation-b");

  assert.equal(await f.resolver({ ...caller, sessionId: "conversation-a" }), "conversation-a");
  assert.equal(await f.resolver({ ...caller, sessionId: "unknown-session" }), "unknown-session", "a session no run owns is its own conversation");
  assert.equal(await f.resolver({ ...caller, sessionId: null }), null);

  // A subagent's session is its parent's conversation: the live progress tracker is what knows it.
  f.runs.progressTracker(root.id).children.add("child-session");
  assert.equal(await f.resolver({ ...caller, sessionId: "child-session" }), "conversation-a", "a child inherits the dependencies of its parent's conversation");

  // A call that names its run is filed under that run's conversation, the session it carries notwithstanding.
  assert.equal(await f.resolver({ ...caller, runId: root.id, sessionId: "somewhere-else" }), "conversation-a");

  // And a run that has finished is still found when it is named: a review of a delivered run is a model call too.
  await f.runs.finishInternal(f.project, root.id, { status: "succeeded", artifacts: [] });
  assert.equal(await f.resolver({ ...caller, runId: root.id }), "conversation-a");
  assert.equal(await f.resolver({ ...caller, sessionId: "conversation-a" }), "conversation-a", "its conversation is still its own once nothing is running in it");
});

/** The model gateway in front of a provider that records what reached it, with the privacy hook the server wires. */
async function gatewayFixture(t, { store, resolver }) {
  let sent = 0;
  const provider = async () => { sent += 1; return new Response(JSON.stringify({ id: "chatcmpl-1", model: "deepseek-v4-pro", choices: [{ message: { role: "assistant", content: "ok" } }] }), { headers: { "content-type": "application/json" } }); };
  const runtimeManager = { assertActiveModelGatewayToken: (token) => {
    if (token !== "runtime-token") throw Object.assign(new Error("invalid"), { status: 401, code: "model_gateway_token_invalid" });
    return { userId: "alice", projectId: "paper-1", jti: "runtime-1" };
  } };
  const gateway = createServer(createModelGatewayHandler({
    deepseekProviderEnabled: true, deepseekApiKey: "server-only-test-secret", deepseekBaseUrl: "https://provider.invalid",
    deepseekModel: "deepseek-v4-pro", modelGatewayMaxBodyBytes: 32 * 1024, modelGatewayTimeoutMs: 1_000, modelGatewayMaxResponseBytes: 32 * 1024 * 1024,
  }, runtimeManager, { fetchImpl: provider, assertModelAccess: createVcrCloudEgress({ store, resolveSession: resolver, destinations: () => [origin] }) }));
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(async () => { gateway.close(); await once(gateway, "close"); });
  const base = `http://127.0.0.1:${/** @type {any} */ (gateway.address()).port}`;
  const ask = async () => {
    const response = await fetch(`${base}/internal/model/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer runtime-token", "content-type": "application/json", "x-deepseek-harness-session-id": "conversation-a" },
      body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "an ordinary question" }] }),
    });
    return { status: response.status, body: await response.text() };
  };
  return { ask, sent: () => sent };
}

test("a project with no study still has its model calls answered when its run ledger is damaged", async (t) => {
  const f = await ledgerFixture(t);
  await f.start("conversation-a");
  const store = storeDouble({ study: false });
  const gateway = await gatewayFixture(t, { store, resolver: f.resolver });
  assert.equal((await gateway.ask()).status, 200);

  await f.damage();
  const answered = await gateway.ask();
  assert.equal(answered.status, 200, answered.body);
  assert.equal(gateway.sent(), 2, "the provider was reached both times");
  assert.deepEqual(store.calls.filter((call) => call.startsWith("cloudDependencies")), [], "no dependency was looked up for a project that holds none");
});

test("a project that holds a study is still checked, and refused when its conversation cannot be read", async (t) => {
  const f = await ledgerFixture(t);
  await f.start("conversation-a");
  const revoked = storeDouble({ study: true, rows: [revokedRow] });
  const refused = await (await gatewayFixture(t, { store: revoked, resolver: f.resolver })).ask();
  assert.equal(refused.status, 403);
  assert.match(refused.body, /vcr_cloud_processing_not_authorized/);

  const clean = storeDouble({ study: true, rows: [] });
  const gateway = await gatewayFixture(t, { store: clean, resolver: f.resolver });
  assert.equal((await gateway.ask()).status, 200, "a conversation with nothing recorded against it goes through");
  assert.ok(clean.calls.some((call) => call.startsWith("cloudDependencies:conversation-a")), "and was looked up under its own conversation");

  // Fail closed: for this project an unreadable ledger is a conversation nobody can name, and nothing is sent.
  await f.damage();
  const unreadable = await gateway.ask();
  assert.equal(unreadable.status, 500);
  assert.match(unreadable.body, /agent_runs_corrupt/);
  assert.equal(gateway.sent(), 1, "the provider saw only the call made before the ledger was damaged");
});

test("the server wires the privacy hook with the resolver these tests pin, on every model path that asks it", async () => {
  // The resolver was a closure inside `createWebApiApp`, which no test could reach -- every test of the hook stubbed it with
  // `async caller => caller.sessionId`, and the first version of it resolved the project with the wrong identity (fixed
  // after manual acceptance, b4a4d7a5c, without a test). It is a module now; this holds the composition to it.
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /createVcrCloudEgress\(\{[^}]*resolveSession: createVcrSessionResolver\(\{ sourceProject, agentRuns \}\)/s);
  assert.doesNotMatch(source, /resolveSession: async caller =>/, "no second, untested resolver beside it");
  // And the one function it makes is the hook of the model gateway, the review model and the reply check alike.
  assert.match(source, /assertModelAccess: assertVcrCloudAccess,/);
  assert.match(source, /assertModelAccess: \(caller, body\) => assertVcrCloudAccess\?\.\(caller, body\)/);
});
