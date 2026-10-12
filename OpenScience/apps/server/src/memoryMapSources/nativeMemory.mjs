/**
 * THE SEAM FOR THE NATIVE MEMORY ENGINE.
 *
 * An account switched to OpenViking's native memory engine keeps its memories as files, not as rows of `evimed_memory`. The map
 * must draw them exactly as it draws a PostgreSQL account's, so this source asks a reader for the account's memories in the one
 * shape the store already speaks and hands them to the same function the PostgreSQL source uses (`recordsContribution`): the marks,
 * the lines, the lineages, the radar and the events then cannot differ between the two engines.
 *
 * What the package that builds the native engine supplies is `readMemories` — and nothing else:
 *
 *   readMemories(request: MapSourceRequest) => Promise<NativeMemories>
 *
 *   NativeMemories = {
 *     records: NativeRecord[],       // the account's memories, newest change first, at most MAP_RECORD_LIMIT
 *     sources?: NativeSource[],      // what each rests on
 *     conflicts?: NativeConflict[],  // the disagreements still open
 *     usage?: Record<string, { count: number }>,   // how often each was handed to a conversation
 *   }
 *   NativeRecord = {                 // the shape of `publicRecord` in researchMemory.mjs, the fields the map reads
 *     id: string,                    // the memory's stable id; becomes `memory:<id>`
 *     scope: "user" | "project", scopeId: string,
 *     kind: string,                  // one of MEMORY_KINDS; the memory page's vocabulary
 *     key: string, value: string, summary: string,
 *     status: "active" | "pending" | "superseded",   // a forgotten memory is not handed over
 *     importance: number,            // 0..1
 *     sensitive: boolean,            // true is never drawn
 *     createdAt: string, updatedAt: string, validFrom: string | null, invalidSince: string | null, expiresAt: string | null,
 *     supersededBy: string | null,   // the id of the memory that replaced this one
 *     revisions: { version: number, value: string, summary: string, status: string, changedAt: string | null, by?: string, runId?: string }[],
 *   }
 *   NativeSource   = { recordId: string, type: "knowledge_source" | "doi" | "evidence_card" | "frontier_item", id: string, state: "current" | "changed" | "retracted" | "expired" | "unknown", linkedAt: string | null }
 *   NativeConflict = { recordId: string, otherId: string, recordStatus?: string, otherStatus?: string }
 *
 * Until it is wired — `readMemories` absent — this source stands aside and contributes nothing, so a deployment with no native
 * engine behaves exactly as before. Once wired, a throw is that account's `missing: ["native-memory"]` and nothing else. The
 * source applies only to an account whose `request.engine` is `"native"`; the PostgreSQL source stands aside for that account.
 * Back-office fields (who wrote a memory, how sure it is) are not part of this interface and never reach the document.
 *
 * @module memoryMapSources/nativeMemory
 */

import { MAP_RECORD_LIMIT, recordsContribution } from "./records.mjs";

/**
 * @typedef {object} NativeMemories
 * @property {any[]} records @property {any[]} [sources] @property {any[]} [conflicts] @property {Record<string, { count: number }>} [usage]
 */

/**
 * @param {{ readMemories?: ((request: import("./common.mjs").MapSourceRequest) => Promise<NativeMemories>) | null }} [dependencies]
 * @returns {import("./common.mjs").MapSource}
 */
export function createNativeMemorySource({ readMemories = null } = {}) {
  return {
    name: "native-memory",
    applies: (request) => request.engine === "native" && typeof readMemories === "function",
    async read(request) {
      const held = await /** @type {NonNullable<typeof readMemories>} */ (readMemories)(request);
      const records = (held?.records ?? []).slice(0, MAP_RECORD_LIMIT)
        .filter((record) => !request.projectId || (record.scope === "project" && record.scopeId === request.projectId));
      return recordsContribution(records, { sources: held?.sources ?? [], conflicts: held?.conflicts ?? [], usage: held?.usage ?? {} },
        { now: request.now, timeZone: request.timeZone });
    },
  };
}
