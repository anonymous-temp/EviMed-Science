import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * The browser's routes for 「前沿动态」 (`/api/frontier/*`, plan §7.3).
 *
 * Hidden knowledge:
 *
 * - Off is invisible. With the module off — or on for operators only and the
 *   caller not among them or the preview list — every path answers 404
 *   `frontier_not_enabled`, the same answer a URL that never existed gets. The
 *   dry-run week (plan §10.5.10) is exactly that: the pipeline runs in
 *   production and only its operators can see it.
 * - Writes arrive here already past the platform's CSRF check and maintenance
 *   admission (the dispatch in `server.mjs` runs both before any route
 *   factory); the CSRF check is repeated here like every other factory does,
 *   because a route that relies on its call site is one refactor from none.
 * - None of these routes goes through a per-request usage admission (plan
 *   §10.5.2): they spend no model money, and the page polls `/status` every two
 *   minutes — a quota walk per request once turned a thirty-request page open
 *   into a twenty-nine-second start.
 * - Lists, items and the status carry an `ETag` and `Cache-Control: private,
 *   no-cache`; a matching `If-None-Match` is answered 304 with no body. The tag
 *   includes a digest of the account, so two people signing in on one browser
 *   can never be handed each other's stars from its cache.
 * - Answers keep the platform's envelope, `{ data: <shape> }` — the one
 *   exception is a merged event's old id, which is a `308` to the survivor
 *   with a relative `Location` and `{ data: { redirect } }` (plan §14.8 #1):
 *   `fetch` follows it, and a client that does not still learns where to go.
 * - A route of the second wave whose module is not composed answers 404
 *   `not_found`, which the page reads as 「还在准备」 and `/status`
 *   `capabilities` already told it.
 *
 * @module frontierRoutes
 */

const NOT_ENABLED = () => new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
const ITEM_ACTIONS = Object.freeze(["star", "unstar", "hide", "unhide", "read"]);
const OPERATOR_ITEM_ACTIONS = Object.freeze(["withdraw", "pin", "unpin"]);

/**
 * The bounded metric label of a frontier path: ids are folded so a dashboard
 * row is a route, not an item.
 * @param {string} pathname
 */
export function frontierRoutePattern(pathname) {
  const parts = pathname.slice("/api/frontier".length).split("/").filter(Boolean);
  if (!parts.length) return "/api/frontier";
  if (parts[0] === "items") {
    if (parts.length === 1) return "/api/frontier/items";
    if (parts.length === 2) return "/api/frontier/items/:id";
    return "/api/frontier/items/:id/:action";
  }
  if (parts[0] === "follows") return parts.length === 1 ? "/api/frontier/follows" : "/api/frontier/follows/:id";
  if (parts[0] === "ops") return parts[1] === "sources" ? "/api/frontier/ops/sources/:id/enabled" : "/api/frontier/ops/items/:id/:action";
  if (["status", "sources", "for-you", "hot", "events", "dailies"].includes(parts[0])) return `/api/frontier/${parts[0]}${parts.length > 1 ? "/:id" : ""}`;
  return "/api/frontier/:route";
}

/** @param {any} req @param {number} limit @param {readonly string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const body = await readJson(req, limit);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "frontier_payload_invalid", "The frontier request has unsupported fields.");
  }
  return body;
}

/**
 * @param {{ store: any, service: any, config: Record<string, any>, maxJsonBytes: number,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown> }} dependencies
 */
export function createFrontierRoutes({ store, service, config, maxJsonBytes, audit = async () => {} }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/frontier" && !url.pathname.startsWith("/api/frontier/")) return false;
    if (!config?.frontierEnabled || !service) throw NOT_ENABLED();
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service.allows(user)) throw NOT_ENABLED();
    let parts;
    try { parts = url.pathname.slice("/api/frontier".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "frontier_path_invalid", "Invalid frontier path."); }
    const method = req.method ?? "GET";
    const reply = (/** @type {any} */ value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    /** @param {{ status: number, etag: string, body?: any }} result */
    const conditional = (result) => {
      const headers = { ETag: result.etag, "Cache-Control": "private, no-cache", Vary: "Cookie" };
      if (result.status === 304) {
        res.writeHead(304, headers);
        res.end();
        return true;
      }
      sendJson(res, 200, { data: result.body }, headers);
      return true;
    };
    const requireOperator = () => {
      if (!service.isOperator(user)) throw new HttpError(403, "frontier_operator_required", "Only an operator may change what the feed shows.");
    };

    if (parts.length === 1 && parts[0] === "status" && method === "GET") {
      // Opening the page is what the daily's audience is made of (plan §10.5.5).
      await service.markSeen?.(user);
      return conditional(await service.statusAnswer(req.headers["if-none-match"]));
    }
    if (parts.length === 1 && parts[0] === "items" && method === "GET") {
      await service.markSeen?.(user);
      return conditional(await service.listItems(user, url.searchParams, req.headers["if-none-match"]));
    }
    if (parts.length === 2 && parts[0] === "items" && method === "GET") {
      return conditional(await service.getItem(user, parts[1], req.headers["if-none-match"]));
    }
    if (parts.length === 3 && parts[0] === "items" && method === "POST" && ITEM_ACTIONS.includes(parts[2])) {
      await bodyOf(req, maxJsonBytes, []);
      return reply(await service.setItemState(user, parts[1], parts[2]));
    }
    if (parts.length === 3 && parts[0] === "items" && method === "POST" && parts[2] === "save-to-library") {
      const body = await bodyOf(req, maxJsonBytes, ["projectId"]);
      const result = await service.saveToLibrary(user, parts[1], body);
      await audit("frontier.item.save-to-library", "completed", { userId: user.id, code: parts[1], detail: `${result.saved.kind}:${body.projectId}` });
      return reply(result);
    }
    if (parts.length === 3 && parts[0] === "items" && method === "POST" && parts[2] === "abstract-zh") {
      await bodyOf(req, maxJsonBytes, []);
      return reply(await service.abstractZh(user, parts[1]));
    }
    // The second wave's readers (build spec D.7).
    if (parts.length === 1 && parts[0] === "for-you" && method === "GET") {
      await service.markSeen?.(user);
      return reply(await service.forYou(user));
    }
    if (parts.length === 1 && parts[0] === "hot" && method === "GET") {
      // `?window=week|month`: that window's ranking instead of the current list.
      return reply(await service.hot(url.searchParams));
    }
    if (parts.length === 2 && parts[0] === "events" && method === "GET") {
      const answer = await service.event(user, parts[1]);
      if (answer.redirect) {
        // A merged event's old id, permanently: relative, so it resolves under
        // whatever prefix this API is served at, and `fetch` follows it.
        res.writeHead(308, { Location: encodeURIComponent(answer.redirect), "Cache-Control": "private, no-cache", "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ data: { redirect: answer.redirect } }));
        return true;
      }
      return reply(answer);
    }
    if (parts.length === 1 && parts[0] === "dailies" && method === "GET") {
      return reply(await service.dailies(url.searchParams));
    }
    if (parts.length === 2 && parts[0] === "dailies" && method === "GET") {
      return reply(await service.dailyIssue(user, parts[1]));
    }
    if (parts.length === 1 && parts[0] === "sources" && method === "GET") {
      return reply(await service.sources(user));
    }
    if (parts.length === 1 && parts[0] === "follows") {
      if (method === "GET") return reply(await service.listFollows(user));
      if (method === "POST") return reply(await service.createFollow(user, await bodyOf(req, maxJsonBytes, ["kind", "key", "label", "muted"])));
    }
    if (parts.length === 2 && parts[0] === "follows" && method === "DELETE") {
      return reply(await service.deleteFollow(user, parts[1]));
    }
    if (parts.length === 4 && parts[0] === "ops" && parts[1] === "items" && method === "POST" && OPERATOR_ITEM_ACTIONS.includes(parts[3])) {
      requireOperator();
      const body = await bodyOf(req, maxJsonBytes, ["reason"]);
      if (body.reason != null && typeof body.reason !== "string") throw new HttpError(400, "frontier_operation_invalid", "reason must be a string.");
      const result = await service.operateItem(parts[2], parts[3], { reason: body.reason ?? null });
      await audit(`frontier.item.${parts[3]}`, "completed", { userId: user.id, code: result.item.id, detail: body.reason ?? "" });
      return reply(result);
    }
    if (parts.length === 4 && parts[0] === "ops" && parts[1] === "sources" && parts[3] === "enabled" && method === "POST") {
      requireOperator();
      const body = await bodyOf(req, maxJsonBytes, ["enabled"]);
      const result = await service.setSourceEnabled(parts[2], body.enabled);
      await audit("frontier.source.enabled", "completed", { userId: user.id, code: result.source.id, detail: `enabled=${result.source.enabled}` });
      return reply(result);
    }
    throw new HttpError(404, "not_found", "Frontier route not found.");
  };
}
