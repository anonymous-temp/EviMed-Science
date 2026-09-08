// What a distillation run is allowed to write about itself.
//
// This file exists because `applyCandidate` had no test at all, and the thing
// it turned out to be doing was letting the run's own model output choose
// `origin: "explicit"` — the one value that exempts a method from the paired
// evaluation and mounts it into every later run of the project. Every other
// part of the design was arranged so that generation cannot approve itself, and
// the bypass was one word in a JSON file the model wrote.
//
// So the load-bearing test here is the first one, and it is deliberately
// written against the hostile input rather than the happy path: the happy path
// was green the whole time the hole was open.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { MethodDistillationRuns } from "../src/methodDistillationRuns.mjs";

const BODY = [
  "## Purpose", "Do a thing.", "",
  "## When to Use", "When the thing is needed.", "",
  "## Inputs", "A frozen input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "",
  "## Constraints", "- Never do the other thing.", "",
  "## Output", "The thing.",
].join("\n");

const SKILL = [
  "---",
  'name: "do-the-thing"',
  'description: "Does the thing when the thing is needed, using only the frozen input it is given."',
  'whenToUse: "When the thing is needed."',
  "metadata:",
  '  role: "functional"',
  '  applies_when: "The thing is needed."',
  '  not_when: "The other thing is needed."',
  '  derived_from: "run:run_1"',
  `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`,
  "---",
  "",
  BODY,
  "",
].join("\n");

/** A learning service that records what it was asked to write. */
function fakeLearning() {
  /** @type {any[]} */
  const created = [];
  /** @type {any[]} */
  const amended = [];
  return {
    created, amended,
    async createCandidate(userId, input) { created.push({ userId, ...input }); return { id: "method:learned:do-the-thing" }; },
    async amendMethod(userId, methodId, input) { amended.push({ userId, methodId, ...input }); return { id: methodId }; },
    async getMethod() { return { id: "method:learned:do-the-thing", revision: 3, payload: { dependencies: [] } }; },
  };
}

/** @param {any} [learning] */
function runs(learning = fakeLearning()) {
  /** @type {any[]} */
  const enqueued = [];
  const distillation = new MethodDistillationRuns({
    learning,
    jobs: { async enqueue(userId, kind, payload, opts) { enqueued.push({ userId, kind, payload, opts }); return { id: "job_2" }; } },
    // `applyCandidate` never reaches either of these; they are required at
    // construction because the class as a whole dispatches a bounded run.
    dispatch: async () => { throw new Error("applyCandidate must not dispatch a run"); },
    readResult: async () => { throw new Error("applyCandidate must not read a run result"); },
  });
  return { distillation, learning, enqueued };
}

const job = { userId: "u1", projectId: "p1", payload: { feedbackEventIds: ["fe_1"] } };
const run = { id: "run_1" };

test("a distillation run cannot mint an explicit method, however it labels its own output", async () => {
  const { distillation, learning } = runs();
  await distillation.applyCandidate(job, run, {
    candidate: { operation: "create", origin: "explicit" },
    skill: SKILL,
  });
  assert.equal(learning.created.length, 1);
  assert.equal(learning.created[0].provenance.origin, "inferred",
    "an explicit origin skips the paired evaluation; only a person may claim one");
  // The external part of the trigger is still recorded — it is evidence, not an
  // exemption.
  assert.deepEqual(learning.created[0].provenance.feedbackEventIds, ["fe_1"]);
  assert.equal(learning.created[0].provenance.runId, "run_1");
});

test("the same refusal holds for an amendment, which is the other way into an existing method", async () => {
  const { distillation, learning } = runs();
  await distillation.applyCandidate(job, run, {
    candidate: { operation: "amend", origin: "explicit", targetMethodId: "method:learned:do-the-thing" },
    skill: SKILL,
  });
  assert.equal(learning.amended.length, 1);
  assert.equal(learning.amended[0].provenance.origin, "inferred");
});

test("a safety-touching candidate keeps the one flag it is allowed to raise", async () => {
  // `safetyRelated` is the opposite of an exemption: it makes a method harder
  // to retire, never easier to promote, so the run is trusted to raise it.
  const { distillation, learning } = runs();
  await distillation.applyCandidate(job, run, {
    candidate: { operation: "create", risk: { touchesSafety: true } },
    skill: SKILL,
  });
  assert.equal(learning.created[0].provenance.safetyRelated, true);
  assert.equal(learning.created[0].provenance.origin, "inferred");
});

test("no_change writes nothing at all, which is the commonest correct answer", async () => {
  const { distillation, learning, enqueued } = runs();
  const applied = await distillation.applyCandidate(job, run, { candidate: { operation: "no_change" } });
  assert.deepEqual(applied, { operation: "no_change", methodId: undefined });
  assert.equal(learning.created.length, 0);
  assert.equal(enqueued.length, 0);
});

test("an unknown operation and an unparseable skill are both refused before the store sees them", async () => {
  const { distillation, learning } = runs();
  await assert.rejects(
    () => distillation.applyCandidate(job, run, { candidate: { operation: "publish" }, skill: SKILL }),
    (error) => error.code === "method_candidate_invalid" && /publish/.test(error.message),
  );
  await assert.rejects(
    () => distillation.applyCandidate(job, run, { candidate: { operation: "create" }, skill: "no frontmatter here" }),
    (error) => error.code === "method_candidate_invalid",
  );
  await assert.rejects(
    () => distillation.applyCandidate(job, run, { candidate: { operation: "amend" }, skill: SKILL }),
    (error) => error.code === "method_candidate_invalid" && /must name the method/.test(error.message),
  );
  assert.equal(learning.created.length, 0);
  assert.equal(learning.amended.length, 0);
});

test("a written method is queued for integration, so it is compared against what exists", async () => {
  const { distillation, enqueued } = runs();
  await distillation.applyCandidate(job, run, { candidate: { operation: "create" }, skill: SKILL });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, "consolidate");
  assert.equal(enqueued[0].payload.action, "integrate");
  assert.equal(enqueued[0].payload.methodId, "method:learned:do-the-thing");
});
