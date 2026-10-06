// The platform's publication standard (evidence-flywheel plan §5.1, F02): which of an episode's conclusions become an official
// card. Every test names a rule and fails when the rule is removed from `evidenceProgrammeCard.mjs`; the card the standard
// writes is also held to the domain's own contract (`evidenceCardClaims`, `verifyEvidenceCardClaims`).
import assert from "node:assert/strict";
import test from "node:test";
import { evidenceCardClaims, evidenceDisclosure, evidenceLineage, evidenceOriginalityBasisIssues, evidenceProducer, verifyEvidenceCardClaims } from "@evimed/domain";
import { claimVerification } from "@evimed/domain/clinical-evidence";
import {
  buildOriginalAnalysisCard, buildProgrammeCard, evaluateProgrammeClaims, independentDatasetCount, multiplicityOf, programmeCardProvenance, programmeCardRequestId, programmeComparisons,
} from "../src/evidenceProgrammeCard.mjs";
import { receiptFromResultVersion } from "../src/evidenceCalculationReceipts.mjs";
import { MULTIPLICITY_MACHINE_VALUE_KEYS, REPLICATION_MACHINE_VALUE_KEY } from "../src/evidenceProgrammeData.mjs";

const PATH_A = ".evimed-sources/a1/aristotle.txt";
const PATH_B = ".evimed-sources/b2/rely.txt";
const TEXT_A = "In ARISTOTLE, apixaban was superior to warfarin in preventing stroke or systemic embolism (hazard ratio 0.79; 95% CI 0.66 to 0.95), and caused less major bleeding.";
const TEXT_B = "RE-LY found dabigatran 150 mg twice daily reduced stroke or systemic embolism compared with warfarin (relative risk 0.66).";
const QUOTE_A = "apixaban was superior to warfarin in preventing stroke or systemic embolism";
const QUOTE_B = "dabigatran 150 mg twice daily reduced stroke or systemic embolism compared with warfarin";

const directA = { claimId: "CLM-001", claimType: "direct", claim: "阿哌沙班预防卒中或系统性栓塞优于华法林。", applicability: "非瓣膜性房颤成人", uncertainty: "与华法林的开放性比较。",
  sourceUrl: "https://doi.org/10.1056/NEJMoa1107039", sourceTitle: "ARISTOTLE", artifactPath: PATH_A, accessLevel: "full_text", supportQuote: QUOTE_A };
const directB = { claimId: "CLM-002", claimType: "direct", claim: "达比加群 150 mg 每日两次降低卒中或系统性栓塞。", sourceUrl: "https://doi.org/10.1056/NEJMoa0905561", sourceTitle: "RE-LY",
  artifactPath: PATH_B, accessLevel: "abstract", supportQuote: QUOTE_B };
const synthesis = { claimId: "CLM-003", claimType: "synthesized", claim: "两项随机试验都显示新型口服抗凝药在预防卒中上不劣于华法林。", confidence: "moderate",
  supportingSources: [
    { sourceUrl: "https://doi.org/10.1056/NEJMoa1107039", sourceTitle: "ARISTOTLE", artifactPath: PATH_A, accessLevel: "full_text", supportQuote: QUOTE_A },
    { sourceUrl: "https://doi.org/10.1056/NEJMoa0905561", sourceTitle: "RE-LY", artifactPath: PATH_B, accessLevel: "abstract", supportQuote: QUOTE_B },
  ] };
const misquoted = { ...directB, claimId: "CLM-004", claim: "一条引文不在来源里的结论。", supportQuote: "this passage is not in the source at all" };

const SOURCES = { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B };
const captured = new Map([[PATH_A, { text: TEXT_A, digest: "a".repeat(64), capturedAt: "2026-10-05T01:00:00.000Z" }], [PATH_B, { text: TEXT_B, digest: "b".repeat(64), capturedAt: "2026-10-05T01:00:00.000Z" }]]);

/** The agenda claim the independent check graded: `tier`, `type` and the verdict decide the placement (`digestPlacement`). */
const graded = (id, over = {}) => ({ id, type: "direct", tier: "gated", refutation: "stands", verification: { status: "recorded" }, ...over });

function evaluate(claims, agendaClaims) {
  const matrix = { claims };
  return evaluateProgrammeClaims({ matrix, verification: claimVerification({ matrix, sourceArtifacts: SOURCES }), agendaClaims });
}
const input = (evaluation, over = {}) => ({
  zone: { id: "ez_zone", title: "房颤抗凝" }, question: "房颤患者用口服抗凝药，各药有什么证据？", taskType: "evidence-update", capabilityId: "clinical-evidence-synthesis",
  decisionId: "programme-decision-2026-10-05", agenda: { id: "agenda-1" }, episode: { id: "episode-1" }, runId: "run_1", resultVersionId: `rv_${"c".repeat(64)}`,
  evaluation, captured, machineValues: [], model: "deepseek-flash", at: new Date("2026-10-05T02:00:00.000Z"), ...over,
});

test("a claim is published only when the run verified it and the independent check did not refute or weaken it", () => {
  const evaluation = evaluate([directA, directB, synthesis, misquoted, { claimId: "CLM-005", claimType: "derived", claim: "一条推算", derivedFrom: ["CLM-001"], method: "m", assumptions: "a", sensitivity: "s" }],
    [graded("CLM-001"), graded("CLM-002", { refutation: "refuted" }), graded("CLM-003", { type: "synthesized", refutation: "weakened" })]);
  assert.deepEqual(evaluation.included.map((entry) => entry.claim.claimId), ["CLM-001"], "only the verified, standing claim is in");
  const why = Object.fromEntries(evaluation.excluded.map((entry) => [entry.claimId, entry.reason]));
  assert.deepEqual(why, { "CLM-002": "refuted", "CLM-003": "weakened", "CLM-004": "run_not_verified", "CLM-005": "derived_claim" });
  assert.equal(evaluation.pending, 0);
});

test("a ⚠ claim never reaches a card: the run's own verdict is the gate, and the card checks itself again", () => {
  const evaluation = evaluate([directA, misquoted], [graded("CLM-001"), graded("CLM-004")]);
  assert.deepEqual(evaluation.included.map((entry) => entry.claim.claimId), ["CLM-001"], "a quotation not found in its source is out before the card is built");
  const built = buildProgrammeCard(input(evaluation));
  assert.equal(built.status, "card");
  assert.deepEqual(built.card.claims.map((claim) => claim.claimId), ["CLM-001"]);
  // The re-check: hand the builder a claim the run marked verified but whose preserved text the card cannot reproduce.
  const verdict = claimVerification({ matrix: { claims: [directA] }, sourceArtifacts: SOURCES });
  const tampered = buildProgrammeCard(input(evaluateProgrammeClaims({ matrix: { claims: [directA] }, verification: verdict, agendaClaims: [graded("CLM-001")] }),
    { captured: new Map([[PATH_A, { text: "an unrelated passage that holds no such statement", digest: "a".repeat(64), capturedAt: null }]]) }));
  assert.equal(tampered.status, "refused", "a claim that does not come out ✓ against the card's own source is dropped, and nothing is left");
  assert.deepEqual(tampered.excluded.map((entry) => entry.reason), ["card_not_verified"]);
  const reread = verifyEvidenceCardClaims({ claims: built.card.claims, sources: built.card.sources });
  assert.ok(reread.claims.every((entry) => entry.mark === "✓"), "every claim the card carries is ✓ by the reader's own comparison");
});

test("a card with no qualifying claim is not written, and says why", () => {
  const none = buildProgrammeCard(input(evaluate([misquoted, directB], [graded("CLM-002", { refutation: "refuted" })])));
  assert.equal(none.status, "refused");
  assert.equal(none.outcome, "no_qualifying_claims");
  assert.deepEqual(none.excluded.map((entry) => entry.reason).sort(), ["refuted", "run_not_verified"]);
});

test("a claim whose independent check is still queued is not decided: the episode waits", () => {
  const evaluation = evaluate([directA, directB], [graded("CLM-001", { verification: { status: "queued", id: "episode-1-v0" } }), graded("CLM-002")]);
  assert.equal(evaluation.pending, 1);
  assert.deepEqual(evaluation.included.map((entry) => entry.claim.claimId), ["CLM-002"], "the claim already graded is not held back by its neighbour");
});

test("the first sentence is a claim digestPlacement would headline; a synthesized claim keeps its confidence label", () => {
  // CLM-001 direct + gated + stands is a headline; CLM-003 synthesized + gated is a lead, never the first sentence.
  const built = buildProgrammeCard(input(evaluate([synthesis, directA], [graded("CLM-001"), graded("CLM-003", { type: "synthesized" })])));
  assert.equal(built.status, "card");
  assert.equal(built.headlineClaimId, "CLM-001");
  assert.equal(built.card.content.answer, directA.claim, "the answer is the headline claim's own text");
  assert.equal(built.card.summary, directA.claim);
  const lead = built.card.claims.find((claim) => claim.claimId === "CLM-003");
  assert.equal(lead.claimType, "synthesized");
  assert.equal(lead.confidence, "moderate", "the label travels with the claim");
  assert.match(built.card.body, /综合判断（把握度：中）/, "and into the text a reader reads");
  // With only a lead, the card states no finding in its first sentence.
  const leadOnly = buildProgrammeCard(input(evaluate([synthesis], [graded("CLM-003", { type: "synthesized" })])));
  assert.equal(leadOnly.status, "card");
  assert.equal(leadOnly.headlineClaimId, null);
  assert.ok(!leadOnly.card.content.answer.includes(synthesis.claim), "a lead is never the first sentence");
  assert.match(leadOnly.card.content.answer, /没有达到“发现”标准/);
  // A reproduced claim outranks a merely standing one for the first sentence, and a reproduced synthesis is a headline with its label.
  const reproduced = buildProgrammeCard(input(evaluate([directA, synthesis], [graded("CLM-001"), graded("CLM-003", { type: "synthesized", tier: "reproduced" })])));
  assert.equal(reproduced.headlineClaimId, "CLM-003");
  assert.match(reproduced.card.content.answer, /把握度：中/);
});

test("the card satisfies the domain's contract: lineage, producer, disclosure, claims over its own sources", () => {
  const built = buildProgrammeCard(input(evaluate([directA, directB, synthesis], [graded("CLM-001"), graded("CLM-002"), graded("CLM-003", { type: "synthesized" })])));
  assert.equal(built.status, "card");
  const { card } = built;
  assert.deepEqual(evidenceLineage(card.lineage), { runId: "run_1", agendaId: "agenda-1", episodeId: "episode-1", resultVersionId: `rv_${"c".repeat(64)}` });
  assert.equal(evidenceProducer(card.producer).kind, "platform");
  assert.equal(card.originality, "synthesis");
  const disclosure = evidenceDisclosure(card.disclosure);
  assert.equal(disclosure.model, "deepseek-flash");
  assert.deepEqual(disclosure.aiSteps, ["search", "screen", "extract", "synthesize", "review"], "the independent re-check ran, and is disclosed as a step");
  assert.equal(card.sources.length, 2);
  assert.deepEqual(card.sources.map((source) => source.fetchedSha256), ["a".repeat(64), "b".repeat(64)], "the hash of the bytes the run captured");
  assert.equal(card.sources[0].documentText, TEXT_A, "the preserved text travels with the source, so the card verifies by itself");
  assert.equal(card.sources[0].coverage, "full-text");
  assert.equal(card.sources[1].coverage, "abstract");
  evidenceCardClaims(card.claims, card.sources.length);
  assert.equal(built.requestId, programmeCardRequestId("agenda-1", "evidence-update"));
  assert.equal(card.provenance, programmeCardProvenance("agenda-1", "evidence-update"));
});

test("a run with no independent check labels no review step and the card still says what it checked", () => {
  const built = buildProgrammeCard(input(evaluate([directA], [])));
  assert.equal(built.status, "card");
  assert.deepEqual(built.card.disclosure.aiSteps, ["search", "screen", "extract", "synthesize"]);
  assert.equal(built.headlineClaimId, null, "an unchecked claim is never the first sentence");
  assert.match(built.card.content.context, /引文已逐字核对/);
  assert.doesNotMatch(built.card.content.context, /独立复核/);
});

test("a card built with no decision id is refused by name", () => {
  assert.throws(() => buildProgrammeCard(input(evaluate([directA], [graded("CLM-001")]), { decisionId: null })),
    (error) => error.code === "evidence_programme_decision_required" && error.status === 409);
});

test("numbers are never typed: a comparison is kept only when every number is a machine value of the result", () => {
  const comparison = (events) => ({ title: "卒中或系统性栓塞", outcome: "卒中或系统性栓塞", timeframe: "中位随访 1.8 年", denominator: 9120, outcomeRole: "benefit",
    control: { label: "华法林", events }, intervention: { label: "阿哌沙班", events: 212 }, sourceIndexes: [1] });
  const values = [{ key: "n", value: 9120, unit: "people" }, { key: "e", value: 265, unit: "events" }, { key: "e2", value: 212, unit: "events" }];
  assert.equal(programmeComparisons({ candidates: [comparison(265)], machineValues: values, sourceCount: 1 }).length, 1);
  assert.equal(programmeComparisons({ candidates: [comparison(266)], machineValues: values, sourceCount: 1 }).length, 0, "266 is a number nobody computed");
  assert.equal(programmeComparisons({ candidates: [comparison(265)], machineValues: [], sourceCount: 1 }).length, 0, "no machine values, no comparison");
  const evaluation = evaluate([directA], [graded("CLM-001")]);
  const withValues = buildProgrammeCard(input(evaluation, { machineValues: values, comparisonCandidates: [comparison(265), comparison(266)] }));
  assert.equal(withValues.card.content.comparisons.length, 1);
  assert.equal(buildProgrammeCard(input(evaluation, { comparisonCandidates: [comparison(265)] })).card.content.comparisons, undefined, "a card without machine values carries claims and no comparison");
});

// ── The anti-paper-mill rules (plan §2.4, §5.1): the original analysis stands on engine receipts ──────────────────────────────

const VERSION_ID = `rv_${"d".repeat(64)}`;
/** The result version the drug-safety replay leaves: a method record and machine values at `values[0].…` paths. */
const replayVersion = (extra = [], over = {}) => ({
  versionId: VERSION_ID, method: { id: "faers.signals", version: "1.1.0", digest: "e".repeat(64), seeded: false, seed: null },
  inputs: [{ kind: "data", id: "faers-snapshot-2026q2", digest: "f".repeat(64), versionId: null, path: "inputs/faers.json", availability: "captured" }, { kind: "code", id: "replay.py", digest: null }],
  machineValues: [
    { key: "values[0].ror.value", value: 2.4012, unit: "ratio" }, { key: "values[0].ror.ci95_lower", value: 1.5034 }, { key: "values[0].ror.ci95_upper", value: 3.2199 },
    { key: "values[0].table.a", value: 1234 }, ...extra,
  ], ...over,
});
const receiptOf = (extra = [], over = {}) => /** @type {any} */ (receiptFromResultVersion(replayVersion(extra, over)));
const analysis = (over = {}) => ({
  zone: { id: "ez_zone", title: "房颤抗凝" }, question: "房颤患者的药物安全信号有哪些？", taskType: "signal-monitoring", capabilityId: "adr-analysis",
  decisionId: "programme-decision-2026-10-05", agenda: { id: "agenda-1" }, episode: { id: "episode-1" }, runId: "run_1", receipts: [receiptOf()],
  model: "deepseek-flash", at: new Date("2026-10-05T02:00:00.000Z"), originalPerWeek: 2, originalThisWeek: 0, ...over,
});

test("a result version is a receipt only with a method record and machine values behind it, and says which engine ran", () => {
  const receipt = receiptOf();
  assert.deepEqual([receipt.receiptId, receipt.engine, receipt.method], [VERSION_ID, "drug_safety_analysis", "faers.signals@1.1.0"]);
  assert.deepEqual(receipt.inputs, [{ datasetId: "faers-snapshot-2026q2", hash: "f".repeat(64) }], "the data it ran on, not its code");
  assert.equal(receiptFromResultVersion(replayVersion([], { method: null })), null, "a file no admitted calculation produced is not a receipt");
  assert.equal(receiptFromResultVersion(replayVersion([], { machineValues: [] })), null);
  assert.equal(receiptFromResultVersion(replayVersion([], { method: { id: "unknown.method", version: "1" } })), null, "an engine the platform does not name is not cited");
});

test("an original analysis is composed from the receipt: every number rendered from a machine value, each ✓ by the reader's own check", () => {
  const built = buildOriginalAnalysisCard(analysis());
  assert.equal(built.status, "card");
  assert.equal(built.originality, "original_analysis");
  assert.deepEqual(built.card.claims.map((claim) => [claim.claimId, claim.claimType, claim.valueSource]), [["CALC-1-ror", "calculated", "calculated"], ["CALC-1-reports", "calculated", "calculated"]]);
  assert.equal(built.card.claims[0].claim, "该药物与该不良事件的报告比值比（ROR）为 2.40，置信区间下限 1.50、上限 3.22。");
  assert.deepEqual(built.card.claims[0].calculation.alsoValues.map((entry) => entry.valuePath), ["values[0].ror.ci95_lower", "values[0].ror.ci95_upper"]);
  assert.equal(built.card.claims[1].claim, "同时报告了该药物与该不良事件的病例报告有 1,234 份。");
  const receipts = new Map([[VERSION_ID, receiptOf()]]);
  const verdict = verifyEvidenceCardClaims({ claims: built.card.claims, sources: built.card.sources }, { receipts });
  assert.ok(verdict.claims.every((entry) => entry.mark === "✓"), "the card's claims are ✓ against the receipt");
  assert.deepEqual(verifyEvidenceCardClaims(built.card).claims.map((entry) => entry.reason), ["receipt_unavailable", "receipt_unavailable"], "and never ✓ for a reader that cannot read the receipt");
  assert.doesNotThrow(() => evidenceCardClaims(built.card.claims, built.card.sources.length), "the domain's own contract holds it");
  assert.deepEqual(evidenceOriginalityBasisIssues({ originality: built.card.originality, claims: built.card.claims, zoneKind: "official" }), [], "and the official zone accepts a first-hand card");
  assert.equal(built.card.sources[0].url, null);
  assert.match(built.card.sources[0].documentText, /values\[0\]\.ror\.value\t2\.4012\tratio/, "the card keeps the machine values its sentences were rendered from");
  assert.deepEqual(evidenceLineage(built.card.lineage), built.card.lineage);
  assert.deepEqual(evidenceProducer(built.card.producer), built.card.producer);
});

test("the topic comes only from a recorded selector decision", () => {
  assert.throws(() => buildOriginalAnalysisCard(analysis({ decisionId: null })), (error) => error.code === "evidence_programme_decision_required" && error.status === 409);
});

test("an original analysis states its reporting standard in disclosure, by the domain's map of engines, and no engine outside it makes one", () => {
  const built = buildOriginalAnalysisCard(analysis());
  assert.equal(built.card.disclosure.reportingStandard, "READUS-PV");
  assert.equal(evidenceDisclosure(built.card.disclosure).reportingStandard, "READUS-PV", "the domain's disclosure contract carries it");
  const outsider = buildOriginalAnalysisCard(analysis({ capabilityId: "mendelian-randomization" }));
  assert.deepEqual([outsider.status, outsider.outcome], ["refused", "no_engine_receipt"], "a receipt of another engine is not this capability's");
  const bibliometric = buildOriginalAnalysisCard(analysis({ capabilityId: "clinical-evidence-synthesis" }));
  assert.equal(bibliometric.outcome, "no_engine_receipt", "a capability that is not an analysis engine makes no original analysis");
  const metaOnly = buildOriginalAnalysisCard(analysis({ receipts: [receiptOf([], { method: { id: "meta.dl", version: "2.0.0" } })] }));
  assert.equal(metaOnly.outcome, "no_engine_receipt", "an engine with no reporting standard in the map makes none");
});

test("an unreplicated analysis is 「信号，待验证」 in title and answer; 「发现」 needs the second independent dataset", () => {
  const signal = buildOriginalAnalysisCard(analysis());
  assert.equal(signal.replicated, false);
  assert.match(signal.card.title, /（信号，待验证）/);
  assert.match(signal.card.content.answer, /^信号，待验证：/);
  assert.match(signal.card.limitations, /尚未在第二个独立数据集中复现/);
  const corrected = [{ key: MULTIPLICITY_MACHINE_VALUE_KEYS.tested, value: 8 }, { key: MULTIPLICITY_MACHINE_VALUE_KEYS.corrected, value: 1 }];
  assert.equal(independentDatasetCount([receiptOf([{ key: REPLICATION_MACHINE_VALUE_KEY, value: 1 }])]), 1);
  const oneDataset = buildOriginalAnalysisCard(analysis({ receipts: [receiptOf([{ key: REPLICATION_MACHINE_VALUE_KEY, value: 1 }, ...corrected])] }));
  assert.equal(oneDataset.replicated, false, "the analysed dataset alone is not a replication");
  assert.match(oneDataset.card.title, /（信号，待验证）/);
  const found = buildOriginalAnalysisCard(analysis({ receipts: [receiptOf([{ key: REPLICATION_MACHINE_VALUE_KEY, value: 2 }, ...corrected])] }));
  assert.equal(found.replicated, true);
  assert.match(found.card.title, /（发现）/);
  assert.doesNotMatch(found.card.content.answer, /信号，待验证/);
  assert.equal(buildOriginalAnalysisCard(analysis({ receipts: [receiptOf([{ key: "replication", value: 3 }])] })).replicated, false, "only the named field counts");
});

test("multiple comparisons are stated when the receipt reports a correction, and otherwise the card says 未报告多重比较校正 and is a signal", () => {
  const corrected = [{ key: MULTIPLICITY_MACHINE_VALUE_KEYS.tested, value: 8 }, { key: MULTIPLICITY_MACHINE_VALUE_KEYS.corrected, value: 1 }];
  const stated = buildOriginalAnalysisCard(analysis({ receipts: [receiptOf(corrected)] }));
  assert.equal(stated.card.claims.at(-1).claim, "本次分析共检验了 8 个假设，并已做多重比较校正。", "the count is rendered from the receipt, not typed");
  assert.deepEqual(multiplicityOf([receiptOf(corrected)]).status, "corrected");
  assert.doesNotMatch(stated.card.body, /未报告多重比较校正/);

  const unreported = buildOriginalAnalysisCard(analysis());
  assert.equal(multiplicityOf([receiptOf()]).status, "not_reported", "an engine that reports nothing about it");
  assert.match(unreported.card.body, /未报告多重比较校正/);
  assert.match(unreported.card.limitations, /未报告多重比较校正/);
  assert.equal(multiplicityOf([receiptOf([{ key: MULTIPLICITY_MACHINE_VALUE_KEYS.tested, value: 8 }])]).status, "not_reported", "several tested and no correction stated");
  assert.equal(multiplicityOf([receiptOf([{ key: MULTIPLICITY_MACHINE_VALUE_KEYS.tested, value: 1 }])]).status, "single", "one hypothesis has nothing to correct");
  const replicatedButUnreported = buildOriginalAnalysisCard(analysis({ receipts: [receiptOf([{ key: REPLICATION_MACHINE_VALUE_KEY, value: 3 }])] }));
  assert.equal(replicatedButUnreported.replicated, false, "a replication does not excuse the missing correction");
  assert.match(replicatedButUnreported.card.title, /（信号，待验证）/);
});

test("the third original analysis in a rolling week is deferred, not dropped; a revision of a published one is not a new card", () => {
  const third = buildOriginalAnalysisCard(analysis({ originalThisWeek: 2 }));
  assert.equal(third.status, "deferred");
  assert.equal(third.outcome, "deferred_original_cap");
  assert.equal(buildOriginalAnalysisCard(analysis({ originalThisWeek: 1 })).status, "card", "the second is still published");
  assert.equal(buildOriginalAnalysisCard(analysis({ originalThisWeek: 2, revising: true })).status, "card", "a revision does not count against the week");
  assert.equal(buildOriginalAnalysisCard(analysis({ originalPerWeek: 0 })).status, "deferred", "a cap of zero publishes none");
  // A synthesis is not an analysis, whatever the week holds.
  assert.equal(buildProgrammeCard(input(evaluate([directA], [graded("CLM-001")]), { originalThisWeek: 99 })).status, "card");
});

test("a headline whose paths the receipt does not hold is left out and counted; the card keeps the rest, and none at all is no card", () => {
  const partial = receiptOf([], { machineValues: [{ key: "values[0].table.a", value: 40 }] });
  const built = buildOriginalAnalysisCard(analysis({ receipts: [partial] }));
  assert.deepEqual(built.card.claims.map((claim) => claim.claimId), ["CALC-1-reports"]);
  assert.deepEqual(built.excluded, [{ claimId: "CALC-1-ror", reason: "headline_unresolved" }]);
  const none = buildOriginalAnalysisCard(analysis({ receipts: [receiptOf([], { machineValues: [{ key: "other.value", value: 1 }] })] }));
  assert.deepEqual([none.status, none.outcome], ["refused", "no_qualifying_claims"]);
});

test("a run of an analysis engine read through its evidence matrix is a synthesis and carries no reporting standard", () => {
  const built = buildProgrammeCard(input(evaluate([directA], [graded("CLM-001")]), { capabilityId: "adr-analysis", taskType: "signal-monitoring", machineValues: [{ key: "ror", value: 2.4 }] }));
  assert.equal(built.originality, "synthesis", "quotations alone are interpretation, and the card contract would refuse it any other name");
  assert.equal(built.card.disclosure.reportingStandard, undefined);
  assert.deepEqual(evidenceOriginalityBasisIssues({ originality: "original_analysis", claims: built.card.claims, zoneKind: "official" }).map((issue) => issue.code), ["evidence_primary_requires_calculation"]);
});
