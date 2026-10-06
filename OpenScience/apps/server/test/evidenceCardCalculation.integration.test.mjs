// A first-hand card stands on a calculation (evidence-flywheel plan §5.1): the zone service refuses an official primary card with
// none and an interpretive card that claims one, and reads the receipts a calculated claim names back through the injected reader,
// so the mark a reader sees is the domain's own comparison and never a stored word. Real PostgreSQL; the reader is the one double.
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const publisher = { id: "publisher" };

const RECEIPT_ID = `rv_${"a".repeat(64)}`;
const RECEIPT = {
  receiptId: RECEIPT_ID, engine: "drug_safety_analysis", method: "faers.signals@1.1.0", inputs: [{ datasetId: "faers-snapshot", hash: "b".repeat(64) }],
  values: [{ key: "values[0].ror.value", value: 2.4012, unit: "ratio" }, { key: "values[0].table.a", value: 1234 }, { key: "values[0].table.b", value: 9000 }, { key: "values[0].table.c", value: 400 }],
};
const calculated = {
  claimId: "CALC-1", claimType: "calculated", claim: "报告比值比（ROR）为 2.40。",
  calculation: { engine: "drug_safety_analysis", method: "faers.signals@1.1.0", receiptId: RECEIPT_ID, inputs: RECEIPT.inputs, valuePath: "values[0].ror.value", machineValue: 2.4012, format: "f2" },
};
const quoted = { claimId: "CLM-1", claimType: "direct", claim: "原文报告了一例。", sourceIndexes: [2], supportQuote: "one case was reported" };
const card = (over = {}) => ({
  title: "药物安全信号", subtype: "academic", summary: "信号，待验证：报告比值比为 2.40。", body: "平台计算的结论。", limitations: "尚未复现。", provenance: "平台议程",
  sources: [{ title: "引擎回执", url: null, excerpt: "values[0].ror.value\t2.4012\tratio" }, { title: "Report", url: "https://example.org/report", excerpt: "one case was reported" }],
  content: { question: "有什么信号？", answer: "信号，待验证：报告比值比为 2.40。" }, state: "published", claims: [calculated, quoted], originality: "original_analysis", ...over,
});

let isolated, db, plain, reading, receipts;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "evidencecalc");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('publisher','Platform publisher','development')");
  receipts = new Map([[RECEIPT_ID, RECEIPT]]);
  plain = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
  reading = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher", calculationReceipts: { get: async (id) => receipts.get(id) ?? null } });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  receipts.set(RECEIPT_ID, RECEIPT);
});

const officialZone = async () => {
  const { zone } = await plain.saveEditorial(publisher, { title: "Official", description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  return (await plain.saveEditorial(publisher, { expectedRevision: zone.revision, state: "published" }, zone.id, null, false, "programme")).zone;
};
const userZone = async () => {
  const { zone } = await plain.save(alice, { title: "Mine", description: "d", background: "b" });
  return (await plain.save(alice, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
};
const refusedWith = (code) => (error) => error?.code === code;
let seed = 0;
const official = (zone, fields) => plain.saveEditorial(publisher, { requestId: `calc-card-${++seed}`, ...card(fields) }, zone.id, null, true, "programme").then((result) => result.evidence);

test("an official card of primary originality with no calculated claim is refused by name, and one with a calculation is saved", options, async () => {
  const zone = await officialZone();
  for (const originality of ["original_analysis", "recalculation", "original_research"]) {
    await assert.rejects(() => official(zone, { originality, claims: [quoted] }), refusedWith("evidence_primary_requires_calculation"), originality);
  }
  await assert.rejects(() => official(zone, { claims: [] }), refusedWith("evidence_primary_requires_calculation"), "no claims at all is no calculation");
  const saved = await official(zone, {});
  assert.equal(saved.originality, "original_analysis");
  assert.deepEqual(saved.claims.map((claim) => claim.claimType), ["calculated", "direct"]);
  assert.equal(saved.claims[0].valueSource, "calculated", "stored with its label");
});

test("interpretation never claims a calculation, in any zone; a researcher's own zone keeps its own rules for first-hand work", options, async () => {
  const official1 = await officialZone();
  for (const originality of ["synthesis", "brief"]) {
    await assert.rejects(() => official(official1, { originality }), refusedWith("evidence_interpretive_calculation_refused"), originality);
  }
  const mine = await userZone();
  await assert.rejects(() => plain.save(alice, { ...card({ originality: "synthesis" }), requestId: "mine-card-1" }, mine.id, null, true), refusedWith("evidence_interpretive_calculation_refused"));
  const own = await plain.save(alice, { ...card({ originality: "original_research", claims: [quoted] }), requestId: "mine-card-2" }, mine.id, null, true);
  assert.equal(own.evidence.originality, "original_research", "a user's own research stands on their own words");
  const interpretation = await official(official1, { originality: "synthesis", claims: [quoted] });
  assert.equal(interpretation.originality, "synthesis");
});

test("the reader's mark on a calculated claim is the receipt's comparison made now: ✓ and 平台计算 when it holds, ⚠ with a named reason when it does not", options, async () => {
  const zone = await officialZone();
  const saved = await official(zone, {});
  const seen = (await reading.detail(alice, zone.id, saved.id)).evidence;
  assert.deepEqual(seen.claims[0].verification, { claimId: "CALC-1", claimType: "calculated", status: "verified", mark: "✓", sources: [] });
  assert.equal(seen.claims[1].verification.status, "verified", "the quotation beside it is its own check");
  assert.equal(seen.claimVerification.calculation_unverified, 0);
  assert.deepEqual(seen.views.clinical.claims.find((claim) => claim.claimId === "CALC-1").platformCalculation,
    { label: "平台计算", engine: "drug_safety_analysis", method: "faers.signals@1.1.0", receiptId: RECEIPT_ID });
  assert.equal(seen.views.public.calculations[0].label, "平台计算");

  // The receipt moved under the claim: the mark follows, because it is never stored.
  receipts.set(RECEIPT_ID, { ...RECEIPT, values: RECEIPT.values.map((entry) => (entry.key.endsWith("ror.value") ? { ...entry, value: 3.1 } : entry)) });
  const moved = (await reading.detail(alice, zone.id, saved.id)).evidence;
  assert.deepEqual([moved.claims[0].verification.mark, moved.claims[0].verification.reason], ["⚠", "value_mismatch"]);
  assert.deepEqual(moved.views.clinical.claims.map((claim) => claim.claimId), ["CLM-1"], "an unverified calculation is not shown as a claim");
  assert.deepEqual(moved.views.clinical.withheldCalculations, [{ claimId: "CALC-1", reason: "value_mismatch" }]);
  receipts.delete(RECEIPT_ID);
  const gone = (await reading.detail(alice, zone.id, saved.id)).evidence;
  assert.equal(gone.claims[0].verification.reason, "receipt_unavailable");
  // A service with no reader never says ✓ for a number it cannot read back.
  const blind = (await plain.detail(alice, zone.id, saved.id)).evidence;
  assert.deepEqual([blind.claims[0].verification.mark, blind.claims[0].verification.reason], ["⚠", "receipt_unavailable"]);
  assert.equal(blind.claimVerification.calculation_unverified, 1);
});

test("a comparison whose counts a machine produced is in the fact box only when its receipt holds every count", options, async () => {
  const zone = await officialZone();
  const comparison = { title: "报告", outcome: "报告数", timeframe: "2026Q2", denominator: 10634, valueSource: "calculated", outcomeRole: "harm", sourceIndexes: [1],
    control: { label: "无暴露", events: 400 }, intervention: { label: "暴露", events: 1234 },
    calculation: { engine: "drug_safety_analysis", method: "faers.signals@1.1.0", receiptId: RECEIPT_ID, inputs: RECEIPT.inputs,
      valuePaths: { denominator: "values[0].table.total", controlEvents: "values[0].table.c", interventionEvents: "values[0].table.a" } } };
  receipts.set(RECEIPT_ID, { ...RECEIPT, values: [...RECEIPT.values, { key: "values[0].table.total", value: 10634 }] });
  const saved = await official(zone, { content: { question: "q", answer: "a", comparisons: [comparison] } });
  const held = (await reading.detail(alice, zone.id, saved.id)).evidence;
  assert.equal(held.views.public.factBox.status, "available");
  assert.equal(held.views.public.factBox.harms[0].intervention.per1000, 116);
  receipts.set(RECEIPT_ID, RECEIPT);
  const without = (await reading.detail(alice, zone.id, saved.id)).evidence;
  assert.equal(without.views.public.factBox.status, "unavailable", "the receipt carries no denominator: the counts are not used");
  assert.deepEqual(without.views.public.factBox.excluded, [{ index: 0, reason: "calculation_unverified" }]);
});
