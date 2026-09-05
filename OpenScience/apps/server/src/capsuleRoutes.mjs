import { HttpError, readJson, sendJson } from "./security.mjs";
import { CAPSULE_TRANSFER_MAX_BYTES } from "./capsuleTransferService.mjs";

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "capsule_payload_invalid", "The capsule request has unsupported fields.");
  }
  return value;
}

/** @param {URL} url */
function pageOptions(url) {
  return { limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor"), deleted: url.searchParams.get("deleted") === "true" };
}

/** Typed user endpoints; no generic product document write API is exposed.
 * @param {{ store: any, service: any, transferService?: any, maxJsonBytes: number }} dependencies */
export function createCapsuleRoutes({ store, service, transferService = null, maxJsonBytes }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/capsules" && !url.pathname.startsWith("/api/capsules/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Research memory storage is temporarily unavailable.");
    let parts;
    try { parts = url.pathname.slice("/api/capsules".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "capsule_path_invalid", "Invalid capsule path."); }
    const method = req.method ?? "GET";
    const reply = (value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    const project = async (id) => {
      if (id != null) await store.requireProject(user, id);
      return id ?? null;
    };

    if (parts.length === 0) {
      if (method === "GET") return reply(await service.list(user.id, pageOptions(url)));
      if (method === "POST") return reply(await service.create(user.id, await bodyOf(req, maxJsonBytes, ["title", "description"])), 201);
    }
    if (parts.length === 1 && parts[0] === "recall" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["query", "projectId", "limit"]);
      body.projectId = await project(body.projectId);
      return reply(await service.recall(user.id, { ...body, accountCreatedAt: user.accountCreatedAt }));
    }
    if (parts.length === 1 && parts[0] === "active" && method === "GET") {
      return reply(await service.active(user.id, await project(url.searchParams.get("projectId"))));
    }
    if ((parts[0] === "transfers" && parts.length === 2) || parts[1] === "exports") {
      if (!transferService) throw new HttpError(503, "product_state_unavailable", "Capsule transfer is temporarily unavailable.");
      const accountContext = { accountCreatedAt: user.accountCreatedAt };
      if (parts[0] === "transfers" && method === "POST") {
        if (parts[1] === "preview") return reply(await transferService.preview(user.id,
          await bodyOf(req, CAPSULE_TRANSFER_MAX_BYTES * 2 + 4096, ["archive", "password"]), accountContext));
        if (parts[1] === "import") return reply(await transferService.import(user.id,
          await bodyOf(req, CAPSULE_TRANSFER_MAX_BYTES * 2 + 4096, ["archive", "password", "expectedDigest", "confirmed", "title"]), accountContext), 201);
      }
      if (parts[1] === "exports" && parts.length === 2) {
        if (method === "GET") return reply(await transferService.history(user.id, parts[0], { cursor: url.searchParams.get("cursor") }));
        if (method === "POST") return reply(await transferService.export(user.id, parts[0],
          await bodyOf(req, 4096, ["password", "scopes", "supersedes"]), accountContext), 201);
      }
      if (parts[1] === "exports" && parts.length === 3) {
        if (method === "DELETE") {
          const body = await bodyOf(req, 4096, ["expectedRevision"]);
          return reply(await transferService.revoke(user.id, parts[0], parts[2], body.expectedRevision));
        }
        if (method === "GET") {
          const result = await transferService.download(user.id, parts[0], parts[2]);
          res.writeHead(200, { "content-type": "application/vnd.evimed.capsule+json", "cache-control": "no-store",
            "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="${result.filename}"` });
          res.end(result.archive); return true;
        }
      }
      throw new HttpError(404, "not_found", "Capsule transfer route not found.");
    }
    const [capsuleId, action, entryId, entryAction] = parts;
    if (parts.length === 1) {
      if (method === "GET") return reply(await service.get(user.id, capsuleId));
      if (method === "PATCH") return reply(await service.update(user.id, capsuleId,
        await bodyOf(req, maxJsonBytes, ["title", "description", "expectedRevision"])));
      if (method === "DELETE") {
        const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
        return reply(await service.remove(user.id, capsuleId, body.expectedRevision));
      }
    }
    if (parts.length === 2 && action === "activate" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["mode", "projectId"]);
      body.projectId = await project(body.projectId);
      return reply(await service.activate(user.id, capsuleId, body));
    }
    if (parts.length === 2 && action === "restore" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service.restore(user.id, capsuleId, body.expectedRevision));
    }
    if (parts.length === 2 && action === "history" && method === "GET") {
      await service.get(user.id, capsuleId);
      return reply(await service.documents.history(user.id, "capsule", capsuleId, {
        limit: Number(url.searchParams.get("limit") ?? 50),
        beforeRevision: url.searchParams.has("beforeRevision") ? Number(url.searchParams.get("beforeRevision")) : null,
      }));
    }
    if (action === "entries" && parts.length === 2) {
      if (method === "GET") return reply(await service.entries(user.id, capsuleId, pageOptions(url)));
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["factKind", "layer", "content"]);
        return reply(await service.addEntry(user.id, capsuleId, { ...body, origin: "explicit", provenance: [{ type: "user", id: user.id }] }), 201);
      }
    }
    if (action === "entries" && parts.length === 3 && method === "PATCH") {
      return reply(await service.updateEntry(user.id, capsuleId, entryId,
        await bodyOf(req, maxJsonBytes, ["content", "status", "expectedRevision"])));
    }
    if (action === "entries" && parts.length === 4 && entryAction === "history" && method === "GET") {
      await service.get(user.id, capsuleId);
      const entry = await service.documents.get(user.id, "fact", entryId);
      if (!entry || entry.payload.capsuleId !== capsuleId) throw new HttpError(404, "capsule_entry_not_found", "The capsule entry is unavailable.");
      return reply(await service.documents.history(user.id, "fact", entryId, {
        limit: Number(url.searchParams.get("limit") ?? 50),
        beforeRevision: url.searchParams.has("beforeRevision") ? Number(url.searchParams.get("beforeRevision")) : null,
      }));
    }
    throw new HttpError(404, "not_found", "Capsule route not found.");
  };
}
