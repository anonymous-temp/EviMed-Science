/**
 * The simulated wallet's two pages' data (`/api/simulated-wallet/*`, 2026-10-04):
 * a top-up, and the list of top-ups already made.
 *
 * Hidden knowledge:
 *
 * - **Its own path, never the allowance's.** `/api/account/allowance/*` is
 *   read-only by contract and answers 405 to a write. A write that adds credits
 *   lives here, under a name that says what it is, so it can never be mistaken
 *   for, or routed to, anything that moves real money.
 * - **Off is a 404 before a session is even opened**, like the credits routes: a
 *   deployment whose wallet is real has no simulated wallet to top up.
 * - **A top-up is idempotent on the page's request id.** The page makes one per
 *   press and reuses it on a retry, so a double click or a lost answer can never
 *   add the credits twice (`duplicate: true` says the request was already applied).
 * - **A closed list of packages.** The request names a package of the domain's
 *   `SIMULATED_TOPUP_PACKAGES`, never a number.
 *
 *   GET  /api/simulated-wallet/orders?limit&cursor   this account's simulated top-ups
 *   POST /api/simulated-wallet/topups                { packageId, requestId }
 *
 * @module simulatedWalletRoutes
 */

import { HttpError, assertObject, readJson, sendJson } from "./security.mjs";

const ROOT = "/api/simulated-wallet";
const HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });
/** A top-up's body is two short strings. */
const MAX_BODY_BYTES = 2_048;

/** @param {string} pathname */
export function simulatedWalletRoutePattern(pathname) {
  return [`${ROOT}/orders`, `${ROOT}/topups`].includes(pathname) ? pathname : `${ROOT}/:route`;
}

/** @param {URL} url */
function orderOptions(url) {
  const limit = url.searchParams.get("limit") ?? "20";
  const cursor = url.searchParams.get("cursor");
  if (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50
    || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1
    || (cursor !== null && (cursor.length === 0 || cursor.length > 512))) {
    throw new HttpError(400, "simulated_wallet_request_invalid", "Invalid order pagination.");
  }
  return { limit: Number(limit), cursor };
}

/** @template T @param {() => Promise<T>} read @returns {Promise<T>} */
async function walletRead(read) {
  try { return await read(); } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "evimed_credits_unreachable", "The simulated wallet is temporarily unavailable.");
  }
}

/**
 * @param {{ store: any, service: any, config: Record<string, any> }} dependencies
 */
export function createSimulatedWalletRoutes({ store, service, config }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    if (config?.evimedCreditsEnabled !== true || config.evimedCreditsSimulated !== true || !service) {
      throw new HttpError(404, "simulated_wallet_not_enabled", "This deployment has no simulated wallet.");
    }
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    const method = req.method ?? "GET";
    if (url.pathname === `${ROOT}/orders`) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "The simulated orders are read-only.");
      const options = orderOptions(url);
      const data = await walletRead(() => service.simulatedOrders(user.id, options));
      sendJson(res, 200, { data: { simulated: true, currency: "CNY", ...data } }, HEADERS);
      return true;
    }
    if (url.pathname === `${ROOT}/topups`) {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "A simulated top-up is a POST.");
      const body = assertObject(await readJson(req, MAX_BODY_BYTES), "simulated top-up");
      const unknown = Object.keys(body).filter((field) => !["packageId", "requestId"].includes(field));
      if (unknown.length > 0 || typeof body.packageId !== "string" || typeof body.requestId !== "string") {
        throw new HttpError(400, "simulated_wallet_request_invalid", "A simulated top-up names a package and a request id.");
      }
      const result = await walletRead(() => service.simulatedTopUp(user.id, { packageId: body.packageId, requestId: body.requestId }));
      sendJson(res, result.duplicate ? 200 : 201, { data: {
        simulated: true, order: result.order, available: result.balance, duplicate: result.duplicate,
      } }, HEADERS);
      return true;
    }
    throw new HttpError(404, "not_found", "Simulated wallet route not found.");
  };
}
