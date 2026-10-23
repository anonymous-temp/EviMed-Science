// Learning evidence against the real tables (2026-10-23): the vocabularies a deployed database must learn, the queries that decide "clean", and the
// settle job that rides the product queue.
//
// What only a database answers: the CHECK lists of `feedback_events` (a trigger and a subject type the code adds) and of `jobs` (a kind it adds)
// on a table a previous release created, the `NOT EXISTS` that keeps a corrected run out of every family however late the correction came, the
// `DISTINCT ON` that counts a run once, the `ON CONFLICT` that makes one reaction one row, and `run_after` / `bringForward`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FeedbackEvents } from "../src/feedbackEvents.mjs";
import { LearningEvidence, settleKeyFor } from "../src/learningEvidence.mjs";
import { FEEDBACK_EVENT_TRIGGERS, FEEDBACK_SUBJECT_TYPES, PRODUCT_JOB_KINDS, migrateProductStore } from "../src/productPersistence.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { learningEvidenceReport } from "../../../scripts/ops/learning-evidence-report.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 30_000 };
const owner = `evidence_${randomUUID().replaceAll("-", "")}`;
const stranger = `evidence_${randomUUID().replaceAll("-", "")}`;
const PROJECT = "evidence_project";
const list = (/** @type {readonly string[]} */ words) => words.map((word) => `'${word}'`).join(",");
/** @type {any} */ let database;
/** @type {FeedbackEvents} */ let feedback;
/** @type {ProductJobs} */ let jobs;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  await migrateProductStore(database);
  for (const id of [owner, stranger]) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Learning evidence','development')", [id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Evidence',1048576)", [owner, PROJECT]);
  feedback = new FeedbackEvents({ database });
  jobs = new ProductJobs(database);
});

after(async () => {
  if (!url) return;
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id = ANY($1)", [[owner, stranger]]).catch(() => {});
  await database.query("DELETE FROM evimed_control.projects WHERE user_id = $1", [owner]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1)", [[owner, stranger]]).catch(() => {});
  await database.close?.();
});

const at = (/** @type {number} */ minutes) => new Date(Date.UTC(2026, 9, 23, 10, minutes)).toISOString();
const shape = [{ format: "docx", labels: ["summary", "findings", "next steps"] }];
/** @param {string} runId @param {Record<string, any>} detail @param {string} [key] */
const record = (runId, detail, key = "k", userId = owner) => feedback.recordLearningEvidence(userId, { runId, key, projectId: userId === owner ? PROJECT : null, detail: { at: at(0), scope: "conversation", sessionId: "ses_1", ...detail } });

test("a table written before learning evidence existed takes the trigger, the subject type and the job kind after the migration, and again harmlessly", options, async () => {
  const oldTriggers = FEEDBACK_EVENT_TRIGGERS.filter((word) => word !== "learning-evidence");
  const oldSubjects = FEEDBACK_SUBJECT_TYPES.filter((word) => word !== "run");
  const oldKinds = PRODUCT_JOB_KINDS.filter((word) => word !== "learning-evidence");
  assert.equal(oldTriggers.length, FEEDBACK_EVENT_TRIGGERS.length - 1);
  assert.equal(oldSubjects.length, FEEDBACK_SUBJECT_TYPES.length - 1);
  assert.equal(oldKinds.length, PRODUCT_JOB_KINDS.length - 1);
  await database.query(`ALTER TABLE evimed_product.feedback_events DROP CONSTRAINT feedback_events_trigger_check;
    ALTER TABLE evimed_product.feedback_events ADD CONSTRAINT feedback_events_trigger_check CHECK (trigger_kind IN (${list(oldTriggers)})) NOT VALID;
    ALTER TABLE evimed_product.feedback_events DROP CONSTRAINT feedback_events_subject_check;
    ALTER TABLE evimed_product.feedback_events ADD CONSTRAINT feedback_events_subject_check CHECK (subject_type IN (${list(oldSubjects)})) NOT VALID;
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${list(oldKinds)})) NOT VALID`);
  await assert.rejects(record("run_before", { evidence: "steer", quote: "再短一点" }), /feedback_events_(trigger|subject)_check|violates check constraint/, "the table as the last release wrote it refuses the event");
  await assert.rejects(jobs.enqueue(owner, "learning-evidence", { runId: "r" }, { idempotencyKey: `before-${randomUUID()}` }), /product_jobs_kind_check/);

  for (let pass = 0; pass < 2; pass += 1) await migrateProductStore({ transaction: (/** @type {any} */ operation) => database.transaction(operation) });

  const written = await record("run_after", { evidence: "steer", quote: "再短一点" });
  assert.equal(written.created, true);
  assert.equal((await jobs.enqueue(owner, "learning-evidence", { runId: "r" }, { idempotencyKey: `after-${randomUUID()}`, runAfter: new Date(Date.now() + 86_400_000) })).kind, "learning-evidence");
  await assert.rejects(database.query("INSERT INTO evimed_product.feedback_events(id,user_id,trigger_kind,subject_type,subject_id,occurred_at) VALUES($1,$2,'not-a-trigger','run','r',now())", [`x-${randomUUID()}`, owner]),
    /feedback_events_trigger_check/, "still a closed vocabulary");
});

test("one reaction is one row; the account's listing does not carry the loop's evidence unless it is asked for by name; one account never reads another's", options, async () => {
  const first = await record("run_one", { evidence: "follow-up", verdict: "correction", rule: "每节只写三行", quote: "不对，每节只要三行", at: at(1) }, "req_1");
  const again = await record("run_one", { evidence: "follow-up", verdict: "correction", rule: "每节只写三行", quote: "不对，每节只要三行", at: at(1) }, "req_1");
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.event.id, first.event.id);
  await record("run_one", { evidence: "follow-up", verdict: "none", at: at(3) }, "req_2");

  const all = await feedback.list(owner, { limit: 200 });
  assert.ok(all.items.every((event) => event.trigger !== "learning-evidence"), "the memory timeline and activity list the newest 200: evidence must not push their rows out");
  const named = await feedback.list(owner, { trigger: "learning-evidence", limit: 200 });
  assert.ok(named.items.length >= 2);
  const ofRun = await feedback.learningEvidenceOf(owner, "run_one");
  assert.deepEqual(ofRun.map((event) => [event.detail.evidence, event.detail.verdict]), [["follow-up", "correction"], ["follow-up", "none"]]);
  assert.equal(ofRun[0].subject.type, "run");
  assert.deepEqual((await feedback.learningEvidenceOf(stranger, "run_one")), []);
  await assert.rejects(record("run_bad", { evidence: "applause" }), /closed kinds and verdicts/);
});

test("the clean runs of a scope in a window are the ones nobody corrected, however late, each once, with the shape of what they left", options, async () => {
  const scope = `scope_${randomUUID().slice(0, 8)}`;
  const base = { scope };
  // Clean: settled in silence, and accepted on the next turn.
  await record("c_silent", { ...base, evidence: "silent", shape, at: at(5) });
  await record("c_accept", { ...base, evidence: "follow-up", verdict: "accept", shape, at: at(10) }, "t1");
  await record("c_new_question", { ...base, evidence: "follow-up", verdict: "none", shape, at: at(12) }, "t2");
  // Silent twice (two settle attempts under different keys) is still one run.
  await record("c_silent", { ...base, evidence: "silent", shape, at: at(6) }, "again");
  // Not clean: a steer, a follow-up that corrected it, and a result corrected long after the silence.
  await record("x_steer", { ...base, evidence: "steer", quote: "再短一点" });
  await record("x_follow", { ...base, evidence: "follow-up", verdict: "preference", rule: "以后用表格", quote: "以后用表格" }, "t3");
  await record("x_late", { ...base, evidence: "silent", shape, at: at(15) });
  await record("x_late", { ...base, evidence: "result-corrected", quote: "把第二节删掉", at: at(55) }, "later");
  await record("x_follow_then_silent", { ...base, evidence: "silent", shape, at: at(16) });
  await record("x_follow_then_silent", { ...base, evidence: "follow-up", verdict: "rejection", rule: "重做", quote: "重做" }, "t4");
  // Not in the family: another scope, no shape, outside the window, another account.
  await record("o_scope", { scope: `${scope}_other`, evidence: "silent", shape, at: at(7) });
  await record("o_no_shape", { ...base, evidence: "silent", at: at(8) });
  await record("o_early", { ...base, evidence: "silent", shape, at: "2026-10-01T10:00:00.000Z" });
  await record("o_stranger", { ...base, evidence: "silent", shape, at: at(9) }, "k", stranger);

  const window = { scope, from: new Date(Date.UTC(2026, 9, 23)), to: new Date(Date.UTC(2026, 9, 24)) };
  const family = await feedback.cleanSettledRuns(owner, window);
  assert.deepEqual(family.map((member) => member.runId), ["c_silent", "c_accept", "c_new_question"], "oldest first, each run once");
  assert.equal(family[0].projectId, PROJECT, "each with the project its transcript is in");
  assert.deepEqual(family[0].shape, shape);
  assert.equal(family[1].at, new Date(at(10)).toISOString());
  assert.deepEqual((await feedback.cleanSettledRuns(stranger, window)).map((member) => member.runId), ["o_stranger"]);
  assert.deepEqual(await feedback.cleanSettledRuns(owner, { ...window, scope: "no-such-scope" }), []);
  assert.deepEqual((await feedback.cleanSettledRuns(owner, { ...window, limit: 2 })).map((member) => member.runId), ["c_accept", "c_new_question"], "the newest of the family when it is bounded");

  // The operator's report reads the same rows: this account, once, with what it left and when.
  const [mine, ...others] = await learningEvidenceReport(database, { user: owner, now: new Date("2026-10-23T12:00:00.000Z") });
  assert.deepEqual(others, []);
  assert.equal(mine.user, owner);
  assert.equal(mine.lastEvidenceAt, new Date(at(55)).toISOString());
  assert.ok(mine.evidence7d.silent >= 4 && mine.evidence7d["follow-up"] >= 4 && mine.evidence7d["result-corrected"] >= 1);
  assert.ok(mine.corrections30d >= 5, "the steer, the corrected follow-ups and the result corrected");
});

test("a delivery is settled by the product queue: not before its window closes, at once when the next turn brings it forward, and a routine follows the third clean run", options, async () => {
  const scope = "conversation";
  /** @type {any[]} */ const lessons = [];
  const runs = [];
  const triggers = { refusalFor: async () => null, queue: async (_project, _run, lesson) => { lessons.push(lesson); return true; }, afterCorrection: async () => ({ queued: [] }), guestInfluenced: async () => false };
  const finishedAgo = (/** @type {number} */ minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const delivery = (/** @type {string} */ id, /** @type {number} */ minutesAgo) => ({ id, sessionId: `ses_${id}`, status: "succeeded", effectiveAgentId: "open-domain-answer", outputFiles: ["report/weekly.docx"], finishedAt: finishedAgo(minutesAgo), startedAt: finishedAgo(minutesAgo + 5) });
  const evidence = new LearningEvidence({
    feedback, jobs, agentRuns: { list: async () => runs }, triggers: () => triggers, judge: null, resolveProject: async () => ({ id: PROJECT, userId: owner }),
    readShapes: async () => ({ "report/weekly.docx": shape[0] }), now: () => new Date(),
  });

  // Two clean runs of the same shape settled earlier in this period, then a third that finished a minute ago.
  const earlier = [delivery("s_run_a", 90), delivery("s_run_b", 80)];
  const third = delivery("s_run_c", 1);
  runs.push(...earlier, third);
  for (const run of earlier) await record(run.id, { evidence: "silent", shape, scope, at: new Date().toISOString() }, "settled");

  const due = await jobs.enqueue(owner, "learning-evidence", { runId: third.id, sessionId: third.sessionId }, { idempotencyKey: settleKeyFor(third.id), projectId: PROJECT, runAfter: new Date(Date.now() + 29 * 60_000) });
  assert.equal(await jobs.claim(["learning-evidence"], `w-${randomUUID()}`), null, "not before its window closes");
  assert.equal(await jobs.bringForward(owner, settleKeyFor(third.id)), true, "the next turn's reaction settles it at once");
  const claimed = await jobs.claim(["learning-evidence"], `w-${randomUUID()}`);
  assert.equal(claimed?.id, due.id);
  const result = await evidence.settle({ job: claimed });
  assert.deepEqual(result, { jobCompleted: true, settled: "silent", routine: true });
  await jobs.finish(owner, claimed.id, claimed.leaseToken, result);
  assert.equal(lessons.length, 1);
  assert.deepEqual(lessons[0].payload.peers.map((peer) => [peer.runId, peer.projectId]), [["s_run_a", PROJECT], ["s_run_b", PROJECT]]);
  assert.equal(lessons[0].idempotencyKey, `distill:${third.id}:routine`);
});
