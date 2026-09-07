// The nightly pass, and the two places where it refuses its own model.
//
// The builder is told to preserve every verification and constraint item, and
// SkillPyramid states that as prose. Stated as prose it is a request; stated as
// "the item set may grow and may not shrink" it is decidable, and this file is
// where the decision is made. The other refusal is quieter: a group of methods
// is disjoint, because a method rewritten twice in one night keeps only the
// second rewrite and loses the first without anything failing.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, renderMethodSkill } from "@evimed/domain";

import { CONSOLIDATE_ACTIONS, MethodConsolidation, candidatePairs, groupPairs } from "../src/methodConsolidation.mjs";

const SECTIONS = (extra = "") => [
  "## Purpose", "Do a thing.", "",
  "## When to Use", "When needed.", "",
  "## Inputs", "An input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- The quote still matches its source.", "- The numbers were swept.", "",
  "## Constraints", "- Never widen a claim.", extra, "",
  "## Output", "The thing.",
].join("\n");

/** @param {string} name @param {string} [description] */
const frontmatter = (name, description = "Resolves a claim to the source span it is bonded to, for a report under repair.") => ({
  name,
  description,
  whenToUse: "When a claim needs its span.",
  metadata: {
    role: "functional",
    applies_when: "A claim and a source ledger exist.",
    not_when: "The source is unavailable.",
    derived_from: "run:run_1",
    evimed_schema: METHOD_SKILL_SCHEMA,
  },
});

/** @param {string} id @param {string} name @param {any} [overrides] */
const doc = (id, name, overrides = {}) => ({
  id,
  revision: 1,
  projectId: "p1",
  payload: {
    recordType: "learned-method",
    status: "candidate",
    frontmatter: frontmatter(name),
    body: SECTIONS(),
    contentDigest: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
    learning: { digest: `sha256:${id.padEnd(64, "0").slice(0, 64)}`, counts: {}, observations: [], relations: [], evaluations: [], level: 0 },
    provenance: { origin: "inferred" },
    ...overrides,
  },
});

/** A learning-service stand-in that records what was asked of it. */
function fakeLearning(items) {
  return {
    items,
    amendments: /** @type {any[]} */ ([]),
    relations: /** @type {any[]} */ ([]),
    approvals: /** @type {any[]} */ ([]),
    async listMethods() { return { items: this.items }; },
    async getMethod(userId, id) { return this.items.find((item) => item.id === id); },
    async recordRelations(userId, id, relations) { this.relations.push({ id, relations }); return this.items.find((item) => item.id === id); },
    async amendMethod(userId, id, input) { this.amendments.push({ id, input }); return { ...this.items.find((item) => item.id === id), revision: 2 }; },
    async approve(userId, id) {
      this.approvals.push(id);
      const error = new Error("not promotable"); /** @type {any} */ (error).code = "method_not_promotable";
      throw error;
    },
    async retire() { return null; },
    async recordEvaluation() { return null; },
    async retirementProposals() { return []; },
  };
}

/** @param {any} options */
function consolidation(options) {
  /** @type {any[]} */
  const dispatched = [];
  return {
    dispatched,
    instance: new MethodConsolidation({
      dispatch: async (request) => { dispatched.push(request); return { runId: "r1", sessionId: "s1", dispatchId: request.dispatchId }; },
      readResult: options.readResult ?? (async () => ({ status: "succeeded", output: {} })),
      learning: options.learning,
      jobs: options.jobs ?? null,
      notifications: options.notifications ?? null,
      now: () => new Date("2026-09-07T00:00:00.000Z"),
    }),
  };
}

test("the action vocabulary is closed and an unknown one is refused before any model call", async () => {
  assert.deepEqual([...CONSOLIDATE_ACTIONS], ["sleep", "integrate", "evaluate", "optimize"]);
  const { instance, dispatched } = consolidation({ learning: fakeLearning([]) });
  await assert.rejects(
    () => instance.run({ job: { payload: { action: "improvise" } } }),
    (error) => error.code === "consolidate_action_invalid",
  );
  assert.deepEqual(dispatched, []);
});

test("candidate pairs come from shared vocabulary, and groups are disjoint", () => {
  const items = [
    doc("m1", "resolve-claim-span", "Resolves a claim to the source span it is bonded to."),
    doc("m2", "resolve-claim-anchor", "Resolves a claim to the source span it quotes."),
    doc("m3", "count-forest-plots", "Counts forest plots in a meta analysis."),
  ];
  items[1].payload.frontmatter.description = "Resolves a claim to the source span it quotes verbatim.";
  items[2].payload.frontmatter.description = "Counts the forest plots a meta analysis produced.";
  const pairs = candidatePairs(items);
  assert.ok(pairs.some((pair) => pair.a === "m1" && pair.b === "m2"), "the two claim methods share vocabulary");
  assert.ok(!pairs.some((pair) => pair.b === "m3" && pair.a === "m1"), "an unrelated method is not paired");

  // Disjointness: one method may not be in two groups on the same night.
  const groups = groupPairs([
    { a: "a", b: "b", overlap: 5 },
    { a: "b", b: "c", overlap: 4 },
    { a: "d", b: "e", overlap: 3 },
  ]);
  const seen = groups.flat();
  assert.equal(new Set(seen).size, seen.length, "a method appears in at most one group");
  assert.deepEqual(groups[0].sort(), ["a", "b", "c"]);
  assert.equal(groupPairs([{ a: "a", b: "b", overlap: 1 }], { maxGroups: 0 }).length, 0);
});

test("a rewrite that drops a verification item is refused, and the refusal is a notice", async () => {
  const items = [doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")];
  const learning = fakeLearning(items);
  /** @type {any[]} */
  const notices = [];
  const shrunk = SECTIONS().replace("- The numbers were swept.\n", "");
  const { instance } = consolidation({
    learning,
    notifications: { async create(userId, input) { notices.push(input); return input; } },
    readResult: async (identity) => ({
      status: "succeeded",
      output: identity.dispatchId.includes("build")
        ? { methods: [{ id: "m1", skill: renderMethodSkill(frontmatter("resolve-claim-span"), shrunk) }] }
        : { relations: [], assignments: [{ ASSIGNMENT: "g1", relationType: "subset", SKILLS: ["m1", "m2"] }] },
    }),
  });
  await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(learning.amendments, [], "the shrunken rewrite was never written");
  assert.ok(notices.some((notice) => /verification or constraint/.test(notice.body)), notices.map((n) => n.body).join(" | "));
});

test("a rewrite that only grows the checks is accepted", async () => {
  const items = [doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")];
  const learning = fakeLearning(items);
  const grown = SECTIONS("- Never invent a span.");
  const { instance } = consolidation({
    learning,
    readResult: async (identity) => ({
      status: "succeeded",
      output: identity.dispatchId.includes("build")
        ? { methods: [{ id: "m1", skill: renderMethodSkill(frontmatter("resolve-claim-span"), grown) }] }
        : { relations: [], assignments: [{ ASSIGNMENT: "g1", relationType: "subset", SKILLS: ["m1", "m2"] }] },
    }),
  });
  await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.equal(learning.amendments.length, 1);
  assert.match(learning.amendments[0].input.body, /Never invent a span/);
  assert.equal(learning.amendments[0].input.provenance.consolidatedBy, "consolidate:job_1");
});

test("the two model steps run as separate bounded runs, in order, with the capability's own actions", async () => {
  const learning = fakeLearning([doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")]);
  const { instance, dispatched } = consolidation({
    learning,
    readResult: async () => ({ status: "succeeded", output: { relations: [], assignments: [{ ASSIGNMENT: "g1", relationType: "merge", SKILLS: ["m1", "m2"] }] } }),
  });
  await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.equal(dispatched.length, 2, "decide then build");
  assert.deepEqual(dispatched.map((call) => call.input.action), ["decide", "build"]);
  assert.deepEqual(new Set(dispatched.map((call) => call.capabilityId)), new Set(["method-relations"]));
  assert.deepEqual(new Set(dispatched.map((call) => call.contractKind)), new Set(["method-relations"]));
  // The decide step sees the bodies; the build step sees the assignments it may not change.
  assert.ok(dispatched[0].input.methods.every((entry) => typeof entry.body === "string"));
  assert.deepEqual(dispatched[1].input.assignments, [{ ASSIGNMENT: "g1", relationType: "merge", SKILLS: ["m1", "m2"] }]);
});

test("a candidate that has earned an evaluation is queued for one instead of being promoted", async () => {
  const passing = doc("m1", "resolve-claim-span");
  passing.payload.learning = {
    digest: passing.payload.contentDigest,
    counts: {},
    observations: [1, 2, 3].map((index) => ({ runId: `r${index}`, family: `f${index}`, outcome: "accepted", at: "2026-09-06T00:00:00.000Z" })),
    relations: [], evaluations: [], level: 0,
  };
  const learning = fakeLearning([passing, doc("m2", "resolve-claim-anchor")]);
  /** @type {any[]} */
  const enqueued = [];
  const { instance } = consolidation({
    learning,
    jobs: { async enqueue(userId, kind, payload, options) { enqueued.push({ kind, payload, options }); return { id: "j" }; } },
    readResult: async () => ({ status: "succeeded", output: { relations: [], assignments: [] } }),
  });
  const summary = await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(summary.promoted, []);
  assert.ok(summary.queuedForEvaluation.includes("m1"));
  assert.equal(enqueued[0].kind, "consolidate");
  assert.equal(enqueued[0].payload.action, "evaluate");
  assert.match(enqueued[0].options.idempotencyKey, /^consolidate:evaluate:m1:sha256:/);
});

test("an evaluate job without a runner fails by name rather than quietly succeeding", async () => {
  const learning = fakeLearning([doc("m1", "resolve-claim-span")]);
  const { instance } = consolidation({ learning });
  await assert.rejects(
    () => instance.run({ job: { id: "j", userId: "u1", payload: { action: "evaluate", methodId: "m1" } } }),
    (error) => error.code === "method_evaluation_unavailable",
  );
});

test("integrate looks at a bounded neighbourhood, never the whole library", async () => {
  const items = [doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")];
  for (let index = 3; index < 30; index += 1) items.push(doc(`m${index}`, `unrelated-method-${index}`, "Something else entirely."));
  for (const item of items.slice(2)) item.payload.frontmatter.description = `Counts widgets number ${item.id}.`;
  const learning = fakeLearning(items);
  const { instance, dispatched } = consolidation({
    learning,
    readResult: async () => ({ status: "succeeded", output: { relations: [], assignments: [] } }),
  });
  const summary = await instance.integrate({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "integrate", methodId: "m1" } } });
  assert.ok(summary.neighbours <= 7, `${summary.neighbours} neighbours is not a bounded neighbourhood`);
  assert.ok(dispatched[0].input.methods.length <= 8);
});

test("optimize stages nothing from the control plane, and says why", async () => {
  const { instance } = consolidation({ learning: fakeLearning([]) });
  const result = await instance.optimize({ job: { payload: { action: "optimize", capabilityId: "meta-analysis" } } });
  assert.equal(result.staged, false);
  assert.match(result.reason, /open-method-pr/);
  await assert.rejects(
    () => instance.optimize({ job: { payload: { action: "optimize" } } }),
    (error) => error.code === "consolidate_payload_invalid",
  );
});

test("a library too small to compare does nothing and spends nothing", async () => {
  const { instance, dispatched } = consolidation({ learning: fakeLearning([doc("m1", "only-method")]) });
  const summary = await instance.sleep({ job: { id: "j", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(dispatched, []);
  assert.equal(summary.groups, 0);
});
