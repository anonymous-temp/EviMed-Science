// 2026-10-10 review M-10/M-11 (owner ruling): what a reset and a deletion promise, against a real database.
//
//   - A reset cancels the account's queued and running learning jobs, deletes its feedback events, and records the instant; a
//     conversation that ended before it is not learned from again — by extraction, by a lesson, or as a peer of a routine —
//     and is counted.
//   - Account erasure takes the retired usememos rows with it, and leaves the digests an archive is re-sealed against.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FeedbackEvents } from "../src/feedbackEvents.mjs";
import { LearningEvidence } from "../src/learningEvidence.mjs";
import { LearningTriggers } from "../src/learningTriggers.mjs";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";
import { memoryMetricFamilies, resetMemoryMetrics } from "../src/memoryMetrics.mjs";
import { resetLearnedMemory } from "../src/memoryReset.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ResearchMemoryStore, endedBeforeReset } from "../src/researchMemory.mjs";
import { eraseRetiredMemos, retiredMemosOwner } from "../src/retiredMemos.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 120_000 };

const alice = `reset_alice_${randomUUID()}`;
const bob = `reset_bob_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;
/** @type {any} */ let jobs;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,'Reset owner','development' FROM unnest($1::text[]) AS id", [[alice, bob]]);
  await migrateProductStore(database);
  await migrateNotifications(database);
  await migrateUsageLedger(database);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
  jobs = new ProductJobs(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[alice, bob]]);
  await database.close();
});
beforeEach(() => resetMemoryMetrics());

const counter = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string} */ value) =>
  memoryMetricFamilies().find((family) => family.name === name)?.series.find((item) => item.labels?.[label] === value)?.value;

/** @param {string} owner @param {string} kind @param {string} key @param {string} [status] */
async function seedJob(owner, kind, key, status = "queued") {
  const job = await jobs.enqueue(owner, kind, { seeded: key }, { idempotencyKey: `${key}:${randomUUID()}` });
  if (status === "running") {
    await database.query("UPDATE evimed_product.jobs SET status='running',lease_token='lease',lease_expires_at=clock_timestamp()+interval '10 minutes',attempts=1 WHERE id=$1", [job.id]);
  }
  return job;
}
/** @param {string} owner @param {string} trigger */
async function seedFeedback(owner, trigger = "memory-rejected") {
  const id = `feedback:${randomUUID()}`;
  await database.query(`INSERT INTO evimed_product.feedback_events(id,user_id,trigger_kind,subject_type,subject_id,detail,occurred_at)
    VALUES ($1,$2,$3,'memory-record',$4,'{}'::jsonb,clock_timestamp())`, [id, owner, trigger, `rec_${randomUUID()}`]);
  return id;
}
const jobStatus = async (/** @type {string} */ id) => (await database.query("SELECT status,lease_token FROM evimed_product.jobs WHERE id=$1", [id])).rows[0];

test("a reset cancels the account's queued and running learning jobs and deletes its feedback events, and no one else's", options, async () => {
  const queuedDistill = await seedJob(alice, "distill", "q-distill");
  const runningDistill = await seedJob(alice, "distill", "r-distill", "running");
  const queuedConsolidate = await seedJob(alice, "consolidate", "q-consolidate");
  const queuedSettle = await seedJob(alice, "learning-evidence", "q-settle");
  // Not learning: the index outbox carries a withdrawal the reset itself owes, and a notice is not a lesson.
  const outbox = await seedJob(alice, "memory-record-index", "outbox");
  const notice = await seedJob(alice, "notify", "notice");
  const bobsDistill = await seedJob(bob, "distill", "bob-distill");
  await seedFeedback(alice, "memory-rejected");
  await seedFeedback(alice, "deliverable-adopted");
  const bobsFeedback = await seedFeedback(bob);

  const removed = await resetLearnedMemory(database, alice);
  assert.equal(removed.jobs, 4);
  assert.equal(removed.feedback, 2);

  for (const job of [queuedDistill, runningDistill, queuedConsolidate, queuedSettle]) {
    const row = await jobStatus(job.id);
    assert.equal(row.status, "canceled", `${job.id} is cancelled`);
    assert.equal(row.lease_token, null, "and a worker that holds it loses the lease, so it cannot finish it");
  }
  assert.equal((await jobStatus(outbox.id)).status, "queued", "the index outbox is not a lesson");
  assert.equal((await jobStatus(notice.id)).status, "queued");
  assert.equal((await jobStatus(bobsDistill.id)).status, "queued", "another account's lessons are untouched");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.feedback_events WHERE user_id=$1", [alice])).rows[0].n, 0);
  assert.equal((await database.query("SELECT id FROM evimed_product.feedback_events WHERE id=$1", [bobsFeedback])).rowCount, 1);

  // A second reset finds nothing.
  assert.deepEqual(await resetLearnedMemory(database, alice), { methods: 0, handbooks: 0, entries: 0, jobs: 0, feedback: 0 });
});

test("the reset is an instant per account, to the millisecond, and a run is placed on one side of it", options, async () => {
  assert.equal(await store.resetInstant(alice), null, "never reset");
  const first = await store.noteReset(alice);
  assert.match(first, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(await store.resetInstant(alice), first);
  assert.equal(await store.resetInstant(bob), null, "another account has none");
  const second = await store.noteReset(alice);
  assert.ok(Date.parse(second) >= Date.parse(first), "taken again, it can only move later");
  // The switches are left as they are.
  await store.updateSettings(alice, { learningPaused: true });
  await store.noteReset(alice);
  assert.equal((await store.settings(alice)).learningPaused, true);

  const at = "2026-10-10T12:00:00.250Z";
  assert.equal(endedBeforeReset({ finishedAt: "2026-10-10T12:00:00.249Z" }, at), true);
  assert.equal(endedBeforeReset({ finishedAt: "2026-10-10T12:00:00.250Z" }, at), false, "ending at the instant is after it");
  assert.equal(endedBeforeReset({ startedAt: "2026-10-10T11:00:00Z" }, at), true, "the start stands in for a finish the ledger lacks");
  assert.equal(endedBeforeReset({}, at), false, "a run with no readable time is not placed before anything");
  assert.equal(endedBeforeReset({ finishedAt: "2020-01-01T00:00:00Z" }, null), false, "no reset, nothing is before it");
});

// ------------------------------------------------------------------ extraction

const extractionConfig = { deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro", memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 5_000 };
const run = (/** @type {string} */ id, /** @type {string} */ finishedAt) => ({ id, sessionId: `session_${id}`, mode: "open-domain", agentId: null, agentVersion: null,
  effectiveAgentId: "clinical-evidence-synthesis", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "research", model: "deepseek/deepseek-v4-pro",
  status: "succeeded", errorCode: null, artifacts: [], startedAt: finishedAt, finishedAt, durationMs: 60_000 });
const message = (/** @type {string} */ id, /** @type {string} */ text) => ({ info: { id, role: "user" }, parts: [{ type: "text", text }] });
function proposing() {
  let calls = 0;
  const fetchImpl = async (/** @type {any} */ _input, /** @type {any} */ init) => {
    calls += 1;
    const payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{
      scope: "user", kind: "preference", key: "preference.output_language", value: "回答请用中文", summary: "中文回答", origin: "explicit",
      importance: 0.7, sensitive: false, sourceRef: payload.sources[0].sourceRef, evidenceQuote: payload.sources[0].text,
    }] }) } }] });
  };
  return { fetchImpl, calls: () => calls };
}

test("extraction never learns from a conversation that ended before the reset, and counts the refusal", options, async () => {
  const owner = `${alice}_extract`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Extract owner','development')", [owner]);
  try {
    const project = { id: "prj_reset", userId: owner };
    const model = proposing();
    const intelligence = new MemoryIntelligence(extractionConfig, store, { fetchImpl: model.fetchImpl });
    const resetAt = await store.noteReset(owner);
    const before = new Date(Date.parse(resetAt) - 60_000).toISOString();
    const after = new Date(Date.parse(resetAt) + 60_000).toISOString();

    const old = await intelligence.recordRun(project, run("run_old", before), [message("m1", "回答请用中文")]);
    assert.equal(old.source, "before_reset");
    assert.equal(old.extracted, 0);
    assert.equal(model.calls(), 0, "no model call is spent on what the reset asked to forget");
    assert.deepEqual(await store.listAllRecords(owner), [], "and no record, not even the conversation's summary, is written back");
    assert.equal(counter("open_science_memory_skipped_before_reset_total", "stage", "extraction"), 1);

    const fresh = await intelligence.recordRun(project, run("run_new", after), [message("m2", "回答请用中文")]);
    assert.equal(fresh.source, "model");
    assert.equal(fresh.extracted, 1, "a conversation that ended after the reset is learned from as before");
    assert.equal(counter("open_science_memory_skipped_before_reset_total", "stage", "extraction"), 1);
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  }
});

// ------------------------------------------------------------------ the learning loop

/** @param {string} id @param {string} finishedAt @param {string} [capability] */
function ledgerRun(id, finishedAt, capability = "clinical-evidence-synthesis") {
  return { id, sessionId: `s_${id}`, status: "succeeded", effectiveAgentId: capability, artifacts: [{ path: "deliverables/a/report.md" }],
    startedAt: finishedAt, finishedAt, transcript: { completeness: "complete" }, corrections: 0 };
}

test("a lesson is not queued for a conversation that ended before the reset, and a routine does not count it as a peer", options, async () => {
  const owner = `${alice}_lessons`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Lesson owner','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'prj_lessons','Lessons',1048576)", [owner]);
  try {
    const project = { id: "prj_lessons", userId: owner };
    const resetAt = await store.noteReset(owner);
    const ms = Date.parse(resetAt);
    const at = (/** @type {number} */ offset) => new Date(ms + offset).toISOString();
    const runs = [
      ledgerRun("run_before_1", at(-3_000)), ledgerRun("run_before_2", at(-2_000)),
      ledgerRun("run_after_1", at(1_000)), ledgerRun("run_after_2", at(2_000)), ledgerRun("run_after_3", at(3_000)),
    ];
    /** @type {any[]} */ const queued = [];
    const triggers = new LearningTriggers({
      jobs: { async enqueue(_user, kind, payload, opts) { queued.push({ kind, payload, opts }); return { id: `job_${queued.length}` }; } },
      agentRuns: { async list() { return runs; }, async runWorkflowProjection() { return null; } },
      memory: store,
    });

    const old = await triggers.afterRun(project, runs[0]);
    assert.deepEqual(old, { queued: [], skipped: "before_reset" });
    assert.deepEqual(queued, [], "nothing is queued from it");
    assert.equal(counter("open_science_memory_skipped_before_reset_total", "stage", "lesson"), 1);
    const corrected = await triggers.afterCorrection(project, { runId: "run_before_1", event: { id: "ev_1", trigger: "result-corrected" } });
    assert.deepEqual(corrected, { queued: [], skipped: "before_reset" }, "nor from an old run the researcher corrects now");

    // A routine is τ clean runs of one scope and one shape (METHOD_INDUCTION_MIN_TRAJECTORIES), counted when a run is settled from the feedback
    // ledger: the two runs before the reset were settled long ago, and they are no peers of a run after it, however recently they were counted.
    const feedback = new FeedbackEvents({ database });
    const shape = [{ format: "md", labels: ["summary", "findings"] }];
    const clean = (run, evidence = "silent") => feedback.recordLearningEvidence(owner, { runId: run.id, key: "settled",
      detail: { evidence, verdict: "none", at: at(10_000), endedAt: run.finishedAt, scope: "clinical-evidence-synthesis", shape, sessionId: run.sessionId } });
    for (const run of runs.slice(0, 2)) await clean(run);
    const evidence = new LearningEvidence({
      feedback, jobs: { async enqueue() { return { id: "settle" }; } }, agentRuns: { async list() { return runs; } }, triggers: () => triggers, judge: null,
      resolveProject: async () => project, readShapes: async () => ({ "deliverables/a/report.md": shape[0] }), now: () => new Date(ms + 10_000),
    });
    const settle = (runId) => evidence.settle({ job: { userId: owner, projectId: project.id, payload: { runId } } });
    assert.deepEqual(await settle("run_before_1"), { settled: null, routine: false, skipped: "before_reset" }, "a conversation that ended before the reset is not settled for the loop");
    const first = await settle("run_after_1");
    assert.deepEqual([first.settled, first.routine], ["silent", false]);
    const second = await settle("run_after_2");
    assert.deepEqual([second.settled, second.routine], ["silent", false], "with the two before it left out the family has not reached the third run yet");
    assert.equal(counter("open_science_memory_skipped_before_reset_total", "stage", "routine_peer") >= 2, true, "the two earlier runs were left out of the family");
    const reached = await settle("run_after_3");
    assert.deepEqual([reached.settled, reached.routine], ["silent", true], "the third run after the reset completes the routine");
    const routine = queued.find((item) => item.payload.trigger === "routine");
    assert.deepEqual(routine.payload.peers.map((/** @type {{ runId: string }} */ peer) => peer.runId), ["run_after_1", "run_after_2"], "and its peers all ended after the reset");
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  }
});

// ------------------------------------------------------------------ the retired usememos store

test("an erased account's rows leave the retired usememos tables, the ledger keeps their digests, and nothing else goes", options, async () => {
  const schema = `retired_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const mine = retiredMemosOwner(alice);
  const theirs = retiredMemosOwner(bob);
  await database.query(`CREATE SCHEMA "${schema}"`);
  try {
    await database.query(`CREATE TABLE "${schema}".memory_record (id serial PRIMARY KEY, namespace text, value text)`);
    await database.query(`CREATE TABLE "${schema}".memo (id serial PRIMARY KEY, content text)`);
    await database.query(`INSERT INTO "${schema}".memory_record (namespace, value) VALUES ($1,'a1'),($1,'a2'),($2,'b1')`, [mine.namespace, theirs.namespace]);
    await database.query(`INSERT INTO "${schema}".memo (content) VALUES
      ($1),
      ($2),
      ($3),
      ($4)`, [
      `a note of Alice's\n\n#evimed-user-${mine.tag}`,
      `a note of Bob's\n\n#evimed-user-${theirs.tag}`,
      // A tag sitting inline is a tag anybody could have typed: not an owner (the import's own rule).
      `Bob quoting #evimed-user-${mine.tag} in the middle of a sentence\n\n#evimed-user-${theirs.tag}`,
      `an unowned note`,
    ]);
    await database.query("DELETE FROM evimed_memory.retired_erasures WHERE namespace=ANY($1::text[])", [[mine.namespace, theirs.namespace]]).catch(() => {});

    await store.status();
    const result = await database.transaction((/** @type {any} */ client) => eraseRetiredMemos(client, alice, { schema }));
    assert.deepEqual(result.tables, { memory_record: 2, memo: 1 });
    assert.deepEqual((await database.query(`SELECT value FROM "${schema}".memory_record ORDER BY value`)).rows.map((/** @type {any} */ row) => row.value), ["b1"]);
    assert.equal((await database.query(`SELECT count(*)::int AS n FROM "${schema}".memo`)).rows[0].n, 3, "only the note that ends in her tag");
    assert.equal(counter("open_science_retired_memos_erased_total", "table", "memory_record"), 2);
    assert.equal(counter("open_science_retired_memos_erased_total", "table", "memo"), 1);

    const ledger = await database.query("SELECT namespace, tag FROM evimed_memory.retired_erasures WHERE namespace=$1", [mine.namespace]);
    assert.deepEqual(ledger.rows, [{ namespace: mine.namespace, tag: mine.tag }], "the digests an archive is re-sealed against");
    assert.equal((await database.query("SELECT 1 FROM evimed_memory.retired_erasures WHERE namespace=$1", [theirs.namespace])).rowCount, 0);

    // Erased again, or with the tables already dropped (a deployment that ran the retirement): nothing to remove, nothing fails.
    const again = await database.transaction((/** @type {any} */ client) => eraseRetiredMemos(client, alice, { schema }));
    assert.deepEqual(again.tables, { memory_record: 0, memo: 0 });
    const gone = await database.transaction((/** @type {any} */ client) => eraseRetiredMemos(client, alice, { schema: `${schema}_missing` }));
    assert.deepEqual(gone.tables, {});
  } finally {
    await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.query("DELETE FROM evimed_memory.retired_erasures WHERE namespace=ANY($1::text[])", [[mine.namespace, theirs.namespace]]);
  }
});

test("a retired table of another shape costs that table and not the account's deletion", options, async () => {
  const schema = `retired_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const owner = retiredMemosOwner(bob);
  await database.query(`CREATE SCHEMA "${schema}"`);
  try {
    // A `memory_record` with no `namespace` column: the statement would abort the transaction without a savepoint.
    await database.query(`CREATE TABLE "${schema}".memory_record (id serial PRIMARY KEY, value text)`);
    await database.query(`CREATE TABLE "${schema}".memo (id serial PRIMARY KEY, content text)`);
    await database.query(`INSERT INTO "${schema}".memo (content) VALUES ($1)`, [`bob's note\n#evimed-user-${owner.tag}`]);
    await database.transaction(async (/** @type {any} */ client) => {
      const result = await eraseRetiredMemos(client, bob, { schema });
      assert.deepEqual(result.tables, { memo: 1 }, "the table it could not read is skipped, the other is erased");
      await client.query("SELECT 1");
    });
  } finally {
    await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.query("DELETE FROM evimed_memory.retired_erasures WHERE namespace=$1", [owner.namespace]);
  }
});
