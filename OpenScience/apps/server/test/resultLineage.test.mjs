import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultLineageService } from "../src/resultLineage.mjs";
import { createResultProducerCapture } from "../src/resultProducerCapture.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { captureResultDelivery } from "../src/resultDeliveryCapture.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const OWNER = "owner";

/** One project, the result store on its in-memory ledger, and the lineage service over it. */
async function fixture(t) {
  const root = await mkdtemp("/tmp/evimed-lineage-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: OWNER, rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const documents = productDocumentsDouble();
  const results = new ResultProvenanceService({ documents, authorizeProject: async () => project, authorizeReference: async (_actor, _project, reference) => reference });
  const lineage = new ResultLineageService({ results, replays: null, config: {} });
  const write = async (relative, content) => { await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(project.workspaceDir, relative), content); };
  let call = 0;
  /** A file the run wrote through a native write call, in run `runId`. */
  const capture = async (relative, content, { runId = "run-1", extra = {}, callId = `call-${++call}` } = {}) => {
    await write(relative, content);
    return results.captureFile({ userId: OWNER, project, relativePath: relative, expectedDigest: sha(content),
      producer: { kind: "tool", sessionId: "session-1", runId, callId, eventId: callId }, ...extra });
  };
  /** A calculation: a version that carries machine values, as an engine job's output does. */
  const calculation = (relative, values, options = {}) => capture(relative, JSON.stringify({ values }), { ...options, extra: { machineValues: values, ...(options.extra ?? {}) } });
  return { project, documents, results, lineage, write, capture, calculation };
}

const POOLED = [
  { key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio" },
  { key: "values.ci_lower", value: 0.5201, unit: "odds_ratio" },
  { key: "values.ci_upper", value: 0.9087, unit: "odds_ratio" },
  { key: "values.i_squared", value: 41.234, unit: "percent" },
];
const report = (effect = "0.71", extra = "") => `# 结果\n\n合并 OR 为 ${effect}（95% 置信区间 0.52–0.91），I² 为 41.2%。${extra}\n`;

test("a report is bound to the calculation of its own run by the values it prints, and a number nothing computed is labelled, not refused", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED);
  assert.equal(calc.bindings.status, "not_checked", "a calculation's own numbers are its values, not claims to be checked");
  const typed = await f.capture("report.md", report("0.71", "另有 3.14 例未归因。"));
  assert.equal(typed.bindings.status, "partly_bound");
  assert.deepEqual(typed.bindings.items.map(item => [item.calculation.key, item.printed, item.format]).sort(),
    [["values.ci_lower", "0.52", { id: "round", places: 2 }], ["values.ci_upper", "0.91", { id: "round", places: 2 }],
      ["values.i_squared", "41.2%", { id: "round", places: 1 }], ["values.pooled_effect", "0.71", { id: "round", places: 2 }]]);
  assert.ok(typed.bindings.items.every(item => item.calculation.versionId === calc.versionId && item.calculation.digest === calc.digest));
  assert.equal(typed.bindings.items.find(item => item.printed === "0.71").calculation.value, 0.7134, "the machine value, not the rounding, is what the binding holds");
  assert.deepEqual(typed.bindings.unbound.map(item => [item.printed, item.reason]), [["95%", "no_matching_value"], ["3.14", "no_matching_value"]]);
  assert.ok(typed.coverage.gaps.includes("values_unbound"), "the gap is a label on the version");
  assert.equal((await f.results.raw(OWNER, "p", typed.versionId)).bytes.toString(), report("0.71", "另有 3.14 例未归因。"), "the report was delivered as written");
  // The report that names no calculation value it could be wrong about is not accused of anything.
  const prose = await f.capture("notes.md", "没有数字的说明。");
  assert.equal(prose.bindings.status, "no_numbers");
});

test("a number that is near a value but not equal to it is named as differing, with the value it probably meant", async t => {
  const f = await fixture(t);
  await f.calculation("analysis/pooled.json", POOLED);
  const stale = await f.capture("stale.md", "合并 OR 为 0.73。");
  assert.deepEqual(stale.bindings.items, []);
  assert.deepEqual(stale.bindings.unbound.map(item => [item.printed, item.reason, item.candidates[0].key, item.candidates[0].value]), [["0.73", "differs_from_value", "values.pooled_effect", 0.7134]]);
  assert.equal(stale.bindings.status, "unbound");
});

test("two files from one call each carry their own bindings, and a file from another run is not bound to this run's calculation", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED, { runId: "run-1" });
  const callId = "call-fan-out";
  const md = await f.capture("fan/report.md", report(), { callId });
  const csv = await f.capture("fan/table.csv", "measure,value\nOR,0.7134\nlower,0.5201\n", { callId });
  assert.notEqual(md.versionId, csv.versionId, "a call-level key never discards a second file");
  assert.equal(md.producer.callId, csv.producer.callId);
  assert.deepEqual(csv.bindings.items.map(item => [item.calculation.key, item.locator]), [["values.pooled_effect", { kind: "cell", row: 2, column: 2 }], ["values.ci_lower", { kind: "cell", row: 3, column: 2 }]]);
  assert.ok(md.bindings.items.length >= 3 && csv.bindings.items.length === 2);
  // A branch (another run, another session) never inherits this run's calculation as a dependency of its prose.
  const branch = await f.results.captureFile({ userId: OWNER, project: f.project, relativePath: "fan/report.md", expectedDigest: sha(report()),
    producer: { kind: "tool", sessionId: "fork-1", branchId: "branch", parentSessionId: "session-1", runId: "run-fork", callId: "call-fork" } });
  assert.equal(branch.bindings.status, "no_calculation", "same digest, another run: no calculation of its own to be bound against");
  assert.equal(branch.producer.branchId, "branch");
  assert.notEqual(branch.versionId, md.versionId);
  assert.equal(calc.bindings.status, "not_checked");
});

test("an overwritten report keeps its old bytes and its old bindings, and the new one is bound to what it now prints", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED);
  const first = await f.capture("report.md", report("0.71"));
  const second = await f.capture("report.md", report("0.73"), { callId: "call-overwrite" });
  assert.equal(first.artifactId, second.artifactId, "one artifact, two versions");
  assert.notEqual(first.versionId, second.versionId);
  assert.equal((await f.results.raw(OWNER, "p", first.versionId)).bytes.toString(), report("0.71"));
  const old = await f.results.get(OWNER, "p", first.versionId);
  assert.equal(old.bindings.items.find(item => item.printed === "0.71").calculation.versionId, calc.versionId, "the old version is still bound as it was");
  assert.deepEqual(second.bindings.unbound.map(item => item.printed).filter(printed => printed === "0.73"), ["0.73"]);
  const view = await f.lineage.describe(OWNER, "p", calc.versionId);
  assert.deepEqual(view.dependents.map(item => item.versionId).sort(), [first.versionId, second.versionId].sort(), "both versions print this calculation's values");
});

test("a calculation re-run after its input changed updates only the values bound to it; everything else keeps its identity", async t => {
  const f = await fixture(t);
  const original = await f.calculation("analysis/pooled.json", POOLED);
  const table = await f.capture("table.csv", "measure,value\nOR,0.7134\n");
  const bound = await f.capture("report.md", report("0.71"));
  // A version of this run that prints nothing of the calculation, and a report of another calculation altogether.
  const unrelated = await f.capture("methods.md", "纳入 3 项随机对照试验。");
  const other = await f.calculation("analysis/other.json", [{ key: "values.rate", value: 0.25 }], { runId: "run-2" });
  const otherReport = await f.capture("other.md", "事件率为 0.25。", { runId: "run-2" });

  // The input changed, the calculation was run again: a new version that supersedes the first.
  const rerun = await f.calculation("analysis/pooled.json", [
    { key: "values.pooled_effect", value: 0.7141, unit: "odds_ratio" },   // still prints 0.71
    { key: "values.ci_lower", value: 0.4811, unit: "odds_ratio" },        // now prints 0.48
    { key: "values.ci_upper", value: 0.9087, unit: "odds_ratio" },
    { key: "values.i_squared", value: 41.234, unit: "percent" },
  ], { runId: "run-3", callId: "call-rerun", extra: { supersedesVersionId: original.versionId } });
  assert.equal(rerun.supersedesVersionId, original.versionId);

  const view = await f.lineage.describe(OWNER, "p", original.versionId);
  assert.equal(view.role, "calculation");
  assert.deepEqual(view.dependents.map(item => item.path).sort(), ["report.md", "table.csv"], "the versions bound to it, and no others");
  assert.ok(!view.dependents.some(item => [unrelated.versionId, otherReport.versionId, other.versionId].includes(item.versionId)));
  const [change] = view.changes;
  assert.equal(change.successorVersionId, rerun.versionId);
  const byPath = Object.fromEntries(change.dependents.map(row => [row.path, row]));
  assert.equal(byPath["report.md"].needsSuccessor, true);
  assert.deepEqual(byPath["report.md"].affected.map(item => [item.key, item.status, item.printed, item.printedNow]), [["values.ci_lower", "changed", "0.52", "0.48"]]);
  assert.equal(byPath["report.md"].unchanged, 3, "0.7134 → 0.7141 still prints 0.71: the binding survived the rounding");
  assert.equal(byPath["table.csv"].needsSuccessor, true, "the table printed the full-precision effect, which did move");
  assert.equal(change.summary.dependents, 2);

  // The same question from the report: its calculation has a successor, and this is what it would move in this report.
  const fromReport = await f.lineage.describe(OWNER, "p", bound.versionId);
  assert.equal(fromReport.role, "report");
  assert.deepEqual(fromReport.calculations.map(item => item.versionId), [original.versionId]);
  assert.equal(fromReport.changes[0].dependents[0].versionId, bound.versionId);
  // Nothing was written: every old version still reads as it did.
  for (const version of [original, table, bound, unrelated]) assert.equal((await f.results.get(OWNER, "p", version.versionId)).digest, version.digest);
  assert.equal((await f.lineage.describe(OWNER, "p", unrelated.versionId)).role, "none");
  assert.deepEqual((await f.lineage.describe(OWNER, "p", other.versionId)).changes, []);
});

test("what the platform did not observe stays visible: a deliverable of unknown origin, and code that was written but never run", async t => {
  const f = await fixture(t);
  // A file in a deliverable with no receipt behind it: how it was made (a shell command, say) is not known.
  await f.write("deliverables/d1/summary.md", "汇总。");
  const unreceipted = await captureResultDelivery({ results: f.results, project: f.project, run: { id: "run-1", sessionId: "session-1" }, receipt: null, files: ["deliverables/d1/summary.md"] });
  const version = unreceipted.items[0];
  assert.equal(version.snapshot.kind, "unobserved");
  assert.deepEqual(version.snapshot.unknown, ["script", "inputs", "environment", "undeclared_dependencies"]);
  assert.equal(version.snapshot.recorded, true, "this is a record that nothing was observed, not a missing record");
  assert.ok(version.coverage.gaps.includes("dependencies_not_observed") && version.coverage.gaps.includes("producer_bytes_not_bound"));
  assert.equal(version.snapshot.script, null, "no script is inferred from a neighbouring file");

  // A native write of a script: authored bytes. It is never promoted to an observed execution.
  const events = [];
  const capture = createResultProducerCapture({ service: f.results, onFailure: failure => events.push(failure) });
  const project = f.project;
  await f.write("reproduce.py", "print('0.71')\n");
  const call = { type: "tool/call", tool: "write", callId: "call-script", seq: 1, input: { file_path: "reproduce.py", content: "print('0.71')\n" } };
  await capture.observe(project, "run-1", { sessionId: "session-1", event: call });
  const written = await capture.observe(project, "run-1", { sessionId: "session-1", event: { type: "tool/result", callId: "call-script", status: "completed", seq: 2 } });
  assert.deepEqual(events, []);
  assert.equal(written.snapshot.kind, "authored");
  assert.equal(written.snapshot.reproduction, "generated_not_executed");
  assert.equal(written.snapshot.script.executed, false);
  assert.ok(written.coverage.gaps.includes("code_not_executed"));
  assert.equal(written.code, null, "the version names no code that produced it");
  await f.write("notes.md", "说明");
  const note = await capture.observe(project, "run-1", { sessionId: "session-1", event: { type: "tool/call", tool: "write", callId: "call-note", seq: 3, input: { file_path: "notes.md", content: "说明" } } });
  assert.equal(note, null);
  const noted = await capture.observe(project, "run-1", { sessionId: "session-1", event: { type: "tool/result", callId: "call-note", status: "completed", seq: 4 } });
  assert.equal(noted.snapshot.reproduction, "not_applicable");
});

test("a version captured before any of this was recorded is not retroactively given an execution record", async t => {
  const f = await fixture(t);
  const stored = await f.capture("old.md", "旧结果");
  // What a ledger row written by an earlier release holds: no snapshot, no bindings.
  const row = await f.documents.get(OWNER, "result-version", stored.versionId);
  const { snapshot: _snapshot, bindings: _bindings, bindingSources: _sources, ...legacy } = row.payload;
  await f.documents.put(OWNER, "result-version", stored.versionId, legacy, { expectedRevision: row.revision, projectId: "p" });
  const read = await f.results.get(OWNER, "p", stored.versionId);
  assert.equal(read.snapshot.recorded, false);
  assert.equal(read.snapshot.kind, "unobserved");
  assert.equal(read.bindings.status, "not_checked");
  assert.equal(read.bindings.items.length, 0);
});

test("a revision of one printed number is told which calculation is behind it and which other versions print from it, so only those are rebuilt", async t => {
  const f = await fixture(t);
  const calc = await f.calculation("analysis/pooled.json", POOLED);
  const selected = await f.capture("report.md", report("0.71"));
  const table = await f.capture("table.csv", "measure,value\nOR,0.7134\n");
  const figure = await f.capture("forest.svg", '<svg><text>OR 0.71 [0.52, 0.91]</text></svg>');
  const unrelated = await f.capture("methods.md", "纳入 3 项随机对照试验。");
  const revisions = new ResultRevisionService({ results: f.results, documents: f.documents, lineage: f.lineage });
  const reach = await revisions.reach(OWNER, "p", selected.versionId);
  assert.deepEqual(reach.calculations, [{ versionId: calc.versionId, path: "analysis/pooled.json" }]);
  assert.deepEqual(reach.alsoPrintedFrom.map(item => item.path).sort(), ["forest.svg", "table.csv"], "the other dependents, not the selection itself and not what prints nothing of it");
  assert.ok(![selected.versionId, unrelated.versionId, calc.versionId].some(id => reach.alsoPrintedFrom.some(item => item.versionId === id)));
  assert.equal(reach.alsoPrintedFrom.find(item => item.path === "table.csv").versionId, table.versionId);
  assert.ok(figure.bindings.items.length >= 3, "a vector figure's labels are bound like prose");
  // Selecting the calculation itself reaches everything printed from it.
  const fromCalc = await revisions.reach(OWNER, "p", calc.versionId);
  assert.deepEqual(fromCalc.alsoPrintedFrom.map(item => item.path).sort(), ["forest.svg", "report.md", "table.csv"]);
  // A selection with no numerical chain, and a lineage that cannot be read, leave the selection as it was.
  assert.equal(await revisions.reach(OWNER, "p", unrelated.versionId), null);
  assert.equal(await new ResultRevisionService({ results: f.results, documents: f.documents }).reach(OWNER, "p", selected.versionId), null);
  assert.equal(await new ResultRevisionService({ results: f.results, documents: f.documents, lineage: { describe: async () => { throw new Error("down"); } } }).reach(OWNER, "p", selected.versionId), null);
});
