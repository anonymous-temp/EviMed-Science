// When a learned method may take effect, and when it should go away.
//
// The promotion rule is the only place in the learning loop where the system
// decides something about its own output, so it is written here as a truth
// table rather than as prose: every way a candidate can fail to qualify has a
// case, and the case asserts the *reason* the researcher will be shown, not
// merely that it failed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  METHOD_GRAPH_ISSUE_CODES,
  METHOD_RELATION_TYPES,
  computeMethodLevels,
  emptyLearning,
  evaluationEligible,
  foldEligible,
  foldEvaluation,
  foldObservation,
  foldRead,
  foldRelation,
  libraryEvictions,
  methodContribution,
  methodLevel,
  methodStrength,
  promotionVerdict,
  reflectionDue,
  relationIssues,
  resetLearningForDigest,
  retirementProposal,
  successfulFamilies,
  unresolvedConflicts,
  validateMethodGraph,
} from "../src/methodGraph.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const NOW = Date.parse("2026-09-07T00:00:00.000Z");
/** @param {number} days @returns {string} */
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

/**
 * @param {Partial<import("../src/methodGraph.mjs").MethodRecord>} [options]
 * @returns {import("../src/methodGraph.mjs").MethodRecord}
 */
const method = (options = {}) => {
  const digest = options.digest ?? DIGEST_A;
  const learning = options.learning ?? emptyLearning(digest);
  return {
    id: options.id ?? "m1",
    name: options.name ?? "a-method",
    digest,
    status: options.status ?? "candidate",
    dependencies: options.dependencies ?? [],
    learning,
    provenance: options.provenance ?? { origin: "inferred", runId: "run_1" },
  };
};

/** Three accepted runs in three families: the shape that clears the threshold. */
const threeSuccesses = () => {
  let learning = emptyLearning(DIGEST_A);
  for (const index of [1, 2, 3]) {
    learning = foldObservation(learning, {
      runId: `run_${index}`, family: `fam_${index}`, outcome: "accepted", at: daysAgo(index), invoked: true,
    });
  }
  return learning;
};

/* ------------------------------------------------------------- the counters */

test("a use is counted once per run family, and a failed run is not a use", () => {
  let learning = emptyLearning(DIGEST_A);
  learning = foldObservation(learning, { runId: "run_1", family: "fam_1", outcome: "accepted", at: daysAgo(1), invoked: true });
  // The retry is the same trajectory seen twice. EvoDS would count two.
  learning = foldObservation(learning, { runId: "run_1_retry", family: "fam_1", outcome: "accepted", at: daysAgo(1), invoked: true });
  assert.deepEqual(learning.counts, { eligible: 0, loaded: 1, invoked: 1, succeeded: 1, validated: 0, read: 0 });
  assert.deepEqual(successfulFamilies(learning), ["fam_1"]);

  learning = foldObservation(learning, { runId: "run_2", family: "fam_2", outcome: "rejected", at: daysAgo(1), invoked: true });
  assert.equal(learning.counts.loaded, 2);
  assert.equal(learning.counts.succeeded, 1, "a rejected run is evidence against the method");

  // Loaded and invoked are different claims: a pre-injected body is never called.
  learning = foldObservation(learning, { runId: "run_3", family: "fam_3", outcome: "accepted", at: daysAgo(1) });
  assert.equal(learning.counts.loaded, 3);
  assert.equal(learning.counts.invoked, 2);

  learning = foldEligible(learning);
  assert.equal(learning.counts.eligible, 1);
  assert.equal(foldObservation(learning, { runId: "x", family: "", outcome: "accepted", at: daysAgo(1) }).counts.loaded, 3);
  assert.equal(foldObservation(learning, { runId: "x", family: "f", outcome: "exploded", at: daysAgo(1) }).counts.loaded, 3);
});

test("changing the body resets what was measured about the old one, but keeps the relations", () => {
  const learning = foldRelation(threeSuccesses(), { type: "subset", target: "m2", evidence: "e", proposedBy: "job_1" });
  const moved = resetLearningForDigest(learning, DIGEST_B);
  assert.deepEqual(moved.counts, { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 });
  assert.deepEqual(moved.observations, []);
  assert.deepEqual(moved.evaluations, []);
  assert.equal(moved.relations.length, 1, "where a method sits in the library did not change because its wording did");
  assert.equal(resetLearningForDigest(learning, DIGEST_A), learning, "an unchanged digest is not a reset");
});

test("an evaluation counts as validation only when it passed, on the text it measured", () => {
  const passed = foldEvaluation(emptyLearning(DIGEST_A), { report: "r1.json", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "non_inferior" });
  assert.equal(passed.counts.validated, 1);
  const failed = foldEvaluation(emptyLearning(DIGEST_A), { report: "r2.json", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "worse" });
  assert.equal(failed.counts.validated, 0);
  assert.equal(failed.evaluations.length, 1, "a failing verdict is still recorded");
  assert.equal(foldEvaluation(emptyLearning(DIGEST_A), { report: "r", baselineDigest: DIGEST_B, verdict: "vibes" }).evaluations.length, 0);

  // An evaluation takes hours of real runs and the method can be amended while
  // it is in flight; the amendment resets this record for the new digest. A
  // verdict folded in unconditionally therefore made the old text's score the
  // new text's first vote. Recorded either way -- "we measured something else"
  // is a fact worth keeping -- and counted only when the digests agree.
  const elsewhere = foldEvaluation(emptyLearning(DIGEST_A), { report: "r3.json", baselineDigest: DIGEST_B, candidateDigest: DIGEST_B, verdict: "better" });
  assert.equal(elsewhere.counts.validated, 0, "a verdict about other text must not count");
  assert.equal(elsewhere.evaluations.length, 1, "and must still be on the record");
  const unnamed = foldEvaluation(emptyLearning(DIGEST_A), { report: "r4.json", baselineDigest: DIGEST_B, verdict: "better" });
  assert.equal(unnamed.counts.validated, 0, "a verdict that names no text counts for none");
});

test("a relation is upserted by (type, target) so a nightly re-proposal is not a duplicate", () => {
  let learning = foldRelation(emptyLearning(DIGEST_A), { type: "merge", target: "m2", evidence: "one", proposedBy: "job_1" });
  learning = foldRelation(learning, { type: "merge", target: "m2", evidence: "two", proposedBy: "job_2" });
  assert.equal(learning.relations.length, 1);
  assert.equal(learning.relations[0].evidence, "two");
  assert.equal(foldRelation(learning, { type: "is-vaguely-like", target: "m3", evidence: "e", proposedBy: "j" }).relations.length, 1);
});

/* ------------------------------------------------------- the budget threshold */

test("tau decides who gets an evaluation, and it is about spending money", () => {
  assert.equal(evaluationEligible(method({ learning: threeSuccesses() })).eligible, true);

  // Two runs of the same deliverable are one trajectory: the family is the key,
  // so a retry cannot buy its way past the threshold.
  const oneRetried = foldObservation(foldObservation(emptyLearning(DIGEST_A),
    { runId: "r1", family: "f1", outcome: "accepted", at: daysAgo(1) }),
  { runId: "r2", family: "f1", outcome: "accepted", at: daysAgo(1) });
  const short = evaluationEligible(method({ learning: oneRetried }));
  assert.equal(short.eligible, false);
  assert.match(short.reason, /1 successful trajectories/);

  // Three trajectories, one run. Enough evidence by volume and not enough by
  // independence: one brief, one researcher, one set of sources, read three
  // times. This is the check `MEMORY_PROMOTION_MIN_RUNS` was always meant to be
  // and was not, because both thresholds were reading the same number.
  let oneAfternoon = emptyLearning(DIGEST_A);
  for (const item of ["d1", "d2", "d3"]) {
    oneAfternoon = foldObservation(oneAfternoon, { runId: "run_1", family: `run_1:${item}`, outcome: "accepted", at: daysAgo(1) });
  }
  const correlated = evaluationEligible(method({ learning: oneAfternoon }));
  assert.equal(correlated.eligible, false);
  assert.match(correlated.reason, /came from 1 run/);

  // The same three trajectories spread over two runs qualify.
  let twoAfternoons = emptyLearning(DIGEST_A);
  for (const [runId, item] of [["run_1", "d1"], ["run_1", "d2"], ["run_2", "d1"]]) {
    twoAfternoons = foldObservation(twoAfternoons, { runId, family: `${runId}:${item}`, outcome: "accepted", at: daysAgo(1) });
  }
  assert.equal(evaluationEligible(method({ learning: twoAfternoons })).eligible, true);

  // Counters that describe a body the method no longer has cannot qualify it.
  const stale = evaluationEligible(method({ digest: DIGEST_B, learning: threeSuccesses() }));
  assert.equal(stale.eligible, false);
  assert.match(stale.reason, /counters were reset/);

  // An explicit method never needs the threshold at all.
  assert.equal(evaluationEligible(method({ provenance: { origin: "explicit" } })).eligible, true);
});

/* --------------------------------------------------------- the promotion table */

test("an explicitly taught method takes effect immediately", () => {
  const verdict = promotionVerdict(method({ provenance: { origin: "explicit" } }));
  assert.equal(verdict.status, "approved");
  assert.match(verdict.reasons.join(" "), /immediately/);
  assert.deepEqual(verdict.missing, []);
});

test("an inferred method needs the threshold, a passing evaluation on its own text, and a live baseline", () => {
  const passing = foldEvaluation(threeSuccesses(), { report: "r.json", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "better" });
  const good = promotionVerdict(method({ learning: passing }), { currentBaselineDigest: DIGEST_B });
  assert.equal(good.status, "approved", good.missing.join("; "));

  // No evaluation at all.
  const unevaluated = promotionVerdict(method({ learning: threeSuccesses() }));
  assert.equal(unevaluated.status, "candidate");
  assert.match(unevaluated.missing.join(" "), /no paired evaluation/);

  // Evaluated and lost.
  const lost = promotionVerdict(method({
    learning: foldEvaluation(threeSuccesses(), { report: "r", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "worse" }),
  }));
  assert.equal(lost.status, "candidate");
  assert.match(lost.missing.join(" "), /returned worse/);

  // Inconclusive is not a pass. A confidence interval that spans the margin
  // means we do not know, and "we do not know" must not promote.
  const unclear = promotionVerdict(method({
    learning: foldEvaluation(threeSuccesses(), { report: "r", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "inconclusive" }),
  }));
  assert.equal(unclear.status, "candidate");

  // Won against a baseline that has since moved: the comparison is stale.
  const stale = promotionVerdict(method({ learning: passing }), { currentBaselineDigest: DIGEST_C });
  assert.equal(stale.status, "candidate");

  // Won, but about text this method no longer holds. The verdict was real and
  // it is not about what would be mounted, which is the same answer as never
  // having been evaluated -- and the message has to say which of the two it is.
  const otherText = promotionVerdict(
    method({ learning: foldEvaluation(threeSuccesses(), { report: "r", baselineDigest: DIGEST_B, candidateDigest: DIGEST_C, verdict: "better" }) }),
    { currentBaselineDigest: DIGEST_B },
  );
  assert.equal(otherText.status, "candidate");
  assert.match(otherText.missing.join(" "), /no longer holds/);
  const unnamedText = promotionVerdict(
    method({ learning: foldEvaluation(threeSuccesses(), { report: "r", baselineDigest: DIGEST_B, verdict: "better" }) }),
    { currentBaselineDigest: DIGEST_B },
  );
  assert.match(unnamedText.missing.join(" "), /does not name the text it measured/);
  assert.match(stale.missing.join(" "), /baseline that has since moved/);

  // Not enough trajectories.
  const thin = promotionVerdict(method({
    learning: foldEvaluation(
      foldObservation(emptyLearning(DIGEST_A), { runId: "r1", family: "f1", outcome: "accepted", at: daysAgo(1) }),
      { report: "r", baselineDigest: DIGEST_B, verdict: "better" },
    ),
  }), { currentBaselineDigest: DIGEST_B });
  assert.equal(thin.status, "candidate");
});

test("an unresolved conflict blocks promotion from either origin", () => {
  const conflicted = foldRelation(threeSuccesses(), { type: "conflicts_with", target: "m9", evidence: "opposite advice", proposedBy: "job_1" });
  const withEvaluation = foldEvaluation(conflicted, { report: "r", baselineDigest: DIGEST_B, verdict: "better" });
  const inferred = promotionVerdict(method({ learning: withEvaluation }), { currentBaselineDigest: DIGEST_B });
  assert.equal(inferred.status, "candidate");
  assert.match(inferred.missing.join(" "), /unresolved conflict/);

  const explicit = promotionVerdict(method({ learning: conflicted, provenance: { origin: "explicit" } }));
  assert.equal(explicit.status, "candidate", "even a stated preference waits while two methods contradict each other");

  const resolved = foldRelation(conflicted, { type: "conflicts_with", target: "m9", evidence: "opposite advice", proposedBy: "job_1", resolved: true });
  assert.deepEqual(unresolvedConflicts(resolved.relations), []);
});

/* --------------------------------------------------------------- retirement */

test("strength decays, and retirement is proposed only when something validated replaces it", () => {
  const fresh = methodStrength(threeSuccesses().observations, NOW);
  const old = methodStrength(threeSuccesses().observations.map((entry) => ({ ...entry, at: daysAgo(180) })), NOW);
  assert.ok(fresh > old * 10, `${fresh} should dwarf ${old}`);

  const unusedAndReplaced = foldRelation(
    { ...emptyLearning(DIGEST_A), observations: [{ runId: "r", family: "f", outcome: "accepted", at: daysAgo(365) }] },
    { type: "supersedes", target: "m2", evidence: "merged", proposedBy: "job_1" },
  );
  const proposal = retirementProposal(method({ learning: unusedAndReplaced }), { nowMs: NOW, isApproved: () => true });
  assert.equal(proposal.propose, true);
  assert.equal(proposal.immediate, false);
  assert.match(proposal.reason, /superseded by m2/);

  // Unused with nothing to replace it: retiring would remove a capability.
  const orphan = retirementProposal(
    method({ learning: { ...emptyLearning(DIGEST_A), observations: [{ runId: "r", family: "f", outcome: "accepted", at: daysAgo(365) }] } }),
    { nowMs: NOW },
  );
  assert.equal(orphan.propose, false);
  assert.match(orphan.reason, /nothing validated replaces it/);

  // Still in use.
  assert.equal(retirementProposal(method({ learning: threeSuccesses() }), { nowMs: NOW }).propose, false);
});

test("a safety-related method is never retired for being quiet, and an incident retires one at once", () => {
  const quiet = { ...emptyLearning(DIGEST_A), observations: [{ runId: "r", family: "f", outcome: "accepted", at: daysAgo(365) }] };
  const safe = retirementProposal(
    method({ learning: foldRelation(quiet, { type: "supersedes", target: "m2", evidence: "e", proposedBy: "j" }), provenance: { origin: "inferred", safetyRelated: true } }),
    { nowMs: NOW, isApproved: () => true },
  );
  assert.equal(safe.propose, false);
  assert.match(safe.reason, /working safety check/);

  const implicated = retirementProposal(
    method({ learning: threeSuccesses(), status: "approved", provenance: { origin: "inferred", incident: true } }),
    { nowMs: NOW },
  );
  assert.deepEqual([implicated.propose, implicated.immediate], [true, true]);

  assert.equal(retirementProposal(method({ status: "retired" }), { nowMs: NOW }).propose, false);
});

test("reflection fires on accumulated importance, on the memory subsystem's threshold", () => {
  assert.equal(reflectionDue(149), false);
  assert.equal(reflectionDue(150), true);
  assert.equal(reflectionDue(10, 5), true);
});

/* -------------------------------------------------------------- the graph */

test("levels come from the dependency graph, not from the role label", () => {
  const atom = method({ id: "m1", name: "atom", digest: DIGEST_A });
  const mid = method({ id: "m2", name: "mid", digest: DIGEST_B, dependencies: [{ name: "atom", digest: DIGEST_A }] });
  const top = method({ id: "m3", name: "top", digest: DIGEST_C, dependencies: [{ name: "mid", digest: DIGEST_B }, { name: "atom", digest: DIGEST_A }] });
  const { levels } = computeMethodLevels([atom, mid, top]);
  assert.deepEqual([levels.get("atom"), levels.get("mid"), levels.get("top")], [0, 1, 2]);
  assert.equal(methodLevel(top, [atom, mid, top]), 2);

  // Two parents reusing one atom is the point of extracting it, not an error.
  const other = method({ id: "m4", name: "other", digest: DIGEST_C, dependencies: [{ name: "atom", digest: DIGEST_A }] });
  assert.equal(validateMethodGraph([atom, mid, other]).ok, true);
});

test("the graph refuses cycles, dangling pins, moved digests and duplicate names", () => {
  /** @type {Set<string>} */
  const raised = new Set();
  /** @param {readonly any[]} methods @param {string} code */
  const expect = (methods, code) => {
    const result = validateMethodGraph(methods);
    for (const entry of result.issues) raised.add(entry.code);
    assert.ok(result.issues.some((entry) => entry.code === code), `${code} not raised: ${result.issues.map((e) => e.code).join(", ")}`);
  };

  expect([
    method({ id: "m1", name: "a", digest: DIGEST_A, dependencies: [{ name: "b", digest: DIGEST_B }] }),
    method({ id: "m2", name: "b", digest: DIGEST_B, dependencies: [{ name: "a", digest: DIGEST_A }] }),
  ], "method_graph_cycle");
  expect([method({ name: "a", dependencies: [{ name: "b", digest: "sha256:nope" }] })], "method_graph_digest_unparsable");
  expect([method({ name: "a", dependencies: [{ name: "ghost", digest: DIGEST_B }] })], "method_graph_dangling_dependency");
  expect([
    method({ id: "m1", name: "a", digest: DIGEST_A, dependencies: [{ name: "b", digest: DIGEST_C }] }),
    method({ id: "m2", name: "b", digest: DIGEST_B }),
  ], "method_graph_digest_moved");
  expect([method({ id: "m1", name: "same" }), method({ id: "m2", name: "same", digest: DIGEST_B })], "method_graph_duplicate_name");
  expect([
    method({ id: "m1", name: "a", digest: DIGEST_A, status: "approved", dependencies: [{ name: "b", digest: DIGEST_B }] }),
    method({ id: "m2", name: "b", digest: DIGEST_B, status: "candidate" }),
  ], "method_graph_dependency_not_effective");

  /** @type {{relation: any, code: string}[]} */
  const relationCases = [
    { relation: { type: "vibes", target: "m1", evidence: "e", proposedBy: "j" }, code: "method_relation_type_unknown" },
    { relation: { type: "merge", evidence: "e", proposedBy: "j" }, code: "method_relation_target_missing" },
    { relation: { type: "merge", target: "gone", evidence: "e", proposedBy: "j" }, code: "method_relation_target_unknown" },
    { relation: { type: "merge", target: "m1", proposedBy: "j" }, code: "method_relation_evidence_missing" },
    { relation: { type: "merge", target: "m1", evidence: "e" }, code: "method_relation_unattributed" },
  ];
  for (const { relation, code } of relationCases) {
    const issues = relationIssues(relation, (id) => id === "m1");
    for (const entry of issues) raised.add(entry.code);
    assert.ok(issues.some((entry) => entry.code === code), `${code} not raised`);
  }
  assert.deepEqual(relationIssues({ type: "merge", target: "m1", evidence: "e", proposedBy: "j" }, () => true), []);

  assert.ok(raised.size >= 10, `only ${raised.size} codes exercised`);
  const never = METHOD_GRAPH_ISSUE_CODES.filter((code) => !raised.has(code));
  assert.deepEqual(never, [], `declared but never raised: ${never.join(", ")}`);
});

test("the relation vocabulary is the paper's four plus the two it lacks", () => {
  assert.deepEqual([...METHOD_RELATION_TYPES], ["shared_part", "subset", "merge", "abstract_pattern", "conflicts_with", "supersedes"]);
});

/* ------------------------------------------------------ contribution and the cap */

/** @param {number} loaded @param {number} succeeded @param {number} [ageDays] */
const record = (loaded, succeeded, ageDays = 1) => {
  let learning = emptyLearning(DIGEST_A);
  for (let index = 0; index < loaded; index += 1) {
    learning = foldObservation(learning, {
      runId: `run_${index}`,
      family: `fam_${index}`,
      outcome: index < succeeded ? "accepted" : "rejected",
      at: daysAgo(ageDays),
    });
  }
  return learning;
};

test("contribution is outcomes over trials, and silence is not neutrality", () => {
  assert.equal(methodContribution(record(10, 10)), 1);
  assert.equal(methodContribution(record(10, 5)), 0);
  assert.equal(methodContribution(record(10, 0)), -1);
  assert.equal(Number(methodContribution(record(10, 4))).toFixed(2), "-0.20");
  // Never mounted is not evidence of anything; a rule that reads it as 0 would
  // retire every method that has just been promoted.
  assert.equal(methodContribution(emptyLearning(DIGEST_A)), null);
  assert.equal(methodContribution(foldEligible(emptyLearning(DIGEST_A))), null);
  assert.equal(methodContribution(undefined), null);
});

test("a method only ever read by a run that delegates nothing is not idle, and still retirable when it hurts", () => {
  // The non-delegating answer line: it calls the `skill` tool, reads the body,
  // and answers the researcher directly. No delegation means no mounted digest
  // and no deliverable verdict, so every outcome-reading clause in the
  // retirement rule sees an empty record and calls it idle.
  const quiet = { ...emptyLearning(DIGEST_A), observations: [{ runId: "r", family: "f", outcome: "accepted", at: daysAgo(365) }] };
  const superseded = { type: "supersedes", target: "m2", evidence: "merged", proposedBy: "job_1" };

  // Without the reading this exact input is proposed for retirement — that is
  // the assertion above this one, and it is what this counter has to change.
  assert.equal(retirementProposal(method({ learning: foldRelation(quiet, superseded) }), { nowMs: NOW, isApproved: () => true }).propose, true);

  const read = foldRelation(foldRead(quiet, daysAgo(2)), superseded);
  assert.equal(read.counts.read, 1);
  assert.equal(methodContribution(read), null, "a reading carries no verdict and may not move a success rate");
  const kept = retirementProposal(method({ learning: read }), { nowMs: NOW, isApproved: () => true });
  assert.equal(kept.propose, false);
  assert.match(kept.reason, /delegated nothing/);
  assert.ok(kept.strength < 0.5, "it is protected despite having no strength, which is the whole point");

  // A reading older than the decay window stops protecting anything, so one
  // ancient timestamp cannot pin a method in the library forever.
  const stale = foldRelation(foldRead(quiet, daysAgo(200)), superseded);
  assert.equal(retirementProposal(method({ learning: stale }), { nowMs: NOW, isApproved: () => true }).propose, true);

  // Being read is evidence of not being idle, never evidence of being good: a
  // method whose packages keep being refused is proposed however often it is
  // read, because the contribution clause sits above this one.
  const harmful = method({ status: "approved", learning: foldRead(record(24, 10), daysAgo(1)) });
  const proposal = retirementProposal(harmful, { nowMs: NOW });
  assert.equal(proposal.propose, true);
  assert.match(proposal.reason, /24 trajectories at a contribution of -0\.17/);
});

test("a reading moves the timestamp forward only, and an unreadable one changes nothing", () => {
  const once = foldRead(emptyLearning(DIGEST_A), daysAgo(5));
  assert.equal(once.lastReadAt, daysAgo(5));

  // An out-of-order write from a slow run must not make a method look staler
  // than it is; the counter still moves, because the reading did happen.
  const outOfOrder = foldRead(once, daysAgo(40));
  assert.equal(outOfOrder.lastReadAt, daysAgo(5));
  assert.equal(outOfOrder.counts.read, 2);

  assert.equal(foldRead(outOfOrder, daysAgo(1)).lastReadAt, daysAgo(1));
  assert.equal(foldRead(once, "not a date"), once, "an unparseable timestamp is not a reading");
  assert.equal(foldRead(once, undefined).counts.read, 1);
});

test("a method that is used constantly and hurts is proposed, which decay alone can never do", () => {
  // 24 recent trajectories, 10 accepted: contribution -0.17, strength high.
  const busy = method({ status: "approved", learning: record(24, 10) });
  const proposal = retirementProposal(busy, { nowMs: NOW });
  assert.ok(proposal.strength > 0.5, "this is exactly the case the recency rule reads as healthy");
  assert.equal(proposal.propose, true);
  assert.equal(proposal.immediate, false, "a proposal, never a silent deletion");
  assert.match(proposal.reason, /24 trajectories at a contribution of -0\.17/);
  assert.equal(Number(proposal.contribution).toFixed(2), "-0.17");

  // It needs no replacement to be proposed: removing something that makes
  // packages worse removes nothing.
  assert.ok(!/superseded/.test(proposal.reason));
});

test("the contribution clause waits for enough trials, and never fires on a safety method", () => {
  // Same ratio, too few trajectories to say anything.
  const early = method({ status: "approved", learning: record(6, 2) });
  assert.equal(retirementProposal(early, { nowMs: NOW }).propose, false);
  assert.equal(retirementProposal(early, { nowMs: NOW, minTrials: 5 }).propose, true, "the floor is a parameter, and it bites");

  const safety = method({
    status: "approved",
    learning: record(24, 10),
    provenance: { origin: "inferred", safetyRelated: true },
  });
  assert.equal(retirementProposal(safety, { nowMs: NOW }).propose, false);
  assert.match(retirementProposal(safety, { nowMs: NOW }).reason, /safety-related/);

  // A good method with many trials is left alone.
  const good = method({ status: "approved", learning: record(24, 20) });
  assert.equal(retirementProposal(good, { nowMs: NOW }).propose, false);
});

test("a library over its cap gives up its worst first, and never the untried", () => {
  const methods = [
    method({ id: "m_bad", status: "approved", learning: record(20, 4) }),
    method({ id: "m_ok", status: "approved", learning: record(20, 14) }),
    method({ id: "m_worst", status: "approved", learning: record(20, 2) }),
    method({ id: "m_new", status: "approved", learning: emptyLearning(DIGEST_A) }),
    method({ id: "m_candidate", status: "candidate", learning: record(20, 1) }),
  ];
  assert.deepEqual(libraryEvictions(methods, { cap: 10 }), [], "under the cap, nothing is given up");

  const over = libraryEvictions(methods, { cap: 2 });
  assert.deepEqual(over.map((entry) => entry.id), ["m_worst", "m_bad"],
    "four approved against a cap of two: the two lowest contributions, worst first");
  assert.match(over[0].reason, /cap of 2/);
  assert.ok(!over.some((entry) => entry.id === "m_new"), "a method with no record has nothing to be judged on");
  assert.ok(!over.some((entry) => entry.id === "m_candidate"), "only effective methods count against the cap");
});

test("the cap never proposes a safety method, however badly it scores", () => {
  const methods = [
    method({ id: "m_safety", status: "approved", learning: record(20, 1), provenance: { origin: "inferred", safetyRelated: true } }),
    method({ id: "m_a", status: "approved", learning: record(20, 18) }),
    method({ id: "m_b", status: "approved", learning: record(20, 19) }),
  ];
  const over = libraryEvictions(methods, { cap: 1 });
  assert.ok(!over.some((entry) => entry.id === "m_safety"));
  assert.deepEqual(over.map((entry) => entry.id), ["m_a", "m_b"]);
});
