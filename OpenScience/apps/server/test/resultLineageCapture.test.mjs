import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService, verifiedEngineFacts } from "../src/resultReplayService.mjs";
import { ResultLineageService } from "../src/resultLineage.mjs";
import { captureResultDelivery } from "../src/resultDeliveryCapture.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";
import { DataSemanticsService } from "../src/dataSemanticsService.mjs";
import { readSkillExecution } from "../src/skillExecution.mjs";
import { stableBytes } from "../src/resultDeliveryCapture.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const OWNER = "owner";

const CODE_FILES = [{ path: "new_meta/engines/meta_engine.py", sha256: "1".repeat(64), bytes: 120 }, { path: "adapter/deterministic_replay.py", sha256: "2".repeat(64), bytes: 99 }];
const ENVIRONMENT = { python: "3.12.3", implementation: "CPython", platform: "linux", machine: "x86_64", packages: { numpy: "1.26.4", scipy: "1.13.0", pydantic: "2.7.1" } };
const values = effect => [
  { key: "values.pooled_effect", value: effect, unit: "odds_ratio", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 },
  { key: "values.ci_lower", value: 0.5201, unit: "odds_ratio", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 },
  { key: "values.i_squared", value: 41.234, unit: "percent", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 }];

/** The replay service on its in-memory stores, with an engine that reports what it measured. */
async function fixture(t, { engine = {}, measured = true } = {}) {
  const root = await mkdtemp("/tmp/evimed-lineage-capture-");
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
  const capability = { available: true, method: "meta.dl", version: "1", codeDigest: replayDigest(CODE_FILES), environmentDigest: replayDigest(ENVIRONMENT),
    ...(measured ? { codeFiles: CODE_FILES, environment: ENVIRONMENT } : {}) };
  const replays = new ResultReplayService({ results, documents, jobs, engine: { configured: () => true, capabilities: async () => ({ methods: [capability] }),
    start: async () => ({ state: "running" }), ...engine } });
  const lineage = new ResultLineageService({ results, replays, config: {} });
  /** Run one calculation to the end the way the worker does. */
  const calculate = async (effect, { input = { studies: [] }, producer = { kind: "engine", sessionId: "native-session", callId: "call-1" }, output = {} } = {}) => {
    await write("input.json", JSON.stringify(input));
    const calculation = await replays.calculate(OWNER, project, { method: "meta.dl", inputPath: "input.json", parameters: {} }, producer);
    const job = [...queue.values()].find(item => item.payload.replayId === calculation.id);
    const prepared = await replays.prepare(job);
    await replays.start(job, prepared);
    const resultPath = `result-replays/${job.id}/output/result.json`;
    const body = JSON.stringify({ receipt: { recipeDigest: prepared.execution.recipeDigest, ...(measured ? { codeFiles: CODE_FILES, environment: ENVIRONMENT } : {}) },
      result: { executedMethod: { tau_estimator: "DL", ci_method: "normal_wald" } }, machineValues: values(effect), ...output });
    await write(resultPath, body);
    const answer = { jobId: job.id, recipeDigest: prepared.execution.recipeDigest, state: "succeeded", cleanup: "confirmed", resultPath,
      artifacts: [{ path: resultPath, sha256: sha(body), bytes: Buffer.byteLength(body) }], machineValues: values(effect) };
    return { calculation, version: await replays.complete(job, prepared, answer), job };
  };
  return { project, documents, results, replays, lineage, write, calculate, capability };
}

test("an engine job's result carries its method, the code files and installed packages it measured, its parameters and its input version", async t => {
  const f = await fixture(t);
  const { version } = await f.calculate(0.7134);
  const { snapshot } = version;
  assert.equal(snapshot.kind, "engine_job");
  assert.equal(snapshot.origin, "platform_measured");
  assert.deepEqual([snapshot.method.id, snapshot.method.version], ["meta.dl", "1"]);
  assert.deepEqual(snapshot.method.executed, { tau_estimator: "DL", ci_method: "normal_wald" }, "the executed-method block the result already carries is read where it is");
  assert.equal(snapshot.method.record, null, "the validated-method record (N05) is read in one place and absent until a result carries one");
  assert.equal(snapshot.script.digest, replayDigest(CODE_FILES));
  assert.deepEqual(snapshot.script.files.map(file => file.path), CODE_FILES.map(file => file.path));
  assert.equal(snapshot.script.executed, true);
  assert.deepEqual(snapshot.environment.facts.packages, ENVIRONMENT.packages);
  assert.equal(snapshot.environment.facts.interpreter, "Python 3.12.3");
  assert.equal(snapshot.inputs[0].kind, "data");
  assert.equal(snapshot.inputs[0].digest, version.inputs[0].digest, "the exact preserved input version");
  assert.equal(snapshot.reproduction, "observed_execution");
  assert.deepEqual(snapshot.unknown, []);
  assert.equal((await f.results.raw(OWNER, "p", snapshot.inputs[0].versionId)).bytes.toString(), '{"studies":[]}', "the input bytes are the ones that were calculated on");
});

test("an engine's own file list or package record is kept only when it hashes to the identity the recipe names", async t => {
  const recipe = { codeDigest: replayDigest(CODE_FILES), environmentDigest: replayDigest(ENVIRONMENT) };
  const kept = verifiedEngineFacts(recipe, null, { receipt: { codeFiles: CODE_FILES, environment: ENVIRONMENT } });
  assert.deepEqual(kept.capability.codeFiles, CODE_FILES);
  assert.deepEqual(kept.capability.environment, ENVIRONMENT);
  const forged = verifiedEngineFacts(recipe, null, { receipt: { codeFiles: [{ ...CODE_FILES[0], sha256: "9".repeat(64) }], environment: { ...ENVIRONMENT, python: "2.7" } } });
  assert.deepEqual(forged.capability, {}, "facts that do not hash to the recorded identity are dropped; the digests stay on the snapshot");
  const f = await fixture(t, { measured: false });
  const { version } = await f.calculate(0.7134, { output: { receipt: { recipeDigest: "ignored", codeFiles: [{ path: "x.py", sha256: "9".repeat(64), bytes: 1 }] } } }).catch(() => ({ version: null }));
  assert.equal(version, null, "an output whose receipt names another recipe is still refused as before");
  const plain = await fixture(t, { measured: false });
  const { version: unmeasured } = await plain.calculate(0.7134);
  assert.equal(unmeasured.snapshot.script.digest, replayDigest(CODE_FILES));
  assert.equal(unmeasured.snapshot.script.files, null, "no file list is made up for an engine that did not report one");
  assert.equal(unmeasured.snapshot.environment.facts, null);
  assert.equal(unmeasured.snapshot.environment.status, "reported", "the environment digest is still the engine's own identity");
});

test("a calculation run again on a changed input file is the successor of the first, and a calculation of another conversation is not", async t => {
  const f = await fixture(t);
  const first = (await f.calculate(0.7134, { input: { studies: [1] }, producer: { kind: "engine", sessionId: "native-session", callId: "call-1" } })).version;
  assert.equal(first.supersedesVersionId, null);
  const second = (await f.calculate(0.7141, { input: { studies: [1, 2] }, producer: { kind: "engine", sessionId: "native-session", callId: "call-2" } })).version;
  assert.equal(second.supersedesVersionId, first.versionId, "same method, a new version of the same input file, the same conversation");
  assert.notEqual(second.inputs[0].digest, first.inputs[0].digest);
  // Another conversation, even on the same input path, starts its own line.
  const elsewhere = (await f.calculate(0.7, { input: { studies: [1, 2, 3] }, producer: { kind: "engine", sessionId: "other-session", callId: "call-3" } })).version;
  assert.equal(elsewhere.supersedesVersionId, null);
  // A fork of the first conversation continues it.
  const fork = (await f.calculate(0.69, { input: { studies: [9] }, producer: { kind: "engine", sessionId: "fork-session", parentSessionId: "native-session", callId: "call-4" } })).version;
  assert.equal(fork.supersedesVersionId, second.versionId);
  const view = await f.lineage.describe(OWNER, "p", first.versionId);
  assert.equal(view.changes[0].successorVersionId, second.versionId);
  assert.equal(view.role, "calculation");
});

/** What `run_analysis.py` writes beside a results file, for a script that ran. */
function receipt({ script, inputs, results, exitCode = 0, libraries = { numpy: "1.26.4", pandas: "2.2.2" }, extra = {} }) {
  const snap = (relative, bytes) => ({ path: relative, sha256: sha(bytes), size: bytes.length, mtimeNs: 1, ctimeNs: 1, inode: 1 });
  return { schemaVersion: 1, executions: [{ id: "e1", parent: null, argv: ["/usr/bin/python3", script.path, "--token", "must-not-be-kept"], script: snap(script.path, script.bytes),
    inputs: inputs.map(input => snap(input.path, input.bytes)), transforms: [], startedAt: "2026-10-04T10:00:00.000000+00:00",
    versions: { interpreter: "3.12.3 (main, Nov 6 2024, 18:32:19) [GCC 13.2.0]", libraries }, exitCode, endedAt: "2026-10-04T10:00:03.000000+00:00",
    output: { before: null, after: snap(results.path, results.bytes), observation: "created", observedWrite: true }, sourcesUnchanged: true, warnings: [], ...extra }] };
}

async function skillFixture(t, options = {}) {
  const f = await fixture(t);
  const script = { path: "analysis.py", bytes: Buffer.from("import pandas\nprint('analysis')\n") };
  const data = { path: "data/trial.csv", bytes: Buffer.from("id,arm,outcome\n1,a,0.5\n2,b,0.7\n") };
  const resultsDoc = { schemaVersion: 1, analyses: [{ id: "primary", status: "complete", method: "ttest", estimate: 1.25, interval: { lower: 0.8, upper: 1.9 }, pValue: 0.034, n: { a: 120, b: 118 } }] };
  const results = { path: "deliverables/s1/analysis-results.json", bytes: Buffer.from(JSON.stringify(resultsDoc)) };
  const files = { script, data, results };
  await f.write(script.path, script.bytes); await f.write(data.path, data.bytes); await f.write(results.path, results.bytes);
  const record = receipt({ script, inputs: [data], results, ...options });
  await f.write("deliverables/s1/analysis-run.json", JSON.stringify(record));
  return { ...f, files, record, readBytes: (relative, limit) => stableBytes(f.project, relative, limit) };
}

test("an admitted skill script's execution record becomes the results file's producer snapshot, each item re-checked against the bytes readable now", async t => {
  const f = await skillFixture(t);
  const datasets = new DataSemanticsService({ documents: f.documents });
  // N03's transformation record names the script that does the derivation; the snapshot names it by identity and does not restate it.
  await f.documents.put(OWNER, "dataset-semantics", "dsem_1", { schemaVersion: 1, datasetId: "trial-a", title: null, facts: {}, tables: [], joins: [], bindings: [], bindingHistory: [],
    transformations: [{ name: "derive-outcome", kind: "derive", inputs: [{ table: "trial", columns: [] }], code: { path: "analysis.py", sha256: sha(f.files.script.bytes) }, version: 2, recordedAt: "x", history: [] }],
    denominators: {}, lastCheck: null, createdAt: "x", updatedAt: "x" }, { expectedRevision: 0, projectId: "p" });
  const read = await readSkillExecution({ results: f.results, project: f.project, userId: OWNER, receiptPath: "deliverables/s1/analysis-run.json", resultsPath: f.files.results.path,
    readBytes: f.readBytes, transformationsFor: digests => datasets.transformationsByCode(OWNER, "p", digests) });
  assert.equal(read.status, "recorded");
  const { snapshot } = read;
  assert.equal(snapshot.kind, "skill_script");
  assert.equal(snapshot.origin, "receipt_declared", "the receipt is a runtime file: what it states is recorded as stated, and checked");
  assert.equal(snapshot.script.path, "analysis.py");
  assert.equal(snapshot.script.digest, sha(f.files.script.bytes));
  assert.equal(snapshot.script.verified, true);
  assert.equal(snapshot.script.executed, true);
  assert.equal(snapshot.inputs[0].path, "data/trial.csv");
  assert.equal(snapshot.inputs[0].availability, "captured", "the input was preserved as an immutable version");
  assert.equal((await f.results.raw(OWNER, "p", snapshot.inputs[0].versionId)).bytes.toString(), f.files.data.bytes.toString());
  assert.equal(snapshot.environment.facts.interpreter, "3.12.3 (main, Nov 6 2024, 18:32:19) [GCC 13.2.0]");
  assert.deepEqual(snapshot.environment.facts.packages, { numpy: "1.26.4", pandas: "2.2.2" });
  assert.deepEqual(snapshot.transformations, [{ datasetId: "trial-a", name: "derive-outcome", version: 2, codeDigest: sha(f.files.script.bytes) }]);
  assert.deepEqual(snapshot.unknown, ["undeclared_dependencies"], "what the script read beyond its declared input is not known");
  assert.equal(snapshot.process.exitCode, 0);
  assert.ok(!JSON.stringify(snapshot).includes("must-not-be-kept") && !JSON.stringify(snapshot).includes("/usr/bin"), "no command line or interpreter path is kept");
  assert.equal(read.code.availability, "captured");
  assert.ok(read.machineValues.some(value => value.key === "analyses[0].estimate" && value.value === 1.25));
});

test("a script edited after its execution record, or an input gone missing, is recorded as stated and not as verified", async t => {
  const f = await skillFixture(t);
  await f.write("analysis.py", "print('edited afterwards')\n");
  await f.write("data/trial.csv", "id,arm,outcome\n9,a,9\n");
  const read = await readSkillExecution({ results: f.results, project: f.project, userId: OWNER, receiptPath: "deliverables/s1/analysis-run.json", resultsPath: f.files.results.path, readBytes: f.readBytes });
  assert.equal(read.status, "recorded");
  assert.equal(read.snapshot.script.digest, sha(f.files.script.bytes), "the digest the receipt states");
  assert.equal(read.snapshot.script.verified, false);
  assert.equal(read.snapshot.script.executed, false, "an unverified script is not claimed as the one that ran");
  assert.equal(read.snapshot.reproduction, "declared_execution", "the receipt says it ran; the platform could not confirm the bytes");
  assert.equal(read.snapshot.inputs[0].availability, "reference");
  assert.equal(read.snapshot.inputs[0].versionId, null, "the changed input is not preserved as if it were the one the receipt names");
  assert.ok(read.snapshot.unknown.includes("inputs"));
  assert.equal(read.code, null);
  // A results file the receipt does not account for gets no skill snapshot, and says why.
  await f.write(f.files.results.path, "{\"schemaVersion\":1,\"analyses\":[{\"id\":\"x\",\"estimate\":9}]}");
  const stray = await readSkillExecution({ results: f.results, project: f.project, userId: OWNER, receiptPath: "deliverables/s1/analysis-run.json", resultsPath: f.files.results.path, readBytes: f.readBytes });
  assert.deepEqual(stray, { status: "unavailable", reason: "no_execution_produced_these_bytes" });
  await f.write("not-a-receipt.json", "{\"hello\":1}");
  assert.equal((await readSkillExecution({ results: f.results, project: f.project, userId: OWNER, receiptPath: "not-a-receipt.json", resultsPath: "analysis.py", readBytes: f.readBytes })).reason, "not_an_execution_record");
});

test("a delivery with a script's results captures the calculation first, so the report beside it binds its numbers to it", async t => {
  const f = await skillFixture(t);
  const reportText = "# 统计报告\n\n主要分析的估计值为 1.25（95% 置信区间 0.80–1.90），P = 0.034，两组各 120 与 118 例，另有 3.14 未归因。\n";
  await f.write("deliverables/s1/statistical-report.md", reportText);
  const paths = ["deliverables/s1/statistical-report.md", "deliverables/s1/analysis-run.json", f.files.results.path];
  const delivered = await captureResultDelivery({ results: f.results, project: f.project, run: { id: "run-1", sessionId: "s" }, receipt: null, files: paths });
  assert.equal(delivered.failures.length, 0);
  const byPath = Object.fromEntries(delivered.items.map(item => [item.path, item]));
  const calc = byPath[f.files.results.path];
  assert.equal(calc.snapshot.kind, "skill_script");
  assert.equal(calc.coverage.code, "captured", "the script that ran is preserved");
  assert.equal(calc.coverage.inputs, "captured");
  assert.equal(calc.coverage.producer, "observed");
  assert.ok(calc.machineValues.length >= 6);
  const doc = byPath["deliverables/s1/statistical-report.md"];
  assert.deepEqual(doc.bindings.items.map(item => [item.printed, item.calculation.key]).sort(),
    [["0.034", "analyses[0].pValue"], ["0.80", "analyses[0].interval.lower"], ["1.25", "analyses[0].estimate"], ["1.90", "analyses[0].interval.upper"], ["118", "analyses[0].n.b"], ["120", "analyses[0].n.a"]].sort());
  assert.ok(doc.bindings.items.every(item => item.calculation.versionId === calc.versionId));
  assert.deepEqual(doc.bindings.unbound.map(item => item.printed), ["95%", "3.14"]);
  assert.equal(doc.bindings.status, "partly_bound");
  assert.equal(byPath["deliverables/s1/analysis-run.json"].bindings.status, "not_checked", "a JSON record is not a report to be read for numbers");
});
