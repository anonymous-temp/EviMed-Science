/**
 * 「时间轴」 — the events of how the capsule grew, derived when they are read.
 *
 * What is left of the timeline (2026-10-24): its own page, route and read (`GET /api/memory/timeline`, `memoryTimeline`) are gone —
 * no page had read them since the 成长 tab went (2026-10-17), and the 记忆总览's growth card and the map's time view are drawn
 * from the map's own document (`memoryMap.mjs`), which cannot tell a second story. What stays is what that document is made of:
 * the functions that turn a memory, a run, a learned method and a researcher's correction into events (`recordEvents`,
 * `runEvents`, `methodEvents`, `feedbackTimelineEvents`) and the two helpers of a calendar day (`dayOf`, `timeZoneOrDefault`).
 *
 * Hidden knowledge: this module writes nothing, on purpose. Every event it
 * shows already has an owner — a memory's revision history (who changed it, in
 * which run, what it said before), the supersession pointers of a fact that
 * stopped holding (「曾经如此」), the run ledger, the learned methods, and the
 * feedback ledger — so a timeline that kept its own log would be a second
 * writer, and a second writer is where "forgot to record it" holes come from
 * (proposal §4.6). Derived at read time, the timeline cannot disagree with the
 * records it describes; the price is a bounded read of each source per page.
 *
 * Events carry codes and the stored words, never rendered sentences: the web
 * says them in Chinese, and a memory's text is the researcher's own.
 *
 * @module memoryTimeline
 */

import { cleanMethodDisplay, isVerificationRun } from "@evimed/domain";

import { HttpError } from "./security.mjs";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

/** @param {unknown} value @param {number} [max] */
function excerpt(value, max = 200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** @param {unknown} value */
function instant(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * What changed between two states of a memory, as a code.
 * @param {{ value: string, summary: string, status: string }} from
 * @param {{ value: string, summary: string, status: string }} to
 */
function stateChange(from, to) {
  if (from.status !== to.status) {
    if (to.status === "archived") return "archived";
    if (to.status === "superseded") return "superseded";
    if (from.status === "archived" || from.status === "superseded") return "restored";
    if (from.status === "pending" && to.status === "active") return "confirmed";
    return "status";
  }
  return "updated";
}

/**
 * Every event one memory has been through: its writing, each revision, and —
 * when it stopped holding — the fact that replaced it.
 * @param {any} record a `publicRecord`
 * @param {Map<string, any>} byId every record of the account, for the replacement's words
 */
export function recordEvents(record, byId = new Map()) {
  if (record.kind === "run_summary") return [];
  const revisions = Array.isArray(record.revisions) ? [...record.revisions].sort((a, b) => a.version - b.version) : [];
  const current = { value: record.value, summary: record.summary, status: record.status };
  const states = [...revisions.map((item) => ({ value: item.value, summary: item.summary, status: item.status })), current];
  const words = (/** @type {{ summary: string, value: string }} */ state) => excerpt(state.summary || state.value);
  // The version the undo names. 「最近变化」 offers 撤销 on every line it shows,
  // and an undo is a compare-and-swap on the record's current version — so an
  // event that named only the record would make the page read the record again
  // before it could offer the button, once per line.
  const base = { type: "memory", recordId: record.id, kind: record.kind, scope: record.scope, version: record.version };
  /** @type {any[]} */
  const events = [];
  const createdAt = instant(record.createdAt);
  if (createdAt) {
    events.push({
      ...base, id: `memory:${record.id}:created`, at: createdAt, change: "created",
      after: words(states[0]), origin: record.origin, basis: record.provenance?.basis ?? null,
    });
  }
  revisions.forEach((revision, index) => {
    const at = instant(revision.changedAt);
    if (!at) return;
    const to = states[index + 1];
    const change = stateChange(states[index], to);
    // A supersession is told once, below, with the fact that replaced it.
    if (change === "superseded" && record.supersededBy) return;
    events.push({
      ...base, id: `memory:${record.id}:v${revision.version}`, at, change,
      before: words(states[index]), after: words(to),
      ...(revision.by ? { by: revision.by } : {}), ...(revision.runId ? { runId: revision.runId } : {}),
    });
  });
  if (record.status === "superseded" && record.supersededBy) {
    const replacement = byId.get(record.supersededBy);
    const at = instant(record.invalidSince) ?? instant(record.updatedAt);
    if (at) {
      events.push({
        ...base, id: `memory:${record.id}:superseded`, at, change: "superseded",
        // 「曾经如此」: the old words stay on the timeline, marked, instead of
        // disappearing when the fact changed.
        before: words(current), after: replacement ? words(replacement) : "", replacedBy: record.supersededBy,
        wasTrue: true,
      });
    }
  }
  return events;
}

/**
 * A run on the timeline: what it was, and how much memory it was given.
 * @param {any} run
 */
export function runEvents(run) {
  const at = instant(run.finishedAt) ?? instant(run.startedAt);
  // The platform's own re-check of a claim is not something the person did (`isVerificationRun`, 2026-10-14).
  if (!at || run.automated === true || isVerificationRun(run)) return [];
  return [{
    type: "run", id: `run:${run.id}`, at, change: String(run.status ?? ""), runId: run.id,
    title: excerpt(run.title || run.question, 80),
    recalled: Array.isArray(run.recalledMemories) ? run.recalledMemories.length : 0,
    methods: Array.isArray(run.methodsLoaded) ? run.methodsLoaded.length : 0,
  }];
}

/**
 * A learned method on the timeline: learned, and — when its status moved —
 * put in force or retired.
 * @param {any} document a `method` product document
 */
export function methodEvents(document) {
  const payload = document?.payload ?? {};
  // The researcher's line when the method has one (`cleanMethodDisplay`);
  // otherwise its own name, which is written for the model.
  const name = excerpt(cleanMethodDisplay(payload.display)?.title ?? payload.frontmatter?.name ?? document.id, 80);
  const base = { type: "method", methodId: String(document.id), name, origin: payload.origin ?? payload.provenance?.origin ?? null };
  /** @type {any[]} */
  const events = [];
  const created = instant(document.createdAt);
  if (created) events.push({ ...base, id: `method:${document.id}:created`, at: created, change: "learned" });
  const moved = instant(payload.statusChangedAt);
  if (moved && ["approved", "retired"].includes(payload.status) && moved !== created) {
    // Why it stopped is worth a line; why it started is the promotion rule,
    // the same for every method, and it was stored as that rule's English
    // sentence (「learned from the researcher's own work: it takes effect…」
    // under every 「一条做法开始生效」, 2026-09-21 walk).
    events.push({ ...base, id: `method:${document.id}:${payload.status}`, at: moved, change: payload.status,
      ...(payload.status === "retired" && payload.statusReason ? { reason: excerpt(payload.statusReason, 120) } : {}) });
  }
  return events;
}

/**
 * What the researcher did that the records themselves no longer show: a
 * deleted memory (its record is gone), a delivery adopted, edited or corrected.
 * @param {any} event a feedback ledger event
 */
export function feedbackTimelineEvents(event) {
  const at = instant(event?.occurredAt);
  if (!at) return [];
  if (event.trigger === "memory-rejected" && ["deleted", "undone"].includes(event.detail?.reason)) {
    return [{ type: "feedback", id: `feedback:${event.id}`, at, change: `memory-${event.detail.reason}`, kind: event.detail?.kind ?? null }];
  }
  if (event.trigger === "deliverable-adopted" || event.trigger === "deliverable-edited" || event.trigger === "result-corrected") {
    return [{ type: "feedback", id: `feedback:${event.id}`, at, change: event.trigger, runId: event.runId ?? null }];
  }
  return [];
}

/** The calendar day of an instant in a zone, as YYYY-MM-DD. @param {string} at @param {Intl.DateTimeFormat} format */
export function dayOf(at, format) {
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** @param {unknown} value */
export function timeZoneOrDefault(value) {
  const zone = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    throw new HttpError(400, "memory_timeline_invalid", "The time zone is not recognised.");
  }
}
