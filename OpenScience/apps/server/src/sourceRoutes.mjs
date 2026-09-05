import { HttpError, readJson, sendJson } from "./security.mjs";

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "source_payload_invalid", "The source request has unsupported fields.");
  }
  return value;
}

/** Account-authenticated source inventory and user corrections.
 * @param {{store:any,service:any,maxJsonBytes:number}} dependencies */
export function createSourceRoutes({ store, service, maxJsonBytes }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/sources" && !url.pathname.startsWith("/api/sources/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Source analysis storage is temporarily unavailable.");
    const method = req.method ?? "GET";
    const reply = (value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    let parts;
    try { parts = url.pathname.slice("/api/sources".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "source_path_invalid", "Invalid source path."); }

    if (parts.length === 0 && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      await store.requireProject(user, projectId);
      return reply(await service.list(user.id, {
        projectId,
        status: url.searchParams.get("status"),
        limit: Number(url.searchParams.get("limit") ?? 50),
        cursor: url.searchParams.get("cursor"),
      }));
    }
    if (parts.length < 1 || parts.length > 2) throw new HttpError(404, "not_found", "Source route not found.");
    const [sourceId, action] = parts;
    const source = await service.get(user.id, sourceId);
    await store.requireProject(user, source.projectId);
    if (parts.length === 1 && method === "GET") return reply(source);
    if (parts.length === 1 && method === "PATCH") {
      return reply(await service.override(user.id, sourceId,
        await bodyOf(req, maxJsonBytes, ["expectedRevision", "docType", "depth", "reason"])));
    }
    if (parts.length === 1 && method === "DELETE") {
      return reply(await service.remove(user.id, sourceId,
        await bodyOf(req, maxJsonBytes, ["expectedRevision"])));
    }
    if (["retry", "cancel"].includes(action) && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service[action](user.id, sourceId, body));
    }
    throw new HttpError(404, "not_found", "Source route not found.");
  };
}
