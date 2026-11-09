import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

// Published-tool serving is gone (2026-11-09) and no run records a platform generation any more, but a ledger written
// before still holds `platformSkillGeneration` on its rows: it must read, and the field is simply no longer carried.
test("a ledger row that still carries a platform generation reads and lists its run", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-legacy-platform-")));
  const project = { userId: "owner", id: "project", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  const binding = { sessionId: "session", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", monitorIntervalMs: 60000 });
  store.scheduleMonitor = () => {};
  try {
    await fs.mkdir(project.workspaceDir, { recursive: true });
    await fs.mkdir(project.metaDir, { recursive: true });
    const run = await store.dispatch(project, { sessionId: "session", dispatchId: "first" }, async () => ({ accepted: true }));
    await store.closeAll();
    const file = path.join(project.metaDir, "runs.jsonl");
    const legacy = { generationId: "a".repeat(64), pinCount: 3 };
    const rows = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.type === "run.created" || row.runId === run.id || row.id === run.id), "the ledger row the test marks exists");
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row.type === "run.created" || row.runId === run.id || row.id === run.id ? { ...row, platformSkillGeneration: legacy } : row)).join("\n") + "\n");
    const restarted = new AgentRunStore({}, { model: "deepseek/deepseek-v4-flash" });
    try {
      const read = (await restarted.list(project)).find((item) => item.id === run.id);
      assert.ok(read, "the run still lists");
      assert.equal(read.platformSkillGeneration, undefined);
    } finally { await restarted.closeAll(); }
  } finally { await store.closeAll(); await fs.rm(root, { recursive: true, force: true }); }
});
