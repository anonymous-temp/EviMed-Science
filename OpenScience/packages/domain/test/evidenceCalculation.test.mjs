import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_CALCULATION_REASONS,
  EvidenceCardError,
  evidenceAbsoluteEffect,
  evidenceCalculationBasis,
  evidenceCalculationReceiptIds,
  evidenceCalculationVerdict,
  evidenceCardClaims,
  evidenceCardClinicalView,
  evidenceCardPublicView,
  evidenceFactBox,
  evidenceOriginalityBasisIssues,
  evidenceStructuredContent,
  verifyEvidenceCardClaims,
} from "../index.mjs";

const INPUTS = [{ identifier: "doi:10.1000/meta.2026.1", hash: "a".repeat(64) }, { datasetId: "gwas:ieu-a-2" }];
const RECEIPT = {
  receiptId: "rv_" + "b".repeat(64),
  engine: "mendelian_randomization",
  method: "ivw@1.4",
  inputs: INPUTS,
  values: [
    { key: "analyses[0].estimate", value: 0.7134, unit: "odds_ratio" },
    { key: "analyses[0].interval.level", value: 0.95, unit: "fraction" },
    { key: "analyses[0].interval.low", value: 0.6012 },
    { key: "analyses[0].denominator", value: 2000 },
    { key: "analyses[0].events.control", value: 240 },
    { key: "analyses[0].events.treated", value: 180 },
    { key: "analyses[0].share", value: 0.41234, unit: "proportion" },
  ],
};
const basis = (/** @type {Record<string, any>} */ over = {}) => ({
  engine: "mendelian_randomization", method: "ivw@1.4", receiptId: RECEIPT.receiptId, inputs: INPUTS,
  valuePath: "analyses[0].estimate", machineValue: 0.7134, format: "f2", ...over,
});
const claim = (text = "逆方差加权估计的比值比为 0.71。", /** @type {Record<string, any>} */ over = {}) => ({ claimId: "CALC-1", claimType: "calculated", claim: text, calculation: basis(), ...over });
const receipts = (/** @type {any[]} */ ...list) => new Map(list.map((receipt) => [receipt.receiptId, receipt]));
const refusedWith = (/** @type {string} */ code) => (/** @type {any} */ error) => error instanceof EvidenceCardError && error.code === code;

test("a calculated claim states its engine, method, receipt, path, machine value and format, and nothing else", () => {
  const [made] = evidenceCardClaims([claim()], 0);
  assert.equal(made.claimType, "calculated");
  assert.equal(made.valueSource, "calculated", "the value-source label is set by the type, not left to the writer");
  assert.deepEqual(made.calculation, basis());
  assert.throws(() => evidenceCardClaims([claim("x", { valueSource: "extracted" })], 0), refusedWith("evidence_invalid"), "a calculated claim cannot carry another label");
  assert.throws(() => evidenceCardClaims([claim("x", { sourceIndexes: [1] })], 1), refusedWith("evidence_invalid"), "it stands on a receipt, not on a source");
  assert.throws(() => evidenceCardClaims([claim("x", { supportQuote: "0.71" })], 1), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceCardClaims([{ claimId: "D", claimType: "direct", claim: "x", sourceIndexes: [1], calculation: basis() }], 1), refusedWith("evidence_invalid"), "a quote claim carries no calculation");
  for (const broken of [{ engine: "Not An Engine" }, { receiptId: "" }, { valuePath: "a b" }, { machineValue: NaN }, { machineValue: "0.71" }, { format: "months" }, { format: "ci" }, { inputs: [] },
    { inputs: [{ identifier: "x", datasetId: "y" }] }, { inputs: [{ identifier: "x", hash: "short" }] }, { method: " " }]) {
    assert.throws(() => evidenceCalculationBasis(basis(broken)), refusedWith("evidence_invalid"), JSON.stringify(broken));
  }
  assert.throws(() => evidenceCalculationBasis(basis({ alsoValues: [{ valuePath: "analyses[0].estimate", machineValue: 0.7134 }] })), refusedWith("evidence_invalid"), "one path is stated once");
});

test("a calculated claim is ✓ only when the receipt's engine, method and inputs are the claim's and the printed number is the machine value rounded by the renderer", () => {
  const check = (/** @type {any} */ card, /** @type {any} */ reader = receipts(RECEIPT)) => verifyEvidenceCardClaims(card, { receipts: reader });
  const good = check({ claims: [claim()] });
  assert.deepEqual(good.claims[0], { claimId: "CALC-1", claimType: "calculated", status: "verified", mark: "✓", sources: [] });
  assert.equal(good.counts.verified, 1);
  assert.equal(good.counts.calculation_unverified, 0);

  const reason = (/** @type {any} */ card, /** @type {any} */ reader = undefined) => check(card, reader).claims[0]?.reason;
  assert.equal(reason({ claims: [claim()] }, receipts()), "receipt_unavailable", "an unreadable receipt is named, never passed");
  assert.equal(verifyEvidenceCardClaims({ claims: [claim()] }).claims[0]?.reason, "receipt_unavailable", "with no reader at all nothing is ✓");
  assert.equal(reason({ claims: [claim()] }, receipts({ ...RECEIPT, engine: "meta_analysis" })), "engine_mismatch");
  assert.equal(reason({ claims: [claim()] }, receipts({ ...RECEIPT, method: "egger@1.4" })), "method_mismatch");
  assert.equal(reason({ claims: [claim()] }, receipts({ ...RECEIPT, inputs: [INPUTS[0]] })), "inputs_mismatch");
  assert.equal(reason({ claims: [claim()] }, receipts({ ...RECEIPT, inputs: [{ ...INPUTS[0], hash: "c".repeat(64) }, INPUTS[1]] })), "inputs_mismatch", "an input whose bytes changed is another input");
  assert.equal(check({ claims: [claim()] }, receipts({ ...RECEIPT, inputs: [...INPUTS].reverse() })).claims[0].status, "verified", "input order is not identity");
  assert.equal(reason({ claims: [claim()] }, receipts({ ...RECEIPT, values: [] })), "value_missing");
  assert.equal(reason({ claims: [claim()] }, receipts({ ...RECEIPT, values: [{ key: "analyses[0].estimate", value: 0.9 }] })), "value_mismatch", "the receipt moved under the claim");
  assert.equal(reason({ claims: [claim("比值比为 0.72。")] }), "number_not_printed", "0.7134 rounds to 0.71, not 0.72");
  assert.equal(reason({ claims: [claim("比值比约为 0.7134。")] }), "number_not_printed", "the format is the claim's own: f2 prints two places");
  assert.equal(reason({ claims: [claim("比值比为 0.71，共 99 项研究。")] }), "number_unbound", "a number no stated value prints is nobody's computation");
  assert.equal(check({ claims: [claim("纳入 3 项研究，比值比为 0.71。")] }).claims[0].status, "verified", "an ordinal up to twelve is a word, not a statement");
  assert.equal(reason({ claims: [claim("比值比为 0.71。", { calculation: basis({ format: "pct1" }) })] }), "unit_mismatch", "a percentage cannot print an odds ratio");
  assert.deepEqual(EVIDENCE_CALCULATION_REASONS.includes("unit_mismatch"), true);
  assert.equal(check({ claims: [claim()] }, { get: () => undefined }).claims[0]?.reason, "receipt_unavailable");
});

test("a sentence that states several numbers says each, and the renderer's formats apply to each", () => {
  const text = "逆方差加权估计的比值比为 0.71（置信水平 95%，下限 0.6）；有 41.2% 的人处于该状态。";
  const stated = claim(text, { calculation: basis({ alsoValues: [
    { valuePath: "analyses[0].interval.level", machineValue: 0.95, format: "pct0" },
    { valuePath: "analyses[0].interval.low", machineValue: 0.6012, format: "f1" },
    { valuePath: "analyses[0].share", machineValue: 0.41234, format: "pct1" },
  ] }) });
  assert.equal(verifyEvidenceCardClaims({ claims: [stated] }, { receipts: receipts(RECEIPT) }).claims[0].status, "verified");
  const wrongPlaces = claim(text.replace("0.6）", "0.60）"), { calculation: stated.calculation });
  assert.equal(verifyEvidenceCardClaims({ claims: [wrongPlaces] }, { receipts: receipts(RECEIPT) }).claims[0].reason, "number_not_printed");
});

test("a negative value and a thousands-grouped value are printed as the renderer prints them", () => {
  const receipt = { ...RECEIPT, values: [{ key: "x.diff", value: -0.1234 }, { key: "x.n", value: 12345 }] };
  const text = claim("差值为 −0.12，样本 12,345 例。", { calculation: basis({ valuePath: "x.diff", machineValue: -0.1234, alsoValues: [{ valuePath: "x.n", machineValue: 12345, format: "thousands" }] }) });
  assert.equal(verifyEvidenceCardClaims({ claims: [text] }, { receipts: receipts(receipt) }).claims[0].status, "verified");
  assert.equal(verifyEvidenceCardClaims({ claims: [claim("差值为 0.12。", { calculation: text.calculation })] }, { receipts: receipts(receipt) }).claims[0].reason, "number_not_printed", "a sign is part of the number");
});

test("counts include calculated claims beside quoted ones, and only a held receipt makes one ✓", () => {
  const card = { claims: [claim(), { claimId: "Q-1", claimType: "direct", claim: "原文说 12 例。", sourceIndexes: [1], supportQuote: "12 deaths" }],
    sources: [{ title: "Paper", excerpt: "There were 12 events in the trial." }] };
  const verdict = verifyEvidenceCardClaims(card, { receipts: receipts(RECEIPT) });
  assert.deepEqual(verdict.claims.map((entry) => [entry.claimId, entry.status]), [["CALC-1", "verified"], ["Q-1", "quote_not_found"]], "card order, and each by its own rule");
  assert.equal(verdict.counts.total, 2);
  assert.equal(verifyEvidenceCardClaims(card).counts.calculation_unverified, 1);
});

test("the receipt ids of a card are what the caller reads before it checks", () => {
  const comparison = { title: "t", outcome: "o", timeframe: "1y", denominator: 2000, valueSource: "calculated", control: { label: "c", events: 240 }, intervention: { label: "i", events: 180 }, sourceIndexes: [1],
    calculation: { engine: "meta_analysis", method: "pool@2", receiptId: "rv_other", inputs: INPUTS, valuePaths: { denominator: "d", controlEvents: "c", interventionEvents: "i" } } };
  assert.deepEqual(evidenceCalculationReceiptIds({ claims: [claim()], content: { comparisons: [comparison] } }).sort(), [RECEIPT.receiptId, "rv_other"].sort());
});

const COMPARISON = {
  title: "卒中", outcome: "卒中", timeframe: "2 年", denominator: 2000, valueSource: "calculated", outcomeRole: "benefit", sourceIndexes: [1],
  control: { label: "常规治疗", events: 240 }, intervention: { label: "药物", events: 180 },
  calculation: { engine: "mendelian_randomization", method: "ivw@1.4", receiptId: RECEIPT.receiptId, inputs: INPUTS,
    valuePaths: { denominator: "analyses[0].denominator", controlEvents: "analyses[0].events.control", interventionEvents: "analyses[0].events.treated" } },
};

test("a machine's counts enter the fact box only when the receipt carries the events and the denominator", () => {
  assert.doesNotThrow(() => evidenceStructuredContent({ comparisons: [COMPARISON] }, 1));
  assert.throws(() => evidenceStructuredContent({ comparisons: [{ ...COMPARISON, valueSource: "extracted" }] }, 1), refusedWith("evidence_invalid"), "counts a machine produced are labelled so");
  assert.throws(() => evidenceStructuredContent({ comparisons: [{ ...COMPARISON, calculation: { ...COMPARISON.calculation, valuePaths: { denominator: "d" } } }] }, 1), refusedWith("evidence_invalid"), "the events of both arms are named");

  const card = { claims: [], sources: [], content: { comparisons: [COMPARISON] } };
  const held = verifyEvidenceCardClaims(card, { receipts: receipts(RECEIPT) });
  assert.deepEqual(held.comparisons, [{ index: 0, status: "verified", mark: "✓" }]);
  const box = evidenceFactBox(card.content.comparisons, { verdicts: held.comparisons });
  assert.equal(box.status, "available");
  assert.equal(box.benefits[0].control.per1000, 120);
  assert.equal(box.benefits[0].intervention.per1000, 90);

  const without = evidenceFactBox(card.content.comparisons);
  assert.equal(without.status, "unavailable", "no verdict, no counts");
  assert.deepEqual(without.excluded, [{ index: 0, reason: "calculation_unverified" }]);
  const noEvents = verifyEvidenceCardClaims(card, { receipts: receipts({ ...RECEIPT, values: RECEIPT.values.filter((entry) => !entry.key.includes("events")) }) });
  assert.equal(noEvents.comparisons[0].reason, "value_missing");
  assert.equal(evidenceFactBox(card.content.comparisons, { verdicts: noEvents.comparisons }).status, "unavailable");
  const moved = verifyEvidenceCardClaims(card, { receipts: receipts({ ...RECEIPT, values: RECEIPT.values.map((entry) => (entry.key.endsWith("denominator") ? { ...entry, value: 2001 } : entry)) }) });
  assert.equal(moved.comparisons[0].reason, "value_mismatch");

  const own = { ...COMPARISON };
  delete (/** @type {any} */ (own)).calculation;
  assert.equal(evidenceFactBox([own]).status, "available", "an author's own comparison is judged as it always was");
  assert.equal(evidenceAbsoluteEffect(COMPARISON).status, "computed", "the arithmetic itself is unchanged");
});

test("both views show a verified calculated claim as 「平台计算」 with its engine, method and receipt, and withhold an unverified one by name", () => {
  const card = { title: "t", originality: "original_analysis", claims: [claim()], sources: [], content: { comparisons: [COMPARISON] },
    publicView: { oneLineAnswer: { text: "比值比 0.71。", claimIds: ["CALC-1"] } } };
  const held = verifyEvidenceCardClaims(card, { receipts: receipts(RECEIPT) });
  const clinical = evidenceCardClinicalView(card, { verification: held });
  assert.deepEqual(clinical.claims[0].platformCalculation, { label: "平台计算", engine: "mendelian_randomization", method: "ivw@1.4", receiptId: RECEIPT.receiptId });
  assert.deepEqual(clinical.rows[0].platformCalculation.label, "平台计算");
  assert.equal(clinical.rows[0].absoluteEffect.status, "computed");
  assert.deepEqual(clinical.withheldCalculations, []);
  const pub = evidenceCardPublicView(card, { verification: held });
  assert.equal(pub.calculations[0].label, "平台计算");
  assert.equal(/** @type {any} */ (pub.panels.find((panel) => panel.key === "oneLineAnswer")).traced, true, "a panel resting on a verified calculation is traced");
  assert.equal(pub.factBox.status, "available");

  const lost = verifyEvidenceCardClaims(card, { receipts: receipts() });
  const clinicalLost = evidenceCardClinicalView(card, { verification: lost });
  assert.deepEqual(clinicalLost.claims, []);
  assert.deepEqual(clinicalLost.withheldCalculations, [{ claimId: "CALC-1", reason: "receipt_unavailable" }]);
  assert.equal(clinicalLost.rows[0].absoluteEffect.reason, "calculation_unverified");
  const publicLost = evidenceCardPublicView(card, { verification: lost });
  assert.deepEqual(publicLost.calculations, []);
  assert.equal(/** @type {any} */ (publicLost.panels.find((panel) => panel.key === "oneLineAnswer")).traced, false);
  assert.equal(publicLost.factBox.status, "unavailable");
});

test("first-hand cards in the platform's voice stand on a calculation, and interpretation never claims one", () => {
  const calculated = [{ claimId: "C", claimType: "calculated", claim: "x", calculation: basis() }];
  const quoted = [{ claimId: "Q", claimType: "direct", claim: "x", sourceIndexes: [1] }];
  for (const originality of ["original_analysis", "recalculation", "original_research"]) {
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: quoted, zoneKind: "official" }).map((issue) => issue.code), ["evidence_primary_requires_calculation"], originality);
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: [], zoneKind: "official" }).map((issue) => issue.code), ["evidence_primary_requires_calculation"]);
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: [...quoted, ...calculated], zoneKind: "official" }), []);
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: quoted, zoneKind: "user" }), [], "a researcher's own zone keeps its own rules");
  }
  for (const originality of ["synthesis", "brief"]) {
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: calculated, zoneKind: "official" }).map((issue) => issue.code), ["evidence_interpretive_calculation_refused"], originality);
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: [{ claimId: "D", claimType: "direct", claim: "x", valueSource: "calculated", sourceIndexes: [1] }], zoneKind: "user" }).map((issue) => issue.code),
      ["evidence_interpretive_calculation_refused"], "a quoted claim labelled as the card's own calculation is the same thing");
    assert.deepEqual(evidenceOriginalityBasisIssues({ originality, claims: quoted, zoneKind: "official" }), [], "a number quoted from a paper stays a quote");
  }
  // The rule is the rule's: with the check taken out the quoted-only primary card would pass.
  assert.equal(evidenceOriginalityBasisIssues({ originality: "original_analysis", claims: quoted, zoneKind: "official" }).length, 1);
});

test("a calculation verdict is a pure function of the claim and the receipt", () => {
  assert.deepEqual(evidenceCalculationVerdict(claim(), RECEIPT), { ok: true });
  assert.deepEqual(evidenceCalculationVerdict(claim(), null), { ok: false, reason: "receipt_unavailable" });
  assert.deepEqual(evidenceCalculationVerdict(/** @type {any} */ ({ claim: "x" }), RECEIPT), { ok: false, reason: "receipt_unavailable" });
});
