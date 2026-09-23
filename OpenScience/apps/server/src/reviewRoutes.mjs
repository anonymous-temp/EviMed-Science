import { HttpError, sendJson } from "./security.mjs";

/**
 * The browser's reads of the independent review (`/api/review/*`).
 *
 * Hidden knowledge:
 *
 * - Read-only. The reviewer's findings are answered by the run that received
 *   them (through the review gateway), never from the page; what a reader
 *   gets here is what the review found and what the writer answered.
 * - Scoped by the session's own account and the project it names: a finding
 *   quotes a report and a reply check quotes an answer, so a project id that
 *   is not the caller's is a 404 like a project that does not exist.
 * - Off is invisible: with the module off every path answers 404
 *   `review_not_enabled`, and the shell stops asking.
 * - No per-request usage admission: these spend nothing, and the shell polls
 *   the reply checks of the open conversation.
 *
 *   GET /api/review/replies?projectId=&sessionId=   the reply checks of one conversation (L1)
 *   GET /api/review/runs/:runId?projectId=          the reviews of one run's deliverables (L2/L3)
 *
 * @module reviewRoutes
 */

const NOT_ENABLED = () => new HttpError(404, "review_not_enabled", "The independent review is not enabled.");
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The bounded metric label of a review path. @param {string} pathname */
export function reviewRoutePattern(pathname) {
  if (pathname === "/api/review/replies") return "/api/review/replies";
  if (pathname.startsWith("/api/review/runs/")) return "/api/review/runs/:id";
  return "/api/review/:route";
}

/**
 * @param {{ store: any, service: any, config: Record<string, any> }} dependencies
 */
export function createReviewRoutes({ store, service, config }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/review" && !url.pathname.startsWith("/api/review/")) return false;
    if (!config?.reviewEnabled || !service?.enabled) throw NOT_ENABLED();
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "method_not_allowed", "The review is read-only here.");
    const projectId = String(url.searchParams.get("projectId") ?? "");
    if (!PROJECT_ID.test(projectId)) throw new HttpError(400, "review_request_invalid", "projectId is required.");
    const project = await store.requireProject(user, projectId);
    const identity = { userId: user.id, projectId: project.id };
    if (url.pathname === "/api/review/replies") {
      const sessionId = String(url.searchParams.get("sessionId") ?? "");
      if (!SESSION_ID.test(sessionId)) throw new HttpError(400, "review_request_invalid", "sessionId is required.");
      sendJson(res, 200, { data: { checks: await service.replyChecksForSession(identity, sessionId) } }, { "Cache-Control": "private, no-store" });
      return true;
    }
    if (url.pathname.startsWith("/api/review/runs/")) {
      let runId;
      try { runId = decodeURIComponent(url.pathname.slice("/api/review/runs/".length)); }
      catch { throw new HttpError(400, "review_request_invalid", "Invalid run id."); }
      if (!RUN_ID.test(runId)) throw new HttpError(400, "review_request_invalid", "Invalid run id.");
      sendJson(res, 200, { data: { reviews: await service.reviewsForRun(identity, runId) } }, { "Cache-Control": "private, no-store" });
      return true;
    }
    throw new HttpError(404, "not_found", "Review route not found.");
  };
}
