import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { methodContentDigest, skillBodyDigest } from "@evimed/domain";
import { evaluateLearnedMethod, freezeLearningEvaluation } from "../src/learningEvaluation.mjs";
import { materializeCapsuleMethods } from "../src/capsuleMethods.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const payload = { frontmatter: { name: "m", description: "A method" }, body: "Original method body.", files: { "scripts/example.py": "print(1)" }, status: "candidate" };
payload.contentDigest = methodContentDigest(payload, sha256);
const document = { id: "method:learned:m", projectId: "source", payload };
const request = { userId: "owner", projectId: "source", methodId: document.id, candidateDigest: payload.contentDigest };

test("method evaluation freezes body, files and both digests under the original owner", async (t) => {
  const current = structuredClone(document);
  const learning = { getMethod: async (userId) => { assert.equal(userId, "owner"); return current; }, approvedMethods: async () => [] };
  const capsules = { active: async () => ({ items: [{ capsuleId: "capsule" }] }), entries: async () => ({ items: [{ id: "capsule-method", payload: { status: "approved", factKind: "method_preference", layer: "methods", content: "Quote the source." } }] }) };
  const frozen = await freezeLearningEvaluation({ learning, capsules, project: { id: "source" }, request });
  current.payload.body = "Amended while evaluating.";
  current.payload.files["scripts/example.py"] = "print(2)";
  assert.match(frozen.arms.candidate.learnedMethods[0].document, /Original method body/);
  assert.equal(frozen.arms.candidate.learnedMethods[0].files["scripts/example.py"], "print(1)");
  assert.notEqual(frozen.grant.candidateDigest, frozen.grant.mountedDigest);
  assert.deepEqual(frozen.grant.expectedMethods.baseline, [{ name: "method-capsule-method", digest: skillBodyDigest(frozen.arms.baseline.capsuleMethods[0].document, sha256) }]);
  const root = await mkdtemp(path.join(tmpdir(), "frozen-learning-mount-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "methods");
  await materializeCapsuleMethods({ capsules: null, project: { rootDir: root, userId: "owner", id: "private" }, directory, frozenMethods: frozen.arms.candidate });
  const file = path.join(directory, frozen.arms.candidate.learnedMethods[0].directoryName, "scripts/example.py");
  assert.equal(await readFile(file, "utf8"), "print(1)");
  assert.equal((await stat(file)).mode & 0o777, 0o444);
  await assert.rejects(() => freezeLearningEvaluation({ learning, capsules: null, project: { id: "other" }, request }), { code: "method_evaluation_stale" });
});

test("private cells use bounded dispatch and retain billing atomically before deleting only their own projects", async () => {
  const rows = new Map([["source", { id: "source", userId: "owner", rootDir: "/unused/source", metaDir: "/unused/source/.openscience" }]]);
  const invoices = [];
  const dispatched = [];
  const removed = [];
  const statements = [];
  const runtimeManager = {
    evaluationMethodSnapshots: new Map(), key: (project) => `${project.userId}:${project.id}`,
    stop: async () => {},
  };
  const store = {
    userById: async (id) => ({ id }),
    requireProject: async (user, id) => { const row = rows.get(id); assert.equal(row?.userId, user.id); return row; },
    createProject: async (user, id) => { rows.set(id, { id, userId: user.id, baseDir: "/unused", workspaceDir: "/unused" }); },
    deleteProject: async (user, id, { beforeDelete }) => {
      // Faithful transaction seam: callback changes and deletion roll back
      // together. Deletion still has the real schema's usage cascade.
      const prior = structuredClone(invoices);
      try {
        await beforeDelete({ query: async (sql, values) => {
          statements.push({ sql, values });
          if (sql.startsWith("SELECT id")) return { rowCount: values[1].filter((projectId) => rows.get(projectId)?.userId === values[0]).length };
          if (sql.startsWith("UPDATE")) for (const row of invoices) if (row.userId === values[0] && row.projectId === values[1]) row.projectId = values[2];
          return { rowCount: 1 };
        } });
        for (let i = invoices.length - 1; i >= 0; i -= 1) if (invoices[i].projectId === id) invoices.splice(i, 1);
        rows.delete(id); removed.push(id);
      } catch (error) { invoices.splice(0, invoices.length, ...prior); throw error; }
      assert.equal(user.id, "owner");
    },
  };
  const learning = { getMethod: async () => structuredClone(document), approvedMethods: async () => [] };
  const result = await evaluateLearnedMethod({
    config: { learningEvaluationCommand: "unused" }, store, learning, capsules: null, runtimeManager,
    agentRuns: { cancelSession: async () => {}, monitors: new Map() }, commands: {}, usageLedger: {},
    learningRuntime: { dispatch: async (input) => {
      dispatched.push(input);
      invoices.push({ userId: input.userId, projectId: input.projectId, runId: input.dispatchId, cost: 0.4 });
      return { runId: `run-${dispatched.length}`, sessionId: `session-${dispatched.length}`, dispatchId: input.dispatchId };
    } },
  }, request, { runProcess: async (_command, actual, { env }) => {
    const headers = { authorization: `Bearer ${env.OPEN_SCIENCE_EVAL_JOB_TOKEN}`, "content-type": "application/json" };
    const { data: grant } = await (await fetch(`${env.OPEN_SCIENCE_EVAL_BASE_URL}/api/evaluation/job`, { headers })).json();
    for (const arm of ["baseline", "candidate"]) {
      const response = await fetch(`${env.OPEN_SCIENCE_EVAL_BASE_URL}/api/evaluation/cells`, { method: "POST", headers,
        body: JSON.stringify({ ...grant, cellId: arm, arm, capabilityId: "clinical-evidence-synthesis", text: "Report", fixtures: [] }) });
      assert.equal(response.status, 201, await response.text());
    }
    return { verdict: "non_inferior", report: "private.json", evaluationScope: grant,
      baselineDigest: actual.baselineDigest, candidateDigest: actual.candidateDigest };
  } });
  assert.equal(result.verdict, "non_inferior");
  assert.equal(removed.length, 2);
  assert.deepEqual([...rows.keys()], ["source"]);
  assert.equal(invoices.length, 2);
  assert.equal(invoices.reduce((sum, invoice) => sum + invoice.cost, 0), 0.8);
  assert.ok(invoices.every((invoice) => invoice.projectId === "source" && invoice.userId === "owner"));
  assert.ok(dispatched.every((input) => input.isolatedProject === true && input.projectId !== "source" && input.job.userId === "owner"));
  assert.equal(new Set(dispatched.map((input) => input.projectId)).size, 2);
  assert.equal(runtimeManager.evaluationMethodSnapshots.size, 0);
  assert.equal(statements.filter((entry) => entry.sql.startsWith("UPDATE")).length, 2);
});
