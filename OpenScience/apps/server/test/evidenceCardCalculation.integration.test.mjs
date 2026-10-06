// A first-hand card stands on a calculation (evidence-flywheel plan §5.1): the zone service refuses an official primary card with
// none and an interpretive card that claims one, and reads the receipts a calculated claim names back through the injected reader,
// so the mark a reader sees is the domain's own comparison and never a stored word. Real PostgreSQL; the reader is the one double.
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createCalculationReceiptReader } from "../src/evidenceCalculationReceipts.mjs";
import { monthlyEvidenceFigures } from "../src/evidenceFigures.mjs";
import { createEvidenceRecalculation, createOfficialZoneMatcher } from "../src/evidenceRecalculation.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { createEvidencePublicReads } from "../src/evidencePublicQuery.mjs";

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
// The platform's own writer read its sources: the read receipt it keeps beside an excerpt is what makes a quotation found there ✓.
const platformRead = (/** @type {any} */ value) => ({ ...value, sources: value.sources.map((/** @type {any} */ source) => (source.url ? { ...source, fetchedSha256: "c".repeat(64) } : source)) });
const official = (zone, fields) => plain.saveEditorial(publisher, { requestId: `calc-card-${++seed}`, ...platformRead(card(fields)) }, zone.id, null, true, "programme").then((result) => result.evidence);

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

test("a reproduced paper becomes a recalculation card in the official zone its entities name, and the reader sees it ✓ through the evolution receipt", options, async () => {
  const { zone } = await plain.saveEditorial(publisher, { title: "房颤抗凝", description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  const af = (await plain.saveEditorial(publisher, { expectedRevision: zone.revision, state: "published" }, zone.id, null, false, "programme")).zone;
  const other = await plain.saveEditorial(publisher, { title: "心肾与慢性肾病", description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  await plain.saveEditorial(publisher, { expectedRevision: other.zone.revision, state: "published" }, other.zone.id, null, false, "programme");
  // The glossary double: the paper's text mentions apixaban; the atrial-fibrillation zone's terms do too, the kidney zone's do not.
  const vocabulary = { keysForText: async ({ texts }) => (texts.some((text) => /apixaban|房颤|anticoagulation/i.test(text)) ? ["drug:apixaban"] : ["disease:chronic kidney disease"]) };
  const ledger = new Map();
  const evolution = {
    get: async (id) => ledger.get(id) ?? null,
    save: async (type, id, payload) => { const row = { id, payload: { ...payload, recordType: `evolution-${type}` } }; ledger.set(id, row); return row; },
  };
  const paper = "In the pooled analysis of apixaban trials the summary hazard ratio for stroke was 0.82 across 12 trials.";
  const quote = "the summary hazard ratio for stroke was 0.82";
  const row = { type: "research", goldSourceHash: "a".repeat(64), comparison: { title: "Apixaban meta-analysis", url: "https://doi.org/10.1000/meta.2026.1",
    source: { title: "Apixaban meta-analysis", url: "https://doi.org/10.1000/meta.2026.1", documentText: paper }, items: [{ key: "hr", published: { value: 0.82, printed: "0.82", quote }, recalculated: { value: 0.8213 } }] } };
  const publisherOfCards = createEvidenceRecalculation({ config: { evidenceRecalculationCardsEnabled: true, evolutionEnabled: true }, evolution, zones: plain,
    matchZone: createOfficialZoneMatcher({ database: db, entityVocabulary: vocabulary }), now: () => new Date("2026-10-06T01:00:00.000Z"), publisherUser: publisher });
  const result = await publisherOfCards.onProofRecorded({ proofId: "evolution-research-proof-9", toolId: "meta-pool", artifactDigest: "d".repeat(64), paperId: "doi:10.1000/meta.2026.1", passed: true, rows: [row] });
  assert.equal(result.outcome, "published", JSON.stringify(result));
  const stored = (await db.query("SELECT c.id, c.zone_id, c.originality, c.state FROM evimed_frontier.evidence_cards c WHERE c.zone_id=$1", [af.id])).rows;
  assert.deepEqual(stored.map((card) => [card.originality, card.state]), [["recalculation", "published"]], "in the zone the paper's entities name");
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards WHERE zone_id=$1", [other.zone.id])).rows[0].n, 0);
  const seen = (await new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher", calculationReceipts: createCalculationReceiptReader({ evolution }) }).detail(alice, af.id, stored[0].id)).evidence;
  assert.deepEqual(seen.claims.map((claim) => [claim.claimId, claim.verification.mark]), [["QUOTE-1", "✓"], ["CALC-1", "✓"]], "the quotation is in the preserved paper and the numbers are in the receipt");
  assert.equal(seen.views.clinical.claims.find((claim) => claim.claimId === "CALC-1").platformCalculation.engine, "evolution_recalculation");
  // A paper about a topic no official zone holds publishes nothing.
  const elsewhere = createEvidenceRecalculation({ config: { evidenceRecalculationCardsEnabled: true, evolutionEnabled: true }, evolution, zones: plain,
    matchZone: createOfficialZoneMatcher({ database: db, entityVocabulary: { keysForText: async (input) => (input.texts.some((text) => /summary hazard ratio/.test(text)) ? ["drug:something-no-zone-holds"] : vocabulary.keysForText(input)) } }), publisherUser: publisher });
  assert.equal((await elsewhere.onProofRecorded({ proofId: "evolution-research-proof-10", toolId: "meta-pool", artifactDigest: "d".repeat(64), paperId: "doi:10.1000/meta.2026.2", passed: true, rows: [row] })).outcome, "no_matching_zone");
});

test("the monthly verification figure counts the quotations it can check, not calculations whose receipts it does not read", options, async () => {
  const zone = await officialZone();
  await official(zone, {});
  const month = new Date().toISOString().slice(0, 7);
  const next = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 7);
  // The card was recorded now; the figure looks at the end of a month after it, so the card is read as it stood.
  const figures = await monthlyEvidenceFigures(db, { month: next === month ? month : next });
  assert.deepEqual([figures.verification.claims, figures.verification.verified], [1, 1], "one quotation, found; the calculated claim is not scored as an unread receipt");
});

test("the public card page checks a calculated claim against its receipt as the app does; without the receipt reader it says the receipt is unavailable", options, async () => {
  const zone = await officialZone();
  const saved = await official(zone, {});
  const statusOf = async (/** @type {any} */ reads) => Object.fromEntries((await reads.card(saved.id)).claimList.map((/** @type {any} */ claim) => [claim.claimId, [claim.status, claim.mark]]));
  const withReceipts = createEvidencePublicReads({ database: db, receiptsFor: (/** @type {any} */ card) => reading.receiptsFor(card) });
  assert.deepEqual((await statusOf(withReceipts))["CALC-1"], ["verified", "✓"]);
  const without = createEvidencePublicReads({ database: db });
  assert.deepEqual((await statusOf(without))["CALC-1"], ["calculation_unverified", "⚠"]);
});
