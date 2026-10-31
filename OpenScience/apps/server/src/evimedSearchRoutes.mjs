import { HttpError, readJson, sendJson } from "./security.mjs";
import { EVIMED_SEARCH_CATEGORIES, evimedSearchFailureDetail } from "./evimedSearchService.mjs";
import { EVIMED_SEARCH_ACTIONS } from "./evimedSearchActions.mjs";

export const EVIMED_SEARCH_PATH = "/api/evimed-search";

/** @param {{store:any,service:any,maxJsonBytes:number,audit?:(action:string,status:string,details:Record<string,any>)=>Promise<any>}} dependencies */
export function createEvimedSearchRoutes({ store, service, maxJsonBytes, audit }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== EVIMED_SEARCH_PATH && !url.pathname.startsWith(`${EVIMED_SEARCH_PATH}/`)) return false;
    res.setHeader("Cache-Control", "no-store");
    const parts = url.pathname.slice(EVIMED_SEARCH_PATH.length + 1).split("/");
    if (parts.length !== 2 || !EVIMED_SEARCH_CATEGORIES.includes(parts[0]) || !["search", "detail", "facets", ...EVIMED_SEARCH_ACTIONS].includes(parts[1]) || url.search) {
      throw new HttpError(404, "not_found", "The account search route was not found.");
    }
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Account search requires POST.");
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(400, "invalid_json", "Account search requires JSON.");
    await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    const body = await readJson(req, Math.min(maxJsonBytes, EVIMED_SEARCH_ACTIONS.includes(parts[1]) ? 256 * 1024 : 16 * 1024));
    let data;
    try { data = EVIMED_SEARCH_ACTIONS.includes(parts[1]) ? await service.action(req, res, parts[0], parts[1], body) : await service[parts[1]](req, res, parts[0], body); }
    catch (error) {
      const detail = evimedSearchFailureDetail(error);
      await audit?.(`evimed_search.${parts[0]}.${parts[1]}`, "failed", { code: error instanceof HttpError ? error.code : "internal_error", ...(detail ? { detail } : {}) });
      throw error;
    }
    sendJson(res, 200, { data });
    return true;
  };
}
