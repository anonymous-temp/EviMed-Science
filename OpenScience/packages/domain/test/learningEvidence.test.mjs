import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_EVIDENCE_KINDS, LEARNING_EVIDENCE_LIMITS, cleanLearningEvidence, isLearningCorrection } from "@evimed/domain";

const at = "2026-10-23T10:00:00.000Z";

test("an evidence event is of the closed kinds and verdicts, and the kinds that are corrections by where they happened carry no other verdict", () => {
  assert.deepEqual(LEARNING_EVIDENCE_KINDS, ["steer", "follow-up", "result-corrected", "silent"]);
  assert.equal(cleanLearningEvidence({ evidence: "steer", verdict: "accept", quote: "再短一点", at })?.verdict, "correction");
  assert.equal(cleanLearningEvidence({ evidence: "result-corrected", verdict: "none", at })?.verdict, "correction");
  assert.equal(cleanLearningEvidence({ evidence: "silent", verdict: "correction", at })?.verdict, "none");
  assert.equal(cleanLearningEvidence({ evidence: "follow-up", verdict: "rejection", rule: "重做", quote: "重做", at })?.verdict, "rejection");
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

test("a correction is a steer, a corrected result, or a follow-up that corrected, preferred or rejected; silence, an acceptance and a new question are the run left alone", () => {
  assert.equal(isLearningCorrection({ evidence: "steer" }), true);
  assert.equal(isLearningCorrection({ evidence: "result-corrected" }), true);
  for (const verdict of ["correction", "preference", "rejection"]) assert.equal(isLearningCorrection({ evidence: "follow-up", verdict }), true, verdict);
  for (const verdict of ["accept", "none"]) assert.equal(isLearningCorrection({ evidence: "follow-up", verdict }), false, verdict);
  assert.equal(isLearningCorrection({ evidence: "silent", verdict: "none" }), false);
  assert.equal(isLearningCorrection(null), false);
});
