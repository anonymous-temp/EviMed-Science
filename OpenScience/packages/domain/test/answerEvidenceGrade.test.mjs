// The answer-level evidence grade: every letter, the U floor, the two
// decidable reasons to lose a rung, the one cap, and the certainty wording the
// two engines share.
import assert from "node:assert/strict";
import test from "node:test";

import { CERTAINTY_LEVELS } from "../index.mjs";
import {
  ANSWER_EVIDENCE_GRADES,
  ANSWER_EVIDENCE_GRADE_LABELS_ZH,
  ANSWER_EVIDENCE_THRESHOLDS,
  CERTAINTY_WORDING_ZH,
  answerGradeCertainty,
  answerGradeWording,
  certaintyWording,
  gradeAnswerEvidence,
} from "../src/answerEvidenceGrade.mjs";

/** A ratio-scale effect on the named interval. @param {number} estimate @param {number} low @param {number} high */
function rr(estimate, low, high) {
  return { measure: "rr", estimate, ciLow: low, ciHigh: high };
}

/** @param {readonly any[]} reasons @param {string} code @returns {any} */
function reasonOf(reasons, code) {
  const found = reasons.find((entry) => entry.code === code);
  assert.ok(found, `expected a ${code} reason, got ${reasons.map((entry) => entry.code).join(", ")}`);
  return found;
}

test("A: two randomised trials, enough participants, one direction, an interval clear of the null line", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 2_500, effect: rr(0.78, 0.66, 0.92) },
      { design: "rct", participants: 2_500, effect: rr(0.81, 0.70, 0.94) },
    ],
  });
  assert.equal(grade, "A");
  // Every reason is a fact with a code, what it did to the letter, and its own numbers.
  assert.deepEqual(reasons.map((entry) => entry.code), ["design", "studies", "participants", "direction", "interval"]);
  for (const entry of reasons) {
    assert.equal(typeof entry.text, "string");
    assert.ok(entry.text.length > 0);
    assert.equal(entry.steps, 0);
  }
  assert.equal(reasonOf(reasons, "design").topDesign, "rct");
  assert.equal(reasonOf(reasons, "studies").studies, 2);
  assert.equal(reasonOf(reasons, "participants").participants, 5_000);
  assert.equal(reasonOf(reasons, "direction").conflict, false);
  assert.deepEqual(reasonOf(reasons, "direction").directions, { increase: 0, decrease: 2, "no-difference": 0, unclear: 0 });
  assert.equal(reasonOf(reasons, "interval").crossesNull, false);
  assert.equal(answerGradeCertainty(grade), "high");
});

test("B: the same body once its intervals admit no effect", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 2_500, effect: rr(0.88, 0.70, 1.10) },
      { design: "rct", participants: 2_500, effect: rr(0.91, 0.74, 1.12) },
    ],
  });
  assert.equal(grade, "B");
  assert.equal(reasonOf(reasons, "interval").steps, -1);
  assert.equal(reasonOf(reasons, "interval").crossing, 2);
  assert.equal(reasonOf(reasons, "interval").intervals, 2);
  assert.equal(answerGradeCertainty(grade), "moderate");
});

test("C: a randomised body that both disagrees with itself and cannot exclude no effect loses two rungs", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 900, effect: rr(0.70, 0.52, 0.95) },
      { design: "rct", participants: 900, effect: rr(1.40, 0.90, 2.00) },
    ],
  });
  assert.equal(grade, "C");
  assert.equal(reasonOf(reasons, "direction").conflict, true);
  assert.equal(reasonOf(reasons, "direction").steps, -1);
  assert.equal(reasonOf(reasons, "interval").steps, -1);
  assert.equal(reasonOf(reasons, "participants").steps, 0);
});

test("D: all three decidable defects at once take a randomised body to the bottom rung", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 100, effect: rr(0.70, 0.40, 1.20) },
      { design: "rct", participants: 120, effect: rr(1.50, 0.80, 2.50) },
    ],
  });
  assert.equal(grade, "D");
  assert.deepEqual(
    reasons.filter((entry) => entry.steps === -1).map((entry) => entry.code),
    ["participants", "direction", "interval"],
  );
  assert.equal(reasonOf(reasons, "participants").participants, 220);
  assert.equal(reasonOf(reasons, "participants").threshold, ANSWER_EVIDENCE_THRESHOLDS.minParticipants);
  assert.equal(answerGradeCertainty(grade), "very-low");
});

test("C: an observational body starts two rungs down, and stays there when nothing else is wrong", () => {
  const { grade } = gradeAnswerEvidence({
    sources: [
      { design: "observational", participants: 40_000, effect: rr(0.62, 0.55, 0.71) },
      { design: "observational", participants: 18_000, effect: rr(0.66, 0.58, 0.75) },
    ],
  });
  assert.equal(grade, "C");
});

test("D: case reports are the bottom rung before anything is subtracted", () => {
  assert.equal(gradeAnswerEvidence({
    sources: [{ design: "case-report", participants: 1 }, { design: "case-report", participants: 2 }],
  }).grade, "D");
});

test("a drug label is authoritative but not a design: a label beside a cohort starts at C", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [{ design: "label" }, { design: "observational", participants: 5_000 }],
  });
  assert.equal(grade, "C");
  assert.equal(reasonOf(reasons, "design").topDesign, "label");
});

test("U: fewer decidable sources than the floor, whatever else is known about them", () => {
  const empty = gradeAnswerEvidence({ sources: [] });
  assert.equal(empty.grade, "U");
  assert.equal(reasonOf(empty.reasons, "insufficient").required, ANSWER_EVIDENCE_THRESHOLDS.minGradableSources);
  assert.equal(reasonOf(empty.reasons, "insufficient").gradable, 0);

  // A narrative review is secondary prose, a trial registration has no results
  // and `other` is the source-type table saying it does not know: none of the
  // three is a design, so this body has one decidable source, not four.
  const mostlyUngradable = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 9_000, effect: rr(0.7, 0.6, 0.8) },
      { design: "review" },
      { design: "trial-registration" },
      { design: "other" },
    ],
  });
  assert.equal(mostlyUngradable.grade, "U");
  assert.equal(reasonOf(mostlyUngradable.reasons, "design").gradable, 1);
  assert.equal(reasonOf(mostlyUngradable.reasons, "design").ungradable, 3);
  assert.equal(answerGradeCertainty("U"), null);
  assert.equal(answerGradeWording("U", "降低"), null);

  // Nothing at all, and a shape that is not a source, are the same answer.
  assert.equal(gradeAnswerEvidence({}).grade, "U");
  assert.equal(gradeAnswerEvidence({ sources: [null, "a paper", 7] }).grade, "U");
  assert.equal(gradeAnswerEvidence(/** @type {any} */ (undefined)).grade, "U");
});

test("the top letter is capped, not dropped, when no source reports its size", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [{ design: "guideline" }, { design: "systematic-review" }],
  });
  assert.equal(grade, "B");
  assert.equal(reasonOf(reasons, "participants").participants, null);
  assert.equal(reasonOf(reasons, "participants").steps, 0, "unknown is not the same as small");
  assert.deepEqual(
    { from: reasonOf(reasons, "cap").from, to: reasonOf(reasons, "cap").to, because: reasonOf(reasons, "cap").because },
    { from: "A", to: "B", because: "participants-unknown" },
  );

  // One reported size is a decidable floor for the whole body, and a floor
  // above the threshold neither drops the letter nor caps it.
  const partlySized = gradeAnswerEvidence({
    sources: [
      { design: "systematic-review", participants: 12_000, effect: rr(0.75, 0.65, 0.86) },
      { design: "guideline" },
    ],
  });
  assert.equal(partlySized.grade, "A");
  assert.equal(reasonOf(partlySized.reasons, "participants").unsized, 1);
});

test("direction: opposite directions conflict, no-difference beside an effect does not", () => {
  const mixed = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 3_000, direction: "decrease" },
      { design: "rct", participants: 3_000, direction: "no-difference" },
    ],
  });
  assert.equal(reasonOf(mixed.reasons, "direction").conflict, false);
  assert.equal(mixed.grade, "A");

  const opposed = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 3_000, direction: "reduced" },
      { design: "rct", participants: 3_000, direction: "higher" },
    ],
  });
  assert.equal(reasonOf(opposed.reasons, "direction").conflict, true);
  assert.equal(opposed.grade, "B");
  assert.ok(reasonOf(opposed.reasons, "direction").text.startsWith("方向不一致"));
});

test("the null line comes from the scale, the measure or an explicit value — never a guess", () => {
  /** @param {Record<string, any>} effect */
  const interval = (effect) => reasonOf(gradeAnswerEvidence({
    sources: [{ design: "rct", participants: 5_000, effect }, { design: "rct", participants: 5_000, effect }],
  }).reasons, "interval");

  // A risk difference is measured against 0, so [-0.02, 0.09] crosses and
  // [0.03, 0.09] does not. Checked against 1, both would read as "crosses".
  assert.equal(interval({ measure: "rd", estimate: 0.04, ciLow: -0.02, ciHigh: 0.09 }).crossesNull, true);
  assert.equal(interval({ scale: "difference", estimate: 0.06, ciLow: 0.03, ciHigh: 0.09 }).crossesNull, false);
  assert.equal(interval({ measure: "hr", estimate: 0.82, ciLow: 0.71, ciHigh: 0.95 }).crossesNull, false);
  assert.equal(interval({ nullValue: 1, estimate: 1.04, ciLow: 0.88, ciHigh: 1.23 }).crossesNull, true);
  // Reversed bounds are still an interval; an unnamed scale is not a decidable one.
  assert.equal(interval({ measure: "rr", ciLow: 1.4, ciHigh: 0.8 }).crossesNull, true);
  assert.equal(interval({ estimate: 0.7, ciLow: 0.5, ciHigh: 0.9 }).crossesNull, null);
  assert.equal(interval({ measure: "rr", estimate: 0.7 }).crossesNull, null);

  // Undecidable costs nothing, which is what keeps the letter honest rather
  // than pessimistic.
  assert.equal(gradeAnswerEvidence({
    sources: [{ design: "rct", participants: 5_000 }, { design: "rct", participants: 5_000 }],
  }).grade, "A");
});

test("a pooled estimate answers the interval question outright", () => {
  const sources = [
    { design: "rct", participants: 2_000, effect: rr(0.80, 0.60, 1.05) },
    { design: "rct", participants: 2_000, effect: rr(0.84, 0.64, 1.10) },
  ];
  // Two imprecise trials, precise once pooled: the pooled interval is the body's.
  const pooled = gradeAnswerEvidence({ sources, pooledEffect: rr(0.82, 0.71, 0.95) });
  assert.equal(pooled.grade, "A");
  assert.equal(reasonOf(pooled.reasons, "interval").pooled, true);
  assert.equal(reasonOf(pooled.reasons, "interval").steps, 0);
  assert.equal(gradeAnswerEvidence({ sources }).grade, "B");

  // And the other way: individually clear, pooled not.
  const clearButNotPooled = gradeAnswerEvidence({
    sources: [
      { design: "rct", participants: 2_000, effect: rr(0.70, 0.52, 0.95) },
      { design: "rct", participants: 2_000, effect: rr(0.88, 0.78, 0.99) },
    ],
    pooledEffect: rr(0.84, 0.69, 1.02),
  });
  assert.equal(clearButNotPooled.grade, "B");
  assert.equal(reasonOf(clearButNotPooled.reasons, "interval").crossesNull, true);
});

test("without a pooled estimate the body is imprecise once half its intervals admit no effect", () => {
  /** @param {number} crossing @param {number} clear */
  const body = (crossing, clear) => gradeAnswerEvidence({
    sources: [
      ...Array.from({ length: crossing }, () => ({ design: "rct", participants: 1_000, effect: rr(0.9, 0.7, 1.15) })),
      ...Array.from({ length: clear }, () => ({ design: "rct", participants: 1_000, effect: rr(0.8, 0.7, 0.93) })),
    ],
  });
  assert.equal(ANSWER_EVIDENCE_THRESHOLDS.crossingFraction, 0.5);
  assert.equal(body(1, 3).grade, "A", "one interval in four is not an imprecise body");
  assert.equal(body(2, 2).grade, "B", "half of them is");
  assert.equal(body(3, 1).grade, "B");
});

test("a source's design is the shared source-type decision, and pooled sources bring their own study count", () => {
  const { grade, reasons } = gradeAnswerEvidence({
    sources: [
      // No `design`: typed from NLM publication types by sourceTypes.mjs, the
      // same decision every badge in the product draws.
      { publicationTypes: ["Meta-Analysis", "Review"], studies: 12, participants: 24_000, effect: rr(0.79, 0.70, 0.89) },
      { url: "https://www.nice.org.uk/guidance/ng238" },
      { sourceType: "rct", n: 1_800, direction: "decrease" },
      { tool: "drug_label_search", sampleSize: 0 },
    ],
  });
  assert.equal(reasonOf(reasons, "design").designs["meta-analysis"], 1);
  assert.equal(reasonOf(reasons, "design").designs.guideline, 1);
  assert.equal(reasonOf(reasons, "design").designs.rct, 1);
  assert.equal(reasonOf(reasons, "design").designs.label, 1);
  assert.equal(reasonOf(reasons, "studies").studies, 15, "12 pooled studies plus three single sources");
  assert.equal(reasonOf(reasons, "participants").participants, 25_800);
  assert.equal(grade, "A");
});

test("every letter is reachable, the ladder is the certainty ladder, and U is not a rung on it", () => {
  assert.deepEqual([...ANSWER_EVIDENCE_GRADES], ["A", "B", "C", "D", "U"]);
  assert.deepEqual(
    ANSWER_EVIDENCE_GRADES.map((grade) => answerGradeCertainty(grade)),
    ["high", "moderate", "low", "very-low", null],
  );
  assert.deepEqual(Object.keys(ANSWER_EVIDENCE_GRADE_LABELS_ZH).sort(), [...ANSWER_EVIDENCE_GRADES].sort());
  for (const grade of ANSWER_EVIDENCE_GRADES) {
    assert.equal(typeof ANSWER_EVIDENCE_GRADE_LABELS_ZH[grade], "string");
  }
});

test("the certainty wording table is §5.8's, and it covers every rung exactly once", () => {
  assert.deepEqual(Object.keys(CERTAINTY_WORDING_ZH).sort(), [...CERTAINTY_LEVELS].sort());
  // The plan's own examples, which are the reason the table exists: two engines
  // hedging one body of evidence differently reads as two findings.
  assert.deepEqual(
    CERTAINTY_LEVELS.map((level) => certaintyWording(level, "降低")),
    ["是否降低尚不确定", "可能降低", "很可能降低", "可降低"],
  );
  for (const level of CERTAINTY_LEVELS) {
    assert.equal(CERTAINTY_WORDING_ZH[level].example, certaintyWording(level, "降低"));
    assert.equal(CERTAINTY_WORDING_ZH[level].level, level);
  }
  assert.equal(certaintyWording("high", "改善"), "可改善");
  assert.equal(answerGradeWording("C", "增加"), "可能增加");
  // Nothing to say is said as nothing, never as a hedge.
  assert.equal(certaintyWording("high", "  "), null);
  assert.equal(certaintyWording("nonsense", "降低"), null);
  assert.equal(answerGradeWording("U", "降低"), null);
});

test("the result is frozen: a caller cannot edit the letter or the facts it rests on", () => {
  const result = gradeAnswerEvidence({ sources: [{ design: "rct", participants: 5_000 }, { design: "rct", participants: 5_000 }] });
  assert.throws(() => { /** @type {any} */ (result).grade = "A"; }, TypeError);
  assert.throws(() => { /** @type {any} */ (result.reasons).push({}); }, TypeError);
  assert.throws(() => { /** @type {any} */ (result.reasons[0]).steps = -3; }, TypeError);
});
