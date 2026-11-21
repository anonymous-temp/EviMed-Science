import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

test("cold and adopted runs retain exact personal pins through later runtime changes and ledger reload", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-personal-provenance-")));
  const project = { userId: "owner", id: "project", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  const skillId = `skill:${randomUUID()}`;
  const original = { generationId: "a".repeat(64), platformSkills: { disabled: ['office:docx'], disabledPlugins: ['annotation'] }, pins: [{ skillId, revision: 1, digest: `sha256:${"b".repeat(64)}`, nativeName: "personal-owner-method", source: "personal", instructions: "must never be recorded" }] };
  let snapshot = null;
  const binding = { sessionId: "session", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", runtimePersonalSkills: () => snapshot, monitorIntervalMs: 60000 });
  store.scheduleMonitor = () => {};
  try {
    await fs.mkdir(project.workspaceDir, { recursive: true });
    await fs.mkdir(project.metaDir, { recursive: true });
    const run = await store.dispatch(project, { sessionId: "session", dispatchId: "first" }, async () => { snapshot = original; return { accepted: true }; });
    assert.equal(run.personalSkillGeneration.generationId, original.generationId);
    assert.deepEqual(run.personalSkillGeneration.platformSkills, original.platformSkills);
    snapshot = { ...original, platformSkills: { disabled: [], disabledPlugins: [] }, generationId: "c".repeat(64), pins: [{ ...original.pins[0], revision: 2 }] };
    await store.recordRuntimePersonalSkills(project, run.id);
    const current = (await store.list(project)).find(item => item.id === run.id);
    assert.equal(current.personalSkillGeneration.pins[0].revision, 1);
    assert.deepEqual(current.personalSkillGeneration.platformSkills, { disabled: ['office:docx'], disabledPlugins: ['annotation'] });
    assert(!JSON.stringify(current.personalSkillGeneration).includes("instructions"));
    await store.cancelSession(project, "session");
    const second = await store.createRun(project, binding, { baselineCursor: null });
    assert.equal(second.personalSkillGeneration.generationId, snapshot.generationId);
    const restarted = new AgentRunStore({}, { model: "deepseek/deepseek-v4-flash" });
    try { assert.equal((await restarted.list(project)).find(item => item.id === run.id).personalSkillGeneration.pins[0].revision, 1); }
    finally { await restarted.closeAll(); }
    const ledger = await fs.readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
    assert(!ledger.includes("must never be recorded"));
  } finally { await store.closeAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test("accepted and adopted turns persist only their own offered methods across a restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "method-receipt-"));
  const project = { userId: "owner", id: "project", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(project.workspaceDir);
  await fs.mkdir(project.metaDir);
  const binding = { sessionId: "session", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const receipt = { name: "official-reference", digest: "sha256:" + "e".repeat(64), reason: "similarity" };
  const mounted = [{ ...receipt, body: "transient-method-body" }];
  const offeredAt = Date.now() - 1000;
  let sent = false;
  const options = { model: "deepseek/deepseek-v4-flash", runtimeMethodReceipt: (_project, sessionId, startedAt) =>
    sent && sessionId === binding.sessionId && (!startedAt || Date.parse(startedAt) >= offeredAt) ? mounted : null };
  const store = new AgentRunStore({ get: async () => binding }, options);
  store.scheduleMonitor = () => {};
  t.after(() => store.closeAll());
  const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "cold" }, async () => { sent = true; return { accepted: true }; });
  assert.deepEqual(run.methodsLoaded, [receipt]);
  await store.cancelSession(project, binding.sessionId);
  const adopted = (await store.reserveRun(project, binding, { nativeTurn: { startSeq: 10, userSeq: 11 }, startedAt: new Date().toISOString() })).run;
  assert.deepEqual(adopted.methodsLoaded, [receipt]);
  await store.cancelSession(project, binding.sessionId);
  const older = (await store.reserveRun(project, binding, { nativeTurn: { startSeq: 1, userSeq: 2 }, startedAt: new Date(offeredAt - 1000).toISOString() })).run;
  assert.equal(older.methodsLoaded, undefined);
  const restarted = new AgentRunStore({}, { model: options.model });
  t.after(() => restarted.closeAll());
  assert.deepEqual((await restarted.list(project)).find(item => item.id === run.id).methodsLoaded, [receipt]);
  assert.ok(!(await fs.readFile(path.join(project.metaDir, "runs.jsonl"), "utf8")).includes("transient-method-body"));
});
