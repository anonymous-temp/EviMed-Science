import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService, replayEnvironment } from "../src/resultReplayService.mjs";
import { replayDigest, ResultReplayClient } from "../src/resultReplayClient.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const OWNER = "owner";
const MACHINE_VALUES = [{ key: "values.pooled_effect", value: 1.5, unit: "mean_difference_unspecified_unit", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 }];

/** The replay service on its in-memory stores, with an engine whose identity the test can change. */
async function fixture(t, { engine = {} } = {}) {
  const root = await mkdtemp("/tmp/evimed-replay-environment-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: OWNER, rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(project.workspaceDir, relative), text); };
  const documents = productDocumentsDouble();
  const results = new ResultProvenanceService({ documents, authorizeProject: async () => project, authorizeReference: async (_actor, _project, reference) => reference });
  const queue = new Map();
  const jobs = {
    async enqueue(userId, kind, payload, { projectId }) {
      const job = { id: `job_${queue.size + 1}`, userId, kind, projectId, payload, status: "queued", leaseToken: `lease_${queue.size + 1}` };
      queue.set(job.id, job); return job;
    },
    get: async (_userId, id) => queue.get(id) ?? null,
    withLease: async (_userId, _id, _leaseToken, operation) => operation(null),
    renew: async () => true,
    async finishWithLease(_userId, id, _leaseToken, _result, operation) { await operation(null); queue.get(id).status = "succeeded"; },
  };
  const capability = { available: true, method: "meta.dl", version: "1", codeDigest: "c".repeat(64), environmentDigest: "e".repeat(64) };
  const starts = [];
  const replays = new ResultReplayService({ results, documents, jobs, engine: {
    configured: () => true, capabilities: async () => ({ methods: [capability] }),
    start: async (scope, recipe) => { starts.push({ scope, recipe }); return { state: "running" }; }, ...engine } });
  /** What the replay worker does with a claimed job, the engine's output written the way the numerical adapter writes it. */
  const finish = async (replayId, { tamper = false } = {}) => {
    const job = [...queue.values()].find(item => item.payload.replayId === replayId);
    const prepared = await replays.prepare(job);
    await replays.start(job, prepared);
    const resultPath = `result-replays/${job.id}/output/result.json`;
    const output = JSON.stringify({ receipt: { recipeDigest: prepared.execution.recipeDigest }, machineValues: MACHINE_VALUES });
    await write(resultPath, output);
    const answer = { jobId: job.id, recipeDigest: prepared.execution.recipeDigest, state: "succeeded", cleanup: "confirmed", resultPath,
      artifacts: [{ path: resultPath, sha256: tamper ? sha("not the output") : sha(output), bytes: Buffer.byteLength(output) }], machineValues: MACHINE_VALUES };
    return { job, prepared, answer, complete: () => replays.complete(job, prepared, answer) };
  };
  await write("input.json", '{"studies":[]}');
  const original = async () => {
    const calculation = await replays.calculate(OWNER, project, { method: "meta.dl", inputPath: "input.json", parameters: {} }, { kind: "engine", sessionId: "native-session", callId: "call-1" });
    return (await finish(calculation.id)).complete();
  };
  return { project, documents, results, jobs, queue, replays, capability, starts, write, finish, original };
}

test("a replay on an engine that is not the original's runs, and says which digests differ", async t => {
  const f = await fixture(t);
  const calculated = await f.original();
  assert.equal((await f.replays.recipe(OWNER, calculated)).recipe.codeDigest, "c".repeat(64));
  Object.assign(f.capability, { codeDigest: "d".repeat(64), environmentDigest: "f".repeat(64) });

  const replay = await f.replays.request(OWNER, calculated.versionId, { projectId: "p", digest: calculated.digest, requestId: "again" });
  const run = await f.finish(replay.id);
  // It was prepared and started, not refused: the engine was asked to run the recipe it now has.
  assert.equal(f.starts.length, 2);
  assert.equal(run.prepared.recipe.codeDigest, "d".repeat(64));
  assert.equal(run.prepared.recipe.environmentDigest, "f".repeat(64));
  assert.equal(run.prepared.execution.recipeDigest, replayDigest(run.prepared.recipe), "the engine job is identified by the recipe it ran, not the one that was recorded");
  assert.deepEqual(run.prepared.environment, { status: "differs", changed: ["code", "environment"],
    recorded: { codeDigest: "c".repeat(64), environmentDigest: "e".repeat(64) }, current: { codeDigest: "d".repeat(64), environmentDigest: "f".repeat(64) } });

  const output = await run.complete();
  assert.equal(output.supersedesVersionId, calculated.versionId);
  // The new result names what it ran on, never the original's engine.
  assert.equal(output.code.digest, "d".repeat(64));
  assert.equal(output.environment.digest, "f".repeat(64));
  const finding = output.findings.find(item => item.id === "environment-differs");
  assert.ok(finding, "the result carries the label where it is inspected");
  assert.match(finding.message, /代码摘要 cccccccc → dddddddd/);
  assert.match(finding.message, /运行环境摘要 eeeeeeee → ffffffff/);
  assert.match(finding.message, /不能说明原环境下可以复现/);
  assert.equal((await f.replays.recipe(OWNER, output)).recipe.codeDigest, "d".repeat(64), "the new result's own recipe replays against what produced it");

  const status = await f.replays.status(OWNER, "p", replay.id);
  assert.equal(status.state, "succeeded");
  assert.equal(status.comparison.numbers.status, "identical");
  assert.equal(status.comparison.environment.status, "differs", "the numbers are compared, labelled as not from the same environment");
  assert.deepEqual(status.comparison.environment.changed, ["code", "environment"]);
  assert.equal(status.environment.status, "differs");
  // The original is untouched.
  assert.equal((await f.results.get(OWNER, "p", calculated.versionId)).code.digest, "c".repeat(64));
});

test("only the part that moved is named, and a replay on the same engine carries no environment finding", async t => {
  const f = await fixture(t);
  const calculated = await f.original();
  const same = await f.finish((await f.replays.request(OWNER, calculated.versionId, { projectId: "p", digest: calculated.digest, requestId: "same" })).id);
  const unchanged = await same.complete();
  assert.equal(same.prepared.environment.status, "same");
  assert.deepEqual(same.prepared.environment.changed, []);
  assert.equal(unchanged.findings.some(item => item.id === "environment-differs"), false);
  assert.equal(unchanged.code.digest, "c".repeat(64));

  f.capability.environmentDigest = "9".repeat(64);
  const partly = await f.finish((await f.replays.request(OWNER, calculated.versionId, { projectId: "p", digest: calculated.digest, requestId: "partly" })).id);
  const output = await partly.complete();
  assert.deepEqual(partly.prepared.environment.changed, ["environment"]);
  assert.equal(output.code.digest, "c".repeat(64), "the code did not move, so its record is the original's");
  assert.equal(output.environment.digest, "9".repeat(64));
  const message = output.findings.find(item => item.id === "environment-differs").message;
  assert.match(message, /运行环境摘要 eeeeeeee → 99999999/);
  assert.doesNotMatch(message, /代码摘要/);
  assert.deepEqual(replayEnvironment({ codeDigest: "a", environmentDigest: "b" }, { codeDigest: "a", environmentDigest: "b" }).changed, []);
});

test("a job that has started joins the identity it started under even if the engine is replaced before its recovery", async t => {
  const f = await fixture(t);
  const calculated = await f.original();
  Object.assign(f.capability, { codeDigest: "d".repeat(64) });
  const replay = await f.replays.request(OWNER, calculated.versionId, { projectId: "p", digest: calculated.digest, requestId: "recover" });
  const job = [...f.queue.values()].find(item => item.payload.replayId === replay.id);
  const prepared = await f.replays.prepare(job);
  await f.replays.start(job, prepared);
  // The engine is replaced again while the job is in flight; the control plane restarts and prepares the same job.
  Object.assign(f.capability, { codeDigest: "1".repeat(64), environmentDigest: "2".repeat(64) });
  const recovered = await f.replays.prepare(job);
  assert.deepEqual(recovered.execution, prepared.execution);
  assert.deepEqual(recovered.environment, prepared.environment);
  assert.equal(recovered.recipe.codeDigest, "d".repeat(64));
  // A partial capture after a stop is bound to what the job ran on too.
  const row = await f.documents.get(OWNER, "result-replay", replay.id);
  assert.equal((await f.replays.preparedForRecord(row)).recipe.codeDigest, "d".repeat(64));
});

test("what is still refused says plainly what is missing", async t => {
  // A recipe that was never captured.
  const f = await fixture(t);
  await f.write("report.md", "A result nobody calculated.");
  const plain = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "report.md", expectedDigest: sha("A result nobody calculated."),
    producer: { kind: "tool", sessionId: "s", runId: "r", callId: "c" } });
  await assert.rejects(f.replays.request(OWNER, plain.versionId, { projectId: "p", digest: plain.digest, requestId: "none" }),
    error => error.code === "result_recipe_unavailable" && /no recorded calculation recipe/.test(error.message) && /method, input and parameters/.test(error.message));

  // An engine that is not deployed, told apart from a result that has no recipe.
  const calculated = await f.original();
  const undeployed = new ResultReplayService({ results: f.results, documents: f.documents, jobs: f.jobs, engine: { configured: () => false } });
  await assert.rejects(undeployed.request(OWNER, calculated.versionId, { projectId: "p", digest: calculated.digest, requestId: "off" }),
    error => error.code === "result_engine_unavailable" && error.status === 503 && /meta\.dl is not deployed/.test(error.message));
  assert.deepEqual((await undeployed.eligibility(OWNER, await f.results.get(OWNER, "p", calculated.versionId))).replay, { status: "unavailable", reasons: ["engine_unavailable"] });
  assert.deepEqual((await f.replays.eligibility(OWNER, plain)).replay, { status: "unavailable", reasons: ["no_owned_deterministic_recipe"] });

  // An engine that is there and does not offer the method, or does not say what it is.
  const replay = await f.replays.request(OWNER, calculated.versionId, { projectId: "p", digest: calculated.digest, requestId: "silent" });
  const job = [...f.queue.values()].find(item => item.payload.replayId === replay.id);
  const original = f.capability.environmentDigest;
  f.capability.environmentDigest = undefined;
  await assert.rejects(f.replays.prepare(job), error => error.code === "result_engine_unavailable" && /did not report its code and environment identity/.test(error.message));
  f.capability.environmentDigest = original;

  // Output bytes that do not match the engine's own record: nothing is saved.
  const forged = await f.finish(replay.id, { tamper: true });
  await assert.rejects(forged.complete(), error => error.code === "result_replay_receipt_invalid" && /does not match the byte record the engine returned/.test(error.message));
  assert.equal((await f.results.list(OWNER, { projectId: "p", path: forged.answer.resultPath })).items.length, 0);
  // An engine answer that is not a finished calculation.
  await assert.rejects(f.replays.complete(forged.job, forged.prepared, { ...forged.answer, state: "running" }),
    error => error.code === "result_replay_receipt_invalid" && /not a finished calculation/.test(error.message));
});

test("a refusal by the engine says why, from the engine's own closed list and nothing it merely wrote", async () => {
  const config = { resultEngineUrl: "http://engine:8031", evimedWorkloadSigningSecret: "test-only-".repeat(8), resultEngineRequestTimeoutMs: 200 };
  const scope = { userId: "user", projectId: "project", jobId: "c40e90ce-caa7-46af-90e2-61b581e23c30", recipeDigest: "a".repeat(64), method: "meta.dl" };
  const answering = body => new ResultReplayClient({ config, fetchImpl: async () => new Response(body, { status: 401 }) });
  await assert.rejects(answering(JSON.stringify({ detail: "replay_job_token_required" })).status(scope),
    error => error.code === "result_engine_rejected" && /replay_job_token_required/.test(error.message) && /job token/.test(error.message) && /workload secret/.test(error.message));
  await assert.rejects(answering(JSON.stringify({ detail: "replay_recipe_not_owned" })).status(scope), error => /not the one the job token was issued for/.test(error.message));
  for (const body of [JSON.stringify({ detail: "an upstream stack trace with a credential" }), "plain text credential", "x".repeat(10_000), JSON.stringify({ detail: { nested: true } })]) {
    await assert.rejects(answering(body).status(scope), error => error.code === "result_engine_rejected" && /HTTP 401/.test(error.message) && !/credential|stack|nested|xxxx/.test(error.message));
  }
  await assert.rejects(new ResultReplayClient({ config: {} }).status(scope), error => error.code === "result_replay_unavailable" && /not deployed/.test(error.message));
});
