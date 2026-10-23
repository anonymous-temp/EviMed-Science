// What the researcher did after a run that opened a method reaches the method's counters (`methodAppliedOutcomes.mjs`).
// The evidence events are another package's: the rows here have the shape it writes (feedback ledger, `learning-evidence`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, methodHarmTest, mountedMethodDigest } from "@evimed/domain";

import { LearningService } from "../src/learningService.mjs";
import { createMethodAppliedOutcomes } from "../src/methodAppliedOutcomes.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text, "utf8").digest("hex");
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const BODY = ["## Purpose", "Do a thing.", "", "## When to Use", "When it is needed.", "", "## Inputs", "A frozen input.", "", "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "", "## Constraints", "- Never do the other thing.", "", "## Output", "The thing."].join("\n");

async function fixture() {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now: () => new Date("2026-10-20T00:00:00.000Z") });
  const make = (/** @type {string} */ name) => learning.createCandidate("u1", {
    projectId: "p1", body: BODY, provenance: { origin: "inferred", runId: "run_0" },
    frontmatter: { name, description: `Does ${name} when ${name} is needed.`, whenToUse: `When ${name} is needed.`,
      metadata: { role: "functional", applies_when: "Needed.", not_when: "Not needed.", derived_from: "run:run_0", evimed_schema: METHOD_SKILL_SCHEMA } },
  });
  const grade = await make("grade-first");
  const slides = await make("slide-titles");
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const runs = [];
  const applied = [];
  const settle = createMethodAppliedOutcomes({
    learning,
    feedback: { async list(_user, { cursor = null } = {}) {
      assert.equal(cursor, null, "one page is enough here");
      return { items: [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), nextCursor: null };
    } },
    resolveProject: async (_user, projectId) => ({ id: projectId }),
    runsOf: async () => runs,
    now: () => NOW,
    onApplied: (outcome) => applied.push(outcome),
  });
  const mounted = (/** @type {any} */ method) => mountedMethodDigest(method.payload, sha256);
  const run = (/** @type {string} */ id, /** @type {any[]} */ opened, extra = {}) => runs.push({ id, status: "succeeded", methodsInvoked: opened.map((method) => ({ name: method.payload.frontmatter.name, digest: mounted(method) })), ...extra });
  const event = (/** @type {string} */ runId, /** @type {any} */ detail, at = "2026-10-23T11:00:00.000Z") => events.push({
    id: `e${events.length}`, userId: "u1", projectId: "p1", runId, trigger: "learning-evidence", subject: { type: "run", id: runId },
    detail: { sessionId: "s1", at, ...detail }, occurredAt: at,
  });
  const counts = async (/** @type {any} */ method) => (await learning.getMethod("u1", method.id)).payload.learning.counts;
  return { learning, grade, slides, events, runs, settle, applied, run, event, counts, mounted };
}

test("a correction that names the method, at the body the run read, is its run's reaction; silence and acceptance are a clean one", async () => {
  const f = await fixture();
  f.run("run_a", [f.grade]);
  f.event("run_a", { evidence: "follow-up", verdict: "correction", rule: "shorter", quote: "不对，短一点", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] });
  f.run("run_b", [f.grade]);
  f.event("run_b", { evidence: "silent", verdict: "none", concerns: [] });
  f.run("run_c", [f.grade]);
  f.event("run_c", { evidence: "follow-up", verdict: "accept", concerns: [] });
  f.run("run_d", [f.grade]);
  f.event("run_d", { evidence: "follow-up", verdict: "none", concerns: [] });
  const result = await f.settle.settleUser("u1");
  assert.deepEqual(result, { runs: 4, corrected: 1, clean: 3, unattributed: 0, stale: 0, failed: 0 });
  const counts = await f.counts(f.grade);
  assert.deepEqual([counts.appliedCorrected, counts.appliedClean], [1, 3]);
  assert.deepEqual(f.applied.sort(), ["clean", "clean", "clean", "corrected"]);
  assert.equal(methodHarmTest((await f.learning.getMethod("u1", f.grade.id)).payload.learning).state, "watching");
  // The same window again counts nothing twice.
  assert.deepEqual(await f.settle.settleUser("u1"), { runs: 4, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 0 });
  assert.equal((await f.counts(f.grade)).appliedClean, 3);
});

test("only the method named is corrected: a correction that names none leaves the run unattributed, and a method not opened is not counted", async () => {
  const f = await fixture();
  f.run("run_1", [f.grade, f.slides]);
  f.event("run_1", { evidence: "follow-up", verdict: "preference", concerns: [{ id: f.slides.id, digest: f.mounted(f.slides) }] });
  f.run("run_2", [f.grade]);
  f.event("run_2", { evidence: "follow-up", verdict: "correction", concerns: [] });
  f.run("run_3", []);
  f.event("run_3", { evidence: "follow-up", verdict: "rejection", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] });
  const result = await f.settle.settleUser("u1");
  // run_1: slides corrected; grade opened beside it but the researcher named the other, and a correction was said, so grade is unattributed.
  assert.deepEqual(result, { runs: 2, corrected: 1, clean: 0, unattributed: 2, stale: 0, failed: 0 });
  assert.deepEqual([(await f.counts(f.slides)).appliedCorrected, (await f.counts(f.slides)).appliedClean], [1, undefined]);
  assert.deepEqual([(await f.counts(f.grade)).appliedCorrected, (await f.counts(f.grade)).appliedClean], [undefined, undefined], "a missing attribution is not a clean run");
});

test("the judge may name the content digest as well as the mounted one, and a steer or a corrected result is a correction by where it happened", async () => {
  const f = await fixture();
  f.run("run_x", [f.grade]);
  f.event("run_x", { evidence: "result-corrected", verdict: "correction", concerns: [{ id: f.grade.id, digest: f.grade.payload.contentDigest }] });
  f.run("run_y", [f.grade]);
  f.event("run_y", { evidence: "steer", verdict: "correction", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] });
  assert.equal((await f.settle.settleUser("u1")).corrected, 2);
});

test("a reaction that arrives after silence is the run's reaction, and a correction is never taken back", async () => {
  const f = await fixture();
  f.run("run_late", [f.grade]);
  f.event("run_late", { evidence: "silent", verdict: "none" }, "2026-10-23T09:00:00.000Z");
  await f.settle.settleUser("u1");
  assert.equal((await f.counts(f.grade)).appliedClean, 1);
  f.event("run_late", { evidence: "follow-up", verdict: "correction", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] }, "2026-10-23T10:00:00.000Z");
  const second = await f.settle.settleUser("u1");
  assert.equal(second.corrected, 1);
  const counts = await f.counts(f.grade);
  assert.deepEqual([counts.appliedCorrected, counts.appliedClean], [1, 0]);
});

test("a method amended since the run read it, a run the platform made, an old event and a failed read are each left alone, and the rest is still settled", async () => {
  const f = await fixture();
  // Amended since: the run's digest is not the body it holds now.
  f.run("run_old_body", [f.grade]);
  f.runs.at(-1).methodsInvoked[0].digest = `sha256:${"0".repeat(64)}`;
  f.event("run_old_body", { evidence: "silent", verdict: "none" });
  // A harness's run teaches nothing.
  f.run("run_driver", [f.slides], { automated: true });
  f.event("run_driver", { evidence: "silent", verdict: "none" });
  // Older than the window.
  f.run("run_ancient", [f.slides]);
  f.event("run_ancient", { evidence: "silent", verdict: "none" }, "2026-10-01T00:00:00.000Z");
  // And one that is good.
  f.run("run_fine", [f.slides]);
  f.event("run_fine", { evidence: "silent", verdict: "none" });
  const result = await f.settle.settleUser("u1");
  assert.deepEqual(result, { runs: 2, corrected: 0, clean: 1, unattributed: 0, stale: 1, failed: 0 });
  assert.equal((await f.counts(f.slides)).appliedClean, 1);
  assert.equal((await f.counts(f.grade)).appliedClean, undefined);

  // A ledger that cannot be read is a reading that failed, not an error of the pass.
  const down = createMethodAppliedOutcomes({ learning: f.learning, feedback: { async list() { throw Object.assign(new Error("db"), { code: "feedback_event_invalid" }); } },
    resolveProject: async () => null, runsOf: async () => [] });
  assert.deepEqual(await down.settleUser("u1"), { runs: 0, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 1 });
});

test("four corrected runs of the answer line stop the method at the next pass, which is the loop this exists for", async () => {
  const f = await fixture();
  for (const index of [1, 2, 3, 4]) {
    f.run(`run_${index}`, [f.grade]);
    f.event(`run_${index}`, { evidence: "follow-up", verdict: "correction", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] }, `2026-10-23T0${index}:00:00.000Z`);
  }
  await f.settle.settleUser("u1");
  const [proposal] = await f.learning.retirementProposals("u1", { nowMs: NOW });
  assert.deepEqual({ id: proposal.document.id, code: proposal.proposal.code, immediate: proposal.proposal.immediate }, { id: f.grade.id, code: "harm", immediate: true });
});
