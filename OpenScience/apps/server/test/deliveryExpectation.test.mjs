import assert from "node:assert/strict";
import test from "node:test";

import { NO_EXPECTATION, buildExpectation, compareExpectation, namedCapability } from "../src/deliveryExpectation.mjs";

const capabilities = [
  { id: "clinical-evidence-synthesis", title: "Clinical Evidence Synthesis", produces: [{ contractKind: "clinical-evidence-report" }] },
  { id: "meta-analysis", title: "Meta Analysis", produces: [{ contractKind: "meta-analysis-report" }] },
  { id: "adr-analysis", title: "ADR Analysis", produces: [{ contractKind: "adr-analysis-report" }] },
];

test("naming a capability is an instruction and outranks a classification", () => {
  const expectation = buildExpectation({
    text: "用 clinical-evidence-synthesis 做一份证据综述",
    capabilities,
    classified: { capabilityId: "meta-analysis", reason: "mentions synthesis" },
  });
  assert.equal(expectation.confidence, "named");
  assert.deepEqual(expectation.contractKinds, ["clinical-evidence-report"]);
});

test("a classification is an observation, and it is recorded as one", () => {
  const expectation = buildExpectation({
    text: "帮我看看这个药的安全信号",
    capabilities,
    classified: { capabilityId: "adr-analysis", reason: "asks about safety signals" },
  });
  assert.equal(expectation.confidence, "classified");
  assert.deepEqual(expectation.contractKinds, ["adr-analysis-report"]);
});

test("a request that implies no deliverable expects none", () => {
  const expectation = buildExpectation({ text: "你好", capabilities, classified: null });
  assert.deepEqual(expectation.contractKinds, []);
  assert.equal(expectation.confidence, NO_EXPECTATION.confidence);
});

test("a high-risk medicine named in the request is recorded even when nothing routes", () => {
  // This is the one job the retired regex net actually had. It no longer routes:
  // the content triggers apply the clinical rules to whatever is produced. What
  // survives here is the record of why they will.
  const expectation = buildExpectation({ text: "速效救心丸的疗效分析", capabilities, classified: null });
  assert.equal(expectation.confidence, "trigger");
  assert.deepEqual(expectation.clinicalTriggers, ["速效救心丸"]);
  assert.deepEqual(expectation.contractKinds, [], "a trigger is not a routing decision");
});

test("a mismatch is a notice, never a refusal", () => {
  const expectation = buildExpectation({ text: "meta-analysis", capabilities, classified: null });
  const result = compareExpectation(expectation, [{ contractKind: "clinical-evidence-report", status: "accepted" }]);
  assert.equal(result.matched, false);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], /不一定是错的/, "a classifier's guess must not read as a verdict");
  assert.match(result.notices[0], /逐问核对/, "it belongs in the question-by-question check, not in a repair round");
});

test("a match produces nothing at all", () => {
  const expectation = buildExpectation({ text: "meta-analysis", capabilities, classified: null });
  assert.deepEqual(compareExpectation(expectation, [{ contractKind: "meta-analysis-report", status: "accepted" }]), { matched: true, notices: [] });
  assert.deepEqual(compareExpectation(NO_EXPECTATION, []), { matched: true, notices: [] });
});

test("a rejected deliverable does not count as delivered", () => {
  const expectation = buildExpectation({ text: "meta-analysis", capabilities, classified: null });
  const result = compareExpectation(expectation, [{ contractKind: "meta-analysis-report", status: "rejected" }]);
  assert.equal(result.matched, false);
  assert.match(result.notices[0], /没有交付任何产物/);
});

test("an unknown contract kind from a classifier is ignored rather than trusted", () => {
  const expectation = buildExpectation({ text: "x", capabilities, classified: { contractKind: "not-a-kind" } });
  assert.deepEqual(expectation.contractKinds, []);
});

test("a capability is named by id or by a long enough title, never by a common word", () => {
  assert.equal(namedCapability("run meta-analysis on this", capabilities)?.id, "meta-analysis");
  assert.equal(namedCapability("Clinical Evidence Synthesis please", capabilities)?.id, "clinical-evidence-synthesis");
  assert.equal(namedCapability("这个分析怎么做", capabilities), null);
});
