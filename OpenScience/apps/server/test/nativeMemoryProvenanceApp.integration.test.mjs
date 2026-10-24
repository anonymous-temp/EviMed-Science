// The conversation titles of a native memory's sources, through the real app: the run ledger of the project the conversation was held
// in names the conversation, a deleted conversation is dropped from the evidence, and the page serves it all on `GET /api/memory/profile`.
import assert from "node:assert/strict";
import test from "node:test";

import { nativeAppIntegration } from "./helpers/nativeAppFixture.mjs";

const { options, fixture } = nativeAppIntegration();

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
