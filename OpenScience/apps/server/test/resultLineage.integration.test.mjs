import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { engineJobSnapshot } from "@evimed/domain";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService } from "../src/resultReplayService.mjs";
import { ResultLineageService } from "../src/resultLineage.mjs";
import { captureFinishedRun } from "../src/resultDeliveryCapture.mjs";
import { createResultProducerCapture } from "../src/resultProducerCapture.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 30000 };
const sha = value => createHash("sha256").update(value).digest("hex");

const POOLED = [
  { key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio" },
  { key: "values.ci_lower", value: 0.5201, unit: "odds_ratio" },
  { key: "values.i_squared", value: 41.234, unit: "percent" },
];

/** The result store on PostgreSQL's own jsonb containment, the lookups the lineage view depends on. */
async function fixture(t) {
  const isolated = await createGeoTestDatabase(databaseUrl, "lin");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-lineage-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true, maxProjectBytes: 32 * 1024 * 1024 });
  const store = new PostgresStore(config);
  t.after(async () => { await store.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await store.devUser(); const project = await store.requireProject(user, "default");
  await mkdir(project.workspaceDir, { recursive: true });
  const documents = new ProductDocuments(store.database); const jobs = new ProductJobs(store.database);
  const results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => store.requireProject(await store.userById(actor), id),
    authorizeReference: async (_actor, _project, reference) => reference });
  const engine = { configured: () => true, capabilities: async () => ({ methods: [] }) };
  const replays = new ResultReplayService({ results, documents, jobs, engine, config });
  const lineage = new ResultLineageService({ results, replays, config });
  const write = async (relative, content) => { await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(project.workspaceDir, relative), content); };
  let call = 0;
  const capture = async (relative, content, { runId = "run-1", sessionId = "session-1", extra = {} } = {}) => {
    await write(relative, content);
    const callId = `call-${++call}`;
    return results.captureFile({ userId: user.id, project, relativePath: relative, expectedDigest: sha(content), producer: { kind: "tool", sessionId, runId, callId, eventId: callId }, ...extra });
  };
  return { user, project, documents, results, replays, lineage, write, capture, store };
}

test("on PostgreSQL: the versions printed from a calculation, a successor's reach and an unrelated version are found by containment", options, async t => {
  const f = await fixture(t); const uid = f.user.id;
  const body = JSON.stringify({ values: POOLED });
  const calc = await f.capture("analysis/pooled.json", body, { extra: { machineValues: POOLED } });
  await f.capture("table.csv", "measure,value\nOR,0.7134\n");
  const report = await f.capture("report.md", "合并 OR 为 0.71，下限 0.52，I² 41.2%。另有 3.14。");
  const unrelated = await f.capture("methods.md", "纳入 3 项试验。");
  assert.equal(report.bindings.status, "partly_bound");
  const rerun = await f.capture("analysis/pooled.json", JSON.stringify({ values: [{ ...POOLED[0], value: 0.6612 }, POOLED[1], POOLED[2]] }),
    { runId: "run-2", extra: { machineValues: [{ ...POOLED[0], value: 0.6612 }, POOLED[1], POOLED[2]], supersedesVersionId: calc.versionId } });
  const view = await f.lineage.describe(uid, f.project.id, calc.versionId);
  assert.deepEqual(view.dependents.map(item => item.path).sort(), ["report.md", "table.csv"]);
  assert.ok(!view.dependents.some(item => item.versionId === unrelated.versionId));
  assert.equal(view.changes[0].successorVersionId, rerun.versionId);
  const byPath = Object.fromEntries(view.changes[0].dependents.map(row => [row.path, row]));
  assert.deepEqual(byPath["report.md"].affected.map(item => [item.key, item.printedNow]), [["values.pooled_effect", "0.66"]]);
  assert.equal(byPath["report.md"].unchanged, 2, "the other two printed values still print the same words");
  const fromReport = await f.lineage.describe(uid, f.project.id, report.versionId);
  assert.equal(fromReport.role, "report");
  assert.equal(fromReport.changes[0].dependents[0].versionId, report.versionId);
  assert.equal((await f.lineage.describe(uid, f.project.id, unrelated.versionId)).role, "none");
});

test("on PostgreSQL: a calculation run again on a changed input of the same conversation is found as its predecessor", options, async t => {
  const f = await fixture(t); const uid = f.user.id;
  const captureCalc = async (inputBytes, effect, sessionId, callId) => {
    const input = await f.capture("input.json", inputBytes, { sessionId, runId: `run-${callId}` });
    const recipe = { method: "meta.dl", version: "1", parameters: {}, codeDigest: "c".repeat(64), environmentDigest: "e".repeat(64), input: { path: "input.json", sha256: input.digest } };
    const inputs = [{ kind: "data", id: input.versionId, versionId: input.versionId, digest: input.digest, availability: "captured" }];
    const values = [{ key: "values.pooled_effect", value: effect }];
    await f.write(`out-${callId}.json`, JSON.stringify({ values }));
    const version = await f.results.captureFile({ userId: uid, project: f.project, relativePath: `out-${callId}.json`, expectedDigest: sha(JSON.stringify({ values })),
      producer: { kind: "engine", sessionId, callId, runId: `run-${callId}` }, inputs, machineValues: values, snapshot: engineJobSnapshot({ recipe, inputs }) });
    return { input, version };
  };
  const first = await captureCalc('{"studies":[1]}', 0.7134, "native-session", "c1");
  await f.write("input.json", '{"studies":[1,2]}');
  const changed = await f.results.captureFile({ userId: uid, project: f.project, relativePath: "input.json", expectedDigest: sha('{"studies":[1,2]}'),
    producer: { kind: "tool", sessionId: "native-session", runId: "run-c2", callId: "in-c2", eventId: "in-c2" } });
  assert.equal(changed.artifactId, first.input.artifactId, "the same input file, a new version of it");
  assert.equal(await f.replays.previousCalculation(uid, f.project, { method: "meta.dl", inputVersion: changed, producer: { sessionId: "native-session" } }), first.version.versionId);
  assert.equal(await f.replays.previousCalculation(uid, f.project, { method: "meta.dl", inputVersion: changed, producer: { sessionId: "another-session" } }), null);
  assert.equal(await f.replays.previousCalculation(uid, f.project, { method: "faers.signals", inputVersion: changed, producer: { sessionId: "native-session" } }), null);
  assert.equal(await f.replays.previousCalculation(uid, f.project, { method: "meta.dl", inputVersion: changed, producer: { sessionId: "fork", parentSessionId: "native-session" } }), first.version.versionId);
});

test("on PostgreSQL: the end of a run binds the reports it wrote first, as a new revision of their rows", options, async t => {
  const f = await fixture(t); const uid = f.user.id;
  const doc = { schemaVersion: 1, analyses: [{ id: "primary", status: "complete", estimate: 1.25, interval: { lower: 0.8, upper: 1.9 }, pValue: 0.034 }] };
  const resultsBytes = Buffer.from(JSON.stringify(doc)); const scriptBytes = Buffer.from("print(1)\n"); const dataBytes = Buffer.from("a,b\n1,2\n");
  const snap = (relative, bytes) => ({ path: relative, sha256: sha(bytes), size: bytes.length });
  await f.write("analysis-results.json", resultsBytes); await f.write("analysis.py", scriptBytes); await f.write("data.csv", dataBytes);
  await f.write("analysis-run.json", JSON.stringify({ schemaVersion: 1, executions: [{ id: "e", script: snap("analysis.py", scriptBytes), inputs: [snap("data.csv", dataBytes)], transforms: [],
    versions: { interpreter: "3.12", libraries: { pandas: "2" } }, exitCode: 0, startedAt: "2026-10-04T10:00:00+00:00", endedAt: "2026-10-04T10:00:01+00:00",
    output: { before: null, after: snap("analysis-results.json", resultsBytes), observation: "created", observedWrite: true }, sourcesUnchanged: true }] }));
  const text = "估计值 1.25，区间 0.80–1.90，P = 0.034。";
  const capture = createResultProducerCapture({ service: f.results });
  await f.write("statistical-report.md", text);
  await capture.observe(f.project, "run-1", { sessionId: "session-1", event: { type: "tool/call", tool: "write", callId: "w1", seq: 1, input: { file_path: "statistical-report.md", content: text } } });
  const early = await capture.observe(f.project, "run-1", { sessionId: "session-1", event: { type: "tool/result", callId: "w1", status: "completed", seq: 2 } });
  assert.equal(early.bindings.status, "no_calculation");
  const run = { id: "run-1", sessionId: "session-1", artifacts: ["statistical-report.md", "analysis-results.json", "analysis-run.json", "analysis.py"] };
  const finished = await captureFinishedRun({ results: f.results, project: f.project, run, readReceipt: async () => null });
  assert.deepEqual(finished.failures, []);
  const report = await f.results.get(uid, f.project.id, early.versionId);
  assert.equal(report.digest, early.digest);
  assert.equal(report.bindings.status, "bound");
  assert.equal(report.bindings.items.length, 4);
  const calc = (await f.results.query(uid, f.project.id, { path: "analysis-results.json", hasMachineValues: true })).items[0];
  assert.equal(calc.snapshot.kind, "skill_script");
  assert.deepEqual((await f.lineage.describe(uid, f.project.id, calc.versionId)).dependents.map(item => item.path), ["statistical-report.md"]);
  const revisions = (await f.documents.history(uid, "result-version", early.versionId)).map(row => row.payload.bindings.status);
  assert.deepEqual(revisions, ["bound", "no_calculation"], "the ledger kept the row the annotation replaced");
});

test("on PostgreSQL: a render reads the template, writes a new file and records its bindings; a second render into it is refused", options, async t => {
  const f = await fixture(t); const uid = f.user.id;
  const calc = await f.capture("analysis/pooled.json", JSON.stringify({ values: POOLED }), { extra: { machineValues: POOLED } });
  await f.capture("template.md", "OR {{n:pool.values.pooled_effect|f2}}，I² {{n:pool.values.i_squared|pct1}}，缺 {{n:pool.nothing|f2}}。\n");
  const request = { templatePath: "template.md", outputPath: "report.md", calculations: { pool: { versionId: calc.versionId } } };
  const origin = { sessionId: "session-1", callId: "render-1", runId: "run-1" };
  const out = await f.lineage.render(uid, f.project, request, origin);
  assert.equal(out.counts.rendered, 2);
  assert.deepEqual(out.unresolved, [{ path: "pool.nothing", reason: "no_such_value" }]);
  const version = await f.results.get(uid, f.project.id, out.versionId);
  assert.equal(version.snapshot.kind, "render");
  assert.equal(version.inputs.length, 2);
  assert.deepEqual((await f.lineage.describe(uid, f.project.id, calc.versionId)).dependents.map(item => item.versionId), [out.versionId]);
  await assert.rejects(f.lineage.render(uid, f.project, request, { ...origin, callId: "render-2" }), { code: "result_render_output_exists" });
});
