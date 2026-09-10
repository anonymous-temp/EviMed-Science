// The method ledger, and the one rule no caller may talk its way past.
//
// The load-bearing test in this file is the last one: nothing that generates a
// method can approve one. Everything else here is the ordinary care a store
// needs — optimistic revisions, a reset when the body moves, a rollback that
// saves forward — but that one is the difference between a loop that proposes
// and a loop that publishes to itself.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, methodContentDigest, renderMethodSkill } from "@evimed/domain";

import { LearningService, learnedMethodId, methodRecordFrom } from "../src/learningService.mjs";

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * An in-memory stand-in for ProductDocuments with the two behaviours that
 * matter: optimistic revisions, and a revision history a rollback can read.
 * Written by hand rather than mocked so a 409 here is the same 409 Postgres
 * would raise.
 */
function fakeDocuments() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, any[]>} */
  const history = new Map();
  const key = (userId, kind, id) => `${userId}:${kind}:${id}`;
  return {
    rows,
    async put(userId, kind, id, payload, { expectedRevision, projectId = null } = {}) {
      const at = key(userId, kind, id);
      const current = rows.get(at);
      if (expectedRevision === 0) {
        if (current) {
          const error = new Error("conflict"); /** @type {any} */ (error).code = "product_revision_conflict";
          throw error;
        }
        const record = { id, kind, projectId, payload, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" };
        rows.set(at, record);
        history.set(at, [{ revision: 1, payload }]);
        return record;
      }
      if (!current || current.revision !== expectedRevision) {
        const error = new Error("conflict"); /** @type {any} */ (error).code = "product_revision_conflict";
        throw error;
      }
      const next = { ...current, payload, revision: current.revision + 1 };
      rows.set(at, next);
      history.set(at, [...(history.get(at) ?? []), { revision: next.revision, payload }]);
      return next;
    },
    async get(userId, kind, id) { return rows.get(key(userId, kind, id)) ?? null; },
    async list(userId, kind, { filter = {} } = {}) {
      const items = [...rows.values()].filter((row) => row.kind === kind
        && Object.entries(filter).every(([field, value]) => row.payload?.[field] === value));
      return { items, nextCursor: null };
    },
    async history(userId, kind, id) { return { items: [...(history.get(key(userId, kind, id)) ?? [])].reverse() }; },
  };
}

const BODY = [
  "## Purpose", "Do a thing.", "",
  "## When to Use", "When the thing is needed.", "",
  "## Inputs", "A frozen input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "",
  "## Constraints", "- Never do the other thing.", "",
  "## Output", "The thing.",
].join("\n");

/** @param {Record<string, unknown>} [overrides] */
const frontmatter = (overrides = {}) => ({
  name: "do-the-thing",
  description: "Does the thing when the thing is needed, using only the frozen input it is given.",
  whenToUse: "When the thing is needed.",
  metadata: {
    role: "functional",
    applies_when: "The thing is needed.",
    not_when: "The other thing is needed.",
    derived_from: "run:run_1",
    evimed_schema: METHOD_SKILL_SCHEMA,
  },
  ...overrides,
});

/** @param {any} [options] */
function service(options = {}) {
  const documents = options.documents ?? fakeDocuments();
  /** @type {any[]} */
  const notices = [];
  const notifications = { async create(userId, input) { notices.push({ userId, ...input }); return input; } };
  /** @type {any[]} */
  const enqueued = [];
  const jobs = { async enqueue(userId, kind, payload, opts) { enqueued.push({ userId, kind, payload, opts }); return { id: "job_1" }; } };
  return {
    documents, notices, enqueued,
    learning: new LearningService({ documents, jobs, notifications, now: () => new Date("2026-09-07T00:00:00.000Z") }),
  };
}

/** @param {any} learning @param {any} [input] */
const create = (learning, input = {}) => learning.createCandidate("u1", {
  projectId: "p1",
  frontmatter: frontmatter(),
  body: BODY,
  provenance: { origin: "inferred", runId: "run_1" },
  ...input,
});

test("a created method is a candidate, and there is no parameter that says otherwise", async () => {
  const { learning } = service();
  const document = await create(learning);
  assert.equal(document.payload.status, "candidate");
  assert.equal(document.id, learnedMethodId("do-the-thing"));
  assert.equal(document.payload.contentDigest, methodContentDigest({ frontmatter: frontmatter(), body: BODY }, sha256));
  assert.deepEqual(document.payload.learning.counts, { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 });

  // The API surface itself: nothing accepts a status.
  const created = await create(learning, { frontmatter: frontmatter({ name: "another-thing" }) });
  assert.equal(created.payload.status, "candidate");
});

test("a method that breaks a rule is refused at the store, not only at the contract", async () => {
  const { learning } = service();
  await assert.rejects(
    () => create(learning, { body: BODY.replace("## Verification", "## Checks") }),
    (error) => error.code === "method_invalid" && /method_body_section_missing/.test(error.message),
  );
  // The run side validates too. Both, deliberately: once where the run can
  // repair it, and once where nothing can talk past it.
  await assert.rejects(
    () => create(learning, { frontmatter: frontmatter({ name: "Not-Kebab" }) }),
    (error) => error.code === "method_invalid",
  );
});

test("a pinned dependency nobody holds is refused, which the contract cannot see", async () => {
  const { learning } = service();
  const missing = `sha256:${"f".repeat(64)}`;
  await assert.rejects(
    () => create(learning, {
      frontmatter: frontmatter({ metadata: { ...frontmatter().metadata, depends_on: `other-method@${missing}` } }),
      body: `${BODY}\n\n[reuse method: other-method | when: always | provides: the other thing]`,
    }),
    (error) => error.code === "method_invalid" && /method_depends_on_unresolved/.test(error.message),
  );
});

test("amending the body resets everything measured about the old one", async () => {
  const { learning } = service();
  const created = await create(learning);
  const observed = await learning.recordObservation("u1", created.id, {
    runId: "r1", family: "f1", outcome: "accepted", at: "2026-09-06T00:00:00.000Z", invoked: true,
  });
  assert.equal(observed.payload.learning.counts.loaded, 1);

  const amended = await learning.amendMethod("u1", created.id, {
    expectedRevision: observed.revision,
    frontmatter: frontmatter(),
    body: `${BODY}\n\nOne more sentence.`,
    provenance: { runId: "run_2" },
  });
  assert.equal(amended.payload.status, "candidate");
  assert.deepEqual(amended.payload.learning.counts, { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 });
  assert.notEqual(amended.payload.contentDigest, created.payload.contentDigest);

  // A stale revision loses, the way every other optimistic write here does.
  await assert.rejects(
    () => learning.amendMethod("u1", created.id, { expectedRevision: 1, frontmatter: frontmatter(), body: BODY }),
    (error) => error.code === "product_revision_conflict",
  );
});

test("rollback saves an earlier revision forward and never deletes the one it replaces", async () => {
  const { learning } = service();
  const created = await create(learning);
  const amended = await learning.amendMethod("u1", created.id, {
    expectedRevision: created.revision, frontmatter: frontmatter(), body: `${BODY}\n\nA regrettable change.`,
  });
  const restored = await learning.rollback("u1", created.id, { expectedRevision: amended.revision, targetRevision: 1 });
  assert.equal(restored.payload.body, BODY);
  assert.equal(restored.payload.restoredFromRevision, 1);
  assert.equal(restored.revision, 3, "the rollback is a new revision, not a deletion of the last one");
  const history = await learning.documents.history("u1", "method", created.id);
  assert.equal(history.items.length, 3, "the regrettable version is still on the record");
  await assert.rejects(
    () => learning.rollback("u1", created.id, { expectedRevision: restored.revision, targetRevision: 99 }),
    (error) => error.code === "method_revision_unavailable",
  );
});

test("retirement needs no evidence, says why, and is undone by the rollback the route exposes", async () => {
  const { learning, notices } = service();
  const created = await create(learning);
  const retired = await learning.retire("u1", created.id, { expectedRevision: created.revision, reason: "superseded by hand" });
  assert.equal(retired.payload.status, "retired");
  assert.equal(retired.payload.statusReason, "superseded by hand");
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /superseded by hand/);

  // Un-retiring is a rollback, not a second verb. A `revive` existed here and
  // had no caller anywhere: the route offers `retire` and `rollback`, and two
  // ways to reach one status is two places for the rules to drift.
  assert.equal(typeof (/** @type {any} */ (learning).revive), "undefined");
  const restored = await learning.rollback("u1", created.id, { expectedRevision: retired.revision, targetRevision: created.revision });
  assert.equal(restored.payload.status, "candidate");
});

test("retirement proposals never include a method that is still being used", async () => {
  const { learning } = service();
  const created = await create(learning);
  await learning.retire("u1", created.id, { expectedRevision: created.revision });
  const proposals = await learning.retirementProposals("u1", { nowMs: Date.parse("2026-09-07T00:00:00.000Z") });
  assert.deepEqual(proposals, [], "a retired method is not proposed for retirement again");
});

test("a reading is recorded against the method, and is not an observation", async () => {
  const { learning } = service();
  const created = await create(learning);
  const read = await learning.recordRead("u1", created.id, "2026-09-06T00:00:00.000Z");
  assert.equal(read.payload.learning.counts.read, 1);
  assert.equal(read.payload.learning.lastReadAt, "2026-09-06T00:00:00.000Z");

  // The claim it does not make. A run that reads a method and delegates nothing
  // produced no deliverable, so there is no verdict — and `loaded` is the
  // denominator of the success rate the promotion and retirement rules read.
  assert.deepEqual(read.payload.learning.observations, []);
  assert.equal(read.payload.learning.counts.loaded, 0);
  assert.equal(read.payload.learning.counts.succeeded, 0);
});

/* ------------------------------------------------------------------ the rule */

test("nothing that generates a method can approve one", async () => {
  const { learning } = service();
  const created = await create(learning);

  // 1. A fresh candidate cannot be approved, and the refusal names what is missing.
  await assert.rejects(
    () => learning.approve("u1", created.id, { expectedRevision: created.revision }),
    (error) => error.code === "method_not_promotable" && /run families|paired evaluation/.test(error.message),
  );

  // 2. Nor can it be approved by claiming an evaluation it did not have: the
  //    verdict is recomputed from the stored record, so a caller's opinion is
  //    not an input.
  let document = created;
  for (const index of [1, 2, 3]) {
    document = await learning.recordObservation("u1", created.id, {
      runId: `r${index}`, family: `f${index}`, outcome: "accepted", at: "2026-09-06T00:00:00.000Z", invoked: true,
    });
  }
  await assert.rejects(
    () => learning.approve("u1", created.id, { expectedRevision: document.revision }),
    (error) => error.code === "method_not_promotable" && /no paired evaluation/.test(error.message),
  );

  // 3. Nor by an evaluation that does not name the text it measured: a verdict
  //    with no candidate digest describes nothing in particular, and crediting
  //    it is how a score for one revision became the first vote for another.
  document = await learning.recordEvaluation("u1", created.id, {
    report: "evals/method-quality/reports/0.json", baselineDigest: `sha256:${"b".repeat(64)}`, verdict: "better",
  });
  await assert.rejects(
    () => learning.approve("u1", created.id, { expectedRevision: document.revision }),
    (error) => error.code === "method_not_promotable" && /does not name the text it measured/.test(error.message),
  );

  // 4. With a passing evaluation on this text and against the current
  //    baseline, it goes through.
  const baseline = `sha256:${"b".repeat(64)}`;
  document = await learning.recordEvaluation("u1", created.id, {
    report: "evals/method-quality/reports/1.json", baselineDigest: baseline, verdict: "better",
    candidateDigest: document.payload.contentDigest,
  });
  const approved = await learning.approve("u1", created.id, { expectedRevision: document.revision, currentBaselineDigest: baseline });
  assert.equal(approved.payload.status, "approved");

  // 5. And a baseline that has since moved takes the approval away again.
  const moved = await learning.amendMethod("u1", created.id, {
    expectedRevision: approved.revision, frontmatter: frontmatter(), body: `${BODY}\n\nA later thought.`,
  });
  assert.equal(moved.payload.status, "candidate", "a changed body is never still approved");
  await assert.rejects(
    () => learning.approve("u1", created.id, { expectedRevision: moved.revision, currentBaselineDigest: baseline }),
    (error) => error.code === "method_not_promotable",
  );
});

test("an explicitly taught method takes effect at once, which is the other half of the bargain", async () => {
  const { learning, notices } = service();
  // At creation, with nothing else called. Before this, `approve` was the only
  // way into `approved` and no production caller ever reached it, so a method a
  // researcher wrote sat as a candidate waiting for evidence it could not
  // gather — the threshold needs the method to have been mounted, and only an
  // approved method is mounted.
  const created = await create(learning, { provenance: { origin: "explicit", runId: "run_1" } });
  assert.equal(created.payload.status, "approved");
  assert.equal(created.payload.statusChangedAt, created.payload.createdAt, "the mount orders on this field");
  assert.deepEqual((await learning.approvedMethods("u1")).map((item) => item.id), [created.id]);

  // And the nightly path still works on it without complaint.
  const approved = await learning.approve("u1", created.id, { expectedRevision: created.revision });
  assert.equal(approved.payload.status, "approved");
  assert.match(notices.at(-1).body, /immediately|回滚|rollback/i);
});

test("an inferred method is never approved at creation, whatever it claims about itself", async () => {
  const { learning } = service();
  // The store is the last place that can refuse, so it may not read a status,
  // an origin the caller invented, or a verdict the caller computed.
  const created = await create(learning, {
    provenance: { origin: "inferred", runId: "run_1" },
    // @ts-expect-error the point of the test is that these are not parameters
    status: "approved", promotion: { status: "approved" },
  });
  assert.equal(created.payload.status, "candidate");
  assert.deepEqual(await learning.approvedMethods("u1"), []);
});

test("the record the promotion rule reads is assembled in one place", async () => {
  const { learning } = service();
  const created = await create(learning);
  const record = methodRecordFrom(created);
  assert.equal(record.name, "do-the-thing");
  assert.equal(record.digest, created.payload.contentDigest);
  assert.equal(record.provenance.origin, "inferred");
  assert.deepEqual(record.learning.counts, created.payload.learning.counts);
  // A document with nothing in it still yields a usable record rather than
  // throwing: the nightly job reads every row it finds, including old ones.
  const empty = methodRecordFrom({ id: "x", payload: {} });
  assert.equal(empty.status, "candidate");
  assert.equal(empty.provenance.origin, "inferred");
});

test("a relation is refused unless it names its evidence and its author", async () => {
  const { learning } = service();
  const created = await create(learning);
  await assert.rejects(
    () => learning.recordRelations("u1", created.id, [{ type: "merge", target: created.id }]),
    (error) => error.code === "method_relation_invalid",
  );
  const written = await learning.recordRelations("u1", created.id, [
    { type: "subset", target: created.id, evidence: "the narrow one is a strict subset", proposedBy: "consolidate:job_1" },
  ], () => true);
  assert.equal(written.payload.learning.relations.length, 1);
});

test("a rendered method round-trips through the store without moving its digest", async () => {
  const { learning } = service();
  const created = await create(learning);
  const rendered = renderMethodSkill(created.payload.frontmatter, created.payload.body);
  assert.match(rendered, /^---\n/);
  assert.match(rendered, /## Verification/);
});
