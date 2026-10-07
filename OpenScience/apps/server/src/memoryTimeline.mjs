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

import { DOCUMENT_MEMORY_LAYER } from "./derivedMemory.mjs";
import { LEARNED_METHOD_RECORD_TYPE } from "./learningService.mjs";
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

  const eligible = cursor ? events.filter((item) => item.at < cursor) : events;
  // A page never ends inside one instant. The next page is "strictly before
  // the last time shown", so an event stamped in the same millisecond as the
  // page's last one and cut off by the page size was on neither page. The
  // page runs on to the end of that instant instead.
  let end = Math.min(pageSize, eligible.length);
  while (end < eligible.length && eligible[end].at === eligible[end - 1].at) end += 1;
  const items = eligible.slice(0, end).map((item) => ({ ...item, day: dayOf(item.at, format) }));
  return {
    items,
    nextBefore: end < eligible.length ? items.at(-1)?.at ?? null : null,
    density: [...density.values()].sort((left, right) => left.day.localeCompare(right.day)),
    timeZone: zone,
    missing,
  };
}

/**
 * 「成长」 — how much of the researcher EviMed has come to hold, over time: the
 * capsule page's one chart (the owner's timeline of change and growth,
 * 2026-08-23).
 *
 * Hidden knowledge: the line counts exactly the rows the capsule page lists —
 * the memories (never a run summary), the learned methods, and the notes in the
 * researcher's own capsules outside the document layer — and it counts each
 * from the day it began to hold until the day it stopped: forgotten, replaced,
 * or a method stood down. So the line's last point is what the page shows
 * today, a fact that was replaced is carried on by the fact that replaced it
 * rather than dropping out and coming back, and a reset, which deletes, takes
 * its history with it. Nothing here is a counter of use or a pipeline state;
 * the only other things it names are two kinds of moment the researcher can
 * see on the page — a method learned, a capsule received.
 *
 * Every source is read whole, never a page of it: the memories grouped by day
 * in the database, the methods and notes paged through to the end under a
 * bound far above any account (`MEMORY_GROWTH_DOCUMENTS`). The browser used to
 * be the only place such a line could be drawn, from lists capped at 50 and
 * 300. A source that cannot be read fails the read: a line with a third of the
 * capsule missing would look exactly like a true one.
 */

/** Weekly points while the history is at most this many weeks long; months after that. */
export const MEMORY_GROWTH_WEEKS = 26;
/** The furthest back the line reaches, in months. */
export const MEMORY_GROWTH_MONTHS = 24;
/** The documents one growth read pages through per kind — an account's methods number in the tens. */
export const MEMORY_GROWTH_DOCUMENTS = 5000;
/** The moments a read returns at most. */
export const MEMORY_GROWTH_MOMENTS = 50;

/** @param {string} day YYYY-MM-DD @param {number} count */
function addDays(day, count) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

/** The Monday a day's week starts on. @param {string} day */
function weekOf(day) {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

/** The first of a day's month, moved by whole months. @param {string} day @param {number} [count] */
function monthOf(day, count = 0) {
  const at = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + count);
  return at.toISOString().slice(0, 10);
}

/** Whole weeks between two Mondays. @param {string} from @param {string} to */
function weeksBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000));
}

/**
 * Where each point of the line starts: weeks for a short history, months for
 * a long one, and — when the whole history fits — one point before the first
 * memory, at zero, so a capsule a week old is a line that starts somewhere
 * rather than a lone dot.
 * @param {string} first the day the first row began @param {string} today
 * @returns {{ unit: "week" | "month", starts: string[] }}
 */
export function growthBuckets(first, today) {
  const firstWeek = weekOf(first);
  const thisWeek = weekOf(today);
  if (weeksBetween(firstWeek, thisWeek) < MEMORY_GROWTH_WEEKS) {
    const starts = [];
    for (let start = addDays(firstWeek, -7); start <= thisWeek; start = addDays(start, 7)) starts.push(start);
    return { unit: "week", starts };
  }
  const starts = [];
  for (let start = monthOf(first, -1); start <= monthOf(today); start = monthOf(start, 1)) starts.push(start);
  return { unit: "month", starts: starts.slice(-(MEMORY_GROWTH_MONTHS + 1)) };
}

/** Every document of a kind the filter matches, paged to the end under the bound.
 *  @param {any} documents @param {string} userId @param {string} kind @param {{ filter?: object, fields?: object }} options */
async function everyDocument(documents, userId, kind, { filter = {}, fields } = {}) {
  /** @type {any[]} */
  const items = [];
  /** @type {string | null} */
  let cursor = null;
  do {
    const page = await documents.list(userId, kind, { limit: 100, cursor, filter, ...(fields ? { fields } : {}) });
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor && items.length < MEMORY_GROWTH_DOCUMENTS);
  return items;
}

/**
 * The line and its moments, in the researcher's zone.
 *
 * @param {{ researchMemory: any, learning?: any, capsules?: any, now?: () => Date }} sources
 * @param {{ id: string }} user
 * @param {{ timeZone?: string | null }} [options]
 * @returns {Promise<{ unit: "week" | "month" | null, first: string | null, fromStart: boolean, points: Array<{ start: string, known: number }>,
 *   moments: Array<{ day: string, kind: "method" | "capsule", title: string }>, timeZone: string }>}
 */
export async function memoryGrowth({ researchMemory, learning = null, capsules = null, now = () => new Date() }, user, { timeZone = null } = {}) {
  const zone = timeZoneOrDefault(timeZone);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (/** @type {unknown} */ value) => {
    const at = instant(value);
    return at ? dayOf(at, format) : null;
  };
  /** @type {Map<string, { added: number, ended: number }>} */
  const changes = new Map();
  const note = (/** @type {string | null} */ at, /** @type {"added" | "ended"} */ field, count = 1) => {
    if (!at || count <= 0) return;
    const entry = changes.get(at) ?? { added: 0, ended: 0 };
    entry[field] += count;
    changes.set(at, entry);
  };

  for (const row of await researchMemory.growthDays(user.id, { timeZone: zone })) {
    note(row.day, "added", row.added);
    note(row.day, "ended", row.ended);
  }

  /** @type {Array<{ day: string, kind: "method" | "capsule", title: string }>} */
  const moments = [];
  if (learning?.documents) {
    const methods = await everyDocument(learning.documents, user.id, "method", {
      filter: { recordType: LEARNED_METHOD_RECORD_TYPE },
      fields: { status: true, statusChangedAt: true, origin: true, provenance: true, display: true, frontmatter: true },
    });
    for (const method of methods) {
      const payload = method.payload ?? {};
      const began = day(method.createdAt);
      note(began, "added");
      if (payload.status === "retired") note(day(payload.statusChangedAt) ?? day(method.updatedAt), "ended");
      if (began && (payload.origin ?? payload.provenance?.origin) === "inferred") {
        moments.push({ day: began, kind: "method", title: excerpt(cleanMethodDisplay(payload.display)?.title ?? payload.frontmatter?.name ?? "", 80) });
      }
    }
  }
  if (capsules?.documents) {
    const all = await everyDocument(capsules.documents, user.id, "capsule", { fields: { imported: true, title: true, transfer: true } });
    for (const capsule of all) {
      if (capsule.payload?.imported !== true) continue;
      const received = day(capsule.payload.transfer?.importedAt) ?? day(capsule.createdAt);
      if (received) moments.push({ day: received, kind: "capsule", title: excerpt(capsule.payload.title ?? "", 80) });
    }
    // The researcher's own capsules' notes, as the page lists them: approved,
    // outside the document layer (a document's facts are the document's).
    for (const capsule of all.filter((item) => item.payload?.imported !== true)) {
      const notes = await everyDocument(capsules.documents, user.id, "fact", { filter: { capsuleId: capsule.id }, fields: { status: true, layer: true } });
      for (const item of notes) {
        const status = item.payload?.status;
        if (item.payload?.layer === DOCUMENT_MEMORY_LAYER || (status !== "approved" && status !== "retired")) continue;
        note(day(item.createdAt), "added");
        if (status === "retired") note(day(item.updatedAt), "ended");
      }
    }
  }

  const days = [...changes.keys()].filter((key) => (changes.get(key)?.added ?? 0) > 0).sort();
  const first = days[0] ?? null;
  if (!first) return { unit: null, first: null, fromStart: false, points: [], moments: [], timeZone: zone };
  const today = dayOf(now().toISOString(), format);
  const { unit, starts } = growthBuckets(first, today < first ? first : today);
  const ordered = [...changes.entries()].sort(([left], [right]) => left.localeCompare(right));
  let known = 0;
  let cursor = 0;
  const points = starts.map((start, index) => {
    // A point is what held at the end of its week or month: everything that
    // began on or before that day, less everything that had stopped.
    const end = index + 1 < starts.length ? addDays(starts[index + 1], -1) : (today < first ? first : today);
    while (cursor < ordered.length && ordered[cursor][0] <= end) {
      known += ordered[cursor][1].added - ordered[cursor][1].ended;
      cursor += 1;
    }
    return { start, known: Math.max(0, known) };
  });
  return {
    unit,
    first,
    // Whether the first point is the zero before the first memory: the line
    // starts at the start, rather than partway through a longer history.
    fromStart: starts[0] < first,
    points,
    moments: moments
      .filter((moment) => moment.day >= starts[0] && moment.title)
      .sort((left, right) => left.day.localeCompare(right.day))
      .slice(-MEMORY_GROWTH_MOMENTS),
    timeZone: zone,
  };
}

/**
 * 「哪天学会了什么」: the growth page's list under its line — one day at a time,
 * what the platform learned for the researcher and when, newest first.
 *
 * Hidden knowledge: like the line above it, this writes nothing and keeps no
 * log of its own. Every row is read from the record that already says it: a
 * method or a handbook has the day it was first written, and each later body it
 * held is a saved revision with its own day (`history`); the day the capsule
 * began to remember is the first day `growthDays` counts a memory. Only what is
 * in force is listed — a method or handbook the researcher stopped is under
 * 已忘记的内容, not in the story of what was learned — and the facts the
 * researcher said or the platform noted are not itemised: the line counts them,
 * and a day with forty of them is not forty rows.
 *
 * A source that cannot be read leaves its rows out and the read still answers
 * (principle 19): the list is a label on the growth, never a reason the page
 * does not open.
 */

/** How many rows one read returns at most, newest first. */
export const MEMORY_LEARNED_ITEMS = 200;
/** How many methods and handbooks have their earlier bodies read: each is one history read. */
export const MEMORY_LEARNED_HISTORIES = 100;

/**
 * @param {{ researchMemory: any, learning?: any, handbooks?: any }} sources
 * @param {{ id: string }} user
 * @param {{ timeZone?: string | null }} [options]
 * @returns {Promise<{ days: Array<{ day: string, items: Array<{ kind: "start" | "learned" | "improved", what: "method" | "handbook" | null, id: string | null, title: string }> }>, timeZone: string }>}
 */
export async function memoryLearned({ researchMemory, learning = null, handbooks = null }, user, { timeZone = null } = {}) {
  const zone = timeZoneOrDefault(timeZone);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (/** @type {unknown} */ value) => {
    const at = instant(value);
    return at ? dayOf(at, format) : null;
  };
  /** @type {Array<{ day: string, kind: "start" | "learned" | "improved", what: "method" | "handbook" | null, id: string | null, title: string }>} */
  const rows = [];
  const add = (/** @type {string | null} */ at, /** @type {"start" | "learned" | "improved"} */ kind, /** @type {"method" | "handbook" | null} */ what,
    /** @type {string | null} */ id, /** @type {string} */ title) => {
    if (at && (kind === "start" || title)) rows.push({ day: at, kind, what, id, title });
  };
  /** One method's or handbook's days: when it was first written, then when each later body was. */
  const lifeOf = async (/** @type {() => Promise<any[]>} */ history, /** @type {string | null} */ began, /** @type {"method" | "handbook"} */ what,
    /** @type {string} */ id, /** @type {string} */ title, /** @type {boolean} */ maybeAmended) => {
    add(began, "learned", what, id, title);
    if (!maybeAmended) return;
    try {
      const versions = [...(await history())].sort((left, right) => String(left.at).localeCompare(String(right.at)));
      for (const version of versions.slice(1)) add(day(version.at), "improved", what, id, excerpt(version.title ?? title, 80));
    } catch { /* the story keeps the day it began */ }
  };

  try {
    const first = (await researchMemory.growthDays(user.id, { timeZone: zone })).filter((/** @type {any} */ row) => row.added > 0).map((/** @type {any} */ row) => row.day).sort()[0];
    add(first ?? null, "start", null, null, "");
  } catch { /* no first day: the list starts at what was learned */ }

  let histories = 0;
  if (learning?.documents) {
    try {
      const methods = await everyDocument(learning.documents, user.id, "method", {
        filter: { recordType: LEARNED_METHOD_RECORD_TYPE, status: "approved" },
        fields: { display: true, frontmatter: true, bodyVersion: true },
      });
      for (const method of methods) {
        const payload = method.payload ?? {};
        const title = excerpt(cleanMethodDisplay(payload.display)?.title ?? payload.frontmatter?.name ?? "", 80);
        const amended = Number(payload.bodyVersion) > 1 && histories < MEMORY_LEARNED_HISTORIES;
        if (amended) histories += 1;
        await lifeOf(() => learning.history(user.id, method.id), day(method.createdAt), "method", String(method.id), title, amended);
      }
    } catch { /* the methods' days are left out */ }
  }
  if (handbooks) {
    try {
      /** @type {any[]} */
      const held = [];
      /** @type {string | null} */
      let cursor = null;
      do {
        const page = await handbooks.list(user.id, { status: "active", limit: 100, cursor });
        held.push(...(page.items ?? []));
        cursor = page.nextCursor ?? null;
      } while (cursor && held.length < MEMORY_GROWTH_DOCUMENTS);
      for (const handbook of held) {
        const payload = handbook.payload ?? {};
        const title = excerpt(cleanMethodDisplay(payload.display)?.title ?? payload.frontmatter?.name ?? "", 80);
        const amended = Number(payload.version) > 1 && histories < MEMORY_LEARNED_HISTORIES;
        if (amended) histories += 1;
        await lifeOf(() => handbooks.history(user.id, handbook.id), day(payload.createdAt) ?? day(handbook.createdAt), "handbook", String(handbook.id), title, amended);
      }
    } catch { /* the handbooks' days are left out */ }
  }

  const kindRank = { start: 0, learned: 1, improved: 2 };
  rows.sort((left, right) => right.day.localeCompare(left.day) || kindRank[left.kind] - kindRank[right.kind] || left.title.localeCompare(right.title, "zh"));
  /** @type {Map<string, any[]>} */
  const byDay = new Map();
  for (const row of rows.slice(0, MEMORY_LEARNED_ITEMS)) {
    const { day: at, ...item } = row;
    byDay.set(at, [...(byDay.get(at) ?? []), item]);
  }
  return { days: [...byDay.entries()].map(([at, items]) => ({ day: at, items })), timeZone: zone };
}

/**
 * `GET /api/memory/timeline?before=&limit=&timeZone=`,
 * `GET /api/memory/growth?timeZone=` and `GET /api/memory/learned?timeZone=`.
 *
 * @param {{ config: any, researchMemory: any, agentRuns?: any, feedbackEvents?: any, learning?: any, capsules?: any, handbooks?: any,
 *   context: (req: any, res: any) => Promise<any> }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createMemoryTimelineRoutes({ researchMemory, agentRuns = null, feedbackEvents = null, learning = null, capsules = null, handbooks = null, context }) {
  return async function memoryTimelineRoutes(req, res) {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/memory/timeline" && url.pathname !== "/api/memory/growth" && url.pathname !== "/api/memory/learned") return false;
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "The timeline is read-only.");
    if (!researchMemory?.configured) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
    const ctx = await context(req, res);
    if (url.pathname === "/api/memory/learned") {
      sendJson(res, 200, { data: await memoryLearned({ researchMemory, learning, handbooks }, ctx.user, { timeZone: url.searchParams.get("timeZone") }) });
      return true;
    }
    if (url.pathname === "/api/memory/growth") {
      sendJson(res, 200, { data: await memoryGrowth({ researchMemory, learning, capsules }, ctx.user, {
        timeZone: url.searchParams.get("timeZone"),
      }) });
      return true;
    }
    sendJson(res, 200, { data: await memoryTimeline({ researchMemory, agentRuns, feedbackEvents, learning }, ctx.user, ctx.project, {
      before: url.searchParams.get("before"),
      limit: Number(url.searchParams.get("limit") ?? 50),
      timeZone: url.searchParams.get("timeZone"),
    }) });
    return true;
  };
}
