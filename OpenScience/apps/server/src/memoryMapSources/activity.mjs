/**
 * The map's time: what happened and when — the events of the memories and the learned methods.
 *
 * Hidden knowledge:
 *
 * - **The events are the timeline's** (`memoryTimeline.mjs`): its own functions turn a memory's writing, revisions and
 *   replacement and a learned method into events, so the map and the timeline cannot tell two stories. This source writes
 *   nothing and keeps no log of its own.
 * - **`events` lists what a mark can be drawn for** — memories (`memoryEventsOf`, given by whichever source holds the memories)
 *   and methods. A conversation or a correction of a delivery is no event of the map: a year of
 *   conversations is thousands of rows nobody opens.
 * - A part that cannot be read leaves its events out and is named in `missing`; the rest stands.
 *
 * @module memoryMapSources/activity
 */

import { methodEvents, recordEvents } from "../memoryTimeline.mjs";
import { excerpt, nodeId } from "./common.mjs";

/**
 * The timeline's events of a set of memories, as the map lists them.
 * @param {readonly any[]} records
 * @returns {import("./common.mjs").MapEvent[]}
 */
export function memoryEventsOf(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  // A native memory is a file and its `summary` is the file's name, not what changed: its events say the words the file held (the
  // rule the timeline's own read of a native account had, before that read was deleted with its route).
  return records.flatMap((record) => recordEvents(record.uri ? { ...record, summary: "" } : record, byId).map((event) => ({
    id: event.id, at: event.at, type: /** @type {const} */ ("memory"), change: event.change,
    ref: nodeId("memory", record.id), text: excerpt(event.after ?? "", 80),
  })));
}

/**
 * @param {{ learning?: any }} dependencies
 * @returns {import("./common.mjs").MapSource}
 */
export function createActivitySource({ learning = null }) {
  return {
    name: "activity",
    applies: (request) => Boolean(learning) && request.projectId === null,
    async read(request) {
      /** @type {string[]} */
      const missing = [];
      /** @type {any[]} */
      let methods = [];
      try { methods = (await learning.listMethods(request.user.id, { limit: 100 })).items ?? []; } catch { missing.push("methods"); }
      const events = /** @type {any[]} */ (methods.flatMap(methodEvents)).map((event) => ({
        id: event.id, at: event.at, type: /** @type {const} */ ("method"), change: event.change,
        ref: nodeId("method", event.methodId), text: excerpt(event.name ?? "", 80),
      }));
      return { events, missing };
    },
  };
}
