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
  foldEligible,
  foldObservation,
  foldRead,
  foldRelation,
  libraryEvictions,
  methodContribution,
  methodHarmTest,
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
  assert.deepEqual(learning.counts, { eligible: 0, loaded: 1, invoked: 1, succeeded: 1, read: 0 });
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
  assert.deepEqual(moved.counts, { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, read: 0 });
  assert.deepEqual(moved.observations, []);
  assert.equal(moved.relations.length, 1, "where a method sits in the library did not change because its wording did");
  assert.equal(resetLearningForDigest(learning, DIGEST_A), learning, "an unchanged digest is not a reset");
});

test("a relation is upserted by (type, target) so a nightly re-proposal is not a duplicate", () => {
  let learning = foldRelation(emptyLearning(DIGEST_A), { type: "merge", target: "m2", evidence: "one", proposedBy: "job_1" });
  learning = foldRelation(learning, { type: "merge", target: "m2", evidence: "two", proposedBy: "job_2" });
  assert.equal(learning.relations.length, 1);
  assert.equal(learning.relations[0].evidence, "two");
  assert.equal(foldRelation(learning, { type: "is-vaguely-like", target: "m3", evidence: "e", proposedBy: "j" }).relations.length, 1);
});

/* --------------------------------------------------------- the promotion table */

test("what a method still lacks is given as codes a page can put in the reader's language, line for line", () => {
  // The sentences are English and written for the log; the memory page reads
  // these instead of pattern-matching them. Since 2026-09-20 there is one code
  // left to report: an unresolved conflict is the only thing that blocks
  // effect, because it is the only one no measurement repairs.
  const conflicted = promotionVerdict(method({
    learning: foldRelation(threeSuccesses(), { type: "conflicts_with", target: "m9", evidence: "opposite advice", proposedBy: "job_1" }),
  }));
  assert.equal(conflicted.missingDetails.length, conflicted.missing.length);
  assert.deepEqual(conflicted.missingDetails.map((detail) => detail.code), ["conflicts"]);
  assert.equal(conflicted.missingDetails[0].count, 1);

  for (const record of [method({ learning: threeSuccesses() }), method({ learning: emptyLearning(DIGEST_A) }),
    method({ provenance: { origin: "explicit" } })]) {
    assert.deepEqual(promotionVerdict(record).missingDetails, [], "nothing else is a reason to withhold a method");
  }
});

test("an explicitly taught method takes effect immediately", () => {
  const verdict = promotionVerdict(method({ provenance: { origin: "explicit" } }));
  assert.equal(verdict.status, "approved");
  assert.match(verdict.reasons.join(" "), /immediately/);
  assert.deepEqual(verdict.missing, []);
});

test("a distilled method takes effect immediately too, whatever its evidence says", () => {
  // The bar moved from promotion to demotion on 2026-09-20. An inferred method
  // used to need three trajectories, two runs and a passing paired evaluation
  // against a live baseline; production never once cleared it, because the
  // evaluation runner defaults to empty and the job failed terminally by name.
  // So: effective at once, and `retirementProposal` is what takes it away.
  const fresh = promotionVerdict(method({ learning: emptyLearning(DIGEST_A) }));
  assert.equal(fresh.status, "approved", fresh.missing.join("; "));
  assert.match(fresh.reasons.join(" "), /takes effect immediately/);
  assert.equal(promotionVerdict(method({ learning: threeSuccesses() })).status, "approved", "evidence does not gate it either");

  // The paired evaluation that used to sit behind this is gone (2026-10-10), and a verdict one wrote into a stored record
  // before then is not read: not as a reason to withhold a method, not on its row, and not as a reason to retire it.
  const legacy = { ...threeSuccesses(), evaluations: [{ report: "r", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "worse" }] };
  const verdict = promotionVerdict(method({ learning: /** @type {any} */ (legacy) }));
  assert.equal(verdict.status, "approved");
  assert.doesNotMatch(verdict.reasons.join(" "), /evaluation/);
});

test("a stored paired-evaluation verdict of worse retires nothing: a method goes by its own runs", () => {
  // `retirementProposal` used to read the newest verdict first and retire at once on `worse`. The evaluation was never run
  // in production and is deleted; what retires an inferred method is the sequential harm test over its runs, the scientific
  // record and the researcher.
  const now = Date.now();
  const legacy = { ...threeSuccesses(), evaluations: [{ report: "r.json", baselineDigest: DIGEST_B, candidateDigest: DIGEST_A, verdict: "worse" }] };
  const proposal = retirementProposal(method({ status: "approved", learning: /** @type {any} */ (legacy) }), { nowMs: now });
  assert.equal(proposal.propose, false);
  assert.notEqual(proposal.code, "evaluated_worse");
  const safety = retirementProposal(
    method({ status: "approved", learning: /** @type {any} */ (legacy), provenance: { origin: "inferred", safetyRelated: true } }), { nowMs: now });
  assert.equal(safety.propose, false, "a safety method is read by its runs like any other");

  // The harm test is what acts on the same method: rejected deliveries among its invoked runs retire it at once.
  let rejected = emptyLearning(DIGEST_A);
  for (const index of [1, 2, 3, 4]) {
    rejected = foldObservation(rejected, { runId: `run_${index}`, family: `fam_${index}`, outcome: "rejected", at: daysAgo(5 - index), invoked: true });
  }
  const harmed = retirementProposal(method({ status: "approved", learning: rejected }), { nowMs: now });
  assert.deepEqual([harmed.propose, harmed.immediate, harmed.code], [true, true, "harm"]);
});

test("an unresolved conflict blocks promotion from either origin", () => {
  const conflicted = foldRelation(threeSuccesses(), { type: "conflicts_with", target: "m9", evidence: "opposite advice", proposedBy: "job_1" });
  const inferred = promotionVerdict(method({ learning: conflicted }));
  assert.equal(inferred.status, "candidate");
  assert.match(inferred.missing.join(" "), /unresolved conflict/);

  const explicit = promotionVerdict(method({ learning: conflicted, provenance: { origin: "explicit" } }));
  assert.equal(explicit.status, "candidate", "even a stated preference waits while two methods contradict each other");

  const resolved = foldRelation(conflicted, { type: "conflicts_with", target: "m9", evidence: "opposite advice", proposedBy: "job_1", resolved: true });
  assert.deepEqual(unresolvedConflicts(resolved.relations), []);
});

test("a conflict withholds a method only while the method it is with is in force", () => {
  const conflicted = foldRelation(threeSuccesses(), { type: "conflicts_with", target: "m9", evidence: "opposite advice", proposedBy: "job_1" });
  const record = method({ learning: conflicted });
  const inForce = (/** @type {Record<string, string | undefined>} */ statuses) => ({ isApproved: (/** @type {string} */ id) => statuses[id] === "approved" });
  assert.equal(promotionVerdict(record, inForce({ m9: "approved" })).status, "candidate", "the library would tell a run two opposite things");
  for (const status of ["retired", "candidate", undefined]) {
    const verdict = promotionVerdict(record, inForce({ m9: status }));
    assert.equal(verdict.status, "approved", `a ${status ?? "missing"} counterpart is not told to any run, so it holds nothing back`);
    assert.deepEqual(verdict.missingDetails, []);
  }
  assert.equal(promotionVerdict(record).status, "candidate", "a caller that cannot look still has every unresolved conflict count");
  assert.deepEqual(unresolvedConflicts(conflicted.relations, () => false), []);
  assert.equal(unresolvedConflicts(conflicted.relations, () => true).length, 1);
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

/** Runs in the order given, a day apart: "r" rejected, anything else accepted.
 * Every run used the method (`invoked`) unless told otherwise, which is what
 * the harm test reads.
 * @param {string} pattern @param {string} [digest] @param {{invoked?: boolean}} [options] */
const runs = (pattern, digest = DIGEST_A, { invoked = true } = {}) => {
  let learning = emptyLearning(digest);
  [...pattern].forEach((mark, index) => {
    learning = foldObservation(learning, {
      runId: `run_${index}`, family: `fam_${index}`, outcome: mark === "r" ? "rejected" : "accepted",
      at: daysAgo(pattern.length - index), invoked,
    });
  });
  return learning;
};

test("the harm test reads the runs in order and stops at a boundary", () => {
  // Three rejections in a row cross the harm boundary; two cannot decide alone.
  assert.equal(methodHarmTest(runs("rr")).state, "watching");
  assert.deepEqual({ ...methodHarmTest(runs("rrr")), llr: undefined }, { state: "harm", reason: "upper-boundary", runs: 3, bad: 3, llr: undefined });
  // Two early rejections, then work that holds up: not harm.
  assert.equal(methodHarmTest(runs("rra")).state, "watching");
  // Four accepted runs are enough to call it clear, and later runs are not read.
  assert.deepEqual({ ...methodHarmTest(runs("aaaarrrr")), llr: undefined }, { state: "clear", reason: "lower-boundary", runs: 4, bad: 0, llr: undefined });
  // A background-rate mix that never crosses is clear at the cap.
  const mixed = "aaaaaaaaar".repeat(5);
  const capped = methodHarmTest(runs(mixed), { minRuns: 3 });
  assert.equal(capped.state, "clear");
  // A 40% rate is caught well before the cap.
  const harmful = methodHarmTest(runs("aarararrar"));
  assert.equal(harmful.state, "harm");
  assert.ok(harmful.runs <= 10, `caught after ${harmful.runs} runs`);
  assert.equal(methodHarmTest(emptyLearning(DIGEST_A)).state, "watching");
  assert.equal(methodHarmTest(/** @type {any} */ (undefined)).state, "watching");
});

test("a harmful revision is retired now; a stated one is only proposed; another revision's runs do not count", () => {
  const now = NOW;
  const harmful = retirementProposal(method({ status: "approved", learning: runs("rrrr") }), { nowMs: now });
  assert.equal(harmful.propose, true);
  assert.equal(harmful.immediate, true);
  assert.match(harmful.reason, /3 of the 3 runs that mounted this revision were rejected/, "decided at the third run, not read further");
  const stated = retirementProposal(method({ status: "approved", learning: runs("rrrr"), provenance: { origin: "explicit" } }), { nowMs: now });
  assert.deepEqual({ propose: stated.propose, immediate: stated.immediate }, { propose: true, immediate: false });
  // Observations recorded against a revision this method no longer holds.
  const amended = retirementProposal(method({ status: "approved", digest: DIGEST_B, learning: runs("rrrr", DIGEST_A) }), { nowMs: now });
  assert.equal(amended.immediate, false);
  // A safety method is read by the harm test like any other: the flag is the
  // generator's own claim, and it exempts a method from disuse only.
  const safety = retirementProposal(method({ status: "approved", learning: runs("rrrr"), provenance: { origin: "inferred", safetyRelated: true } }), { nowMs: now });
  assert.deepEqual([safety.propose, safety.immediate, safety.code], [true, true, "harm"]);
});

test("the harm test reads only the runs that used the method, never the ones that merely carried it", () => {
  // 2026-09-25: the only observations production held were GEO writing runs
  // that had a research method in their directory and never opened it.
  const carried = runs("rrrrrr", DIGEST_A, { invoked: false });
  assert.equal(carried.counts.loaded, 6, "every one of them was mounted");
  assert.deepEqual({ ...methodHarmTest(carried), llr: undefined }, { state: "watching", reason: "accumulating", runs: 0, bad: 0, llr: undefined },
    "a run that never read the method is no evidence about it");
  assert.notEqual(retirementProposal(method({ status: "approved", learning: carried }), { nowMs: NOW }).code, "harm");

  // Mixed: only the two runs that read it are counted, and two cannot decide.
  let mixed = runs("rrrr", DIGEST_A, { invoked: false });
  for (const index of [10, 11]) {
    mixed = foldObservation(mixed, { runId: `run_${index}`, family: `fam_${index}`, outcome: "rejected", at: daysAgo(0), invoked: true });
  }
  assert.equal(methodHarmTest(mixed).runs, 2);
  assert.equal(methodHarmTest(mixed).state, "watching");
});

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

test("the contribution clause waits for enough trials, and fires on a safety method too", () => {
  // A bad ratio, but too few trajectories for this clause to say anything.
  // Four good runs first, so the harm test has already read this revision as
  // clear and it is the contribution clause alone that is being asked (a run
  // of early rejections is the harm test's to decide; see above).
  const early = method({ status: "approved", learning: runs("aaaarrrrrr") });
  assert.equal(methodContribution(early.learning), -0.2);
  assert.equal(retirementProposal(early, { nowMs: NOW }).propose, false);
  assert.equal(retirementProposal(early, { nowMs: NOW, minTrials: 5 }).propose, true, "the floor is a parameter, and it bites");

  // A self-declared safety flag is not an exemption from outcomes.
  const safety = method({
    status: "approved",
    learning: record(24, 10),
    provenance: { origin: "inferred", safetyRelated: true },
  });
  assert.equal(retirementProposal(safety, { nowMs: NOW }).propose, true);
  assert.equal(retirementProposal(safety, { nowMs: NOW }).code, "contribution");

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

test("the cap ranks a safety method by its contribution like any other", () => {
  // The cap is an outcome rule, not a disuse rule: the one exemption a safety
  // method has (build spec §8.7) does not reach it.
  const methods = [
    method({ id: "m_safety", status: "approved", learning: record(20, 1), provenance: { origin: "inferred", safetyRelated: true } }),
    method({ id: "m_a", status: "approved", learning: record(20, 18) }),
    method({ id: "m_b", status: "approved", learning: record(20, 19) }),
  ];
  const over = libraryEvictions(methods, { cap: 1 });
  assert.deepEqual(over.map((entry) => entry.id), ["m_safety", "m_a"]);
});
