import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createOwnedResearchContext } from "../src/ownedResearchContext.mjs";
import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import { fixture, registry } from "./helpers/handbookFixture.mjs";

async function setup(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-owned-context-"));
  const project = { id: "research", userId: "alice", baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir); await fs.mkdir(project.metaDir);
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  await new HandbookConsolidation({ ...f, registry }).run({ job: f.queued[0] });
  const receipts = [], audits = [];
  const runtime = { mountedMethodPromptBytes: 0 };
  const config = { learningEnabled: true, maxFileBytes: 1048576, maxProjectBytes: 16777216, maxWorkspaceScanEntries: 100, mountedMethodPromptBytes: 8000 };
  const deps = { learning: f.learning, registry: Promise.resolve(registry), config,
    runtimeManager: { key: () => "key", runtimes: new Map([["key", runtime]]) },
    agentRuns: { recordLearning: async (...args) => receipts.push(args) },
    paused: async () => ({ learning: false, trial: false }), audit: async (...args) => audits.push(args) };
  const run = { id: "next-run", effectiveAgentId: "geo-content", dispatchId: "geo:research:one" };
  try { await fn({ f, project, deps, runtime, receipts, audits, run }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("owned GEO and autonomous research consume exactly the supplement recorded before dispatch", () => setup(async ({ project, deps, receipts, run }) => {
  const prepare = createOwnedResearchContext(deps);
  for (const dispatchId of ["geo:research:one", "autopilot:research:one", "chat-one"]) {
    const result = await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, { ...run, dispatchId });
    assert.equal(result.handbooks.length, 1);
    assert.match(result.system, /Keep denominators tied/);
    assert.deepEqual(receipts.at(-1), [project, run.id, { capabilityHandbooks: result.handbooks }]);
  }
}));

test("supplements share remaining mounted-method bytes and never assume an unknown runtime is empty", () => setup(async ({ project, deps, runtime, receipts, run }) => {
  const prepare = createOwnedResearchContext(deps);
  runtime.mountedMethodPromptBytes = 7999;
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  deps.runtimeManager.runtimes.clear();
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  assert.equal(receipts.length, 0);
}));

test("paused learning, foreign owners and evaluation work get no supplement", () => setup(async ({ project, deps, run }) => {
  let prepare = createOwnedResearchContext({ ...deps, paused: async () => ({ learning: true }) });
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  prepare = createOwnedResearchContext(deps);
  assert.equal((await prepare({ ...project, userId: "bob" }, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, { ...run, learningEvaluation: {} })).handbooks.length, 0);
}));

test("supplement IO failure is audited without vetoing ordinary research", () => setup(async ({ project, deps, audits, run }) => {
  await fs.symlink(project.metaDir, path.join(project.workspaceDir, ".evimed-handbooks"));
  const result = await createOwnedResearchContext(deps)(project, { mode: "specialist", agentId: "geo-content" }, {}, run);
  assert.equal(result.handbooks.length, 0);
  assert.ok(result.system.length > 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][0], "handbook.context");
}));
