import { HttpError, readJson, safeId, sendJson } from "./security.mjs";

/** The owner may refresh an inventory; only signed-in deployment operators may plan and apply historical capture repairs.
 * @param {{store:any,runs:any,service:any,config:any,maxJsonBytes:number}} dependencies */
export function createResultCaptureRepairRoutes({ store, runs, service, config, maxJsonBytes }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const ordinary = /^\/api\/agent-runs\/([^/]+)\/artifacts\/refresh$/.exec(url.pathname);
    const operator = url.pathname === "/api/ops/result-capture-repairs";
    if (!ordinary && !operator) return false;
    if (req.method !== "POST") throw new HttpError(404, "not_found", "Route not found.");
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (operator && !(config.operatorUsers ?? []).includes(user.id)) throw new HttpError(403, "result_capture_repair_operator_required", "Capture repairs are available to operators only.");
    const body = await readJson(req, Math.min(maxJsonBytes, 8192));
    const allowed = ordinary ? ["projectId", "expectedTranscriptSha256"]
      : ["action", "userId", "projectId", "runId", "expectedReceiptSha256", "expectedPlanSha256", "resettle"];
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, "invalid_payload", "Invalid capture repair fields.");
    const projectId = safeId(body.projectId, "project id");
    let data;
    if (ordinary) {
      const project = await store.requireProject(user, projectId);
      let runId;
      try { runId = safeId(decodeURIComponent(ordinary[1]), "run id"); } catch { throw new HttpError(400, "invalid_payload", "Invalid run id."); }
      data = await runs.refreshArtifacts(project, runId, { expectedTranscriptSha256: body.expectedTranscriptSha256 });
    } else {
      if (!service) throw new HttpError(503, "result_storage_unavailable", "Result storage is temporarily unavailable.");
      const request = { userId: safeId(body.userId, "user id"), projectId, runId: safeId(body.runId, "run id"), requestedBy: user.id,
        ...(body.expectedReceiptSha256 ? { expectedReceiptSha256: body.expectedReceiptSha256 } : {}) };
      if (body.action === "plan") data = await service.plan(request);
      else if (body.action === "apply") {
        if (!/^[a-f0-9]{64}$/.test(body.expectedReceiptSha256 ?? "") || !/^[a-f0-9]{64}$/.test(body.expectedPlanSha256 ?? "")
          || (body.resettle !== undefined && typeof body.resettle !== "boolean")) throw new HttpError(400, "result_capture_repair_plan_required", "Apply requires the exact plan and receipt digests.");
        data = await service.apply({ ...request, expectedReceiptSha256: body.expectedReceiptSha256, expectedPlanSha256: body.expectedPlanSha256, resettle: body.resettle === true });
      } else throw new HttpError(400, "invalid_payload", "Use plan or apply for a capture repair.");
    }
    sendJson(res, 200, { data }, { "Cache-Control": "private, no-store" });
    return true;
  };
}
