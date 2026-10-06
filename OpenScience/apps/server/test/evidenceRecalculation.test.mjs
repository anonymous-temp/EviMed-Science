// Recalculation cards (evidence-flywheel plan §5.1, F03): what the paper printed, what the platform's reproduction computed and how far
// apart they are against the evaluator's own tolerance — each number rendered from a receipt, the verdict from a closed vocabulary, a
// non-reproduction only when adjudicated. The publisher's collaborators are doubles; the rules are the unit under test.
import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, evidenceCardClaims, evidenceOriginalityBasisIssues, verifyEvidenceCardClaims } from "@evimed/domain";
import { boundedHalfWidth } from "../../../evals/paper-gold/tolerance.mjs";
import {
  RECALCULATION_OUTCOMES, buildRecalculationCard, compareRecalculation, createEvidenceRecalculation, evidenceRecalculationMetricFamilies, isAdjudicated,
  recalculationReceipt, recalculationVerdict,
} from "../src/evidenceRecalculation.mjs";
import { createCalculationReceiptReader } from "../src/evidenceCalculationReceipts.mjs";

const PAPER_TEXT = "In the pooled analysis the summary hazard ratio for stroke was 0.82 (95% CI 0.71 to 0.95) across 12 trials.";
const QUOTE = "the summary hazard ratio for stroke was 0.82";
const source = { title: "A meta-analysis of anticoagulants", url: "https://doi.org/10.1000/meta.2026.1", documentText: PAPER_TEXT, sha256: "a".repeat(64) };
const item = (recalculated = 0.8213, over = {}) => ({ key: "summary.hr", published: { value: 0.82, printed: "0.82", quote: QUOTE, ...over }, recalculated: { value: recalculated } });
const review = { verdict: "paper_error", codeVerified: true, reviewerFamily: "qwen", evidenceIds: ["e1"], verificationProof: { proofHash: "c".repeat(64) } };

const LOOSE = { absoluteTolerance: 0.02, toleranceReason: "inputs-rounded-in-source" };

test("the tolerance is the evaluator's own half-width, and a result matches when it rounds to what the paper printed", () => {
  const reference = { value: 0.82, printed: "0.82" };
  assert.equal(compareRecalculation(item()).tolerance, boundedHalfWidth(reference).halfWidth, "one rule, so the card and the evaluation cannot disagree");
  assert.deepEqual([compareRecalculation(item(0.8213)).within, compareRecalculation(item(0.8213)).matchesPrinted], [true, true], "0.8213 prints as 0.82");
  const loosened = compareRecalculation(item(0.8349, LOOSE));
  assert.deepEqual([loosened.within, loosened.matchesPrinted, loosened.tolerance], [true, false, 0.02], "inside the tolerance a curator argued for, not at the printed precision");
  assert.equal(compareRecalculation(item(0.9)).within, false);
  assert.equal(compareRecalculation(item(0.9, { absoluteTolerance: 0.2 })).within, false, "a tolerance beyond the evaluator's ceiling counts only up to the ceiling");
  assert.equal(compareRecalculation({ published: { value: 12 }, recalculated: { value: 12 } }).matchesPrinted, true, "with no printed token, equality");
});

test("the verdict is a closed vocabulary, and a paper is said not to be reproduced only when the disagreement is adjudicated", () => {
  const hit = compareRecalculation(item(0.8213)), near = compareRecalculation(item(0.8349, LOOSE)), miss = compareRecalculation(item(0.9));
  assert.deepEqual(recalculationVerdict([hit], { adjudicated: false }), { verdict: "reproduced" });
  assert.deepEqual(recalculationVerdict([hit, near], { adjudicated: false }), { verdict: "reproduced_with_difference" });
  assert.deepEqual(recalculationVerdict([hit, miss], { adjudicated: true }), { verdict: "not_reproduced_adjudicated" });
  assert.deepEqual(recalculationVerdict([hit, miss], { adjudicated: false }), { verdict: null, reason: "not_adjudicated" }, "a failure nobody judged is no statement about the paper");
  assert.deepEqual(recalculationVerdict([], { adjudicated: true }), { verdict: null, reason: "no_results" });
});

test("an adjudication is the evaluator's own: the paper's error or a reasonable difference, code-verified, cross-family, with evidence and its proof", () => {
  assert.equal(isAdjudicated(review), true);
  assert.equal(isAdjudicated({ ...review, verdict: "reasonable_difference" }), true);
  for (const broken of [{ verdict: "platform_error" }, { codeVerified: false }, { reviewerFamily: "" }, { evidenceIds: [] }, { verificationProof: { proofHash: "short" } }]) {
    assert.equal(isAdjudicated({ ...review, ...broken }), false, JSON.stringify(broken));
  }
  assert.equal(isAdjudicated(null), false);
});

const built = (verdict = "reproduced", items = [item()], adjudication = null) => {
  const compared = items.map(compareRecalculation);
  const receipt = recalculationReceipt({ proofId: "evolution-research-proof-1", toolId: "meta-pool", artifactDigest: "d".repeat(64), paperId: "doi:10.1000/meta.2026.1", goldSourceHash: "a".repeat(64), items, comparisons: compared });
  return { receipt, ...buildRecalculationCard({ paper: { id: "doi:10.1000/meta.2026.1", title: "A meta-analysis of anticoagulants", url: source.url, source, doi: "10.1000/meta.2026.1" },
    items, verdict, adjudication, receipt, proofId: "evolution-research-proof-1", model: "deepseek-flash", at: new Date("2026-10-06T01:00:00.000Z") }) };
};

test("the card quotes what the paper printed, renders the platform's numbers from a receipt, and checks itself before it is returned", () => {
  const { card, receipt, status } = built();
  assert.equal(status, "card");
  assert.equal(card.originality, "recalculation");
  assert.deepEqual(card.claims.map((claim) => [claim.claimId, claim.claimType]), [["QUOTE-1", "direct"], ["CALC-1", "calculated"]]);
  assert.equal(card.claims[0].supportQuote, QUOTE, "the published value is a verbatim quotation");
  assert.equal(card.claims[1].claim, "平台复算值为 0.821，论文报告值为 0.820，差值为 0.001，容差为 0.005。");
  assert.deepEqual(receipt.values.map((entry) => entry.key), ["recalculated[0].value", "published[0].value", "difference[0]", "tolerance[0]"]);
  assert.match(receipt.id, /^evolution-recalculation-receipt-[a-f0-9]{32}$/);
  assert.equal(recalculationReceipt({ ...{ proofId: "evolution-research-proof-1", toolId: "meta-pool", artifactDigest: "d".repeat(64), paperId: "doi:10.1000/meta.2026.1", goldSourceHash: "a".repeat(64) }, items: [item()], comparisons: [compareRecalculation(item())] }).id, receipt.id, "the same proof gives the same receipt");
  const reader = new Map([[receipt.id, { receiptId: receipt.id, ...receipt }]]);
  const verdict = verifyEvidenceCardClaims(card, { receipts: reader });
  assert.deepEqual(verdict.claims.map((entry) => entry.mark), ["✓", "✓"]);
  assert.doesNotThrow(() => evidenceCardClaims(card.claims, card.sources.length));
  assert.deepEqual(evidenceOriginalityBasisIssues({ originality: card.originality, claims: card.claims, zoneKind: "official" }), []);
  assert.match(card.title, /（已复现）/);
  assert.match(card.content.answer, /^已复现：/);
  assert.deepEqual(card.lineage, { verifiedStudy: { doi: "10.1000/meta.2026.1" } });
});

test("a quotation that is not in the preserved paper makes no card", () => {
  const items = [item(0.8213, { quote: "a sentence the paper never contains" })];
  assert.deepEqual(built("reproduced", items), { receipt: built().receipt, ...{ status: "refused", reason: "card_refused" } });
});

test("a non-reproduction card carries the adjudication, and says what the evaluator's reviewer concluded", () => {
  const { card } = built("not_reproduced_adjudicated", [item(0.9)], review);
  assert.match(card.title, /（未复现（分歧已经裁定））/);
  assert.match(card.body, /差异来自论文本身的错误/);
  assert.match(card.body, /证明哈希 cccccccccccc/);
});

/** The publisher's collaborators, in memory. */
function harness(over = {}) {
  const ledger = new Map();
  const saved = [];
  const evolution = {
    get: async (id) => ledger.get(id) ?? null,
    save: async (type, id, payload) => { const row = { id, payload: { ...payload, recordType: `evolution-${type}` } }; ledger.set(id, row); return row; },
  };
  const zones = { saveEditorial: async (...args) => { saved.push(args); return { evidence: { id: `ec_${saved.length}` } }; } };
  const reports = [];
  const row = (extra = {}) => ({ type: "research", publishedPaperId: "doi:10.1000/meta.2026.1", goldSourceHash: "a".repeat(64), comparison: { title: "A meta-analysis of anticoagulants", url: source.url, source, items: [item()] }, ...extra });
  const publisher = createEvidenceRecalculation({
    config: { evidenceRecalculationCardsEnabled: true, evolutionEnabled: true }, evolution, zones, matchZone: async () => ({ id: "ez_af", title: "房颤抗凝" }),
    now: () => new Date("2026-10-06T01:00:00.000Z"), report: (message) => reports.push(message), ...over,
  });
  const proof = (extra = {}) => ({ proofId: "evolution-research-proof-1", toolId: "meta-pool", artifactDigest: "d".repeat(64), paperId: "doi:10.1000/meta.2026.1", passed: true, rows: [row()], ...extra });
  return { ledger, saved, evolution, zones, reports, publisher, proof, row };
}

test("with its switch off the publisher does nothing at all: no read, no write, no card", async () => {
  for (const config of [{ evidenceRecalculationCardsEnabled: false, evolutionEnabled: true }, { evidenceRecalculationCardsEnabled: true, evolutionEnabled: false }]) {
    const touched = [];
    const watch = (name) => new Proxy({}, { get: () => () => { touched.push(name); } });
    const publisher = createEvidenceRecalculation({ config, evolution: watch("evolution"), zones: watch("zones"), matchZone: async () => { touched.push("zone"); return null; } });
    assert.equal(publisher.enabled, false);
    assert.deepEqual(await publisher.onProofRecorded({ proofId: "p", toolId: "t", artifactDigest: "d", paperId: "x", passed: true, rows: [] }), { outcome: "off" });
    assert.deepEqual(touched, []);
  }
});

test("a reproduced paper is published once, as the platform with origin programme, with its receipt written first", async () => {
  const h = harness();
  const result = await h.publisher.onProofRecorded(h.proof());
  assert.deepEqual([result.outcome, result.verdict, result.cardId], ["published", "reproduced", "ec_1"]);
  const [user, body, zoneId, cardId, createCard, origin] = h.saved[0];
  assert.deepEqual([user.id, zoneId, cardId, createCard, origin], [PLATFORM_PUBLISHER_USER_ID, "ez_af", null, true, "programme"]);
  assert.match(body.requestId, /^recalc-[a-f0-9]{40}$/);
  const receiptRow = [...h.ledger.values()].find((row) => row.payload.recordType === "evolution-recalculation-receipt");
  assert.equal(receiptRow.payload.verdict, "reproduced");
  assert.equal(body.claims.find((claim) => claim.claimType === "calculated").calculation.receiptId, receiptRow.id, "the card cites the record that was written");
  // The receipt is readable back by the reader the zone service uses.
  const reader = createCalculationReceiptReader({ evolution: h.evolution });
  const read = await reader.get(receiptRow.id);
  assert.deepEqual([read.engine, read.method.startsWith("meta-pool@")], ["evolution_recalculation", true]);
  assert.equal((await reader.get("evolution-recalculation-receipt-" + "0".repeat(32))), null);
  // The proof is not published twice.
  assert.deepEqual((await h.publisher.onProofRecorded(h.proof())).outcome, "already_published");
  assert.equal(h.saved.length, 1);
  assert.deepEqual([h.publisher.status().counters.outcomes.published, h.publisher.status().counters.verdicts.reproduced], [1, 1]);
});

test("a failed reproduction nobody adjudicated is no card, an adjudicated one is, and each is counted", async () => {
  const h = harness();
  const miss = h.row({ comparison: { title: "t", source, items: [item(0.9)] } });
  assert.equal((await h.publisher.onProofRecorded(h.proof({ rows: [miss] }))).outcome, "not_adjudicated");
  assert.equal(h.saved.length, 0);
  const judged = await h.publisher.onProofRecorded(h.proof({ proofId: "evolution-research-proof-2", rows: [{ ...miss, disagreement: review }] }));
  assert.deepEqual([judged.outcome, judged.verdict], ["published", "not_reproduced_adjudicated"]);
  assert.equal((await h.publisher.onProofRecorded(h.proof({ proofId: "evolution-research-proof-3", rows: [{ ...miss, disagreement: { ...review, verdict: "platform_error" } }] }))).outcome, "not_adjudicated",
    "a verdict that the platform was wrong is not a statement about the paper");
});

test("no comparison values, no matching official zone and a refused card are each named and publish nothing", async () => {
  const h = harness();
  assert.equal((await h.publisher.onProofRecorded(h.proof({ rows: [{ type: "research" }] }))).outcome, "no_comparison_values", "the unit recorded no pair of values");
  const none = harness({ matchZone: async () => null });
  assert.equal((await none.publisher.onProofRecorded(none.proof())).outcome, "no_matching_zone");
  assert.equal(none.saved.length, 0);
  assert.equal([...none.ledger.values()].length, 0, "nothing is written for a paper with no zone");
  const refused = harness();
  const row = refused.row({ comparison: { title: "t", source, items: [item(0.8213, { quote: "not in the paper" })] } });
  assert.equal((await refused.publisher.onProofRecorded(refused.proof({ rows: [row] }))).outcome, "card_refused");
  const injected = harness({ comparisons: async () => ({ title: "t", source, items: [item()] }) });
  assert.equal((await injected.publisher.onProofRecorded(injected.proof({ rows: [] }))).outcome, "published", "an injected provider replaces the unit's own comparison");
});

test("a failure of the publisher never reaches the evolution loop: it is counted and reported, and the proof stands", async () => {
  const h = harness({ zones: { saveEditorial: async () => { throw Object.assign(new Error("down"), { code: "zone_down" }); } } });
  assert.deepEqual(await h.publisher.onProofRecorded(h.proof()), { outcome: "error" });
  assert.equal(h.publisher.status().counters.outcomes.error, 1);
  assert.match(h.reports[0], /zone_down/);
});

test("the operator's metrics carry the switch, every outcome and every verdict, and read zero with the module off", () => {
  const off = evidenceRecalculationMetricFamilies(null, { evidenceRecalculationCardsEnabled: false });
  assert.deepEqual(off.map((family) => family.name), ["open_science_evidence_recalculation_cards_enabled", "open_science_evidence_recalculation_outcomes_total", "open_science_evidence_recalculation_verdicts_total"]);
  assert.equal(off[0].series[0].value, 0);
  assert.deepEqual(off[1].series.map((entry) => entry.labels.outcome), [...RECALCULATION_OUTCOMES]);
  assert.ok(off[1].series.every((entry) => entry.value === 0));
});

test("the evolution module tells the publisher of each proof it records, once, and a publisher that fails changes nothing", async () => {
  const { recordResearchPromotion } = await import("../src/evolutionResearchPromotion.mjs");
  /** @param {(proof: any) => any} callback */
  const evolution = (callback) => {
    const records = new Map();
    const told = [];
    const service = {
      callbacks: { recalculationProof: async (proof) => { told.push(proof); return callback(proof); } },
      now: () => new Date("2026-10-06T01:00:00.000Z"),
      withLock: async (_key, operation) => operation(),
      get: async (id) => (id === "research-tool" ? { id, payload: { artifactDigest: "pin", validationLevel: "V0" } } : records.get(id) ?? null),
      list: async (type) => (type === "use" ? [{ payload: { projectId: "eval", runId: "run-0", toolId: "research-tool", digest: "pin", result: { ok: true } } }, { payload: { projectId: "eval", runId: "run-1", toolId: "research-tool", digest: "pin", result: { ok: true } } }]
        : [...records.values()].filter((row) => row.payload.recordType === `evolution-${type}`)),
      save: async (type, id, payload) => { const row = { id, payload: { ...payload, recordType: `evolution-${type}` } }; records.set(id, row); return row; },
      recordAssessment: async () => ({}),
    };
    return { service, told, records };
  };
  const rows = [0, 1].map((replicate) => ({ type: "research", group: "holdout", caseId: "case-0", variant: 0, publishedPaperId: "10.1000/meta.2026.1", producerRunId: `run-${replicate}`, producerProjectId: "eval",
    goldSourceHash: "a".repeat(64), fullResearchReproductionValid: true, codeVerified: true, verificationProof: { kind: "isolated-independent-replay", replicates: 2, proofHash: "f".repeat(64), sourceHash: "a".repeat(64) },
    independent: true, retracted: false, exposureTier: "unexposed", comparison: { title: "t", source, items: [item()] } }));
  const input = (service) => ({ service, userId: "operator", toolId: "research-tool", artifactDigest: "pin", report: { units: rows }, canonicalize: async () => ({ verified: true, canonicalId: "doi:10.1000/meta.2026.1" }) });

  const ok = evolution(() => undefined);
  await recordResearchPromotion(input(ok.service));
  assert.equal(ok.told.length, 1);
  assert.deepEqual([ok.told[0].toolId, ok.told[0].artifactDigest, ok.told[0].paperId, ok.told[0].passed, ok.told[0].rows.length], ["research-tool", "pin", "doi:10.1000/meta.2026.1", true, 2]);
  assert.match(ok.told[0].proofId, /^evolution-research-proof-[a-f0-9]{64}$/);
  assert.ok(ok.records.has(ok.told[0].proofId), "the proof was recorded before the publisher was told");
  await recordResearchPromotion(input(ok.service));
  assert.equal(ok.told.length, 1, "a proof already recorded is not told again: the first measured outcome stands");

  const failing = evolution(() => { throw new Error("publisher down"); });
  const result = await recordResearchPromotion(input(failing.service));
  assert.equal(result.papers, 1, "the loop goes on as if there were no publisher");
  assert.equal([...failing.records.values()].filter((row) => row.payload.recordType === "evolution-research-proof").length, 1);
});
