/**
 * 「时间轴」 — how the capsule grew, derived when it is read.
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

import { cleanMethodDisplay } from "@evimed/domain";

import { HttpError, sendJson } from "./security.mjs";

/** The kinds of event a timeline shows. */
export const MEMORY_TIMELINE_TYPES = Object.freeze(["memory", "run", "method", "feedback"]);

/** How many days the density band covers. */
export const MEMORY_TIMELINE_DENSITY_DAYS = 365;

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const MAX_PAGE = 100;
/** How many memories, the most recently changed, the timeline derives events
 *  from. It read every memory of the account whole on every page — up to
 *  100,000 rows of up to 100,000 characters each (security review 2026-09-20). */
export const MEMORY_TIMELINE_RECORDS = 1000;

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
  if (!at || run.automated === true) return [];
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
 * deleted memory (its record is gone), a delivery adopted or edited.
 * @param {any} event a feedback ledger event
 */
export function feedbackTimelineEvents(event) {
  const at = instant(event?.occurredAt);
  if (!at) return [];
  if (event.trigger === "memory-rejected" && ["deleted", "undone"].includes(event.detail?.reason)) {
    return [{ type: "feedback", id: `feedback:${event.id}`, at, change: `memory-${event.detail.reason}`, kind: event.detail?.kind ?? null }];
  }
  if (event.trigger === "deliverable-adopted" || event.trigger === "deliverable-edited") {
    return [{ type: "feedback", id: `feedback:${event.id}`, at, change: event.trigger, runId: event.runId ?? null }];
  }
  return [];
}

/** The calendar day of an instant in a zone, as YYYY-MM-DD. @param {string} at @param {Intl.DateTimeFormat} format */
function dayOf(at, format) {
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** @param {unknown} value */
function timeZoneOrDefault(value) {
  const zone = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    throw new HttpError(400, "memory_timeline_invalid", "The time zone is not recognised.");
  }
}

/**
 * One page of the timeline, newest first, and the density band over the last
 * year. Each source is read bounded: the memories the account changed most
 * recently (`MEMORY_TIMELINE_RECORDS`, read light), the project's runs, the
 * newest methods and feedback. A source that cannot be read leaves its events
 * out and is named in `missing` rather than failing the page.
 *
 * @param {{ researchMemory: any, agentRuns?: any, feedbackEvents?: any, learning?: any, now?: () => Date }} sources
 * @param {{ id: string }} user @param {any} project
 * @param {{ before?: string | null, limit?: number, timeZone?: string | null }} [options]
 */
export async function memoryTimeline({ researchMemory, agentRuns = null, feedbackEvents = null, learning = null, now = () => new Date() },
  user, project, { before = null, limit = 50, timeZone = null } = {}) {
  const zone = timeZoneOrDefault(timeZone);
  const pageSize = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 50));
  const cursor = before == null || before === "" ? null : instant(String(before));
  if (before && !cursor) throw new HttpError(400, "memory_timeline_invalid", "before is not a time.");
  /** @type {string[]} */
  const missing = [];
  const read = async (/** @type {string} */ name, /** @type {() => Promise<any>} */ operation, /** @type {any} */ fallback) => {
    try { return await operation(); } catch { missing.push(name); return fallback; }
  };

  const records = await read("memory", () => researchMemory.timelineRecords(user.id, { projectId: project.id, limit: MEMORY_TIMELINE_RECORDS }), []);
  const byId = new Map(records.map((/** @type {any} */ record) => [record.id, record]));
  const runs = agentRuns ? await read("runs", () => agentRuns.list(project), []) : [];
  const methods = learning ? await read("methods", async () => (await learning.listMethods(user.id, { limit: 100 })).items ?? [], []) : [];
  const feedback = feedbackEvents ? await read("feedback", async () => (await feedbackEvents.list(user.id, { limit: 200 })).items ?? [], []) : [];

  const events = [
    ...records.flatMap((/** @type {any} */ record) => recordEvents(record, byId)),
    ...runs.flatMap(runEvents),
    ...methods.flatMap(methodEvents),
    ...feedback.flatMap(feedbackTimelineEvents),
  ].sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));

  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const from = new Date(now().getTime() - MEMORY_TIMELINE_DENSITY_DAYS * 86_400_000).toISOString();
  /** @type {Map<string, { day: string, memory: number, run: number, method: number, feedback: number }>} */
  const density = new Map();
  for (const item of events) {
    if (item.at < from) continue;
    const day = dayOf(item.at, format);
    const bucket = density.get(day) ?? { day, memory: 0, run: 0, method: 0, feedback: 0 };
    bucket[/** @type {"memory"|"run"|"method"|"feedback"} */ (item.type)] += 1;
    density.set(day, bucket);
  }

  const page = (cursor ? events.filter((item) => item.at < cursor) : events).slice(0, pageSize + 1);
  const items = page.slice(0, pageSize).map((item) => ({ ...item, day: dayOf(item.at, format) }));
  return {
    items,
    nextBefore: page.length > pageSize ? items.at(-1)?.at ?? null : null,
    density: [...density.values()].sort((left, right) => left.day.localeCompare(right.day)),
    timeZone: zone,
    missing,
  };
}

/**
 * `GET /api/memory/timeline?before=&limit=&timeZone=`.
 *
 * @param {{ config: any, researchMemory: any, agentRuns?: any, feedbackEvents?: any, learning?: any,
 *   context: (req: any, res: any) => Promise<any> }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createMemoryTimelineRoutes({ researchMemory, agentRuns = null, feedbackEvents = null, learning = null, context }) {
  return async function memoryTimelineRoutes(req, res) {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/memory/timeline") return false;
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "The timeline is read-only.");
    if (!researchMemory?.configured) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
    const ctx = await context(req, res);
    sendJson(res, 200, { data: await memoryTimeline({ researchMemory, agentRuns, feedbackEvents, learning }, ctx.user, ctx.project, {
      before: url.searchParams.get("before"),
      limit: Number(url.searchParams.get("limit") ?? 50),
      timeZone: url.searchParams.get("timeZone"),
    }) });
    return true;
  };
}
