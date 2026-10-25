import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_ACCEPT_VERDICTS, LEARNING_CORRECTION_VERDICTS, LEARNING_EVIDENCE_KINDS, LEARNING_EVIDENCE_LIMITS, LEARNING_EVIDENCE_VERDICTS, LEARNING_RULE_VERDICTS, LEARNING_STEER_VERDICTS,
  cleanLearningEvidence, isLearningCorrection, isLearningKept, learningRunOutcome,
} from "@evimed/domain";

const at = "2026-10-23T10:00:00.000Z";

test("an evidence event is of the closed kinds and verdicts; a result corrected is always a correction, silence and a use say nothing, and a steer carries what its judge said", () => {
  assert.deepEqual(LEARNING_EVIDENCE_KINDS, ["steer", "follow-up", "result-corrected", "silent", "used"]);
  assert.deepEqual(LEARNING_EVIDENCE_VERDICTS, ["correction", "preference", "rejection", "accept", "none", "adopt"], "the longitudinal harness probes this export for `adopt`");
  assert.deepEqual(LEARNING_RULE_VERDICTS, [...LEARNING_CORRECTION_VERDICTS, "adopt"], "the verdicts that carry a rule and the person's words");
  assert.deepEqual(LEARNING_ACCEPT_VERDICTS, ["accept", "adopt"]);
  assert.deepEqual(LEARNING_STEER_VERDICTS, ["correction", "preference", "rejection", "accept", "none"], "a run still going cannot be adopted");
  assert.equal(cleanLearningEvidence({ evidence: "steer", quote: "再短一点", at })?.verdict, "correction", "a steer nobody read is a correction, as it always was");
  assert.equal(cleanLearningEvidence({ evidence: "steer", verdict: "accept", quote: "好，继续", at })?.verdict, "accept", "a steer its judge read keeps the verdict");
  assert.equal(cleanLearningEvidence({ evidence: "steer", verdict: "adopt", quote: "以后都这样", at })?.verdict, "correction", "an adoption of unfinished work is no such thing: back to the unread default");
  assert.equal(cleanLearningEvidence({ evidence: "result-corrected", verdict: "none", at })?.verdict, "correction");
  assert.equal(cleanLearningEvidence({ evidence: "silent", verdict: "correction", at })?.verdict, "none");
  assert.equal(cleanLearningEvidence({ evidence: "used", verdict: "correction", at })?.verdict, "none", "a use has no words");
  assert.equal(cleanLearningEvidence({ evidence: "follow-up", verdict: "rejection", rule: "重做", quote: "重做", at })?.verdict, "rejection");
  assert.equal(cleanLearningEvidence({ evidence: "follow-up", verdict: "adopt", rule: "周报按这个来", quote: "以后周报都按这个来", at })?.verdict, "adopt");
  for (const bad of [{ evidence: "applause", at }, { evidence: "follow-up", verdict: "maybe", at }, { evidence: "follow-up", verdict: "accept" }, { evidence: "follow-up", verdict: "accept", at: "yesterday" }, null, "text", []]) {
    assert.equal(cleanLearningEvidence(bad), null, JSON.stringify(bad));
  }
});

test("the detail is cleaned and bounded: words cut, methods by id once and bounded, a shape in the ledger's form, fitted to what the ledger holds", () => {
  const detail = cleanLearningEvidence({
    evidence: "follow-up", verdict: "correction", rule: `  ${"规".repeat(500)}  `, quote: "q".repeat(900), sessionId: "s".repeat(300), at, endedAt: "2026-10-23T09:00:00Z", scope: "conversation",
    concerns: [...Array.from({ length: 12 }, (_, index) => ({ id: `method:learned:m${index}`, digest: `sha256:${index}` })), { id: "method:learned:m0", digest: "sha256:dup" }, { id: "", digest: "x" }, null],
    shape: [{ format: "DOCX", labels: ["Summary", "Findings"] }],
  });
  assert.equal(detail?.rule?.length, LEARNING_EVIDENCE_LIMITS.rule);
  assert.equal(detail?.quote?.length, LEARNING_EVIDENCE_LIMITS.quote);
  assert.equal(detail?.sessionId?.length, LEARNING_EVIDENCE_LIMITS.sessionId);
  assert.equal(detail?.concerns.length, LEARNING_EVIDENCE_LIMITS.concerns);
  assert.equal(detail?.concerns[0].digest, "sha256:0", "the first mention of a method stands");
  assert.deepEqual(detail?.shape, [{ format: "docx", labels: ["summary", "findings"] }]);
  assert.equal(detail?.endedAt, "2026-10-23T09:00:00.000Z");
  // A detail too big for the ledger gives up its shape, then its rule, then the end of its quotation, and is never refused for size.
  const crowded = cleanLearningEvidence({ evidence: "follow-up", verdict: "correction", rule: "规".repeat(300), quote: "引".repeat(600), at, scope: "conversation",
    shape: Array.from({ length: 4 }, (_, file) => ({ format: `f${file}`, labels: Array.from({ length: 16 }, (_unused, index) => `${String.fromCharCode(97 + index)}${"l".repeat(38)}`) })) });
  assert.ok(new TextEncoder().encode(JSON.stringify(crowded)).length <= LEARNING_EVIDENCE_LIMITS.bytes);
  assert.equal(crowded?.shape, undefined);
});

test("a correction is a corrected result, or a steer or follow-up read as a correction, a preference or a rejection; silence, a use, an acceptance, an adoption and a new question are the run left alone", () => {
  assert.equal(isLearningCorrection({ evidence: "steer" }), true, "an unread steer is a correction");
  assert.equal(isLearningCorrection({ evidence: "result-corrected" }), true);
  for (const verdict of ["correction", "preference", "rejection"]) {
    assert.equal(isLearningCorrection({ evidence: "follow-up", verdict }), true, verdict);
    assert.equal(isLearningCorrection({ evidence: "steer", verdict }), true, `a steer read as ${verdict}`);
  }
  for (const verdict of ["accept", "none", "adopt"]) {
    assert.equal(isLearningCorrection({ evidence: "follow-up", verdict }), false, verdict);
    assert.equal(isLearningCorrection({ evidence: "steer", verdict }), false, `a steer read as ${verdict} is not a correction`);
  }
  assert.equal(isLearningCorrection({ evidence: "silent", verdict: "none" }), false);
  assert.equal(isLearningCorrection({ evidence: "used", verdict: "none" }), false);
  assert.equal(isLearningCorrection(null), false);
});

test("a run is kept when it was accepted, adopted or its file taken, and nothing else is: silence and a message about something else are unknown", () => {
  assert.equal(isLearningKept({ evidence: "used" }), true);
  for (const verdict of ["accept", "adopt"]) assert.equal(isLearningKept({ evidence: "follow-up", verdict }), true, verdict);
  for (const detail of [{ evidence: "silent", verdict: "none" }, { evidence: "follow-up", verdict: "none" }, { evidence: "follow-up", verdict: "correction" }, { evidence: "steer", verdict: "accept" }, { evidence: "steer", verdict: "none" }, null]) {
    assert.equal(isLearningKept(detail), false, JSON.stringify(detail));
  }
  const silent = { evidence: "silent", verdict: "none" };
  assert.equal(learningRunOutcome([]), "unknown");
  assert.equal(learningRunOutcome([silent]), "unknown", "silence is not approval");
  assert.equal(learningRunOutcome([silent, { evidence: "follow-up", verdict: "none" }]), "unknown", "a new question says nothing about the work");
  assert.equal(learningRunOutcome([silent, { evidence: "used" }]), "clean");
  assert.equal(learningRunOutcome([{ evidence: "follow-up", verdict: "accept" }]), "clean");
  assert.equal(learningRunOutcome([{ evidence: "follow-up", verdict: "adopt" }]), "clean", "an adoption is an acceptance");
  assert.equal(learningRunOutcome([{ evidence: "used" }, { evidence: "follow-up", verdict: "preference" }]), "corrected", "a correction wins, whenever it came");
  assert.equal(learningRunOutcome([{ evidence: "used" }, { evidence: "steer" }]), "corrected", "an unread steer is a correction");
  assert.equal(learningRunOutcome([{ evidence: "used" }, { evidence: "steer", verdict: "none" }]), "clean", "a steer its judge read as nothing is no correction");
  assert.equal(learningRunOutcome([{ evidence: "used" }, { evidence: "result-corrected" }]), "corrected");
  assert.equal(learningRunOutcome(/** @type {any} */ (null)), "unknown");
});
