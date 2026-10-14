// The turn committer on a real PostgreSQL and a stub engine, end to end: a short exchange of a native account is said through the
// memory gateway as the plugin says it, the turn ends, the committer commits through the gateway's own path, and what the rest of
// the native memory path owes a commit is done — the ledger row (`native_commits`, origin `gateway`, the project of the
// conversation from `native_sessions`), the worker's reading of the diff into revisions and the memory file, and the replay of an
// extraction that failed. The unit file next to this one holds the committer's own rules with doubles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createMemoryAdmission } from "../src/memoryAdmission.mjs";
import { MEMORY_GATEWAY_PATH, createMemoryGatewayHandler } from "../src/memoryGateway.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { NativeMemoryOverlay } from "../src/nativeMemoryOverlay.mjs";
import { NativeMemoryWorker } from "../src/nativeMemoryWorker.mjs";
import { NativeTurnCommit } from "../src/nativeTurnCommit.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const config = { ovNativeMemoryEnabled: true, memoryEnabled: true, memoryContextLimit: 8, memoryContextMaxChars: 20_000, nativeMemoryReplayAttempts: 3 };
const TOKEN = "workload-token-for-tests";
const CONVERSATION = "session_0123456789abcdef0123456789abcdef";
const ENGINE_SESSION = `dsh-${CONVERSATION}`;

/** @type {ControlPlaneDatabase} */
let database;
const users = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
});
after(async () => {
  if (!url) return;
  for (const id of users) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
  await database.close();
});

test("a short exchange is learned from while the runtime lives: ledger row, project, diff, memory file — and a failed extraction is replayed", options, async (t) => {
  resetNativeMemoryMetrics();
  const userId = `tc_${randomUUID().slice(0, 8)}`;
  users.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Turn commit test','development')", [userId]);
  const project = { id: "p_turn", userId };
  let failNext = false;
  const profileOf = (user) => `viking://user/${user}/memories/profile.md`;
  const stub = await startOpenVikingStub(t, { extract: ({ user, messages }) => {
    if (failNext) { failNext = false; return "fail"; }
    const said = messages.flatMap((message) => (message.parts ?? []).map((part) => part.text)).join("\n");
    return /心内科/.test(said) ? { adds: [{ uri: profileOf(user), memory_type: "profile", after: "# Profile\n- 心内科主治医生，在苏州工作" }] } : {};
  } });
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const overlay = new NativeMemoryOverlay({ database });
  const researchMemory = new ResearchMemoryStore(config, { database });
  assert.equal(await researchMemory.memoryEngine(userId), "native");
  const runs = [];
  const conversations = {
    running: async () => runs.filter((run) => run.status === "running"),
    runsOf: async (_project, id) => runs.filter((run) => run.sessionId === id),
  };
  const admission = createMemoryAdmission({ config, researchMemory, conversations });
  const handler = createMemoryGatewayHandler({
    config,
    runtimeManager: { assertActiveEviMedWorkloadToken: async (token) => { if (token === TOKEN) return { userId, projectId: project.id }; throw new Error("no"); } },
    store: { userById: async (id) => (id === userId ? { id } : null), requireProject: async (_user, id) => ({ id, userId }) },
    sessions, admission, overlay,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}${MEMORY_GATEWAY_PATH}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const say = (role, text) => post(`/api/v1/sessions/${ENGINE_SESSION}/messages`, { role, parts: [{ type: "text", text }] });

  /** @type {Set<{ fn: () => void }>} */
  const timers = new Set();
  const committer = new NativeTurnCommit({
    config: { ...config, nativeMemoryTurnCommitSettleMs: 100 }, researchMemory, sessions, admission, conversations, commit: handler.commitSession,
    setTimer: (fn) => { const timer = { fn }; timers.add(timer); return timer; }, clearTimer: (timer) => { timers.delete(timer); }, wait: async () => {},
  });
  const worker = new NativeMemoryWorker({ config, researchMemory, sessions, overlay });
  const turnEnds = async (id) => {
    runs.push({ id, sessionId: CONVERSATION, status: "succeeded" });
    await committer.noteRunFinished(project, runs.at(-1));
    for (const timer of [...timers]) { timers.delete(timer); timer.fn(); }
    await committer.idle();
  };

  await post("/api/v1/sessions", { session_id: ENGINE_SESSION });
  await say("user", "我是心内科的主治医生，在苏州工作。");
  await say("assistant", "好的，记下了。");
  assert.equal(stub.sent("POST", `/api/v1/sessions/${ENGINE_SESSION}/commit`).length, 0, "nothing has committed it: the plugin's threshold is 20000 tokens");
  await turnEnds("run-1");

  const ledger = await overlay.commitsOfSession(userId, ENGINE_SESSION);
  assert.equal(ledger.length, 1);
  assert.deepEqual([ledger[0].origin, ledger[0].projectId, ledger[0].state], ["gateway", project.id, "pending"], "the conversation's project comes from native_sessions, noted at its first forwarded message");
  assert.equal(await overlay.projectOfSession(userId, ENGINE_SESSION), project.id);
  assert.equal(await worker.processCommits({ userId }), 1);
  const engineUser = sessions.engineUser(userId);
  assert.equal(await sessions.read(userId, profileOf(engineUser)), "# Profile\n- 心内科主治医生，在苏州工作", "the memory is in the engine while the conversation is still open");
  assert.equal((await overlay.revisionsOf(userId, profileOf(engineUser)))[0].actor, "engine");
  assert.equal(nativeMemoryCounters().turnCommits.committed, 1);

  // The next turn's extraction fails (a rate-limited minute): the commit was made and recorded, and the existing replay owns it.
  failNext = true;
  await say("user", "我们的研究是一项随机对照试验，主要终点是大出血。");
  await say("assistant", "明白。");
  await turnEnds("run-2");
  const second = (await overlay.commitsOfSession(userId, ENGINE_SESSION)).at(-1);
  assert.equal(second.state, "pending");
  await worker.processCommits({ userId });
  assert.equal((await overlay.commit(userId, second.archiveUri)).state, "failed", "the worker read the failure marker");
  let replays = 0;
  for (let step = 0; step < 3 && !replays; step += 1) {
    await database.query("UPDATE evimed_memory.native_commits SET next_attempt_at = now() - interval '1 second' WHERE user_id=$1 AND state='failed'", [userId]);
    replays += await worker.processCommits({ userId });
  }
  assert.equal((await overlay.commit(userId, second.archiveUri)).state, "replayed");
  assert.equal(nativeMemoryCounters().workerCommits.replayed, 1);
});
