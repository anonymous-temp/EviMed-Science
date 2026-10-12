/**
 * The map's knowledge-base documents: the marks the memories rest on, and the documents of the account's projects beside them.
 *
 * Hidden knowledge:
 *
 * - **A document is read through the knowledge base's own service**, which is the one thing that knows its title, its type and
 *   whether the researcher removed it. A document a memory names that the service no longer has keeps the placeholder the
 *   records source gave it (「一份资料」), and its line stays: a memory resting on a document that is gone is worth seeing.
 * - **Bounded.** One page of each project's newest documents (a project's whole library is not what a map of what is
 *   remembered is for), at most `MAP_DOCUMENT_PROJECTS` projects, and at most `MAP_DOCUMENT_LOOKUPS` documents a memory names
 *   that are not on those pages.
 * - A failed read of one project leaves that project's documents out; the source fails only when every read did.
 *
 * @module memoryMapSources/documents
 */

import { sourceDisplayOf } from "../sourceDisplay.mjs";
import { excerpt, instant, nodeId } from "./common.mjs";
import { drawnLinks } from "./records.mjs";

/** How many projects' documents one read lists. */
export const MAP_DOCUMENT_PROJECTS = 8;
/** How many documents of one project one read lists. */
export const MAP_DOCUMENT_PAGE = 100;
/** How many documents named by a memory, and not on a listed page, are looked up one by one. */
export const MAP_DOCUMENT_LOOKUPS = 30;

/** @param {any} item a source record @returns {import("./common.mjs").MapNode} */
export function documentNode(item) {
  const display = sourceDisplayOf(item);
  return {
    id: nodeId("document", item.id), type: "document", subtype: display.docType, group: display.typeLabel,
    label: excerpt(display.title, 40), at: instant(item.createdAt), state: "current", projectId: item.projectId ?? null,
    open: { kind: "page", href: `/app/files/${encodeURIComponent(item.id)}` },
  };
}

/**
 * @param {{ sources: any, researchMemory?: any }} dependencies `sources`: the knowledge base's `SourceService` (`list`, `get`)
 * @returns {import("./common.mjs").MapSource}
 */
export function createDocumentsSource({ sources, researchMemory = null }) {
  return {
    name: "documents",
    applies: () => Boolean(sources) && typeof sources.list === "function",
    async read(request) {
      const projectIds = (request.projectId ? [request.projectId] : request.projects.map((project) => project.id)).slice(0, MAP_DOCUMENT_PROJECTS);
      const pages = await Promise.allSettled(projectIds.map((projectId) => sources.list(request.user.id, { projectId, limit: MAP_DOCUMENT_PAGE })));
      const read = pages.filter((page) => page.status === "fulfilled");
      if (projectIds.length > 0 && read.length === 0) throw /** @type {PromiseRejectedResult} */ (pages[0]).reason;
      const items = read.flatMap((page) => /** @type {PromiseFulfilledResult<any>} */ (page).value?.items ?? []).filter((item) => item && !item.deletedAt);
      const nodes = items.map(documentNode);
      /** @type {import("./common.mjs").MapEdge[]} */
      const edges = nodes.filter((node) => node.projectId).map((node) => ({ from: node.id, to: nodeId("project", /** @type {string} */ (node.projectId)), type: "belongs-to" }));

      // The documents the memories name that are not on a listed page: looked up one by one, a few.
      if (researchMemory && typeof sources.get === "function") {
        try {
          const links = await drawnLinks(request, researchMemory);
          const listed = new Set(nodes.map((node) => node.id));
          const named = [...new Set(links.sources.filter((/** @type {any} */ link) => link.type === "knowledge_source").map((/** @type {any} */ link) => String(link.id)))]
            .filter((id) => !listed.has(nodeId("document", id))).slice(0, MAP_DOCUMENT_LOOKUPS);
          const found = await Promise.allSettled(named.map((id) => sources.get(request.user.id, id)));
          for (const result of found) {
            if (result.status === "fulfilled" && result.value && !result.value.deletedAt) nodes.push(documentNode(result.value));
          }
        } catch { /* the placeholders stand (principle 19) */ }
      }
      return { nodes, edges };
    },
  };
}
