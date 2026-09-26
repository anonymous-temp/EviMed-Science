/**
 * The two numbers the composer shows before a deep run starts (`/api/credits/*`,
 * fusion plan §9.6 and §3.4: 「会做深度研究 · 约 40 分钟 · 约 120 灵豆」).
 *
 * Hidden knowledge:
 *
 * - Read-only, and authenticated like every other page read: a balance is an
 *   account's own fact, so the account is the session's and never a parameter.
 * - **Off is invisible.** With the module off every path answers 404
 *   `evimed_credits_not_enabled` and the shell stops asking — the same shape
 *   `reviewRoutes` uses, so a deployment that has not joined EviMed's billing
 *   renders no balance rather than a zero.
 * - The balance is a *status*, not an error: an unreachable credits service
 *   answers 200 with `balance: null` and the reason, because a page opened to
 *   read a number must not fail on our own plumbing (principle 19). The only
 *   refusal money makes is at the start of a run, and that one lives in the
 *   dispatch path.
 * - Nothing here spends, so there is no usage admission and no CSRF-exempt
 *   path: the session check and the repeated CSRF check are the whole guard.
 *
 *   GET /api/credits/balance                  this account's 灵豆
 *   GET /api/credits/estimate?capability=<id> what that capability is likely to cost
 *
 * @module evimedCreditsRoutes
 */

import { HttpError, sendJson } from "./security.mjs";

const NOT_ENABLED = () => new HttpError(404, "evimed_credits_not_enabled", "灵豆 settlement is not enabled for this deployment.");
/** A capability id as `capabilities/<id>` spells one. */
const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The bounded metric label of a credits path. @param {string} pathname */
export function evimedCreditsRoutePattern(pathname) {
  if (pathname === "/api/credits/balance") return "/api/credits/balance";
  if (pathname === "/api/credits/estimate") return "/api/credits/estimate";
  return "/api/credits/:route";
}

/**
 * @param {{ store: any, service: any, config: Record<string, any> }} dependencies
 */
export function createEvimedCreditsRoutes({ store, service, config }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/credits" && !url.pathname.startsWith("/api/credits/")) return false;
    if (!config?.evimedCreditsEnabled || !service) throw NOT_ENABLED();
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "method_not_allowed", "The credits routes are read-only.");
    const headers = { "Cache-Control": "private, no-store" };
    if (url.pathname === "/api/credits/balance") {
      const balance = await service.balanceFor(user.id);
      sendJson(res, 200, { data: balance }, headers);
      return true;
    }
    if (url.pathname === "/api/credits/estimate") {
      const capability = String(url.searchParams.get("capability") ?? "").trim();
      // An estimate for no named capability is the deep-research line's own,
      // which has no manifest minutes and no history of its own — answered as
      // `basis: "none"` rather than refused, because the composer asks for every
      // send and 「暂无预估」 is a usable answer.
      if (capability && !CAPABILITY_ID.test(capability)) {
        throw new HttpError(400, "evimed_credits_request_invalid", "capability must be a capability id.");
      }
      sendJson(res, 200, { data: await service.estimate(capability) }, headers);
      return true;
    }
    throw new HttpError(404, "not_found", "Credits route not found.");
  };
}
