import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const REVISION_GATEWAY_PATH = "/internal/revisions/v1/authorize";

/** Consume one private-snapshot-backed repair authorization for the active workload. */
export function createRevisionGatewayHandler({ runtimeManager, store, agentRuns }) {
  /** @param {any} req @param {any} res @param {(failure:any)=>void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url, "http://evimed.local");
      if (req.method !== "POST" || url.pathname !== REVISION_GATEWAY_PATH || url.search) {
        throw new HttpError(404, "not_found", "Revision authorization operation not found.");
      }
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      let identity;
      try { identity = await runtimeManager.assertActiveEviMedWorkloadToken(token); }
      catch { throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable."); }
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      const project = await store.requireProject(user, identity.projectId);
      const body = await readJson(req, 8 * 1024);
      const allowed = ["runId", "deliverableId", "acceptedDigest"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((field) => !allowed.includes(field))) {
        throw new HttpError(400, "revision_authorization_payload_invalid", "Unsupported revision authorization fields.");
      }
      try { await runtimeManager.assertActiveEviMedWorkloadToken(token); }
      catch { throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable."); }
      const result = await agentRuns.consumeRepairAuthorization(project, {
        ...body,
        runtimeGeneration: identity.runtimeGeneration,
      });
      if (!result.authorized) throw new HttpError(409, "deliverable_revision_unauthorized", "No current repair authorization matches these accepted bytes.");
      sendJson(res, 200, { authorized: true });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "revision_authorization_unavailable", "Revision authorization is unavailable.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
