import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_ERROR_CODES,
  ERROR_CODE_MESSAGES,
  EVIDENCE_CHANGE_CATEGORIES,
  EVIDENCE_CHANGE_CATEGORY_LABELS_ZH,
  EVIDENCE_CHANGE_SUMMARY_MAX_CHARS,
  EVIDENCE_CHANGE_TRIGGERS,
  EVIDENCE_CHANGE_TRIGGER_LABELS_ZH,
  EVIDENCE_UPKEEP_ERROR_CODES,
  errorCodeOutcome,
  evidenceChallengeRoute,
  evidenceChangeSummaryZh,
  evidenceConclusionChanged,
  evidenceNewEvidenceNoticeTitleZh,
  evidenceUpkeepRoute,
} from "../index.mjs";

test("the change log's two lists are closed and every member reads in Chinese", () => {
  assert.deepEqual([...EVIDENCE_CHANGE_CATEGORIES], ["searched_no_change", "new_evidence_conclusion_changed", "new_evidence_conclusion_unchanged", "correction", "withdrawal", "retired"]);
  assert.deepEqual([...EVIDENCE_CHANGE_TRIGGERS], ["source_change", "new_evidence", "challenge", "producer_edit", "scheduled_check"]);
  for (const category of EVIDENCE_CHANGE_CATEGORIES) assert.match(/** @type {any} */ (EVIDENCE_CHANGE_CATEGORY_LABELS_ZH)[category], /[一-鿿]/);
  for (const trigger of EVIDENCE_CHANGE_TRIGGERS) assert.match(/** @type {any} */ (EVIDENCE_CHANGE_TRIGGER_LABELS_ZH)[trigger], /[一-鿿]/);
});

test("who answers is decided by who made the card: the editor for an AI card, the producer for a person's, the programme for an official synthesis", () => {
  // The platform's own brief in an official zone: the editor keeps it.
  assert.equal(evidenceUpkeepRoute({ zoneKind: "official", producerKind: "platform", authorKind: "ai", originality: "brief" }), "editor");
  // An official synthesis, an original analysis, or anything the programme stamped with a run: not the editor's to rewrite.
  assert.equal(evidenceUpkeepRoute({ zoneKind: "official", producerKind: "platform", authorKind: "ai", originality: "synthesis" }), "programme");
  assert.equal(evidenceUpkeepRoute({ zoneKind: "official", producerKind: "platform", authorKind: "ai", originality: "brief", lineage: { agendaId: "ag_1" } }), "programme");
  assert.equal(evidenceUpkeepRoute({ zoneKind: "official", producerKind: "platform", authorKind: "ai", originality: "recalculation" }), "programme");
  // The owner's own upkeep of their zone is the editor's; their hand-written card is theirs.
  assert.equal(evidenceUpkeepRoute({ zoneKind: "user", producerKind: "user", authorKind: "ai", originality: "brief" }), "editor");
  assert.equal(evidenceUpkeepRoute({ zoneKind: "user", producerKind: "user", authorKind: "human", originality: "synthesis" }), "producer_notice");
  // A product zone is never rewritten, whoever wrote the words.
  assert.equal(evidenceUpkeepRoute({ zoneKind: "product", producerKind: "enterprise", authorKind: "ai" }), "producer_notice");
  assert.equal(evidenceUpkeepRoute({ zoneKind: "user", producerKind: "doctor", authorKind: "ai" }), "producer_notice");
  assert.equal(evidenceChallengeRoute({ producerKind: "platform" }), "platform_recheck");
  for (const producerKind of ["user", "enterprise", "doctor", "external", null]) assert.equal(evidenceChallengeRoute({ producerKind }), "producer_notice");
});

test("a conclusion has changed when the answer, a claim or a number moved, not when the prose around it did", () => {
  const card = {
    summary: "Fewer strokes", content: { answer: "The drug reduces stroke.", sections: [{ title: "a", text: "long prose" }],
      comparisons: [{ outcome: "Stroke", denominator: 100, control: { events: 12 }, intervention: { events: 7 }, relativeEffect: "RR 0.58" }] },
    claims: [{ claimId: "CLM-1", claim: "Stroke fell." }],
  };
  assert.equal(evidenceConclusionChanged(card, JSON.parse(JSON.stringify(card))), false);
  assert.equal(evidenceConclusionChanged(card, { ...card, content: { ...card.content, sections: [{ title: "a", text: "entirely different prose" }] } }), false, "prose is not the conclusion");
  assert.equal(evidenceConclusionChanged(card, { ...card, content: { ...card.content, comparisons: [{ ...card.content.comparisons[0], relativeEffect: "RR 0.71" }] } }), true, "an effect that moved is");
  assert.equal(evidenceConclusionChanged(card, { ...card, claims: [] }), true, "a claim removed is");
  assert.equal(evidenceConclusionChanged(card, { ...card, content: { ...card.content, answer: "No clear effect." } }), true);
});

test("an entry's sentence is made from facts and says what happened in plain Chinese", () => {
  const said = (/** @type {any} */ entry) => evidenceChangeSummaryZh(entry);
  assert.match(said({ category: "searched_no_change", trigger: "scheduled_check" }), /没有发现.*新证据.*结论未变/);
  assert.match(said({ category: "new_evidence_conclusion_changed", trigger: "new_evidence", facts: { itemCount: 2, revisionBefore: 3, revisionAfter: 5 } }), /2 项.*结论有变化.*第 3 版 → 第 5 版/);
  assert.match(said({ category: "new_evidence_conclusion_unchanged", trigger: "new_evidence", facts: { itemCount: 1 } }), /1 项.*结论未变/);
  assert.match(said({ category: "correction", trigger: "source_change", facts: { sourceChangeKinds: ["retraction"], sourceCount: 1 } }), /已撤稿/);
  assert.match(said({ category: "correction", trigger: "challenge", facts: { claimId: "CLM-2", revisionBefore: 2, revisionAfter: 3 } }), /CLM-2.*修正/);
  assert.match(said({ category: "withdrawal", trigger: "challenge", facts: { claimId: "CLM-2", cardWithdrawn: true } }), /撤回该条结论.*本卡.*撤回/);
  assert.match(said({ category: "searched_no_change", trigger: "challenge", facts: { claimId: "CLM-2" } }), /维持原结论/);
  // A calculated claim is checked against its receipt, never a source: its entries do not say "原文".
  const calculated = { claimId: "CALC-1", calculated: true };
  assert.match(said({ category: "withdrawal", trigger: "challenge", facts: calculated }), /CALC-1.*计算依据对不上平台保存的回执，已撤回该条结论。$/);
  assert.match(said({ category: "withdrawal", trigger: "challenge", facts: { ...calculated, cardWithdrawn: true, lostCalculationBasis: true } }), /已没有一条带计算依据，一手分析无法成立，本卡一并撤回/);
  assert.match(said({ category: "correction", trigger: "challenge", facts: calculated }), /修正了该条结论的表述，数字仍与平台保存的回执一致/);
  assert.match(said({ category: "searched_no_change", trigger: "challenge", facts: calculated }), /维持原结论，数字已按平台保存的回执重新核对/);
  for (const category of ["withdrawal", "correction", "searched_no_change"]) assert.doesNotMatch(said({ category, trigger: "challenge", facts: calculated }), /原文/, category);
  assert.match(said({ category: "correction", trigger: "producer_edit", facts: { revisionBefore: 1, revisionAfter: 2 } }), /出品方更新了本卡/);
  assert.match(said({ category: "new_evidence_conclusion_changed", trigger: "producer_edit", facts: { itemCount: 2, revisionBefore: 1, revisionAfter: 2 } }), /核对了 2 项新研究并更新了本卡；结论有变化（第 1 版 → 第 2 版）/);
  assert.match(said({ category: "new_evidence_conclusion_unchanged", trigger: "producer_edit", facts: { itemCount: 1 } }), /核对了 1 项新研究并更新了本卡；结论未变/);
  assert.match(said({ category: "retired", trigger: "scheduled_check", facts: { lastCheckedAt: "2026-10-05T01:00:00Z" } }), /不再更新.*2026-10-05/);
  assert.match(said({ category: "retired", trigger: "producer_edit", facts: { retiredBy: "producer" } }), /出品方说明/);
  for (const category of EVIDENCE_CHANGE_CATEGORIES) for (const trigger of EVIDENCE_CHANGE_TRIGGERS) {
    const sentence = said({ category, trigger, facts: { sourceChangeKinds: ["retraction", "correction"], claimId: "X", itemCount: 3 } });
    assert.ok(sentence.length > 4 && sentence.length <= EVIDENCE_CHANGE_SUMMARY_MAX_CHARS, `${category}/${trigger}`);
  }
  assert.match(evidenceNewEvidenceNoticeTitleZh({ count: 2 }), /有 2 项新研究可能影响你的卡片/);
});

test("its refusals are registered with a Chinese sentence and are never a verdict on a run", () => {
  for (const code of EVIDENCE_UPKEEP_ERROR_CODES) {
    assert.ok(ALL_ERROR_CODES.includes(code), `${code} is in no registry list`);
    assert.match(/** @type {Record<string, string>} */ (ERROR_CODE_MESSAGES)[code] ?? "", /[一-鿿]/, `${code} has no sentence`);
    assert.equal(errorCodeOutcome(code), "upstream");
  }
  assert.match(/** @type {any} */ (ERROR_CODE_MESSAGES).evidence_automation_product_zone, /站内通知/, "the answer says to use the notice instead");
});
