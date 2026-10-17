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
  AUTOPILOT_VERIFICATION_ROUTE_REASON,
  EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON,
  GEO_STEPS,
  RUN_ROLES,
  PROGRAMME_ROUTE_REASON_PREFIXES,
  isProgrammeRun,
  isVerificationRouteReason,
  isVerificationRun,
  runRoleOf,
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
    "kernel", "memory-extraction", "routing", "title", "task-type", "engine",
    "capsule-scan", "channel-intent", "source-understanding", "knowledge", "learning", "autopilot", "frontier", "review", "geo", "vcr", "web-search", "evolution",
    "evidence", "evidence-upkeep", "other",
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

test("the evidence programme's overhead and an account's own zone upkeep are two purposes with two payers", async () => {
  // 2026-10-05 (evidence-flywheel §3.3): any frontier-audience account could switch on AI upkeep of its zone
  // and have it booked to the platform's frontier budget. `evidence` is what the platform's own programme costs;
  // `evidence-upkeep` is what keeping an account's own zone current costs, and the account pays it.
  const { RESEARCH_BILLABLE_PURPOSES, researchTaskCharge } = await import("../index.mjs");
  assert.ok(USAGE_PURPOSES.includes("evidence") && USAGE_PURPOSES.includes("evidence-upkeep"));
  assert.equal(USAGE_PURPOSE_LABELS_ZH.evidence, "证据中心");
  assert.equal(USAGE_PURPOSE_LABELS_ZH["evidence-upkeep"], "证据专区维护");
  assert.equal(RESEARCH_BILLABLE_PURPOSES.includes("evidence-upkeep"), true, "the owner's own upkeep is billed to the owner");
  assert.equal(RESEARCH_BILLABLE_PURPOSES.includes("evidence"), false, "the platform's programme is overhead the platform carries");
  assert.equal(RESEARCH_BILLABLE_PURPOSES.includes("frontier"), false);
  const row = (/** @type {string} */ id, /** @type {string} */ purpose) => ({ id, status: "settled", priced: true, currency: "CNY", purpose, actual_cost: "0.50000000", price_version: "v1" });
  const charge = researchTaskCharge([row("a", "evidence-upkeep"), row("b", "evidence")], { owned: true, mode: "precision-v1" });
  assert.equal(charge.billableCny, "0.50000000", "only the upkeep row is the owner's");
  assert.equal(charge.platformCostCny, "0.50000000", "the programme row stays overhead");
});

// 2026-10-14: the independent re-check of a scheduled task's claim was read as the researcher's own work (its route reason is not an
// `autopilot:` one and its `automated` is unset), so it reached the learning loop and the lists of what the person did.
test('a verification run is the platform\'s work, whichever kind, and the execution it checks stays the researcher\'s', () => {
  assert.equal(AUTOPILOT_VERIFICATION_ROUTE_REASON, 'autopilot-verify')
  for (const effectiveRouteReason of [AUTOPILOT_VERIFICATION_ROUTE_REASON, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON]) {
    const run = { effectiveRouteReason, effectiveAgentId: 'open-domain-answer' }
    assert.equal(isVerificationRun(run), true, effectiveRouteReason)
    assert.equal(isResearcherOwnedWork(run), false, effectiveRouteReason)
    assert.equal(isResearcherOwnedWork({ ...run, automated: false }), false, effectiveRouteReason)
    assert.equal(runRoleOf(run), 'verification', effectiveRouteReason)
  }
  // The money is untouched: the task's budget pays for it, as the ruling that held a share back for it says.
  assert.equal(isChargeableResearchRun({ effectiveRouteReason: AUTOPILOT_VERIFICATION_ROUTE_REASON, effectiveAgentId: 'open-domain-answer' }), true)
  // The episode itself, and every other reason, is as it was.
  for (const effectiveRouteReason of ['autopilot:literature-sentinel', 'autopilot:routine', 'unrouted:open-domain', 'session-binding', 'choice:literature-search', 'autopilot-verifyx', 'autopilot-verify:', '']) {
    const run = { effectiveRouteReason, effectiveAgentId: 'open-domain-answer' }
    assert.equal(isVerificationRun(run), false, effectiveRouteReason)
    assert.equal(runRoleOf(run), null, effectiveRouteReason)
  }
  assert.equal(isResearcherOwnedWork({ effectiveRouteReason: 'autopilot:literature-sentinel', effectiveAgentId: 'clinical-evidence-synthesis' }), true)
  assert.equal(isResearcherOwnedWork({ effectiveRouteReason: 'unrouted:open-domain', effectiveAgentId: 'open-domain-answer' }), true)
  assert.equal(isVerificationRouteReason(null), false)
  assert.equal(runRoleOf(null), null)
  assert.deepEqual([...RUN_ROLES], ['verification', 'programme'])
})

// 2026-10-14 (R3): every step the 虚拟临床研究 orchestrator dispatches into a study's project opened as a conversation of its own, titled by the
// machine instruction it was briefed with, in the study's group of the sidebar. A run's role is the one mark lists read.
test('a 虚拟临床研究 programme step is a programme run, by the route reason the control plane wrote, and no conversation list draws it', () => {
  for (const effectiveRouteReason of ['vcr:definition', 'vcr:analysis', 'vcr:patients', 'vcr:export-study_package', 'vcr:review-repair', 'vcr:trial-search', 'vcr:evidence-refresh']) {
    const run = { effectiveRouteReason, effectiveAgentId: 'vcr-analysis', automated: true }
    assert.equal(isProgrammeRun(run), true, effectiveRouteReason)
    assert.equal(runRoleOf(run), 'programme', effectiveRouteReason)
    // Researcher-owned and charged as before: only the lists change.
    assert.equal(isResearcherOwnedWork(run), true, effectiveRouteReason)
  }
  // Not by a title or a text, not by another word that merely contains the prefix, and a person's own turn in the study is none.
  for (const run of [
    { effectiveRouteReason: 'session-binding', effectiveAgentId: 'vcr-protocol', question: 'vcr: 生成虚拟患者' },
    { effectiveRouteReason: 'unrouted:open-domain', effectiveAgentId: 'open-domain-answer' },
    { effectiveRouteReason: 'xvcr:analysis' }, { effectiveRouteReason: '' }, { effectiveRouteReason: null }, {},
  ]) assert.equal(isProgrammeRun(run), false, JSON.stringify(run))
  assert.equal(isProgrammeRun(null), false)
  assert.deepEqual([...PROGRAMME_ROUTE_REASON_PREFIXES], ['vcr:', 'geo:'])
  // A verification stays a verification.
  assert.equal(runRoleOf({ effectiveRouteReason: AUTOPILOT_VERIFICATION_ROUTE_REASON }), 'verification')
})

// 2026-10-17 (R19 geoq, the second instance of the class): the 循证 GEO orchestrator's steps opened as conversations of their own,
// titled by the brief they were sent with, in the GEO project's group of the sidebar.
test('a 循证 GEO programme step is a programme run, by the route reason the orchestrator wrote and by nothing a text says', () => {
  // Every reason `GeoOrchestrator` writes: `geo:<step>` for the insight run (its first step) and the strategy run (`sources`), `geo:content`,
  // `geo:research`, `geo:export-<kind>` — the steps come from the vocabulary, so a step added there is walked here.
  const reasons = [...GEO_STEPS.map((step) => `geo:${step}`), 'geo:content', 'geo:sources', 'geo:research', 'geo:export-weekly', 'geo:export-proposal']
  assert.ok(reasons.length >= 13, `only ${reasons.length} reasons were walked`)
  for (const effectiveRouteReason of reasons) {
    for (const effectiveAgentId of ['geo-insight', 'geo-strategy', 'geo-content', 'geo-proposal', 'clinical-evidence-synthesis']) {
      const run = { effectiveRouteReason, effectiveAgentId, automated: true }
      assert.equal(isProgrammeRun(run), true, effectiveRouteReason)
      assert.equal(runRoleOf(run), 'programme', effectiveRouteReason)
      // Researcher-owned and charged as before: only the lists change.
      assert.equal(isResearcherOwnedWork(run), true, effectiveRouteReason)
      assert.equal(isVerificationRun(run), false, effectiveRouteReason)
    }
  }
  // The prefix is a fact about who started the run, never about its text: a person's own turn in a GEO project, a conversation that
  // names the prefix, and reasons that merely contain it are ordinary.
  for (const run of [
    { effectiveRouteReason: 'session-binding', effectiveAgentId: 'geo-insight', question: 'geo:content 写第 2 批稿件' },
    { effectiveRouteReason: 'unrouted:open-domain', effectiveAgentId: 'open-domain-answer', question: 'geo:research' },
    { effectiveRouteReason: 'choice:geo-insight', effectiveAgentId: 'geo-insight' },
    { effectiveRouteReason: 'xgeo:content' }, { effectiveRouteReason: 'autopilot:geo:content' }, { effectiveRouteReason: 'GEO:content' },
    { effectiveRouteReason: 'geo' }, { effectiveRouteReason: null }, {},
  ]) assert.equal(isProgrammeRun(run), false, JSON.stringify(run))
  // The two modules do not take each other's reasons, and a verification stays a verification.
  assert.equal(runRoleOf({ effectiveRouteReason: 'vcr:definition' }), 'programme')
  assert.equal(runRoleOf({ effectiveRouteReason: AUTOPILOT_VERIFICATION_ROUTE_REASON }), 'verification')
})
