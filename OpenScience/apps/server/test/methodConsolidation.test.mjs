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

import { CONSOLIDATE_ACTIONS, MethodConsolidation, candidatePairs, groupPairs, screenedPairs } from "../src/methodConsolidation.mjs";

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

test("a single candidate pair skips the screen, because screening one pair costs more than it saves", async () => {
  const learning = fakeLearning([doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")]);
  const { instance, dispatched } = consolidation({
    learning,
    readResult: async () => ({ status: "succeeded", output: { relations: [], assignments: [{ ASSIGNMENT: "g1", relationType: "merge", SKILLS: ["m1", "m2"] }] } }),
  });
  await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.equal(dispatched.length, 2, "decide then build, with no screen in front of them");
  assert.deepEqual(dispatched.map((call) => call.input.action), ["decide", "build"]);
  assert.deepEqual(new Set(dispatched.map((call) => call.capabilityId)), new Set(["method-relations"]));
  assert.deepEqual(new Set(dispatched.map((call) => call.contractKind)), new Set(["method-relations"]));
  // The decide step sees the bodies; the build step sees the assignments it may not change.
  assert.ok(dispatched[0].input.methods.every((entry) => typeof entry.body === "string"));
  assert.deepEqual(dispatched[1].input.assignments, [{ ASSIGNMENT: "g1", relationType: "merge", SKILLS: ["m1", "m2"] }]);
});

test("the three model steps run as separate bounded runs, in order, with the capability's own actions", async () => {
  // SCREEN was specified from the start — `candidatePairs` says in its own
  // docstring that it is not the screen, "the model does that" — and nothing
  // called it, so a lexical token overlap decided what got grouped, reasoned
  // about at DECIDE's price, and sometimes rewritten into each other.
  const learning = fakeLearning([
    doc("m1", "resolve-claim-span"),
    doc("m2", "resolve-claim-anchor"),
    doc("m3", "resolve-claim-quote"),
  ]);
  const { instance, dispatched } = consolidation({
    learning,
    readResult: async (identity) => (String(identity.dispatchId ?? "").includes("screen")
      ? { status: "succeeded", output: { pairs: [{ a: "m1", b: "m2" }] } }
      : { status: "succeeded", output: { relations: [], assignments: [{ ASSIGNMENT: "g1", relationType: "merge", SKILLS: ["m1", "m2"] }] } }),
  });
  const result = await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(dispatched.map((call) => call.input.action), ["screen", "decide", "build"]);
  assert.deepEqual(new Set(dispatched.map((call) => call.capabilityId)), new Set(["method-relations"]));

  // The screen kept one of the three pairs, so only that pair was grouped.
  assert.equal(result.screened, true);
  assert.equal(result.screenDropped, 2);
  assert.deepEqual(dispatched[1].input.methods.map((entry) => entry.id).sort(), ["m1", "m2"],
    "the pairs the screen dropped never reached the expensive step");
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

/* --------------------------------------------------------------- the SCREEN step */

test("a screen answer may only thin the shortlist it was given", () => {
  const shortlist = [
    { a: "m1", b: "m2", overlap: 5 },
    { a: "m1", b: "m3", overlap: 4 },
    { a: "m2", b: "m3", overlap: 3 },
  ];
  // Both spellings the capability may answer in, and both orders of a pair.
  assert.deepEqual(
    screenedPairs(shortlist, { pairs: [{ a: "m2", b: "m1" }, { a: { id: "m2" }, b: { id: "m3" } }] }).map((pair) => [pair.a, pair.b]),
    [["m1", "m2"], ["m2", "m3"]],
  );
  assert.deepEqual(screenedPairs(shortlist, { kept: [{ a: "m1", b: "m3" }] }).map((pair) => pair.b), ["m3"]);

  // A verdict of "not related" and no verdict at all both drop the pair: a pair
  // nobody judged is not a screened pair.
  assert.deepEqual(screenedPairs(shortlist, { pairs: [{ a: "m1", b: "m2", related: false }] }), []);
  assert.deepEqual(screenedPairs(shortlist, { pairs: [{ a: "m1", b: "m2", keep: false }] }), []);
  assert.deepEqual(screenedPairs(shortlist, {}), []);

  // And it may not invent one. A screen that could add pairs would have to see
  // every pair to be fair, which is the cost the shortlist exists to avoid.
  assert.deepEqual(screenedPairs(shortlist, { pairs: [{ a: "m9", b: "m8" }, { a: "m1", b: "m9" }] }), []);
});

test("the screen runs once for the whole shortlist, and sees names rather than bodies", async () => {
  /** @type {any[]} */
  const dispatched = [];
  const consolidation = new MethodConsolidation({
    learning: { async listMethods() { return { items: [] }; } },
    dispatch: async (input) => { dispatched.push(input); return { runId: "run_screen", sessionId: "s" }; },
    readResult: async () => ({ status: "succeeded", output: { pairs: [{ a: "m1", b: "m2" }] } }),
    jobs: { async enqueue() { return { id: "j" }; } },
  });
  const methods = ["m1", "m2", "m3"].map((id) => ({
    id,
    payload: { frontmatter: { name: id, description: `about ${id}` }, body: "SECRET BODY", contentDigest: `sha256:${"0".repeat(64)}` },
  }));
  const pairs = [{ a: "m1", b: "m2", overlap: 4 }, { a: "m1", b: "m3", overlap: 3 }];
  const screened = await consolidation.screenPairs({ userId: "u1", projectId: "p1" }, pairs, methods);

  assert.equal(dispatched.length, 1, "one run for the shortlist; a screen per pair costs more than it saves");
  assert.equal(dispatched[0].input.action, "screen");
  assert.equal(dispatched[0].input.pairs.length, 2);
  assert.ok(!JSON.stringify(dispatched[0].input).includes("SECRET BODY"),
    "the cheap step must stay cheap; bodies are DECIDE's to read");
  assert.deepEqual(screened.pairs.map((pair) => [pair.a, pair.b]), [["m1", "m2"]]);
  assert.equal(screened.screened, true);
  assert.equal(screened.dropped, 1);
});

test("a screen that could not run leaves the shortlist alone rather than emptying it", async () => {
  const methods = ["m1", "m2"].map((id) => ({ id, payload: { frontmatter: { name: id, description: id } } }));
  const pairs = [{ a: "m1", b: "m2", overlap: 4 }, { a: "m1", b: "m3", overlap: 2 }];
  for (const [label, overrides] of [
    ["dispatch throws", { dispatch: async () => { throw new Error("no runtime"); } }],
    ["no run identity", { dispatch: async () => ({}) }],
    ["run did not succeed", { readResult: async () => ({ status: "failed" }) }],
  ]) {
    const consolidation = new MethodConsolidation({
      learning: { async listMethods() { return { items: [] }; } },
      dispatch: async () => ({ runId: "r", sessionId: "s" }),
      readResult: async () => ({ status: "succeeded", output: { pairs: [] } }),
      jobs: { async enqueue() { return { id: "j" }; } },
      ...overrides,
    });
    const screened = await consolidation.screenPairs({ userId: "u1", projectId: "p1" }, pairs, methods);
    assert.deepEqual(screened.pairs, pairs, `${label}: consolidation degraded is better than a silent no-op night`);
    assert.equal(screened.screened, false, label);
  }

  // Too few pairs to be worth a run at all.
  const tiny = new MethodConsolidation({
    learning: { async listMethods() { return { items: [] }; } },
    dispatch: async () => { throw new Error("must not dispatch"); },
    readResult: async () => null,
    jobs: { async enqueue() { return { id: "j" }; } },
  });
  assert.equal((await tiny.screenPairs({ userId: "u1" }, [{ a: "m1", b: "m2", overlap: 9 }], methods)).screened, false);
});
