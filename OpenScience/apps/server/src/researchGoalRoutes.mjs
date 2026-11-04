import { HttpError, sendJson } from "./security.mjs";
import { assertClientProject } from "./internalProjects.mjs";

const SESSION = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * `/api/research-goals`: what 主动科研 reads and does about a project's long research goals.
 *
 *   GET  /api/research-goals?projectId=…                      { data: { available, goals: [{ sessionId, status, reason, statusAt, goalId, progress }] } }
 *   POST /api/research-goals/:sessionId/pause?projectId=…     pause it (LoopX's own state)
 *   POST /api/research-goals/:sessionId/resume?projectId=…    take it up again, from any state it rests in
 *
 * A stop is the run's own route (`POST /api/agent-runs/:id/cancel`): stopping a round stops the goal, and `observeRound` writes that down.
 * With no service (no PostgreSQL, the switch off) `available` is false and the page reads a goal by its rounds alone.
 * @param {{ store: any, goals: import('./researchGoalService.mjs').ResearchGoals | null }} dependencies
 */
export function createResearchGoalRoutes({ store, goals }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/research-goals" && !url.pathname.startsWith("/api/research-goals/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    const projectId = url.searchParams.get("projectId");
    assertClientProject(projectId);
    const project = await store.requireProject(user, projectId);
    const parts = url.pathname.slice("/api/research-goals".length).split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (parts.length === 0 && method === "GET") {
      sendJson(res, 200, { data: { available: Boolean(goals), goals: goals ? await goals.list(project) : [] } });
      return true;
    }
    if (parts.length === 2 && method === "POST" && (parts[1] === "pause" || parts[1] === "resume")) {
      if (!goals) throw new HttpError(409, "research_goal_unavailable", "Long research is not available on this deployment.");
      const sessionId = decodeURIComponent(parts[0]);
      if (!SESSION.test(sessionId)) throw new HttpError(404, "research_goal_not_found", "The research goal is unavailable.");
      sendJson(res, 200, { data: parts[1] === "pause" ? await goals.pause(project, sessionId) : await goals.resume(project, sessionId) });
      return true;
    }
    throw new HttpError(404, "not_found", "Route not found.");
  };
}
