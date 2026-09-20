// A method the loop distils takes effect at once, and the measurement that used
// to let it in is what now takes it away.
//
// The bar it replaced had never once been cleared in production:
// `learningEvaluationCommand` defaults to empty, so the evaluate job failed
// terminally by name (`method_evaluation_unavailable`) and
// `evimed_product.documents` held zero effective methods while the product told
// researchers it learned their way of working. This file is the whole rule in
// one place — creation, mount, demotion, and what the page reads off it.
import assert from "node:assert/strict";
import test from "node:test";

import { promotionVerdict, retirementProposal } from "@evimed/domain";
import { selectLearnedMethods } from "../src/learnedMethodMount.mjs";
import { LearningService, methodRecordFrom } from "../src/learningService.mjs";
import { methodView } from "../src/learningRoutes.mjs";

const USER = "usr_1";
const PROJECT = "prj_1";
const BODY = [
  "## Purpose", "Report GRADE before the effect estimate.",
  "## When to Use", "Any meta-analysis.",
  "## Inputs", "The included studies.",
  "## Workflow", "1. Grade the body of evidence.", "2. Report the estimate.",
  "## Verification", "The grade precedes the estimate in the report.",
  "## Constraints", "None.",
  "## Output", "A report section.",
].join("\n\n");

const frontmatter = (name) => ({
  name, description: "Report GRADE before the effect estimate.", whenToUse: "Any meta-analysis.",
  metadata: { evimed_schema: "method-skill/1", role: "functional", applies_when: "meta-analysis", not_when: "a single trial", derived_from: "run_seed" },
});

/** The product document store, reduced to what the learning service uses. */
function documents() {
  const rows = new Map();
  const past = new Map();
  return {
    async put(userId, kind, id, payload, { expectedRevision = 0, projectId = null } = {}) {
      const key = `${userId}\u0000${kind}\u0000${id}`;
      const current = rows.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw Object.assign(new Error("conflict"), { status: 409, code: "product_revision_conflict" });
      }
      if (current) past.set(key, [...(past.get(key) ?? []), structuredClone(current)]);
      const next = {
        id, projectId: current?.projectId ?? projectId, revision: expectedRevision + 1, payload,
        createdAt: current?.createdAt ?? "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T01:00:00.000Z",
      };
      rows.set(key, next);
      return next;
    },
    async get(userId, kind, id) { return rows.get(`${userId}\u0000${kind}\u0000${id}`) ?? null; },
    async list(userId, kind, { filter = {} } = {}) {
      const items = [...rows.entries()]
        .filter(([key]) => key.startsWith(`${userId}\u0000${kind}\u0000`))
        .map(([, row]) => row)
        .filter((row) => Object.entries(filter).every(([field, value]) => row.payload?.[field] === value));
      return { items, nextCursor: null };
    },
    async history(userId, kind, id) { return { items: [...(past.get(`${userId}\u0000${kind}\u0000${id}`) ?? [])].reverse() }; },
    async revisions() { return { items: [] }; },
    async restore() { return null; },
  };
}

async function distilled(learning, name = "grade-before-estimate") {
  return learning.createCandidate(USER, {
    projectId: PROJECT, frontmatter: frontmatter(name), body: BODY,
    provenance: { origin: "inferred", runId: "run_seed" },
  });
}

test("a distilled method is effective from the night it is learned, and mounts for real runs", async () => {
  const learning = new LearningService({ documents: documents() });
  const created = await distilled(learning);
  assert.equal(created.payload.status, "approved");
  assert.equal(created.payload.provenance.origin, "inferred", "it is still labelled as the platform's own observation");
  assert.equal(created.payload.statusChangedAt, created.payload.createdAt);

  const mounted = await selectLearnedMethods(learning, { userId: USER, projectId: PROJECT });
  assert.deepEqual(mounted.map((entry) => entry.name), ["grade-before-estimate"]);
  assert.equal(mounted[0].trial, undefined, "no trial was needed to get it there");
});

test("the page reads 「新」 and 「从你的 N 次研究学到」 off the record, never off a claim", async () => {
  const learning = new LearningService({ documents: documents() });
  const created = await distilled(learning);
  let view = methodView(created);
  assert.equal(view.status, "approved");
  assert.equal(view.statusChangedAt, created.payload.createdAt, "what the row wears 「新」 from");
  assert.equal(view.trajectories, 0, "nothing is claimed that the observations do not show");
  assert.deepEqual(view.promotion.missing, [], "and nothing is reported as missing");

  for (const index of [1, 2, 3]) {
    await learning.recordObservation(USER, created.id, {
      runId: `run_${index}`, family: `family_${index}`, outcome: "accepted", invoked: true,
      at: "2026-09-20T02:00:00.000Z", contentDigest: created.payload.contentDigest,
    });
  }
  view = methodView(await learning.getMethod(USER, created.id));
  assert.equal(view.trajectories, 3, "counted from the observations themselves");
});

test("only an unresolved conflict withholds a method, because no measurement repairs one", async () => {
  const learning = new LearningService({ documents: documents() });
  const created = await distilled(learning);
  const conflicted = await learning.recordRelations(USER, created.id, [
    { type: "conflicts_with", target: "another-method", evidence: "两条方法对同一步给出相反要求", proposedBy: "consolidate:job_1" },
  ], () => true);
  const verdict = promotionVerdict(methodRecordFrom(conflicted));
  assert.equal(verdict.status, "candidate");
  assert.deepEqual(verdict.missingDetails.map((detail) => detail.code), ["conflicts"]);
  // A conflict recorded after the fact does not take a method out of the
  // library by itself — `recordRelations` writes the relation, not a status —
  // and the next thing that recomputes the verdict refuses. That is the same
  // behaviour a conflict had before 2026-09-20; what changed is that it is now
  // the only thing this verdict ever says no to.
  await assert.rejects(
    () => learning.approve(USER, created.id, { expectedRevision: conflicted.revision }),
    (error) => error.code === "method_not_promotable" && /unresolved conflict/.test(error.message),
  );
  const fresh = await learning.createCandidate(USER, {
    projectId: PROJECT, frontmatter: frontmatter("born-conflicted"), body: BODY,
    provenance: { origin: "inferred", runId: "run_seed" },
    dependencies: [],
  });
  assert.equal(fresh.payload.status, "approved", "a method with no conflict is effective at creation");
});

test("a paired evaluation that measures worse retires it at once, and says why", async () => {
  const learning = new LearningService({ documents: documents() });
  const created = await distilled(learning);
  const measured = await learning.recordEvaluation(USER, created.id, {
    report: "evals/method-quality/reports/1.json", baselineDigest: `sha256:${"b".repeat(64)}`,
    candidateDigest: created.payload.contentDigest, verdict: "worse",
  });
  const proposal = retirementProposal(methodRecordFrom(measured), { nowMs: Date.parse("2026-09-21T00:00:00.000Z") });
  assert.equal(proposal.propose, true);
  assert.equal(proposal.immediate, true);

  const retired = await learning.retire(USER, created.id, { expectedRevision: measured.revision, reason: proposal.reason });
  assert.equal(retired.payload.status, "retired");
  assert.match(retired.payload.statusReason, /worse than working without it/);
  assert.deepEqual(await selectLearnedMethods(learning, { userId: USER, projectId: PROJECT }), []);

  // And the researcher takes it back in one click, which is the bargain.
  const restored = await learning.rollback(USER, created.id, { expectedRevision: retired.revision, targetRevision: created.revision });
  assert.equal(restored.payload.status, "approved");
  assert.equal((await selectLearnedMethods(learning, { userId: USER, projectId: PROJECT })).length, 1);
});

test("a verdict of inconclusive keeps a method, because 「we could not tell」 is not a reason to take one away", async () => {
  const learning = new LearningService({ documents: documents() });
  const created = await distilled(learning);
  const measured = await learning.recordEvaluation(USER, created.id, {
    report: "r.json", baselineDigest: `sha256:${"b".repeat(64)}`,
    candidateDigest: created.payload.contentDigest, verdict: "inconclusive",
  });
  assert.equal(retirementProposal(methodRecordFrom(measured), { nowMs: Date.now() }).propose, false);
  assert.equal(measured.payload.status, "approved");
});

test("there is still no way for a caller to say what its own method is worth", async () => {
  const learning = new LearningService({ documents: documents() });
  const created = await learning.createCandidate(USER, {
    projectId: PROJECT, frontmatter: frontmatter("asserted"), body: BODY,
    // @ts-expect-error the point of the test is that these are not parameters
    provenance: { origin: "inferred", runId: "r" }, status: "retired", promotion: { status: "retired" },
  });
  assert.equal(created.payload.status, "approved", "the verdict decided, not the caller");
});
