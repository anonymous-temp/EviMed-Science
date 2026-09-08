// The feedback ledger, and the one producer that reads it back.
//
// What these tests are for: the loop from "what the researcher did" to "what
// the system believes" had no substrate at all. Confirming a pending memory
// updated a record and wrote one audit line; nothing could count confirmations,
// tell one from an edit or a rejection, or read any of it later. So the
// assertions below are about the properties that make an event log worth
// having — an event is identified by what happened rather than by when it was
// written, replaying an action writes nothing, and a producer fires on evidence
// that is really there — not about the SQL, which
// `feedbackEvents.integration.test.mjs` exercises against a real table. That
// file is separate because `scripts/ops/test-product-state.mjs` collects
// `*.integration.test.mjs`: a Postgres-gated block down here would skip in the
// unit run and never be opened by the product-state run at all.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DISTILLATION_TRIGGERS } from "../src/methodDistillationRuns.mjs";
import {
  DISTILL_TRIGGER,
  FeedbackEvents,
  deliverableSubjectId,
  feedbackEventId,
  memoryFeedbackEvents,
} from "../src/feedbackEvents.mjs";

/**
 * The three statements `FeedbackEvents` issues, answered from a Map.
 *
 * The insert honours `ON CONFLICT(id) DO NOTHING`, because that is the whole
 * idempotency mechanism: if this double returned a row for a second insert the
 * tests below would pass with an append-only ledger that quietly rewrote
 * history.
 */
/** `(occurred_at,id) < ($1,$2)`, as Postgres compares the row tuple. */
function before([leftTime, leftId], [rightTime, rightId]) {
  return leftTime === rightTime ? leftId < rightId : leftTime < rightTime;
}

class DatabaseDouble {
  constructor() {
    /** @type {Map<string, any>} */
    this.rows = new Map();
    /** @type {string[]} */
    this.statements = [];
  }

  async query(text, values = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("INSERT INTO evimed_product.feedback_events")) {
      const [id, userId, projectId, runId, trigger, subjectType, subjectId, detail, occurredAt] = values;
      if (this.rows.has(id)) return { rows: [], rowCount: 0 };
      const row = {
        id, user_id: userId, project_id: projectId, run_id: runId, trigger_kind: trigger,
        subject_type: subjectType, subject_id: subjectId, detail: JSON.parse(String(detail)),
        occurred_at: occurredAt, recorded_at: new Date().toISOString(),
      };
      this.rows.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM evimed_product.feedback_events WHERE id=$1 AND user_id=$2")) {
      const row = this.rows.get(values[0]);
      const owned = row && row.user_id === values[1] ? [row] : [];
      return { rows: owned, rowCount: owned.length };
    }
    if (sql.startsWith("SELECT * FROM evimed_product.feedback_events WHERE user_id=$1 AND id=$2")) {
      const row = this.rows.get(values[1]);
      const owned = row && row.user_id === values[0] ? [row] : [];
      return { rows: owned, rowCount: owned.length };
    }
    if (sql.startsWith("SELECT * FROM evimed_product.feedback_events WHERE user_id=$1 AND ($2::text IS NULL")) {
      const [userId, trigger, subjectType, subjectId, limit, afterTime, afterId] = values;
      const key = (row) => [new Date(row.occurred_at).toISOString(), row.id];
      // Answered from the statement, not from the parameters: a query that
      // binds a cursor and never mentions it filters nothing, here as there.
      const keyed = sql.includes("(occurred_at,id) < ($6::timestamptz,$7::text)");
      const rows = [...this.rows.values()]
        .filter((row) => row.user_id === userId
          && (trigger == null || row.trigger_kind === trigger)
          && (subjectType == null || (row.subject_type === subjectType && row.subject_id === subjectId))
          // The keyset comparison the statement makes, spelled out: a cursor
          // that does not narrow here would not narrow against Postgres either.
          && (!keyed || afterTime == null || before(key(row), [new Date(afterTime).toISOString(), afterId])))
        .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at))
          || String(right.id).localeCompare(String(left.id)))
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction(operation) { return operation(this); }
}

/** `ProductJobs`'s enqueue/claim/finish/fail contract, in memory. */
class JobsDouble {
  constructor(database) {
    this.database = database;
    /** @type {any[]} */
    this.jobs = [];
    /** @type {Map<string, any>} */
    this.byKey = new Map();
    /** @type {any[]} */
    this.finished = [];
    /** @type {any[]} */
    this.failed = [];
  }

  async enqueue(userId, kind, payload, { idempotencyKey, projectId = null }) {
    const key = `${userId}\0${idempotencyKey}`;
    const existing = this.byKey.get(key);
    if (existing) {
      assert.deepEqual(existing.payload, payload, "the same job key must never name different work");
      return existing;
    }
    const job = { id: `job_${this.jobs.length + 1}`, userId, kind, payload, projectId, status: "queued", leaseToken: "lease" };
    this.byKey.set(key, job);
    this.jobs.push(job);
    return job;
  }

  async claim(kinds, _workerId) {
    const job = this.jobs.find((item) => kinds.includes(item.kind) && item.status === "queued");
    if (!job) return null;
    job.status = "running";
    return job;
  }

  async finish(userId, id, leaseToken, result) {
    const job = this.jobs.find((item) => item.id === id && item.userId === userId && item.leaseToken === leaseToken);
    assert.ok(job, "a worker finished a job it does not hold");
    job.status = "succeeded";
    job.result = result;
    this.finished.push({ id, result });
    return job;
  }

  async fail(userId, id, leaseToken, error, options = {}) {
    const job = this.jobs.find((item) => item.id === id && item.userId === userId && item.leaseToken === leaseToken);
    assert.ok(job, "a worker failed a job it does not hold");
    job.status = options.retry ? "queued" : "failed";
    this.failed.push({ id, error, options });
    return job;
  }
}

/** `ProductDocuments`'s get/put contract, with its optimistic revision rule. */
class DocumentsDouble {
  constructor() {
    /** @type {Map<string, any>} */
    this.docs = new Map();
    /** @type {any[]} */
    this.revisions = [];
  }

  async get(userId, kind, id) { return this.docs.get(`${userId}\0${kind}\0${id}`) ?? null; }

  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    const key = `${userId}\0${kind}\0${id}`;
    const existing = this.docs.get(key);
    if ((existing?.revision ?? 0) !== expectedRevision) {
      const error = new Error("The record changed; reload before saving.");
      /** @type {any} */ (error).code = "product_revision_conflict";
      throw error;
    }
    const document = { id, kind, projectId: existing?.projectId ?? projectId, payload, revision: expectedRevision + 1 };
    this.docs.set(key, document);
    this.revisions.push({ id, revision: document.revision, payload });
    return document;
  }
}

function fixture() {
  const database = new DatabaseDouble();
  const jobs = new JobsDouble(database);
  const documents = new DocumentsDouble();
  const feedback = new FeedbackEvents({ database, jobs, now: () => new Date("2026-09-07T08:00:00.000Z") });
  return { database, jobs, documents, feedback };
}

/** A structured memory record as the memory API hands it back. */
function memoryRecord(overrides = {}) {
  return {
    id: "record_1", scope: "user", scopeId: "", kind: "preference", key: "response.evidence_depth",
    value: "优先给原始证据", summary: "原始证据优先", origin: "inferred", status: "pending",
    confidence: 0.7, importance: 0.9, sensitive: false, version: 3, ...overrides,
  };
}

/** The digest the ledger names a memory value by, computed here independently. */
function digestOf(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

const SUBJECT = { type: "deliverable", id: deliverableSubjectId("run_1", "reports/evidence.md") };

async function adoptAndEdit(feedback, { summary = "把结论段的效应量补上了置信区间。", editDigest = "b".repeat(64) } = {}) {
  const adoption = await feedback.record("user_1", {
    trigger: "deliverable-adopted", subject: SUBJECT, projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
  });
  const edit = await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: [editDigest], projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: editDigest, summary },
  });
  return { adoption, edit };
}

test("one memory update becomes the events it actually is, and replaying it adds none", async () => {
  const { feedback, database } = fixture();
  const before = memoryRecord();
  // The confirmation path the memory route takes: pending -> active, and the
  // route rewrites origin and confidence as part of the same write.
  const after = memoryRecord({ status: "active", origin: "explicit", confidence: 1, version: 4 });

  const first = await feedback.recordMemoryUpdate("user_1", { before, after, projectId: "project_1" });
  assert.deepEqual(first.map((item) => item.event.trigger), ["memory-inference-accepted"]);
  assert.equal(first[0].created, true);
  assert.deepEqual(first[0].event.subject, { type: "memory-record", id: "record_1" });
  assert.equal(first[0].event.detail.key, "response.evidence_depth");

  // Replay. The identity is the record and the version the change produced, so
  // the same PATCH arriving twice is one event, not two.
  const replay = await feedback.recordMemoryUpdate("user_1", { before, after, projectId: "project_1" });
  assert.equal(replay[0].created, false);
  assert.equal(replay[0].event.id, first[0].event.id);
  assert.equal(database.rows.size, 1, "an append-only ledger must not grow on a replay");

  // A different decision on the same record is a different event.
  const edited = await feedback.recordMemoryUpdate("user_1", {
    before: after, after: memoryRecord({ status: "active", origin: "manual", value: "只用系统综述", version: 5 }),
    projectId: "project_1",
  });
  assert.deepEqual(edited.map((item) => item.event.trigger), ["memory-value-edited"]);
  // The two values are named by digest and never by text: this table has no
  // delete path, so a value copied into it outlives the memory the researcher
  // later deletes — the whole reason the deletion event below carries none.
  assert.deepEqual(Object.keys(edited[0].event.detail).sort(),
    ["key", "kind", "nextValueDigest", "previousValueDigest", "sensitive", "version"]);
  assert.match(edited[0].event.detail.previousValueDigest, /^[0-9a-f]{32}$/);
  assert.equal(edited[0].event.detail.previousValueDigest, digestOf("优先给原始证据"));
  assert.equal(edited[0].event.detail.nextValueDigest, digestOf("只用系统综述"));
  assert.equal(database.rows.size, 2);

  // Correcting the same memory again next week is a second lesson, and the
  // version the change produced is what makes it one. Without that identity
  // every later edit of a record collapses into the first, `record()` returns
  // `created: false` and writes nothing, and "how often was the extractor
  // close but wrong" is undercounted with no signal that it happened.
  const again = await feedback.recordMemoryUpdate("user_1", {
    before: memoryRecord({ status: "active", origin: "manual", value: "只用系统综述", version: 5 }),
    after: memoryRecord({ status: "active", origin: "manual", value: "只用系统综述和随机对照试验", version: 6 }),
    projectId: "project_1",
  });
  assert.deepEqual(again.map((item) => item.event.trigger), ["memory-value-edited"]);
  assert.equal(again[0].created, true, "a second, different edit of one record is a second event");
  assert.notEqual(again[0].event.id, edited[0].event.id);
  assert.equal(again[0].event.detail.nextValueDigest, digestOf("只用系统综述和随机对照试验"));
  // The digest is what lets a later consumer see a correction being undone
  // without the ledger holding either text.
  assert.equal(again[0].event.detail.previousValueDigest, edited[0].event.detail.nextValueDigest);
  assert.equal(database.rows.size, 3, "an edit that collapses into an earlier one is an edit nothing recorded");

  // And rejection, which is neither of the two above.
  const archived = await feedback.recordMemoryUpdate("user_1", {
    before: after, after: memoryRecord({ status: "archived", origin: "manual", version: 6 }),
    projectId: "project_1",
  });
  assert.deepEqual(archived.map((item) => item.event.trigger), ["memory-rejected"]);
  assert.equal(archived[0].event.detail.reason, "archived");

  const deleted = await feedback.recordMemoryDeletion("user_1", { record: after, projectId: "project_1" });
  assert.equal(deleted.event.trigger, "memory-rejected");
  assert.equal(deleted.event.detail.reason, "deleted");

  // Archiving a memory and then deleting the archived record is one rejection,
  // not two: the record and the version it was rejected at are the identity,
  // and the second action carries no new fact about the extractor.
  const sameRejection = await feedback.recordMemoryDeletion("user_1", {
    record: memoryRecord({ status: "archived", origin: "manual", version: 6 }), projectId: "project_1",
  });
  assert.equal(sameRejection.created, false);
  assert.equal(sameRejection.event.id, archived[0].event.id);
});

test("no memory value text reaches the ledger, and a sensitive record leaves no digest either", () => {
  // The ledger has no delete path. A value copied into it survives the memory
  // the researcher deletes, which is the one thing `recordMemoryDeletion` was
  // careful never to do — so the edit event may not do it either.
  const secret = "住址：上海市徐汇区某路 100 号";
  const before = memoryRecord({ status: "active", origin: "explicit", value: secret });
  const after = { ...before, value: "住址：上海市浦东新区某路 200 号", version: 4 };
  const [edited] = memoryFeedbackEvents(before, after);
  const serialized = JSON.stringify(edited.detail);
  assert.ok(!serialized.includes(secret), "the previous value is in the ledger's detail");
  assert.ok(!serialized.includes(after.value), "the next value is in the ledger's detail");
  assert.equal(edited.detail.previousValueDigest, digestOf(secret));
  assert.equal(edited.detail.sensitive, false);

  // And when the extractor already judged the content sensitive, not even a
  // digest: a short value is guessable from an unsalted one.
  const [flagged] = memoryFeedbackEvents({ ...before, sensitive: true }, { ...after, sensitive: true });
  assert.deepEqual(Object.keys(flagged.detail).sort(), ["key", "kind", "sensitive", "version"]);
  assert.equal(flagged.detail.sensitive, true);
  // The event itself is unchanged: what the researcher did is still recorded,
  // with the same identity, and only its evidence is withheld.
  assert.equal(flagged.trigger, "memory-value-edited");
  assert.deepEqual(flagged.identity, edited.identity);
  // Either side of the change setting the flag is enough. Turning it on with
  // the edit withholds the digests, and so does the same PATCH clearing it —
  // the value being replaced was still sensitive when it was written, and a
  // clear-and-rewrite must not be the way its digest gets in.
  for (const pair of [[before, { ...after, sensitive: true }], [{ ...before, sensitive: true }, after]]) {
    const [event] = memoryFeedbackEvents(pair[0], pair[1]);
    assert.equal(event.detail.sensitive, true);
    assert.equal(event.detail.previousValueDigest, undefined);
    assert.equal(event.detail.nextValueDigest, undefined);
  }
});

test("a memory update that decided nothing produces no event", () => {
  // Raising `importance` is not feedback about whether the memory is right, and
  // an event log that fires on every PATCH cannot answer the question it exists
  // for. Both directions asserted: silence here, and events above.
  const before = memoryRecord({ status: "active", origin: "explicit" });
  assert.deepEqual(memoryFeedbackEvents(before, { ...before, importance: 0.4, version: 4 }), []);
  assert.deepEqual(memoryFeedbackEvents(before, before), []);
  assert.deepEqual(memoryFeedbackEvents(null, before), []);
  // Whitespace is not a value change either way round: the ledger records the
  // strings it was given and does not normalize them away.
  assert.deepEqual(
    memoryFeedbackEvents(before, { ...before, value: `${before.value} ` }).map((item) => item.trigger),
    ["memory-value-edited"],
  );
});

test("a feedback event refuses a vocabulary it does not know", async () => {
  const { feedback } = fixture();
  await assert.rejects(() => feedback.record("user_1", { trigger: "user-was-happy", subject: SUBJECT }),
    (error) => error.status === 400 && error.code === "feedback_event_invalid");
  await assert.rejects(() => feedback.record("user_1", { trigger: "deliverable-adopted", subject: { type: "run", id: "x" } }),
    (error) => error.status === 400 && error.code === "feedback_event_invalid");
  await assert.rejects(() => feedback.record("user_1", { trigger: "deliverable-adopted", subject: { type: "deliverable", id: "" } }),
    (error) => error.status === 400 && error.code === "feedback_event_invalid");
  await assert.rejects(() => feedback.record("user_1", {
    trigger: "deliverable-adopted", subject: SUBJECT, detail: { note: "x".repeat(5_000) },
  }), (error) => error.status === 400 && error.code === "feedback_event_invalid");
});

test("an adopted deliverable that was then edited enqueues one distill job in the fixed payload shape", async () => {
  const { feedback, jobs } = fixture();
  const { adoption, edit } = await adoptAndEdit(feedback);

  assert.equal(adoption.distillJob, null, "an adoption on its own is not a lesson");
  assert.ok(edit.distillJob, "an edit after an adoption is the trigger this release ships");
  assert.equal(edit.distillJob.kind, "distill");
  // The shape is the one `MethodDistillationRuns` reads, checked key by key
  // because this ledger and that consumer arrived on separate branches and the
  // only thing that made them agree was this assertion.
  assert.deepEqual(Object.keys(edit.distillJob.payload).sort(), ["feedback", "feedbackEventIds", "runId", "trigger"]);
  assert.equal(edit.distillJob.payload.runId, "run_1");
  assert.equal(edit.distillJob.payload.trigger, DISTILL_TRIGGER);
  assert.ok(DISTILLATION_TRIGGERS.includes(DISTILL_TRIGGER),
    "a trigger the distillation run does not accept is a job its only claimer fails terminally");
  assert.deepEqual(edit.distillJob.payload.feedbackEventIds, [adoption.event.id, edit.event.id]);
  // The events travel whole, not as ids: the consumer builds its frozen input
  // from the payload and never reads this ledger back.
  assert.deepEqual(edit.distillJob.payload.feedback.map((event) => event.id), [adoption.event.id, edit.event.id]);
  assert.equal(edit.distillJob.payload.feedback[1].detail.summary, "把结论段的效应量补上了置信区间。");

  // Reporting the same edit again is the same job, not a second one.
  const replay = await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: ["b".repeat(64)], projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "b".repeat(64), summary: "把结论段的效应量补上了置信区间。" },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.distillJob.id, edit.distillJob.id);
  assert.equal(jobs.jobs.length, 1);
});

test("an edit with nothing behind it, and an edit that changed nothing, distil nothing", async () => {
  const { feedback, jobs } = fixture();

  // No adoption first: the researcher may simply be rewriting work they
  // rejected, and there is no lesson in that.
  const orphan = await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: ["c".repeat(64)], projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "c".repeat(64) },
  });
  assert.equal(orphan.created, true, "the event is still a fact and is still recorded");
  assert.equal(orphan.distillJob, null);
  assert.equal(jobs.jobs.length, 0);

  // Adopted, then "edited" to byte-identical content. A true event, an empty
  // diff, and the diff is the whole lesson.
  await feedback.record("user_1", {
    trigger: "deliverable-adopted", subject: SUBJECT, projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
  });
  const unchanged = await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: ["a".repeat(64)], projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
  });
  assert.equal(unchanged.distillJob, null);
  assert.equal(jobs.jobs.length, 0);
});

test("the ledger pages instead of ending at its limit", async () => {
  // A cap with no cursor is a ledger that silently ends: every reader below
  // this API — the ones that count how often an inference was accepted, or how
  // often a deliverable was revised — would have seen a truncated history and
  // had no way to know it.
  const { feedback } = fixture();
  for (let index = 1; index <= 5; index += 1) {
    await feedback.record("user_1", {
      trigger: "deliverable-adopted",
      subject: { type: "deliverable", id: deliverableSubjectId(`run_${index}`, "reports/evidence.md") },
      projectId: "project_1", runId: `run_${index}`, occurredAt: `2026-09-0${index}T08:00:00.000Z`,
      detail: { path: "reports/evidence.md", runId: `run_${index}`, contentSha256: "a".repeat(64) },
    });
  }

  const first = await feedback.list("user_1", { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor, "a truncated page must say how to continue");
  const second = await feedback.list("user_1", { limit: 2, cursor: first.nextCursor });
  const third = await feedback.list("user_1", { limit: 2, cursor: second.nextCursor });
  assert.equal(third.items.length, 1);
  assert.equal(third.nextCursor, null, "the last page says it is the last");
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size, 5,
    "paging must show every event exactly once");
  assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.runId),
    ["run_5", "run_4", "run_3", "run_2", "run_1"], "newest first, across the pages as within one");

  await assert.rejects(() => feedback.list("user_1", { cursor: "not-a-cursor" }),
    (error) => error.status === 400 && error.code === "feedback_cursor_invalid");
});

test("an event id is derived from what happened, not from when it was written", () => {
  // The property the whole ledger rests on. If this used a timestamp or a
  // random id, every replay would append and every count would be wrong.
  const first = feedbackEventId("user_1", "deliverable-adopted", SUBJECT);
  const second = feedbackEventId("user_1", "deliverable-adopted", SUBJECT);
  assert.equal(first, second);
  assert.notEqual(first, feedbackEventId("user_1", "deliverable-edited", SUBJECT));
  assert.notEqual(first, feedbackEventId("user_1", "deliverable-adopted", { type: "deliverable", id: "run_2:reports/evidence.md" }));
  assert.notEqual(feedbackEventId("user_1", "memory-rejected", { type: "memory-record", id: "record_1" }, [3]),
    feedbackEventId("user_1", "memory-rejected", { type: "memory-record", id: "record_1" }, [4]));
  assert.match(first, /^feedback:deliverable-adopted:[0-9a-f]{32}$/);
  // And two accounts are never one event. The id is the table's whole primary
  // key and is derived rather than allocated, so a shared key would give the
  // second account a permanent 409 on an action of its own — with a run id the
  // client chooses, that is a collision someone can aim.
  assert.notEqual(first, feedbackEventId("user_2", "deliverable-adopted", SUBJECT));
});

test("two accounts reporting the same deliverable each get their own event", async () => {
  const { feedback, database } = fixture();
  const mine = await feedback.record("user_1", {
    trigger: "deliverable-adopted", subject: SUBJECT, projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
  });
  const theirs = await feedback.record("user_2", {
    trigger: "deliverable-adopted", subject: SUBJECT, projectId: "project_1", runId: "run_1",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
  });
  assert.equal(theirs.created, true, "the second account must not inherit the first account's event");
  assert.notEqual(theirs.event.id, mine.event.id);
  assert.equal(database.rows.size, 2);
});

test("an adoption reported after the edit it justifies still produces the lesson", async () => {
  // The natural human order: read the report, revise it, then mark it adopted.
  // The edit's own producer ran when there was no adoption to find, and nothing
  // ever looked back, so this sequence yielded nothing at all — and re-posting
  // the edit is a replay the client has no reason to send.
  const { feedback, jobs } = fixture();
  const edit = await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: ["e".repeat(64)], projectId: "project_1", runId: "run_1",
    occurredAt: "2026-09-07T08:00:00.000Z",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "e".repeat(64), summary: "补上了置信区间。" },
  });
  assert.equal(edit.distillJob, null, "an edit with no adoption behind it is still not a lesson");

  const adoption = await feedback.record("user_1", {
    trigger: "deliverable-adopted", subject: SUBJECT, projectId: "project_1", runId: "run_1",
    occurredAt: "2026-09-07T09:00:00.000Z",
    // Adopting exactly the text they had revised: identical digests mean the
    // opposite of what they mean in the other order.
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "e".repeat(64) },
  });
  assert.ok(adoption.distillJob, "the adoption never paired with the edit it justifies");
  assert.equal(adoption.distillJob.payload.runId, "run_1");
  assert.equal(adoption.distillJob.payload.trigger, DISTILL_TRIGGER);
  assert.deepEqual(adoption.distillJob.payload.feedbackEventIds, [adoption.event.id, edit.event.id]);
  assert.deepEqual(adoption.distillJob.payload.feedback.map((event) => event.id), [adoption.event.id, edit.event.id]);
  assert.equal(jobs.jobs.length, 1);

  // And the two directions cannot enqueue one lesson twice: the job key is the
  // edit's id whichever event completed the pair.
  const replay = await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: ["e".repeat(64)], projectId: "project_1", runId: "run_1",
    occurredAt: "2026-09-07T08:00:00.000Z",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "e".repeat(64), summary: "补上了置信区间。" },
  });
  assert.equal(replay.distillJob, null, "an edit byte-identical to the adoption that followed it adds nothing");
  assert.equal(jobs.jobs.length, 1);
});

test("an adoption with only a later edit behind it waits for that edit's own producer", async () => {
  const { feedback, jobs } = fixture();
  await feedback.record("user_1", {
    trigger: "deliverable-edited", subject: SUBJECT, identity: ["f".repeat(64)], projectId: "project_1", runId: "run_1",
    occurredAt: "2026-09-08T10:00:00.000Z",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "f".repeat(64), summary: "后来又改的。" },
  });
  const adoption = await feedback.record("user_1", {
    trigger: "deliverable-adopted", subject: SUBJECT, projectId: "project_1", runId: "run_1",
    occurredAt: "2026-09-08T09:00:00.000Z",
    detail: { path: "reports/evidence.md", runId: "run_1", contentSha256: "a".repeat(64) },
  });
  assert.equal(adoption.distillJob, null, "an adoption must not be paired with a revision that did not exist yet");
  assert.equal(jobs.jobs.length, 0);
});
