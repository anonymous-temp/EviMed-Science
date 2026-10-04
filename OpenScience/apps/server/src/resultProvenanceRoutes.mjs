import { HttpError, sendJson } from "./security.mjs";

/** Read-only result inspection. Browser assertions never publish capture facts.
 * `lineage`: the numerical chain of a version (`ResultLineageService.describe`): the calculations its printed numbers are
 * bound to, the versions bound to it when it is a calculation, and what a successor calculation would move.
 * @param {{store:any,service:any,lineage?:any}} dependencies */
export function createResultProvenanceRoutes({ store, service, lineage = null }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (req.method !== "GET" || (url.pathname !== "/api/results" && !/^\/api\/results\/[^/]+(?:\/raw|\/lineage)?$/.test(url.pathname))) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    if (!service) throw new HttpError(503, "result_storage_unavailable", "Result storage is temporarily unavailable.");
    const projectId = url.searchParams.get("projectId");
    if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
    await store.requireProject(user, projectId);
    if (url.pathname === "/api/results") {
      const relatedTo = url.searchParams.get("relatedTo");
      if (relatedTo && !/^rv_[a-f0-9]{64}$/.test(relatedTo)) throw new HttpError(400, "result_identifier_invalid", "Invalid result identifier.");
      const page = relatedTo ? await service.related(user.id, { projectId, versionId: relatedTo,
        limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") })
        : await service.list(user.id, { projectId, path: url.searchParams.get("path") ?? undefined,
        runId: url.searchParams.get("runId") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") });
      sendJson(res, 200, { data: page }); return true;
    }
    let versionId;
    try { versionId = decodeURIComponent(url.pathname.split("/")[3]); }
    catch { throw new HttpError(400, "result_identifier_invalid", "Invalid result identifier."); }
    if (!/^rv_[a-f0-9]{64}$/.test(versionId)) throw new HttpError(400, "result_identifier_invalid", "Invalid result identifier.");
    if (url.pathname.endsWith("/lineage")) {
      if (!lineage) throw new HttpError(503, "result_storage_unavailable", "Result storage is temporarily unavailable.");
      sendJson(res, 200, { data: await lineage.describe(user.id, projectId, versionId) }); return true;
    }
    if (url.pathname.endsWith("/raw")) {
      const { version, bytes } = await service.raw(user.id, projectId, versionId);
      res.writeHead(200, { "Content-Type": version.mimeType, "Content-Length": bytes.length,
        "Content-Disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(version.path.split("/").at(-1))}`,
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        ETag: `"${version.digest}"` });
      res.end(bytes); return true;
    }
    sendJson(res, 200, { data: await service.get(user.id, projectId, versionId) }); return true;
  };
}
