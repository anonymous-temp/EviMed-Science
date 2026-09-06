import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sourceUnderstandingSchema, validateSourceUnderstanding } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { sourceAttemptId } from "../src/sourceFiles.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) { const url = new URL(databaseUrl); assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname)); assert.match(url.pathname, /evimed_test/); }
const options = { skip: !databaseUrl, timeout: 30_000 };

async function fixture(t) {
  const dataDir = await mkdtemp("/tmp/source-runtime-app-");
  const app = createWebApiApp({ dataDir, stateStore: "postgres", databaseUrl, runtimeMode: "mock",
    devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", requireMemos: false,
    requireMemoryIndex: false, memoryExtractionEnabled: false, memOsEngineUrl: "", autopilotEnabled: false,
    sourceIngestionEnabled: true, sourceIngestionPollMs: 60_000, sourceIngestionLeaseMs: 30_000,
    documentParserUrl: "", modelGatewaySigningSecret: "fixture-source-signing-secret-at-least-32-characters" });
  const userId = `source_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await app.store.createUser(userId, "test-only-source-password", "Source runtime fixture");
  const user = await app.store.userById(userId);
  const project = await app.store.defaultProject(user);
  await app.listen(0, "127.0.0.1");
  await app.sourceWorker.close();
  t.after(async () => {
    await app.sourceWorker.close();
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const text = "Record the outcome. Keep the original notes.";
  await mkdir(path.join(project.baseDir, "knowledge-base"), { recursive: true });
  await writeFile(path.join(project.baseDir, "knowledge-base/notes.txt"), text);
  const { source } = await app.sourceService.register(userId, { projectId: project.id, connector: { type: "upload", id: "library" },
    path: "knowledge-base/notes.txt", sha256: createHash("sha256").update(text).digest("hex"), size: Buffer.byteLength(text),
    mimeType: "text/plain", mtime: new Date().toISOString() });
  const calls = { reserve: 0, prompt: 0, cancel: 0, release: [] };
  const state = { scope: null, project: null, sessionId: null };
  // Keep real ProductJobs, source transactions, registry, research sessions,
  // AgentRunStore dispatch and usage settlement. Only the external DSH kernel
  // boundary is a fixture; no paid model or unrelated Memos service is called.
  app.runtimeManager.reserveBoundedRuntimeSession = async (scoped, scope) => {
    calls.reserve++; state.scope = scope; state.project = scoped;
    state.sessionId = `session_${randomUUID().replaceAll("-", "")}`;
    return { id: state.sessionId };
  };
  app.runtimeManager.sessionMessages = async () => [];
  app.runtimeManager.sessionStatus = async () => "idle";
  app.runtimeManager.dispatchPrompt = async (_project, _session, input) => {
    calls.prompt++;
    assert.equal(input.allowBounded, true);
    assert.equal(input.model, `deepseek/${app.config.deepseekModel}`);
    assert.ok(input.text.includes("source-understanding-input.json"));
    assert.ok(!input.text.includes(text));
    return { accepted: true };
  };
  app.runtimeManager.boundedRuntimeScope = () => state.scope;
  app.runtimeManager.endBoundedRuntime = async (_project, scopeId) => {
    assert.equal(state.scope?.runId, scopeId);
    calls.release.push(scopeId); state.scope = null; return true;
  };
  app.runtimeManager.cancelRuntimeSession = async () => { calls.cancel++; return true; };
  app.agentRuns.scheduleMonitor = () => {};
  app.agentRuns.onRunFinished = (scoped, run) => app.sourceUnderstandingRuntime.complete(scoped, run);
  const due = () => app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND status='queued'", [userId]);
  return { app, source, userId, user, project, calls, state, due };
}

async function acceptFixture(f) {
  const input = JSON.parse(await readFile(path.join(f.state.project.workspaceDir, "source-understanding-input.json"), "utf8"));
  const unit = input.units[0];
  const evidence = [{ sourceId: input.sourceId, generation: input.generation, unitId: unit.id,
    start: 0, end: 19, quote: "Record the outcome." }];
  const output = { schemaVersion: 1, sourceId: input.sourceId, generation: input.generation, docType: input.docType,
    depth: input.depth, summary: "Record outcomes and retain the original notes.",
    slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map((name, index) => [name,
      index ? { state: "unknown", reason: "Not stated by this source." } : { state: "known", value: "Record the outcome.", evidence }])),
    claims: [{ id: "claim-one", statement: "The source asks to record outcomes.", evidence }], methods: [],
    omissionAudit: { status: "not_run", reason: "Question audit was not performed.", omissionRate: null } };
  assert.deepEqual(validateSourceUnderstanding(output, input), []);
  const directory = path.join(f.state.project.workspaceDir, "deliverables/source-package");
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const [name, value] of [["source-understanding-input.json", input], ["source-understanding.json", output]]) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const relative = `deliverables/source-package/${name}`;
    await writeFile(path.join(f.state.project.workspaceDir, relative), bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(f.state.project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1, runId: "fixture-kernel-run", bundleVersion: "1.0.0", domainVersion: "1.0.0", entries: [{
      deliverableId: "source-package", contractKind: "source-understanding", capability: "source-understanding",
      files, acceptedAt: new Date().toISOString(), attempt: 1, notices: [],
    }],
  }));
  const request = await f.app.usageLedger.reserveModel({ id: randomUUID(), userId: f.userId, projectId: f.project.id,
    runId: f.state.scope.runId, model: f.app.config.deepseekModel, currency: "CNY", priceVersion: "fixture-price",
    requestFingerprint: "d".repeat(64), estimatedCost: 0.1, runLimit: 3, dailyLimit: 10, weeklyLimit: 50 });
  await f.app.usageLedger.settleModel(f.userId, request.id, { actualCost: 0.031, priced: true,
    usage: { cacheHitTokens: 7, cacheMissTokens: 123, completionTokens: 47 } });
  const run = (await f.app.agentRuns.list(f.project))[0];
  await f.app.agentRuns.finishInternal(f.state.project, run.id, { status: "succeeded", artifacts: files.map(file => file.path) });
  return { input, output, run };
}

test("the wired structured source worker uses one real run ledger dispatch and publishes the accepted result on reclaim", options, async t => {
  const f = await fixture(t);
  const first = await f.app.sourceWorker.tick();
  assert.equal(first.deferred, true);
  assert.equal(f.calls.reserve, 1);
  assert.equal(f.calls.prompt, 1);
  const processing = await f.app.sourceService.get(f.userId, f.source.id);
  assert.equal(processing.payload.status, "parsing");
  assert.ok(processing.payload.analysis.run.artifactDirectory.includes("knowledge-base/.evimed-derived"));
  await f.due();
  await f.app.sourceWorker.tick();
  assert.equal(f.calls.prompt, 1, "polling never repeats model dispatch");
  const { output, run } = await acceptFixture(f);
  assert.equal(f.calls.release.length, 1);
  await mkdir(path.join(f.project.baseDir, "changed-workspace"));
  await f.app.store.setProjectWorkspace(f.project, "changed-workspace");
  await f.due();
  await f.app.sourceWorker.tick();
  const complete = await f.app.sourceService.get(f.userId, f.source.id);
  assert.equal(complete.payload.status, "complete");
  const result = await f.app.sourceService.getUnderstanding(f.userId, f.source.id);
  assert.equal(result.current.summary, output.summary);
  assert.equal(result.current.run.id, run.id);
  assert.equal(result.current.usage.inputTokens, 130);
  assert.equal(result.current.usage.outputTokens, 47);
  assert.equal(result.current.usage.modelId, f.app.config.deepseekModel);
  assert.equal(result.current.usage.actualCost, 0.031);
  assert.equal(f.calls.reserve, 1);
});

test("wired source budget rejection happens before any runtime or paid request", options, async t => {
  const f = await fixture(t);
  f.app.config.sourceUnderstandingRunLimitCny = 0;
  await f.app.sourceWorker.tick();
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.calls.prompt, 0);
  assert.equal((await f.app.sourceService.get(f.userId, f.source.id)).payload.error.code, "source_understanding_budget_invalid");
  assert.equal((await f.app.usageLedger.summary(f.userId)).totalCalls, 0);
});

test("a crash after the actual ledger append recovers the protected launch and terminates without resending", options, async t => {
  const f = await fixture(t);
  const jobs = f.app.sourceService.jobs;
  const job = await jobs.claim(["ingest"], "crash-fixture", { leaseMs: 30_000 });
  await f.app.sourceService.beginIngestion(f.userId, f.source.id, { generation: 1, job });
  const parsed = await f.app.sourceService.freezeCapture(job, {
    text: await readFile(path.join(f.project.baseDir, "knowledge-base/notes.txt"), "utf8"), summary: "Fixture capture",
    extractor: { name: "fixture", version: "1", parser: "fallback" }, units: [{ id: "page-one", unitType: "page", status: "extracted" }],
  });
  const dispatchId = `source-understanding-${createHash("sha256").update(`${f.source.id}\0${1}`).digest("hex").slice(0, 32)}`;
  const dispatch = f.app.agentRuns.dispatch.bind(f.app.agentRuns);
  // This is exactly the durable state a process exit leaves after reserveRun's
  // ledger fsync but before the source binding or any kernel prompt callback.
  f.app.agentRuns.dispatch = async (scoped, args) => {
    const session = await f.app.researchSessions.get(scoped, args.sessionId);
    await f.app.agentRuns.reserveRun(scoped, session, { dispatchId: args.dispatchId,
      question: args.question, effectiveAgentId: args.effectiveAgentId,
      effectiveAgentVersion: args.effectiveAgentVersion, effectiveRuntimeAgent: args.effectiveRuntimeAgent,
      effectiveRouteReason: args.effectiveRouteReason });
    throw Object.assign(new Error("Simulated process exit after ledger append"), { code: "fixture_crash" });
  };
  const identity = await f.app.sourceUnderstandingRuntime.dispatch({ job, userId: f.userId, projectId: f.project.id,
    dispatchId, input: parsed.input, question: "Read source-understanding-input.json and submit the source-understanding contract." });
  const unbound = await f.app.sourceService.get(f.userId, f.source.id);
  assert.ok(unbound.payload.analysis.launch.artifactDirectory);
  assert.equal(unbound.payload.analysis.run, undefined);
  assert.equal(f.calls.prompt, 0);
  f.app.agentRuns.dispatch = dispatch;
  f.app.agentRuns.dispatchOwners.clear();
  f.app.agentRuns.scheduleMonitor = AgentRunStore.prototype.scheduleMonitor;
  f.app.agentRuns.monitorMaxPolls = 1;
  f.app.agentRuns.monitorIntervalMs = 1;
  await f.app.store.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  await f.app.sourceWorker.tick();
  await Promise.all([...f.app.agentRuns.monitors.values()].map(monitor => monitor.promise));
  const recovered = (await f.app.agentRuns.list(f.project)).find(run => run.id === identity.runId);
  assert.equal(recovered.dispatchStatus, "unknown");
  assert.notEqual(recovered.status, "running", "the recovered monitor must reach a bounded terminal state");
  await f.due();
  await f.app.sourceWorker.tick();
  const failed = await f.app.sourceService.get(f.userId, f.source.id);
  assert.equal(failed.payload.status, "failed");
  assert.equal(failed.payload.analysis.run.id, identity.runId);
  assert.equal(failed.payload.analysis.run.artifactDirectory, unbound.payload.analysis.launch.artifactDirectory);
  assert.equal(f.calls.reserve, 1);
  assert.equal(f.calls.prompt, 0);
  assert.equal(f.calls.release.length, 1);
  assert.equal((await f.app.usageLedger.summary(f.userId)).totalCalls, 0);
});

test("wired durable cancellation stops only the bound source session and removes its derived workspace", {
  ...options, skip: !databaseUrl || (process.platform !== "linux" && "Source copy cleanup requires the hosted Linux environment"),
}, async t => {
  const f = await fixture(t);
  await f.app.sourceWorker.tick();
  const source = await f.app.sourceService.get(f.userId, f.source.id);
  const owned = f.state.project.workspaceDir;
  await f.app.sourceService.cancel(f.userId, source.id, { expectedRevision: source.revision });
  await f.due();
  for (let index = 0; index < 3; index++) await f.app.sourceWorker.tick();
  assert.equal(f.calls.cancel, 1);
  assert.equal(f.calls.release.length, 1);
  assert.equal((await f.app.agentRuns.list(f.project))[0].status, "canceled");
  await assert.rejects(stat(owned), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.project.baseDir, "knowledge-base/notes.txt"), "utf8"), "Record the outcome. Keep the original notes.");
});

test("wired cancellation also cleans a protected pre-ledger launch without inventing a run id", {
  ...options, skip: !databaseUrl || (process.platform !== "linux" && "Source copy cleanup requires the hosted Linux environment"),
}, async t => {
  const f = await fixture(t);
  const job = await f.app.sourceService.jobs.claim(["ingest"], "launch-only-fixture", { leaseMs: 30_000 });
  await f.app.sourceService.beginIngestion(f.userId, f.source.id, { generation: 1, job });
  const parsed = await f.app.sourceService.freezeCapture(job, { text: "Record the outcome.", summary: "Fixture capture",
    extractor: { name: "fixture", version: "1", parser: "fallback" }, units: [{ id: "page-one", unitType: "page", status: "extracted" }] });
  const dispatchId = `source-understanding-${createHash("sha256").update(`${f.source.id}\0${1}`).digest("hex").slice(0, 32)}`;
  const artifactDirectory = `knowledge-base/.evimed-derived/${f.source.id}/generation-1-${job.id}-${sourceAttemptId(job)}`;
  const scoped = { ...f.project, workspaceDir: path.join(f.project.baseDir, artifactDirectory) };
  await mkdir(scoped.workspaceDir, { recursive: true });
  await writeFile(path.join(scoped.workspaceDir, "source-understanding-input.json"), JSON.stringify(parsed.input));
  const session = await f.app.runtimeManager.reserveBoundedRuntimeSession(scoped, { runId: dispatchId, runLimit: 3, dailyLimit: 10, weeklyLimit: 50 });
  const launched = await f.app.sourceService.bindUnderstandingLaunch(job, { sessionId: session.id, dispatchId,
    workspaceName: "", artifactDirectory });
  await f.app.sourceService.cancel(f.userId, f.source.id, { expectedRevision: launched.revision });
  await f.app.sourceWorker.tick();
  assert.equal(f.calls.release.length, 1);
  assert.equal(f.calls.cancel, 0);
  assert.equal(f.calls.prompt, 0);
  assert.deepEqual(await f.app.agentRuns.list(f.project), []);
  await assert.rejects(stat(scoped.workspaceDir), { code: "ENOENT" });
});
