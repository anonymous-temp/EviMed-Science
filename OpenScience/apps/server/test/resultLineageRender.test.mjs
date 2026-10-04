import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultLineageService } from "../src/resultLineage.mjs";
import { createResultGateway } from "../src/resultGateway.mjs";
import { createResultProvenanceRoutes } from "../src/resultProvenanceRoutes.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const OWNER = "owner";
const PRODUCER = { sessionId: "session-1", callId: "call-render", runId: "run-1" };
const POOLED = [
  { key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio" },
  { key: "values.ci_lower", value: 0.5201, unit: "odds_ratio" },
  { key: "values.ci_upper", value: 0.9087, unit: "odds_ratio" },
  { key: "values.i_squared", value: 41.234, unit: "percent" },
];
const TEMPLATE = "# 结果\n\n合并 OR 为 {{n:pool.values.pooled_effect|f2}}（95% 置信区间 {{n:pool.values.ci_lower|f2}}–{{n:pool.values.ci_upper|f2}}），I² 为 {{n:pool.values.i_squared|pct1}}。\n";

async function fixture(t) {
  const root = await mkdtemp("/tmp/evimed-lineage-render-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: OWNER, rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const documents = productDocumentsDouble();
  const results = new ResultProvenanceService({ documents, authorizeProject: async () => project, authorizeReference: async (_actor, _project, reference) => reference });
  const mirrored = [];
  const lineage = new ResultLineageService({ results, replays: null, config: {}, mirror: async (_project, full, bytes) => { mirrored.push([full, bytes.toString()]); } });
  const write = async (relative, content) => { await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(project.workspaceDir, relative), content); };
  const calculation = async (relative, values, producer = { sessionId: "session-1", runId: "run-1", callId: `calc-${relative}` }) => {
    const body = JSON.stringify({ values });
    await write(relative, body);
    return results.captureFile({ userId: OWNER, project, relativePath: relative, expectedDigest: sha(body), machineValues: values, producer: { kind: "tool", eventId: producer.callId, ...producer } });
  };
  /** The template as the run's own native write is captured. */
  const template = async (relative, body) => {
    await write(relative, body);
    return results.captureFile({ userId: OWNER, project, relativePath: relative, expectedDigest: sha(body), producer: { kind: "tool", sessionId: "session-1", runId: "run-1", callId: `write-${relative}`, eventId: "1" } });
  };
  return { project, documents, results, lineage, write, calculation, template, mirrored };
}

test("the platform writes a report's numbers from the calculation's machine values into a new file, and each one is bound", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED);
  const written = await f.template("reports/template.md", TEMPLATE);
  const out = await f.lineage.render(OWNER, f.project, { templatePath: "reports/template.md", outputPath: "reports/report.md", calculations: { pool: { versionId: calc.versionId } } }, PRODUCER);
  const text = await readFile(path.join(f.project.workspaceDir, "reports/report.md"), "utf8");
  assert.equal(text, "# 结果\n\n合并 OR 为 0.71（95% 置信区间 0.52–0.91），I² 为 41.2%。\n", "the printed number is the machine value, in the recorded format");
  assert.deepEqual(f.mirrored.map(([, bytes]) => bytes), [text], "the runtime sees the file the platform wrote");
  assert.equal(out.state, "rendered");
  assert.equal(out.id, out.versionId);
  assert.deepEqual(out.counts, { bound: 4, rendered: 4, unbound: 1, ambiguous: 0, unresolved: 0 });
  assert.deepEqual(out.unbound, [{ printed: "95%", reason: "no_matching_value" }], "the confidence level is a convention, named and not hidden");

  const version = await f.results.get(OWNER, "p", out.versionId);
  assert.equal(version.snapshot.kind, "render");
  assert.equal(version.snapshot.origin, "platform_measured");
  assert.equal(version.coverage.producer, "bound");
  assert.deepEqual(version.inputs.map(input => input.versionId).sort(), [calc.versionId, written.versionId].sort(), "the template version and the calculation version it was rendered from");
  assert.deepEqual(version.bindings.items.map(item => [item.basis, item.printed, item.calculation.key, item.format.id]),
    [["rendered", "0.71", "values.pooled_effect", "f2"], ["rendered", "0.52", "values.ci_lower", "f2"], ["rendered", "0.91", "values.ci_upper", "f2"], ["rendered", "41.2%", "values.i_squared", "pct1"]]);
  assert.ok(version.bindings.items.every(item => item.calculation.versionId === calc.versionId && item.calculation.digest === calc.digest));
  assert.equal(version.bindings.items[0].calculation.unit, "odds_ratio");
  assert.equal(version.bindings.items[0].calculation.value, 0.7134);
  assert.deepEqual(version.bindings.items[0].locator, { kind: "text", line: 3, column: 8 });
  assert.equal((await f.lineage.describe(OWNER, "p", calc.versionId)).dependents[0].versionId, out.versionId);
  assert.equal((await f.lineage.describe(OWNER, "p", out.versionId)).role, "report");
});

test("an unresolved reference reads 未计算 and is named, a typed number stays and is checked, and the report is delivered either way", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED);
  await f.template("t.md", "OR {{n:pool.values.pooled_effect|f2}}，缺 {{n:pool.values.nothing|f2}}，别名 {{n:nopool.values.x|f2}}，手写 17.5 与 0.52。\n");
  const out = await f.lineage.render(OWNER, f.project, { templatePath: "t.md", outputPath: "r.md", calculations: { pool: { versionId: calc.versionId } } }, PRODUCER);
  assert.equal(await readFile(path.join(f.project.workspaceDir, "r.md"), "utf8"), "OR 0.71，缺 未计算，别名 未计算，手写 17.5 与 0.52。\n", "never a zero, and the researcher's own digits are not deleted");
  assert.deepEqual(out.unresolved, [{ path: "pool.values.nothing", reason: "no_such_value" }, { path: "nopool.values.x", reason: "no_such_value" }]);
  const version = await f.results.get(OWNER, "p", out.versionId);
  assert.equal(version.bindings.status, "partly_bound");
  assert.deepEqual(version.bindings.items.map(item => [item.basis, item.printed]), [["rendered", "0.71"], ["matched", "0.52"]]);
  assert.deepEqual(version.bindings.unbound.map(item => item.printed), ["17.5"]);
  assert.ok(version.coverage.gaps.includes("values_unresolved") && version.coverage.gaps.includes("values_unbound"));
});

test("a render never overwrites: an existing output, an unreadable template and a calculation with no values are refused by name before anything is written", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED);
  await f.template("t.md", TEMPLATE);
  const request = { templatePath: "t.md", outputPath: "r.md", calculations: { pool: { versionId: calc.versionId } } };
  await f.write("existing.md", "keep me");
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, outputPath: "existing.md" }, PRODUCER), { code: "result_render_output_exists" });
  assert.equal(await readFile(path.join(f.project.workspaceDir, "existing.md"), "utf8"), "keep me");
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, templatePath: "missing.md" }, PRODUCER), { code: "result_render_template_unavailable" });
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, outputPath: "t.md" }, PRODUCER), { code: "result_render_invalid" });
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, outputPath: "../escape.md" }, PRODUCER), { code: "result_render_invalid" });
  const plain = await f.template("plain.md", "no values here");
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, calculations: { pool: { versionId: plain.versionId } } }, PRODUCER), { code: "result_render_calculation_unavailable" });
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, calculations: { pool: { jobId: `replay_${"a".repeat(64)}` } } }, PRODUCER), { code: "result_render_calculation_unavailable" });
  await assert.rejects(f.lineage.render(OWNER, f.project, { ...request, calculations: {} }, PRODUCER), { code: "result_render_invalid" });
  assert.deepEqual(f.mirrored, [], "nothing was written for any refusal");
  await assert.rejects(readFile(path.join(f.project.workspaceDir, "r.md")), { code: "ENOENT" });
  // A second render into the first one's output is the same refusal: the old bytes are never replaced.
  await f.lineage.render(OWNER, f.project, request, PRODUCER);
  await assert.rejects(f.lineage.render(OWNER, f.project, request, { ...PRODUCER, callId: "call-again" }), { code: "result_render_output_exists" });
});

test("rendering again against a successor calculation writes a new report; the first keeps its numbers and its binding", async t => {
  const f = await fixture(t);
  const first = await f.calculation("analysis/pooled.json", POOLED);
  await f.template("t.md", TEMPLATE);
  const r1 = await f.lineage.render(OWNER, f.project, { templatePath: "t.md", outputPath: "r1.md", calculations: { pool: { versionId: first.versionId } } }, PRODUCER);
  const second = await f.calculation("analysis/pooled.json", POOLED.map(value => value.key === "values.pooled_effect" ? { ...value, value: 0.6612 } : value),
    { sessionId: "session-1", runId: "run-2", callId: "calc-2" });
  const rerun = await f.results.get(OWNER, "p", second.versionId);
  assert.equal(rerun.artifactId, first.artifactId, "the same results file, written again");
  const r2 = await f.lineage.render(OWNER, f.project, { templatePath: "t.md", outputPath: "r2.md", calculations: { pool: { versionId: second.versionId } } }, { ...PRODUCER, callId: "call-render-2", runId: "run-2" });
  assert.match(await readFile(path.join(f.project.workspaceDir, "r2.md"), "utf8"), /OR 为 0\.66/);
  assert.match(await readFile(path.join(f.project.workspaceDir, "r1.md"), "utf8"), /OR 为 0\.71/, "the first report is untouched");
  const v1 = await f.results.get(OWNER, "p", r1.versionId);
  const v2 = await f.results.get(OWNER, "p", r2.versionId);
  assert.ok(v1.bindings.items.every(item => item.calculation.versionId === first.versionId));
  assert.ok(v2.bindings.items.every(item => item.calculation.versionId === second.versionId));
  assert.equal((await f.lineage.describe(OWNER, "p", first.versionId)).dependents.length, 1, "each calculation is printed by exactly its own report");
  assert.equal((await f.lineage.describe(OWNER, "p", second.versionId)).dependents[0].versionId, r2.versionId);
});

test("a results file and the receipt of the script that wrote it are captured as a calculation by the render, once", async t => {
  const f = await fixture(t);
  const doc = { schemaVersion: 1, analyses: [{ id: "primary", status: "complete", estimate: 1.25, interval: { lower: 0.8, upper: 1.9 }, pValue: 0.034 }] };
  const resultsBytes = Buffer.from(JSON.stringify(doc));
  const scriptBytes = Buffer.from("print('x')\n");
  const snap = (relative, bytes) => ({ path: relative, sha256: sha(bytes), size: bytes.length });
  await f.write("analysis-results.json", resultsBytes); await f.write("analysis.py", scriptBytes); await f.write("data.csv", "a,b\n1,2\n");
  await f.write("analysis-run.json", JSON.stringify({ schemaVersion: 1, executions: [{ id: "e", argv: ["python"], script: snap("analysis.py", scriptBytes), inputs: [snap("data.csv", Buffer.from("a,b\n1,2\n"))], transforms: [],
    versions: { interpreter: "3.12", libraries: { pandas: "2" } }, exitCode: 0, startedAt: "2026-10-04T10:00:00+00:00", endedAt: "2026-10-04T10:00:01+00:00",
    output: { before: null, after: snap("analysis-results.json", resultsBytes), observation: "created", observedWrite: true }, sourcesUnchanged: true }] }));
  await f.template("report.template.md", "估计值 {{n:stat.analyses[0].estimate|f2}}，区间 {{n:stat.analyses[0].interval.lower|f2}}–{{n:stat.analyses[0].interval.upper|f2}}，P {{n:stat.analyses[0].pValue|f3}}。\n");
  const calculations = { stat: { resultsPath: "analysis-results.json", receiptPath: "analysis-run.json" } };
  const out = await f.lineage.render(OWNER, f.project, { templatePath: "report.template.md", outputPath: "statistical-report.md", calculations }, PRODUCER);
  assert.equal(await readFile(path.join(f.project.workspaceDir, "statistical-report.md"), "utf8"), "估计值 1.25，区间 0.80–1.90，P 0.034。\n");
  const report = await f.results.get(OWNER, "p", out.versionId);
  const calc = await f.results.get(OWNER, "p", report.bindings.calculations[0].versionId);
  assert.equal(calc.path, "analysis-results.json");
  assert.equal(calc.snapshot.kind, "skill_script");
  assert.equal(calc.snapshot.script.verified, true);
  assert.equal(calc.snapshot.inputs[0].availability, "captured");
  assert.equal(calc.code.availability, "captured");
  assert.deepEqual(report.bindings.items.map(item => [item.printed, item.calculation.key]),
    [["1.25", "analyses[0].estimate"], ["0.80", "analyses[0].interval.lower"], ["1.90", "analyses[0].interval.upper"], ["0.034", "analyses[0].pValue"]]);
  // The same results file named again is the same calculation, not a second identity for it.
  await f.template("again.md", "{{n:stat.analyses[0].estimate|f1}}");
  const again = await f.lineage.render(OWNER, f.project, { templatePath: "again.md", outputPath: "again-out.md", calculations }, { ...PRODUCER, callId: "call-2" });
  assert.equal((await f.results.get(OWNER, "p", again.versionId)).bindings.calculations[0].versionId, calc.versionId);
});

test("the gateway renders only for the native call that asked, with the paths and calculations that call named", async t => {
  const project = { id: "p", userId: "owner" };
  const request = { templatePath: "t.md", outputPath: "r.md", calculations: { pool: { versionId: `rv_${"a".repeat(64)}` } } };
  const context = { v: 1, sessionId: "session-1", callId: "call-1" };
  let rendered;
  const build = (input, lineage) => createResultGateway({ store: { userById: async () => ({ id: "owner" }), requireProject: async () => project },
    agentRuns: { activeRuns: async () => [{ id: "run-1", sessionId: "session-1" }] }, resolveSession: () => null,
    runtimeManager: { assertActiveModelGatewayToken: () => ({ userId: "owner", projectId: "p" }),
      sessionTranscript: async (_project, sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }], messages: [{ turnStartSeq: 1,
        parts: [{ type: "tool", callId: "call-1", tool: "mcp__evimed__research_calculate", status: "pending", input }] }] }) },
    service: {}, lineage });
  const send = async (handler, body, operation = "render") => {
    const server = createServer((req, res) => { void handler(req, res); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      return await fetch(`http://127.0.0.1:${server.address().port}/internal/results/v1/${operation}`, { method: "POST",
        headers: { authorization: "Bearer owned-workload", "content-type": "application/json", "x-evimed-execution-context": JSON.stringify(context) }, body: JSON.stringify(body) });
    } finally { await new Promise(resolve => server.close(resolve)); }
  };
  const lineage = { render: async (_user, owned, input, origin, revalidate) => { await revalidate(); rendered = { owned, input, origin }; return { id: `rv_${"b".repeat(64)}`, state: "rendered" }; } };
  const ok = await send(build({ ...request, action: "render" }, lineage), request);
  assert.equal(ok.status, 200);
  assert.deepEqual(rendered.origin, { sessionId: "session-1", callId: "call-1", runId: "run-1", parentSessionId: null, branchId: null });
  assert.deepEqual(rendered.input, request);
  rendered = null;
  // The native call named other paths or other calculations than the request: it is not that call's render.
  const other = await send(build({ ...request, outputPath: "other.md", action: "render" }, lineage), request);
  assert.equal(other.status, 403);
  assert.equal((await other.json()).code, "result_invocation_unavailable");
  const swapped = await send(build({ ...request, calculations: { pool: { versionId: `rv_${"c".repeat(64)}` } }, action: "render" }, lineage), request);
  assert.equal(swapped.status, 403);
  const notRender = await send(build({ method: "meta.dl", inputPath: "x.json", action: "start" }, lineage), request);
  assert.equal(notRender.status, 403, "a start call is not authority to render");
  const extra = await send(build({ ...request, action: "render" }, lineage), { ...request, secret: "x" });
  assert.equal(extra.status, 400);
  assert.equal(rendered, null);
  const unconfigured = await send(build({ ...request, action: "render" }, null), request);
  assert.equal(unconfigured.status, 503);
});

test("the lineage route is read-only, authenticated and project-scoped", async () => {
  const seen = [];
  const store = { ensureSessionUser: async () => ({ user: { id: "alice" } }), requireProject: async (_user, id) => { seen.push(["project", id]); } };
  const lineage = { describe: async (...args) => { seen.push(["describe", ...args]); return { versionId: args[2], role: "report", calculations: [], dependents: [], changes: [] }; } };
  const route = createResultProvenanceRoutes({ store, service: {}, lineage });
  const invoke = async (url, method = "GET") => {
    const req = Readable.from([]); Object.assign(req, { url, method, headers: {} });
    let output; let status;
    const res = { writeHead(code) { status = code; }, end(value) { output = JSON.parse(value); } };
    const handled = await route(req, res); return { handled, status, output };
  };
  const version = `rv_${"a".repeat(64)}`;
  const read = await invoke(`/api/results/${version}/lineage?projectId=p`);
  assert.equal(read.status, 200);
  assert.equal(read.output.data.role, "report");
  assert.deepEqual(seen, [["project", "p"], ["describe", "alice", "p", version]]);
  assert.equal((await invoke(`/api/results/${version}/lineage?projectId=p`, "POST")).handled, false, "a browser cannot write lineage");
  await assert.rejects(invoke("/api/results/not-a-version/lineage?projectId=p"), { code: "result_identifier_invalid" });
  await assert.rejects(invoke(`/api/results/${version}/lineage`), { code: "project_required" });
  const bare = createResultProvenanceRoutes({ store, service: {} });
  await assert.rejects(Promise.resolve().then(async () => { const req = Readable.from([]); Object.assign(req, { url: `/api/results/${version}/lineage?projectId=p`, method: "GET", headers: {} }); return bare(req, { writeHead() {}, end() {} }); }), { code: "result_storage_unavailable" });
});
