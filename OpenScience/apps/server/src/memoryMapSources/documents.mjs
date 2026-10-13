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
 * - **A file the engine compiled is not a document here.** The wiki and graph files mirrored under `knowledge-base/wiki/**` and
 *   `knowledge-base/kg/**` are documents of the knowledge base's ledger (origin `wiki`), and the knowledge-graph source already
 *   draws each of them, as a page or an entity. Counted again as documents, a project of 6 uploads and 36 compiled files read as
 *   42 documents beside its 13 pages and 6 entities. They are left out of the page and of the one-by-one lookups; the knowledge
 *   base's own 「全部」 list keeps them, which is not this map's to change. Because they are the newest files a compile writes,
 *   they would also fill the page and push the uploads off it, so the page is followed (a few pages) until it holds enough
 *   documents of the researcher's own.
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
/** How many pages of one project are followed to fill `MAP_DOCUMENT_PAGE` documents once the compiled files are left out. */
export const MAP_DOCUMENT_PAGES = 4;

/** Whether a source record is a file the engine compiled and the platform mirrored (a wiki page or a graph entity), not a document. @param {any} item */
export function isCompiledMirror(item) { return sourceDisplayOf(item).origin === "wiki"; }

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
      /** One project's own documents, newest first. @param {string} projectId @returns {Promise<{ items: any[] }>} */
      const documentsOf = async (projectId) => {
        /** @type {any[]} */
        const items = [];
        /** @type {string | null} */
        let cursor = null;
        for (let page = 0; page < MAP_DOCUMENT_PAGES && items.length < MAP_DOCUMENT_PAGE; page += 1) {
          const listed = await sources.list(request.user.id, { projectId, limit: MAP_DOCUMENT_PAGE, ...(cursor ? { cursor } : {}) });
          items.push(...(listed?.items ?? []).filter((/** @type {any} */ item) => item && !item.deletedAt && !isCompiledMirror(item)));
          cursor = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : null;
          if (!cursor) break;
        }
        return { items: items.slice(0, MAP_DOCUMENT_PAGE) };
      };
      const pages = await Promise.allSettled(projectIds.map(documentsOf));
      const read = pages.filter((page) => page.status === "fulfilled");
      if (projectIds.length > 0 && read.length === 0) throw /** @type {PromiseRejectedResult} */ (pages[0]).reason;
      const items = read.flatMap((page) => /** @type {PromiseFulfilledResult<any>} */ (page).value.items);
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
            if (result.status === "fulfilled" && result.value && !result.value.deletedAt && !isCompiledMirror(result.value)) nodes.push(documentNode(result.value));
          }
        } catch { /* the placeholders stand (principle 19) */ }
      }
      return { nodes, edges };
    },
  };
}
