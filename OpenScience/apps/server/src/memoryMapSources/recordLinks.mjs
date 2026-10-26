/**
 * What one memory is tied to, for the 关联 section of the drawer both the memory page and the map open (`GET /api/memory/records/:id/links`):
 * what it rests on. (The section also had what a memory replaced and what replaced it, what it disagreed with and the conversations it
 * was handed to, read from the legacy engine's PostgreSQL records; a file of the engine has none of those, and the answer keeps their keys
 * empty for the page that reads them.)
 *
 * Hidden knowledge: this is the drawer's, not the map's — the drawer is the one place every mark of the map and every row of the
 * memory page ends, so the relations are read when it opens and never carried for every row.
 *
 * @module memoryMapSources/recordLinks
 */

import { excerpt } from "./common.mjs";

/** The sources one memory lists. */
export const LINK_SOURCES = 8;

/**
 * The section for a memory file (`NativeMemoryStore`): what it rests on is the sources it names, as the overlay recorded them. The
 * engine keeps no replacement, no disagreement and no record of which conversation was handed what, so the other three are empty —
 * said here rather than guessed.
 * @param {{ nativeMemory: { sourceLinks: (userId: string, id: string) => Promise<{ type: string, id: string, state: string }[]> } }} dependencies
 */
export function createNativeRecordLinks({ nativeMemory }) {
  return async function nativeRecordLinks(/** @type {{ id: string }} */ user, /** @type {string} */ recordId) {
    const links = await nativeMemory.sourceLinks(user.id, recordId);
    return {
      rests: links.slice(0, LINK_SOURCES).map((link) => ({
        type: String(link.type), id: String(link.id), state: String(link.state), title: link.type === "doi" ? excerpt(link.id, 60) : null,
        href: link.type === "knowledge_source" ? `/app/files/${encodeURIComponent(link.id)}` : link.type === "doi" ? `https://doi.org/${link.id}` : null,
      })),
      replaced: [], replacedBy: null, conflicts: [], usedIn: [],
    };
  };
}
