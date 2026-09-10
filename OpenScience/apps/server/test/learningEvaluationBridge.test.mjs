import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLearningEvaluationBridge } from "../src/learningEvaluationBridge.mjs";
import { runLearningEvaluationProcess } from "../src/learningEvaluationProcess.mjs";

const grant = { userId: "owner-a", projectId: "source-a", methodId: "method:learned:test", candidateDigest: "sha256:content", mountedDigest: "sha256:mounted", snapshotDigest: "sha256:snapshot" };

test("private evaluation grant isolates owner, cells and digests and returns real API envelopes", async (t) => {
  const created = [];
  const cleaned = [];
  let now = 1000;
  const bridge = await startLearningEvaluationBridge({
    grant, now: () => now, ttlMs: 1000, maxCells: 2,
    createCell: async (input) => {
      created.push(input);
      return { projectId: `private-${created.length}`, runId: `run-${created.length}`, sessionId: `session-${created.length}` };
    },
    readCell: async (cell) => ({ id: cell.runId, status: "succeeded" }),
    readArtifact: async () => ({ encoding: "utf8", data: "report" }),
    readTranscript: async () => ({ messages: [] }),
    readUsage: async () => ({ cost: 0.25, calls: 1 }),
    cleanupCell: async (cell) => { cleaned.push(cell.projectId); },
  });
  t.after(() => bridge.close());
  const request = (route, method = "GET", body, extra = {}) => fetch(`${bridge.url}${route}`, {
    method, headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await request("/api/evaluation/job", "GET", null, { authorization: "Bearer wrong" })).status, 401);
  assert.deepEqual((await (await request("/api/evaluation/job")).json()).data.userId, "owner-a");
  const body = { ...grant, cellId: "brief-baseline-1", arm: "baseline", capabilityId: "clinical-evidence-synthesis", text: "Write a report.", fixtures: [] };
  assert.equal((await request("/api/evaluation/cells", "POST", { ...body, userId: "owner-b" })).status, 403);
  assert.equal((await request("/api/evaluation/cells", "POST", { ...body, candidateDigest: "other" })).status, 403);
  const response = await request("/api/evaluation/cells", "POST", body);
  assert.equal(response.status, 201);
  const cell = (await response.json()).data;
  const scope = { "x-open-science-project": cell.projectId };
  assert.deepEqual((await (await request(`/api/runs/${cell.runId}/usage`, "GET", null, scope)).json()).data, { cost: 0.25, calls: 1 });
  assert.equal((await request(`/api/runs/${cell.runId}/usage`, "GET", null, { "x-open-science-project": "source-a" })).status, 403);
  assert.equal((await request("/api/account/export", "GET", null, scope)).status, 404);
  now = 2001;
  assert.equal((await request("/api/evaluation/job")).status, 401);
  await bridge.close();
  assert.deepEqual(cleaned, [cell.projectId]);
  assert.equal(created[0].userId, "owner-a");
});

test("the real Python CLI consumes a private owner grant and measures isolated frozen cells", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "learning-private-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const briefs = [1, 2, 3].map((number) => ({ id: `family-${number}`, title: `Brief ${number}`, family: `family-${number}`, inputs: { question: "Write a report." }, mustDo: ["deliver"], mustNotDo: ["invent"] }));
  await writeFile(path.join(root, "briefs.json"), JSON.stringify(briefs));
  await writeFile(path.join(root, "splits.json"), JSON.stringify({ schemaVersion: 1, dev: { briefs: briefs.map((brief) => brief.id) }, holdout: { briefs: [] }, regression: { briefs: [] }, chronological: { briefs: [] } }));
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    id: "private", capability: "clinical-evidence-synthesis", briefsFile: path.join(root, "briefs.json"), briefs: briefs.map((brief) => brief.id),
    repeats: 1, seed: 1, concurrency: 2, margin: 0.02, bootstrapSamples: 50,
    timeoutMinutes: 1, pollSeconds: 0, budget: { costCap: 1, latencyCapMs: 60000 },
    baseline: { methodSnapshot: { id: "baseline", records: [] }, compactionPolicy: "basic" },
  }));
  const privateGrant = { ...grant, baselineDigest: "sha256:baseline", expectedMethods: { baseline: [], candidate: [{ name: "m", digest: grant.mountedDigest }] } };
  const seen = [];
  const cleaned = [];
  const bridge = await startLearningEvaluationBridge({
    grant: privateGrant, maxCells: 6,
    createCell: async (input) => {
      const n = seen.length + 1;
      seen.push(input);
      return { projectId: `private-${n}`, runId: `run-${n}`, sessionId: `session-${n}`, arm: input.arm };
    },
    readCell: async (cell) => ({ id: cell.runId, status: "succeeded", durationMs: 100, artifacts: ["report.md"],
      methodsLoaded: privateGrant.expectedMethods[cell.arm], methodsInvoked: [], transcript: { completeness: "complete" } }),
    readArtifact: async () => ({ encoding: "utf8", data: "An evidence report." }),
    readTranscript: async () => ({ messages: [] }), readUsage: async () => ({ cost: 0.25, calls: 1 }),
    cleanupCell: async (cell) => { cleaned.push(cell.projectId); },
  });
  t.after(() => bridge.close());
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = await runLearningEvaluationProcess(`python3 ${repo}/evals/method-quality/run_paired.py --template ${root}/config.json --splits ${root}/splits.json --results-dir ${root}/results --reports-dir ${root}/reports`, privateGrant, {
    timeoutMs: 20000, env: { OPEN_SCIENCE_EVAL_JOB_TOKEN: bridge.token, OPEN_SCIENCE_EVAL_BASE_URL: bridge.url },
  });
  assert.equal(result.evaluationScope.userId, "owner-a");
  assert.equal(result.evaluationScope.snapshotDigest, grant.snapshotDigest);
  assert.equal(seen.length, 6);
  assert.equal(new Set(cleaned).size, 6);
  assert.ok(seen.every((cell) => cell.userId === "owner-a" && cell.projectId === "source-a"));
  const report = JSON.parse(await readFile(result.report, "utf8"));
  assert.equal(report.armsVerified.candidate.cellsVerified, 3);
  assert.equal(report.armsVerified.baseline.cellsVerified, 3);
  assert.equal(report.cost.candidate.total, 0.75);
  assert.equal(report.cells.excluded.length, 0);
});

test("evaluation subprocesses enforce timeout, total output and explicit cancellation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "learning-process-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const waiting = path.join(root, "waiting.mjs");
  const noisy = path.join(root, "noisy.mjs");
  await writeFile(waiting, "setInterval(() => {}, 1000);\n");
  await writeFile(noisy, "setInterval(() => process.stdout.write('x'.repeat(65536)), 1);\n");
  await assert.rejects(() => runLearningEvaluationProcess(`node ${waiting}`, grant, { timeoutMs: 40 }), { code: "method_evaluation_timeout" });
  await assert.rejects(() => runLearningEvaluationProcess(`node ${noisy}`, grant, { timeoutMs: 5000 }), { code: "method_evaluation_output_limit" });
  const controller = new AbortController();
  const cleaned = [];
  const bridge = await startLearningEvaluationBridge({
    grant, createCell: async () => ({ projectId: "cancelled-private", runId: "r", sessionId: "s" }),
    readCell: async () => ({}), readArtifact: async () => ({}), readTranscript: async () => ({}), readUsage: async () => ({}),
    cleanupCell: async (cell) => { cleaned.push(cell.projectId); },
  });
  t.after(() => bridge.close());
  const created = await fetch(`${bridge.url}/api/evaluation/cells`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...grant, cellId: "cancelled", arm: "candidate", capabilityId: "clinical-evidence-synthesis", text: "Report", fixtures: [] }),
  });
  assert.equal(created.status, 201);
  const running = runLearningEvaluationProcess(`node ${waiting}`, grant, { timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => running, { code: "method_evaluation_cancelled" });
  await bridge.close();
  assert.deepEqual(cleaned, ["cancelled-private"]);
});

test("evaluation timeout kills descendants holding inherited output pipes", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evaluation-descendant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = path.join(root, "wrapper.cjs");
  await writeFile(wrapper, "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}); setInterval(() => {}, 1000);\n");
  const started = Date.now();
  await assert.rejects(() => runLearningEvaluationProcess(`node ${wrapper}`, { methodId: "method:test", candidateDigest: "digest" }, { timeoutMs: 150 }),
    { code: "method_evaluation_timeout" });
  assert.ok(Date.now() - started < 1500, "pipe descendants must not keep the evaluation pending");
});
