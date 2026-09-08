// One method, from the run that suggested it to the run that used it.
//
// Every segment of this path had its own test and no test crossed a seam, which
// is how the loop shipped with `recordObservation` unreachable: the ledger was
// right, the promotion table was right, the mount was right, and nothing
// carried a fact from one to the next. This file drives the whole path with the
// real service and the real domain rules, and asserts the two properties that
// only appear at the seams:
//
//  1. the circle closes — a candidate can reach `approved` without anyone
//     asserting a status;
//  2. it does not close too early — the same path with weaker evidence stops,
//     and stops with a readable reason.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, methodContribution, promotionVerdict, retirementProposal } from "@evimed/domain";

import { selectLearnedMethods } from "../src/learnedMethodMount.mjs";
import { LearningService, methodRecordFrom } from "../src/learningService.mjs";
import { MethodDistillationRuns } from "../src/methodDistillationRuns.mjs";
import { runMethodObservations } from "../src/methodObservations.mjs";
import { toSkillName } from "@evimed/harness-port";

const BODY = [
  "## Purpose", "Quote before you conclude.", "",
  "## When to Use", "When a claim rests on a source.", "",
  "## Inputs", "The retrieved evidence files.", "",
  "## Workflow", "1. Quote the sentence.", "2. Then state the claim.", "",
  "## Verification", "- Every claim has a quote.", "",
  "## Constraints", "- Never paraphrase a dose.", "",
  "## Output", "The report.",
].join("\n");

const SKILL = [
  "---",
  'name: "quote-first"',
  'description: "Quote the source sentence before stating a claim that rests on it."',
  'whenToUse: "When a claim rests on a source."',
  "metadata:",
  '  role: "functional"',
  '  applies_when: "A claim rests on a source."',
  '  not_when: "The claim is the analyst\'s own estimate."',
  '  derived_from: "run:run_1"',
  `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`,
  "---",
  "",
  BODY,
  "",
].join("\n");

/** The store, with the two behaviours the path depends on. */
function fakeDocuments() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, any[]>} */
  const history = new Map();
  const key = (userId, kind, id) => `${userId}:${kind}:${id}`;
  return {
    async put(userId, kind, id, payload, { expectedRevision, projectId = null } = {}) {
      const at = key(userId, kind, id);
      const current = rows.get(at);
      if (expectedRevision === 0 && current) {
        const error = new Error("conflict"); /** @type {any} */ (error).code = "product_revision_conflict";
        throw error;
      }
      if (expectedRevision !== 0 && (!current || current.revision !== expectedRevision)) {
        const error = new Error("conflict"); /** @type {any} */ (error).code = "product_revision_conflict";
        throw error;
      }
      const record = current
        ? { ...current, payload, revision: current.revision + 1 }
        : { id, kind, projectId, payload, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" };
      rows.set(at, record);
      history.set(at, [...(history.get(at) ?? []), { revision: record.revision, payload }]);
      return record;
    },
    async get(userId, kind, id) { return rows.get(key(userId, kind, id)) ?? null; },
    async list(userId, kind, { filter = {} } = {}) {
      return {
        items: [...rows.values()].filter((row) => row.kind === kind
          && Object.entries(filter).every(([field, value]) => row.payload?.[field] === value)),
        nextCursor: null,
      };
    },
    async history(userId, kind, id) { return { items: [...(history.get(key(userId, kind, id)) ?? [])].reverse() }; },
  };
}

function harness() {
  const documents = fakeDocuments();
  /** @type {any[]} */
  const notices = [];
  /** @type {any[]} */
  const enqueued = [];
  const learning = new LearningService({
    documents,
    jobs: { async enqueue(userId, kind, payload, opts) { enqueued.push({ userId, kind, payload, opts }); return { id: "job_1" }; } },
    notifications: { async create(userId, input) { notices.push({ userId, ...input }); return input; } },
    now: () => new Date("2026-09-07T00:00:00.000Z"),
  });
  const distillation = new MethodDistillationRuns({
    learning,
    jobs: { async enqueue() { return { id: "job_2" }; } },
    dispatch: async () => { throw new Error("not used"); },
    readResult: async () => { throw new Error("not used"); },
  });
  return { documents, learning, distillation, notices, enqueued };
}

/**
 * One finished run, as the projection and transcript the terminal hook reads.
 * @param {string} runId @param {readonly string[]} deliverables @param {{name: string, digest: string}} method
 */
function finishedRun(runId, deliverables, method) {
  return {
    run: { id: runId },
    projection: {
      plan: { items: deliverables.map((id) => ({ id, status: "accepted", attempts: 1 })) },
      subagents: deliverables.map((id) => ({
        deliverableId: id,
        childSessionId: `${runId}:${id}`,
        methods: [{ name: method.name, digest: method.digest }],
      })),
    },
    sessions: deliverables.map((id) => ({ sessionId: `${runId}:${id}`, transcript: { messages: [] } })),
  };
}

/**
 * The terminal hook's rule, without the server around it.
 * @param {any} learning @param {any} finished @param {readonly {id: string, name: string, digest: string}[]} methods
 */
async function foldRun(learning, finished, methods) {
  const derived = runMethodObservations({ ...finished, methods });
  for (const { methodId, observation } of derived.observations) {
    await learning.recordObservation("u1", methodId, observation);
  }
  for (const methodId of derived.eligible) await learning.recordEligible("u1", methodId);
  // The third write the run finalizer makes, and the one that is not an
  // attribution: a method the run read with no delegation to hang it on.
  const readAt = new Date().toISOString();
  for (const entry of derived.invokedWithoutMount) await learning.recordRead("u1", entry.id, readAt);
  return derived;
}

test("a distilled candidate reaches effect through evidence, and nothing asserts a status", async () => {
  const { learning, distillation, notices } = harness();

  // 1. A run that needed repair produced a proposal.
  const applied = await distillation.applyCandidate(
    { userId: "u1", projectId: "p1", payload: {} },
    { id: "run_0" },
    { candidate: { operation: "create" }, skill: SKILL },
  );
  const methodId = applied.methodId;
  let document = await learning.getMethod("u1", methodId);
  assert.equal(document.payload.status, "candidate");
  assert.equal(document.payload.provenance.origin, "inferred");

  // 2. It is not mounted for anyone's real run.
  const known = [{ id: methodId, name: "quote-first", digest: "" }];
  assert.deepEqual(await selectLearnedMethods(learning, { userId: "u1", projectId: "p1" }), []);

  // 3. The paired evaluation is the one caller that may put it in a run, and
  //    the digest it gets mounted under is the one the ledger will compare.
  const trial = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", trialMethodIds: [methodId] });
  assert.deepEqual(trial.map((entry) => [entry.id, entry.trial]), [[methodId, true]]);
  known[0].digest = trial[0].digest;

  // 4. Three deliverables across two runs, all accepted.
  await foldRun(learning, finishedRun("run_1", ["d1", "d2"], known[0]), known);
  await foldRun(learning, finishedRun("run_2", ["d1"], known[0]), known);
  document = await learning.getMethod("u1", methodId);
  assert.deepEqual(document.payload.learning.counts,
    { eligible: 0, loaded: 3, invoked: 0, succeeded: 3, validated: 0, read: 0 });

  // Still not promotable: the trajectories are in, the measurement is not.
  let verdict = promotionVerdict(methodRecordFrom(document));
  assert.equal(verdict.status, "candidate");
  assert.match(verdict.missing.join(" "), /no paired evaluation/);
  await assert.rejects(
    () => learning.approve("u1", methodId, { expectedRevision: document.revision }),
    (error) => error.code === "method_not_promotable",
  );

  // 5. The evaluation returns, against the baseline that is current.
  await learning.recordEvaluation("u1", methodId, {
    report: "evals/method-quality/reports/e1.json",
    baselineDigest: "sha256:" + "c".repeat(64),
    verdict: "better",
  });
  document = await learning.getMethod("u1", methodId);
  verdict = promotionVerdict(methodRecordFrom(document), { currentBaselineDigest: "sha256:" + "c".repeat(64) });
  assert.equal(verdict.status, "approved", verdict.missing.join("; "));

  // 6. Promotion, and the researcher hears about it with a way back.
  const approved = await learning.approve("u1", methodId, {
    expectedRevision: document.revision,
    currentBaselineDigest: "sha256:" + "c".repeat(64),
  });
  assert.equal(approved.payload.status, "approved");
  assert.match(notices.at(-1).body, /回滚|rollback/i);

  // 7. And now it mounts for real runs, with no trial argument anywhere.
  const mounted = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1" });
  assert.deepEqual(mounted.map((entry) => entry.name), ["quote-first"]);
  assert.equal(mounted[0].trial, undefined);
  assert.equal(mounted[0].digest, known[0].digest, "the mount digest did not move across promotion");

  // 8. One rollback undoes it, saving forward.
  const rolled = await learning.rollback("u1", methodId, { expectedRevision: approved.revision, targetRevision: 1 });
  assert.equal(rolled.payload.status, "candidate");
  assert.deepEqual(await selectLearnedMethods(learning, { userId: "u1", projectId: "p1" }), []);
  assert.ok(rolled.revision > approved.revision, "history is kept, never deleted");
});

test("three trajectories inside one run are not enough, and the reason says which one is short", async () => {
  const { learning, distillation } = harness();
  const applied = await distillation.applyCandidate(
    { userId: "u1", projectId: "p1", payload: {} }, { id: "run_0" },
    { candidate: { operation: "create" }, skill: SKILL },
  );
  const trial = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", trialMethodIds: [applied.methodId] });
  const known = [{ id: applied.methodId, name: "quote-first", digest: trial[0].digest }];

  await foldRun(learning, finishedRun("run_1", ["d1", "d2", "d3"], known[0]), known);
  await learning.recordEvaluation("u1", applied.methodId, {
    report: "r.json", baselineDigest: "sha256:" + "c".repeat(64), verdict: "better",
  });
  const document = await learning.getMethod("u1", applied.methodId);
  assert.equal(document.payload.learning.counts.succeeded, 3);
  const verdict = promotionVerdict(methodRecordFrom(document), { currentBaselineDigest: "sha256:" + "c".repeat(64) });
  assert.equal(verdict.status, "candidate");
  assert.match(verdict.missing.join(" "), /came from 1 run/);
});

test("a rejected deliverable is evidence against, and amending the body starts the count over", async () => {
  const { learning, distillation } = harness();
  const applied = await distillation.applyCandidate(
    { userId: "u1", projectId: "p1", payload: {} }, { id: "run_0" },
    { candidate: { operation: "create" }, skill: SKILL },
  );
  const methodId = applied.methodId;
  const trial = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", trialMethodIds: [methodId] });
  const known = [{ id: methodId, name: "quote-first", digest: trial[0].digest }];

  const failing = finishedRun("run_1", ["d1"], known[0]);
  failing.projection.plan.items[0] = { id: "d1", status: "submitted", attempts: 2 };
  await foldRun(learning, failing, known);
  let document = await learning.getMethod("u1", methodId);
  assert.deepEqual(document.payload.learning.counts,
    { eligible: 0, loaded: 1, invoked: 0, succeeded: 0, validated: 0, read: 0 },
    "a run the gate refused is a use and not a success");

  await foldRun(learning, finishedRun("run_2", ["d1", "d2"], known[0]), known);
  document = await learning.getMethod("u1", methodId);
  assert.equal(document.payload.learning.counts.succeeded, 2);

  // The body changes, and everything measured about the old one goes with it.
  const amended = await learning.amendMethod("u1", methodId, {
    expectedRevision: document.revision,
    frontmatter: document.payload.frontmatter,
    body: `${BODY}\n\nAlways name the edition of the label you quoted.`,
  });
  assert.equal(amended.payload.status, "candidate");
  assert.deepEqual(amended.payload.learning.counts,
    { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 });
  assert.deepEqual(amended.payload.learning.observations, []);

  // And an observation carrying the old mount's digest cannot resurrect them.
  const stale = await foldRun(learning, finishedRun("run_3", ["d1"], known[0]), [
    { id: methodId, name: "quote-first", digest: amended.payload.contentDigest },
  ]);
  assert.deepEqual(stale.observations, []);
  assert.equal(stale.mismatched.length, 1);
});

test("a run that reads a method and delegates nothing keeps it out of the idle pile", async () => {
  const { learning, distillation } = harness();
  const applied = await distillation.applyCandidate(
    { userId: "u1", projectId: "p1", payload: {} }, { id: "run_0" },
    { candidate: { operation: "create" }, skill: SKILL },
  );
  const known = [{ id: applied.methodId, name: "quote-first", digest: "sha256:" + "d".repeat(64) }];

  // The non-delegating answer line: one root session, no subagents, no
  // deliverables — and a `skill` call on the learned method.
  const derived = await foldRun(learning, {
    run: { id: "run_1" },
    projection: { plan: { items: [] }, subagents: [] },
    sessions: [{
      sessionId: "run_1:root",
      transcript: { messages: [{ parts: [{ type: "tool", tool: "skill", status: "completed", input: { name: toSkillName("quote-first", "capsule") } }] }] },
    }],
  }, known);
  assert.deepEqual(derived.invokedWithoutMount, [{ id: applied.methodId, name: "quote-first" }]);
  assert.deepEqual(derived.eligible, [], "it was read, so counting it as passed over would be a false denominator");

  const document = await learning.getMethod("u1", applied.methodId);
  assert.deepEqual(document.payload.learning.counts,
    { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 1 });
  assert.deepEqual(document.payload.learning.observations, [], "no verdict, so no attribution");
  assert.equal(methodContribution(document.payload.learning), null, "and no movement in the success rate");

  // The point of the counter: with a validated replacement in the library, the
  // nightly job would otherwise propose this for retirement as unused, because
  // every outcome-reading clause sees an empty record.
  const record = methodRecordFrom(document);
  const superseded = { ...record, learning: { ...record.learning, relations: [{ type: "supersedes", target: "m2", evidence: "merged", proposedBy: "job_1" }] } };
  const nowMs = Date.parse(document.payload.learning.lastReadAt) + 86_400_000;
  assert.equal(retirementProposal(superseded, { nowMs, isApproved: () => true }).propose, false);
  assert.equal(
    retirementProposal({ ...superseded, learning: { ...superseded.learning, lastReadAt: null } }, { nowMs, isApproved: () => true }).propose,
    true,
    "without the reading, this exact method is proposed for retirement",
  );
});

test("a method that was available and not mounted gets the denominator, not a success", async () => {
  const { learning, distillation } = harness();
  const applied = await distillation.applyCandidate(
    { userId: "u1", projectId: "p1", payload: {} }, { id: "run_0" },
    { candidate: { operation: "create" }, skill: SKILL },
  );
  const known = [{ id: applied.methodId, name: "quote-first", digest: "sha256:" + "d".repeat(64) }];
  // A run in which nothing was mounted at all.
  await foldRun(learning, { run: { id: "run_1" }, projection: { plan: { items: [] }, subagents: [] }, sessions: [] }, known);
  const document = await learning.getMethod("u1", applied.methodId);
  assert.deepEqual(document.payload.learning.counts,
    { eligible: 1, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 });
});
