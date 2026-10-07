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
      judgeService: options.judgeService ?? null,
      jobs: options.jobs ?? null,
      audit: options.audit ?? null,
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

test("a rewrite that drops a verification item is refused, and the refusal is an audit line, not an inbox item", async () => {
  const items = [doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")];
  const learning = fakeLearning(items);
  /** @type {any[]} */
  const audited = [];
  const shrunk = SECTIONS().replace("- The numbers were swept.\n", "");
  const { instance } = consolidation({
    learning,
    audit: async (job, event, detail) => { audited.push({ job: job.id, event, detail }); },
    readResult: async (identity) => ({
      status: "succeeded",
      output: identity.dispatchId.includes("build")
        ? { revisions: [{ methodId: "m1", operation: "amend", assignment: "g1", baseDigest: items[0].payload.contentDigest, skill: renderMethodSkill(frontmatter("resolve-claim-span"), shrunk) }] }
        : { relations: [], assignments: [{ ASSIGNMENT: "g1", RELATION_TYPE: "subset", SKILLS: ["m1", "m2"] }] },
    }),
  });
  await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(learning.amendments, [], "the shrunken rewrite was never written");
  // It used to be the English sentence 「A rewrite dropped 1 verification or
  // constraint item(s) and was refused.」 in the researcher's inbox.
  assert.deepEqual(audited, [{ job: "job_1", event: "method.rewrite.refused", detail: { methodId: "m1", dropped: 1 } }]);
  assert.equal("notifications" in instance, false, "the library's housekeeping has no inbox to post to (plan 2026-09-23 §5.8)");
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
        ? { revisions: [{ methodId: "m1", operation: "amend", assignment: "g1", baseDigest: items[0].payload.contentDigest, skill: renderMethodSkill(frontmatter("resolve-claim-span"), grown) }] }
        : { relations: [], assignments: [{ ASSIGNMENT: "g1", RELATION_TYPE: "subset", SKILLS: ["m1", "m2"] }] },
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
    readResult: async () => ({ status: "succeeded", output: { relations: [], assignments: [{ ASSIGNMENT: "g1", RELATION_TYPE: "merge", SKILLS: ["m1", "m2"] }] } }),
  });
  await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.equal(dispatched.length, 2, "decide then build, with no screen in front of them");
  assert.deepEqual(dispatched.map((call) => call.input.action), ["decide", "build"]);
  assert.deepEqual(new Set(dispatched.map((call) => call.capabilityId)), new Set(["method-relations"]));
  assert.deepEqual(new Set(dispatched.map((call) => call.contractKind)), new Set(["method-relations"]));
  // The decide step sees the bodies; the build step sees the assignments it may not change.
  assert.ok(dispatched[0].input.methods.every((entry) => typeof entry.body === "string"));
  assert.deepEqual(dispatched[1].input.assignments, [{ ASSIGNMENT: "g1", RELATION_TYPE: "merge", SKILLS: ["m1", "m2"] }]);
});

test("the semantic screen precedes the two bounded capability runs", async () => {
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
    judgeService: { judge: async () => ({ outcome: "settled", value: { pairs: [{ id: "1", relation: "unrelated" }, { id: "2", relation: "unrelated" }] } }) },
    readResult: async (identity) => (String(identity.dispatchId ?? "").includes("screen")
      ? { status: "succeeded", output: { pairs: [{ a: "m1", b: "m2" }] } }
      : { status: "succeeded", output: { relations: [], assignments: [{ ASSIGNMENT: "g1", RELATION_TYPE: "merge", SKILLS: ["m1", "m2"] }] } }),
  });
  const result = await instance.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(dispatched.map((call) => call.input.action), ["decide", "build"]);
  assert.deepEqual(new Set(dispatched.map((call) => call.capabilityId)), new Set(["method-relations"]));

  // The screen kept one of the three pairs, so only that pair was grouped.
  assert.equal(result.screened, true);
  assert.equal(result.screenDropped, 2);
  assert.deepEqual(dispatched[0].input.methods.map((entry) => entry.id).sort(), ["m1", "m2"],
    "the pairs the screen dropped never reached the expensive step");
});

test("the nightly pass queues no paired evaluation, whatever a method has earned", async () => {
  // Ruling of 2026-09-21: one was queued for every method and every revision —
  // a six-cell tier that can only answer `inconclusive` and a 24-cell one that
  // retired about one harmless method in six. The method's own runs decide now.
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
  assert.equal("queuedForEvaluation" in summary, false);
  assert.deepEqual(enqueued.filter((entry) => entry.payload?.action === "evaluate"), []);
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

test("optimize without its consumer fails explicitly instead of pretending to complete", async () => {
  const { instance } = consolidation({ learning: fakeLearning([]) });
  await assert.rejects(instance.optimize({ job: { payload: { action: "optimize", capabilityId: "meta-analysis" } } }),
    { code: "handbook_loop_unavailable" });
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

test("the control-plane screen sees only descriptions and preserves omitted pairs", async () => {
  const calls = [];
  const consolidation = new MethodConsolidation({ learning: {}, dispatch: async () => { throw new Error("No runtime screen"); }, readResult: async () => null,
    judgeService: { judge: async (...args) => { calls.push(args); return { outcome: "settled", value: { pairs: [{ id: "0", relation: "unrelated" }] } }; } } });
  const methods = ["m1", "m2", "m3"].map(id => ({ id, payload: { frontmatter: { name: id, description: id }, body: "PRIVATE BODY" } }));
  const pairs = [{ a: "m1", b: "m2", overlap: 4 }, { a: "m1", b: "m3", overlap: 3 }];
  const result = await consolidation.screenPairs({ userId: "u1", projectId: "p1" }, pairs, methods);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "J1");
  assert.ok(!JSON.stringify(calls).includes("PRIVATE BODY"));
  assert.deepEqual(result.pairs, [pairs[1]]);
  assert.equal(result.dropped, 1);
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

test("a pass reads the researcher's whole library, whichever project its job is filed under", async () => {
  // Methods follow the researcher (2026-09-21); a pass filed under one project
  // that read only that project's methods would never relate, promote or
  // retire the rest.
  /** @type {any[]} */
  const reads = [];
  /** @type {any[]} */
  const proposals = [];
  const consolidation = new MethodConsolidation({
    learning: {
      async listMethods(_userId, options) { reads.push(options); return { items: [] }; },
      async retirementProposals(_userId, options) { proposals.push(options); return []; },
    },
    dispatch: async () => { throw new Error("an empty library dispatches nothing"); },
    readResult: async () => null,
    jobs: { async enqueue() { return { id: "j" }; } },
  });
  await consolidation.run({ job: { id: "j1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.ok(reads.length >= 1);
  for (const options of reads) assert.equal(Object.hasOwn(options, "projectId"), false, "no project filter on the library read");
  for (const options of proposals) assert.equal(Object.hasOwn(options, "projectId"), false);
});

test("a step whose run is still working is waited for, not counted as having no answer", async () => {
  // 2026-09-21: every step read its result straight after dispatching, found
  // the run still working, and the pass finished without it while the run
  // carried on and was paid for.
  const learning = fakeLearning([doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")]);
  /** @type {Map<string, number>} */
  const reads = new Map();
  /** @type {number[]} */
  const waits = [];
  const consolidation = new MethodConsolidation({
    learning,
    dispatch: async (request) => ({ runId: `run_${request.dispatchId}`, sessionId: "s1", dispatchId: request.dispatchId }),
    readResult: async (identity) => {
      const seen = (reads.get(identity.dispatchId) ?? 0) + 1;
      reads.set(identity.dispatchId, seen);
      if (seen < 3) return { status: seen === 1 ? "pending" : "running" };
      return { status: "succeeded", output: { assignments: [{ ASSIGNMENT: "A1", SKILLS: ["m1", "m2"], RELATION_TYPE: "shared_part", REASON: "Both resolve a span." }] } };
    },
    pollMs: 7,
    wait: async (ms) => { waits.push(ms); },
    now: () => new Date("2026-09-21T00:00:00.000Z"),
  });
  const result = await consolidation.integrate({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "integrate", methodId: "m1" } } });
  assert.equal(result.relations, 2, "the answer that arrived on the third look was applied");
  assert.deepEqual([...reads.values()], [3]);
  assert.deepEqual(waits, [7, 7]);
});

test("a step that cannot start defers the pass instead of finishing it without the step", async () => {
  const learning = fakeLearning([doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor"), doc("m3", "resolve-claim-quote")]);
  for (const busyAt of ["decide", "build"]) {
    const consolidation = new MethodConsolidation({
      learning,
      dispatch: async (request) => {
        if (request.input.action === busyAt) throw Object.assign(new Error("busy"), { code: "runtime_busy" });
        return { runId: "r1", sessionId: "s1", dispatchId: request.dispatchId };
      },
      readResult: async (identity) => (String(identity.dispatchId).includes("screen")
        ? { status: "succeeded", output: { pairs: [{ a: "m1", b: "m2" }] } }
        : { status: "succeeded", output: { relations: [], assignments: [{ ASSIGNMENT: "g1", RELATION_TYPE: "merge", SKILLS: ["m1", "m2"] }] } }),
      wait: async () => {},
    });
    await assert.rejects(consolidation.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } }),
      { code: "runtime_busy" }, `busy at ${busyAt}: the worker defers the job and the pass resumes`);
  }
});

test("a step is keyed on what it reads: an unchanged group reads its answer again, a changed method is a new question", async () => {
  const ids = async (items) => {
    const { instance, dispatched } = consolidation({ learning: fakeLearning(items) });
    await instance.decideGroup({ id: "job_1", userId: "u1", projectId: "p1" }, items);
    return dispatched.map((call) => call.dispatchId);
  };
  const first = await ids([doc("m1", "resolve-claim-span"), doc("m2", "resolve-claim-anchor")]);
  assert.deepEqual(await ids([doc("m2", "resolve-claim-anchor"), doc("m1", "resolve-claim-span")]), first, "order does not matter");
  const changed = doc("m2", "resolve-claim-anchor");
  changed.payload.contentDigest = `sha256:${"f".repeat(64)}`;
  assert.notDeepEqual(await ids([doc("m1", "resolve-claim-span"), changed]), first);
});

test("a method without the researcher's line gets one at the end of the pass, and one that has it is left alone", async () => {
  // 2026-09-21: the memory page printed the model's English name and routing
  // description to a Chinese reader. A method with its line and its steps in
  // the reader's language, for the body it holds, has nothing to be asked.
  const named = doc("m2", "resolve-claim-anchor", {
    display: { title: "先锚定再改写", summary: "修报告前先把每条主张对回原文位置。" },
    displaySteps: { text: "1. 先锚定\n2. 再改写", contentDigest: `sha256:${"m2".padEnd(64, "0").slice(0, 64)}` },
  });
  const learning = fakeLearning([doc("m1", "resolve-claim-span"), named]);
  /** @type {any[]} */
  const written = [];
  /** @type {any} */ (learning).setDisplay = async (_userId, id, display) => { written.push({ id, display }); return { id }; };
  /** @type {string[]} */
  const asked = [];
  const consolidation = new MethodConsolidation({
    learning,
    dispatch: async (request) => ({ runId: "r1", sessionId: "s1", dispatchId: request.dispatchId }),
    readResult: async () => ({ status: "succeeded", output: { pairs: [] } }),
    describe: async (document) => { asked.push(document.id); return { title: "按原文锚定主张", summary: "交付前逐条把主张对回来源原文的确切位置。" }; },
    wait: async () => {},
  });
  const result = await consolidation.sleep({ job: { id: "job_1", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(asked, ["m1"], "only the method without a line is described");
  assert.deepEqual(written, [{ id: "m1", display: { title: "按原文锚定主张", summary: "交付前逐条把主张对回来源原文的确切位置。" } }]);
  assert.deepEqual(result.described, ["m1"]);
});

test("a method whose steps are not in the reader's language, or render another body, is described again", async () => {
  // 2026-09-26 audit (M-5): opening a method showed its English SKILL.md. The
  // steps are rendered beside it and name the body they render, so an amended
  // body is rendered afresh.
  const line = { title: "先锚定再改写", summary: "修报告前先把每条主张对回原文位置。" };
  const noSteps = doc("m1", "resolve-claim-span", { display: line });
  const staleSteps = doc("m2", "resolve-claim-anchor", { display: line, displaySteps: { text: "1. 旧的步骤", contentDigest: `sha256:${"f".repeat(64)}` } });
  const learning = fakeLearning([noSteps, staleSteps]);
  /** @type {string[]} */
  const asked = [];
  /** @type {any[]} */
  const written = [];
  /** @type {any} */ (learning).setDisplay = async (_userId, id, display) => { written.push({ id, display }); return { id }; };
  const consolidation = new MethodConsolidation({
    learning,
    dispatch: async (request) => ({ runId: "r1", sessionId: "s1", dispatchId: request.dispatchId }),
    readResult: async () => ({ status: "succeeded", output: { pairs: [] } }),
    describe: async (document) => { asked.push(document.id); return { ...line, steps: "1. 先锚定\n2. 再改写" }; },
    wait: async () => {},
  });
  await consolidation.sleep({ job: { id: "job_2", userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  assert.deepEqual(asked.sort(), ["m1", "m2"]);
  assert.ok(written.every((entry) => entry.display.steps === "1. 先锚定\n2. 再改写"));
});

test("Chinese method descriptions propose overlapping adjacent bigrams", () => {
  const items = [doc("a", "风险评估"), doc("b", "风险评价"), doc("c", "患者招募")].map(item => ({ ...item, payload: { ...item.payload, frontmatter: { name: item.payload.frontmatter.name, description: "" } } }));
  assert.deepEqual(candidatePairs(items).map(pair => [pair.a, pair.b]), [["a", "b"]]);
});

test("the method-relations contract screen selects groups using actual artifact keys", () => {
  const pairs = [{ a: "a", b: "b", overlap: 2 }, { a: "a", b: "c", overlap: 2 }];
  assert.deepEqual(screenedPairs(pairs, { schemaVersion: 1, action: "screen", screened: { selected: [{ group: "g1", methods: ["a", "b"], reason: "Shared task" }], rejected: [{ method: "c", reason: "Different" }] } }), [pairs[0]]);
});

test("J1 preserves the unjudged tail and falls back without dispatching a runtime", async () => {
  const pairs = Array.from({ length: 45 }, (_, index) => ({ a: "a", b: String(index), overlap: 2 }));
  const service = new MethodConsolidation({ learning: {}, dispatch: async () => { throw new Error("Runtime forbidden"); }, readResult: async () => null,
    judgeService: { judge: async (site, input) => { assert.equal(input.pairs.length, 40); return { outcome: "settled", value: { pairs: input.pairs.map(pair => ({ id: pair.id, relation: "unrelated" })) } }; } } });
  assert.deepEqual((await service.screenPairs({ userId: "u" }, pairs, [])).pairs, pairs.slice(40));
  service.judgeService = { judge: async () => ({ outcome: "fallback", value: null }) };
  assert.deepEqual((await service.screenPairs({ userId: "u" }, pairs, [])).pairs, pairs);
});

test("canonical creation keeps approved originals usable until already-recorded independent evidence passes", async () => {
  const source = doc("source", "source-method", { status: "approved" });
  const canonicalId = "method:learned:canonical-method";
  const assignments = [{ ASSIGNMENT: "A1", SKILLS: ["source", "other"], RELATION_TYPE: "merge", REASON: "Identical methods" }];
  const members = [source, doc("other", "other-method")];
  const rows = new Map(members.map(member => [member.id, member]));
  const retirements = [];
  const learning = { listMethods: async () => ({ items: [...rows.values()] }), getMethod: async (user, id) => {
    if (!rows.has(id)) throw Object.assign(new Error("Missing"), { code: "method_not_found" }); return rows.get(id);
  }, createCandidate: async (user, input) => {
    const canonical = doc(canonicalId, input.frontmatter.name, { ...input, status: "approved" }); rows.set(canonicalId, canonical); return canonical;
  }, retire: async (user, id, input) => { retirements.push({ id, input }); rows.get(id).payload.status = "retired"; return rows.get(id); } };
  const output = { schemaVersion: 1, action: "build", assignments, revisions: [
    { assignment: "A1", methodId: canonicalId, name: "canonical-method", operation: "create", baseDigest: null, skill: renderMethodSkill(frontmatter("canonical-method"), SECTIONS()) },
    { assignment: "A1", methodId: source.id, name: "source-method", operation: "retire", baseDigest: source.payload.contentDigest, supersededBy: canonicalId },
  ] };
  const service = new MethodConsolidation({ learning, dispatch: async request => ({ runId: "run", sessionId: "session", dispatchId: request.dispatchId }), readResult: async () => ({ status: "succeeded", output }) });
  const result = await service.buildGroup({ id: "job", userId: "user", projectId: "project" }, members, { assignments });
  assert.equal(result.applied, 1);
  assert.equal(retirements.length, 0);
  assert.equal(rows.get("source").payload.status, "approved");
  assert.equal(rows.get(canonicalId).payload.provenance.pendingRetirements.length, 1);
  assert.deepEqual(await service.completePendingMerges({ userId: "user" }), []);
  const canonical = rows.get(canonicalId);
  canonical.payload.learning.evaluations = [{ verdict: "better", candidateDigest: "different", baselineDigest: "baseline", report: {} }];
  assert.deepEqual(await service.completePendingMerges({ userId: "user" }), []);
  canonical.payload.learning.evaluations.push({ verdict: "non_inferior", candidateDigest: canonical.payload.contentDigest, baselineDigest: "baseline", report: { independentlyRecorded: true } });
  assert.deepEqual(await service.completePendingMerges({ userId: "user" }), ["source"]);
  assert.equal(retirements[0].input.link.supersededBy, canonicalId);
  assert.deepEqual(await service.completePendingMerges({ userId: "user" }), []);
});
