/**
 * The map's topics: what the account's memories are about, as the model grouped them and the researcher corrected them
 * (`memoryTopics.mjs`).
 *
 * Reading never calls the model and never writes: a grouping that is out of date is served as it is with `topicsStatus: "stale"`,
 * and the page asks for a new one (`POST /api/memory/topics/refresh`). Topics are the account's, not a project's, so they are read
 * over all the account's memories and then narrowed to the marks the map holds. A topic's members are the ids of marks
 * (`memory:<id>`), and `weight` and `trend` are what the page ranks them by.
 *
 * @module memoryMapSources/topics
 */

import { MAP_RECORD_LIMIT, drawable } from "./records.mjs";
import { nodeId } from "./common.mjs";

/**
 * @param {{ topics: import("../memoryTopics.mjs").MemoryTopics | null, researchMemory: any, accountRecords?: ((userId: string) => Promise<any[]>) | null }} dependencies
 *   `accountRecords`: the account's memories from whichever engine holds them, as the map draws them; the store's own rows by default.
 *   An account's topics are the same view whichever engine keeps its memories.
 * @returns {import("./common.mjs").MapSource}
 */
export function createTopicsSource({ topics, researchMemory, accountRecords = null }) {
  const recordsOf = accountRecords ?? ((/** @type {string} */ userId) => researchMemory.mapRecords(userId, { projectId: null, limit: MAP_RECORD_LIMIT }));
  return {
    name: "topics",
    applies: () => Boolean(topics?.configured) && (typeof accountRecords === "function" || typeof researchMemory?.mapRecords === "function"),
    async read(request) {
      const all = await request.memo("records:account", () => recordsOf(request.user.id));
      const found = await /** @type {NonNullable<typeof topics>} */ (topics).read(request.user.id, all.filter(drawable));
      return {
        facets: {
          topics: found.topics.map((topic) => ({
            id: topic.id, label: topic.label, weight: topic.weight, trend: topic.trend,
            members: topic.members.map((id) => nodeId("memory", id)),
          })),
        },
        facts: { topicsStatus: found.status },
      };
    },
  };
}
