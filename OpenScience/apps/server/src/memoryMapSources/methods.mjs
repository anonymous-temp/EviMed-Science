/**
 * The map's learned methods: what the platform has learned to do for this researcher, as marks hanging from the account.
 *
 * A method is the platform's own, learned across projects (`LearningService`), so it belongs to the account and not to a
 * project, and only those in force are drawn — one the researcher stopped is under 已忘记的内容. It is named as the memory page
 * names it: the researcher's line when the method has one, else its own name.
 *
 * @module memoryMapSources/methods
 */

import { cleanMethodDisplay } from "@evimed/domain";

import { excerpt, instant, nodeId } from "./common.mjs";

/** The methods one read draws at most. */
export const MAP_METHOD_LIMIT = 40;

/**
 * @param {{ learning: { listMethods: (userId: string, options?: any) => Promise<{ items?: any[] }> } | null }} dependencies
 * @returns {import("./common.mjs").MapSource}
 */
export function createMethodsSource({ learning }) {
  return {
    name: "methods",
    applies: (request) => Boolean(learning) && typeof learning?.listMethods === "function" && request.projectId === null,
    async read(request) {
      const page = await /** @type {any} */ (learning).listMethods(request.user.id, { status: "approved", limit: MAP_METHOD_LIMIT });
      /** @type {import("./common.mjs").MapNode[]} */
      const nodes = [];
      /** @type {import("./common.mjs").MapEdge[]} */
      const edges = [];
      for (const method of page.items ?? []) {
        const payload = method.payload ?? {};
        const title = excerpt(cleanMethodDisplay(payload.display)?.title ?? payload.frontmatter?.name ?? "", 40);
        if (!title) continue;
        const id = nodeId("method", String(method.id));
        nodes.push({ id, type: "method", group: "做法", label: title, at: instant(method.createdAt), state: "current", open: { kind: "method", id: String(method.id) } });
        edges.push({ from: id, to: nodeId("you", "account"), type: "belongs-to" });
      }
      return { nodes, edges };
    },
  };
}
