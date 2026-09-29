import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

test("the real run ledger preserves only bounded owner/capability/digest handbook receipts across learning writers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-handbook-ledger-"));
  try {
    const project = { id: "p", userId: "alice", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir); await mkdir(project.metaDir);
    const binding = { sessionId: "session", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-pro", readSessionHistory: async () => [], readSessionStatus: async () => "idle" });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "dispatch" }, async () => ({ accepted: true }));
    const receipt = { id: "method:capability-handbook:geo-content:denominator-check", ownerId: "alice", capabilityId: "geo-content", contentDigest: `sha256:${"a".repeat(64)}`, version: 1, path: `.evimed-handbooks/${"b".repeat(64)}/SKILL.md` };
    await store.recordLearning(project, run.id, { capabilityHandbooks: [{ ...receipt, body: "PRIVATE BODY" }, { ...receipt, ownerId: "bob" }, { ...receipt, path: "../secret" }] });
    await store.recordLearning(project, run.id, { mountedSkills: ["open-domain-answer"] });
    const [stored] = await store.list(project);
    assert.deepEqual(stored.capabilityHandbooks, [receipt]);
    assert.ok(!(await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8")).includes("PRIVATE BODY"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
