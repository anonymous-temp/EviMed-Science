/**
 * The map's time: what happened and when — the events of the memories and the learned methods, and how busy each day was.
 *
 * Hidden knowledge:
 *
 * - **The events are the timeline's** (`memoryTimeline.mjs`): its own functions turn a memory's writing, revisions and
 *   replacement, a learned method, a run and a researcher's correction into events, so the map and the timeline cannot tell two
 *   stories. This source writes nothing and keeps no log of its own.
 * - **`events` lists what a mark can be drawn for** — memories (`memoryEventsOf`, given by whichever source holds the memories)
 *   and methods; a conversation or a correction of a delivery is one tick of a day's activity and is counted in `buckets`, not
 *   listed (a year of conversations is thousands of rows nobody opens).
 * - **`buckets` are always the last year, by day in the researcher's zone**, whatever range the page is narrowed to: the calendar
 *   is the picture of the whole year and a range is what it is read through. Each source counts what it holds and the aggregator
 *   adds the days up, so an account whose memories are in the native engine still has its conversations on the calendar.
 * - This source holds the ledger's side: the conversations, the learned methods and the researcher's corrections. A part that
 *   cannot be read leaves its counts out and is named in `missing`; the rest stands.
 *
 * @module memoryMapSources/activity
 */

import { dayOf, feedbackTimelineEvents, methodEvents, recordEvents, runEvents } from "../memoryTimeline.mjs";
import { excerpt, nodeId } from "./common.mjs";
import { ledgerRuns } from "./runs.mjs";

/** How many days the calendar covers. */
export const MAP_BUCKET_DAYS = 365;
/** The events one read lists at most, newest first. */
export const MAP_EVENT_LIMIT = 500;

/** @param {any} record @returns {string} */
const laneOfRecord = (record) => (record.scope === "project" && record.scopeId ? `project:${record.scopeId}` : "account");

/**
 * The timeline's events of a set of memories, as the map lists them.
 * @param {readonly any[]} records
 * @returns {import("./common.mjs").MapEvent[]}
 */
export function memoryEventsOf(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return records.flatMap((record) => recordEvents(record, byId).map((event) => ({
    id: event.id, at: event.at, type: /** @type {const} */ ("memory"), change: event.change, kind: record.kind,
    ref: nodeId("memory", record.id), lane: laneOfRecord(record), text: excerpt(event.after ?? "", 80),
  })));
}

/**
 * The days, in a zone, and how many events of each kind fell on each: the calendar's counts.
 * @param {readonly { at: string, type: string }[]} events @param {string} timeZone @param {Date} now
 * @returns {{ t: string, memory: number, run: number, method: number, feedback: number }[]}
 */
export function bucketsOf(events, timeZone, now) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const from = new Date(now.getTime() - MAP_BUCKET_DAYS * 86_400_000).toISOString();
  /** @type {Map<string, { t: string, memory: number, run: number, method: number, feedback: number }>} */
  const days = new Map();
  for (const event of events) {
    if (event.at < from || event.at > now.toISOString()) continue;
    const t = dayOf(event.at, format);
    const bucket = days.get(t) ?? { t, memory: 0, run: 0, method: 0, feedback: 0 };
    if (event.type === "memory" || event.type === "run" || event.type === "method" || event.type === "feedback") bucket[event.type] += 1;
    days.set(t, bucket);
  }
  return [...days.values()].sort((left, right) => left.t.localeCompare(right.t));
}

/**
 * @param {{ agentRuns?: any, projectOf?: ((user: any, projectId: string) => Promise<any>) | null, learning?: any, feedbackEvents?: any }} dependencies
 * @returns {import("./common.mjs").MapSource}
 */
export function createActivitySource({ agentRuns = null, projectOf = null, learning = null, feedbackEvents = null }) {
  return {
    name: "activity",
    applies: () => Boolean((agentRuns && projectOf) || learning || feedbackEvents),
    async read(request) {
      /** @type {string[]} */
      const missing = [];
      const attempt = async (/** @type {string} */ name, /** @type {() => Promise<any[]>} */ read) => {
        try { return await read(); } catch { missing.push(name); return []; }
      };
      const [runs, methods, feedback] = await Promise.all([
        agentRuns && projectOf ? attempt("runs", () => ledgerRuns(request, agentRuns, projectOf)) : [],
        learning ? attempt("methods", async () => (await learning.listMethods(request.user.id, { limit: 100 })).items ?? []) : [],
        feedbackEvents ? attempt("feedback", async () => (await feedbackEvents.list(request.user.id, { limit: 200 })).items ?? []) : [],
      ]);
      const methodMarks = request.projectId ? [] : /** @type {any[]} */ (methods.flatMap(methodEvents)).map((event) => ({
        id: event.id, at: event.at, type: /** @type {const} */ ("method"), change: event.change, kind: "method",
        ref: nodeId("method", event.methodId), lane: "account", text: excerpt(event.name ?? "", 80),
      }));
      /** @type {{ at: string, type: string }[]} */
      const counted = [
        ...methods.flatMap((/** @type {any} */ method) => methodEvents(method)),
        ...runs.filter((/** @type {any} */ run) => run.deleted !== true).flatMap((/** @type {any} */ run) => runEvents(run)),
        ...feedback.flatMap((/** @type {any} */ event) => /** @type {any[]} */ (feedbackTimelineEvents(event))),
      ];
      return { events: methodMarks, buckets: bucketsOf(counted, request.timeZone, request.now), missing };
    },
  };
}
