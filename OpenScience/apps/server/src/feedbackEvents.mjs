/**
 * What the researcher actually did, kept as facts the system can learn from.
 *
 * Hidden knowledge: the loop this closes. Confirming a pending memory through
 * `PATCH /api/memory/records/:id` was already recognized — `acceptedInference`
 * set origin "explicit", confidence 1 and `lastConfirmedAt`, and appended one
 * audit line. That is a record update plus a line in a per-project JSONL file.
 * It is not an event: nothing could count how often inferences are confirmed,
 * nothing could tell a confirmation from an edit from a rejection, and no later
 * step could read any of it. Every "the system should learn from what the user
 * did" idea died on the same missing substrate.
 *
 * Why a table of its own rather than a `documents` kind. `evimed_product.documents`
 * is a mutable store with revisions and a per-kind export contract:
 * `accountExport.mjs` refuses the whole account export with 503 when it meets a
 * document kind its `customerKinds` list does not name, so a new kind is a
 * cross-module change. An event log also does not want what `documents` offers
 * — there is no revision of an event, and "append-only" should be structural
 * rather than a convention every writer has to keep. So: one narrow table in
 * the same `evimed_product` schema, no UPDATE path anywhere in this module, and
 * identity carried by the primary key so a replay writes nothing.
 *
 * Idempotency is the event's own identity, not a timestamp. A memory event is
 * identified by the record and the version the change produced, so replaying
 * the same PATCH is the same event; an adoption is identified by its
 * deliverable, because adopting twice is one fact; an edit is identified by the
 * content it produced, because two different edits are two lessons and the same
 * edit reported twice is one.
 *
 * What is live today, and what waits on a surface. The three memory triggers
 * are the ones the product writes by itself: the memory PATCH and DELETE routes
 * record them, and nothing reads them back — the substrate exists so that the
 * extractor's own thresholds can one day be answered from what the researcher
 * did, and that consumer is not in this release. The two deliverable triggers
 * are the only ones the producer below reads, and no page posts them yet: they
 * have an HTTP route (`POST /api/feedback/events`) and a typed client function
 * (`reportWebDeliverableFeedback` in `apps/web/src/lib/apiClient.ts`), and
 * until a deliverable surface calls it `#distill` fires only for a caller that
 * posts those events itself — so an ordinary session enqueues no `distill` job
 * and writes no learned-method candidate. Saying so here is the difference
 * between a deliberate first half and a loop someone believes is closed.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { DISTILLATION_TRIGGERS } from "./methodDistillationRuns.mjs";
import { HttpError } from "./security.mjs";
import {
  FEEDBACK_EVENT_TRIGGERS,
  FEEDBACK_SUBJECT_TYPES,
  migrateProductStore,
  productId,
  productInteger,
  productPayload,
} from "./productPersistence.mjs";

export { FEEDBACK_EVENT_TRIGGERS, FEEDBACK_SUBJECT_TYPES };

/**
 * Which distillation this ledger asks for: the `edit_diff` trigger of
 * `DISTILLATION_TRIGGERS`, named from that module so a rename there is a
 * load-time failure here rather than a job nothing will ever claim.
 *
 * It used to be `"adopted-deliverable-edit"`, a private trigger for a private
 * worker in this file that wrote the lesson deterministically and said so:
 * "this release ships the producer, not the judgement… retrieving related
 * methods before proposing, and deciding create/amend/merge, belong to the
 * method-distillation effort and are deliberately not here." That effort landed
 * on another branch and merged next to this one. Both workers then claimed job
 * kind `distill`, `SKIP LOCKED` handed each of them the other's payload, and
 * both classify a foreign trigger as terminal — so whichever polled first
 * destroyed the other's job and burned its idempotency key, meaning the lesson
 * could never be re-queued. Two `learned-method` writers with disjoint payload
 * schemas is the same collision one layer down: `LearningService` filters
 * `method` documents by `recordType` containment, so it would have read rows
 * that carry no `frontmatter`, no `contentDigest` and no `learning`.
 *
 * One kind, one claimer. The evidence this ledger holds — the adoption and the
 * edit — travels as `feedback`, which is exactly the field
 * `buildDistillationInput` reserves for it.
 */
export const DISTILL_TRIGGER = "edit_diff";

if (!DISTILLATION_TRIGGERS.includes(DISTILL_TRIGGER)) {
  throw new TypeError(`Method distillation no longer accepts the "${DISTILL_TRIGGER}" trigger.`);
}

/** Detail objects are evidence, not prose: bounded, and refused when oversized. */
const MAX_DETAIL_BYTES = 4_096;

/** @param {unknown} value @param {number} max */
function boundedText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** A value's identity without its text; the empty string stays empty, so an
 * edit from or to nothing is still visible. @param {unknown} value */
function valueDigest(value) {
  const text = String(value ?? "");
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 32) : "";
}

/** @param {unknown} value @param {string} field */
function feedbackTime(value, field) {
  const time = value == null ? new Date() : new Date(String(value));
  if (!Number.isFinite(time.getTime())) throw new HttpError(400, "feedback_event_invalid", `Invalid ${field}.`);
  return time.toISOString();
}

/** @param {unknown} value */
function feedbackDetail(value) {
  if (value == null) return {};
  const text = productPayload(value);
  if (Buffer.byteLength(text) > MAX_DETAIL_BYTES) {
    throw new HttpError(400, "feedback_event_invalid", "A feedback event detail exceeds 4 KiB.");
  }
  return JSON.parse(text);
}

/** @param {unknown} value */
function feedbackSubject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "feedback_event_invalid", "A feedback event names a subject.");
  }
  const subject = /** @type {Record<string, any>} */ (value);
  if (Object.keys(subject).sort().join(",") !== "id,type" || !FEEDBACK_SUBJECT_TYPES.includes(String(subject.type))) {
    throw new HttpError(400, "feedback_event_invalid", "A feedback event subject is a type and an id.");
  }
  const id = boundedText(subject.id, 400);
  if (!id || id.includes("\0")) throw new HttpError(400, "feedback_event_invalid", "Invalid feedback event subject id.");
  return { type: String(subject.type), id };
}

/**
 * The event's identity, and therefore its idempotency.
 *
 * `identity` is what makes two records of the same trigger on the same subject
 * the same event or two of them. Callers pass the memory version, the edited
 * content's digest, or nothing at all — see the module comment.
 *
 * The account is part of the digest because the table's primary key is one
 * global `id` and a derived id cannot be regenerated: two accounts landing on
 * the same key would give the second one a permanent 409 on an action that is
 * entirely legitimate. The deliverable subject carries a client-chosen run id,
 * so that collision is shaped by whoever picks the id rather than by chance.
 *
 * @param {string} userId @param {string} trigger
 * @param {{type:string,id:string}} subject @param {readonly (string|number)[]} identity
 */
export function feedbackEventId(userId, trigger, subject, identity = []) {
  const digest = createHash("sha256")
    .update(JSON.stringify([String(userId), trigger, subject.type, subject.id, ...identity.map((part) => String(part))]))
    .digest("hex").slice(0, 32);
  return `feedback:${trigger}:${digest}`;
}

/** The subject id a run's deliverable is known by, in both halves of the loop. */
export function deliverableSubjectId(runId, path) {
  return `${boundedText(runId, 120)}:${boundedText(path, 260)}`;
}

/** @param {any} row */
function event(row) {
  return row ? {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    runId: row.run_id,
    trigger: row.trigger_kind,
    subject: { type: row.subject_type, id: row.subject_id },
    detail: row.detail,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
  } : null;
}

/**
 * Which feedback events one structured-memory update produced.
 *
 * A pure function on the record before and after, so "what did the researcher
 * just tell us" is decided in one readable place and can be tested without a
 * database. Three of them, because they mean three different things: accepting
 * an inference says the extractor was right, editing a value says it was close
 * but wrong, and archiving says it should not have been learned at all.
 *
 * The version the change produced is the identity: replaying the same PATCH
 * lands on the same event id and writes nothing.
 *
 * @param {any} before @param {any} after
 * @returns {{trigger:string,identity:string[],detail:Record<string,any>}[]}
 */
export function memoryFeedbackEvents(before, after) {
  if (!before || !after) return [];
  const version = String(after.version ?? 0);
  const key = boundedText(after.key ?? before.key, 255);
  const events = [];
  if (before.status === "pending" && after.status === "active") {
    events.push({
      trigger: "memory-inference-accepted",
      identity: [version],
      detail: { key, kind: after.kind ?? before.kind, previousOrigin: before.origin ?? null, version: after.version ?? null },
    });
  }
  if (String(before.value ?? "") !== String(after.value ?? "")) {
    // The fact of the edit, never its text. This table has no delete path, so a
    // value copied here outlives the memory the researcher later deletes — the
    // reason `recordMemoryDeletion` below stores a key, a kind and a version and
    // no value at all. A digest keeps what the consumer this substrate is for
    // needs: whether the value changed, and whether a later edit went back to
    // one the researcher had before. And a record the extractor marked
    // sensitive carries no digest either: a short value is guessable from an
    // unsalted digest, and that flag is the extractor saying this is exactly
    // the content worth guessing. Either side of the change setting it is
    // enough: the same PATCH can clear the flag and rewrite the value, and the
    // value being replaced was still sensitive when it was written.
    const sensitive = Boolean(after.sensitive) || Boolean(before.sensitive);
    events.push({
      trigger: "memory-value-edited",
      identity: [version],
      detail: {
        key, kind: after.kind ?? before.kind, version: after.version ?? null, sensitive,
        ...(sensitive ? {} : { previousValueDigest: valueDigest(before.value), nextValueDigest: valueDigest(after.value) }),
      },
    });
  }
  if (before.status !== "archived" && after.status === "archived") {
    events.push({
      trigger: "memory-rejected",
      identity: [version],
      detail: { key, kind: after.kind ?? before.kind, version: after.version ?? null, reason: "archived" },
    });
  }
  return events;
}

/** Append-only feedback ledger, and the one producer that reads it. */
export class FeedbackEvents {
  /** @param {{database:any,jobs?:any,now?:()=>Date}} dependencies */
  constructor({ database, jobs = null, now = () => new Date() }) {
    this.database = database;
    this.jobs = jobs;
    this.now = now;
  }

  /**
   * Append one event. Recording it twice records it once.
   *
   * @param {string} userId
   * @param {{trigger:string,subject:{type:string,id:string},identity?:readonly (string|number)[],
   *   projectId?:string|null,runId?:string|null,detail?:Record<string,any>,occurredAt?:any}} input
   * @returns {Promise<{event:any,created:boolean,distillJob:any}>}
   */
  async record(userId, input) {
    const user = productId(userId, "user");
    const trigger = String(input?.trigger ?? "");
    if (!FEEDBACK_EVENT_TRIGGERS.includes(trigger)) {
      throw new HttpError(400, "feedback_event_invalid", "Unknown feedback trigger.");
    }
    const subject = feedbackSubject(input.subject);
    const identity = Array.isArray(input.identity) ? input.identity : [];
    if (identity.length > 4) throw new HttpError(400, "feedback_event_invalid", "A feedback event identity is at most four parts.");
    const id = feedbackEventId(user, trigger, subject, identity);
    const projectId = input.projectId == null ? null : productId(input.projectId, "project");
    const runId = input.runId == null ? null : productId(input.runId, "run");
    const detail = feedbackDetail(input.detail);
    const occurredAt = feedbackTime(input.occurredAt ?? this.now(), "feedback time");
    await migrateProductStore(this.database);
    const inserted = await this.database.query(`INSERT INTO evimed_product.feedback_events
      (id,user_id,project_id,run_id,trigger_kind,subject_type,subject_id,detail,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(id) DO NOTHING RETURNING *`,
    [id, user, projectId, runId, trigger, subject.type, subject.id, JSON.stringify(detail), occurredAt]);
    let created = inserted.rowCount === 1;
    let row = inserted.rows[0] ?? null;
    if (!row) {
      const existing = await this.database.query("SELECT * FROM evimed_product.feedback_events WHERE id=$1 AND user_id=$2", [id, user]);
      // A key that belongs to another account is not this account's event. The
      // digest covers the subject, so this only fires on a genuine collision.
      if (existing.rowCount !== 1) throw new HttpError(409, "feedback_event_conflict", "The feedback event key is already in use.");
      row = existing.rows[0];
      created = false;
    }
    const recorded = event(row);
    // The producer runs on every record, not only the first, so a replay after
    // a crash between the append and the enqueue still reaches the queue.
    const distillJob = await this.#distill(recorded);
    return { event: recorded, created, distillJob };
  }

  /**
   * Every event one structured-memory update produced.
   * @param {string} userId @param {{before:any,after:any,projectId?:string|null}} input
   */
  async recordMemoryUpdate(userId, { before, after, projectId = null }) {
    const results = [];
    for (const item of memoryFeedbackEvents(before, after)) {
      results.push(await this.record(userId, {
        trigger: item.trigger, subject: { type: "memory-record", id: String(after.id ?? before.id ?? "") },
        identity: item.identity, detail: item.detail, projectId,
      }));
    }
    return results;
  }

  /**
   * Deleting a memory is rejecting it. The version is the one that was deleted,
   * so deleting the same record twice is one event.
   * @param {string} userId @param {{record:any,projectId?:string|null}} input
   */
  async recordMemoryDeletion(userId, { record, projectId = null }) {
    return this.record(userId, {
      trigger: "memory-rejected",
      subject: { type: "memory-record", id: String(record?.id ?? "") },
      identity: [String(record?.version ?? 0)],
      detail: { key: boundedText(record?.key, 255), kind: record?.kind ?? null, version: record?.version ?? null, reason: "deleted" },
      projectId,
    });
  }

  /**
   * One page of the ledger, newest first.
   *
   * Keyset rather than offset, on the `(user_id, occurred_at DESC, id)` index
   * this table already carries: an append-only log grows under the reader, and
   * `OFFSET` on a growing log skips and repeats rows. A page cap without a
   * cursor was worse than either — an account with real history simply ended at
   * two hundred events per filter, silently, which is the shape of answer that
   * makes a ledger untrustworthy to everything downstream of it.
   *
   * @param {string} userId
   * @param {{subject?:{type:string,id:string}|null,trigger?:string|null,limit?:number,cursor?:string|null}} options
   * @returns {Promise<{items:any[],nextCursor:string|null}>}
   */
  async list(userId, { subject = null, trigger = null, limit = 50, cursor = null } = {}) {
    productInteger(limit, 1, 200);
    if (trigger != null && !FEEDBACK_EVENT_TRIGGERS.includes(trigger)) {
      throw new HttpError(400, "feedback_event_invalid", "Unknown feedback trigger.");
    }
    const named = subject ? feedbackSubject(subject) : null;
    let after = null;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
        if (!Array.isArray(after) || after.length !== 2 || !Number.isFinite(Date.parse(after[0]))) throw new Error("bad cursor");
        productId(after[1], "feedback event");
      } catch { throw new HttpError(400, "feedback_cursor_invalid", "Invalid feedback cursor."); }
    }
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_product.feedback_events
      WHERE user_id=$1 AND ($2::text IS NULL OR trigger_kind=$2)
      AND ($3::text IS NULL OR (subject_type=$3 AND subject_id=$4))
      AND ($6::timestamptz IS NULL OR (occurred_at,id) < ($6::timestamptz,$7::text))
      ORDER BY occurred_at DESC,id DESC LIMIT $5`,
    [productId(userId, "user"), trigger, named?.type ?? null, named?.id ?? null, limit + 1,
      after?.[0] ?? null, after?.[1] ?? null]);
    const items = result.rows.slice(0, limit).map(event);
    const last = items.at(-1);
    return {
      items,
      // A cursor only when there is a next page, so "there is more" is a fact
      // rather than something the caller has to discover by asking again.
      nextCursor: result.rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.occurredAt, last.id])).toString("base64url") : null,
    };
  }

  /** @param {string} userId @param {string} id */
  async get(userId, id) {
    await migrateProductStore(this.database);
    const result = await this.database.query("SELECT * FROM evimed_product.feedback_events WHERE user_id=$1 AND id=$2",
      [productId(userId, "user"), productId(id, "feedback event")]);
    return event(result.rows[0]);
  }

  /**
   * The first `distill` producer, and the narrowest trigger there is.
   *
   * A deliverable the researcher adopted and also edited: the adoption says the
   * work was worth keeping, the edit says what was still wrong with it, and the
   * pair of them is the only thing here that could be a lesson. An edit with no
   * adoption anywhere near it is not one — the researcher may simply be
   * rewriting something they rejected — so nothing is enqueued.
   *
   * Both orders, because both happen. "Adopt, then revise" is what the earlier
   * version handled; "revise, then mark it adopted" is the more natural human
   * sequence and produced nothing at all, forever, because the edit's producer
   * had run before the adoption existed and no later event ever looked back.
   * The job key is the edit's id in either direction, so the two paths cannot
   * enqueue the same lesson twice.
   *
   * @param {any} recorded
   */
  async #distill(recorded) {
    if (!this.jobs) return null;
    if (recorded.trigger === "deliverable-edited") {
      const adoption = await this.get(recorded.userId, feedbackEventId(recorded.userId, "deliverable-adopted", recorded.subject));
      if (!adoption) return null;
      // Reported after the adoption and byte-identical to it: a true event and
      // an empty lesson, because nothing was revised. The same digests in the
      // other order mean the opposite — see below — so this rule belongs here
      // rather than in the shared enqueue.
      if (adoption.detail?.contentSha256 && adoption.detail.contentSha256 === recorded.detail?.contentSha256) return null;
      return this.#enqueueLesson(adoption, recorded);
    }
    if (recorded.trigger === "deliverable-adopted") {
      const { items: [edit] } = await this.list(recorded.userId, { subject: recorded.subject, trigger: "deliverable-edited", limit: 1 });
      if (!edit) return null;
      // Two conditions, and they are the mirror of the branch above. The edit
      // must be one this adoption came after — a later one is the other
      // direction's to enqueue — and the adopted content must be exactly the
      // revised content. The same digests mean opposite things in the two
      // orders: after an adoption they say nothing was revised, before one
      // they say the revision is what the researcher kept. Different digests
      // here mean the deliverable changed again between the two events, and
      // then this adoption is not evidence about that edit.
      if (Date.parse(edit.occurredAt) > Date.parse(recorded.occurredAt)) return null;
      if (edit.detail?.contentSha256 !== recorded.detail?.contentSha256) return null;
      return this.#enqueueLesson(recorded, edit);
    }
    return null;
  }

  /**
   * Queue the distillation this pair of events is the evidence for.
   *
   * The two events travel whole, under `feedback`, rather than as the ids they
   * used to be: `MethodDistillationRuns` builds the run's frozen input from the
   * payload and never reads this ledger, so a payload of ids would arrive at a
   * reader that cannot resolve them. `feedbackEventIds` stays beside them
   * because the job is the only place that records which two events a candidate
   * came from, and a lesson whose evidence cannot be named is one nobody can
   * audit.
   *
   * The idempotency key is still the edit — one edit is one lesson however many
   * times the pair is completed — but it now names the run as well, because the
   * distillation dispatch identity is `(runId, trigger)` and two jobs that would
   * adopt the same bounded run must be the same job.
   *
   * @param {any} adoption @param {any} edit
   */
  async #enqueueLesson(adoption, edit) {
    const runId = edit.runId ?? adoption.runId;
    if (!runId) return null;
    return this.jobs.enqueue(edit.userId, "distill", {
      runId,
      trigger: DISTILL_TRIGGER,
      feedbackEventIds: [adoption.id, edit.id],
      feedback: [adoption, edit],
    }, {
      idempotencyKey: `distill:${runId}:${DISTILL_TRIGGER}:${edit.id}`,
      projectId: edit.projectId ?? adoption.projectId ?? null,
    });
  }
}
