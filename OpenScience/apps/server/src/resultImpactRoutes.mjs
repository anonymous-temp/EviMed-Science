import { HttpError, readJson, sendJson } from "./security.mjs";

/** Explicit user actions; source-check reconciliation is internal, never caller supplied evidence. */
export function createResultImpactRoutes({ store, service, maxJsonBytes }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const match = /^\/api\/projects\/([^/]+)\/result-impacts(?:\/([^/]+)(?:\/(continue))?)?$/.exec(url.pathname);
    if (!match) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    let projectId, id;
    try { projectId = decodeURIComponent(match[1]); id = match[2] ? decodeURIComponent(match[2]) : null; }
    catch { throw new HttpError(400, "result_impact_payload_invalid", "Invalid result impact path."); }
    await store.requireProject(user, projectId);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Result impact storage is unavailable.");
    let data;
    if ((req.method ?? "GET") === "GET" && !match[3]) {
      data = id ? await service.get(user.id, projectId, id) : await service.list(user.id, { projectId,
        versionId: url.searchParams.get("versionId"), limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") });
    } else if (req.method === "POST" && id && match[3] === "continue") {
      const input = await readJson(req, maxJsonBytes);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["agendaId", "expectedRevision"].includes(key))
        || typeof input.agendaId !== "string") throw new HttpError(400, "result_impact_payload_invalid", "Select an existing research agenda.");
      data = await service.continueImpact(user.id, projectId, id, input);
    } else throw new HttpError(405, "method_not_allowed", "Unsupported result impact operation.");
    sendJson(res, 200, { data });
    return true;
  };
}
