import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResearchDispatchContext } from "../src/researchDispatchContext.mjs";

async function setup(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-dispatch-context-"));
  const project = { id: "research", userId: "alice", baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir); await fs.mkdir(project.metaDir);
  const config = { learningEnabled: true, maxFileBytes: 1048576, maxProjectBytes: 16777216, maxWorkspaceScanEntries: 100, mountedMethodPromptBytes: 8000 };
  try { await fn({ project, config }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("a dispatch is handed the research context with the sources its conversation selected, read from the saved session, and no capability supplement", () => setup(async ({ project, config }) => {
  const asked = [];
  const sourceService = {
    get: async (userId, id) => { asked.push([userId, id]); return { id, projectId: project.id, payload: { status: "ready", metadata: { title: "Trial report" } }, display: { title: "Trial report" } }; },
    isShared: async () => false,
  };
  const researchSessions = { get: async (_project, sessionId) => ({ sessionId, sourceScope: ["src_1"] }) };
  const prepare = createResearchDispatchContext({ config, sourceService, researchSessions });
  const prepared = await prepare(project, { sessionId: "s1", mode: "specialist", agentId: "geo-content" }, { query: "q", specialists: [] }, { id: "run-1", effectiveAgentId: "geo-content" });
  assert.deepEqual(asked, [["alice", "src_1"]], "the selection is the saved session's, not the dispatch's copy");
  assert.match(prepared.system, /limited this conversation's knowledge base/, "the scope the session saved reaches the context");
  assert.equal("handbooks" in prepared, false, "nothing of an account's capability handbook is read any more");
  assert.equal("platformTrial" in prepared, false);
}));

test("a session with no selection and no stored session still prepares the ordinary context", () => setup(async ({ project, config }) => {
  const prepare = createResearchDispatchContext({ config });
  const prepared = await prepare(project, { sessionId: "s1", mode: "open-domain" }, {}, { id: "run-2" });
  assert.ok(prepared.system.length > 0);
  assert.doesNotMatch(prepared.system, /limited this conversation's knowledge base/);
}));
