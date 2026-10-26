import { randomBytes } from "node:crypto";
import { linkStatesLeftFor } from "@evimed/domain";

/**
 * The memory engine's side of a source change, in memory: the files of an account that name sources, and the two calls
 * `KnowledgeChangeService` makes of them (`labelSource`, `dependentsOfSource`).
 *
 * The real ones are `NativeMemoryWorker.labelSource` (it writes the label line into the engine's file and moves the overlay's
 * link) and `NativeMemoryStore.dependentsOfSource`, and the engine's own write is covered with them
 * (`nativeMemory.integration.test.mjs`). The tests that use this double are about what reaches a memory when a source changes, not
 * about how the engine writes a label, so it keeps one rule of the real worker and no more: a check moves a link only where it
 * adds knowledge (`linkStatesLeftFor`: a correction never lowers a retraction, a check that could not answer or one that found
 * nothing is only what a link nobody had found a change on becomes).
 */
export function nativeSourceLinks() {
  /** @type {{ userId: string, recordId: string, scope: string, scopeId: string, kind: string, summary: string, sensitive: boolean, links: { type: string, id: string, state: string }[] }[]} */
  const files = [];
  return {
    /**
     * A memory file of an account that names sources, and the id the page knows it by.
     * @param {string} userId @param {{ scope?: string, scopeId?: string, kind?: string, summary?: string, sensitive?: boolean, links?: { type: string, id: string, state?: string }[] }} file
     */
    file(userId, { scope = "user", scopeId = "", kind = "project_fact", summary = "", sensitive = false, links = [] } = {}) {
      const recordId = `nm_${randomBytes(12).toString("hex")}`;
      files.push({ userId, recordId, scope, scopeId, kind, summary, sensitive, links: links.map((link) => ({ type: link.type, id: link.id, state: link.state ?? "current" })) });
      return recordId;
    },
    /** @param {string} userId @param {{ type: string, id: string }} source @param {string} state */
    async labelSource(userId, source, state) {
      let touched = 0;
      for (const file of files.filter((entry) => entry.userId === userId)) {
        for (const link of file.links.filter((entry) => entry.type === source.type && entry.id === source.id)) {
          if (link.state === state || !linkStatesLeftFor(state).includes(link.state)) continue;
          link.state = state;
          touched += 1;
        }
      }
      return touched;
    },
    /** @param {string} userId @param {{ type: string, id: string }} source */
    async dependentsOfSource(userId, source) {
      return files.filter((entry) => entry.userId === userId && entry.links.some((link) => link.type === source.type && link.id === source.id))
        .map((entry) => ({ recordId: entry.recordId, scope: entry.scope, scopeId: entry.scopeId, kind: entry.kind, status: "active",
          state: /** @type {{ state: string }} */ (entry.links.find((link) => link.type === source.type && link.id === source.id)).state }));
    },
    /** What `NativeMemoryStore.recordSummaries` answers: the page's record of each file named. @param {string} userId @param {readonly string[]} ids */
    async recordSummaries(userId, ids) {
      return files.filter((entry) => entry.userId === userId && ids.includes(entry.recordId))
        .map((entry) => ({ id: entry.recordId, summary: entry.summary, value: entry.summary, sensitive: entry.sensitive, updatedAt: "2026-10-04T00:00:00Z" }));
    },
    /** The states of the links of one file: what a test reads back. @param {string} recordId */
    states(recordId) {
      return (files.find((entry) => entry.recordId === recordId)?.links ?? []).map((link) => [link.type, link.state]);
    },
  };
}
