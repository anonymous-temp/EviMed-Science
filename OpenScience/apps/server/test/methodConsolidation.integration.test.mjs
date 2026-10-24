// The hourly consolidation over the real ledger (2026-10-24).
//
// `methodConsolidationPass.test.mjs` keeps a library in the real `LearningService` over an in-memory ledger "so a revision conflict
// here is the one Postgres would raise"; this file asks Postgres. Recording a relation or a stamp moves a method's revision, a build
// has to write against the revision those left, and a merge's originals are stopped through a `supersedes` relation because the store
// refuses any other link on a retirement: each of those is a question the ledger's own revision check answers, so each runs here
// through `ProductDocuments` on a real table, with only the model steps and the embedder stubbed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { METHOD_SKILL_SCHEMA, renderMethodSkill } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LearningService, learnedMethodId } from "../src/learningService.mjs";
import { MethodConsolidation, groupKey } from "../src/methodConsolidation.mjs";
import { createMethodSimilarity } from "../src/methodSimilarity.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60_000 };
const PROJECT = "consolidation_project";
/** @type {any} */ let database;
/** @type {string[]} */ const owners = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  await migrateProductStore(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.projects WHERE user_id = ANY($1::text[])", [owners]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [owners]).catch(() => {});
  await database.close?.();
});

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

/** @param {any} input a decide input @returns {string[]} the ids of its methods */
const idsOf = (input) => input.methods.map((/** @type {any} */ method) => method.id).sort();

/**
 * A fresh account with one project, a real ledger and a consolidation over it. `decide(input)` and `build(input)` answer the two model
 * steps by what they were asked.
 * @param {{ decide?: (input: any) => any, build?: (input: any) => any }} [steps]
 */
async function harness({ decide = () => ({ assignments: [] }), build = () => ({ revisions: [] }) } = {}) {
  const owner = `consolidate_${randomUUID().replaceAll("-", "")}`;
  owners.push(owner);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Consolidation test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Consolidation',1048576)", [owner, PROJECT]);
  const documents = new ProductDocuments(database);
  const learning = new LearningService({ documents });
  /** @type {any[]} */
  const dispatched = [];
  /** @type {Map<string, any>} */
  const inputs = new Map();
  const consolidation = new MethodConsolidation({
    learning,
    dispatch: async (request) => { dispatched.push(request); inputs.set(request.dispatchId, request.input); return { runId: `run_${request.dispatchId}`, sessionId: "s1", dispatchId: request.dispatchId }; },
    readResult: async (identity) => {
      const input = inputs.get(identity.dispatchId);
      return { status: "succeeded", output: input.action === "build" ? build(input) : decide(input) };
    },
    similarity: createMethodSimilarity({ embed: async (/** @type {string[]} */ texts) => texts.map(vectorOf) }),
    wait: async () => {},
  });
  /** @param {string} name @param {string} topic @param {any} [input] */
  const make = (name, topic, input = {}) => learning.createCandidate(owner, {
    projectId: PROJECT, frontmatter: frontmatter(name, topic), body: sections(), provenance: { origin: "inferred", runId: "run_1" }, ...input,
  });
  /** @param {string} [id] */
  const sleep = (id = "job_1") => consolidation.sleep({ job: { id, userId: owner, projectId: PROJECT, payload: { action: "sleep" } } });
  const decides = () => dispatched.filter((request) => request.input.action === "decide");
  const builds = () => dispatched.filter((request) => request.input.action === "build");
  return { owner, documents, learning, consolidation, dispatched, make, sleep, decides, builds };
}

test("on a real ledger the pass relates a group, stamps it, reads an unchanged library once and a changed method as one new question", options, async () => {
  const h = await harness({ decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "shared_part", REASON: "They share a step." }] }) });
  const a1 = await h.make("span-a-one", "axis-a");
  const a2 = await h.make("span-a-two", "axis-a");
  await h.make("plots-b-one", "axis-b");
  await h.make("plots-b-two", "axis-b");

  const first = await h.sleep("job_1");
  assert.deepEqual([first.groupsFormed, first.groups, first.skippedUnchanged], [2, 2, 0]);
  assert.equal(h.decides().length, 2, "one DECIDE per group");
  assert.equal(first.relations, 4, "each group relates its two methods both ways, and every write found the revision the last one left");
  assert.equal(first.noGroups, false);
  // What the ledger holds now: the relation on the method, and the group's stamp.
  const stamped = await h.learning.getMethod(h.owner, a1.id);
  assert.deepEqual(stamped.payload.learning.relations.map((/** @type {any} */ relation) => relation.type), ["shared_part"]);
  const key = groupKey([await h.learning.getMethod(h.owner, a2.id), stamped]);
  assert.equal(stamped.payload.learning.decided.key, key, "the stamp is the sha256 of the group's sorted id@digest");
  assert.ok(stamped.revision > a1.revision, "recording moved the revision, which is why a later write must read it again");

  const before = h.dispatched.length;
  const second = await h.sleep("job_2");
  assert.equal(h.dispatched.length, before, "no model step ran on an unchanged library");
  assert.deepEqual([second.groups, second.skippedUnchanged, second.relations, second.builds], [0, 2, 0, 0]);
  assert.ok(second.noop.includes("skipped_unchanged"));

  const current = await h.learning.getMethod(h.owner, a1.id);
  await h.learning.amendMethod(h.owner, a1.id, { expectedRevision: current.revision, frontmatter: frontmatter("span-a-one", "axis-a"), body: sections("- Never invent a span.") });
  const third = await h.sleep("job_3");
  assert.equal(h.decides().length, 3, "exactly one new DECIDE");
  assert.deepEqual([third.groups, third.skippedUnchanged], [1, 1]);
});

test("on a real ledger a build lands against the revision the pass's own bookkeeping left, and levels are written back where they differ", options, async () => {
  const grown = renderMethodSkill(frontmatter("wide-a", "axis-a"), sections("- Never invent a span."));
  /** @type {any} */
  let wider;
  const h = await harness({
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "subset", WIDER: wider.id, REASON: "narrow is part of wide" }] }),
    build: () => ({ revisions: [{ assignment: "A1", methodId: wider.id, operation: "amend", baseDigest: wider.payload.contentDigest, skill: grown }] }),
  });
  wider = await h.make("wide-a", "axis-a");
  await h.make("narrow-a", "axis-a");
  const base = await h.make("base-step", "axis-c");
  const dependent = await h.learning.createCandidate(h.owner, {
    projectId: PROJECT,
    frontmatter: { ...frontmatter("uses-base", "axis-d"), metadata: { ...frontmatter("uses-base", "axis-d").metadata, depends_on: `base-step@${base.payload.contentDigest}` } },
    body: `${sections()}\n\n[reuse method: base-step | when: always | provides: the base step]`,
    dependencies: [{ name: "base-step", digest: base.payload.contentDigest }],
    provenance: { origin: "inferred", runId: "run_1" },
  });
  assert.equal(dependent.payload.learning.level, 0, "written as 0 and never updated, as on production before the pass wrote levels back");

  const result = await h.sleep();
  assert.deepEqual([result.relations, result.builds], [1, 1], "a relation was recorded and the rewrite still landed");
  assert.match((await h.learning.getMethod(h.owner, wider.id)).payload.body, /Never invent a span/);
  assert.deepEqual(result.levels, { written: 1, max: 1 });
  assert.equal((await h.learning.getMethod(h.owner, dependent.id)).payload.learning.level, 1);
  assert.equal((await h.learning.getMethod(h.owner, base.id)).payload.learning.level, 0);
  assert.equal((await h.sleep("job_2")).levels.written, 0, "an unchanged level is not rewritten");
});

test("on a real ledger a merge keeps its originals in force until the merged method has cleared the harm test, then stops them through a supersedes relation, restorably", options, async () => {
  const quote = "the twelve millimetre cut-off was my own choice";
  const canonicalId = learnedMethodId("merged-a");
  const h = await harness({
    decide: (input) => ({ assignments: [{ ASSIGNMENT: "A1", SKILLS: idsOf(input), RELATION_TYPE: "merge", REASON: "One method written twice." }] }),
    build: (input) => ({ revisions: [
      { assignment: "A1", methodId: canonicalId, name: "merged-a", operation: "create", baseDigest: null,
        skill: renderMethodSkill(frontmatter("merged-a", "axis-a"), sections("", `Always apply: ${quote}.`)) },
      ...input.methods.map((/** @type {any} */ method) => ({ assignment: "A1", methodId: method.id, name: method.name, operation: "retire", baseDigest: method.digest, supersededBy: canonicalId })),
    ] }),
  });
  const one = await h.make("span-a-one", "axis-a", { body: sections("", `Always apply: ${quote}.`),
    provenance: { origin: "inferred", runId: "run_1", evidence: [{ runId: "run_1", seqRange: [1, 3], quote }], feedbackEventIds: ["fb_1"] } });
  const two = await h.make("span-a-two", "axis-a", { provenance: { origin: "inferred", runId: "run_2", feedbackEventIds: ["fb_2"] } });
  await h.learning.approve(h.owner, one.id, { expectedRevision: one.revision });
  await h.learning.approve(h.owner, two.id, { expectedRevision: two.revision });

  const built = await h.sleep("job_1");
  assert.equal(built.builds, 1);
  const merged = await h.learning.getMethod(h.owner, canonicalId);
  assert.deepEqual(merged.payload.provenance.evidence, [{ runId: "run_1", seqRange: [1, 3], quote }], "the run and span travel with the quotation");
  assert.equal(merged.payload.provenance.pendingRetirements.length, 2, "both originals wait for the merged method's own runs");
  assert.equal((await h.learning.getMethod(h.owner, one.id)).payload.status, "approved", "the original stays in force beside a method nobody has used yet");

  // Four clean runs that opened the body it holds: the harm test reads clear, and the pass stops both originals.
  const digest = merged.payload.contentDigest;
  for (let index = 1; index <= 4; index += 1) {
    await h.learning.recordObservation(h.owner, canonicalId, { runId: `run-${index}`, family: `family-${index}`, outcome: "accepted", invoked: true, at: `2026-10-0${index}T00:00:00.000Z`, contentDigest: digest });
  }
  assert.deepEqual((await h.consolidation.completePendingMerges({ userId: h.owner })).sort(), [one.id, two.id].sort());
  for (const original of [one, two]) {
    const stopped = await h.learning.getMethod(h.owner, original.id);
    assert.equal(stopped.payload.status, "retired");
    assert.deepEqual(stopped.payload.learning.relations.filter((/** @type {any} */ relation) => relation.type === "supersedes").map((/** @type {any} */ relation) => relation.target), [canonicalId],
      "the forwarding address is a supersedes relation naming the merged method");
  }
  assert.deepEqual(await h.consolidation.completePendingMerges({ userId: h.owner }), [], "once");

  // One click gives an original back (「回到上一版」): a stopped method is a revision, and the one before it is still there.
  const stoppedOne = await h.learning.getMethod(h.owner, one.id);
  const rolled = await h.learning.rollback(h.owner, one.id, { expectedRevision: stoppedOne.revision, targetRevision: stoppedOne.revision - 1 });
  assert.equal(rolled.payload.status, "approved");
});
