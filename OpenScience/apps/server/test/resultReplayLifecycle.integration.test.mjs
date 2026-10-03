import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService } from "../src/resultReplayService.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";
import { ResultReplayClient } from "../src/resultReplayClient.mjs";
import { ResultReplayWorker } from "../src/resultReplayWorker.mjs";
import { createResultGateway } from "../src/resultGateway.mjs";
import { createResultReplayRoutes } from "../src/resultReplayRoutes.mjs";
import { HttpError } from "../src/security.mjs";
import { heavyWorkAdmission, heavyWorkBlockerCount } from "../src/heavyWorkAdmission.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
if (process.env.VCR_ENGINE_TESTS === "required") {
  assert.ok(databaseUrl, "required replay integration needs PostgreSQL");
  assert.equal(process.env.OPEN_SCIENCE_TEST_RESULT_ENGINES, "1", "required replay integration must run every Python recipe");
  assert.ok(process.env.VCR_R_LIBS, "required replay integration needs the locked R library");
  assert.equal(process.env.EVIMED_RESULT_REPLAY_SIGNED_VCR, "1", "required replay integration must verify genuine signed R HTTP receipts");
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 30000 };
const sha = value => createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function recordNumericalEvidence(method, original, rerun, receipt = null) {
  const directory = process.env.EVIMED_RESULT_REPLAY_EVIDENCE_DIR;
  if (!directory) return;
  const { mkdir } = await import("node:fs/promises"); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${method}.result.json`), original.bytes);
  await writeFile(path.join(directory, `${method}.evidence.json`), JSON.stringify({ method, versionId: original.version.versionId,
    digest: original.version.digest, machineValues: original.version.machineValues, comparison: rerun.comparison, receipt,
    originalRetained: true, scientificApplicability: "not_assessed" }, null, 2));
}

export async function replayFixture(t, engineOverride = null) {
  const isolated = await createGeoTestDatabase(databaseUrl, "rpl");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-lifecycle-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true,
    maxProjectBytes: 32 * 1024 * 1024 });
  const store = new PostgresStore(config);
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await store.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await store.devUser(); const project = await store.requireProject(user, "default");
  const documents = new ProductDocuments(store.database); const jobs = new ProductJobs(store.database);
  const results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => { assert.equal(actor, user.id); return store.requireProject(await store.userById(actor), id); },
    authorizeReference: async (_actor, _project, ref) => ref });
  let starts = 0; let cancels = 0;
  const executions = new Map();
  const capability = { available: true, method: "meta.dl", version: "1", codeDigest: "c".repeat(64), environmentDigest: "e".repeat(64) };
  const engine = engineOverride ?? {
    configured: () => true, capabilities: async () => ({ methods: [capability] }),
    start: async scope => { starts++; executions.set(scope.jobId, scope); return { state: "running" }; },
    cancel: async scope => { cancels++; executions.delete(scope.jobId); return { jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "canceled", cleanup: "confirmed" }; },
  };
  const service = new ResultReplayService({ results, documents, jobs, engine, config });
  const calculate = async (callId = "native-call") => {
    await writeFile(path.join(project.workspaceDir, "input.json"), '{"studies":[]}');
    return service.calculate(user.id, project, { method: "meta.dl", inputPath: "input.json", parameters: {} },
      { kind: "engine", sessionId: "native-session", callId });
  };
  const claim = () => jobs.claim(["result-replay"], "lifecycle-fixture", { leaseMs: 60000 });
  return { isolated, dataDir, config, store, user, project, documents, jobs, results, service, engine, capability, cleanup,
    calculate, claim, get starts() { return starts; }, get cancels() { return cancels; } };
}

test("a queued or prepared calculation canceled before launch cannot be launched by its old lease", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job);
  assert.equal((await f.service.cancel(f.user.id, f.project.id, initial.id)).state, "canceled");
  await assert.rejects(f.service.start(job, prepared), { code: "product_job_lease_lost" });
  assert.equal(f.starts, 0); assert.equal(f.cancels, 0);
});

test("cancel waits for preparation's parent lock then prevents its later launch", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const entered = deferred(); const release = deferred();
  f.engine.capabilities = async () => { entered.resolve(); await release.promise; return { methods: [f.capability] }; };
  const preparing = f.service.prepare(job); await entered.promise;
  let canceled = false;
  const cancellation = f.service.cancel(f.user.id, f.project.id, initial.id).then(answer => { canceled = true; return answer; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(canceled, false);
  release.resolve(); const prepared = await preparing; await cancellation;
  await assert.rejects(f.service.start(job, prepared), { code: "product_job_lease_lost" });
  assert.equal(f.starts, 0);
});

test("cancel during admission reloads the persisted execution and joins before changing durable state", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job); const entered = deferred(); const release = deferred();
  f.engine.start = async () => { entered.resolve(); await release.promise; return { state: "running" }; };
  const starting = f.service.start(job, prepared); await entered.promise;
  const cancellation = f.service.cancel(f.user.id, f.project.id, initial.id);
  assert.equal((await f.jobs.get(f.user.id, job.id)).status, "running");
  release.resolve(); await starting; const answer = await cancellation;
  assert.equal(answer.state, "canceled"); assert.equal(answer.cleanup, "confirmed"); assert.equal(f.cancels, 1);
});

test("lost start response keeps the admitted identity and unknown ownership preserves active durable state", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job);
  f.engine.start = async () => { throw new HttpError(504, "result_engine_timeout", "fixture response lost"); };
  await assert.rejects(f.service.start(job, prepared), { code: "result_engine_timeout" });
  assert.deepEqual((await f.documents.get(f.user.id, "result-replay", initial.id)).payload.execution, prepared.execution);
  f.engine.cancel = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "ownership_unknown", cleanup: "unknown" });
  await assert.rejects(f.service.cancel(f.user.id, f.project.id, initial.id), { code: "result_replay_stop_unconfirmed" });
  assert.equal((await f.jobs.get(f.user.id, job.id)).status, "running");
});

test("recovery joins the stable engine identity and the replaced lease cannot cancel its owner", options, async t => {
  const f = await replayFixture(t); await f.calculate(); const oldJob = await f.claim();
  const oldPrepared = await f.service.prepare(oldJob); await f.service.start(oldJob, oldPrepared);
  await f.store.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [oldJob.id]);
  const newJob = await f.claim(); assert.notEqual(newJob.leaseToken, oldJob.leaseToken);
  const recovered = new ResultReplayService({ results: f.results, documents: f.documents, jobs: f.jobs, engine: f.engine, config: f.config });
  const prepared = await recovered.prepare(newJob); assert.deepEqual(prepared.execution, oldPrepared.execution);
  await assert.rejects(f.service.start(oldJob, oldPrepared), { code: "product_job_lease_lost" });
  await assert.rejects(f.service.stop(oldJob), { code: "product_job_lease_lost" });
  assert.equal(f.cancels, 0);
  await recovered.stop(newJob); assert.equal(f.cancels, 1);
});

test("project deletion joins its engine jobs before the parent is removed", options, async t => {
  const f = await replayFixture(t); await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job); await f.service.start(job, prepared);
  await f.store.database.transaction(client => f.service.cancelProject(f.user.id, f.project.id, client));
  assert.equal(f.cancels, 1); assert.equal((await f.jobs.get(f.user.id, job.id)).status, "canceled");
  await assert.rejects(f.service.start(job, prepared), { code: "product_job_lease_lost" });
});

test("three exhausted leases cannot free uncertain physical capacity; reconciliation frees only a joined process", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job); await f.service.start(job, prepared);
  f.engine.status = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "ownership_unknown", cleanup: "unknown" });
  f.engine.cancel = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "ownership_unknown", cleanup: "unknown" });
  await f.store.database.query("UPDATE evimed_product.jobs SET attempts=3,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  await f.service.reconcileTerminatedAttempts();
  assert.equal((await f.service.status(f.user.id, f.project.id, initial.id)).state, "ownership_unknown");
  assert.equal(await heavyWorkBlockerCount(f.store.database), 1);
  for (const kind of ["render", "compute", "replay"]) assert.equal(await f.store.database.transaction(client => heavyWorkAdmission(client, kind)), false);
  assert.equal(await f.jobs.claim(["result-replay"], "uncertain-owner", { admission: client => heavyWorkAdmission(client, "replay") }), null);
  // Even an already exhausted logical job continues to account for its process.
  await f.store.database.query("UPDATE evimed_product.jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
  assert.equal(await f.store.database.transaction(client => heavyWorkAdmission(client, "render")), false);
  await assert.rejects(f.store.database.transaction(client => f.service.cancelProject(f.user.id, f.project.id, client)), { code: "result_replay_stop_unconfirmed" });
  f.engine.status = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "failed", cleanup: "confirmed" });
  await f.service.reconcileTerminatedAttempts();
  assert.equal(await heavyWorkBlockerCount(f.store.database), 0);
  for (const kind of ["render", "compute", "replay"]) assert.equal(await f.store.database.transaction(client => heavyWorkAdmission(client, kind)), true);
});

test("expired recovered work can claim its own confirmed execution without heavy-admission self deadlock", options, async t => {
  const f = await replayFixture(t); await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job); await f.service.start(job, prepared);
  f.engine.status = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "succeeded", cleanup: "confirmed" });
  await f.store.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  await f.service.reconcileTerminatedAttempts();
  const resumed = await f.jobs.claim(["result-replay"], "recovered-owner", { admission: client => heavyWorkAdmission(client, "replay") });
  assert.equal(resumed.id, job.id); assert.notEqual(resumed.leaseToken, job.leaseToken);
});

test("cleanup requires the owned job, recipe and terminal state; bare 404 never frees delayed admission", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job); await f.service.start(job, prepared);
  f.engine.cancel = async scope => ({ jobId: "different-job", recipeDigest: scope.recipeDigest, state: "canceled", cleanup: "confirmed" });
  await assert.rejects(f.service.stop(job), { code: "result_replay_stop_unconfirmed" });
  assert.equal((await f.service.status(f.user.id, f.project.id, initial.id)).state, "ownership_unknown");
  assert.equal((await f.jobs.get(f.user.id, job.id)).status, "running");
  await f.store.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  f.engine.status = async scope => ({ jobId: scope.jobId, recipeDigest: "f".repeat(64), state: "failed", cleanup: "confirmed" });
  await f.service.reconcileTerminatedAttempts();
  assert.equal(await heavyWorkBlockerCount(f.store.database), 1);
  assert.equal(await f.store.database.transaction(client => heavyWorkAdmission(client, "replay")), false);
  f.engine.status = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "running", cleanup: "confirmed" });
  f.engine.cancel = async () => { throw new HttpError(404, "result_engine_missing", "fixture unknown endpoint"); };
  await f.service.reconcileTerminatedAttempts();
  assert.equal(await heavyWorkBlockerCount(f.store.database), 1);
  await assert.rejects(f.service.stopExecution(prepared.execution), { status: 404 });
  f.engine.cancel = async scope => ({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "running", cleanup: "confirmed" });
  await assert.rejects(f.service.stopExecution(prepared.execution), { code: "result_replay_stop_unconfirmed" });
});

test("cancel preserves a byte-bound partial output without admitting it as a complete replay baseline", options, async t => {
  const f = await replayFixture(t); const initial = await f.calculate(); const job = await f.claim();
  const prepared = await f.service.prepare(job); await f.service.start(job, prepared);
  const machineValues = [{ key: "computed", value: 7, unit: "test", absoluteTolerance: 0 }];
  const bytes = Buffer.from(JSON.stringify({ receipt: { recipeDigest: prepared.execution.recipeDigest }, machineValues }));
  const outputPath = `result-replays/${job.id}/output/result.json`;
  const { mkdir } = await import("node:fs/promises"); await mkdir(path.dirname(path.join(f.project.workspaceDir, outputPath)), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, outputPath), bytes);
  f.engine.cancel = async () => ({ jobId: job.id, recipeDigest: prepared.execution.recipeDigest,
    state: "canceled", cleanup: "confirmed", resultPath: outputPath, machineValues,
    artifacts: [{ path: outputPath, sha256: sha(bytes), bytes: bytes.length }] });
  const canceled = await f.service.cancel(f.user.id, f.project.id, initial.id);
  assert.equal(canceled.state, "canceled"); assert.equal(canceled.partial, true); assert.ok(canceled.resultVersionId);
  const partial = await f.results.raw(f.user.id, f.project.id, canceled.resultVersionId);
  assert.equal(partial.bytes.equals(bytes), true); assert.equal(partial.version.findings[0].status, "partial");
  assert.equal(await f.service.recipe(f.user.id, partial.version), null);
});

test("a separately preserved R receipt cannot substitute machine values absent from the preserved numerical result", options, async t => {
  const f = await replayFixture(t); f.capability.method = "comparator.evalue";
  await writeFile(path.join(f.project.workspaceDir, "input.json"), '{"scenario":{"riskRatio":3.9}}');
  await f.service.calculate(f.user.id, f.project, { method: "comparator.evalue", inputPath: "input.json", parameters: {} },
    { kind: "engine", sessionId: "r-session", callId: "r-call" });
  const job = await f.claim(); const prepared = await f.service.prepare(job);
  const outputPath = `result-replays/${job.id}/output/result.json`; const receiptPath = `result-replays/${job.id}/output/receipt.json`;
  const bytes = Buffer.from(JSON.stringify({ method: "comparator.evalue", measures: [{ name: "e_value", value: 7.263 }] }));
  const machineValues = [{ key: "e_value", value: 99, absoluteTolerance: 1e-10 }];
  const artifact = { path: outputPath, sha256: sha(bytes), bytes: bytes.length };
  const receipt = Buffer.from(JSON.stringify({ jobId: job.id, recipeDigest: prepared.execution.recipeDigest,
    method: prepared.recipe.method, codeDigest: prepared.recipe.codeDigest, environmentDigest: prepared.recipe.environmentDigest,
    artifacts: [artifact], machineValues }));
  const { mkdir } = await import("node:fs/promises"); await mkdir(path.dirname(path.join(f.project.workspaceDir, outputPath)), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, outputPath), bytes); await writeFile(path.join(f.project.workspaceDir, receiptPath), receipt);
  await assert.rejects(f.service.complete(job, prepared, { jobId: job.id, recipeDigest: prepared.execution.recipeDigest, state: "succeeded", cleanup: "confirmed",
    resultPath: outputPath, machineValues, artifacts: [artifact, { path: receiptPath, sha256: sha(receipt), bytes: receipt.length }] }), { code: "result_replay_receipt_invalid" });
  assert.equal((await f.documents.list(f.user.id, "result-version", { projectId: f.project.id })).items.length, 1);
});

test("completion side effects roll back together when lease authority expires before finish", options, async t => {
  const f = await replayFixture(t); await f.calculate(); const job = await f.claim(); const prepared = await f.service.prepare(job);
  const machineValues = [{ key: "value", value: 1, unit: "test", absoluteTolerance: 0 }];
  const payload = { machineValues, receipt: { recipeDigest: prepared.execution.recipeDigest } };
  const bytes = Buffer.from(JSON.stringify(payload)); const outputPath = `result-replays/${job.id}/output/result.json`;
  const { mkdir } = await import("node:fs/promises"); await mkdir(path.dirname(path.join(f.project.workspaceDir, outputPath)), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, outputPath), bytes);
  const answer = { jobId: job.id, recipeDigest: prepared.execution.recipeDigest, state: "succeeded", cleanup: "confirmed",
    resultPath: outputPath, machineValues, artifacts: [{ path: outputPath, sha256: sha(bytes), bytes: bytes.length }] };
  const originalAdmit = f.service.admit.bind(f.service);
  f.service.admit = async (...args) => {
    const admitted = await originalAdmit(...args);
    await f.store.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    return admitted;
  };
  await assert.rejects(f.service.complete(job, prepared, answer), { code: "product_job_lease_lost" });
  const versions = await f.documents.list(f.user.id, "result-version", { projectId: f.project.id });
  assert.equal(versions.items.length, 1, "only the original input is visible after completion rollback");
  const recipes = await f.documents.list(f.user.id, "result-replay", { projectId: f.project.id, filter: { recordType: "result-replay-recipe" } });
  assert.equal(recipes.items.length, 0);
  assert.equal(replayDigest(payload.machineValues), replayDigest(machineValues));
});

test("three actual Python engines complete native gateway jobs and public reruns from frozen inputs", {
  ...options, timeout: 90000,
  skip: !databaseUrl || process.env.OPEN_SCIENCE_TEST_RESULT_ENGINES !== "1" ? "PostgreSQL and OPEN_SCIENCE_TEST_RESULT_ENGINES=1 are required" : false,
}, async t => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { createServer } = await import("node:http");
  const { fileURLToPath } = await import("node:url");
  const { readFile } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const f = await replayFixture(t);
  const adapterRoot = fileURLToPath(new URL("../../../deploy/specialist-adapter/", import.meta.url));
  const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const secret = "test-only-result-engine-signing-secret-32bytes";
  const secretFile = path.join(f.dataDir, "workload-secret"); await writeFile(secretFile, secret, { mode: 0o600 });
  const source = ["import asyncio,json,socket,uvicorn", "from evimed_specialist_adapter.replay_app import app",
    "sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(128)",
    "print(json.dumps({'port':sock.getsockname()[1]}),flush=True)",
    "asyncio.run(uvicorn.Server(uvicorn.Config(app,log_level='warning')).serve(sockets=[sock]))"].join("\n");
  const child = spawn(process.env.EVIMED_RESULT_REPLAY_PYTHON ?? "python3", ["-c", source], { cwd: adapterRoot, env: {
    PATH: process.env.PATH, HOME: process.env.HOME, PYTHONPATH: adapterRoot, PYTHONDONTWRITEBYTECODE: "1",
    EVIMED_DATA_ROOT: f.dataDir, EVIMED_WORKLOAD_SIGNING_SECRET_FILE: secretFile, EVIMED_SPECIALIST_KIND: "bibliometric-analysis",
    EVIMED_REPLAY_META_ROOT: path.join(workspaceRoot, "项目代码/meta"),
    EVIMED_REPLAY_SAFETY_ROOT: path.join(workspaceRoot, "项目代码/药物安全分析agent"),
    EVIMED_REPLAY_BIBLIOMETRIC_ROOT: path.join(workspaceRoot, "项目代码/文献剂量分析"),
  } });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-4096); });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-8192); });
  const closed = once(child, "close");
  f.cleanup.push(async () => { child.kill("SIGTERM"); await closed; });
  const readyDeadline = Date.now() + 10000;
  while (!stdout.includes("\n") && Date.now() < readyDeadline && child.exitCode === null) await delay(20);
  assert.ok(stdout.includes("\n"), stderr);
  const pythonUrl = `http://127.0.0.1:${JSON.parse(stdout.split("\n")[0]).port}`;
  for (;;) {
    try { const ready = await fetch(`${pythonUrl}/health`); if (ready.ok) break; } catch { /* not listening yet */ }
    assert.ok(Date.now() < readyDeadline, stderr); await delay(20);
  }
  const engine = new ResultReplayClient({ config: { resultEngineUrl: pythonUrl, evimedWorkloadSigningSecret: secret,
    resultEngineRequestTimeoutMs: 10000 } });
  f.service.engine = engine;
  const worker = new ResultReplayWorker({ service: f.service, jobs: f.jobs, engine,
    config: { resultReplayTimeoutMs: 60000 }, report: code => assert.fail(`worker failed: ${code}`) });
  f.cleanup.push(() => worker.close());
  let nativeInput; let nativeCallId;
  const gateway = createResultGateway({ store: f.store, service: f.service, agentRuns: { activeRuns: async () => [] }, runtimeManager: {
    assertActiveModelGatewayToken: token => { assert.equal(token, "fixture-workload"); return { userId: f.user.id, projectId: f.project.id }; },
    sessionTranscript: async () => ({ sessionId: "native-session", truncated: false, turns: [{ startSeq: 1, end: null }],
      messages: [{ turnStartSeq: 1, parts: [{ type: "tool", tool: "mcp__evimed__research_calculate",
        callId: nativeCallId, status: "pending", input: nativeInput }] }] }),
  } });
  const publicRoutes = createResultReplayRoutes({ service: f.service, store: {
    ensureSessionUser: async () => ({ user: f.user }), assertCsrf: async () => {},
  } });
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url.startsWith("/internal/results/v1/")) await gateway(req, res);
      else if (!await publicRoutes(req, res)) { res.statusCode = 404; res.end(); }
    })().catch(error => { res.statusCode = error.status ?? 500; res.end(JSON.stringify({ code: error.code })); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  f.cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fixtures = [
    { method: "meta.dl", value: { studies: [0, 1, 3].map((yi, i) => ({ id: String(i), label: String(i), yi, vi: .1 })), effectMeasure: "MD", outcome: "test" }, parameters: {} },
    { method: "faers.signals", value: { tables: [{ id: "T1", a: 10, b: 90, c: 20, d: 1880 }] }, parameters: {} },
    { method: "bibliometric.network", value: { edges: [{ source: "A", target: "B", weight: 2, source_freq: 8, target_freq: 7 }] }, parameters: { maxNodes: 2 } },
  ];
  for (const [index, item] of fixtures.entries()) {
    await t.test(item.method, async () => {
      const inputPath = `input-${index}.json`; await writeFile(path.join(f.project.workspaceDir, inputPath), JSON.stringify(item.value));
      nativeCallId = `calculate-${index}`;
      nativeInput = { action: "start", method: item.method, inputPath, parameters: item.parameters, requestId: `request-${index}` };
      const body = { method: item.method, inputPath, parameters: item.parameters, requestId: nativeInput.requestId };
      const headers = { Authorization: "Bearer fixture-workload", "Content-Type": "application/json",
        "X-EviMed-Execution-Context": JSON.stringify({ v: 1, sessionId: "native-session", callId: nativeCallId }) };
      nativeInput.action = "cancel";
      assert.equal((await fetch(`${base}/internal/results/v1/start`, { method: "POST", headers, body: JSON.stringify(body) })).status, 403);
      nativeInput.action = "start";
      assert.equal((await fetch(`${base}/internal/results/v1/start`, { method: "POST", headers,
        body: JSON.stringify({ ...body, parameters: { maxNodes: 42 } }) })).status, 403);
      const start = await fetch(`${base}/internal/results/v1/start`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(start.status, 202, await start.clone().text()); const initial = (await start.json()).data;
      await worker.tick();
      const finished = await f.service.status(f.user.id, f.project.id, initial.id);
      assert.equal(finished.state, "succeeded", JSON.stringify(finished)); assert.ok(finished.resultVersionId);
      const original = await f.results.raw(f.user.id, f.project.id, finished.resultVersionId);
      const output = JSON.parse(original.bytes);
      assert.ok(output.machineValues.length > 0); assert.equal(sha(original.bytes), original.version.digest);
      if (item.method === "meta.dl") { assert.ok(Math.abs(output.result.values.pooled_effect - 4 / 3) < 1e-12); t.diagnostic(`Actual pooled_effect=${output.result.values.pooled_effect}; tau_squared=${output.result.values.tau_squared}`); }
      if (item.method === "faers.signals") { assert.ok(Math.abs(output.result.values[0].ror.value - 10.444444444444445) < 1e-12); t.diagnostic(`Actual ROR=${output.result.values[0].ror.value}; PRR=${output.result.values[0].prr.value}`); }
      if (item.method === "bibliometric.network") { assert.equal(output.result.values.nodeCount, 2); assert.equal(output.result.values.edgeCount, 1); t.diagnostic(`Actual nodeCount=${output.result.values.nodeCount}; edgeCount=${output.result.values.edgeCount}`); }
      for (const artifact of finished.artifacts) assert.equal(sha(await readFile(path.join(f.project.workspaceDir, artifact.path))), artifact.sha256);
      await writeFile(path.join(f.project.workspaceDir, inputPath), '{"overwritten":true}');
      const rerun = await fetch(`${base}/api/results/${original.version.versionId}/replays`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.id,
          digest: original.version.digest, requestId: `rerun-${index}` }) });
      assert.equal(rerun.status, 202, await rerun.clone().text()); const replay = (await rerun.json()).data;
      await worker.tick();
      const replayed = await f.service.status(f.user.id, f.project.id, replay.id);
      assert.equal(replayed.state, "succeeded", JSON.stringify(replayed));
      assert.equal(replayed.comparison.numbers.status, "identical");
      assert.equal(replayed.comparison.scientificApplicability, "not_assessed");
      assert.equal((await f.results.raw(f.user.id, f.project.id, original.version.versionId)).bytes.equals(original.bytes), true);
      await recordNumericalEvidence(item.method, original, replayed, output.receipt);
    });
  }
});

test("two actual R engines complete durable initial capture and rerun with separately verified receipts", {
  ...options, timeout: 90000, skip: !databaseUrl || !process.env.VCR_R_LIBS ? "PostgreSQL and VCR_R_LIBS are required" : false,
}, async t => {
  const { spawn, execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile, readdir, mkdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { createVcrEngineClient } = await import("../src/vcrEngineClient.mjs");
  const { ResultVcrReplay } = await import("../src/resultVcrReplay.mjs");
  const f = await replayFixture(t);
  const engineRoot = fileURLToPath(new URL("../../../../项目代码/vcr-engine/", import.meta.url));
  const env = { ...process.env, VCR_ENGINE_ROOT: engineRoot };
  const { stdout } = await promisify(execFile)("Rscript", ["-e",
    'local({lib<-Sys.getenv("VCR_R_LIBS","");if(nzchar(lib)).libPaths(c(lib,.libPaths()))});root<-Sys.getenv("VCR_ENGINE_ROOT");source(file.path(root,"R","engine.R"));vcr_engine_load(root);cat(jsonlite::toJSON(vcr_engine_health(),auto_unbox=TRUE,digits=NA))'], { env });
  const health = JSON.parse(stdout); const sourceFiles = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(file); else if (/\.(R|json)$/.test(entry.name)) sourceFiles.push(file);
    }
  };
  await visit(path.join(engineRoot, "R")); const sourceHash = createHash("sha256");
  for (const file of sourceFiles.sort()) { const bytes = await readFile(file); sourceHash.update(`${path.relative(engineRoot, file).split(path.sep).join("/")}\0${bytes.length}\0${sha(bytes)}\n`); }
  health.numericalSourceDigest = sourceHash.digest("hex"); assert.equal(health.ok, true);
  const processes = new Map();
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, input) => {
    const route = new URL(url).pathname;
    if (route === "/health") return response(health);
    if (route === "/jobs" && input.method === "POST") {
      const job = JSON.parse(input.body); assert.equal(processes.has(job.jobId), false);
      const output = path.join(f.dataDir, "r-jobs", job.jobId); await mkdir(output, { recursive: true });
      const requestFile = path.join(output, "job.json"); await writeFile(requestFile, JSON.stringify(job));
      const child = spawn("Rscript", [path.join(engineRoot, "service/run_job.R"), requestFile, output], { env });
      const record = { child, state: "running", result: null, stderr: "", closed: null };
      child.stderr.on("data", bytes => { record.stderr = (record.stderr + bytes).slice(-8192); }); child.stdout.resume();
      record.closed = new Promise((resolve, reject) => {
        child.once("error", reject); child.once("close", async code => {
          try { assert.equal(code, 0, record.stderr); record.result = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
            record.state = record.result.status; resolve(); } catch (error) { reject(error); }
        });
      });
      record.closed.catch(() => { record.state = "failed"; }); processes.set(job.jobId, record);
      return response({ jobId: job.jobId, accepted: true });
    }
    const matched = /^\/jobs\/([^/]+)(\/result|\/cancel)?$/.exec(route);
    if (!matched || !processes.has(matched[1])) return response({ error: "job_not_found" }, 404);
    const record = processes.get(matched[1]);
    if (matched[2] === "/result") { await record.closed; return response(record.result); }
    if (matched[2] === "/cancel") { if (record.state === "running") record.child.kill("SIGTERM"); return response({ canceled: true }); }
    return response({ jobId: matched[1], state: record.state, progress: { done: record.state === "succeeded" ? 1 : 0, total: 1 } });
  };
  let client = createVcrEngineClient({ baseUrl: "http://r-transport-fixture.invalid", fetchImpl });
  const signedHttp = process.env.EVIMED_RESULT_REPLAY_SIGNED_VCR === "1";
  if (signedHttp) {
    const { once } = await import("node:events");
    const { setTimeout: delay } = await import("node:timers/promises");
    const token = "t".repeat(48); const receiptKey = "r".repeat(48);
    const tokenFile = path.join(f.dataDir, "r-token"); const receiptFile = path.join(f.dataDir, "r-receipt-key");
    await writeFile(tokenFile, token, { mode: 0o600 }); await writeFile(receiptFile, receiptKey, { mode: 0o600 });
    const source = ["import asyncio,json,socket,uvicorn", "from service.app import app",
      "sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(128)", "print(json.dumps({'port':sock.getsockname()[1]}),flush=True)",
      "asyncio.run(uvicorn.Server(uvicorn.Config(app,log_level='warning')).serve(sockets=[sock]))"].join("\n");
    const child = spawn("python3", ["-c", source], { cwd: engineRoot, env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", VCR_ENGINE_ROOT: engineRoot,
      VCR_R_LIBS: process.env.VCR_R_LIBS, R_LIBS_SITE: process.env.R_LIBS_SITE ?? process.env.R_LIBS ?? "",
      VCR_ENGINE_WORK_DIR: path.join(f.dataDir, "signed-r-jobs"), VCR_ENGINE_DATA_ROOT: path.join(f.dataDir, "aggregate-data-plane"),
      VCR_ENGINE_TOKEN_FILE: tokenFile, VCR_ENGINE_RECEIPT_KEY_FILE: receiptFile, VCR_ENGINE_CORES: "1",
    } });
    let output = ""; let diagnostic = "";
    child.stdout.on("data", bytes => { output = (output + bytes).slice(-4096); });
    child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-8192); });
    const closed = once(child, "close");
    f.cleanup.push(async () => { child.kill("SIGTERM"); await closed; });
    const deadline = Date.now() + 30000;
    while (!output.includes("\n") && Date.now() < deadline && child.exitCode === null) await delay(20);
    assert.ok(output.includes("\n"), diagnostic);
    client = createVcrEngineClient({ baseUrl: `http://127.0.0.1:${JSON.parse(output.split("\n")[0]).port}`,
      token, receiptKey, timeoutMs: 10000 });
    for (;;) {
      try { if ((await client.health()).ok) break; } catch { /* startup self-check is still running */ }
      assert.ok(Date.now() < deadline && child.exitCode === null, diagnostic); await delay(20);
    }
  }
  const adapter = new ResultVcrReplay({ engine: client, config: f.config, authorizeProject: (actor, id) => f.results.scope(actor, id) });
  f.service.engine = adapter;
  const worker = new ResultReplayWorker({ service: f.service, jobs: f.jobs, engine: adapter, config: { resultReplayTimeoutMs: 30000 } });
  f.cleanup.push(async () => { await worker.close(); for (const record of processes.values()) if (record.state === "running") record.child.kill("SIGTERM");
    await Promise.all([...processes.values()].map(record => record.closed)); });
  if (signedHttp) for (const delayed of [false, true]) await t.test(delayed
    ? "signed R cancellation tombstone rejects an already reserved delayed admission"
    : "signed R absent-job cancellation survives adapter restart and refuses future admission", async () => {
    const inputPath = `cancel-vcr-${delayed}.json`;
    await writeFile(path.join(f.project.workspaceDir, inputPath), JSON.stringify({ scenario: { riskRatio: 3.9, confidenceLimit: 1.8, scale: "risk_ratio" } }));
    const initial = await f.service.calculate(f.user.id, f.project, { method: "comparator.evalue", inputPath, parameters: {} },
      { kind: "engine", sessionId: "vcr-cancel-session", callId: `vcr-cancel-${delayed}` });
    const job = await f.claim(); const prepared = await f.service.prepare(job);
    const originalSubmit = client.submit; const release = deferred(); let attempts = 0; let admission;
    client.submit = async engineJob => {
      attempts++;
      if (!delayed) return originalSubmit(engineJob);
      // The sender loses its response before the delayed request reaches the engine.
      // Releasing the parent transaction lets cancellation take its ordinary lock.
      admission = release.promise.then(() => originalSubmit(engineJob));
      admission.catch(() => {});
      throw Object.assign(new Error("fixture admission response lost"), { code: "vcr_engine_timeout" });
    };
    try {
      if (delayed) await assert.rejects(f.service.start(job, prepared), { code: "vcr_engine_timeout" });
      const canceled = await adapter.cancel(prepared.execution);
      assert.equal(canceled.state, "canceled"); assert.equal(canceled.cleanup, "confirmed");
      const restarted = new ResultVcrReplay({ engine: client, config: f.config, authorizeProject: (actor, id) => f.results.scope(actor, id) });
      assert.equal((await restarted.status(prepared.execution)).cleanup, "confirmed");
      release.resolve();
      if (delayed) await assert.rejects(admission, { code: "vcr_engine_rejected", status: 409, detail: "job_canceled" });
      const answer = delayed ? await restarted.status(prepared.execution) : await f.service.start(job, prepared);
      assert.equal(answer.state, "canceled"); assert.equal(answer.cleanup, "confirmed");
      assert.deepEqual(answer.artifacts, []); assert.deepEqual(answer.machineValues, []);
      assert.equal((await restarted.start(prepared.execution, prepared.recipe)).state, "canceled");
      assert.equal(attempts, 1, "durable engine tombstone refuses the one delayed HTTP submit; adapter never resubmits");
      const stopped = await f.service.cancel(f.user.id, f.project.id, initial.id);
      assert.equal(stopped.state, "canceled"); assert.equal(stopped.cleanup, "confirmed");
      assert.equal((await f.jobs.get(f.user.id, job.id)).status, "canceled"); assert.equal(stopped.resultVersionId, null);
    } finally { release.resolve(); client.submit = originalSubmit; }
  });
  const fixtures = [
    { method: "design.analytic", scenario: { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" },
      truth: { hazardRatio: .7, controlMedian: 12 }, analysis: { alpha: .025, sided: 1, power: .9 } } },
    { method: "comparator.evalue", scenario: { riskRatio: 3.9, confidenceLimit: 1.8, scale: "risk_ratio" } },
  ];
  for (const [index, item] of fixtures.entries()) await t.test(item.method, async () => {
    const inputPath = `vcr-${index}.json`; await writeFile(path.join(f.project.workspaceDir, inputPath), JSON.stringify({ scenario: item.scenario, seed: 331331 }));
    const initial = await f.service.calculate(f.user.id, f.project, { method: item.method, inputPath, parameters: {} },
      { kind: "engine", sessionId: "vcr-session", callId: `vcr-${index}` });
    await worker.tick(); const completed = await f.service.status(f.user.id, f.project.id, initial.id);
    assert.equal(completed.state, "succeeded", JSON.stringify(completed)); assert.ok(completed.resultVersionId);
    const selected = await f.results.raw(f.user.id, f.project.id, completed.resultVersionId);
    const values = Object.fromEntries(selected.version.machineValues.map(value => [value.key, value.value]));
    if (item.method === "design.analytic") assert.equal(values.required_events, 331);
    else { assert.ok(Math.abs(values.e_value - (3.9 + Math.sqrt(3.9 * 2.9))) < 1e-12); assert.equal(values.e_value_confidence_limit, 3); }
    t.diagnostic(item.method === "design.analytic" ? `Actual required_events_exact=${values.required_events_exact}; required_events=${values.required_events}`
      : `Actual e_value=${values.e_value}; e_value_confidence_limit=${values.e_value_confidence_limit}`);
    const receipt = JSON.parse(await readFile(path.join(f.project.workspaceDir, completed.artifacts.find(artifact => artifact.path.endsWith("/receipt.json")).path), "utf8"));
    assert.equal(receipt.signed, signedHttp, signedHttp ? "actual HTTP receipt verifies against the service-only key" : "transport fixture runs genuine R but does not qualify signed HTTP");
    await writeFile(path.join(f.project.workspaceDir, inputPath), '{"overwritten":true}');
    const replay = await f.service.request(f.user.id, selected.version.versionId, { projectId: f.project.id,
      digest: selected.version.digest, requestId: `r-rerun-${index}` });
    await worker.tick(); const rerun = await f.service.status(f.user.id, f.project.id, replay.id);
    assert.equal(rerun.state, "succeeded", JSON.stringify(rerun)); assert.equal(rerun.comparison.numbers.status, "identical");
    assert.equal((await f.results.raw(f.user.id, f.project.id, selected.version.versionId)).bytes.equals(selected.bytes), true);
    await recordNumericalEvidence(item.method, selected, rerun, receipt);
  });
});
