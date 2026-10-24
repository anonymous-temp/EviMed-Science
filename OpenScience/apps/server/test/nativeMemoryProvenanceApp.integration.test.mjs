// The conversation titles of a native memory's sources, through the real app: the run ledger of the project the conversation was held
// in names the conversation, a deleted conversation is dropped from the evidence, and the page serves it all on `GET /api/memory/profile`.
import assert from "node:assert/strict";
import test from "node:test";

import { nativeAppIntegration } from "./helpers/nativeAppFixture.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoSharedContext } from "../src/geoSharedContext.mjs";
import { GeoNativeMemoryContext } from "../src/geoNativeMemoryContext.mjs";
import { nativeConversationTitleKey } from "../src/nativeMemoryStore.mjs";

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
  assert.deepEqual(page.conversations, { session_titled: "纳入标准", session_asked: "把引用格式统一成 AMA",
    [nativeConversationTitleKey({ projectId, sessionId: 'session_titled' })]: "纳入标准",
    [nativeConversationTitleKey({ projectId, sessionId: 'session_asked' })]: "把引用格式统一成 AMA" });
});

test('historical native provenance never resolves an equal session id against a replacement project incarnation', options, async t => {
  const { app, user, sessions, stub } = await fixture(t);
  const owner = await app.store.userById(user.id), projectId = 'recreated-provenance';
  await app.store.createProject(owner, projectId, 'Original');
  const project = await app.store.requireProject(owner, projectId), database = app.store.database;
  const geo = new GeoStore({ database }); await geo.ready();
  await geo.createProject({ userId: user.id, projectId, engines: ['deepseek'], coverageDays: 30 });
  const documents = new ProductDocuments(database), policies = new GeoSharedContext({ database, documents });
  const contexts = new GeoNativeMemoryContext({ database, documents, policies, sessions });
  const original = await contexts.forProject(project);
  app.nativeMemory.memoryContexts = contexts;
  const seed = async (context, text) => {
    const uri = stub.seedMemory(context.namespaceId, 'project_facts/source.md', text);
    await app.nativeMemory.overlay.addRevision({ userId: user.id, uri, memoryType: 'project_facts', actor: 'engine', change: 'added', before: null, after: text,
      engineSession: 'dsh-shared', projectId, archiveUri: `${context.userRoot}/sessions/dsh-shared/history/archive_001` });
    return uri;
  };
  const oldUri = await seed(original, 'Historical source');
  await database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [user.id, projectId]);
  const current = await contexts.forProject(project);
  assert.notEqual(current.namespaceId, original.namespaceId);
  await app.researchSessions.put(project, 'shared', { mode: 'open-domain' });
  const run = await app.agentRuns.dispatch(project, { sessionId: 'shared', dispatchId: 'replacement-title', automated: true,
    question: 'A new project conversation', effectiveAgentId: null }, async () => ({ accepted: true }));
  await app.agentRuns.recordRunLabels(project, run.id, { title: 'Replacement title', titleSource: 'user' });
  const lookup = app.agentRuns.conversationIndex.bind(app.agentRuns), reads = [];
  app.agentRuns.conversationIndex = async target => { reads.push(target.id); return lookup(target); };
  const old = await app.nativeMemory.profile(user.id);
  assert.equal(old.records.find(record => record.uri === oldUri).evidenceCount, 1, 'historical evidence remains as an unnamed source');
  assert.deepEqual(old.conversations, {}); assert.deepEqual(reads, [], 'a mismatched incarnation does not read the replacement ledger');
  const newUri = await seed(current, 'Current source');
  const page = await app.nativeMemory.profile(user.id);
  const historical = page.records.find(record => record.uri === oldUri).evidence[0], source = page.records.find(record => record.uri === newUri).evidence[0];
  assert.notEqual(historical.conversationTitleKey, source.conversationTitleKey);
  assert.equal(page.conversations[historical.conversationTitleKey], undefined);
  assert.equal(page.conversations[source.conversationTitleKey], 'Replacement title');
  assert.equal(page.conversations.shared, undefined);
});

test('the real title resolver qualifies equal sessions from two registered projects and deletes only the named source', options, async t => {
  const { app, user, sessions, stub } = await fixture(t), owner = await app.store.userById(user.id), database = app.store.database;
  const geo = new GeoStore({ database }); await geo.ready();
  const documents = new ProductDocuments(database), policies = new GeoSharedContext({ database, documents });
  const contexts = new GeoNativeMemoryContext({ database, documents, policies, sessions });
  app.nativeMemory.memoryContexts = contexts;
  const sources = [];
  for (const projectId of ['title-a', 'title-b']) {
    await app.store.createProject(owner, projectId, projectId);
    const project = await app.store.requireProject(owner, projectId);
    await geo.createProject({ userId: user.id, projectId, engines: ['deepseek'], coverageDays: 30 });
    const context = await contexts.forProject(project);
    await app.researchSessions.put(project, 'shared', { mode: 'open-domain' });
    const run = await app.agentRuns.dispatch(project, { sessionId: 'shared', dispatchId: `dispatch-${projectId}`, automated: true,
      question: projectId, effectiveAgentId: null }, async () => ({ accepted: true }));
    await app.agentRuns.recordRunLabels(project, run.id, { title: `Title ${projectId}`, titleSource: 'user' });
    const uri = stub.seedMemory(context.namespaceId, 'project_facts/source.md', projectId);
    await app.nativeMemory.overlay.addRevision({ userId: user.id, uri, memoryType: 'project_facts', actor: 'engine', change: 'added', before: null, after: projectId,
      engineSession: 'dsh-shared', projectId, archiveUri: `${context.userRoot}/sessions/dsh-shared/history/archive_001` });
    sources.push({ project, run, uri });
  }
  const page = await app.nativeMemory.profile(user.id);
  for (const { project, uri } of sources) {
    const source = page.records.find(record => record.uri === uri).evidence[0];
    assert.equal(source.projectId, project.id);
    assert.equal(page.conversations[source.conversationTitleKey], `Title ${project.id}`);
  }
  assert.equal(page.conversations.shared, undefined);
  await app.agentRuns.recordRunLabels(sources[1].project, sources[1].run.id, { deleted: true });
  app.nativeMemory.now = () => new Date(Date.now() + 61_000);
  const found = await app.nativeMemory.search(user.id, '');
  assert.equal(found.items.find(record => record.uri === sources[0].uri).evidenceCount, 1);
  assert.equal(found.items.find(record => record.uri === sources[1].uri).evidenceCount, 0);
  const source = found.items.find(record => record.uri === sources[0].uri).evidence[0];
  assert.equal(found.conversations[source.conversationTitleKey], 'Title title-a');
});
