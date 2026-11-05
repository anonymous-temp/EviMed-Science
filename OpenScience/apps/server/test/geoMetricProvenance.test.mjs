import assert from "node:assert/strict";
import { test } from "node:test";
import { GEO_MEASUREMENT_METHOD_VERSION, geoCoverageDifference } from "@evimed/domain";
import { computeRoundCells } from "../src/geoMetricsJob.mjs";
import { geoMetricInputCoverage } from "../src/geoComparison.mjs";
import { resetDerivedMetricCoverage, storedMetricCoverage } from "../src/geoMetricProvenance.mjs";

const fixture = () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({ roundId: "round-a", snapshotId: `s-${index}`, questionId: `q-${index}`,
    groupId: "group-a", pool: "P2", isControl: false, engine: "deepseek", repeatIndex: 0, status: "valid", askedAt: "2026-11-01",
    surface: { mode: "web", newChat: true }, mentionsOurs: false, failureMode: "omitted", facts: { judgedAt: "2026-11-01",
      judgeExtract: { rubricVersion: "test-rubric" }, parserVersion: "test-parser", checks: { judgementCoverage: { status: "complete" } } } }));
  const options = { samplingMode: "recurring", engines: ["deepseek"], competitors: [], owned: {}, arms: { pilot: ["group-a"], control: [] } };
  const selected = { computed: computeRoundCells(rows, options), metricOptions: options };
  const cell = selected.computed.cells.find(cell => cell.scope === "project" && cell.metricId === "M-01");
  const row = { id: "metric-a", user_id: "owner", geo_project_id: "geo-a", round_id: "round-a", method_version: GEO_MEASUREMENT_METHOD_VERSION,
    computation_generation: "generation-a", metric_id: cell.metricId, scope: cell.scope, value: cell.value, numerator: cell.numerator,
    denominator: cell.denominator, status: cell.status, reason: cell.reason };
  const snapshot = { generation: "generation-a", user_id: "owner", geo_project_id: "geo-a", round_id: "round-a",
    payload: { version: 1, rows, options, setVersion: 1 } };
  return { rows, options, selected, cell, row, snapshot };
};

test("frozen coverage verifies the exact cell, generation and tenant rather than current facts", async () => {
  const f = fixture();
  const db = { query: async (_sql, values) => { assert.equal(values[1].length, 1); return { rows: [f.snapshot] }; } };
  const read = row => storedMetricCoverage(db, [row]);
  const coverage = (await read(f.row)).get(f.row.id);
  assert.equal(typeof coverage, "string");
  assert.equal((await read({ ...f.row, value: String(f.row.value) })).get(f.row.id), coverage, "PostgreSQL numeric text is normalized without accepting a changed value");
  assert.ok(coverage.length < 250, "compatibility keys do not disclose question IDs or calculation inputs");
  assert.equal((await read({ ...f.row, value: f.row.value + 1 })).size, 0);
  assert.equal((await read({ ...f.row, computation_generation: "later-generation" })).size, 0);
  assert.equal((await read({ ...f.row, user_id: "another-owner" })).size, 0);
  assert.equal((await read({ ...f.row, geo_project_id: "another-geo" })).size, 0);
  assert.equal((await read({ ...f.row, method_version: "old-method" })).size, 0);
  assert.equal((await read({ ...f.row, computation_generation: null })).size, 0);
});

test("the per-cell basis retains parser, rubric and surface changes and refuses missing judgments", () => {
  const f = fixture();
  const coverage = rows => { const computed = computeRoundCells(rows, f.options); return geoMetricInputCoverage({ computed, metricOptions: f.options },
    computed.cells.find(cell => cell.scope === "project" && cell.metricId === "M-01"), 1); };
  const original = coverage(f.rows);
  const engineCell = f.selected.computed.cells.find(cell => cell.scope === "engine" && cell.metricId === "M-01");
  const engineKey = geoMetricInputCoverage(f.selected, engineCell, 1);
  assert.equal(geoMetricInputCoverage({ ...f.selected, metricOptions: { ...f.options, engines: ["deepseek", "kimi"], arms: { pilot: ["unrelated"], control: [] } } }, engineCell, 1), engineKey,
    "an engine-local reading does not depend on unrelated engines or arm assignments");
  const later = f.rows.map(row => ({ ...row, roundId: "round-b", snapshotId: `later-${row.snapshotId}`, askedAt: "2026-11-02" }));
  assert.equal(coverage(later), original, "repeated observations of the same cohort may be compared");
  for (const mutate of [row => { row.facts.judgedAt = null; }, row => { row.facts.judgeExtract.rubricVersion = null; },
    row => { row.facts.parserVersion = null; }, row => { row.facts.parserVersion = "mixed-parser"; },
    row => { row.facts.judgeExtract.rubricVersion = "mixed-rubric"; }]) {
    const changed = structuredClone(f.rows); mutate(changed[0]); assert.equal(coverage(changed), null);
  }
  // Members are data: an answer fewer (a failed sample) or a mention more moves the number, not the way it was measured.
  assert.equal(coverage(f.rows.slice(1)), original, "a sample that did not answer leaves the measuring method as it was");
  assert.equal(coverage(f.rows.map((row, index) => (index < 3 ? { ...row, mentionsOurs: true } : row))), original, "more mentions are a change of value, not of method");
  assert.equal(coverage(f.rows.map((row, index) => ({ ...row, surface: { mode: "web", newChat: true, transport: "https", signed: true, responseDigest: `d-${index}` } }))), original,
    "a per-response digest is not a sampling surface");
  for (const change of [rows => rows.map(row => ({ ...row, facts: { ...row.facts, parserVersion: "next-parser" } })),
    rows => rows.map(row => ({ ...row, surface: { mode: "web", newChat: false } }))]) {
    const changed = coverage(change(f.rows));
    assert.equal(geoCoverageDifference(original, changed).comparable, false);
  }
});


test("inline owned-source rates include their registered source portfolio in the basis", () => {
  const f = fixture();
  const rows = f.rows.map(row => ({ ...row, citations: [{ url:"https://ours.example/article", domain:"ours.example", inBody:true }], facts: { ...row.facts, retrievalTriggered:true } }));
  const key = owned => {
    const metricOptions = { ...f.options, owned };
    const computed = computeRoundCells(rows,metricOptions);
    const cell = computed.cells.find(cell => cell.metricId === "M-08B" && cell.scope === "project");
    return geoMetricInputCoverage({ computed,metricOptions },cell,1);
  };
  const before = key({ domains:["ours.example"] }), after = key({ domains:["elsewhere.example"] });
  assert.equal(typeof before,"string"); assert.equal(typeof after,"string");
  assert.equal(geoCoverageDifference(before,after).comparable,false);
});

test("coverage retains stable per-engine heterogeneous sampling surfaces", async () => {
  const { geoSelectionCoverage } = await import("../src/geoReadScope.mjs");
  const f = fixture();
  const rows = f.rows.flatMap(row => [
    { ...structuredClone(row), surface: { mode: "web", deep: false, newChat: true, city: "Beijing", measurementContract: { samplingMode: "recurring", repeats: 1, sourceBasis: "answers", metricIds: ["M-01"] } } },
    { ...structuredClone(row), snapshotId: `${row.snapshotId}-kimi`, engine: "kimi", surface: { mode: "web", deep: true, newChat: false, city: "Shanghai", measurementContract: { samplingMode: "recurring", repeats: 1, sourceBasis: "answers", metricIds: ["M-01"] } } },
  ]);
  const options = { ...f.options, engines: ["deepseek", "kimi"] };
  const metric = input => { const computed = computeRoundCells(input, options); const cell = computed.cells.find(item => item.scope === "project" && item.metricId === "M-01"); return geoMetricInputCoverage({ computed, metricOptions: options }, cell, 1); };
  const original = metric(rows), selected = geoSelectionCoverage(rows, 1);
  assert.equal(typeof original, "string"); assert.equal(typeof selected, "string");
  const later = rows.map(row => ({ ...structuredClone(row), roundId: "round-b", snapshotId: `later-${row.snapshotId}` }));
  assert.equal(metric(later), original); assert.equal(geoSelectionCoverage(later, 1), selected);
  const variants = [
    row => { row.surface.deep = !row.surface.deep; }, row => { row.surface.newChat = !row.surface.newChat; },
    row => { row.surface.city = "Elsewhere"; },
    row => { row.surface.measurementContract.repeats = 2; }, row => { row.surface.measurementContract.metricIds = ["M-03"]; },
    row => { row.surface.measurementContract.samplingMode = "one_shot"; }, row => { row.surface.measurementContract.sourceBasis = "changed"; },
  ];
  for (const mutate of variants) {
    const changed = structuredClone(later); mutate(changed[0]);
    assert.notEqual(metric(changed), original); assert.notEqual(geoSelectionCoverage(changed, 1), selected);
  }
  const metadata = structuredClone(later);
  for (const row of metadata) Object.assign(row.surface, { transport: "other", responseDigest: "arbitrary" });
  assert.equal(metric(metadata), original); assert.equal(geoSelectionCoverage(metadata, 1), selected);
  assert.equal(metric([...metadata].reverse()), original, "row ordering is not a sampling change");
  const unknown = structuredClone(later); delete unknown[0].repeatIndex;
  assert.equal(metric(unknown), null); assert.equal(geoSelectionCoverage(unknown, 1), null);
  const conflict = structuredClone(later); const duplicate = structuredClone(conflict[0]);
  duplicate.snapshotId = "conflicting-duplicate"; duplicate.surface.deep = !duplicate.surface.deep; conflict.push(duplicate);
  assert.equal(geoSelectionCoverage(conflict, 1), null, "a contradictory duplicate cannot assert a unique sampling configuration");
});

test("a stored cell's coverage is derived once; the list and the page's poll read it again without the calculation input", async () => {
  resetDerivedMetricCoverage();
  const f = fixture(); let queries = 0;
  const db = { query: async () => { queries += 1; return { rows: [f.snapshot] }; } };
  const first = (await storedMetricCoverage(db, [f.row])).get(f.row.id);
  assert.equal(typeof first, "string"); assert.equal(queries, 1);
  assert.equal((await storedMetricCoverage(db, [f.row])).get(f.row.id), first); assert.equal(queries, 1, "no second read of the snapshot");
  assert.equal((await storedMetricCoverage(db, [{ ...f.row, value: f.row.value + 1 }])).size, 0, "a changed reading is never served from what was derived for another");
  assert.equal(queries, 2);
});
