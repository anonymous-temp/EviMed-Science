import { cleanMethodDisplay } from "@evimed/domain";
import { conversationSources } from "./learningSources.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * What a researcher can read and undo about the handbooks the platform learned
 * for them: `GET /api/handbooks` (in use, or stopped with `?status=retired`),
 * one handbook whole, its earlier versions, 「不再使用」 and 「回到上一版」.
 *
 * Hidden knowledge: there is deliberately no route that writes a handbook, as
 * there is none that approves a method. A handbook is what the learning loop
 * made of a reviewed lesson (`HandbookConsolidation`); the researcher's part is
 * to read it and, when it is wrong for them, stop it or go back — the same two
 * undos a learned method has, so the memory page's 做法 list can treat the two
 * alike. The memory page reads the list; the rest is its drawer.
 *
 * @module handbookRoutes
 */

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "handbook_payload_invalid", "Handbook request contains unsupported fields.");
  }
  return value;
}

/**
 * The row a researcher reads: the title and sentence the loop wrote for them
 * (`display`, the model-facing name when it has none), the tool it is for and
 * the conversation it came out of. The body is the drawer's.
 * @param {any} document
 */
export function handbookView(document) {
  const payload = document.payload ?? {};
  const display = cleanMethodDisplay(payload.display);
  return {
    id: document.id,
    // The concurrency token: it moves on every write and is never a version a person reads.
    revision: document.revision,
    capabilityId: payload.capabilityId ?? null,
    status: payload.status ?? "active",
    title: display?.title ?? payload.frontmatter?.name ?? "",
    summary: display?.summary ?? null,
    whenToUse: payload.frontmatter?.whenToUse ?? "",
    appliedAt: payload.appliedAt ?? document.updatedAt ?? null,
    source: payload.source?.projectId ? { projectId: payload.source.projectId, sessionId: payload.source.sessionId ?? null } : null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/**
 * @param {{ store: any, library: any, maxJsonBytes: number,
 *   resolveRun?: ((userId: string, projectId: string, runId: string) => Promise<any>) | null }} dependencies
 */
export function createHandbookRoutes({ store, library, maxJsonBytes, resolveRun = null }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/handbooks" && !url.pathname.startsWith("/api/handbooks/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!library) throw new HttpError(503, "handbook_store_unavailable", "Handbook storage is unavailable.");
    let parts;
    try { parts = url.pathname.slice("/api/handbooks".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "handbook_path_invalid", "Invalid handbook path."); }
    const method = req.method ?? "GET";
    /** @param {any} data */
    const reply = (data) => { sendJson(res, 200, { data }); return true; };

    if (parts.length === 0 && method === "GET") {
      const page = await library.list(user.id, {
        status: url.searchParams.get("status") ?? "active",
        limit: Number(url.searchParams.get("limit") ?? 50),
        cursor: url.searchParams.get("cursor"),
      });
      return reply({ items: (page.items ?? []).map(handbookView), nextCursor: page.nextCursor ?? null });
    }
    if (parts.length === 1 && method === "GET") {
      const document = await library.get(user.id, parts[0]);
      const source = document.payload?.source;
      return reply({
        ...handbookView(document),
        body: document.payload?.body ?? "",
        steps: await library.stepsOf(user.id, document),
        sources: await conversationSources({ resolveRun }, user.id, [{ projectId: source?.projectId, runId: source?.runId }]),
      });
    }
    if (parts.length === 2 && parts[1] === "history" && method === "GET") {
      return reply({ items: await library.history(user.id, parts[0]) });
    }
    if (parts.length === 2 && parts[1] === "retire" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision", "reason"]);
      return reply(handbookView(await library.retire(user.id, parts[0], body)));
    }
    if (parts.length === 2 && parts[1] === "rollback" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision", "targetRevision"]);
      return reply(handbookView(await library.rollback(user.id, parts[0], body)));
    }
    throw new HttpError(404, "not_found", "Handbook route not found.");
  };
}
