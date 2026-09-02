// Which rule fired, and on which line — one axis finer than which check fired.
//
// `checks` already names the check behind every finding, and that is the axis a
// false-positive distribution is computed along. It stops one level too high
// for the rules that live in data: all four of `clinical-safety-rules.json`
// report under the single id `clinical-safety-rules`, so a distribution over
// checks can say "a safety rule fired" and nothing about which one — while the
// rules have carried ids of their own all along.
//
// That gap is the input the blocking budget asks for before any rule is
// widened, narrowed, or moved to the model-judge path, and it does not exist
// until the id survives the call. These tests assert it survives: out of the
// evaluator, through the collector, into the gate issue a caller records.
//
// They are also the mutation control. Each names the exact rule id and line it
// expects, so dropping the attribution anywhere along that path fails here
// rather than producing a ledger that still looks populated.
import assert from "node:assert/strict";
import test from "node:test";

import { clinicalSafetyRuleHits, evaluateClinicalSafetyRules } from "../src/clinicalEvidence.mjs";
import { runGate } from "../index.mjs";

// The medicine is named on the second line and nowhere in the question.
const REPORT = "本节为背景说明。\n研究显示速效救心丸在部分人群中被使用。\n";
const QUESTION = "冠心病患者的证据现状如何";

test("a safety-rule finding names the rule that produced it, not just the file", () => {
  const hits = clinicalSafetyRuleHits({ reportText: REPORT, practical: "", question: QUESTION });
  const hit = hits.find((entry) => entry.ruleId === "medicine-absent-from-question");
  assert.ok(hit, `expected medicine-absent-from-question to fire; got ${hits.map((h) => h.ruleId).join(", ") || "nothing"}`);
  assert.equal(hit.where, "report");
  assert.equal(hit.line, 2, "the line must point at where the medicine is named, not at the start of the report");
});

test("a rule that fires on an absence points at its trigger, and says which", () => {
  // `suxiao-must-not-delay-emergency` fires because the practical section is
  // missing a required sentence. An absence has no line, so the only honest
  // number is where its trigger matched the report — and `where` has to say so,
  // or the number reads as the offending line and sends a repair to line 2 of
  // the wrong file.
  const hits = clinicalSafetyRuleHits({ reportText: REPORT, practical: "", question: QUESTION });
  const hit = hits.find((entry) => entry.ruleId === "suxiao-must-not-delay-emergency");
  assert.ok(hit, "expected the emergency rule to fire on a practical section that omits its required sentence");
  assert.equal(hit.where, "trigger");
  assert.equal(hit.line, 2);
});

test("naming the rule did not change which rules fire or what they say", () => {
  // The attribution is notice-only by construction: same rules, same messages,
  // same order. If this drifts, the change stopped being a measurement and
  // became a judgement, which is the one thing it must not be.
  const inputs = [
    { reportText: REPORT, practical: "", question: QUESTION },
    { reportText: REPORT, practical: REPORT, question: undefined },
    { reportText: "", practical: "", question: "" },
  ];
  for (const input of inputs) {
    assert.deepEqual(
      evaluateClinicalSafetyRules(input),
      clinicalSafetyRuleHits(input).map((hit) => hit.message),
      "the message list must stay exactly what it was before the ids were carried alongside it",
    );
  }
});

test("the rule and line reach the gate issue a caller records", () => {
  // End of the path: the GEO pack runs the same four rules over its own prose,
  // and what the ledger stores is the issue this produces. Asserting the hits
  // function alone would leave the forwarding — collector, registry, `issue()` —
  // free to drop both fields with every unit test still green.
  const pack = {
    blocks: [{
      conclusion: "速效救心丸可用于缓解症状。",
      basis: "参见文献。",
      conditions: "适用于既往确诊人群。",
    }],
  };
  const verdict = runGate({
    contractKind: "geo-content-pack",
    files: new Map([["geo-content-pack.json", JSON.stringify(pack)]]),
    expectedOutputs: [],
  });
  const raised = (verdict.issues ?? []).find((entry) => entry.code === "clinical_safety_rule");
  assert.ok(raised, "expected the pack's medicine advice to trip a clinical safety rule");
  assert.equal(raised.check, "clinical-safety-rules");
  assert.equal(raised.rule, "suxiao-must-not-delay-emergency");
  assert.ok(typeof raised.line === "number" && Number.isInteger(raised.line) && raised.line > 0, `expected a line number, got ${raised.line}`);
});
