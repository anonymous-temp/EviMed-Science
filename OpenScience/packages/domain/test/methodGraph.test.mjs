// When a learned method may take effect, and when it should go away.
//
// The promotion rule is the only place in the learning loop where the system
// decides something about its own output, so it is written here as a truth
// table rather than as prose: every way a candidate can fail to qualify has a
// case, and the case asserts the *reason* the researcher will be shown, not
// merely that it failed.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_COUNT_KINDS, METHOD_UNUSED_RETIRE_LOADS } from "../index.mjs";
import {
  METHOD_GRAPH_ISSUE_CODES,
  METHOD_RELATION_TYPES,
  computeMethodLevels,
  emptyLearning,
  bodyPreservation,
  foldApplied,
  foldCarried,
  foldDecided,
  foldEligible,
  foldExplored,
  foldLevel,
  foldObservation,
  foldRead,
  foldRelation,
  isUnprovenMerge,
  libraryEvictions,
  methodHarmTest,
  methodLevel,
  methodStrength,
  promotionVerdict,
  relationIssues,
  resetLearningForDigest,
  retirementProposal,
  storedEvidenceQuotes,
  successfulFamilies,
  unresolvedConflicts,
  validateMethodGraph,
  withoutRetiredLearningKeys,
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
  assert.equal(proposal.immediate, true, "replaced and idle: stopped now, with one click to restore (it was a proposal nobody read)");
  assert.equal(proposal.code, "superseded");
  assert.match(proposal.reason, /superseded by m2/);
  // One the researcher stated is only proposed, and a replacement that is not in force replaces nothing.
  const stated = retirementProposal(method({ learning: unusedAndReplaced, provenance: { origin: "explicit" } }), { nowMs: NOW, isApproved: () => true });
  assert.deepEqual([stated.propose, stated.immediate, stated.code], [true, false, "superseded"]);
  assert.equal(retirementProposal(method({ learning: unusedAndReplaced }), { nowMs: NOW, isApproved: () => false }).propose, false);

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
  // The bounds are the scientific axis's (a correction is ordinary work): three rejections in a row cannot decide, four can.
  assert.equal(methodHarmTest(runs("rr")).state, "watching");
  assert.equal(methodHarmTest(runs("rrr")).state, "watching");
  assert.deepEqual({ ...methodHarmTest(runs("rrrr")), llr: undefined }, { state: "harm", reason: "upper-boundary", runs: 4, bad: 4, llr: undefined });
  // Two early rejections, then work that holds up: not harm.
  assert.equal(methodHarmTest(runs("rra")).state, "watching");
  // Three accepted runs are enough to call it clear, and later runs are not read.
  assert.deepEqual({ ...methodHarmTest(runs("aaaarrrr")), llr: undefined }, { state: "clear", reason: "lower-boundary", runs: 3, bad: 0, llr: undefined });
  // A background-rate mix that never crosses is clear at the cap.
  const mixed = "aaaaaaaaar".repeat(5);
  const capped = methodHarmTest(runs(mixed), { minRuns: 3 });
  assert.equal(capped.state, "clear");
  // A 60% rate is caught well before the cap; a coin-flip rate is not harm.
  const harmful = methodHarmTest(runs("rrarrarrr"));
  assert.equal(harmful.state, "harm");
  assert.ok(harmful.runs <= 10, `caught after ${harmful.runs} runs`);
  assert.notEqual(methodHarmTest(runs("aarararrar")).state, "harm");
  assert.equal(methodHarmTest(emptyLearning(DIGEST_A)).state, "watching");
  assert.equal(methodHarmTest(/** @type {any} */ (undefined)).state, "watching");
});

test("a harmful revision is retired now; a stated one is only proposed; another revision's runs do not count", () => {
  const now = NOW;
  const harmful = retirementProposal(method({ status: "approved", learning: runs("rrrr") }), { nowMs: now });
  assert.equal(harmful.propose, true);
  assert.equal(harmful.immediate, true);
  assert.match(harmful.reason, /4 of the 4 runs that mounted this revision were rejected/, "decided at the fourth run, not read further");
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
  assert.equal(read.counts.loaded, 0, "a reading carries no verdict, so it is not a delivery that could move a rate");
  const kept = retirementProposal(method({ learning: read }), { nowMs: NOW, isApproved: () => true });
  assert.equal(kept.propose, false);
  assert.match(kept.reason, /delegated nothing/);
  assert.ok(kept.strength < 0.5, "it is protected despite having no strength, which is the whole point");

  // A reading older than the decay window stops protecting anything, so one
  // ancient timestamp cannot pin a method in the library forever.
  const stale = foldRelation(foldRead(quiet, daysAgo(200)), superseded);
  assert.equal(retirementProposal(method({ learning: stale }), { nowMs: NOW, isApproved: () => true }).propose, true);

  // Being read is evidence of not being idle, never evidence of being good: a
  // method whose packages keep being refused is stopped however often it is
  // read, because the harm test sits above this one.
  const harmful = method({ status: "approved", learning: foldRead(runs("rrrr"), daysAgo(1)) });
  const proposal = retirementProposal(harmful, { nowMs: NOW });
  assert.deepEqual([proposal.propose, proposal.immediate, proposal.code], [true, true, "harm"]);
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

test("a method that is used constantly and hurts is stopped by the harm test, which decay alone can never do", () => {
  // Used every day and rejected most of the time: strength is high, which is exactly what the recency rule reads as healthy.
  const busy = method({ status: "approved", learning: runs("aarararrarrrrr") });
  const proposal = retirementProposal(busy, { nowMs: NOW });
  assert.ok(proposal.strength > 0.5);
  assert.deepEqual([proposal.propose, proposal.immediate, proposal.code], [true, true, "harm"]);
  assert.ok(!/superseded/.test(proposal.reason));
});

test("there is no contribution clause any more: a method that is only sometimes refused is left to the harm test", () => {
  // 24 trajectories, 10 accepted (contribution -0.17, the old clause's proposal that nothing read): the harm test, which reads
  // the order of the runs and not a ratio, has not crossed, and nothing else stops a method that is in use.
  const mixed = method({ status: "approved", learning: record(24, 10) });
  const proposal = retirementProposal(mixed, { nowMs: NOW });
  assert.notEqual(proposal.code, "contribution");
  assert.equal(proposal.immediate, false);
});

/** A record whose last use was `daysAgoUsed` days ago and that was opened `opens` times: what the cap ranks by. */
const usedLast = (/** @type {number} */ opens, /** @type {number | null} */ daysAgoUsed) => {
  let learning = emptyLearning(DIGEST_A);
  if (opens > 0) learning = { ...learning, counts: { ...learning.counts, invoked: opens } };
  if (daysAgoUsed !== null) learning = foldObservation(learning, { runId: "r", family: "f", outcome: "accepted", at: daysAgo(daysAgoUsed), invoked: opens > 0 });
  return learning;
};

test("a library over its cap gives up its least-used first: fewest openings, then longest idle", () => {
  const methods = [
    method({ id: "m_busy", status: "approved", learning: usedLast(9, 1) }),
    method({ id: "m_idle", status: "approved", learning: usedLast(1, 90) }),
    method({ id: "m_recent", status: "approved", learning: usedLast(1, 2) }),
    method({ id: "m_never", status: "approved", learning: usedLast(0, null) }),
    method({ id: "m_candidate", status: "candidate", learning: usedLast(0, null) }),
  ];
  assert.deepEqual(libraryEvictions(methods, { cap: 10 }), [], "under the cap, nothing is given up");

  const over = libraryEvictions(methods, { cap: 2 });
  assert.deepEqual(over.map((entry) => entry.id), ["m_never", "m_idle"],
    "four approved against a cap of two: the one nobody opened first, then the one idle longest");
  assert.ok(over.every((entry) => entry.immediate), "an inferred method is stopped, restorable in one click");
  assert.match(over[0].reason, /cap of 2/);
  assert.ok(!over.some((entry) => entry.id === "m_candidate"), "only effective methods count against the cap");
});

test("the cap protects a method written recently, gives a stated method up last, and only as a proposal", () => {
  const written = (/** @type {string} */ id, /** @type {string} */ since, /** @type {any} */ extra = {}) => ({ ...method({ id, status: "approved", learning: emptyLearning(DIGEST_A), ...extra }), since });
  const methods = [
    written("m_old", daysAgo(120)),
    written("m_new", daysAgo(1)),
    written("m_stated", daysAgo(300), { provenance: { origin: "explicit" } }),
  ];
  assert.deepEqual(libraryEvictions(methods, { cap: 2 }).map((entry) => entry.id), ["m_old"], "unopened and equal, the older goes");
  const both = libraryEvictions(methods, { cap: 1 });
  assert.deepEqual(both.map((entry) => entry.id), ["m_old", "m_new"], "the researcher's own statement is the last to go");
  const all = libraryEvictions(methods, { cap: 0 });
  assert.deepEqual(all.map((entry) => [entry.id, entry.immediate]), [["m_old", true], ["m_new", true], ["m_stated", false]]);
});

test("the cap ranks a safety method like any other: the flag exempts from disuse, not from the size of the library", () => {
  const methods = [
    method({ id: "m_safety", status: "approved", learning: usedLast(0, null), provenance: { origin: "inferred", safetyRelated: true } }),
    method({ id: "m_a", status: "approved", learning: usedLast(5, 1) }),
    method({ id: "m_b", status: "approved", learning: usedLast(6, 1) }),
  ];
  assert.deepEqual(libraryEvictions(methods, { cap: 1 }).map((entry) => entry.id), ["m_safety", "m_a"]);
});

/* ------------------------------------------- a merge nobody has proven expires */

/** A method a consolidation pass wrote by merging others. */
const merged = (/** @type {any} */ options = {}) => method({ status: "approved", provenance: { origin: "inferred", consolidatedBy: "consolidate:job_1" }, ...options });

test("an unproven merge is one a pass built and the harm test has not cleared", () => {
  assert.equal(isUnprovenMerge(merged()), true);
  assert.equal(isUnprovenMerge(method({ status: "approved", provenance: { origin: "inferred", runId: "run_1", consolidatedBy: "consolidate:job_1" } })), false, "a taught method a pass only amended is not a merge");
  assert.equal(isUnprovenMerge(method({ status: "approved" })), false);
  assert.equal(isUnprovenMerge(merged({ learning: runs("aaaa") })), false, "runs that opened it and held up clear it");
  assert.equal(isUnprovenMerge(merged({ status: "candidate", learning: runs("aaaa") })), true, "one that is not in force is not cleared");
  assert.equal(isUnprovenMerge(merged({ digest: DIGEST_B, learning: runs("aaaa", DIGEST_A) })), true, "another body's runs prove nothing about this one");
});

test("an unproven merge that its runs never opened expires, by carried runs or by age, and says so", () => {
  const since = daysAgo(3);
  const carried = merged({ learning: carriedRecord(10) });
  const byCarried = retirementProposal({ ...carried, since }, { nowMs: NOW });
  assert.deepEqual([byCarried.propose, byCarried.immediate, byCarried.code, byCarried.runs], [true, true, "unproven_merge_expired", 10]);
  assert.match(byCarried.reason, /carried in 10 runs and never opened/);
  assert.notEqual(retirementProposal({ ...merged({ learning: carriedRecord(9) }), since }, { nowMs: NOW }).code, "unproven_merge_expired", "one load short of the limit");

  const old = { ...merged(), since: daysAgo(14) };
  const byAge = retirementProposal(old, { nowMs: NOW });
  assert.deepEqual([byAge.propose, byAge.immediate, byAge.code], [true, true, "unproven_merge_expired"]);
  assert.match(byAge.reason, /14 days old and not used once/);
  assert.notEqual(retirementProposal({ ...merged(), since: daysAgo(13) }, { nowMs: NOW }).code, "unproven_merge_expired");
  assert.notEqual(retirementProposal(merged(), { nowMs: NOW }).code, "unproven_merge_expired", "a record that cannot say when it was written has no age to read");

  // Opened once, by anything, it is being used and waits for its test; a taught method is never read by this clause.
  assert.notEqual(retirementProposal({ ...merged({ learning: carriedRecord(40, { read: 1 }) }), since: daysAgo(40) }, { nowMs: NOW }).code, "unproven_merge_expired");
  assert.notEqual(retirementProposal({ ...method({ status: "approved", learning: carriedRecord(12) }), since: daysAgo(40) }, { nowMs: NOW }).code, "unproven_merge_expired");
  // The limits are the deployment's to move.
  assert.equal(retirementProposal({ ...merged({ learning: carriedRecord(3) }), since }, { nowMs: NOW, unprovenMergeMinCarried: 3 }).code, "unproven_merge_expired");
  assert.notEqual(retirementProposal({ ...merged({ learning: carriedRecord(30) }), since }, { nowMs: NOW, unprovenMergeMinCarried: 0 }).code, "unproven_merge_expired");
});

/* ------------------------------------------ what a group stamp and a level are */

test("a group stamp is written once per group and version, and a level only when it changes", () => {
  const learning = emptyLearning(DIGEST_A);
  const stamped = foldDecided(learning, { key: "k1", at: "2026-10-23T00:00:00.000Z", version: 2 });
  assert.deepEqual(stamped.decided, { key: "k1", at: "2026-10-23T00:00:00.000Z", version: 2 });
  assert.equal(foldDecided(stamped, { key: "k1", at: "2026-10-24T00:00:00.000Z", version: 2 }), stamped, "the same group at the same version is not written again");
  assert.equal(foldDecided(stamped, { key: "k2", at: "2026-10-24T00:00:00.000Z", version: 2 }).decided?.key, "k2");
  assert.equal(foldDecided(stamped, { key: "k1", at: "2026-10-24T00:00:00.000Z", version: 3 }).decided?.version, 3, "a new decide version reads the group again");
  assert.equal(foldDecided(learning, { key: "", at: "x" }), learning);
  assert.equal(resetLearningForDigest(stamped, DIGEST_B).decided, undefined, "an amended body is a new question");

  assert.equal(foldLevel(learning, 0), learning);
  assert.equal(foldLevel(learning, 2).level, 2);
  assert.equal(foldLevel(learning, -1), learning, "a level is never negative");
  assert.equal(foldLevel(undefined, 1).level, 1);
});

/* ------------------------------------------------ what a rewrite must keep */

test("a rewrite keeps every check and every quotation the method's own body carries", () => {
  const body = ["## Purpose", "Keep the span: “the 12 mm cut-off was chosen by the researcher”.", "", "## Verification", "- The quote still matches.", "", "## Constraints", "- Never widen.", ""].join("\n");
  const provenance = { evidence: [{ runId: "r1", seqRange: [1, 2], quote: "the 12 mm cut-off was chosen by the researcher" }, "a quote the body does not carry at all"] };
  assert.deepEqual(storedEvidenceQuotes(provenance), ["the 12 mm cut-off was chosen by the researcher", "a quote the body does not carry at all"]);
  assert.deepEqual(storedEvidenceQuotes({ evidence: ["short", { quote: "x".repeat(700) }, 5, null] }), [], "too short, too long and not text are not quotations");

  assert.deepEqual(bodyPreservation({ body, provenance }, body), { ok: true, dropped: [], quotesDropped: [] });
  const rephrased = body.replace("the 12 mm cut-off was chosen by the researcher", "a 12 mm threshold the researcher picked");
  const lost = bodyPreservation({ body, provenance }, rephrased);
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.quotesDropped, ["the 12 mm cut-off was chosen by the researcher"], "the quotation the body carried is gone; the one it never carried is held by the record, not the body");
  const shrunk = bodyPreservation({ body, provenance }, body.replace("- Never widen.\n", ""));
  assert.deepEqual([shrunk.ok, shrunk.dropped], [false, ["Never widen."]]);
  assert.deepEqual(bodyPreservation({ body }, body.replace("Keep the span", "Keep the exact span")), { ok: true, dropped: [], quotesDropped: [] }, "a method that stores no quotation is held to its checks alone");
});

/* ------------------------------------------------- carried and never opened */

/** A learning record that rode in `carried` answered runs, and was opened `invoked` times by runs with a verdict and `read` times by runs without. */
const carriedRecord = (/** @type {number} */ carried, /** @type {{invoked?: number, read?: number, digest?: string}} */ { invoked = 0, read = 0, digest = DIGEST_A } = {}) => {
  let learning = emptyLearning(digest);
  for (let index = 0; index < carried; index += 1) learning = foldCarried(learning);
  for (let index = 0; index < read; index += 1) learning = foldRead(learning, daysAgo(1));
  if (invoked > 0) learning = { ...learning, counts: { ...learning.counts, invoked } };
  return learning;
};

test("a run that carried the card is its own counter, and a record from before it starts at zero rather than at a guess", () => {
  assert.ok(METHOD_COUNT_KINDS.includes("carried"));
  assert.equal(emptyLearning(DIGEST_A).counts.carried, undefined, "it appears with the first load, so every record that never had one keeps the shape it was stored in");
  assert.equal(foldCarried(foldCarried(emptyLearning(DIGEST_A))).counts.carried, 2);
  const legacy = { digest: DIGEST_A, counts: { eligible: 4, loaded: 3, invoked: 0, succeeded: 3, read: 0 }, observations: [], relations: [], level: 0 };
  const folded = foldCarried(legacy);
  assert.equal(folded.counts.carried, 1, "no counter existed, so none is invented");
  assert.equal(folded.counts.loaded, 3, "and nothing else moves");
  assert.equal(foldCarried(undefined).counts.carried, 1);
});

test("a method whose card rode in twenty answered runs and was never opened is stopped now, with the count as its reason", () => {
  assert.equal(METHOD_UNUSED_RETIRE_LOADS, 20);
  const unused = method({ status: "approved", learning: carriedRecord(20) });
  const proposal = retirementProposal(unused, { nowMs: NOW });
  assert.deepEqual({ propose: proposal.propose, immediate: proposal.immediate, code: proposal.code, runs: proposal.runs }, { propose: true, immediate: true, code: "never_opened", runs: 20 });
  assert.match(proposal.reason, /20 runs and no run opened the method/);
  assert.equal(retirementProposal(method({ status: "approved", learning: carriedRecord(19) }), { nowMs: NOW }).code, "no_replacement",
    "one load short of the limit, the question falls through to the clauses that were always there");
});

test("one opening of any kind keeps the card in the library: a run with a verdict, or one that answered directly", () => {
  for (const opened of [{ invoked: 1 }, { read: 1 }]) {
    const proposal = retirementProposal(method({ status: "approved", learning: carriedRecord(200, opened) }), { nowMs: NOW });
    assert.notEqual(proposal.code, "never_opened", JSON.stringify(opened));
  }
});

test("the limit is a parameter, zero turns the rule off, and a deployment may ask for more", () => {
  const unused = method({ status: "approved", learning: carriedRecord(8) });
  assert.equal(retirementProposal(unused, { nowMs: NOW, unusedAfterLoads: 8 }).code, "never_opened");
  assert.notEqual(retirementProposal(unused, { nowMs: NOW, unusedAfterLoads: 9 }).code, "never_opened");
  assert.notEqual(retirementProposal(method({ status: "approved", learning: carriedRecord(500) }), { nowMs: NOW, unusedAfterLoads: 0 }).code, "never_opened");
});

test("a stated method is only proposed, a safety method is exempt from disuse, and counts about another body decide nothing", () => {
  const stated = method({ status: "approved", learning: carriedRecord(20), provenance: { origin: "explicit" } });
  const proposal = retirementProposal(stated, { nowMs: NOW });
  assert.deepEqual({ propose: proposal.propose, immediate: proposal.immediate, code: proposal.code }, { propose: true, immediate: false, code: "never_opened" });
  const safety = method({ status: "approved", learning: carriedRecord(60), provenance: { origin: "inferred", safetyRelated: true } });
  assert.notEqual(retirementProposal(safety, { nowMs: NOW }).code, "never_opened", "rarely needed is what a safety check looks like when it works");
  const amended = method({ status: "approved", digest: DIGEST_B, learning: carriedRecord(60, { digest: DIGEST_A }) });
  assert.notEqual(retirementProposal(amended, { nowMs: NOW }).code, "never_opened");
});

test("harm and incident are decided before disuse, and an already stopped method is left alone", () => {
  const hurting = method({ status: "approved", learning: { ...runs("rrrr"), counts: { ...runs("rrrr").counts, carried: 40, invoked: 4 } } });
  assert.equal(retirementProposal(hurting, { nowMs: NOW }).code, "harm");
  const incident = method({ status: "approved", learning: carriedRecord(40), provenance: { origin: "inferred", incident: true } });
  assert.equal(retirementProposal(incident, { nowMs: NOW }).code, "incident");
  assert.equal(retirementProposal(method({ status: "retired", learning: carriedRecord(40) }), { nowMs: NOW }).code, "already_retired");
});

/* ------------------------------------- what the researcher did after a run that opened it */

test("a run's reaction is one step of the harm test, once, and a correction is never taken back", () => {
  const at = daysAgo(1);
  let learning = emptyLearning(DIGEST_A);
  learning = foldApplied(learning, { runId: "run_1", outcome: "clean", at });
  learning = foldApplied(learning, { runId: "run_1", outcome: "clean", at });
  assert.deepEqual([learning.counts.appliedClean, learning.counts.appliedCorrected, learning.observations.length], [1, undefined, 1], "recorded once however often it is read");
  assert.deepEqual(learning.observations[0], { runId: "run_1", family: "applied:run_1", outcome: "accepted", at, invoked: true, applied: "clean" });
  // A clean run that is corrected later becomes a corrected one, in the counts too.
  learning = foldApplied(learning, { runId: "run_1", outcome: "corrected", at });
  assert.deepEqual([learning.counts.appliedClean, learning.counts.appliedCorrected], [0, 1]);
  assert.equal(learning.observations[0].outcome, "rejected");
  // And never the other way round.
  assert.equal(foldApplied(learning, { runId: "run_1", outcome: "clean", at }), learning);
  // Nothing recorded for a run with no runId or no outcome the vocabulary knows.
  assert.equal(foldApplied(learning, { runId: "", outcome: "clean", at }), learning);
  assert.equal(foldApplied(learning, /** @type {any} */ ({ runId: "run_2", outcome: "applause", at })), learning);
  // The deliverable counters do not move: a reaction is not a delivery.
  assert.deepEqual([learning.counts.loaded, learning.counts.succeeded, learning.counts.invoked], [0, 0, 0]);
  assert.deepEqual(successfulFamilies(foldApplied(emptyLearning(DIGEST_A), { runId: "r", outcome: "clean", at })), [], "a reaction is not a delivery it was learnt from");
});

test("the researcher's reactions are what retires a method the answer line uses: four corrected runs stop it, clean ones clear it", () => {
  const react = (/** @type {string} */ pattern, digest = DIGEST_A) => {
    let learning = emptyLearning(digest);
    [...pattern].forEach((mark, index) => {
      learning = foldApplied(learning, { runId: `run_${index}`, outcome: mark === "c" ? "corrected" : "clean", at: daysAgo(pattern.length - index) });
    });
    return learning;
  };
  assert.equal(methodHarmTest(react("ccc")).state, "watching");
  assert.equal(methodHarmTest(react("cccc")).state, "harm");
  const stopped = retirementProposal(method({ status: "approved", learning: react("cccc") }), { nowMs: NOW });
  assert.deepEqual([stopped.propose, stopped.immediate, stopped.code], [true, true, "harm"]);
  assert.equal(methodHarmTest(react("kkk")).state, "clear");
  // A deliverable's step and a reaction are different steps of one run: a package the gate accepted and the researcher corrected is one good and one bad.
  let both = foldObservation(emptyLearning(DIGEST_A), { runId: "run_1", family: "run_1:d1", outcome: "accepted", at: daysAgo(2), invoked: true });
  both = foldApplied(both, { runId: "run_1", outcome: "corrected", at: daysAgo(1) });
  assert.deepEqual(methodHarmTest(both).runs, 2);
  assert.equal(both.counts.appliedCorrected, 1);
  // A body that changed starts the count again, reactions included.
  assert.deepEqual(resetLearningForDigest(react("cc"), DIGEST_B).counts, emptyLearning(DIGEST_B).counts);
  assert.deepEqual(resetLearningForDigest(react("cc"), DIGEST_B).observations, []);
});

test("exposure is counted apart from being passed over, and a leftover key of the deleted evaluation is dropped", () => {
  const explored = foldExplored(foldExplored(emptyLearning(DIGEST_A)));
  assert.deepEqual([explored.counts.explored, explored.counts.carried], [2, undefined], "an exploration slot is no load a method can be stopped for");
  assert.ok(METHOD_COUNT_KINDS.includes("explored") && METHOD_COUNT_KINDS.includes("appliedCorrected") && METHOD_COUNT_KINDS.includes("appliedClean"));
  const old = { ...emptyLearning(DIGEST_A), evaluations: [{ verdict: "better" }] };
  assert.equal("evaluations" in withoutRetiredLearningKeys(/** @type {any} */ (old)), false);
  assert.equal(withoutRetiredLearningKeys(old).digest, DIGEST_A);
  const clean = emptyLearning(DIGEST_A);
  assert.equal(withoutRetiredLearningKeys(clean), clean, "nothing to drop, nothing copied");
});
