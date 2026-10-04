import { sendJson } from "./security.mjs";

/**
 * `GET /api/availability`: what this deployment can truthfully say about each
 * capability and tool for the account asking. A label and nothing else — no
 * route consults it before a dispatch, and a failure to compute it is an empty
 * answer, never a refusal of anything the account was doing.
 *
 * The operator's export is not here: it rides the operator token beside the
 * other `/api/ops/*` reports (`server.mjs`), because an account must never be
 * handed the run, dispatch and project references that export carries.
 *
 * @param {{ store: { ensureUser: (req: any, res: any) => Promise<any> }, service: import("./availabilityService.mjs").AvailabilityService }} dependencies
 */
export function createAvailabilityRoutes({ store, service }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/availability" || (req.method ?? "GET") !== "GET") return false;
    const user = await store.ensureUser(req, res);
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, 200, { data: await service.forAccount(user) });
    return true;
  };
}
