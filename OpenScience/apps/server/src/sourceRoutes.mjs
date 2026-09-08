import { projectSourceManifestRecord } from "./sourceService.mjs";
import { openListSourceInput } from "./openListSourceConnector.mjs";
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
 * @param {{store:any,service:any,openList?:any,maxJsonBytes:number}} dependencies */
export function createSourceRoutes({ store, service, openList = null, maxJsonBytes }) {
  // The composition builds one OpenList connector for the browser's namespace and
  // shares this SourceService instance with the ingestion worker. Handing the
  // connector to the service here is what lets the leased folder sync page the
  // same namespace; there is no second client and no second credential.
  if (service && openList) service.useConnector("openlist", openList);
  // A queued job carries worker-only identity (the account generation it was cut
  // against). The browser needs to know a sync is scheduled, not what it holds.
  const folderReply = ({ folder, job, ...rest }) => ({ folder, ...rest, scheduled: Boolean(job) });
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/sources" && !url.pathname.startsWith("/api/sources/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Source analysis storage is temporarily unavailable.");
    const method = req.method ?? "GET";
    const project = value => value?.kind === "source" ? projectSourceManifestRecord(value)
      : value?.source?.kind === "source" ? { ...value, source: projectSourceManifestRecord(value.source) }
      : Array.isArray(value?.items) ? { ...value, items: value.items.map(item => item?.kind === "source" ? projectSourceManifestRecord(item) : item) } : value;
    const reply = (value, status = 200) => { sendJson(res, status, { data: project(value) }); return true; };
    if (url.pathname === "/api/sources/openlist" && method === "GET") {
      if (!openList) throw new HttpError(503, "openlist_unavailable", "OpenList is not configured for this deployment.");
      const projectId = url.searchParams.get("projectId");
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      await store.requireProject(user, projectId);
      const cursor = url.searchParams.get("cursor");
      const page = cursor == null ? 1 : Number(cursor);
      return reply(await openList.list(user.id, url.searchParams.get("path") ?? "/", { page, perPage: 100 }));
    }
    if (url.pathname === "/api/sources/openlist/import" && method === "POST") {
      if (!openList) throw new HttpError(503, "openlist_unavailable", "OpenList is not configured for this deployment.");
      const input = await bodyOf(req, maxJsonBytes, ["projectId", "path"]);
      const projectId = typeof input.projectId === "string" ? input.projectId : "";
      const selected = typeof input.path === "string" ? input.path : "";
      await store.requireProject(user, projectId);
      const item = await openList.stat(user.id, selected);
      if (item.entryType !== "file") throw new HttpError(400, "openlist_file_required", "Select a file to import.");
      // Register the path the connector resolved, not the one the browser typed:
      // the folder sync registers the same resolved paths, and the two must land
      // in one version family rather than two.
      return reply(await service.register(user.id, openListSourceInput(projectId, item)), 201);
    }
    if (url.pathname === "/api/sources/folders" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      await store.requireProject(user, projectId);
      return reply(await service.listFolders(user.id, { projectId,
        limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") }));
    }
    if (url.pathname === "/api/sources/folders" && method === "POST") {
      if (!openList) throw new HttpError(503, "openlist_unavailable", "OpenList is not configured for this deployment.");
      const input = await bodyOf(req, maxJsonBytes, ["projectId", "path"]);
      const projectId = typeof input.projectId === "string" ? input.projectId : "";
      await store.requireProject(user, projectId);
      // Refuse a folder the account cannot even browse, so a registration never
      // promises a sync the namespace would reject on every run.
      const selected = typeof input.path === "string" ? input.path : "";
      const item = await openList.stat(user.id, selected);
      if (item.entryType !== "dir") throw new HttpError(400, "source_folder_invalid", "Select a folder to sync.");
      return reply(folderReply(await service.registerFolder(user.id, { projectId, connectorType: "openlist", path: item.path })), 201);
    }
    if (url.pathname.startsWith("/api/sources/folders/")) {
      let segments;
      try { segments = url.pathname.slice("/api/sources/folders/".length).split("/").filter(Boolean).map(decodeURIComponent); }
      catch { throw new HttpError(400, "source_folder_invalid", "Invalid folder path."); }
      if (segments.length < 1 || segments.length > 2) throw new HttpError(404, "not_found", "Source route not found.");
      const [folderId, folderAction] = segments;
      const folder = await service.getFolder(user.id, folderId);
      await store.requireProject(user, folder.projectId);
      if (segments.length === 1 && method === "GET") return reply(folder);
      if (segments.length === 1 && method === "PATCH") {
        return reply(folderReply(await service.setFolderStatus(user.id, folderId, await bodyOf(req, maxJsonBytes, ["expectedRevision", "status"]))));
      }
      if (folderAction === "sync" && method === "POST") {
        return reply(folderReply(await service.syncFolder(user.id, folderId, await bodyOf(req, maxJsonBytes, ["expectedRevision"]))));
      }
      throw new HttpError(404, "not_found", "Source route not found.");
    }
    if (url.pathname === "/api/sources/duplicates" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      await store.requireProject(user, projectId);
      return reply(await service.duplicateCandidates(user.id, { projectId, limit: Number(url.searchParams.get("limit") ?? 50) }));
    }
    if (url.pathname === "/api/sources/duplicates" && method === "POST") {
      const input = await bodyOf(req, maxJsonBytes, ["projectId", "groupKey", "sourceIds", "decision", "note"]);
      await store.requireProject(user, typeof input.projectId === "string" ? input.projectId : "");
      return reply(await service.decideDuplicate(user.id, input), 201);
    }
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
        familyId: url.searchParams.get("familyId"),
        limit: Number(url.searchParams.get("limit") ?? 50),
        cursor: url.searchParams.get("cursor"),
      }));
    }
    if (parts.length < 1 || parts.length > 3) throw new HttpError(404, "not_found", "Source route not found.");
    const [sourceId, action] = parts;
    const source = await service.get(user.id, sourceId, { includeDeleted: method === "DELETE" });
    await store.requireProject(user, source.projectId);
    if (action === "family" && method === "GET" && parts.length === 2) {
      return reply(await service.family(user.id, sourceId, { limit: Number(url.searchParams.get("limit") ?? 50) }));
    }
    if (action === "understanding" && method === "GET") {
      if (parts.length === 2) return reply(await service.getUnderstanding(user.id, sourceId));
      if (parts[2] === "history") return reply(await service.understandingHistory(user.id, sourceId, {
        limit: Number(url.searchParams.get("limit") ?? 20), cursor: url.searchParams.get("cursor"),
      }));
    }
    if (parts.length > 2) throw new HttpError(404, "not_found", "Source route not found.");
    if (parts.length === 1 && method === "GET") return reply(source);
    if (parts.length === 1 && method === "PATCH") {
      return reply(await service.override(user.id, sourceId,
        await bodyOf(req, maxJsonBytes, ["expectedRevision", "docType", "depth", "reason"])));
    }
    if (parts.length === 1 && method === "DELETE") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service.remove(user.id, sourceId, { ...body, accountCreatedAt: user.accountCreatedAt }));
    }
    if (["retry", "cancel"].includes(action) && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service[action](user.id, sourceId, body));
    }
    throw new HttpError(404, "not_found", "Source route not found.");
  };
}
