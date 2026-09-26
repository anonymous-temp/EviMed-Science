import { HttpError, readJson, sendJson } from "./security.mjs";
import { EVIMED_LOGOUT_PATH, EVIMED_SESSION_PATH } from "./evimedAuthService.mjs";

/**
 * The EviMed shell's two auth calls (fusion plan 2026-09-26 §9.2).
 *
 *   POST /api/auth/evimed/session   the shell's credential → a session of ours
 *   POST /api/auth/evimed/logout    EviMed signed out → revoke that session
 *
 * Hidden knowledge:
 *
 * - The session route is reached before there is a session, so it is one of the
 *   paths `store.assertCsrf` exempts (`SESSIONLESS_AUTH_PATHS` in `store.mjs`);
 *   it is bounded by the auth rate limiter instead, and the only account it can
 *   produce is the visitor's own. The logout route is not exempt: it needs the
 *   session it revokes and that session's CSRF token, like `/api/auth/logout`.
 * - Off is 404 `auth_method_disabled` — the same answer `/api/auth/login` gives
 *   in a deployment that does not accept passwords, because "this deployment
 *   does not offer that way in" is one fact with one name.
 * - The audit line records the account and the failure code, never the
 *   credential: the ledger is forever and the credential is not ours.
 *
 * @module evimedAuthRoutes
 */

/** The bounded metric label of an EviMed auth path. @param {string} pathname */
export function evimedAuthRoutePattern(pathname) {
  if (pathname === EVIMED_SESSION_PATH || pathname === EVIMED_LOGOUT_PATH) return pathname;
  return "/api/auth/evimed/:action";
}

/**
 * @param {{
 *   store: any,
 *   service: any,
 *   maxJsonBytes: number,
 *   audit?: (action: string, status: string, details: Record<string, any>) => Promise<any>,
 *   onSignIn?: (userId: string) => void,
 * }} dependencies
 */
export function createEvimedAuthRoutes({ store, service, maxJsonBytes, audit, onSignIn }) {
  /** @param {string} action @param {string} status @param {Record<string, any>} details */
  const record = (action, status, details) => audit ? audit(action, status, details) : Promise.resolve();
  /** @param {unknown} error */
  const codeOf = (error) => error instanceof HttpError ? error.code : "internal_error";

  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/auth/evimed" && !url.pathname.startsWith("/api/auth/evimed/")) return false;
    if (!service?.enabled) {
      throw new HttpError(404, "auth_method_disabled", "EviMed authentication is disabled.");
    }
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      throw new HttpError(405, "method_not_allowed", "EviMed authentication accepts POST.");
    }

    if (url.pathname === EVIMED_SESSION_PATH) {
      // A body is optional — an empty one reads as `{}` — because the
      // credential may be the cookie the browser attached instead, which is
      // what EviMed's HttpOnly rework leaves the shell with.
      const body = await readJson(req, maxJsonBytes);
      try {
        const session = await service.createSession(req, res, body);
        await record("auth.evimed.session", "completed", { userId: session.user.id });
        sendJson(res, 200, { data: session });
        onSignIn?.(session.user.id);
      } catch (error) {
        await record("auth.evimed.session", "failed", { code: codeOf(error) });
        throw error;
      }
      return true;
    }

    if (url.pathname === EVIMED_LOGOUT_PATH) {
      const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
      await service.endSession(req, res);
      await record("auth.evimed.logout", "completed", { userId: user.id });
      sendJson(res, 200, { data: true });
      return true;
    }

    throw new HttpError(404, "not_found", "EviMed authentication route not found.");
  };
}
