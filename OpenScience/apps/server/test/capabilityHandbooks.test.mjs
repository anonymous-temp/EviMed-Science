import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { renderMethodSkill } from "@evimed/domain";
import { MethodDistillationRuns } from "../src/methodDistillationRuns.mjs";
import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import { prepareCapabilityHandbooks } from "../src/capabilityHandbooks.mjs";
import { prepareResearchContext } from "../src/researchContext.mjs";
import { recordHandbookRunObservations } from "../src/methodObservations.mjs";
import { fixture, registry, BODY, frontmatter } from "./helpers/handbookFixture.mjs";

export const config = { maxFileBytes: 1_048_576, maxProjectBytes: 16_777_216, maxWorkspaceScanEntries: 100, mountedMethodPromptBytes: 8000 };
async function workspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-handbook-"));
  const project = { id: "next-project", userId: "alice", baseDir: root, workspaceDir: path.join(root, "workspace"), rootDir: root, metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir); await fs.mkdir(project.metaDir);
  try { await fn(project); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("consumption applies a supplement which the next authorized prepared turn carries and observes by exact digest", async () => workspace(async (project) => {
  const f = fixture();
  const distillation = new MethodDistillationRuns({ learning: f.learning, jobs: f.jobs,
    dispatch: async () => { throw new Error("No provider calls in this test"); }, readResult: async () => null });
  const lesson = await distillation.applyCandidate({ id: "distill", userId: "alice", projectId: "source-project", payload: { trigger: "repair_accepted" } },
    { id: "source-run", effectiveAgentId: "geo-content" },
    { candidate: { operation: "create", capabilityId: "meta-analysis" }, skill: renderMethodSkill(frontmatter, BODY) }, { signal: "reviewer" });
  const candidate = await f.documents.get("alice", "method", lesson.methodId);
  assert.equal(candidate.payload.capabilityId, "geo-content", "the stored source run outranks a model-invented target");
  const loop = new HandbookConsolidation({ ...f, registry });
  const applied = await loop.run({ job: f.queued[0] });
  const handbooks = await prepareCapabilityHandbooks({ learning: f.learning, registry, project, capabilityId: "geo-content", config });
  const context = await prepareResearchContext(project, { mode: "specialist" }, config, { routedSpecialist: { agentId: "geo-content" }, handbooks });
  assert.equal(context.handbooks.length, 1);
  assert.equal(context.handbooks[0].contentDigest, candidate.payload.contentDigest);
  assert.match(context.system, /Keep denominators tied/);
  assert.match(context.system, /不代表已验证质量改善/);
  assert.match(await fs.readFile(path.join(project.workspaceDir, context.handbooks[0].path), "utf8"), /## Workflow/);
  const projection = { plan: { items: [{ id: "d1", capability: "geo-content", status: "accepted" }] } };
  const run = { startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T01:00:00Z", id: "next-run", effectiveAgentId: "geo-content", status: "succeeded", sessionId: "session", capabilityHandbooks: context.handbooks };
  const sessions = [{ sessionId: "session", transcript: { messages: [{ time: Date.parse("2026-09-30T00:30:00Z"), parts: [{ type: "tool", status: "completed", tool: "read", input: { path: context.handbooks[0].path } }] }] } }];
  await recordHandbookRunObservations({ learning: f.learning, userId: "alice", run, projection, sessions });
  await recordHandbookRunObservations({ learning: f.learning, userId: "alice", run, projection, sessions });
  const row = await f.documents.get("alice", "method", applied.handbookId);
  assert.equal(row.payload.observations.length, 1);
  assert.deepEqual(row.payload.observations[0].outcomes, [{ deliverableId: "d1", outcome: "accepted" }]);
  assert.equal(row.payload.observations[0].used, true);
  assert.equal(row.payload.verification, "unmeasured", "successful use is not an improvement experiment");
  assert.equal(row.payload.source.candidateDigest, candidate.payload.contentDigest);
  assert.equal((await f.documents.history("alice", "method", applied.handbookId)).length, 1, "telemetry is not a new version");
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${BODY}\nA new revision.` }));
  await loop.run({ job: f.queued[1] });
  await recordHandbookRunObservations({ learning: f.learning, userId: "alice", run, projection, sessions });
  assert.equal((await f.documents.get("alice", "method", applied.handbookId)).payload.observations.length, 0, "old outcomes never credit new bytes");
}));

test("owner, capability, internal runs and context-byte limits are enforced again at preparation", async () => workspace(async (project) => {
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  await new HandbookConsolidation({ ...f, registry }).run({ job: f.queued[0] });
  const input = { learning: f.learning, registry, project, capabilityId: "geo-content", config };
  assert.equal((await prepareCapabilityHandbooks({ ...input, project: { ...project, userId: "bob" } })).items.length, 0);
  assert.equal((await prepareCapabilityHandbooks({ ...input, capabilityId: "meta-analysis" })).items.length, 0);
  assert.equal((await prepareCapabilityHandbooks({ ...input, internal: true })).items.length, 0);
  assert.equal((await prepareCapabilityHandbooks({ ...input, maxPromptBytes: 1 })).items.length, 0);
  const handbooks = await prepareCapabilityHandbooks(input);
  const wrong = await prepareResearchContext(project, { mode: "specialist" }, config, { routedSpecialist: { agentId: "meta-analysis" }, handbooks });
  assert.equal(wrong.handbooks.length, 0);
  const foreign = await prepareResearchContext({ ...project, userId: "bob" }, { mode: "specialist" }, config, { routedSpecialist: { agentId: "geo-content" }, handbooks });
  assert.equal(foreign.handbooks.length, 0);
}));

test("a workspace symlink cannot redirect supplement materialization", async () => workspace(async (project) => {
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  await new HandbookConsolidation({ ...f, registry }).run({ job: f.queued[0] });
  await fs.symlink(project.metaDir, path.join(project.workspaceDir, ".evimed-handbooks"));
  await assert.rejects(prepareCapabilityHandbooks({ learning: f.learning, registry, project, capabilityId: "geo-content", config }));
}));

test("old-turn reads and unrelated sessions never count as this run using a supplement", async () => workspace(async (project) => {
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  const applied = await new HandbookConsolidation({ ...f, registry }).run({ job: f.queued[0] });
  const handbooks = await prepareCapabilityHandbooks({ learning: f.learning, registry, project, capabilityId: "geo-content", config });
  const run = { id: "later", sessionId: "root", startedAt: "2026-09-30T01:00:00Z", finishedAt: "2026-09-30T02:00:00Z", effectiveAgentId: "geo-content", capabilityHandbooks: handbooks.items };
  const read = (time) => ({ ...(time ? { time: Date.parse(time) } : {}), parts: [{ type: "tool", status: "completed", tool: "read", input: { path: handbooks.items[0].path } }] });
  const sessions = [{ sessionId: "root", transcript: { messages: [read("2026-09-30T00:30:00Z"), read(null)] } },
    { sessionId: "unrelated", transcript: { messages: [read("2026-09-30T01:30:00Z")] } }];
  await recordHandbookRunObservations({ learning: f.learning, userId: "alice", run, projection: {}, sessions });
  assert.equal((await f.documents.get("alice", "method", applied.handbookId)).payload.observations[0].used, false);
  await recordHandbookRunObservations({ learning: f.learning, userId: "alice", run: { ...run, id: "current-read" }, projection: {},
    sessions: [{ sessionId: "root", transcript: { messages: [read("2026-09-30T01:30:00Z")] } }] });
  assert.equal((await f.documents.get("alice", "method", applied.handbookId)).payload.observations[1].used, true);
}));

test("concurrent terminal observations keep both runs despite a telemetry CAS conflict", async () => workspace(async (project) => {
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  const applied = await new HandbookConsolidation({ ...f, registry }).run({ job: f.queued[0] });
  const handbooks = await prepareCapabilityHandbooks({ learning: f.learning, registry, project, capabilityId: "geo-content", config });
  await Promise.all(["one", "two"].map((id) => recordHandbookRunObservations({ learning: f.learning, userId: "alice", projection: {},
    run: { id, effectiveAgentId: "geo-content", capabilityHandbooks: handbooks.items } })));
  assert.deepEqual((await f.documents.get("alice", "method", applied.handbookId)).payload.observations.map((item) => item.runId).sort(), ["one", "two"]);
}));
