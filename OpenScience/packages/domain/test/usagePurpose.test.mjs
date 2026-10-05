import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_PURPOSES,
  USAGE_PURPOSE_LABELS_ZH,
  isUsagePurpose,
  usagePurpose,
  usagePurposeOfRun,
  isResearcherOwnedWork,
  isChargeableResearchRun,
  PLATFORM_ROUTE_PURPOSES,
} from "../index.mjs";

test('managed research belongs to its researcher, but platform self-measurement does not', () => {
  assert.equal(isResearcherOwnedWork(null), false)
  assert.equal(isResearcherOwnedWork({ automated: true }), false)
  assert.equal(isResearcherOwnedWork({ automated: true, effectiveRouteReason: 'geo:content' }), true)
  assert.equal(isResearcherOwnedWork({ automated: true, effectiveRouteReason: 'autopilot:literature-sentinel' }), true)
  assert.equal(isResearcherOwnedWork({ automated: true, effectiveRouteReason: 'vcr:review-repair' }), true)
  assert.equal(isResearcherOwnedWork({ automated: true, effectiveRouteReason: 'vcr:analysis', effectiveAgentId: 'method-relations' }), false)
  assert.equal(isResearcherOwnedWork({ automated: true, effectiveRouteReason: 'platform-learning' }), false)
  assert.equal(isResearcherOwnedWork({ effectiveRouteReason: 'autopilot:verify', effectiveAgentId: 'method-distillation' }), false)
})

test("the purpose vocabulary is the closed set the ledger's CHECK is built from", () => {
  // The contract every stream codes against (X1). A member added here without
  // the others agreeing is a report column nobody fills; one removed is an
  // insert the database refuses.
  assert.deepEqual([...USAGE_PURPOSES], [
    "kernel", "memory-extraction", "routing", "title", "engine",
    "capsule-scan", "channel-intent", "source-understanding", "learning", "autopilot", "frontier", "review", "geo", "vcr", "web-search", "evolution", "other",
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
  assert.equal(usagePurposeOfRun({ effectiveAgentId: 'clinical-evidence-synthesis', effectiveRouteReason: 'platform-learning' }), 'learning',
    'a paired-evaluation cell is the loop measuring itself, and its dispatcher says so')
  assert.equal(usagePurposeOfRun(/** @type {any} */ ({ effectiveAgentId: 'clinical-evidence-synthesis', dispatchId: 'web-abc' })), 'kernel')
  assert.ok(USAGE_PURPOSES.includes('learning'))
  assert.equal(USAGE_PURPOSE_LABELS_ZH.learning, '学习做法')
})

test('a purpose is never read from an identifier the caller of the dispatch route types', () => {
  // `POST /api/agent-runs/dispatch` takes `dispatchId` from the browser. Until
  // 2026-10-05 an id spelled `evolution_…` booked the run as platform spend —
  // outside the account's caps, waived under research billing — and
  // `methodeval_…` did the same as `learning`.
  for (const dispatchId of ['evolution_free1', 'evolution_paper_x', 'methodeval_0a1b2c', 'EVOLUTION_x']) {
    const run = { dispatchId, effectiveAgentId: 'open-domain-answer', effectiveRouteReason: 'unrouted:open-domain' }
    assert.equal(usagePurposeOfRun(run), 'kernel', dispatchId)
    assert.equal(isChargeableResearchRun(run), true, dispatchId)
    assert.equal(isResearcherOwnedWork(run), true, dispatchId)
  }
  // Nor from the shape of a route reason the router could mint from a question.
  for (const reason of ['choice:tool-builder', 'matched:named:evolution-scout', 'llm:0.9', 'session-binding', 'platform-evolution-x', 'Platform-Evolution', '__proto__', 'toString']) {
    assert.equal(usagePurposeOfRun({ effectiveRouteReason: reason, effectiveAgentId: 'meta-analysis' }), 'kernel', reason)
  }
  // The platform's own dispatchers name their purpose with a reason only they write.
  assert.deepEqual({ ...PLATFORM_ROUTE_PURPOSES }, { 'platform-evolution': 'evolution', 'platform-learning': 'learning' })
  for (const purpose of Object.values(PLATFORM_ROUTE_PURPOSES)) assert.ok(USAGE_PURPOSES.includes(purpose))
})

test('whether a run is charged follows its purpose, never what its caller said about it', () => {
  // `automated` is the caller's own statement that a harness started the run
  // (the dispatch route takes it from the body and from a header). It keeps a
  // harness's traffic out of lessons; it must not be a way to research for free.
  const researcher = { effectiveAgentId: 'open-domain-answer', effectiveRouteReason: 'unrouted:open-domain' }
  assert.equal(isResearcherOwnedWork({ ...researcher, automated: true }), false, 'a harness teaches nothing')
  assert.equal(isChargeableResearchRun(/** @type {any} */ ({ ...researcher, automated: true })), true, 'but it is still charged')
  assert.equal(isChargeableResearchRun(researcher), true)
  for (const reason of ['geo:content', 'autopilot:literature-sentinel', 'vcr:analysis']) {
    assert.equal(isChargeableResearchRun(/** @type {any} */ ({ automated: true, effectiveRouteReason: reason, effectiveAgentId: 'geo-insight' })), true, reason)
  }
  for (const run of [
    { effectiveAgentId: 'source-understanding' }, { effectiveAgentId: 'method-distillation' }, { effectiveAgentId: 'method-relations' },
    { effectiveAgentId: 'tool-builder' }, { effectiveAgentId: 'evolution-scout' },
    { effectiveAgentId: 'meta-analysis', effectiveRouteReason: 'platform-evolution' },
    { effectiveAgentId: 'adr-analysis', effectiveRouteReason: 'platform-learning' },
    null, undefined,
  ]) assert.equal(isChargeableResearchRun(run), false, JSON.stringify(run))
})
