import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_PURPOSES,
  USAGE_PURPOSE_LABELS_ZH,
  isUsagePurpose,
  usagePurpose,
  usagePurposeOfRun,
} from "../index.mjs";

test("the purpose vocabulary is the closed set the ledger's CHECK is built from", () => {
  // The contract every stream codes against (X1). A member added here without
  // the others agreeing is a report column nobody fills; one removed is an
  // insert the database refuses.
  assert.deepEqual([...USAGE_PURPOSES], [
    "kernel", "memory-extraction", "routing", "title", "engine",
    "capsule-scan", "channel-intent", "source-understanding", "learning", "frontier", "other",
  ]);
  assert.ok(Object.isFrozen(USAGE_PURPOSES));
  for (const purpose of USAGE_PURPOSES) {
    // The migration interpolates these into SQL, so their shape is the safety.
    assert.match(purpose, /^[a-z][a-z-]*$/);
    assert.ok(USAGE_PURPOSE_LABELS_ZH[purpose], `${purpose} has no report label`);
  }
  assert.deepEqual(Object.keys(USAGE_PURPOSE_LABELS_ZH).sort(), [...USAGE_PURPOSES].sort());
});

test("a missing or unknown purpose is recorded as other, never refused", () => {
  assert.equal(usagePurpose("routing"), "routing");
  for (const value of [undefined, null, "", "Routing", "kernel ", 7, {}]) {
    assert.equal(usagePurpose(value), "other", `${JSON.stringify(value)} must record as other`);
    assert.equal(isUsagePurpose(value), false);
  }
});

test("a runtime's request is the kernel's, except a source understanding or learning run's", () => {
  assert.equal(usagePurposeOfRun({ effectiveAgentId: "source-understanding" }), "source-understanding");
  for (const run of [
    { effectiveAgentId: "clinical-evidence-synthesis" },
    { effectiveAgentId: null },
    null,
    undefined,
  ]) {
    assert.equal(usagePurposeOfRun(run), "kernel");
  }
});

test('the learning loop\'s own runs are metered as learning, so its caps can count exactly them', () => {
  // Until 2026-09-21 they were `kernel`, and a learning cap could only be
  // compared with everything the account spent.
  assert.equal(usagePurposeOfRun({ effectiveAgentId: 'method-distillation' }), 'learning')
  assert.equal(usagePurposeOfRun({ effectiveAgentId: 'method-relations' }), 'learning')
  assert.equal(usagePurposeOfRun({ effectiveAgentId: 'clinical-evidence-synthesis', dispatchId: 'methodeval_0a1b2c' }), 'learning',
    'a paired-evaluation cell is the loop measuring itself')
  assert.equal(usagePurposeOfRun({ effectiveAgentId: 'clinical-evidence-synthesis', dispatchId: 'web-abc' }), 'kernel')
  assert.ok(USAGE_PURPOSES.includes('learning'))
  assert.equal(USAGE_PURPOSE_LABELS_ZH.learning, '学习做法')
})
