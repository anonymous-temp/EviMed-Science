// What the researcher did after a run that opened a method reaches the method's counters (`methodAppliedOutcomes.mjs`).
// The evidence events are another package's: the rows here have the shape it writes (feedback ledger, `learning-evidence`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, methodHarmTest, mountedMethodDigest } from "@evimed/domain";

import { LearningService } from "../src/learningService.mjs";
import { createMethodAppliedOutcomes, learningPassAccounts } from "../src/methodAppliedOutcomes.mjs";
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

test("a correction that names the method, at the body the run read, is its run's reaction; an acceptance, an adoption and a file taken are a clean one, and silence is neither", async () => {
  const f = await fixture();
  f.run("run_a", [f.grade]);
  f.event("run_a", { evidence: "follow-up", verdict: "correction", rule: "shorter", quote: "不对，短一点", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] });
  f.run("run_b", [f.grade]);
  f.event("run_b", { evidence: "silent", verdict: "none", concerns: [] });
  f.run("run_c", [f.grade]);
  f.event("run_c", { evidence: "follow-up", verdict: "accept", concerns: [] });
  f.run("run_d", [f.grade]);
  f.event("run_d", { evidence: "follow-up", verdict: "none", concerns: [] });
  f.run("run_e", [f.grade]);
  f.event("run_e", { evidence: "silent", verdict: "none", concerns: [] });
  f.event("run_e", { evidence: "used", verdict: "none", concerns: [] });
  f.run("run_f", [f.grade]);
  f.event("run_f", { evidence: "follow-up", verdict: "adopt", rule: "keep", quote: "以后都这样", concerns: [] });
  const result = await f.settle.settleUser("u1");
  // run_b was left alone and run_d was answered about something else: unknown, which counts for nothing (silence is not approval).
  assert.deepEqual(result, { runs: 6, corrected: 1, clean: 3, unattributed: 0, stale: 0, failed: 0 });
  const counts = await f.counts(f.grade);
  assert.deepEqual([counts.appliedCorrected, counts.appliedClean], [1, 3]);
  assert.deepEqual(f.applied.sort(), ["clean", "clean", "clean", "corrected"]);
  assert.equal(methodHarmTest((await f.learning.getMethod("u1", f.grade.id)).payload.learning).state, "watching");
  // The same window again counts nothing twice.
  assert.deepEqual(await f.settle.settleUser("u1"), { runs: 6, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 0 });
  assert.equal((await f.counts(f.grade)).appliedClean, 3);
});

test("a steer typed into the run counts against the method the judge says it is about, exactly as a follow-up does; one it read as nothing does not", async () => {
  const f = await fixture();
  f.run("run_s1", [f.grade]);
  f.event("run_s1", { evidence: "steer", verdict: "correction", rule: "shorter", quote: "再短一点", concerns: [{ id: f.grade.id, digest: f.mounted(f.grade) }] });
  f.run("run_s2", [f.grade]);
  f.event("run_s2", { evidence: "steer", verdict: "none", quote: "顺便问下几点了", concerns: [] });
  f.event("run_s2", { evidence: "used", verdict: "none", concerns: [] });
  f.run("run_s3", [f.grade]);
  f.event("run_s3", { evidence: "steer", verdict: "correction", quote: "再加一节", concerns: [] });
  const result = await f.settle.settleUser("u1");
  assert.deepEqual(result, { runs: 3, corrected: 1, clean: 1, unattributed: 1, stale: 0, failed: 0 });
  const counts = await f.counts(f.grade);
  assert.deepEqual([counts.appliedCorrected, counts.appliedClean], [1, 1]);
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

test("a reaction that arrives after the run was used is the run's reaction, and a correction is never taken back", async () => {
  const f = await fixture();
  f.run("run_late", [f.grade]);
  f.event("run_late", { evidence: "used", verdict: "none" }, "2026-10-23T09:00:00.000Z");
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
  f.event("run_old_body", { evidence: "used", verdict: "none" });
  // A harness's run teaches nothing.
  f.run("run_driver", [f.slides], { automated: true });
  f.event("run_driver", { evidence: "used", verdict: "none" });
  // Older than the window.
  f.run("run_ancient", [f.slides]);
  f.event("run_ancient", { evidence: "used", verdict: "none" }, "2026-10-01T00:00:00.000Z");
  // And one that is good.
  f.run("run_fine", [f.slides]);
  f.event("run_fine", { evidence: "used", verdict: "none" });
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

// 2026-10-25: a run that opened one of the platform's official methods (`officialPacks.mjs`) is read the same way, and recorded in the platform's own
// record of that body — never in the account's methods, which it is not one of.
test("what the researcher did after a run that opened an official method goes to the platform's record of that body, by the same reading", async () => {
  const official = { key: "official:daily-writing:status-report", name: "official-daily-writing-status-report", sha: "a".repeat(64), digest: `sha256:${"b".repeat(64)}` };
  const events = [];
  const recorded = [];
  const runs = [
    { id: "run_x", status: "succeeded", methodsInvoked: [{ name: official.name, digest: official.digest }] },
    { id: "run_y", status: "succeeded", methodsInvoked: [{ name: official.name, digest: official.digest }] },
    { id: "run_z", status: "succeeded", methodsInvoked: [{ name: official.name, digest: `sha256:${"c".repeat(64)}` }] },
    { id: "run_w", status: "succeeded", methodsInvoked: [{ name: official.name, digest: official.digest }] },
  ];
  const event = (/** @type {string} */ runId, /** @type {any} */ detail) => events.push({ id: `e${events.length}`, userId: "u1", projectId: "p1", runId, trigger: "learning-evidence",
    subject: { type: "run", id: runId }, detail: { sessionId: "s1", at: "2026-10-23T11:00:00.000Z", ...detail }, occurredAt: "2026-10-23T11:00:00.000Z" });
  event("run_x", { evidence: "follow-up", verdict: "correction", quote: "不对", concerns: [{ id: official.key, digest: official.digest }] });
  // Silence is unknown: the clean run is one the person used (opened a delivered file), as for an account's own method.
  event("run_y", { evidence: "silent", verdict: "none", concerns: [] });
  event("run_y", { evidence: "used", verdict: "none" });
  event("run_z", { evidence: "silent", verdict: "none", concerns: [] });
  event("run_z", { evidence: "used", verdict: "none" });
  event("run_w", { evidence: "follow-up", verdict: "correction", quote: "不对", concerns: [] });
  const settle = createMethodAppliedOutcomes({
    learning: { approvedMethods: async () => [], recordApplied: async () => { throw new Error("an official method is not one of the account's"); } },
    feedback: { async list() { return { items: events, nextCursor: null }; } },
    resolveProject: async (_user, projectId) => ({ id: projectId }),
    runsOf: async () => runs,
    now: () => NOW,
    official: { methods: async () => [official], recordApplied: async (applied) => { recorded.push(applied); return { changed: true }; } },
  });
  const result = await settle.settleUser("u1");
  assert.deepEqual(result, { runs: 4, corrected: 1, clean: 1, unattributed: 1, stale: 1, failed: 0 });
  assert.deepEqual(recorded.map(({ runId, outcome }) => [runId, outcome]).sort(), [["run_x", "corrected"], ["run_y", "clean"]]);
  assert.ok(recorded.every((applied) => applied.key === official.key && applied.sha === official.sha));
});

// 2026-11-03 (audit D3, D9): the hourly pass settled only accounts holding a learned method, and only the first 200 of them, so an
// account without a method of its own never had its reactions to an official method counted. The pass now reads every account with
// evidence in the window as well, page after page; which accounts the query returns is held against the real tables in the integration test.
test("the hourly pass reads every account, page after page, and says which ones hold a library to consolidate", async () => {
  const accounts = Array.from({ length: 450 }, (_, index) => ({ user_id: `u${String(index).padStart(4, "0")}`, library: index % 3 === 0 }));
  /** @type {unknown[][]} */
  const asked = [];
  const database = { async query(/** @type {string} */ sql, /** @type {any[]} */ params) {
    asked.push(params);
    assert.match(sql, /evimed_product\.feedback_events WHERE trigger_kind=\$2 AND occurred_at >= \$3::timestamptz/);
    assert.match(sql, /WHERE user_id > \$1 GROUP BY user_id ORDER BY user_id LIMIT \$4/);
    const [after, , , limit] = params;
    return { rows: accounts.filter((row) => row.user_id > after).slice(0, limit) };
  } };
  const seen = [];
  for await (const account of learningPassAccounts(database, { now: NOW })) seen.push(account);
  assert.deepEqual(seen, accounts.map((row) => ({ userId: row.user_id, library: row.library })), "each once, in order, past the first 200");
  assert.deepEqual(asked.map(([after]) => after), ["", "u0199", "u0399"]);
  assert.ok(asked.every(([, trigger, since, limit]) => trigger === "learning-evidence" && since === new Date(NOW - 72 * 3_600_000).toISOString() && limit === 200),
    "the evidence is the settlement's own window");
  // A last page that is exactly full asks once more and stops on the empty one.
  asked.length = 0;
  accounts.length = 400;
  let count = 0;
  for await (const _account of learningPassAccounts(database, { now: NOW })) count += 1;
  assert.deepEqual([count, asked.length], [400, 3]);
});

// Review of 2026-11-03: the hourly pass reads the whole 72-hour window again, and the official record keeps 200 observations, so every run it
// had let go of was added back on every pass: 300 reactions in the window read as 400 runs at the second pass and 700 at the fifth.
test("an official body's record counts each run once however many passes read the window again, and holds every reaction the window may still read", async () => {
  const { OfficialPacks } = await import("../src/officialPacks.mjs");
  const documents = productDocumentsDouble();
  let clock = NOW;
  const packs = new OfficialPacks({ documents: /** @type {any} */ (documents), database: { query: async () => ({ rows: [] }) },
    transfers: /** @type {any} */ (null), scanner: /** @type {any} */ (null), now: () => new Date(clock) });
  const official = { key: "official:daily:weekly", name: "official-daily-weekly", sha: "e".repeat(64), digest: `sha256:${"d".repeat(64)}` };
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const runs = [];
  for (let index = 0; index < 300; index += 1) {
    const at = new Date(NOW - (60 * 60 - index * 12) * 60_000).toISOString();
    runs.push({ id: `run_${index}`, status: "succeeded", createdAt: new Date(Date.parse(at) - 120_000).toISOString(), methodsInvoked: [{ name: official.name, digest: official.digest }] });
    const detail = index % 4 === 0
      ? { evidence: "follow-up", verdict: "correction", quote: "不对", concerns: [{ id: official.key, digest: official.digest }] }
      : { evidence: "used", verdict: "none" };
    events.push({ id: `e${index}`, userId: "u1", projectId: "p1", runId: `run_${index}`, trigger: "learning-evidence", subject: { type: "run", id: `run_${index}` },
      detail: { sessionId: "s1", at, ...detail }, occurredAt: at });
  }
  /** @type {{ ensure?: boolean }[]} */ const asked = [];
  const settle = createMethodAppliedOutcomes({
    learning: { approvedMethods: async () => [], recordApplied: async () => { throw new Error("an official method is not one of the account's"); } },
    feedback: { async list(_user, { limit, cursor = null }) {
      const ordered = [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const from = cursor ? Number(cursor) : 0;
      return { items: ordered.slice(from, from + limit), nextCursor: from + limit < ordered.length ? String(from + limit) : null };
    } },
    resolveProject: async (_user, projectId) => ({ id: projectId }),
    runsOf: async () => runs,
    now: () => clock,
    official: { methods: async (_user, options) => { asked.push(options ?? {}); return [official]; }, recordApplied: (applied) => packs.recordApplied(applied) },
  });
  const record = async () => (await documents.get("evimed-evidence-center", "preferences", `official-method:daily:weekly:${official.sha.slice(0, 12)}`)).payload;
  for (let pass = 1; pass <= 5; pass += 1) {
    const result = await settle.settleUser("u1");
    assert.deepEqual([result.corrected, result.clean], pass === 1 ? [75, 225] : [0, 0], `pass ${pass}`);
    const { learning } = await record();
    const read = methodHarmTest(learning, { minAccounts: 2 });
    assert.deepEqual([read.runs, read.bad, learning.counts.appliedClean, learning.counts.appliedCorrected], [300, 75, 225, 75], `pass ${pass}`);
    clock += 3_600_000;
  }
  assert.equal((await record()).learning.observations.length, 300, "every reaction of the window is held, beyond the 200 the record keeps of older ones");
  assert.ok(asked.every((options) => options.ensure === false), "a settlement reads the copies the account holds and makes none");
});

test("an account with evidence and no method of its own or of the platform's is not walked", async () => {
  /** @type {string[]} */ const walked = [];
  const settle = createMethodAppliedOutcomes({
    learning: { approvedMethods: async () => [], recordApplied: async () => ({ changed: false }) },
    feedback: { async list() { return { items: [{ id: "e0", userId: "u1", projectId: "p1", runId: "run_a", trigger: "learning-evidence", subject: { type: "run", id: "run_a" },
      detail: { sessionId: "s1", at: "2026-10-23T11:00:00.000Z", evidence: "used", verdict: "none" }, occurredAt: "2026-10-23T11:00:00.000Z" }], nextCursor: null }; } },
    resolveProject: async (_user, projectId) => { walked.push(projectId); return { id: projectId }; },
    runsOf: async () => { walked.push("runs"); return []; },
    now: () => NOW,
    official: { methods: async () => [], recordApplied: async () => ({ changed: false }) },
  });
  assert.deepEqual(await settle.settleUser("u1"), { runs: 0, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 0 });
  assert.deepEqual(walked, []);
});
