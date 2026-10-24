/**
 * The memory dashboard an integrator draws for its own users — the TCM CDSS's
 * 「记忆胶囊看板」 — and the acts a person takes on it.
 *
 * Hidden knowledge: the research workbench's memory page was cut to a minimal
 * list on 2026-09-23 (owner ruling), while the plan given to the CDSS's client
 * promises a dashboard that shows 「最近变化（每一项均可一键撤销）」, each record's
 * source 「本人设置、从改方学习、来自胶囊」, 「依据次数与使用情况」 and 「曾经如此」.
 * The two are different products on one store (audit M §3, gap 3): the
 * workbench page stays as it is, and this module is what the CDSS's page reads.
 * It holds nothing of its own. Every line is derived when it is read from what
 * the record store, the method ledger and the capsule store already keep — a
 * record's evidence and revisions, its usage counter, a method's revisions —
 * so the dashboard cannot disagree with the memory it describes.
 *
 * Codes and the stored words travel, plus one Chinese label per source,
 * because the reader is another product's page, and a second copy of that
 * vocabulary there would be the one that drifts.
 *
 * The acts are the workbench's own acts, with the workbench's semantics:
 * confirming a proposal makes it the person's own statement, editing makes it
 * theirs, forgetting archives it (restorable), undo saves the previous state
 * forward, and each rejection is written to the feedback ledger so the next
 * extraction does not write it straight back. Only a key carrying
 * `memory.manage` may take them: the integrator declares, by holding one, that
 * its requests come from the person's own dashboard.
 *
 * @module agentMemoryBoard
 */

import { cleanMethodDisplay } from "@evimed/domain";

import { bodyVersionOf, effectiveStatusReason, methodStepsOf } from "./learningService.mjs";
import { filterCapturedMessage } from "./memoryGateway.mjs";
import { NATIVE_RECORD_ID } from "./nativeMemoryStore.mjs";
import { memoryPausedFor } from "./researchMemory.mjs";
import { HttpError } from "./security.mjs";

/** How long a learned method wears 「新」 (build spec §8.4). */
export const BOARD_NEW_DAYS = 14;

/** How far back 「最近变化」 reaches. */
export const BOARD_RECENT_DAYS = 30;

/** Where a memory came from, as the dashboard labels it (甲方 plan 三（一）). */
export const BOARD_SOURCES = Object.freeze({
  self: "本人设置",
  observed: "从改方学习",
  learned: "从研究中学习",
  inferred: "系统推断",
  research: "来自研究",
  capsule: "来自胶囊",
});

const DAY_MS = 86_400_000;

/** @param {unknown} value @returns {number} */
function instantMs(value) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** The source of a record, from the basis its own evidence and revisions give.
 * @param {any} record */
function recordSource(record) {
  if (record?.engine === "native" && ["explicit", "manual"].includes(record.origin)) return "self";
  const basis = record?.provenance?.basis;
  if (["stated", "confirmed", "edited"].includes(basis)) return "self";
  if (basis === "inferred") return "inferred";
  return "research";
}

/** The source of a learned method. @param {any} payload */
function methodSource(payload) {
  if (payload?.provenance?.origin === "explicit") return "self";
  return payload?.provenance?.source === "observations" ? "observed" : "learned";
}

/**
 * The states a record has been through that no longer hold, with when each
 * held: its earlier values (a revision stores the state that was replaced, at
 * the moment it was), and the records it replaced. 「曾经如此」.
 * @param {any} record @param {any[]} replaced records superseded by this one
 */
function wasTrue(record, replaced) {
  const revisions = [...(record.revisions ?? [])].sort((left, right) => left.version - right.version);
  const current = String(record.summary || record.value || "");
  /** @type {any[]} */
  const earlier = [];
  revisions.forEach((revision, index) => {
    const words = String(revision.summary || revision.value || "");
    if (!words || words === current || !["active", "superseded"].includes(revision.status)) return;
    earlier.push({
      version: revision.version,
      summary: words,
      from: index === 0 ? record.validFrom ?? record.createdAt : revisions[index - 1].changedAt ?? null,
      until: revision.changedAt ?? null,
      ...(revision.by ? { by: revision.by } : {}),
    });
  });
  for (const old of replaced) {
    earlier.push({ recordId: old.id, summary: String(old.summary || old.value || ""), from: old.validFrom ?? old.createdAt, until: old.invalidSince ?? old.updatedAt });
  }
  return earlier.sort((left, right) => String(right.until ?? "").localeCompare(String(left.until ?? "")));
}

/** One record, as a dashboard row. @param {any} record @param {any[]} replaced @param {Record<string, any>} usage */
function recordRow(record, replaced, usage) {
  const source = recordSource(record);
  return {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    summary: record.summary || record.value,
    value: record.value,
    status: record.status,
    version: record.version,
    source,
    sourceLabel: BOARD_SOURCES[/** @type {keyof typeof BOARD_SOURCES} */ (source)],
    basis: {
      kind: record.provenance?.basis ?? null,
      observations: record.provenance?.observations ?? 0,
      runs: record.provenance?.runs ?? 0,
      conversations: record.provenance?.conversations ?? 0,
    },
    usage: usage[record.id] ?? { count: 0, lastUsedAt: null },
    quotes: (record.evidence ?? []).slice(-3).map((/** @type {any} */ item) => ({ quote: item.quote, observedAt: item.observedAt, sourceRef: item.sourceRef })),
    history: [...(record.revisions ?? [])].sort((left, right) => right.version - left.version).slice(0, 5)
      .map((/** @type {any} */ revision) => ({ version: revision.version, summary: revision.summary || revision.value, status: revision.status,
        changedAt: revision.changedAt, ...(revision.by ? { by: revision.by } : {}) })),
    wasTrue: wasTrue(record, replaced),
    sensitive: record.sensitive === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * One learned method, as a dashboard row.
 * @param {any} document @param {number} nowMs @param {Map<string, any>} basis
 */
function habitRow(document, nowMs, basis) {
  const payload = document.payload ?? {};
  const display = cleanMethodDisplay(payload.display);
  const since = payload.statusChangedAt ?? null;
  const source = methodSource(payload);
  const counts = payload.learning?.counts ?? {};
  return {
    id: document.id,
    title: display?.title ?? String(payload.frontmatter?.name ?? document.id),
    summary: display?.summary ?? String(payload.frontmatter?.description ?? ""),
    status: payload.status ?? "candidate",
    // A stopped habit keeps the reason it was stopped with; any other reads
    // its standing from the record (`effectiveStatusReason`).
    statusReason: payload.status === "retired" ? payload.statusReason ?? null : effectiveStatusReason(payload),
    // Which body this is (「第 N 版」), never a count of writes.
    version: bodyVersionOf(payload),
    since,
    isNew: payload.status === "approved" && Number.isFinite(instantMs(since)) && nowMs - instantMs(since) <= BOARD_NEW_DAYS * DAY_MS,
    source,
    sourceLabel: BOARD_SOURCES[/** @type {keyof typeof BOARD_SOURCES} */ (source)],
    // For a habit learned from prescription edits, what it was counted from
    // (「在 12 次改方中出现 9 次」); null for one learned from research.
    basis: basis.get(String(document.id)) ?? null,
    usage: { loaded: Number(counts.loaded ?? 0), read: Number(counts.read ?? 0), invoked: Number(counts.invoked ?? 0) },
    revision: document.revision,
    createdAt: document.createdAt,
  };
}

/**
 * The whole dashboard for one account: its switches, what is in force, what
 * waits for the person, what was forgotten, the habits and what they were
 * counted from, what was never learned, and what changed.
 *
 * @param {{ researchMemory: any, nativeMemory?: any, learning?: any, capsules?: any,
 *   projectId?: string | null, observations?: { basis: (userId: string) => Promise<Map<string, any>>, neverLearned: (userId: string) => Promise<any[]> } | null,
 *   now?: () => Date }} services
 * @param {{ id: string } | null} user null: a subject with no memory yet — an empty dashboard
 */
export async function memoryBoard({ researchMemory, nativeMemory = null, learning = null, capsules = null, observations = null, projectId = null, now = () => new Date() }, user) {
  const nowMs = now().getTime();
  if (!user) {
    return { engine: "legacy", switches: { learningPaused: false, recallPaused: false }, records: [], pending: [], forgotten: [], habits: [], neverLearned: [], recentChanges: [] };
  }
  const settings = await researchMemory.settings(user.id);
  const native = typeof researchMemory.memoryEngine === "function" && await researchMemory.memoryEngine(user.id) === "native";
  if (native && !nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
  const recordStore = native ? nativeMemory : researchMemory;
  const all = [...await recordStore.listRecords(user.id, { statuses: ["active", "pending", "superseded", "archived"], pageSize: 100 }),
    ...(native ? await researchMemory.listRecords(user.id, { statuses: ["pending"], pageSize: 100 }) : [])]
    .filter((/** @type {any} */ record) => record.kind !== "run_summary" && (!projectId || (record.scope === "project" && record.scopeId === projectId)));
  const usage = native ? {} : await researchMemory.recordUsage(user.id, all.map((/** @type {any} */ record) => record.id)).catch(() => ({}));
  /** @type {Map<string, any[]>} */
  const replacedBy = new Map();
  for (const record of all) {
    if (record.status !== "superseded" || !record.supersededBy) continue;
    replacedBy.set(record.supersededBy, [...(replacedBy.get(record.supersededBy) ?? []), record]);
  }
  const row = (/** @type {any} */ record) => recordRow(record, replacedBy.get(record.id) ?? [], usage);

  // What waits for the person: records held for them, and the notes an
  // outside agent proposed (`/note`), which are capsule candidates.
  /** @type {any[]} */
  const pending = (await Promise.all(all.filter((/** @type {any} */ record) => record.status === "pending").map(async (/** @type {any} */ record) => {
    const admission = native ? await nativeMemory.overlay.admission(user.id, `record:${record.id}`, record.version) : null;
    if (admission?.state === "completed") return null;
    return { type: "record", ...row(record), ...(admission ? { admission: { state: admission.state, taskId: admission.taskId, recordIds: admission.recordIds } } : {}) };
  }))).filter(Boolean);
  if (capsules?.documents) {
    const notes = await capsules.documents.list(user.id, "fact", { limit: 50, filter: { status: "candidate" } });
    for (const note of notes.items ?? []) {
      if (note.payload?.transfer || (projectId && note.projectId !== projectId)) continue;
      const admission = native ? await nativeMemory.overlay.admission(user.id, note.id, note.revision) : null;
      if (admission?.state === "completed") continue;
      pending.push({ ...(admission ? { admission: { state: admission.state, taskId: admission.taskId, recordIds: admission.recordIds } } : {}), type: "note", id: note.id, capsuleId: note.payload.capsuleId, kind: note.payload.factKind, summary: note.payload.content,
        revision: note.revision, source: "inferred", sourceLabel: BOARD_SOURCES.inferred, createdAt: note.createdAt });
    }
  }

  // What a habit learned from edits was counted from, and what was never
  // learned from (「不学习」). Unreadable, the dashboard shows the habits
  // without their counts rather than failing.
  const basis = observations ? await observations.basis(user.id).catch(() => new Map()) : new Map();
  const never = observations ? await observations.neverLearned(user.id).catch(() => []) : [];
  const methods = learning ? ((await learning.listMethods(user.id, { limit: 50 })).items ?? []).filter((/** @type {any} */ method) => !projectId || method.projectId === projectId) : [];
  const habits = methods.filter((/** @type {any} */ document) => document.payload?.status !== "candidate")
    .map((/** @type {any} */ document) => habitRow(document, nowMs, basis));

  // 「最近变化」: what changed by itself, newest first, each with the act that
  // takes it back.
  const since = new Date(nowMs - BOARD_RECENT_DAYS * DAY_MS).toISOString();
  const recordChanges = (native ? await nativeMemory.changes(user.id, { since, limit: 20 }) : await researchMemory.recentChanges(user.id, { since, limit: 20 })).filter((/** @type {any} */ change) => !projectId || all.some((record) => record.id === change.id)).map((/** @type {any} */ change) => ({
    type: "record", recordId: change.id, kind: change.kind, change: change.change, summary: change.summary, at: change.changedAt,
    undo: { action: "undo", path: `records/${encodeURIComponent(change.id)}/undo`, expectedVersion: change.version },
  }));
  const habitChanges = methods.flatMap((/** @type {any} */ document) => {
    const payload = document.payload ?? {};
    const at = payload.statusChangedAt ?? document.createdAt;
    if (!Number.isFinite(instantMs(at)) || instantMs(at) < nowMs - BOARD_RECENT_DAYS * DAY_MS) return [];
    const title = cleanMethodDisplay(payload.display)?.title ?? String(payload.frontmatter?.name ?? document.id);
    if (payload.status === "approved") {
      return [{ type: "habit", methodId: document.id, change: "approved", summary: title, at,
        undo: { action: "retire", path: `methods/${encodeURIComponent(document.id)}/retire`, expectedRevision: document.revision } }];
    }
    if (payload.status === "retired") {
      return [{ type: "habit", methodId: document.id, change: "retired", summary: title, at, reason: payload.statusReason ?? null,
        undo: { action: "restore", path: `methods/${encodeURIComponent(document.id)}/restore`, expectedRevision: document.revision } }];
    }
    return [];
  });

  return {
    switches: { learningPaused: settings.learningPaused, recallPaused: settings.recallPaused },
    records: all.filter((/** @type {any} */ record) => record.status === "active").map(row),
    pending,
    forgotten: all.filter((/** @type {any} */ record) => record.status === "archived").slice(0, 20).map(row),
    habits,
    neverLearned: projectId ? [] : never,
    recentChanges: [...recordChanges, ...habitChanges]
      .sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 20),
  };
}

/** @param {any} body @param {readonly string[]} allowed */
function bodyOf(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "agent_memory_payload_invalid", `The request body may carry only: ${allowed.join(", ")}.`);
  }
  return body;
}

/** @param {unknown} value @param {string} name */
function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, "agent_memory_payload_invalid", `${name} must be a positive integer.`);
  return number;
}

async function nativeRecordAction(native, user, recordId, action, body) {
  if (action === "undo") {
    const input = bodyOf(body, ["expectedVersion"]);
    const result = await native.undo(user.id, recordId, { expectedVersion: positive(input.expectedVersion, "expectedVersion") });
    return { record: result.record, event: `memory.record.undo.${result.undone}` };
  }
  if (action === "restore") {
    throw new HttpError(400, "memory_engine_unsupported", "On the native memory engine a forgotten memory is brought back with undo, naming the version the forget answered with.");
  }
  const input = bodyOf(body, action === "edit" ? ["expectedVersion", "summary", "value"] : ["expectedVersion"]);
  const expectedVersion = positive(input.expectedVersion, "expectedVersion");
  if (action === "confirm") {
    throw new HttpError(409, "memory_not_pending", "Nothing waits for confirmation on the native memory engine: a memory is in force when it is written.");
  }
  if (action === "forget") {
    return { record: await native.update(user.id, recordId, { status: "archived", expectedVersion }), event: "memory.record.forget" };
  }
  if (action === "edit") {
    if (input.value === undefined && input.summary === undefined) throw new HttpError(400, "agent_memory_payload_invalid", "Edit the summary, the value, or both.");
    // A memory file has the text and nothing else: a summary alone has no place in it, and is refused by name.
    if (input.value === undefined) throw new HttpError(400, "memory_engine_unsupported", "A memory on the native engine has its text and no separate summary: edit the value.");
    const text = typeof input.value === "string" ? input.value.trim() : "";
    if (!text || text.length > 100_000) throw new HttpError(400, "agent_memory_payload_invalid", "value is empty or too long.");
    return { record: await native.update(user.id, recordId, { value: text, expectedVersion }), event: "memory.record.edit" };
  }
  throw new HttpError(404, "not_found", "No such memory action.");
}

/**
 * One act on one record: `confirm`, `edit`, `forget`, `restore` or `undo`.
 *
 * @param {{ researchMemory: any, nativeMemory?: any, feedbackEvents?: any }} services
 * @param {{ id: string }} user @param {string} recordId @param {string} action @param {any} body
 * @returns {Promise<{ record: any, event: string }>}
 */
export async function recordAction({ researchMemory, nativeMemory = null, feedbackEvents = null }, user, recordId, action, body) {
  const native = typeof researchMemory.memoryEngine === "function" && await researchMemory.memoryEngine(user.id) === "native";
  const nativeRecord = native && NATIVE_RECORD_ID.test(recordId);
  if (nativeRecord && !nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
  if (native && !nativeRecord) {
    const candidate = await researchMemory.getRecord(user.id, recordId);
    if (candidate.status !== "pending" && !(candidate.status === "archived" && candidate.revisions?.some((/** @type {any} */ revision) => revision.status === "pending"))) {
      throw new HttpError(404, "memory_not_found", "No such pending memory candidate.");
    }
  }
  if (nativeRecord) return nativeRecordAction(nativeMemory, user, recordId, action, body);

  const projectId = "default";
  const remember = async (/** @type {() => Promise<any>} */ operation) => {
    if (!feedbackEvents) return;
    // The act stands whether or not its trace could be written, as on the
    // workbench page (`recordFeedback`).
    await operation().catch(() => null);
  };
  if (action === "undo") {
    const input = bodyOf(body, ["expectedVersion"]);
    const result = await researchMemory.undo(user.id, recordId, { expectedVersion: positive(input.expectedVersion, "expectedVersion") });
    await remember(() => (result.undone === "removed"
      ? feedbackEvents.recordMemoryDeletion(user.id, { record: result.previous, projectId, reason: "undone" })
      : feedbackEvents.recordMemoryUpdate(user.id, { before: result.previous, after: result.record, projectId })));
    return { record: result.record, event: `memory.record.undo.${result.undone}` };
  }
  const input = bodyOf(body, action === "edit" ? ["expectedVersion", "summary", "value"] : ["expectedVersion"]);
  const expectedVersion = positive(input.expectedVersion, "expectedVersion");
  const existing = await researchMemory.getRecord(user.id, recordId);
  if (existing.version !== expectedVersion) throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
  const next = { ...existing };
  let reason;
  if (action === "confirm") {
    if (existing.status !== "pending") throw new HttpError(409, "memory_not_pending", "Only a memory waiting for its owner can be confirmed.");
    if (native) {
      if (!nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
      if ((await memoryPausedFor(researchMemory, user.id, existing.scope === "project" ? existing.scopeId : null)).learning) throw new HttpError(409, "memory_learning_paused", "Memory learning is paused for this scope.");
      const admission = await nativeMemory.admitCandidate(user.id, { candidateId: `record:${recordId}`, revision: expectedVersion,
        projectId: existing.scope === "project" ? existing.scopeId : null, text: existing.value || existing.summary });
      return { record: { ...existing, admission }, event: "memory.record.admission" };
    }
    // The person's own act: it is now their statement (`memoryRoutes` PATCH).
    Object.assign(next, { status: "active", origin: "explicit", confidence: 1, lastConfirmedAt: new Date().toISOString() });
    reason = "user confirmed a pending memory";
  } else if (action === "edit") {
    if (input.summary === undefined && input.value === undefined) throw new HttpError(400, "agent_memory_payload_invalid", "Edit the summary, the value, or both.");
    for (const field of /** @type {const} */ (["summary", "value"])) {
      if (input[field] === undefined) continue;
      const text = typeof input[field] === "string" ? input[field].trim() : "";
      if (!text || text.length > (field === "value" ? 100_000 : 2_000)) throw new HttpError(400, "agent_memory_payload_invalid", `${field} is empty or too long.`);
      next[field] = text;
    }
    Object.assign(next, { origin: "manual", lastConfirmedAt: new Date().toISOString(), status: native ? existing.status : existing.status === "pending" ? "active" : existing.status });
    reason = "user updated structured memory";
  } else if (action === "forget") {
    if (existing.status === "archived") throw new HttpError(409, "memory_already_forgotten", "This memory is already forgotten.");
    next.status = "archived";
    reason = "user archived the memory";
  } else if (action === "restore") {
    if (existing.status !== "archived") throw new HttpError(409, "memory_not_forgotten", "Only a forgotten memory can be restored.");
    next.status = native ? "pending" : "active";
    reason = "user restored the memory";
  } else {
    throw new HttpError(404, "not_found", "No such memory action.");
  }
  const updated = await researchMemory.upsertRecord(user.id, next, null, { expectedVersion, reason, by: "user" });
  await remember(() => feedbackEvents.recordMemoryUpdate(user.id, { before: existing, after: updated, projectId }));
  return { record: updated, event: `memory.record.${action}` };
}

/**
 * One act on one learned method: `retire` (停用), `restore` (take the stop
 * back) or `rollback` (回到上一版).
 *
 * `LearningService.rollback` decides what 「上一版」 means from the record — for
 * a stopped method the last state that was in use, body included; for one in
 * use the previous body, never a counter write — so `restore` is that rollback
 * from where the method stands now, and `rollback` passes the number the page
 * read and lets the service resolve it.
 *
 * @param {{ learning: any }} services
 * @param {{ id: string }} user @param {string} methodId @param {string} action @param {any} body
 */
export async function methodAction({ learning }, user, methodId, action, body) {
  if (!learning) throw new HttpError(503, "product_state_unavailable", "Learned methods are unavailable.");
  if (action === "retire") {
    const input = bodyOf(body, ["expectedRevision"]);
    return learning.retire(user.id, methodId, { expectedRevision: positive(input.expectedRevision, "expectedRevision"), reason: "你在看板上停用了它" });
  }
  if (action === "restore") {
    const input = bodyOf(body, ["expectedRevision"]);
    const current = await learning.getMethod(user.id, methodId);
    if (current.payload?.status !== "retired") throw new HttpError(409, "method_not_retired", "Only a retired method can be restored.");
    return learning.rollback(user.id, methodId, { expectedRevision: positive(input.expectedRevision, "expectedRevision"), targetRevision: current.revision });
  }
  if (action === "rollback") {
    const input = bodyOf(body, ["expectedRevision", "targetRevision"]);
    return learning.rollback(user.id, methodId, {
      expectedRevision: positive(input.expectedRevision, "expectedRevision"), targetRevision: positive(input.targetRevision, "targetRevision"),
    });
  }
  throw new HttpError(404, "not_found", "No such method action.");
}

/**
 * One learned method with its versions: the bodies it has held, newest first
 * (`LearningService.history` — a counter write or a status change of the same
 * text is not a version), each earlier one marked `wasTrue` (「曾经如此」).
 * @param {{ learning: any }} services @param {{ id: string }} user @param {string} methodId
 */
export async function methodDetail({ learning }, user, methodId) {
  if (!learning) throw new HttpError(503, "product_state_unavailable", "Learned methods are unavailable.");
  const document = await learning.getMethod(user.id, methodId);
  const versions = await learning.history(user.id, methodId);
  return {
    id: document.id,
    revision: document.revision,
    version: bodyVersionOf(document.payload),
    status: document.payload?.status ?? "candidate",
    body: String(document.payload?.body ?? ""),
    steps: methodStepsOf(document.payload),
    versions: versions.map((/** @type {any} */ version) => ({ ...version, wasTrue: version.current !== true })),
  };
}

/**
 * Confirm or reject a note an outside agent proposed.
 * @param {{ capsules: any, researchMemory?: any, nativeMemory?: any }} services @param {{ id: string }} user @param {string} noteId @param {string} action @param {any} body
 */
export async function noteAction({ capsules, researchMemory = null, nativeMemory = null }, user, noteId, action, body) {
  if (!capsules?.documents) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
  const input = bodyOf(body, ["expectedRevision"]);
  const note = await capsules.documents.get(user.id, "fact", noteId);
  if (!note || note.payload?.status !== "candidate" || note.payload?.transfer) throw new HttpError(404, "note_not_found", "No such proposed note.");
  if (!["confirm", "reject"].includes(action)) throw new HttpError(404, "not_found", "No such note action.");
  const revision = positive(input.expectedRevision, "expectedRevision");
  if (note.revision !== revision) throw new HttpError(409, "product_revision_conflict", "This candidate changed since it was read.");
  const native = typeof researchMemory?.memoryEngine === "function" && await researchMemory.memoryEngine(user.id) === "native";
  if (native && action === "confirm") {
    if (!nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
    if ((await memoryPausedFor(researchMemory, user.id, note.projectId ?? null)).learning) throw new HttpError(409, "memory_learning_paused", "Memory learning is paused for this scope.");
    let text = note.payload.content;
    if (note.payload.externalSession) {
      const messages = Array.isArray(note.payload.externalSession.messages) ? note.payload.externalSession.messages : [];
      text = messages.filter((/** @type {any} */ message) => message?.sender === "user")
        .flatMap((/** @type {any} */ message) => {
          const decision = filterCapturedMessage({ role: "user", parts: message.parts });
          return "forward" in decision ? decision.forward.parts.map((part) => part.text) : [];
        }).join("\n\n").trim();
      if (!text) return { ...note, admission: { candidateId: noteId, revision, state: "skipped", reason: "no_user_content", recordIds: [] } };
      if (text.length > 262144) throw new HttpError(400, "memory_payload_invalid", "The user statements are too large for admission.");
    }
    const admission = await nativeMemory.admitCandidate(user.id, { candidateId: noteId, revision, projectId: note.projectId ?? null, text });
    return { ...note, admission };
  }
  return capsules.updateEntry(user.id, note.payload.capsuleId, noteId, {
    status: action === "confirm" ? "approved" : "retired",
    expectedRevision: positive(input.expectedRevision, "expectedRevision"),
  });
}
