import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVcrEvidenceSources } from "../src/vcrEvidenceSources.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";

const sha = text => createHash("sha256").update(text).digest("hex");
const TEXT = "Abstract: control response was 40% (95% CI 30% to 50%), n = 100.\nTable 1\n| Variable | Mean | SD |\n| --- | --- | --- |\n| Age | 62 | 8 |\n";
function fixture() {
  const source = { id: `src_${"a".repeat(32)}`, userId: "u1", projectId: "p1", payload: { generation: 2, analysis: { textSha256: sha(TEXT) } } };
  const sources = { async get(userId, id) { assert.equal(userId, "u1"); assert.equal(id, source.id); return source; }, async loadCapture() { return { input: { text: TEXT } }; } };
  const saved = [];
  const pipeline = createVcrEvidencePipeline({ store: { async appendEvidenceItems(input) { saved.push(input); return { ids: ["ev1"] }; } } });
  pipeline.attachSources(createVcrEvidenceSources({ sources }));
  const quote = TEXT.split("\n")[0];
  const item = { literatureSource: { sourceId: source.id, generation: 2, textSha256: sha(TEXT) }, parameter: "response_rate", arm: "control", armRole: "control",
    value: 40, unit: "%", ciLow: 30, ciHigh: 50, sampleSize: 100, quote, locator: { start: 0, end: quote.length }, historicalBaseline: true, evidenceKind: "outcome", endpointKey: "response" };
  return { pipeline, source, sources, saved, item };
}
test("preserved abstract, full text and table quotations become numerical evidence with immutable source identity", async () => {
  const f = fixture();
  assert.equal((await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: f.item })).state, "verified");
  const first = f.saved[0].items[0];
  assert.equal(first.value, 40);
  assert.equal(first.locator.kind, "literature_text");
  assert.equal(first.locator.sourceHash, sha(TEXT));
  assert.equal(first.locator.generation, 2);
  assert.equal(first.locator.unitVerification.status, "verified");
  assert.equal(first.detail.evidenceKind, "outcome");
  assert.equal(first.detail.sourceStanding, "article_reported");
  const quote = "| Age | 62 | 8 |";
  const start = TEXT.indexOf(quote);
  await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: { ...f.item, parameter: "age_mean", value: 62, unit: "year", ciLow: null, ciHigh: null, sampleSize: null, quote,
    locator: { start, end: start + quote.length, tableId: "tbl-1", cell: "B2" }, evidenceKind: "baseline" } });
  const second = f.saved[1].items[0];
  assert.equal(second.value, 62);
  assert.equal(second.locator.materialLocation.table.id, "tbl-1");
  assert.equal(second.locator.cell, undefined, "caller table geometry is replaced by the existing material locator");
  assert.equal(second.detail.evidenceKind, "baseline");
  assert.equal(second.historicalBaseline, true);
});
test("another account/project, stale generation/hash and forged quote offsets cannot establish literature evidence", async () => {
  for (const change of [{ projectId: "p2" }, { item: { literatureSource: { generation: 1 } } }, { item: { literatureSource: { textSha256: "b".repeat(64) } } }, { item: { locator: { start: 1, end: 4 } } }]) {
    const f = fixture();
    const item = change.item ? { ...f.item, ...change.item, literatureSource: { ...f.item.literatureSource, ...change.item.literatureSource } } : f.item;
    await assert.rejects(f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: change.projectId ?? "p1", item }));
    assert.equal(f.saved.length, 0);
  }
  const f = fixture(); f.source.userId = "u2";
  await assert.rejects(f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: f.item }));
});
test("a nearby genuine quotation cannot validate an invented baseline value", async () => {
  const f = fixture();
  const result = await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: { ...f.item, value: 0.99, evidenceKind: "baseline" } });
  assert.equal(result.state, "quote_missing_number");
  assert.equal(f.saved[0].items[0].value, null);
});

test("a reported literature unit is verified in its quotation or an exact companion unit span", async () => {
  const f = fixture();
  const quote = "| Age | 62 | 8 |";
  const start = TEXT.indexOf(quote);
  const item = { ...f.item, parameter: "age.mean", value: 62, unit: "year", quote, ciLow: null, ciHigh: null, sampleSize: null,
    locator: { start, end: start + quote.length }, evidenceKind: "baseline" };
  await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item });
  assert.equal(f.saved[0].items[0].locator.unitVerification.status, "unknown");
  assert.equal(f.saved[0].items[0].value, 62, "the literal remains preserved; an unverified physical unit cannot verify a baseline mapping");
  const pipeline = createVcrEvidencePipeline({ store: { async verifiedItemsById() { return [{ id: "age1", parameter: "age.mean", value: 62, unit: "year", value_source: "extracted",
    locator: f.saved[0].items[0].locator, detail: { evidenceKind: "baseline" } }]; } } });
  const checked = await pipeline.verifyBaselineTable({ userId: "u1", studyId: "s1", baselineTable: [{ variable: "age", mean: 62 }],
    bindings: [{ variable: "age", field: "mean", unit: "year", evidenceId: "age1" }] });
  assert.equal(checked.ok, false);
  assert.equal(checked.issues[0].code, "baseline_source_unit_unverified");
  const withUnit = `${TEXT}\nAge unit: year`;
  f.sources.loadCapture = async () => ({ input: { text: withUnit } });
  f.source.payload.analysis.textSha256 = sha(withUnit);
  const unitStart = withUnit.lastIndexOf("year");
  await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: { ...item,
    literatureSource: { ...item.literatureSource, textSha256: sha(withUnit) }, locator: { ...item.locator,
      parts: { unit: { start: unitStart, end: unitStart + 4, quote: "year" } } } } });
  assert.equal(f.saved[1].items[0].locator.unitVerification.status, "verified");
});

test("dimensionless labels cannot silently replace a source's physical unit", async () => {
  for (const unit of ["proportion", "ratio", "unitless", "count", "1"]) {
    const f = fixture();
    const quote = "Mean age was 62 years, n = 100.";
    f.sources.loadCapture = async () => ({ input: { text: quote } });
    f.source.payload.analysis.textSha256 = sha(quote);
    await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: { ...f.item, parameter: "age.mean", value: 62,
      ciLow: null, ciHigh: null, sampleSize: null, unit, quote, literatureSource: { ...f.item.literatureSource, textSha256: sha(quote) },
      locator: { start: 0, end: quote.length }, evidenceKind: "baseline" } });
    assert.equal(f.saved[0].items[0].locator.unitVerification.status, "unknown", unit);
  }
});

test("review revalidates preserved literature through the same owner, generation, hash and exact span reader", async () => {
  const f = fixture();
  await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: f.item });
  const row = { ...f.saved[0].items[0], id: "ev1" };
  assert.deepEqual(await f.pipeline.verifyPreservedItems({ userId: "u1", projectId: "p1", items: [row] }), ["ev1"]);
  f.source.payload.generation = 3;
  assert.deepEqual(await f.pipeline.verifyPreservedItems({ userId: "u1", projectId: "p1", items: [row] }), []);
});
test("derived article settings identify verified inputs and do not claim reported or transported outcomes", async () => {
  const f = fixture();
  const result = await f.pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", projectId: "p1", item: { ...f.item, value: 0.45, ciLow: null, ciHigh: null, sampleSize: null,
    valueSource: "calculated", locator: { ...f.item.locator, inputs: [{ start: f.item.locator.start, end: f.item.locator.end, quote: f.item.quote, value: 40 }] } } });
  assert.equal(result.state, "verified");
  assert.equal(f.saved[0].items[0].detail.sourceStanding, "article_derived");
  assert.equal(f.saved[0].items[0].detail.verificationScope, "quoted_inputs_only");
  assert.equal(f.saved[0].items[0].historicalBaseline, false);
});

test("a planned registry value remains planned even when the run calls it a historical baseline", async () => {
  const written = [];
  const pipeline = createVcrEvidencePipeline({ store: { async precedentOfStudy() { return { id: "p1", record_text: "Planned enrollment: 100", record_hash: "a".repeat(64) }; },
    async appendEvidenceItems(input) { written.push(input.items[0]); return { ids: ["planned1"] }; } } });
  await pipeline.addEvidenceItem({ userId: "u1", studyId: "s1", item: { registry: "clinicaltrials.gov", registryId: "NCT00000001", parameter: "enrollment", value: 100,
    quote: "Planned enrollment: 100", enrollmentKind: "estimated", historicalBaseline: true, evidenceKind: "design" } });
  assert.equal(written[0].historicalBaseline, false);
  assert.equal(written[0].detail.sourceStanding, "registry_planned");
});

test("literature baseline bindings match the exact statistic, value, unit and authorized evidence version", async () => {
  const rows = [
    { id: "mean", parameter: "age.mean", value: 62, unit: "year", value_source: "extracted", locator: { verification: "verified", sourceId: "src_a" }, detail: { evidenceKind: "baseline", verificationScope: "quotation_and_numbers" } },
    { id: "sd", parameter: "age.sd", value: 8, unit: "year", value_source: "extracted", locator: { verification: "verified", sourceId: "src_a" }, detail: { evidenceKind: "baseline" } },
    { id: "rate", parameter: "female.proportion", value: 40, unit: "%", value_source: "extracted", locator: { verification: "verified", sourceId: "src_a" }, detail: { evidenceKind: "baseline" } },
  ];
  const pipeline = createVcrEvidencePipeline({ store: { async verifiedItemsById({ ids }) { return rows.filter(row => ids.includes(row.id)); } } });
  const input = { userId: "u1", studyId: "s1", baselineTable: [{ variable: "age", mean: 62, sd: 8 }, { variable: "female", proportion: 0.4 }],
    bindings: [{ variable: "age", field: "mean", evidenceId: "mean", unit: "year" }, { variable: "age", field: "sd", evidenceId: "sd", unit: "year" },
      { variable: "female", field: "proportion", evidenceId: "rate", unit: "proportion" }] };
  const checked = await pipeline.verifyBaselineTable(input);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.evidenceIds, ["mean", "sd", "rate"]);
  assert.equal(checked.bindings[2].conversion, "percent_to_proportion");
  for (const invalid of [
    { baselineTable: [{ variable: "age", mean: 63, sd: 8 }, input.baselineTable[1]] },
    { bindings: input.bindings.slice(1) },
    { bindings: input.bindings.map(row => row.evidenceId === "mean" ? { ...row, unit: "month" } : row) },
  ]) assert.equal((await pipeline.verifyBaselineTable({ ...input, ...invalid })).ok, false);
  rows[0].value_source = "calculated"; rows[0].detail.verificationScope = "quoted_inputs_only";
  const derived = await pipeline.verifyBaselineTable(input);
  assert.equal(derived.ok, false);
  assert.ok(derived.issues.some(issue => issue.code === "reported_baseline_required"));
});
