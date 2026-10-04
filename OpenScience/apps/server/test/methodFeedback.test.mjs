// What later became of a result, joined to the method that was read to produce it (N14).
//
// What these cases are for: the loop learns from how a run's delivery ended, and nothing carried what later became of
// the results that run produced to the method it read. The properties that make the join worth having are the ones a
// careless one loses: it is by the run's own record of what it READ (a method that was only in the room earns and loses
// nothing), under the revision that file was (a body amended since keeps its own record, so a regression is pinned to one
// body), by the immutable pair and never a path, and it is a label — a feedback that cannot be joined is skipped with its
// reason and everything it was about stands. What a demonstrated regression does is the lifecycle's answer, and it is to
// the exact earlier body.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, mountedMethodDigest, parseSkillFrontmatter } from "@evimed/domain";
import { learnedMethodId, LearningService, methodScopeOf } from "../src/learningService.mjs";
import { MethodFeedbackService } from "../src/methodFeedback.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const hex = (character, length = 64) => character.repeat(length);
const version = (n) => `rv_${String(n).padStart(64, "0")}`;
const USER = "owner";
const PROJECT = { id: "p", userId: USER };

/** A method text of its own: the name is the method's identity, the workflow line is what an amendment changes. */
function skill(name, workflow = "1. Quote the sentence.") {
  return [
    "---", `name: "${name}"`, 'description: "Quote the source sentence before stating a claim that rests on it."', 'whenToUse: "When a claim rests on a source."',
    "metadata:", '  role: "functional"', '  applies_when: "A claim rests on a source."', '  not_when: "The claim is the analyst\'s own estimate."',
    '  derived_from: "run:run_1"', `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`, "---", "",
    ["## Purpose", "Quote before you conclude.", "", "## When to Use", "When a claim rests on a source.", "", "## Inputs", "The retrieved evidence files.", "",
      "## Workflow", workflow, "", "## Verification", "- Every claim has a quote.", "", "## Constraints", "- Never paraphrase a dose.", "", "## Output", "The report."].join("\n"), "",
  ].join("\n");
}

function fixture({ provenance = { origin: "inferred", runId: "run_1" } } = {}) {
  const documents = productDocumentsDouble();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => new Date((clock += 60_000));
  const learning = new LearningService({ documents, now, resolveBaselineDigest: async () => `sha256:${hex("c")}` });
  /** @type {any[]} */
  const ledger = [];
  const audit = [];
  const f = { documents, learning, ledger, audit, state: { learning: false, trial: false }, provenance,
    service: null };
  f.service = new MethodFeedbackService({ learning, runs: { list: async () => ledger }, now, report: (code) => audit.push(code),
    enabled: async () => !f.state.learning && !f.state.trial });
  /** A learned method in force, written as the loop writes one. */
  f.method = async (name = "quote-first", workflow, extra = {}) => {
    const parsed = parseSkillFrontmatter(skill(name, workflow));
    assert.deepEqual(parsed.issues, []);
    const created = await learning.createCandidate(USER, { frontmatter: parsed.frontmatter, body: parsed.body, provenance: f.provenance, ...extra });
    assert.equal(created.payload.status, "approved");
    return created;
  };
  /** The next body of a method, in force again as the nightly pass makes it. */
  f.amend = async (name, workflow) => {
    const parsed = parseSkillFrontmatter(skill(name, workflow));
    const current = await learning.getMethod(USER, learnedMethodId(name));
    const amended = await learning.amendMethod(USER, current.id, { expectedRevision: current.revision, frontmatter: parsed.frontmatter, body: parsed.body, provenance: f.provenance });
    return learning.approve(USER, amended.id, { expectedRevision: amended.revision });
  };
  /** A finished run whose ledger says what it read: `invoked` and `loaded` are method documents (by the revision mounted). */
  f.run = ({ id = "run-1", invoked = [], loaded = [], extra = {} } = {}) => {
    const entry = (document) => ({ name: document.payload.frontmatter.name, digest: mountedMethodDigest(document.payload, sha) });
    const run = { id, sessionId: `${id}-session`, status: "succeeded", effectiveAgentId: "meta-analysis", methodsInvoked: invoked.map(entry),
      methodsLoaded: [...invoked, ...loaded].map(entry), ...extra };
    ledger.push(run);
    return run;
  };
  /** The feedback ledger's event for one correction, as the result store writes it. */
  f.correction = ({ runId = "run-1", original = 1, successor = 2, kind = "analytic", id = `feedback:result-corrected:${original}-${successor}`, at = "2026-10-04T13:00:00.000Z" } = {}) => ({
    id, trigger: "result-corrected", runId, occurredAt: at, subject: { type: "result-version", id: version(original) },
    detail: { schemaVersion: 1, revisionId: null, kind, original: { versionId: version(original), digest: hex("a"), path: "report.md" },
      successor: { versionId: version(successor), digest: hex("b"), path: "artifacts/result-revisions/rr/output/report.md" },
      effects: { bytes: "changed", printedNumbers: "changed", machineValues: "none", evidence: "identical", method: "unknown" },
      anchor: { kind: "text", selectedText: "OR 0.71" }, instructionOrigin: "researcher", successorOrigin: "system_generated", adoption: "not_recorded",
      originalRunId: runId, revisionRunId: "revision-run", originalMethod: null },
  });
  f.scientific = async (name = "quote-first") => (await learning.getMethod(USER, learnedMethodId(name))).payload.scientific;
  return f;
}

const replayOf = (numbers = "identical", environment = "same") => ({ environment: { status: environment }, numbers: { status: numbers }, scientificApplicability: "not_assessed" });
const originalVersion = (n = 1, runId = "run-1") => ({ versionId: version(n), digest: hex("a"), path: "report.md", producer: { kind: "tool", runId } });

test("a correction is carried to the revision of the method the corrected result's run read, once, by the immutable pair", async () => {
  const f = fixture();
  const method = await f.method();
  f.run({ invoked: [method] });
  const event = f.correction();
  const joined = await f.service.fromCorrection(PROJECT, event);
  assert.deepEqual(joined.recorded.map((item) => [item.kind, item.id, item.digest, item.added]), [["method", method.id, method.payload.contentDigest, true]]);
  const [entry] = (await f.scientific()).entries;
  assert.equal(entry.signal, "analytic_corrected");
  assert.equal(entry.digest, method.payload.contentDigest);
  assert.deepEqual([entry.result.versionId, entry.successor.versionId, entry.event.id, entry.kind, entry.runId], [version(1), version(2), event.id, "analytic", "run-1"]);
  assert.equal(entry.used, "invoked");
  assert.deepEqual(entry.applicability, { state: "unknown", basis: "none", codes: [] });
  assert.equal(entry.at, event.occurredAt);
  // The capture that replays and the settle that writes the event again add nothing.
  const again = await f.service.fromCorrection(PROJECT, event);
  assert.deepEqual(again.recorded.map((item) => item.added), [false]);
  assert.equal((await f.scientific()).entries.length, 1);
  // Two corrections of one version are two entries; the pair is the identity.
  await f.service.fromCorrection(PROJECT, f.correction({ successor: 3, id: "feedback:result-corrected:1-3", kind: "evidence" }));
  assert.deepEqual((await f.scientific()).entries.map((item) => item.signal), ["analytic_corrected", "evidence_corrected"]);
  // The delivery axis is not touched: no observation, no counter.
  const stored = await f.learning.getMethod(USER, method.id);
  assert.deepEqual(stored.payload.learning.observations, []);
  assert.equal(stored.payload.learning.counts.succeeded, 0);
});

test("a method that was only in the room earns nothing, and a run that read no method is no method's evidence", async () => {
  const f = fixture();
  const read = await f.method("quote-first");
  const passedOver = await f.method("sweep-claims-after-a-number-changes", "1. Sweep the claims.");
  f.run({ invoked: [read], loaded: [passedOver] });
  const joined = await f.service.fromCorrection(PROJECT, f.correction());
  assert.deepEqual(joined.recorded.map((item) => item.id), [read.id]);
  assert.equal((await f.learning.getMethod(USER, passedOver.id)).payload.scientific, undefined);

  const idle = fixture();
  await idle.method();
  idle.run({ invoked: [] });
  const skipped = await idle.service.fromCorrection(PROJECT, idle.correction());
  assert.deepEqual([skipped.recorded, skipped.skipped], [[], "no_method_read"]);
});

test("the successor is the platform's and earns nothing: the methods the revision run read are not charged", async () => {
  const f = fixture();
  const original = await f.method("quote-first");
  const later = await f.method("sweep-claims-after-a-number-changes", "1. Sweep the claims.");
  f.run({ id: "run-1", invoked: [original] });
  f.run({ id: "revision-run", invoked: [later] });
  await f.service.fromCorrection(PROJECT, f.correction());
  assert.equal((await f.learning.getMethod(USER, later.id)).payload.scientific, undefined);
  assert.equal((await f.scientific()).entries.length, 1);
});

test("an entry stays under the revision the run read: a body amended since keeps its own record, and the new body starts without one", async () => {
  const f = fixture();
  const first = await f.method("quote-first", "1. Quote the sentence.");
  const run = f.run({ invoked: [first] });
  const second = await f.amend("quote-first", "1. Quote the sentence.\n2. Then restate it in the table.");
  assert.notEqual(second.payload.contentDigest, first.payload.contentDigest);
  await f.service.fromCorrection(PROJECT, f.correction({ runId: run.id }));
  const scientific = await f.scientific();
  assert.deepEqual(scientific.entries.map((item) => item.digest), [first.payload.contentDigest]);
  const view = await f.learning.getMethod(USER, first.id);
  assert.equal(view.payload.contentDigest, second.payload.contentDigest);
  assert.equal(scientific.entries.some((item) => item.digest === second.payload.contentDigest), false);
});

test("a file no revision of the method ever was is not recorded under a guess, and a deleted method is not charged", async () => {
  const f = fixture();
  const method = await f.method();
  f.run({ invoked: [method], extra: { methodsInvoked: [{ name: "quote-first", digest: `sha256:${hex("9")}` }, { name: "a-method-that-was-deleted", digest: `sha256:${hex("8")}` }] } });
  const joined = await f.service.fromCorrection(PROJECT, f.correction());
  assert.deepEqual(joined.recorded, []);
  assert.deepEqual(joined.unresolved.map((item) => item.reason).sort(), ["method_unavailable", "revision_unknown"]);
  assert.equal(joined.skipped, null);
  assert.equal((await f.learning.getMethod(USER, method.id)).payload.scientific, undefined);
});

test("a feedback that cannot be joined is a labelled skip, never a failure", async () => {
  const f = fixture();
  const method = await f.method();
  f.run({ invoked: [method] });
  assert.equal((await f.service.fromCorrection(PROJECT, { ...f.correction(), detail: {} })).skipped, "correction_unreadable");
  assert.equal((await f.service.fromCorrection(PROJECT, f.correction({ runId: "a-run-the-ledger-rolled-past" }))).skipped, "run_unavailable");
  const noRun = f.correction();
  noRun.runId = null; noRun.detail.originalRunId = null;
  assert.equal((await f.service.fromCorrection(PROJECT, noRun)).skipped, "run_unknown");
  // A ledger that cannot be read is the same: unknown.
  const broken = new MethodFeedbackService({ learning: f.learning, runs: { list: async () => { throw new Error("down"); } } });
  assert.equal((await broken.fromCorrection(PROJECT, f.correction())).skipped, "run_unavailable");
  assert.equal((await f.learning.getMethod(USER, method.id)).payload.scientific, undefined);
});

test("the researcher's own switch, a capsule trial, an evaluation cell and the platform's own work are not the researcher's learning", async () => {
  const f = fixture();
  const method = await f.method();
  f.run({ id: "run-1", invoked: [method] });
  f.state.learning = true;
  assert.equal((await f.service.fromCorrection(PROJECT, f.correction())).skipped, "not_learnable");
  f.state = { learning: false, trial: true };
  assert.equal((await f.service.fromCorrection(PROJECT, f.correction())).skipped, "not_learnable");
  f.state = { learning: false, trial: false };
  f.run({ id: "run-eval", invoked: [method], extra: { learningEvaluation: { cell: "c1" } } });
  assert.equal((await f.service.fromCorrection(PROJECT, f.correction({ runId: "run-eval" }))).skipped, "not_learnable");
  f.run({ id: "run-auto", invoked: [method], extra: { automated: true } });
  assert.equal((await f.service.fromCorrection(PROJECT, f.correction({ runId: "run-auto" }))).skipped, "not_learnable");
  assert.equal((await f.service.fromCorrection({ id: "evimed-learning", userId: USER }, f.correction())).skipped, "not_learnable");
  assert.equal((await f.learning.getMethod(USER, method.id)).payload.scientific, undefined);
  f.run({ id: "run-trial", invoked: [], extra: { methodsInvoked: [{ name: "quote-first", digest: mountedMethodDigest(method.payload, sha), trial: true }] } });
  assert.equal((await f.service.fromCorrection(PROJECT, f.correction({ runId: "run-trial" }))).skipped, "no_method_read");
});

test("a trusted recalculation is carried to the same revision, with what the engine's own diagnostics said; a changed engine is not evidence", async () => {
  const f = fixture();
  const method = await f.method();
  f.run({ invoked: [method] });
  const output = { versionId: version(7) };
  const flagged = { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies"] };
  const agreed = await f.service.fromReplay({ project: PROJECT, original: originalVersion(), replayId: "replay-1", output, comparison: replayOf("within-tolerance"), applicability: flagged });
  assert.deepEqual(agreed.recorded.map((item) => item.added), [true]);
  const differed = await f.service.fromReplay({ project: PROJECT, original: originalVersion(2), replayId: "replay-2", output: { versionId: version(8) }, comparison: replayOf("changed") });
  assert.equal(differed.recorded.length, 1);
  const [first, second] = (await f.scientific()).entries;
  assert.deepEqual([first.signal, first.replay.id, first.replay.outputVersionId, first.replay.numbers, first.applicability.state, first.applicability.codes],
    ["replay_agreed", "replay-1", version(7), "within-tolerance", "flagged", ["few_studies"]]);
  assert.deepEqual([second.signal, second.applicability.state], ["replay_differed", "unknown"]);
  // On another engine than the original's the numbers may differ for the engine's sake; not compared is not agreed.
  for (const [comparison, reason] of [[replayOf("changed", "differs"), "environment_differs"], [{ numbers: { status: "changed" } }, "environment_unknown"],
    [replayOf("not-assessed"), "not_assessed"], [null, "no_comparison"]]) {
    const skipped = await f.service.fromReplay({ project: PROJECT, original: originalVersion(3), replayId: "replay-3", output, comparison });
    assert.deepEqual([skipped.recorded, skipped.skipped], [[], reason]);
  }
  assert.equal((await f.scientific()).entries.length, 2);
  // A result whose version names no producing run cannot be joined.
  assert.equal((await f.service.fromReplay({ project: PROJECT, original: { ...originalVersion(4), producer: { kind: "tool", runId: null } }, replayId: "r4", output, comparison: replayOf() })).skipped, "run_unknown");
});

test("three results found wrong under the body in force return the method to the exact earlier body, and say why without claiming cause", async () => {
  const f = fixture();
  const first = await f.method("quote-first", "1. Quote the sentence.");
  const second = await f.amend("quote-first", "1. Quote the sentence.\n2. Then restate it in the table.");
  // A newer body's runs.
  for (const [index, kind] of [[1, "analytic"], [2, "evidence"], [3, "analytic"]]) {
    f.run({ id: `run-${index}`, invoked: [second] });
    const joined = await f.service.fromCorrection(PROJECT, f.correction({ runId: `run-${index}`, original: index * 10, successor: index * 10 + 1, kind }));
    assert.equal(joined.recorded[0].acted, index === 3 ? "rollback" : undefined);
  }
  const returned = await f.learning.getMethod(USER, first.id);
  assert.equal(returned.payload.contentDigest, first.payload.contentDigest);
  assert.equal(returned.payload.status, "approved");
  const link = returned.payload.links.at(-1);
  assert.deepEqual([link.type, link.fromDigest, link.toDigest, link.results, link.against], ["rolled_back_for_regression", second.payload.contentDigest, first.payload.contentDigest, 3, 3]);
  assert.equal(link.evidence.length, 3);
  // The record keeps what happened under the body it left; the reader is told, in their words, what it is and is not.
  assert.equal(returned.payload.scientific.entries.length, 3);
  assert.match(returned.payload.statusReason, /3 个结果里有 3 个/);
  assert.match(returned.payload.statusReason, /不证明是这条做法造成的/);
  // And the history keeps both bodies: it is one click to undo.
  assert.equal((await f.learning.history(USER, first.id)).length >= 2, true);
});

test("a method with no sound earlier body is stopped, never returned to one", async () => {
  const f = fixture();
  const only = await f.method();
  for (let index = 1; index <= 3; index += 1) {
    f.run({ id: `run-${index}`, invoked: [only] });
    await f.service.fromReplay({ project: PROJECT, original: originalVersion(index, `run-${index}`), replayId: `replay-${index}`, output: { versionId: version(50 + index) }, comparison: replayOf("changed") });
  }
  const stopped = await f.learning.getMethod(USER, only.id);
  assert.equal(stopped.payload.status, "retired");
  assert.match(stopped.payload.statusReason, /3 个没能被重算复现或被你改正过/);
  assert.equal(stopped.payload.links.at(-1).type, "retired_for_regression");
  assert.equal(stopped.payload.links.at(-1).toDigest, null);
});

test("a researcher's own method is never changed by the join, and agreement and restyling never read as a regression", async () => {
  const explicit = fixture({ provenance: { origin: "explicit" } });
  const mine = await explicit.method();
  for (let index = 1; index <= 3; index += 1) {
    explicit.run({ id: `run-${index}`, invoked: [mine] });
    await explicit.service.fromCorrection(PROJECT, explicit.correction({ runId: `run-${index}`, original: index, successor: index + 10, kind: "analytic" }));
  }
  const stillMine = await explicit.learning.getMethod(USER, mine.id);
  assert.equal(stillMine.payload.status, "approved");
  assert.equal(stillMine.payload.scientific.entries.length, 3);
  // ... and it is a proposal the nightly pass can show.
  const [proposal] = await explicit.learning.retirementProposals(USER);
  assert.deepEqual([proposal.proposal.code, proposal.proposal.immediate], ["scientific_regression", false]);

  const calm = fixture();
  const method = await calm.method();
  for (let index = 1; index <= 5; index += 1) {
    calm.run({ id: `run-${index}`, invoked: [method] });
    await calm.service.fromReplay({ project: PROJECT, original: originalVersion(index, `run-${index}`), replayId: `replay-${index}`, output: { versionId: version(60 + index) }, comparison: replayOf("identical") });
    await calm.service.fromCorrection(PROJECT, calm.correction({ runId: `run-${index}`, original: 100 + index, successor: 200 + index, kind: "presentation", id: `fb-${index}` }));
  }
  assert.equal((await calm.learning.getMethod(USER, method.id)).payload.status, "approved");
  assert.equal((await calm.learning.retirementProposals(USER)).length, 0);
});

test("a handbook the run used carries the same record, and one that was only attached or has been replaced since carries nothing", async () => {
  const f = fixture();
  const method = await f.method();
  const handbookId = "method:capability-handbook:meta-analysis:quote-first";
  const handbook = (extra = {}) => ({ recordType: "capability-handbook", capabilityId: "meta-analysis", status: "active", contentDigest: `sha256:${hex("e")}`,
    frontmatter: { name: "quote-first" }, body: "x", version: 1, observations: [], ...extra });
  await f.documents.put(USER, "method", handbookId, handbook({ observations: [{ runId: "run-1", contentDigest: `sha256:${hex("e")}`, attached: true, used: true }] }), { expectedRevision: 0 });
  const other = "method:capability-handbook:meta-analysis:only-attached";
  await f.documents.put(USER, "method", other, handbook({ observations: [{ runId: "run-1", contentDigest: `sha256:${hex("e")}`, attached: true, used: false }] }), { expectedRevision: 0 });
  const replaced = "method:capability-handbook:meta-analysis:replaced";
  await f.documents.put(USER, "method", replaced, handbook({ contentDigest: `sha256:${hex("f")}`, observations: [{ runId: "run-1", contentDigest: `sha256:${hex("e")}`, attached: true, used: true }] }), { expectedRevision: 0 });
  f.run({ invoked: [method], extra: { capabilityHandbooks: [
    { id: handbookId, ownerId: USER, capabilityId: "meta-analysis", contentDigest: `sha256:${hex("e")}` },
    { id: other, ownerId: USER, capabilityId: "meta-analysis", contentDigest: `sha256:${hex("e")}` },
    { id: replaced, ownerId: USER, capabilityId: "meta-analysis", contentDigest: `sha256:${hex("e")}` },
    { id: handbookId, ownerId: "someone-else", capabilityId: "meta-analysis", contentDigest: `sha256:${hex("e")}` }] } });
  const joined = await f.service.fromCorrection(PROJECT, f.correction());
  assert.deepEqual(joined.recorded.map((item) => [item.kind, item.id, item.added]), [["method", method.id, true], ["handbook", handbookId, true], ["handbook", replaced, false]]);
  assert.equal((await f.documents.get(USER, "method", handbookId)).payload.scientific.entries[0].signal, "analytic_corrected");
  assert.equal((await f.documents.get(USER, "method", other)).payload.scientific, undefined);
  assert.equal((await f.documents.get(USER, "method", replaced)).payload.scientific, undefined);
});

test("what a lesson is shown of the methods a run read: identity, revision, what became of the results, the scope, and what was passed over", async () => {
  const f = fixture();
  const read = await f.method("quote-first", undefined, { scope: { applicability: "A claim rests on a source.", counterexamples: ["The claim is the analyst's own estimate."] } });
  const passed = await f.method("sweep-claims-after-a-number-changes", "1. Sweep the claims.");
  f.run({ invoked: [read], loaded: [passed], extra: { methodsInvoked: [
    { name: "quote-first", digest: mountedMethodDigest(read.payload, sha) }, { name: "gone", digest: `sha256:${hex("1")}` }] } });
  await f.service.fromCorrection(PROJECT, f.correction());
  const run = f.ledger[0];
  const shown = await f.service.usedForLesson(PROJECT, run);
  assert.equal(shown.invoked.length, 1);
  const [method] = shown.invoked;
  assert.deepEqual([method.id, method.name, method.status, method.digest, method.current], [read.id, "quote-first", "approved", read.payload.contentDigest, true]);
  assert.deepEqual([method.scientific.against, method.scientific.causalBenefit, method.scientific.applicability], [1, "unproven", "unknown"]);
  assert.deepEqual(method.scope, { applicability: "A claim rests on a source.", counterexamples: ["The claim is the analyst's own estimate."], current: true });
  assert.deepEqual(shown.passedOver.map((item) => item.name), ["sweep-claims-after-a-number-changes"]);
  assert.deepEqual(shown.unresolved, [{ name: "gone", reason: "method_unavailable" }]);
  assert.equal(JSON.stringify(shown).includes("Quote before you conclude"), false, "the body is the related methods' to carry, not this list's");
});

test("the methods a result version is linked to are found by its immutable identity, learnt from or used for", async () => {
  const f = fixture();
  const used = await f.method("quote-first");
  const learnt = await f.method("sweep-claims-after-a-number-changes", "1. Sweep the claims.", { provenance: { origin: "inferred", runId: "run_1", results: [
    { role: "original", versionId: version(1), digest: hex("a") }, { role: "successor", versionId: version(2), digest: hex("b") }] } });
  f.run({ invoked: [used] });
  await f.service.fromCorrection(PROJECT, f.correction());
  assert.deepEqual((await f.learning.methodsLinkedTo(USER, version(1))).map((document) => document.id).sort(), [learnt.id, used.id].sort());
  assert.deepEqual((await f.learning.methodsLinkedTo(USER, version(2))).map((document) => document.id), [learnt.id]);
  assert.deepEqual(await f.learning.methodsLinkedTo(USER, version(99)), []);
  assert.deepEqual(learnt.payload.provenance.results.map((item) => item.role), ["original", "successor"]);
});

test("the scope a method declared is kept beside it, outside its digest, and an amendment that brings none leaves it standing as no longer current", async () => {
  const f = fixture();
  const created = await f.method("quote-first", "1. Quote the sentence.", { scope: { applicability: "A claim rests on a source.", counterexamples: ["The claim is the analyst's own estimate."] } });
  assert.deepEqual(methodScopeOf(created.payload), { applicability: "A claim rests on a source.", counterexamples: ["The claim is the analyst's own estimate."], current: true });
  const bare = await f.method("no-scope-declared", "1. Do the thing.");
  assert.equal(methodScopeOf(bare.payload), null);
  const parsed = parseSkillFrontmatter(skill("quote-first", "1. Quote the sentence.\n2. Check the table."));
  const amended = await f.learning.amendMethod(USER, created.id, { expectedRevision: created.revision, frontmatter: parsed.frontmatter, body: parsed.body, provenance: f.provenance });
  assert.equal(methodScopeOf(amended.payload).current, false);
  const narrowed = await f.learning.amendMethod(USER, created.id, { expectedRevision: amended.revision, frontmatter: parsed.frontmatter, body: `${parsed.body}\n`.replace(/\n\n$/, "\n"),
    provenance: f.provenance, scope: { applicability: "A claim rests on a source.", counterexamples: ["The claim is the analyst's own estimate.", "Fewer than three studies."] } });
  assert.deepEqual(methodScopeOf(narrowed.payload).counterexamples.length, 2);
  // Returning to the first body returns its scope with it, and a body with none declares none.
  const history = await f.learning.history(USER, created.id);
  const back = await f.learning.rollback(USER, created.id, { expectedRevision: (await f.learning.getMethod(USER, created.id)).revision, targetDigest: created.payload.contentDigest });
  assert.equal(back.payload.contentDigest, created.payload.contentDigest);
  assert.equal(methodScopeOf(back.payload).counterexamples.length, 1);
  assert.equal(history.length >= 2, true);
});

test("a method learnt twice from corrections names every pair it was shaped by, once each, bounded", async () => {
  const f = fixture();
  const first = await f.method("quote-first", "1. Quote the sentence.", { provenance: { origin: "inferred", runId: "run_1", results: [{ role: "original", versionId: version(1), digest: hex("a") }] } });
  const parsed = parseSkillFrontmatter(skill("quote-first", "1. Quote the sentence.\n2. Check the table."));
  const amended = await f.learning.amendMethod(USER, first.id, { expectedRevision: first.revision, frontmatter: parsed.frontmatter, body: parsed.body,
    provenance: { origin: "inferred", runId: "run_2", results: [{ role: "original", versionId: version(1), digest: hex("a") }, { role: "original", versionId: version(5), digest: hex("a") }, { role: "weird", versionId: version(6) }] } });
  assert.deepEqual(amended.payload.provenance.results.map((item) => item.versionId), [version(1), version(5)]);
});

test("rolling back to a digest the method never held, or to the one it holds, is refused by name", async () => {
  const f = fixture();
  const method = await f.method();
  await f.amend("quote-first", "1. Quote the sentence.\n2. Check the table.");
  const current = await f.learning.getMethod(USER, method.id);
  for (const targetDigest of [`sha256:${hex("7")}`, current.payload.contentDigest]) {
    await assert.rejects(f.learning.rollback(USER, method.id, { expectedRevision: current.revision, targetDigest }), (error) => error.code === "method_revision_unavailable");
  }
});
