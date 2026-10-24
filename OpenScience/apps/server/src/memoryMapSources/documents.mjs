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
 * - **The inventory is the list's own, not the page's.** What the overview says about the knowledge (how many documents, of what
 *   kind, in which project) is `facets.documentTypes` and `facets.projectDocuments`, counted by the knowledge base for the whole of
 *   each project (`list`'s `counts`, compiled files left out), so a library of three hundred is three hundred and not the hundred the
 *   page of marks holds. The marks and the days (`buckets[].document`, one for each document added) are what the page read.
 * - A failed read of one project leaves that project's documents out; the source fails only when every read did.
 *
 * @module memoryMapSources/documents
 */

import { SOURCE_KINDS } from "@evimed/domain";

import { sourceDisplayOf } from "../sourceDisplay.mjs";
import { bucketsOf } from "./activity.mjs";
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
 * How many documents one project holds under each chip, compiled files left out: the list's own inventory of the whole scope (`counts`),
 * else — a list with no database behind it has none — what the page read.
 * @param {any} listed the first page of `SourceService.list` @param {readonly any[]} items the documents read
 * @returns {Map<string, number>} chip id → count, for the chips with documents
 */
export function documentKindCounts(listed, items) {
  const counts = listed?.counts && typeof listed.counts === "object" ? listed.counts : null;
  /** @type {Map<string, number>} */
  const tally = new Map();
  if (counts) {
    for (const kind of SOURCE_KINDS) {
      const count = Number(counts[kind.id]);
      if (kind.id !== "wiki" && Number.isFinite(count) && count > 0) tally.set(kind.id, Math.trunc(count));
    }
    return tally;
  }
  for (const item of items) {
    const kind = sourceDisplayOf(item).kind;
    if (kind !== "wiki") tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  return tally;
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
      /** One project's own documents, newest first, and how many of each chip the project holds. @param {string} projectId @returns {Promise<{ projectId: string, items: any[], kinds: Map<string, number> }>} */
      const documentsOf = async (projectId) => {
        /** @type {any[]} */
        const items = [];
        /** @type {any} */
        let first = null;
        /** @type {string | null} */
        let cursor = null;
        for (let page = 0; page < MAP_DOCUMENT_PAGES && items.length < MAP_DOCUMENT_PAGE; page += 1) {
          const listed = await sources.list(request.user.id, { projectId, limit: MAP_DOCUMENT_PAGE, ...(cursor ? { cursor } : {}) });
          if (page === 0) first = listed;
          items.push(...(listed?.items ?? []).filter((/** @type {any} */ item) => item && !item.deletedAt && !isCompiledMirror(item)));
          cursor = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : null;
          if (!cursor) break;
        }
        return { projectId, items: items.slice(0, MAP_DOCUMENT_PAGE), kinds: documentKindCounts(first, items) };
      };
      const pages = await Promise.allSettled(projectIds.map(documentsOf));
      const read = pages.filter((page) => page.status === "fulfilled");
      if (projectIds.length > 0 && read.length === 0) throw /** @type {PromiseRejectedResult} */ (pages[0]).reason;
      const held = read.map((page) => /** @type {PromiseFulfilledResult<Awaited<ReturnType<typeof documentsOf>>>} */ (page).value);
      const items = held.flatMap((page) => page.items);
      const nodes = items.map(documentNode);
      // The inventory of what the knowledge base holds, by chip and by project (the overview's 知识 and 项目).
      /** @type {Map<string, number>} */
      const byKind = new Map();
      for (const page of held) for (const [kind, count] of page.kinds) byKind.set(kind, (byKind.get(kind) ?? 0) + count);
      const documentTypes = SOURCE_KINDS.filter((kind) => byKind.has(kind.id)).map((kind) => ({ id: kind.id, label: kind.label, count: /** @type {number} */ (byKind.get(kind.id)) }))
        .sort((left, right) => right.count - left.count);
      const projectDocuments = held.map((page) => ({ id: page.projectId, count: [...page.kinds.values()].reduce((sum, count) => sum + count, 0) }));
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
      // The days the documents were added, for the growth strip: the newest of each project that the page read.
      const added = items.map((item) => instant(item.createdAt)).filter((at) => at !== null).map((at) => ({ at: /** @type {string} */ (at), type: "document" }));
      return { nodes, edges, buckets: bucketsOf(added, request.timeZone, request.now), facets: { documentTypes, projectDocuments } };
    },
  };
}
