// What the hourly pass does, and says it did, over a library kept by the real ledger.
//
// On production the pass ran 705 times in thirty days and returned `groups: 1, builds: 0, relations: 0` every time, as a success:
// one merge nobody had opened held its whole group, the group counted as formed, and nothing said it had been skipped. These tests
// keep a library in the real `LearningService` over the in-memory ledger (so a revision conflict here is the one Postgres would
// raise), stub only the model steps and the embedder, and assert what the pass wrote and what its result and counters say.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, renderMethodSkill } from "@evimed/domain";

import { LearningService, learnedMethodId } from "../src/learningService.mjs";
import { DECIDE_VERSION, MethodConsolidation, groupKey, resolveAssignments } from "../src/methodConsolidation.mjs";
import { createMethodSimilarity } from "../src/methodSimilarity.mjs";
import { LearningMetrics } from "../src/learningMetrics.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const NOW = new Date("2026-10-23T00:00:00.000Z");

/** @param {string} extra @param {string} [purpose] */
const sections = (extra = "", purpose = "Do a thing.") => [
  "## Purpose", purpose, "",
  "## When to Use", "When needed.", "",
  "## Inputs", "An input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- The quote still matches its source.", "",
  "## Constraints", "- Never widen a claim.", extra, "",
  "## Output", "The thing.",
].join("\n");

/** @param {string} name @param {string} topic */
const frontmatter = (name, topic) => ({
  name,
  description: `A method about ${topic}, written for the tests. ${topic}`,
  whenToUse: `When ${topic} comes up.`,
  metadata: { role: "functional", applies_when: `${topic} exists.`, not_when: "It does not.", derived_from: "run:run_1", evimed_schema: METHOD_SKILL_SCHEMA },
});

/** A text lives on the axis its `axis-x` marker names, so two texts on one axis are close and two on different ones are not. */
const AXES = ["a", "b", "c", "d", "e", "f"];
/** @param {string} text */
const vectorOf = (text) => AXES.map((letter) => (text.includes(`axis-${letter}`) ? 1 : 0.01));

/** @param {{fail?: boolean}} [options] */
function embedder(options = {}) {
  const calls = { n: 0 };
  return { calls, embed: async (/** @type {string[]} */ texts) => { calls.n += 1; if (options.fail) throw new Error("down"); return texts.map(vectorOf); } };
}

/**
 * A ledger and a consolidation over it. `decide(input)` and `build(input)` answer the two model steps by what they were asked.
 * @param {{decide?: (input: any) => any, build?: (input: any) => any, similarity?: any, audit?: any, unusedAfterLoads?: number, now?: () => Date}} [options]
 */
function harness({ decide = () => ({ assignments: [] }), build = () => ({ revisions: [] }), similarity = undefined, audit = null, unusedAfterLoads = undefined, now = () => NOW } = {}) {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now });
  /** @type {any[]} */
  const dispatched = [];
  /** @type {Map<string, any>} */
  const inputs = new Map();
  /** @type {[string, number][]} */
  const noops = [];
  /** @type {[string, number][]} */
  const relations = [];
  /** @type {string[]} */
  const stops = [];
  const sim = similarity === undefined ? createMethodSimilarity({ embed: embedder().embed }) : similarity;
  const consolidation = new MethodConsolidation({
    learning,
    dispatch: async (request) => { dispatched.push(request); inputs.set(request.dispatchId, request.input); return { runId: `run_${request.dispatchId}`, sessionId: "s1", dispatchId: request.dispatchId }; },
    readResult: async (identity) => {
      const input = inputs.get(identity.dispatchId);
      return { status: "succeeded", output: input.action === "build" ? build(input) : decide(input) };
    },
    similarity: sim, audit,
    onNoop: (reason, count) => noops.push([reason, count ?? 1]),
    onRelation: (type, count) => relations.push([type, count ?? 1]),
    onRetirement: (code) => stops.push(code),
    unusedAfterLoads, now, wait: async () => {},
  });
  /** @param {string} name @param {string} topic @param {any} [input] */
  const make = (name, topic, input = {}) => learning.createCandidate("u1", {
    projectId: "p1", frontmatter: frontmatter(name, topic), body: sections(), provenance: { origin: "inferred", runId: "run_1" }, ...input,
  });
  /** @param {string} [id] */
  const sleep = (id = "job_1") => consolidation.sleep({ job: { id, userId: "u1", projectId: "p1", payload: { action: "sleep" } } });
  /** @param {string} methodId @param {string} [id] */
  const integrate = (methodId, id = "job_i") => consolidation.integrate({ job: { id, userId: "u1", projectId: "p1", payload: { action: "integrate", methodId } } });
  const decides = () => dispatched.filter((request) => request.input.action === "decide");
  const builds = () => dispatched.filter((request) => request.input.action === "build");
  return { documents, learning, consolidation, dispatched, noops, relations, stops, make, sleep, integrate, decides, builds };
}

/** @param {any} input a decide input @returns {string[]} the ids of its methods */
const idsOf = (input) => input.methods.map((/** @type {any} */ method) => method.id).sort();

test("an unchanged library is read once: the second pass skips its groups, dispatches nothing and says why; a changed method is one new DECIDE", async () => {
  const h = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "shared_part", REASON: "They share a step." }] }) });
  const a1 = await h.make("span-a-one", "axis-a");
  await h.make("span-a-two", "axis-a");
  await h.make("plots-b-one", "axis-b");
  await h.make("plots-b-two", "axis-b");

  const first = await h.sleep("job_1");
  assert.equal(first.shortlist.mode, "embedding");
  assert.deepEqual([first.groupsFormed, first.groups, first.skippedUnchanged], [2, 2, 0]);
  assert.equal(h.decides().length, 2, "one DECIDE per group");
  assert.equal(first.relations, 4, "each of the two groups relates its two methods both ways");
  assert.deepEqual(first.relationTypes, { shared_part: 4 });
  assert.equal(first.noGroups, false);

  const before = h.dispatched.length;
  const second = await h.sleep("job_2");
  assert.equal(h.dispatched.length, before, "no model step ran on an unchanged library");
  assert.deepEqual([second.groupsFormed, second.groups, second.skippedUnchanged, second.relations, second.builds], [2, 0, 2, 0, 0]);
  assert.ok(second.noop.includes("skipped_unchanged"));
  assert.deepEqual(h.noops.filter(([reason]) => reason === "skipped_unchanged"), [["skipped_unchanged", 2]]);

  // One method's body changes: its group is a new question and the other group is still settled.
  const current = await h.learning.getMethod("u1", a1.id);
  await h.learning.amendMethod("u1", a1.id, { expectedRevision: current.revision, frontmatter: frontmatter("span-a-one", "axis-a"), body: sections("- Never invent a span.") });
  const third = await h.sleep("job_3");
  assert.equal(h.decides().length, 3, "exactly one new DECIDE");
  assert.equal(h.dispatched.length, before + 2, "and the build that follows it, for the group that changed");
  assert.deepEqual([third.groups, third.skippedUnchanged], [1, 1]);
});

test("the stamp is the group's own: the sha256 of its sorted id@digest, at the current decide version", async () => {
  const h = harness();
  const one = await h.make("span-a-one", "axis-a");
  const two = await h.make("span-a-two", "axis-a");
  await h.sleep();
  const key = groupKey([two, one]);
  assert.equal(key, groupKey([one, two]), "the order of a listing does not change the question");
  assert.match(key, /^[0-9a-f]{64}$/);
  for (const id of [one.id, two.id]) {
    const stamped = (await h.learning.getMethod("u1", id)).payload.learning.decided;
    assert.deepEqual({ key: stamped.key, version: stamped.version }, { key, version: DECIDE_VERSION });
    assert.equal(stamped.at, NOW.toISOString());
  }
  assert.match(h.decides()[0].dispatchId, new RegExp(`^method-relations-v${DECIDE_VERSION}-`), "an answer stored before the direction fields existed is not adopted in place of a new one");
});

test("a pass over a library nothing groups says so instead of succeeding quietly", async () => {
  const h = harness();
  await h.make("span-a-one", "axis-a");
  await h.make("plots-b-one", "axis-b");
  const result = await h.sleep();
  assert.deepEqual([result.noGroups, result.groups, result.groupsFormed], [true, 0, 0]);
  assert.ok(result.shortlist.topScore !== null && result.shortlist.topScore < 0.8, "and how close the closest two were, which is what the floor is read against");
  assert.ok(result.noop.includes("no_groups"));
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.noops, [["no_groups", 1]]);

  const alone = harness();
  await alone.make("only-one", "axis-a");
  const single = await alone.sleep();
  assert.ok(single.noop.includes("too_few_methods"));
  const empty = await harness().sleep();
  assert.deepEqual([empty.noMethods, empty.noop], [true, ["no_methods"]]);
});

test("a merge nobody has proven blocks only the build of its own group: the others are decided, related and built, and the merge expires", async () => {
  const h = harness({
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "merge", REASON: "One method, written twice." }] }),
  });
  await h.make("span-a-taught", "axis-a");
  const proof = await h.make("span-a-merged", "axis-a", { provenance: { origin: "inferred", consolidatedBy: "consolidate:job_0" } });
  await h.make("plots-b-one", "axis-b");
  await h.make("plots-b-two", "axis-b");

  const result = await h.sleep("job_1");
  assert.equal(h.decides().length, 2, "both groups were read: the guard no longer stops DECIDE");
  assert.equal(result.relations, 4, "and both recorded their relations");
  assert.equal(result.blockedUnproven, 1);
  assert.equal(h.builds().length, 1, "only the group without the unproven merge was built");
  assert.deepEqual(idsOf(h.builds()[0].input), [learnedMethodId("plots-b-one"), learnedMethodId("plots-b-two")]);
  assert.ok(result.noop.includes("blocked_unproven"));
  assert.deepEqual(h.noops.find(([reason]) => reason === "blocked_unproven"), ["blocked_unproven", 1]);

  // The blocked group is not stamped (its build is still owed), so the next pass reads it again for free and says so.
  const bought = new Set(h.decides().map((request) => request.dispatchId));
  const again = await h.sleep("job_2");
  assert.deepEqual([again.groups, again.skippedUnchanged, again.blockedUnproven], [1, 1, 1]);
  assert.deepEqual(new Set(h.decides().map((request) => request.dispatchId)), bought, "the blocked group asked the same question, whose answer the run ledger adopts: nothing new was bought");

  // It expires: carried in ten answered runs and never opened.
  for (let load = 0; load < 10; load += 1) await h.learning.recordCarried("u1", proof.id);
  const expired = await h.sleep("job_3");
  assert.deepEqual(expired.stopped, [{ id: proof.id, code: "unproven_merge_expired" }]);
  assert.deepEqual(h.stops, ["unproven_merge_expired"]);
  const stopped = await h.learning.getMethod("u1", proof.id);
  assert.equal(stopped.payload.status, "retired");
  assert.match(stopped.payload.statusReason, /合并出来的.*回到上一版/s);
});

test("all six relation types are recorded, each in its direction, by id or by name, and a relation already held is not counted again", async () => {
  const h = harness({ similarity: null });
  const members = [];
  for (const name of ["m-a", "m-b", "m-c", "m-d", "m-e", "m-f"]) members.push(await h.make(name, "axis-a"));
  const [a, b, c, d, e, f] = members;
  const decided = { assignments: [
    { ASSIGNMENT: "A1", SKILLS: [a.id, b.id], RELATION_TYPE: "shared_part", REASON: "one step" },
    { ASSIGNMENT: "A2", SKILLS: [c.id, d.id], RELATION_TYPE: "subset", WIDER: c.id, REASON: "d is part of c" },
    { ASSIGNMENT: "A3", SKILLS: [e.id, f.id], RELATION_TYPE: "merge", REASON: "same method" },
    { ASSIGNMENT: "A4", SKILLS: [a.id, c.id, e.id], RELATION_TYPE: "abstract_pattern", REASON: "a pattern over peers" },
    { ASSIGNMENT: "A5", SKILLS: [b.id, f.id], RELATION_TYPE: "conflicts_with", REASON: "opposite advice" },
    // By name rather than id, and the replacing method named by name too.
    { ASSIGNMENT: "A6", SKILLS: ["m-d", "m-e"], RELATION_TYPE: "supersedes", REPLACES: "m-e", REASON: "e is the fuller treatment" },
    // A method the group does not hold, and a directed relation that names no direction: recorded by nobody.
    { ASSIGNMENT: "A7", SKILLS: [a.id, "method:learned:not-here"], RELATION_TYPE: "merge", REASON: "unknown" },
    { ASSIGNMENT: "A8", SKILLS: [a.id, d.id], RELATION_TYPE: "subset", REASON: "no direction named" },
  ] };
  /** @type {Record<string, number>} */
  const tally = {};
  const count = await h.consolidation.applyRelations({ id: "job_1", userId: "u1" }, members, decided, tally);
  assert.deepEqual(tally, { shared_part: 2, subset: 1, merge: 2, abstract_pattern: 6, conflicts_with: 2, supersedes: 1 });
  assert.equal(count, 14);
  assert.deepEqual(h.relations.reduce((total, [type, n]) => ({ ...total, [type]: (total[type] ?? 0) + n }), /** @type {Record<string, number>} */ ({})), tally);

  /** @param {string} id @returns {Promise<string[]>} */
  const held = async (id) => (await h.learning.getMethod("u1", id)).payload.learning.relations.map((/** @type {any} */ relation) => `${relation.type}>${relation.target.replace("method:learned:", "")}`).sort();
  assert.deepEqual(await held(d.id), ["subset>m-c", "supersedes>m-e"], "a subset names the wider method it is part of, and a replaced one names its replacement");
  assert.ok(!(await held(c.id)).some((entry) => entry.startsWith("subset")), "the wider method records nothing for a subset");
  assert.ok(!(await held(e.id)).some((entry) => entry.startsWith("supersedes")), "nor does the replacing one");
  assert.deepEqual((await held(f.id)).filter((entry) => entry.startsWith("merge")), ["merge>m-e"]);

  // The same answer read again adds nothing.
  const again = await h.consolidation.applyRelations({ id: "job_2", userId: "u1" }, members, decided, {});
  assert.equal(again, 0);
  assert.equal(h.relations.reduce((total, [, n]) => total + n, 0), 14, "and counts nothing");

  assert.deepEqual(resolveAssignments(members, [{ ASSIGNMENT: "X", SKILLS: ["m-a", b.id], RELATION_TYPE: "subset", WIDER: "m-b" }])[0].wider, b.id);
  assert.equal(resolveAssignments(members, [{ ASSIGNMENT: "X", SKILLS: ["m-a", b.id], RELATION_TYPE: "subset", WIDER: "m-c" }])[0].wider, null, "a wider method outside SKILLS is no direction");
});

test("a subset builds only its wider method, and a supersedes builds nothing and is not sent to the builder", async () => {
  const wider = renderMethodSkill(frontmatter("wide-a", "axis-a"), sections("- Never invent a span."));
  const narrow = renderMethodSkill(frontmatter("narrow-a", "axis-a"), sections("- Never invent a span."));
  /** @type {any} */
  let answer = {};
  const h = harness({ decide: () => answer.decide, build: () => answer.build });
  const w = await h.make("wide-a", "axis-a");
  const n = await h.make("narrow-a", "axis-a");
  answer = {
    decide: { assignments: [{ ASSIGNMENT: "A1", SKILLS: [w.id, n.id], RELATION_TYPE: "subset", WIDER: w.id, REASON: "narrow is part of wide" }] },
    build: { revisions: [
      { assignment: "A1", methodId: w.id, operation: "amend", baseDigest: w.payload.contentDigest, skill: wider },
      { assignment: "A1", methodId: n.id, operation: "amend", baseDigest: n.payload.contentDigest, skill: narrow },
    ] },
  };
  const result = await h.sleep();
  assert.equal(result.builds, 1);
  assert.match((await h.learning.getMethod("u1", w.id)).payload.body, /Never invent a span/, "the wider method was amended");
  assert.doesNotMatch((await h.learning.getMethod("u1", n.id)).payload.body, /Never invent a span/, "the narrower one was not touched at all");
  assert.deepEqual(result.promoted, [w.id], "the amended body is a new candidate, approved by the same pass once the record allows it");

  // A group that holds only a supersedes is recorded and never sent to the builder.
  const s = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "supersedes", REPLACES: idsOf(input)[0], REASON: "the fuller treatment" }] }) });
  await s.make("old-a", "axis-a");
  await s.make("new-a", "axis-a");
  const settled = await s.sleep();
  assert.equal(s.builds().length, 0);
  assert.deepEqual(settled.relationTypes, { supersedes: 1 });
  assert.deepEqual([settled.blockedUnproven, settled.builds], [0, 0]);
});

test("a method replaced by one in force and not used is stopped, and one the researcher stated is only proposed", async () => {
  const h = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "supersedes", REPLACES: learnedMethodId("new-a"), REASON: "the fuller treatment" }] }) });
  const old = await h.make("old-a", "axis-a");
  await h.make("new-a", "axis-a");
  const first = await h.sleep("job_1");
  assert.deepEqual(first.stopped, [{ id: old.id, code: "superseded" }]);
  assert.equal((await h.learning.getMethod("u1", old.id)).payload.status, "retired");
  assert.match((await h.learning.getMethod("u1", old.id)).payload.statusReason, /取代它.*已先停用/s);
  assert.deepEqual(h.stops, ["superseded"]);

  const stated = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "supersedes", REPLACES: learnedMethodId("new-a"), REASON: "the fuller treatment" }] }) });
  const mine = await stated.make("old-a", "axis-a", { provenance: { origin: "explicit" } });
  await stated.make("new-a", "axis-a");
  const proposed = await stated.sleep();
  assert.deepEqual(proposed.stopped, []);
  assert.deepEqual(proposed.retirements, [mine.id], "named on the result");
  assert.equal((await stated.learning.getMethod("u1", mine.id)).payload.status, "approved");
});

test("a library over its cap stops its least-used methods, which are restorable, and never a stated one first", async () => {
  const h = harness({ similarity: null });
  /** @type {any[]} */
  const made = [];
  for (let index = 0; index < 4; index += 1) made.push(await h.make(`method-${index}`, `axis-${AXES[index]}`));
  for (const [index, document] of made.entries()) {
    for (let open = 0; open < index; open += 1) await h.learning.recordRead("u1", document.id, "2026-10-22T00:00:00.000Z");
  }
  const documents = (await h.learning.listMethods("u1", { limit: 100 })).items;
  const proposals = await h.learning.retirementProposals("u1", { nowMs: NOW.getTime(), cap: 2 });
  const capped = proposals.filter((entry) => entry.proposal.code === "library_cap");
  assert.equal(documents.length, 4);
  assert.deepEqual(capped.map((entry) => entry.document.id).sort(), [made[0].id, made[1].id].sort(), "the two never or once opened go");
  assert.ok(capped.every((entry) => entry.proposal.immediate));
});

test("groups the pass has already read do not use up its group budget: a library whose first groups are settled still reaches the next", async () => {
  const h = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "conflicts_with", REASON: "opposite advice" }] }) });
  for (const [index, axis] of ["a", "b", "c", "d", "e", "f"].entries()) {
    await h.make(`first-${index}`, `axis-${axis}`);
    await h.make(`second-${index}`, `axis-${axis}`);
  }
  const first = await h.sleep("job_1");
  assert.deepEqual([first.groupsFormed, first.groups, first.deferredGroups], [6, 6, 0]);
  // A seventh group appears; the six settled ones are skipped for free and the new one is read in the same pass.
  const extra = createMethodSimilarity({ embed: async (texts) => texts.map((text) => (text.includes("axis-g") ? [0, 0, 0, 0, 0, 0, 1] : [...vectorOf(text), 0])) });
  h.consolidation.similarity = extra;
  await h.make("third-0", "axis-g");
  await h.make("third-1", "axis-g");
  const second = await h.sleep("job_2");
  assert.deepEqual([second.groupsFormed, second.groups, second.skippedUnchanged, second.deferredGroups], [7, 1, 6, 0]);
});

test("an unreachable embedder degrades the shortlist to shared words, and the result says which", async () => {
  const h = harness({ similarity: createMethodSimilarity({ embed: embedder({ fail: true }).embed }) });
  await h.make("span-a-one", "claim span anchoring");
  await h.make("span-a-two", "claim span anchoring");
  const result = await h.sleep();
  assert.equal(result.shortlist.mode, "lexical");
  assert.equal(result.groups, 1, "the pass still grouped by shared vocabulary");

  const none = harness({ similarity: null });
  await none.make("span-a-one", "claim span anchoring");
  await none.make("span-a-two", "claim span anchoring");
  assert.equal((await none.sleep()).shortlist.mode, "lexical");
});

test("a merge that drops a quotation its sources store is not created, and the result and the audit line say why", async () => {
  const quote = "the twelve millimetre cut-off was my own choice";
  /** @type {any[]} */
  const audited = [];
  /** @type {{ canonicalBody: string }} */
  const state = { canonicalBody: sections("", "Keep this instruction.") };
  const h = harness({
    audit: async (job, event, detail) => { audited.push({ event, detail }); },
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "merge", REASON: "One method written twice." }] }),
    build: (input) => ({ revisions: [
      { assignment: "A1", methodId: learnedMethodId("merged-a"), name: "merged-a", operation: "create", baseDigest: null, skill: renderMethodSkill(frontmatter("merged-a", "axis-a"), state.canonicalBody) },
      ...input.methods.map((/** @type {any} */ method) => ({ assignment: "A1", methodId: method.id, name: method.name, operation: "retire", baseDigest: method.digest, supersededBy: learnedMethodId("merged-a") })),
    ] }),
  });
  const one = await h.make("span-a-one", "axis-a", { body: sections("", `Always apply: ${quote}.`), provenance: { origin: "inferred", runId: "run_1", evidence: [{ runId: "run_1", seqRange: [1, 3], quote }], feedbackEventIds: ["fb_1"] } });
  await h.make("span-a-two", "axis-a", { provenance: { origin: "inferred", runId: "run_2", feedbackEventIds: ["fb_2"] } });

  const refused = await h.sleep("job_1");
  assert.equal(refused.builds, 0);
  assert.deepEqual(refused.refusals.map((entry) => [entry.methodId, entry.code, entry.dropped, entry.quotesDropped]), [[one.id, "preservation", 0, 1]]);
  assert.ok(refused.noop.includes("merge_refused"));
  assert.deepEqual(audited, [{ event: "method.merge.refused", detail: { methodId: one.id, dropped: 0, quotesDropped: 1 } }]);
  await assert.rejects(h.learning.getMethod("u1", learnedMethodId("merged-a")), { code: "method_not_found" });

  // The same merge with the quotation kept is created, and passes on the trail the sources stored.
  state.canonicalBody = sections("", `Always apply: ${quote}.`);
  const second = harness({
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "merge", REASON: "One method written twice." }] }),
    build: () => ({ revisions: [{ assignment: "A1", methodId: learnedMethodId("merged-a"), name: "merged-a", operation: "create", baseDigest: null, skill: renderMethodSkill(frontmatter("merged-a", "axis-a"), state.canonicalBody) }] }),
  });
  await second.make("span-a-one", "axis-a", { body: sections("", `Always apply: ${quote}.`), provenance: { origin: "inferred", runId: "run_1", evidence: [{ runId: "run_1", seqRange: [1, 3], quote }], feedbackEventIds: ["fb_1"] } });
  await second.make("span-a-two", "axis-a", { provenance: { origin: "inferred", runId: "run_2", feedbackEventIds: ["fb_2"] } });
  const built = await second.sleep("job_2");
  assert.equal(built.builds, 1);
  const merged = await second.learning.getMethod("u1", learnedMethodId("merged-a"));
  assert.deepEqual(merged.payload.provenance.evidence, [quote]);
  assert.deepEqual(merged.payload.provenance.feedbackEventIds.sort(), ["fb_1", "fb_2"]);
  assert.deepEqual(merged.payload.provenance.mergedFrom.map((/** @type {any} */ source) => source.methodId).sort(), [learnedMethodId("span-a-one"), learnedMethodId("span-a-two")]);
});

test("a build writes against the revision the pass's own bookkeeping left, not the one it listed with", async () => {
  // Recording a relation moves a method's revision. The build used to amend against the revision the pass began with, the write
  // conflicted, the conflict was swallowed, and the rewrite was lost: it never showed because no relation had ever been recorded.
  const grown = renderMethodSkill(frontmatter("wide-a", "axis-a"), sections("- Never invent a span."));
  /** @type {any} */
  let wider;
  const h = harness({
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "subset", WIDER: wider.id, REASON: "narrow is part of wide" }] }),
    build: () => ({ revisions: [{ assignment: "A1", methodId: wider.id, operation: "amend", baseDigest: wider.payload.contentDigest, skill: grown }] }),
  });
  wider = await h.make("wide-a", "axis-a");
  await h.make("narrow-a", "axis-a");
  const result = await h.sleep();
  assert.deepEqual([result.relations, result.builds], [1, 1], "a relation was recorded and the rewrite still landed");
  assert.match((await h.learning.getMethod("u1", wider.id)).payload.body, /Never invent a span/);
});

test("levels come from the dependency graph and are written back where they differ", async () => {
  const h = harness({ similarity: null });
  const base = await h.make("base-step", "axis-a");
  const dependent = await h.learning.createCandidate("u1", {
    projectId: "p1",
    frontmatter: { ...frontmatter("uses-base", "axis-b"), metadata: { ...frontmatter("uses-base", "axis-b").metadata, depends_on: `base-step@${base.payload.contentDigest}` } },
    body: `${sections()}\n\n[reuse method: base-step | when: always | provides: the base step]`,
    dependencies: [{ name: "base-step", digest: base.payload.contentDigest }],
    provenance: { origin: "inferred", runId: "run_1" },
  });
  assert.equal(dependent.payload.learning.level, 0, "written as 0 and never updated: what production held");
  const result = await h.sleep();
  assert.deepEqual(result.levels, { written: 1, max: 1 });
  assert.equal((await h.learning.getMethod("u1", dependent.id)).payload.learning.level, 1);
  assert.equal((await h.learning.getMethod("u1", base.id)).payload.learning.level, 0);
  const again = await h.sleep("job_2");
  assert.equal(again.levels.written, 0, "an unchanged level is not rewritten");
});

test("the incremental pass records every relation and builds shared_part and subset, but never a merge, and never under an unproven merge", async () => {
  /** @type {any[]} */
  const types = [];
  const h = harness({
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: types.shift() ?? "merge", REASON: "r" }] }),
  });
  const subject = await h.make("span-a-one", "axis-a");
  await h.make("span-a-two", "axis-a");
  types.push("merge");
  const merge = await h.integrate(subject.id, "job_i1");
  assert.deepEqual([merge.relations, merge.builds], [2, 0]);
  assert.equal(h.builds().length, 0, "a merge waits for the hourly pass, which sees the whole library");

  const sharing = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "shared_part", REASON: "r" }] }) });
  const first = await sharing.make("span-a-one", "axis-a");
  await sharing.make("span-a-two", "axis-a");
  const built = await sharing.integrate(first.id, "job_i2");
  assert.equal(sharing.builds().length, 1, "shared_part is built the moment the method is learned");
  assert.ok(built.relations === 2);

  const guarded = harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "shared_part", REASON: "r" }] }) });
  const taught = await guarded.make("span-a-one", "axis-a");
  await guarded.make("span-a-merged", "axis-a", { provenance: { origin: "inferred", consolidatedBy: "consolidate:job_0" } });
  const blocked = await guarded.integrate(taught.id, "job_i3");
  assert.deepEqual([blocked.relations, blocked.builds], [2, 0]);
  assert.equal(guarded.builds().length, 0);
  assert.ok(blocked.noop.includes("blocked_unproven"));
});

test("the counters have a closed vocabulary and appear on the scrape", () => {
  const metrics = new LearningMetrics();
  metrics.observeConsolidateNoop("skipped_unchanged", 3);
  metrics.observeConsolidateNoop("a reason nobody named");
  metrics.observeConsolidateNoop("blocked_unproven", 0);
  metrics.observeRelation("supersedes", 2);
  metrics.observeRelation("invented");
  const family = (/** @type {string} */ name) => Object.fromEntries(metrics.families().find((entry) => entry.name === name)?.series.map((series) => [Object.values(series.labels ?? {})[0], series.value]) ?? []);
  assert.equal(family("open_science_learning_consolidate_noop_total").skipped_unchanged, 3);
  assert.equal(family("open_science_learning_consolidate_noop_total").other, 1);
  assert.equal(family("open_science_learning_consolidate_noop_total").blocked_unproven, 0, "a zero is not a count");
  assert.deepEqual([family("open_science_learning_relations_total").supersedes, family("open_science_learning_relations_total").other], [2, 1]);
  assert.deepEqual(Object.keys(family("open_science_learning_relations_total")).slice(0, 6), ["shared_part", "subset", "merge", "abstract_pattern", "conflicts_with", "supersedes"]);
  for (const code of ["superseded", "unproven_merge_expired", "library_cap"]) assert.ok(code in family("open_science_learning_method_retirements_total"), code);
});
