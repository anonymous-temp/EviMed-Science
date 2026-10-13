import { KNOWLEDGE_TREES } from "@evimed/domain";
import { preferredLanguage } from "./knowledgePageService.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * `/api/knowledge-pages/*`: a project's compiled wiki and knowledge graph (「知识页」) as the reader and the graph view
 * need them, and the person's two actions — save an edit, ask for a compile.
 *
 *   GET  /api/knowledge-pages?projectId=            the compile's state: last compiled, pages against the limit, the running stage
 *   GET  /api/knowledge-pages/tree?projectId=       every compiled file, flat and as a tree, with type, title, time and labels
 *   GET  /api/knowledge-pages/page?sourceId=        one page: Markdown, front matter, links, cited documents, each quotation's ✓ / ⚠
 *        (or ?projectId=&tree=&path= — how a link inside a page is followed)
 *   PUT  /api/knowledge-pages/page                  { sourceId, markdown, baseSha256? } — a person's edit
 *   GET  /api/knowledge-pages/graph?projectId=&kind=wiki|kg   { nodes, links }
 *   POST /api/knowledge-pages/compile               { projectId, language? } — 「重新整理」
 *
 * A compiled file is also a document of the knowledge base, listed and opened through `/api/sources` like a note. Every
 * read here answers without the switch (`OPEN_SCIENCE_OV_KNOWLEDGE_ENABLED`) and without the engine: what was compiled
 * stays readable from the ledger's mirror. Only the compile route answers 404 by name when compiling is off.
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
    /** @param {unknown} input @param {string[]} allowed */
    const body = (input, allowed) => {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
        throw new HttpError(400, "knowledge_payload_invalid", "The request has unsupported fields.");
      }
      return /** @type {Record<string, any>} */ (input);
    };
    const language = preferredLanguage(req.headers?.["accept-language"]);

    if (url.pathname === "/api/knowledge-pages" && method === "GET") {
      const project = await ownedProject(url.searchParams.get("projectId"));
      // The language a person's browser states is the one the project's pages are written in, kept the first time it is seen.
      if (service.enabled) await service.noteLanguage(user.id, project.id, language);
      return reply(await service.summary(user.id, project.id));
    }
    if (url.pathname === "/api/knowledge-pages/tree" && method === "GET") {
      const project = await ownedProject(url.searchParams.get("projectId"));
      return reply(await service.list(user.id, project.id));
    }
    if (url.pathname === "/api/knowledge-pages/page" && method === "GET") {
      let sourceId = url.searchParams.get("sourceId") ?? "";
      if (!sourceId) {
        // A link inside a page names a path, not a document id.
        const project = await ownedProject(url.searchParams.get("projectId"));
        const tree = url.searchParams.get("tree") ?? "wiki";
        const path = url.searchParams.get("path") ?? "";
        if (!KNOWLEDGE_TREES.includes(tree)) throw new HttpError(400, "knowledge_payload_invalid", "tree must be wiki or kg.");
        const found = (await service.list(user.id, project.id)).pages.find((/** @type {any} */ page) => page.tree === tree && page.path === path);
        if (!found?.sourceId) throw new HttpError(404, "knowledge_page_not_found", "There is no such page.");
        sourceId = found.sourceId;
      }
      const source = await sources.get(user.id, sourceId);
      const project = await store.requireProject(user, source.projectId);
      return reply(await service.pageView(user.id, project, source));
    }
    if (url.pathname === "/api/knowledge-pages/page" && method === "PUT") {
      const input = body(await readJson(req, maxJsonBytes), ["sourceId", "markdown", "baseSha256"]);
      if (typeof input.sourceId !== "string" || typeof input.markdown !== "string" || (input.baseSha256 != null && !/^[a-f0-9]{64}$/.test(String(input.baseSha256)))) {
        throw new HttpError(400, "knowledge_payload_invalid", "A page is saved with its document id and its Markdown.");
      }
      const source = await sources.get(user.id, input.sourceId);
      const project = await store.requireProject(user, source.projectId);
      const saved = await service.saveEdit({ user, project, source, markdown: input.markdown, baseSha256: input.baseSha256 ?? null });
      return reply({ changed: saved.changed, writeBack: saved.writeBack, userBlocks: saved.userBlocks, page: await service.pageView(user.id, project, saved.source) });
    }
    if (url.pathname === "/api/knowledge-pages/graph" && method === "GET") {
      const project = await ownedProject(url.searchParams.get("projectId"));
      const kind = url.searchParams.get("kind") ?? "wiki";
      if (!KNOWLEDGE_TREES.includes(kind)) throw new HttpError(400, "knowledge_payload_invalid", "kind must be wiki or kg.");
      return reply(await service.graph(user.id, project, kind));
    }
    if (url.pathname === "/api/knowledge-pages/compile" && method === "POST") {
      const input = body(await readJson(req, maxJsonBytes), ["projectId", "language"]);
      if (!service.enabled) throw new HttpError(404, "knowledge_pages_disabled", "Knowledge pages are not enabled.");
      const project = await ownedProject(typeof input.projectId === "string" ? input.projectId : null);
      const stated = input.language == null ? null : preferredLanguage(input.language);
      if (input.language != null && !stated) throw new HttpError(400, "knowledge_payload_invalid", "language must be a language tag such as zh-CN or en.");
      // A language the person names replaces the one their browser stated.
      if (stated) await service.noteLanguage(user.id, project.id, stated, { replace: true });
      await service.requestRound(user.id, project.id, { language });
      return reply(await service.summary(user.id, project.id), 202);
    }
    throw new HttpError(404, "not_found", "Knowledge page route not found.");
  };
}
