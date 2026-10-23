// The conversation titles of a native memory's sources, through the real app: the run ledger of the project the conversation was held
// in names the conversation, a deleted conversation is dropped from the evidence, and the page serves it all on `GET /api/memory/profile`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-native-password";

async function fixture(t, extract) {
  const stub = await startOpenVikingStub(t, { extract });
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const openVikingSessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-native-prov-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, ovNativeMemoryEnabled: true, openVikingSessions,
  });
  await migrateResearchMemory(app.store.database);
  const username = `prov${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const user = await app.store.createUser(username, PASSWORD, "Provenance fixture");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  const auth = await login.json();
  const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
  return { app, base, headers, user, stub, engineUser: openVikingSessions.engineUser(user.id), sessions: openVikingSessions };
}

test("the profile names the conversations behind a native memory by the run ledger of the project they were held in", options, async (t) => {
  const { app, base, headers, user, stub, engineUser } = await fixture(t, ({ user: engine, session }) => ({
    adds: [{ uri: `viking://user/${engine}/memories/preferences/${session.replace("dsh-session_", "")}.md`, memory_type: "preferences", after: `Preference from ${session.replace("dsh-session_", "")}.` }],
  }));
  const projectId = "project-provenance";
  assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: projectId, name: "Provenance" }) })).status, 200);
  const project = await app.store.requireProject(await app.store.userById(user.id), projectId);
  // Two conversations of the project, each with a run in the ledger: one titled, one only with its question; and one the person deleted.
  const run = async (sessionId, dispatchId, question) => {
    await app.researchSessions.put(project, sessionId, { mode: "open-domain" });
    return app.agentRuns.dispatch(project, { sessionId, dispatchId, question, effectiveAgentId: null }, async () => ({ accepted: true }));
  };
  const titled = await run("session_titled", "d-titled", "三期试验的纳入标准怎么写");
  await run("session_asked", "d-asked", "把引用格式统一成 AMA");
  const deleted = await run("session_deleted", "d-deleted", "一次后来删掉的对话");
  await app.agentRuns.recordRunLabels(project, titled.id, { title: "纳入标准", titleSource: "user" });
  await app.agentRuns.recordRunLabels(project, deleted.id, { deleted: true });

  const { overlay } = app.nativeMemory;
  for (const name of ["titled", "asked", "deleted", "outside"]) {
    const engineSession = `dsh-session_${name}`;
    await overlay.noteSession(user.id, engineSession, name === "outside" ? "project-that-does-not-exist" : projectId);
    stub.sessions.set(`${engineUser}/${engineSession}`, { id: engineSession, user: engineUser, archives: 0, commitCount: 0, messages: [{ role: "user", parts: [{ type: "text", text: `About ${name}.` }] }] });
    const committed = stub.commitSession(engineUser, engineSession);
    await overlay.recordCommit({ userId: user.id, archiveUri: committed.archive_uri, engineSession, projectId: name === "outside" ? "project-that-does-not-exist" : projectId, origin: "gateway", taskId: committed.task_id });
  }
  await app.nativeMemoryWorker.processCommits({ userId: user.id });

  const page = (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  const evidenceOf = (suffix) => page.records.find((record) => record.key === `preferences/${suffix}.md`)?.evidence ?? null;
  assert.deepEqual(evidenceOf("titled").map((item) => [item.conversationId, item.projectId]), [["session_titled", projectId]]);
  assert.deepEqual(evidenceOf("deleted"), [], "the conversation the person deleted is no source to link to");
  assert.equal(evidenceOf("outside").length, 1, "a conversation whose project cannot be read is still a link back, unnamed");
  assert.deepEqual(page.conversations, { session_titled: "纳入标准", session_asked: "把引用格式统一成 AMA" });
});
