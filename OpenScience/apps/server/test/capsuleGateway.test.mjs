import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { RuntimeManager, issueEviMedWorkloadToken } from "../src/runtimeManager.mjs";
import { createCapsuleGatewayHandler } from "../src/capsuleGateway.mjs";

async function fixture(t, { memorySubstrate = null, sessions = null, recallItems = [] } = {}) {
  const dir = await mkdtemp("/tmp/evimed-capsule-gateway-");
  const secret = randomBytes(32).toString("hex");
  const project = { userId: "owner", id: "project-one" };
  const manager = new RuntimeManager({ evimedWorkloadSigningSecret: secret });
  const issue = (input = {}) => issueEviMedWorkloadToken({ secret, userId: project.userId, projectId: project.id, ...input });
  const token = issue();
  const tokenFile = `${dir}/workload.token`;
  await writeFile(tokenFile, token, { mode: 0o600 });
  const runtime = { workloadTokenFile: tokenFile };
  manager.runtimes.set(manager.key(project), runtime);
  const calls = [];
  const service = {
    recall: async (userId, input) => { calls.push({ action: "recall", userId, input }); return { items: structuredClone(recallItems), contextOnly: true }; },
    note: async (userId, projectId, input) => { calls.push({ action: "note", userId, projectId, input }); return { status: "candidate" }; },
  };
  let exists = true;
  let authorize;
  const authorized = new Promise((resolve) => { authorize = resolve; });
  const store = { userById: async () => exists ? { id: project.userId } : null,
    requireProject: async (user, id) => { assert.equal(user.id, project.userId); assert.equal(id, project.id); authorize(); return project; } };
  const handler = createCapsuleGatewayHandler({ runtimeManager: manager, store, service, memorySubstrate, sessions });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/internal/capsules/v1`;
  const request = (action, body, credential = token) => fetch(`${base}/${action}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
  });
  return { base, authorized, manager, project, runtime, tokenFile, token, issue, calls, request, removeUser: () => { exists = false; } };
}

test("runtime capsule gateway derives identity only from an active signed workload", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("recall", { query: "methods" }, "invalid")).status, 401);
  assert.equal((await f.request("recall", { query: "methods" }, f.issue({ userId: "other" }))).status, 401);
  assert.equal((await f.request("recall", { query: "methods", projectId: "other" })).status, 400);
  const response = await f.request("recall", { query: "methods", factKinds: ["preference"], scope: "all", since: null });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).contextOnly, true);
  assert.equal(f.calls[0].userId, "owner");
  assert.equal(f.calls[0].input.projectId, "project-one");
  assert.deepEqual(f.calls[0].input.factKinds, ["preference"]);
});

test("capsule credentials stop working on expiry, rotation, runtime stop or account deletion", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("recall", { query: "x" }, f.issue({ nowSeconds: Math.floor(Date.now() / 1000) - 400 }))).status, 401);
  const rotated = f.issue();
  await writeFile(f.tokenFile, rotated);
  assert.equal((await f.request("recall", { query: "x" })).status, 401);
  assert.equal((await f.request("recall", { query: "x" }, rotated)).status, 200);
  f.removeUser();
  assert.equal((await f.request("recall", { query: "x" }, rotated)).status, 401);
  f.manager.runtimes.clear();
  await assert.rejects(f.manager.assertActiveEviMedWorkloadToken(rotated), { code: "evimed_workload_token_invalid" });
});

test("a runtime note is the assistant's wording, takes effect at once, and rejects authority fields and oversized input", async (t) => {
  const f = await fixture(t);
  const noted = await f.request("note", { factKind: "preference", content: "Remember methods", origin: "explicit" });
  assert.equal(noted.status, 200);
  // No confirmation step (owner ruling 2026-09-19): the answer says the note
  // is in force, and the model's own "explicit" is not the researcher's word.
  const body = await noted.json();
  assert.equal(body.reviewRequired, false);
  assert.equal(body.takesEffect, true);
  assert.equal(f.calls[0].input.origin, "inferred");
  assert.equal((await f.request("note", { factKind: "preference", content: "x", status: "approved" })).status, 400);
  assert.equal((await f.request("note", { content: "x".repeat(70000) })).status, 413);
  assert.equal((await f.request("delete", {})).status, 404);
});


test("an authorized slow request is revoked before memory mutation after runtime stop", async (t) => {
  const f = await fixture(t);
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(`${f.base}/note`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); });
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("Request timed out")));
    request.flushHeaders();
  });
  await f.authorized;
  f.manager.runtimes.clear();
  request.end(JSON.stringify({ factKind: "preference", content: "Late unauthorized note" }));
  assert.equal(await response, 401);
  assert.equal(f.calls.length, 0);
});

test("a recall through the gateway reaches the records as well as the capsule, and says which store answered", async (t) => {
  // The tool the runtime holds promised `scope: all` from the day it was
  // written; the gateway answered from capsule facts alone. A delegated child
  // asking about the researcher therefore never saw the records the extractor
  // keeps — the memory the root had been handed in its own prompt.
  const substrateCalls = [];
  const memorySubstrate = {
    async recall(userId, query, scope) {
      substrateCalls.push({ userId, query, scope });
      return [{ id: "record:r1", content: "回答尽量简短", kind: "preference", scope: "user", memoryType: "structured", updatedAt: "2026-09-01T00:00:00.000Z" }];
    },
  };
  const f = await fixture(t, { memorySubstrate });
  const all = await (await f.request("recall", { query: "简短" })).json();
  assert.deepEqual(all.items.map((item) => [item.source, item.id]), [["memory", "record:r1"]]);
  assert.deepEqual(all.sources, { memory: 1, capsule: 0 });
  assert.equal(all.contextOnly, true);
  assert.equal(substrateCalls[0].userId, "owner");
  assert.equal(substrateCalls[0].scope.projectId, "project-one", "the project comes from the workload credential, never the body");
  assert.equal(f.calls.filter((call) => call.action === "recall").length, 1);

  const conversation = await (await f.request("recall", { query: "简短", scope: "conversation" })).json();
  assert.deepEqual(conversation.sources, { memory: 1, capsule: 0 });
  assert.equal(f.calls.filter((call) => call.action === "recall").length, 1, "conversation never asks the capsule");

  const capsule = await (await f.request("recall", { query: "简短", scope: "capsule" })).json();
  assert.deepEqual(capsule.sources, { memory: 0, capsule: 0 });
  assert.equal(substrateCalls.length, 2, "capsule never asks the records");

  const agenda = await f.request("recall", { query: "简短", scope: "agenda" });
  assert.equal(agenda.status, 400);
  assert.match(await agenda.text(), /capsule_scope_unavailable/);
});

/**
 * The conversations a gateway call can belong to, as the run ledger and the
 * memory store would answer. 无痕 and 「本次不用」 were read here until
 * 2026-09-20; the only state left is the capsule a conversation is trying.
 * @param {Record<string, { trialCapsuleId?: string | null }>} states
 * @param {{ id: string, sessionId: string }[]} running
 */
function sessionsDouble(running, states = {}) {
  const recorded = [];
  return {
    recorded,
    running: async () => structuredClone(running),
    state: async (_userId, _projectId, sessionId) => ({ trialCapsuleId: null, ...(states[sessionId] ?? {}) }),
    recordRecall: async (_project, runId, items) => { recorded.push({ runId, ids: items.map((item) => item.id) }); },
  };
}

test("a recall from the one running conversation is that conversation's, and lands on its run", async (t) => {
  const substrateCalls = [];
  const memorySubstrate = {
    async recall(userId, query, scope) {
      substrateCalls.push(scope);
      return [{ id: "record:r1", content: "回答尽量简短", kind: "preference", scope: "user", memoryType: "structured" }];
    },
  };
  const sessions = sessionsDouble([{ id: "run_1", sessionId: "ses_1" }]);
  const f = await fixture(t, {
    memorySubstrate, sessions,
    recallItems: [{ id: "fact_old", factKind: "workflow", content: "旧流程" }, { id: "fact_new", factKind: "preference", content: "中文作答" }],
  });
  const answer = await (await f.request("recall", { query: "流程" })).json();
  assert.deepEqual(answer.items.map((item) => item.id), ["record:r1", "fact_old", "fact_new"]);
  // The substrate hears which conversation is asking.
  assert.equal(substrateCalls[0].sessionId, "ses_1");
  assert.equal(substrateCalls[0].excluded, undefined, "there is no set-aside list left to pass");
  assert.equal(answer.setAside, undefined, "and nothing to report as withheld");
  // What the run was handed is on its own ledger line.
  assert.deepEqual(sessions.recorded, [{ runId: "run_1", ids: ["record:r1", "fact_old", "fact_new"] }]);
});

test("with several conversations running the gateway answers without naming one, and records no run", async (t) => {
  const substrateCalls = [];
  const memorySubstrate = { async recall(_userId, _query, scope) { substrateCalls.push(scope); return []; } };
  const running = [{ id: "run_1", sessionId: "ses_1" }, { id: "run_2", sessionId: "ses_2" }];
  const both = sessionsDouble(running);
  const f = await fixture(t, {
    memorySubstrate, sessions: both,
    recallItems: [{ id: "fact_a", content: "a" }, { id: "fact_b", content: "b" }, { id: "fact_c", content: "c" }],
  });
  const answer = await (await f.request("recall", { query: "x" })).json();
  assert.deepEqual(answer.items.map((item) => item.id), ["fact_a", "fact_b", "fact_c"]);
  assert.equal(substrateCalls[0].sessionId, null, "it cannot tell which conversation is asking");
  assert.deepEqual(both.recorded, [], "and so writes no run's ledger line");

  // If any of them is trying someone else's capsule, nothing is written.
  const oneTrial = sessionsDouble(running, { ses_2: { trialCapsuleId: "pack-1" } });
  const g = await fixture(t, { memorySubstrate, sessions: oneTrial, recallItems: [{ id: "fact_c", content: "c" }] });
  const note = await (await g.request("note", { factKind: "preference", content: "记住我喜欢表格" })).json();
  assert.equal(note.entry, null);
  assert.equal(note.takesEffect, false);

  // A ledger that cannot be read leaves the recall as it was before sessions existed.
  const broken = { ...sessionsDouble([]), running: async () => { throw new Error("ledger down"); } };
  const h = await fixture(t, { memorySubstrate, sessions: broken, recallItems: [{ id: "fact_c", content: "c" }] });
  assert.deepEqual((await (await h.request("recall", { query: "x" })).json()).items.map((item) => item.id), ["fact_c"]);
});

test("a conversation trying someone else's capsule still reads memory but notes nothing", async (t) => {
  const recalledFrom = [];
  const memorySubstrate = { async recall(_userId, _query, scope) { recalledFrom.push(scope.sessionId); return []; } };
  const sessions = sessionsDouble([{ id: "run_1", sessionId: "ses_trial" }], { ses_trial: { trialCapsuleId: "pack-1" } });
  const f = await fixture(t, { memorySubstrate, sessions, recallItems: [{ id: "fact_1", content: "x" }] });
  const recall = await (await f.request("recall", { query: "x" })).json();
  assert.deepEqual(recall.items.map((item) => item.id), ["fact_1"]);
  assert.deepEqual(recalledFrom, ["ses_trial"]);
  const note = await (await f.request("note", { factKind: "preference", content: "记住我喜欢表格" })).json();
  assert.equal(note.entry, null);
  assert.equal(note.incognito, undefined, "无痕 is gone, and the answer no longer carries its flag");
  assert.match(note.notice, /试用别人胶囊/);
  assert.equal(f.calls.filter((call) => call.action === "note").length, 0);
});
