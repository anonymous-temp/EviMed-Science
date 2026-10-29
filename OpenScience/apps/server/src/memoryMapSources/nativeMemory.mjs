/**
 * The map's memory source: the account's memory files in OpenViking's native engine.
 *
 * An account's memories are files, not rows: this source asks a reader for them in the one shape the memory page's store speaks
 * and hands them to `recordsContribution` (`records.mjs`), so the marks, the lines, the radar and the events cannot differ from what the
 * page lists. (A PostgreSQL source over the legacy engine's `evimed_memory.records` stood beside it until that engine was deleted,
 * 2026-10-25.)
 *
 * What the store supplies is `readMemories` — and nothing else:
 *
 *   readMemories(request: MapSourceRequest) => Promise<NativeMemories>
 *
 *   NativeMemories = {
 *     records: NativeRecord[],       // the account's memories, newest change first, at most MAP_RECORD_LIMIT
 *     sources?: NativeSource[],      // what each rests on
 *     conflicts?: NativeConflict[],  // the disagreements still open (a file of the engine has none)
 *     usage?: Record<string, { count: number }>,   // how often each was handed to a conversation (the engine counts none)
 *   }
 *   NativeRecord = {                 // the shape of `publicRecord` in `nativeMemoryStore.mjs`, the fields the map reads
 *     id: string,                    // the memory's stable id; becomes `memory:<id>`
 *     scope: "user" | "project", scopeId: string,
 *     kind: string,                  // one of MEMORY_KINDS (`memoryKinds.mjs`); the memory page's vocabulary
 *     key: string, value: string, summary: string,
 *     status: "active" | "pending" | "superseded",   // a forgotten memory is not handed over
 *     importance: number,            // 0..1
 *     sensitive: boolean,            // true is never drawn
 *     createdAt: string, updatedAt: string, validFrom: string | null, invalidSince: string | null, expiresAt: string | null,
 *     supersededBy: string | null,   // the id of the memory that replaced this one
 *     revisions: { version: number, value: string, summary: string, status: string, changedAt: string | null, by?: string, runId?: string }[],
 *   }
 *   NativeSource   = { recordId: string, type: "knowledge_source" | "doi", id: string, state: "current" | "changed" | "retracted" | "expired" | "unknown", linkedAt: string | null }
 *   NativeConflict = { recordId: string, otherId: string, recordStatus?: string, otherStatus?: string }
 *
 * Without `readMemories` (a deployment with no memory engine) this source stands aside and contributes nothing. Once wired, a throw is
 * that account's `missing: ["native-memory"]` and nothing else. Back-office fields (who wrote a memory, how sure it is) are not part of
 * this interface and never reach the document.
 *
 * @module memoryMapSources/nativeMemory
 */

import { recencyWeight } from "./common.mjs";
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
    applies: () => typeof readMemories === "function",
    async read(request) {
      const held = await /** @type {NonNullable<typeof readMemories>} */ (readMemories)(request);
      const records = (held?.records ?? []).slice(0, MAP_RECORD_LIMIT)
        .filter((record) => !request.projectId || (record.scope === "project" && record.scopeId === request.projectId));
      // A file of the engine has no importance and no use counter of its own (every one reads 0.5 and none is counted), so a mark's size
      // says what the engine can: how recently the file was written.
      return recordsContribution(records, { sources: held?.sources ?? [], conflicts: held?.conflicts ?? [], usage: held?.usage ?? {} },
        { now: request.now, timeZone: request.timeZone, weigh: (record) => recencyWeight(record.updatedAt ?? record.createdAt ?? null, request.now) });
    },
  };
}
