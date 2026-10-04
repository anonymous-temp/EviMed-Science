// One genuine error, to a scoped method, to its use, to its regression (N14).
//
// Every segment of this path has its own test; what only shows at the seams is whether the identifiers a segment writes
// are the ones the next segment reads. This file drives the whole path with the real services and the real domain rules,
// and asserts the acceptance shape of the plan's row:
//
//  1. from one correction of a delivered result, a method is derived with its scope, and it names the pair of immutable
//     result versions it was learnt from — the evidence the platform holds, never an adoption of the successor;
//  2. a later relevant ordinary task is given it, reads it, and the results that task produced carry their fate to it;
//  3. an unrelated task does not: a task of another kind is not given it, and a task that was given it and passed over it
//     earns it nothing and charges it with nothing;
//  4. unknown stays unknown: applicability is `unknown` until the engine's own diagnostics say otherwise, causal benefit
//     is `unproven`, and the delivery axis is a separate record;
//  5. a demonstrated regression is answered precisely: the exact earlier body when there is a sound one, a stop when there
//     is not, by the immediate path and by the nightly pass, and both are one click to undo.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { mountedMethodDigest } from "@evimed/domain";
import { selectLearnedMethods } from "../src/learnedMethodMount.mjs";
import { LearningService } from "../src/learningService.mjs";
import { methodView } from "../src/learningRoutes.mjs";
import { correctionLessonFor } from "../src/learningTriggers.mjs";
import { MethodConsolidation } from "../src/methodConsolidation.mjs";
import { MethodDistillationRuns } from "../src/methodDistillationRuns.mjs";
import { MethodFeedbackService } from "../src/methodFeedback.mjs";
import { runMethodObservations } from "../src/methodObservations.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const hex = (character, length = 64) => character.repeat(length);
const version = (n) => `rv_${String(n).padStart(64, "0")}`;
const USER = "owner";
const PROJECT = { id: "p", userId: USER };

const skill = (workflow, appliesWhen = "A pooled estimate is printed from several studies.") => [
  "---", 'name: "recount-pooled-studies"', 'description: "Recount the studies behind a pooled estimate against the evidence matrix before printing it."',
  'whenToUse: "When a report prints a pooled effect estimate from several studies."',
  "metadata:", '  role: "functional"', `  applies_when: "${appliesWhen}"`, '  not_when: "The estimate is a single trial\'s own result."',
  '  derived_from: "run:run-1, feedback:fb-1"', '  evimed_schema: "method-skill/1"', "---", "",
  ["## Purpose", "Keep the printed pool in step with the studies it rests on.", "", "## When to Use", "When a pooled estimate is printed.", "", "## Inputs", "The matrix and the report.", "",
    "## Workflow", workflow, "", "## Verification", "- The count of studies matches the matrix.", "", "## Constraints", "- Never print a pool of one study.", "", "## Output", "The checked report."].join("\n"), "",
].join("\n");

const V1 = skill("1. Count the studies in the matrix.\n2. Compare with the count the report prints.");
const V2 = skill("1. Count the studies in the matrix.\n2. Compare with the count the report prints.\n3. Drop any study with a missing variance.");

/** The terminal hook's reading of one finished run, as `recordMethodUse` records it into the run's ledger. */
function finishedRun({ id, capability, mounted, readIt }) {
  const method = mounted[0];
  const names = method ? [{ name: method.name, digest: method.digest }] : [];
  const messages = readIt && method ? [{ role: "assistant", parts: [{ type: "tool", tool: "read", status: "completed",
    input: { path: `/runtime/capsule-methods/${method.directoryName}/SKILL.md` } }] }] : [];
  const projection = { plan: { items: [{ id: "d1", status: "accepted", attempts: 1 }] }, subagents: [], mountedMethods: names };
  const derived = runMethodObservations({ run: { id, sessionId: `${id}-s` }, projection,
    methods: method ? [{ id: method.id, name: method.name, digest: method.digest }] : [], sessions: [{ sessionId: `${id}-s`, transcript: { messages } }] });
  return { derived, run: { id, sessionId: `${id}-s`, status: "succeeded", effectiveAgentId: capability, transcript: { completeness: "complete" },
    methodsLoaded: derived.methodsLoaded, methodsInvoked: derived.methodsInvoked } };
}

function harness() {
  const documents = productDocumentsDouble();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => new Date((clock += 60_000));
  const learning = new LearningService({ documents, now, resolveBaselineDigest: async () => `sha256:${hex("c")}` });
  const ledger = [];
  const feedback = new MethodFeedbackService({ learning, runs: { list: async () => ledger }, now });
  const distillation = new MethodDistillationRuns({ learning, jobs: { async enqueue() { return { id: "j" }; } },
    dispatch: async () => { throw new Error("not used"); }, readResult: async () => { throw new Error("not used"); } });
  const consolidation = new MethodConsolidation({ dispatch: async () => { throw new Error("no model step here"); }, readResult: async () => { throw new Error("no model step here"); }, learning, jobs: null, now });
  const correction = ({ runId, original, successor, kind = "analytic" }) => ({
    id: `feedback:result-corrected:${original}-${successor}`, trigger: "result-corrected", runId, occurredAt: new Date(Date.UTC(2026, 9, 5, 0, original)).toISOString(), userId: USER,
    subject: { type: "result-version", id: version(original) },
    detail: { schemaVersion: 1, kind, original: { versionId: version(original), digest: hex("a"), path: "report.md" }, successor: { versionId: version(successor), digest: hex("b"), path: "r/report.md" },
      effects: { bytes: "changed", printedNumbers: "changed", machineValues: "none", evidence: "identical", method: "unknown" }, anchor: { kind: "text", selectedText: "OR 0.71" },
      instructionOrigin: "researcher", successorOrigin: "system_generated", adoption: "not_recorded", originalRunId: runId, revisionRunId: "revision-run", originalMethod: null } });
  return { documents, learning, ledger, feedback, distillation, consolidation, correction, now };
}

/** A relevant research task: given what the library holds, reading what it judges applies. */
async function task(f, { id, capability = "meta-analysis", family = "research", readIt = true }) {
  const mounted = await selectLearnedMethods(f.learning, { userId: USER, projectId: "p", family });
  const finished = finishedRun({ id, capability, mounted, readIt });
  f.ledger.push(finished.run);
  return { mounted, ...finished };
}

test("from one correction to a scoped method, its use on a later relevant task, its absence from an unrelated one, and the record it earns", async () => {
  const f = harness();

  // 1. A run delivered a report; the researcher corrected the pooled estimate through the anchored revision. The platform
  //    wrote the pair of immutable versions as a feedback event and queued one correction lesson about the ORIGINAL's run.
  const original = { id: "run-1", sessionId: "run-1-s", status: "succeeded", effectiveAgentId: "meta-analysis", transcript: { completeness: "complete" }, artifacts: ["report.md"] };
  f.ledger.push(original);
  const event = f.correction({ runId: "run-1", original: 1, successor: 2, kind: "evidence" });
  const lesson = correctionLessonFor({ run: original, runs: f.ledger, project: PROJECT, event });
  assert.equal(lesson.trigger, "correction");
  assert.equal(lesson.payload.feedback[0].detail.successorOrigin, "system_generated");
  // The distillation proposes; the control plane stores. Its candidate declares the scope it is for, and what it must not be loaded into.
  const applied = await f.distillation.applyCandidate({ userId: USER, projectId: "p", payload: lesson.payload }, original, {
    candidate: { operation: "create", applicability: "A pooled estimate is printed from several studies.",
      counterexamples: ["The estimate is a single trial's own result.", "Fewer than three studies are pooled."] },
    skill: V1 });
  const created = await f.learning.getMethod(USER, applied.methodId);
  assert.equal(created.payload.status, "approved", "learnt from the researcher's own work, it takes effect at once");
  assert.equal(created.payload.provenance.origin, "inferred");
  assert.equal(created.payload.provenance.signal, "researcher");
  assert.deepEqual(created.payload.provenance.results.map((item) => [item.role, item.versionId]), [["original", version(1)], ["successor", version(2)]]);
  assert.equal(created.payload.provenance.capabilityId, "meta-analysis");
  const shown = methodView(created);
  assert.deepEqual(shown.scope, { applicability: "A pooled estimate is printed from several studies.", counterexamples: ["The estimate is a single trial's own result.", "Fewer than three studies are pooled."], current: true });
  assert.deepEqual(shown.learntFrom.map((item) => item.versionId), [version(1), version(2)]);
  // Nothing is known yet about what became of any result produced under it, and that is said.
  assert.deepEqual([shown.scientific.results, shown.scientific.causalBenefit, shown.scientific.applicability], [0, "unproven", "unknown"]);
  // The result versions it was learnt from find it by their identity, which is how a change of their sources is followed (N15).
  assert.deepEqual((await f.learning.methodsLinkedTo(USER, version(1))).map((document) => document.id), [created.id]);

  // 2. A later relevant task is given it and reads it.
  const relevant = await task(f, { id: "run-2" });
  assert.deepEqual(relevant.mounted.map((entry) => entry.name), ["recount-pooled-studies"]);
  assert.deepEqual(relevant.run.methodsInvoked.map((entry) => entry.name), ["recount-pooled-studies"]);
  // 3. An unrelated task of another kind is not given it at all; a task of this kind that was given it and passed over it reads nothing.
  const unrelatedKind = await task(f, { id: "run-geo", capability: "geo-content", family: "geo" });
  assert.deepEqual([unrelatedKind.mounted, unrelatedKind.run.methodsInvoked], [[], []]);
  const passedOver = await task(f, { id: "run-3", readIt: false });
  assert.deepEqual(passedOver.mounted.map((entry) => entry.name), ["recount-pooled-studies"]);
  assert.deepEqual([passedOver.run.methodsLoaded.map((entry) => entry.name), passedOver.run.methodsInvoked], [["recount-pooled-studies"], []]);

  // What later became of the relevant task's results: two recalculations on the same engine reproduced them, and the
  // engine's own diagnostics flagged the second's data.
  const flagged = { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies"] };
  const first = await f.feedback.fromReplay({ project: PROJECT, original: { versionId: version(10), digest: hex("a"), producer: { runId: "run-2" } }, replayId: "replay-10",
    output: { versionId: version(11) }, comparison: { environment: { status: "same" }, numbers: { status: "identical" } } });
  await f.feedback.fromReplay({ project: PROJECT, original: { versionId: version(12), digest: hex("a"), producer: { runId: "run-2" } }, replayId: "replay-12",
    output: { versionId: version(13) }, comparison: { environment: { status: "same" }, numbers: { status: "within-tolerance" } }, applicability: flagged });
  assert.deepEqual(first.recorded.map((item) => [item.kind, item.added]), [["method", true]]);
  // Results of the task that passed over it, and of the unrelated one, are corrected and not reproduced: they are not its evidence.
  await f.feedback.fromCorrection(PROJECT, f.correction({ runId: "run-3", original: 30, successor: 31 }));
  await f.feedback.fromReplay({ project: PROJECT, original: { versionId: version(40), digest: hex("a"), producer: { runId: "run-geo" } }, replayId: "replay-40",
    output: { versionId: version(41) }, comparison: { environment: { status: "same" }, numbers: { status: "changed" } } });
  let method = await f.learning.getMethod(USER, created.id);
  assert.equal(method.payload.scientific.entries.length, 2, "only what the runs that read it produced");
  assert.equal(method.payload.status, "approved");
  const record = methodView(method);
  assert.deepEqual([record.scientific.results, record.scientific.supports, record.scientific.against], [2, 2, 0]);
  assert.equal(record.scientific.applicability, "flagged");
  assert.deepEqual(record.scientific.limits.map((item) => item.codes), [["few_studies"]]);
  assert.equal(record.scientific.causalBenefit, "unproven", "agreement after use is not benefit");
  // The delivery axis is its own record: nothing above touched it.
  assert.deepEqual(method.payload.learning.observations, []);

  // 4. A later lesson amends the body; the new body begins with no record of its own, and keeps the first's.
  const amended = await f.distillation.applyCandidate({ userId: USER, projectId: "p", payload: { trigger: "correction" } }, { id: "run-4", effectiveAgentId: "meta-analysis" }, {
    candidate: { operation: "amend", targetMethodId: created.id, applicability: "A pooled estimate is printed from several studies.", counterexamples: ["Fewer than three studies are pooled."] }, skill: V2 });
  assert.equal(amended.methodId, created.id);
  method = await f.learning.getMethod(USER, created.id);
  assert.equal(method.payload.status, "candidate", "an amended body waits for the next pass, as every revised body does");
  await f.consolidation.sleep({ job: { userId: USER, projectId: "evimed-learning" } });
  method = await f.learning.getMethod(USER, created.id);
  assert.equal(method.payload.status, "approved");
  assert.notEqual(method.payload.contentDigest, created.payload.contentDigest);
  assert.deepEqual([methodView(method).scientific.results, method.payload.scientific.entries.length], [0, 2]);

  // 5. Four results produced under the new body are found wrong, one after another, by the two ways the platform sees.
  for (const [index, how] of [[1, "replay"], [2, "correction"], [3, "correction"], [4, "replay"]]) {
    const mounted = await task(f, { id: `run-new-${index}` });
    assert.equal(mounted.run.methodsInvoked[0].digest, mountedMethodDigest(method.payload, sha), "the run read the body in force");
    const joined = how === "replay"
      ? await f.feedback.fromReplay({ project: PROJECT, original: { versionId: version(50 + index), digest: hex("a"), producer: { runId: `run-new-${index}` } }, replayId: `replay-${50 + index}`,
        output: { versionId: version(60 + index) }, comparison: { environment: { status: "same" }, numbers: { status: "changed" } } })
      : await f.feedback.fromCorrection(PROJECT, f.correction({ runId: `run-new-${index}`, original: 50 + index, successor: 60 + index, kind: index === 2 ? "analytic" : "evidence" }));
    assert.equal(joined.recorded[0].acted, index === 4 ? "rollback" : undefined, `result ${index} of 4`);
  }
  // Precisely: the method is the first body again, not retired and not a guess; the second body's record is kept under it.
  const returned = await f.learning.getMethod(USER, created.id);
  assert.equal(returned.payload.contentDigest, created.payload.contentDigest);
  assert.equal(returned.payload.status, "approved");
  assert.equal(returned.payload.links.at(-1).type, "rolled_back_for_regression");
  assert.equal(returned.payload.links.at(-1).fromDigest, method.payload.contentDigest);
  assert.deepEqual([returned.payload.scientific.entries.filter((item) => item.digest === method.payload.contentDigest).length, returned.payload.scientific.entries.length], [4, 6]);
  assert.match(methodView(returned).statusReason, /不证明是这条做法造成的/);
  assert.equal(methodView(returned).scientific.supports, 2, "the first body's own record is what is read again");
  // It is the first body that later tasks read, and one click undoes the return.
  const later = await task(f, { id: "run-5" });
  assert.equal(later.run.methodsInvoked[0].digest, mountedMethodDigest(created.payload, sha));
  const undone = await f.learning.rollback(USER, created.id, { expectedRevision: returned.revision, targetRevision: returned.revision });
  assert.equal(undone.payload.contentDigest, method.payload.contentDigest);
});

test("a method with no sound earlier body is stopped by the nightly pass even when no join was there to act, and a researcher can undo it", async () => {
  const f = harness();
  const created = await f.distillation.applyCandidate({ userId: USER, projectId: "p", payload: {} }, { id: "run-1", effectiveAgentId: "meta-analysis" }, {
    candidate: { operation: "create", applicability: "A.", counterexamples: ["B."] }, skill: V1 });
  const method = await f.learning.getMethod(USER, created.methodId);
  // The record is written without the join's own check (an entry a worker that crashed before acting left behind).
  for (let index = 1; index <= 4; index += 1) {
    await f.learning.recordScientific(USER, method.id, { id: `sf_${String(index).padStart(32, "0")}`, signal: "replay_differed", at: `2026-10-05T00:0${index}:00.000Z`, digest: method.payload.contentDigest,
      used: "invoked", runId: `run-${index}`, result: { versionId: version(index), digest: hex("a") }, replay: { id: `r${index}`, outputVersionId: null, numbers: "changed" } });
  }
  assert.equal((await f.learning.getMethod(USER, method.id)).payload.status, "approved");
  const [proposal] = await f.learning.retirementProposals(USER);
  assert.deepEqual([proposal.proposal.code, proposal.proposal.action, proposal.proposal.immediate, proposal.proposal.rollbackToDigest], ["scientific_regression", "retire", true, null]);
  const night = await f.consolidation.sleep({ job: { userId: USER, projectId: "evimed-learning" } });
  assert.deepEqual(night.retirements, [method.id]);
  const stopped = await f.learning.getMethod(USER, method.id);
  assert.equal(stopped.payload.status, "retired");
  assert.match(stopped.payload.statusReason, /4 个没能被重算复现或被你改正过/);
  assert.match(stopped.payload.statusReason, /不证明因果/);
  assert.equal(stopped.payload.links.at(-1).type, "retired_for_regression");
  assert.deepEqual(await selectLearnedMethods(f.learning, { userId: USER, projectId: "p", family: "research" }), []);
  const restored = await f.learning.rollback(USER, method.id, { expectedRevision: stopped.revision, targetRevision: stopped.revision - 1 });
  assert.equal(restored.payload.status, "approved");
});

test("the nightly pass returns a method to its earlier body by digest when the join was not there to act", async () => {
  const f = harness();
  const created = await f.distillation.applyCandidate({ userId: USER, projectId: "p", payload: {} }, { id: "run-1", effectiveAgentId: "meta-analysis" }, { candidate: { operation: "create", applicability: "A.", counterexamples: ["B."] }, skill: V1 });
  const firstBody = (await f.learning.getMethod(USER, created.methodId)).payload.contentDigest;
  await f.distillation.applyCandidate({ userId: USER, projectId: "p", payload: {} }, { id: "run-2", effectiveAgentId: "meta-analysis" }, { candidate: { operation: "amend", targetMethodId: created.methodId, applicability: "A.", counterexamples: ["B."] }, skill: V2 });
  await f.consolidation.sleep({ job: { userId: USER, projectId: "evimed-learning" } });
  const second = await f.learning.getMethod(USER, created.methodId);
  assert.equal(second.payload.status, "approved");
  for (let index = 1; index <= 4; index += 1) {
    await f.learning.recordScientific(USER, second.id, { id: `sf_${String(index).padStart(32, "0")}`, signal: "analytic_corrected", at: `2026-10-05T00:0${index}:00.000Z`, digest: second.payload.contentDigest,
      used: "invoked", runId: `run-${index}`, result: { versionId: version(index), digest: hex("a") }, event: { id: `e${index}` }, kind: "analytic" });
  }
  await f.consolidation.sleep({ job: { userId: USER, projectId: "evimed-learning" } });
  const first = await f.learning.getMethod(USER, second.id);
  assert.equal(first.payload.contentDigest, firstBody, "the exact earlier body, by its digest");
  assert.notEqual(firstBody, second.payload.contentDigest);
  assert.equal(first.payload.links.at(-1).type, "rolled_back_for_regression");
  assert.equal(first.payload.status, "approved");
});
