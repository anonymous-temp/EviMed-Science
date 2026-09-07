// The feedback ledger against the real table.
//
// Why this is a file of its own rather than a gated block at the bottom of
// `feedbackEvents.test.mjs`: `scripts/ops/test-product-state.mjs` is what runs
// the Postgres-backed suites in CI, and it collects `*.integration.test.mjs`
// and nothing else. A gated block in the unit file was the only real-database
// coverage `evimed_product.feedback_events` had and it executed nowhere — the
// unit run never supplies a URL, so it skipped, and the product-state run never
// opened the file.
//
// What only a database can answer: the DDL, the trigger and subject CHECK
// constraints, the `ON CONFLICT(id) DO NOTHING` that is the whole idempotency
// mechanism, and the cascade that takes an account's feedback with it. The
// doubles in the unit file certify none of those.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FeedbackEvents } from "../src/feedbackEvents.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const integration = { skip: !databaseUrl, timeout: 20_000 };

/** `ProductJobs`'s enqueue contract, in memory: the producer is the unit file's
 * subject, and none of the triggers below reaches it. */
class JobsDouble {
  constructor(database) {
    this.database = database;
    /** @type {any[]} */
    this.jobs = [];
  }

  async enqueue(userId, kind, payload, { idempotencyKey, projectId = null }) {
    const job = { id: `job_${this.jobs.length + 1}`, userId, kind, payload, projectId, idempotencyKey };
    this.jobs.push(job);
    return job;
  }
}

test("the feedback table is append-only, owner-scoped and refuses an unknown trigger", integration, async (t) => {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 5, databaseConnectionTimeoutMs: 2_000 });
  const userId = `fb_${randomUUID()}`;
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await database.close();
  });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Feedback','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [userId]);

  const jobs = new JobsDouble(database);
  const feedback = new FeedbackEvents({ database, jobs });
  const first = await feedback.record(userId, {
    trigger: "memory-inference-accepted", subject: { type: "memory-record", id: "record_1" },
    identity: ["4"], projectId: "default", detail: { key: "response.evidence_depth" },
  });
  assert.equal(first.created, true);
  const replay = await feedback.record(userId, {
    trigger: "memory-inference-accepted", subject: { type: "memory-record", id: "record_1" },
    identity: ["4"], projectId: "default", detail: { key: "response.evidence_depth" },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.event.id, first.event.id);
  const stored = await database.query("SELECT count(*)::integer AS count FROM evimed_product.feedback_events WHERE user_id=$1", [userId]);
  assert.equal(stored.rows[0].count, 1);

  assert.equal((await feedback.list(userId, { trigger: "memory-inference-accepted" })).items.length, 1);
  assert.equal((await feedback.list(userId, { trigger: "memory-rejected" })).items.length, 0);
  assert.equal((await feedback.list(userId, { subject: { type: "memory-record", id: "record_2" } })).items.length, 0);

  // The fourth statement, which the two filters above do not reach: reading one
  // event back by its own derived id, and only for the account that owns it.
  assert.equal((await feedback.get(userId, first.event.id))?.id, first.event.id);
  assert.equal(await feedback.get(`${userId}_other`, first.event.id), null);

  // The vocabulary is the database's too, not only the module's.
  await assert.rejects(() => database.query(`INSERT INTO evimed_product.feedback_events
    (id,user_id,project_id,run_id,trigger_kind,subject_type,subject_id,detail,occurred_at)
    VALUES ($1,$2,NULL,NULL,'user-was-happy','deliverable','x','{}'::jsonb,now())`, [`feedback:x:${randomUUID()}`, userId]));

  // Deleting the account takes its feedback with it.
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  const remaining = await database.query("SELECT count(*)::integer AS count FROM evimed_product.feedback_events WHERE user_id=$1", [userId]);
  assert.equal(remaining.rows[0].count, 0);
});
