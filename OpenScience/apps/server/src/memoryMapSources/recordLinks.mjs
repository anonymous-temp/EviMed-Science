/**
 * What one memory is tied to, for the 关联 section of the drawer both the memory page and the map open (`GET /api/memory/records/:id/links`):
 * what it rests on, what it replaced and what replaced it, what it disagrees with, and the conversations it was handed to.
 *
 * Hidden knowledge: this is the drawer's, not the map's — the drawer is the one place every mark of the map and every row of the
 * memory page ends, so the relations are read when it opens and never carried for every row. Each relation is read from the record
 * that owns it (`record_sources`, `superseded_by`, `record_conflicts`, the run ledger's `recalledMemories`), and a part that cannot be
 * read is left out and the rest stands (principle 19). A sensitive neighbour is named by its id and carries no words, as everywhere.
 * The number of times a memory was used is the platform's bookkeeping and is not here: the drawer says which conversations, not how often.
 *
 * @module memoryMapSources/recordLinks
 */

import { sourceDisplayOf } from "../sourceDisplay.mjs";
import { excerpt, instant } from "./common.mjs";

/** The conversations one memory lists, newest first. */
export const LINK_CONVERSATIONS = 6;
/** The sources one memory lists. */
export const LINK_SOURCES = 8;
/** The projects whose ledgers are read for a memory that belongs to the account rather than to a project. */
export const LINK_PROJECTS = 12;

/** @param {any} record */
function neighbour(record) {
  return {
    id: String(record.id), kind: String(record.kind), status: String(record.status), sensitive: Boolean(record.sensitive),
    text: record.sensitive ? "" : excerpt(record.summary || record.value, 120),
    from: instant(record.validFrom) ?? instant(record.createdAt), to: instant(record.invalidSince),
  };
}

/**
 * @param {{ researchMemory: any, sources?: any, agentRuns?: any, listProjects?: ((user: any) => Promise<{ id: string }[]>) | null,
 *   projectOf?: ((user: any, projectId: string) => Promise<any>) | null }} dependencies
 * @returns {(user: { id: string }, record: any) => Promise<{
 *   rests: { type: string, id: string, state: string, title: string | null, href: string | null }[],
 *   replaced: ReturnType<typeof neighbour>[], replacedBy: ReturnType<typeof neighbour> | null, conflicts: ReturnType<typeof neighbour>[],
 *   usedIn: { sessionId: string, projectId: string, title: string, at: string | null }[] }>}
 */
export function createRecordLinks({ researchMemory, sources = null, agentRuns = null, listProjects = null, projectOf = null }) {
  return async function recordLinks(user, record) {
    const [links, around, used] = await Promise.all([
      Promise.resolve().then(() => researchMemory.sourceLinks(user.id, record.id)).catch(() => []),
      Promise.resolve().then(() => researchMemory.recordNeighbours(user.id, record.id)).catch(() => ({ replaced: [], replacedBy: null, conflicts: [] })),
      Promise.resolve().then(async () => {
        if (!agentRuns || !projectOf) return [];
        const ids = record.scope === "project" && record.scopeId ? [record.scopeId]
          : listProjects ? (await listProjects(user)).map((project) => project.id).slice(0, LINK_PROJECTS) : [];
        const found = await Promise.allSettled(ids.map(async (projectId) => {
          const project = await projectOf(user, projectId);
          return (await agentRuns.researcherRuns(project)).filter((/** @type {any} */ run) => run.deleted !== true
            && Array.isArray(run.recalledMemories) && run.recalledMemories.some((/** @type {any} */ item) => item?.id === record.id))
            .map((/** @type {any} */ run) => ({ sessionId: String(run.sessionId ?? ""), projectId, title: excerpt(run.title || run.question, 60), at: instant(run.finishedAt ?? run.startedAt) }));
        }));
        /** @type {Map<string, { sessionId: string, projectId: string, title: string, at: string | null }>} */
        const bySession = new Map();
        for (const result of found) {
          if (result.status !== "fulfilled") continue;
          for (const item of result.value) if (item.sessionId && !bySession.has(item.sessionId)) bySession.set(item.sessionId, item);
        }
        return [...bySession.values()].sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? ""))).slice(0, LINK_CONVERSATIONS);
      }).catch(() => []),
    ]);
    const rests = await Promise.all(links.slice(0, LINK_SOURCES).map(async (/** @type {any} */ link) => {
      let title = null;
      if (link.type === "knowledge_source" && sources && typeof sources.get === "function") {
        try { title = excerpt(sourceDisplayOf(await sources.get(user.id, link.id)).title, 60) || null; } catch { title = null; }
      } else if (link.type === "doi") title = excerpt(link.id, 60);
      return {
        type: String(link.type), id: String(link.id), state: String(link.state), title,
        href: link.type === "knowledge_source" ? `/app/files/${encodeURIComponent(link.id)}` : link.type === "doi" ? `https://doi.org/${link.id}` : null,
      };
    }));
    return {
      rests,
      replaced: (around.replaced ?? []).map(neighbour),
      replacedBy: around.replacedBy ? neighbour(around.replacedBy) : null,
      conflicts: (around.conflicts ?? []).map(neighbour),
      usedIn: used,
    };
  };
}
