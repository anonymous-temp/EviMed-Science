import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

for (const count of [1, 129, 149]) test(`${count} cold and adopted platform pins are recorded as a generation identity and a count, and survive runtime changes and ledger reload`, async () => {
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
    // The exact set is the generation's own manifest (content-addressed, immutable); the ledger carries which one and how many.
    assert.deepEqual(run.platformSkillGeneration, { generationId: original.generationId, pinCount: count });
    snapshot = { ...original, generationId: "c".repeat(64), pins: original.pins.map(pin => ({ ...pin, revision: 2 })) };
    await store.recordRuntimePersonalSkills(project, run.id);
    const current = (await store.list(project)).find(item => item.id === run.id);
    assert.deepEqual(current.platformSkillGeneration, { generationId: original.generationId, pinCount: count }, "the generation the run started with is kept");
    await store.cancelSession(project, "session");
    const second = await store.createRun(project, binding, { baselineCursor: null });
    assert.deepEqual(second.platformSkillGeneration, { generationId: snapshot.generationId, pinCount: count });
    const restarted = new AgentRunStore({}, { model: "deepseek/deepseek-v4-flash" });
    try { assert.deepEqual((await restarted.list(project)).find(item => item.id === run.id).platformSkillGeneration, { generationId: original.generationId, pinCount: count }); }
    finally { await restarted.closeAll(); }
    const ledger = await fs.readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
    assert(!ledger.includes("must never be recorded"));
    // What the ledger holds does not grow with the library: not one pin id, digest or native name.
    assert(!ledger.includes("platform-000000000000000000000001") && !ledger.includes(`${skillId}-`) && !ledger.includes(`sha256:${"b".repeat(64)}`));
    assert(ledger.length < 4096 * 2, `the ledger held ${ledger.length} bytes for ${count} pins`);
  } finally { await store.closeAll(); await fs.rm(root, { recursive: true, force: true }); }
});
