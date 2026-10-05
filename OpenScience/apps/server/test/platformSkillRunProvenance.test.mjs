import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

for (const count of [1, 129, 149]) test(`${count} cold and adopted platform pins survive runtime changes and ledger reload`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-platform-provenance-")));
  const project = { userId: "owner", id: "project", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  const skillId = "new-tool";
  const original = { generationId: "a".repeat(64), pins: [{ id: skillId, publicationKind: "isolated-tool", revision: 1, digest: `sha256:${"b".repeat(64)}`, nativeName: "platform-" + "d".repeat(24), source: "platform", instructions: "must never be recorded" }] };
  original.pins = Array.from({ length: count }, (_, index) => ({ ...original.pins[0], id: `${skillId}-${index}`, nativeName: `platform-${index.toString(16).padStart(24, "0")}` }));
  let snapshot = null;
  const binding = { sessionId: "session", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", runtimePlatformSkills: () => snapshot, monitorIntervalMs: 60000 });
  store.scheduleMonitor = () => {};
  try {
    await fs.mkdir(project.workspaceDir, { recursive: true });
    await fs.mkdir(project.metaDir, { recursive: true });
    const run = await store.dispatch(project, { sessionId: "session", dispatchId: "first" }, async () => { snapshot = original; return { accepted: true }; });
    assert.equal(run.platformSkillGeneration.generationId, original.generationId);
    assert.equal(run.platformSkillGeneration.pins.length, count);
    snapshot = { ...original, generationId: "c".repeat(64), pins: original.pins.map(pin => ({ ...pin, revision: 2 })) };
    await store.recordRuntimePersonalSkills(project, run.id);
    const current = (await store.list(project)).find(item => item.id === run.id);
    assert.equal(current.platformSkillGeneration.pins[0].revision, 1);
    assert(!JSON.stringify(current.platformSkillGeneration).includes("instructions"));
    await store.cancelSession(project, "session");
    const second = await store.createRun(project, binding, { baselineCursor: null });
    assert.equal(second.platformSkillGeneration.generationId, snapshot.generationId);
    const restarted = new AgentRunStore({}, { model: "deepseek/deepseek-v4-flash" });
    try { assert.deepEqual((await restarted.list(project)).find(item => item.id === run.id).platformSkillGeneration.pins, original.pins.map(({ instructions: _instructions, ...pin }) => pin)); }
    finally { await restarted.closeAll(); }
    const ledger = await fs.readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
    assert(!ledger.includes("must never be recorded"));
  } finally { await store.closeAll(); await fs.rm(root, { recursive: true, force: true }); }
});
