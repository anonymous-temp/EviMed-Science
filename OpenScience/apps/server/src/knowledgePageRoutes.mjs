import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * `/api/knowledge-pages/*`: what a project's knowledge pages (「知识页」) look like, one page as the reader shows it, and the
 * researcher's 「重新整理」.
 *
 * A page itself is a document of the knowledge base and is listed, opened and saved through `/api/sources` like a note; these
 * routes add only what a page has that a note does not — each sentence with what it rests on, checked now — and the state of the
 * project's compile. Both reads answer without the switch (`OPEN_SCIENCE_KNOWLEDGE_PAGES_ENABLED`): pages that exist stay
 * readable when the compile is turned off. The compile route answers 404 by name when it is off.
 *
 * @param {{ store: any, service: any, sources: any, maxJsonBytes: number }} dependencies
 */
export function createKnowledgePageRoutes({ store, service, sources, maxJsonBytes }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/knowledge-pages" && !url.pathname.startsWith("/api/knowledge-pages/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service || !sources) throw new HttpError(503, "product_state_unavailable", "Knowledge pages need the product ledger.");
    const method = req.method ?? "GET";
    const reply = (/** @type {any} */ value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    /** @param {string | null} projectId */
    const ownedProject = async (projectId) => {
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      return store.requireProject(user, projectId);
    };
    if (url.pathname === "/api/knowledge-pages" && method === "GET") {
      const project = await ownedProject(url.searchParams.get("projectId"));
      return reply(await service.summary(user.id, project.id));
    }
    if (url.pathname === "/api/knowledge-pages/page" && method === "GET") {
      const sourceId = url.searchParams.get("sourceId") ?? "";
      const source = await sources.get(user.id, sourceId);
      const project = await store.requireProject(user, source.projectId);
      return reply(await service.pageView(user.id, project, source));
    }
    if (url.pathname === "/api/knowledge-pages/compile" && method === "POST") {
      const input = await readJson(req, maxJsonBytes);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "projectId")) {
        throw new HttpError(400, "knowledge_payload_invalid", "The request has unsupported fields.");
      }
      if (!service.enabled) throw new HttpError(404, "knowledge_pages_disabled", "Knowledge pages are not enabled.");
      const project = await ownedProject(typeof input.projectId === "string" ? input.projectId : null);
      await service.requestRound(user.id, project.id);
      return reply(await service.summary(user.id, project.id), 202);
    }
    throw new HttpError(404, "not_found", "Knowledge page route not found.");
  };
}
