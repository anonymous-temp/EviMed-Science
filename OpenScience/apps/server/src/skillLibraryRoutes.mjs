import { HttpError, readBody, readJson, sendJson } from "./security.mjs";

/** @param {{store:any,service:any,maxJsonBytes:number,saveProject?:any}} dependencies */
export function createSkillLibraryRoutes({ store, service, maxJsonBytes, saveProject = null }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const personal = /^\/api\/skills(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    const projectRoute = /^\/api\/projects\/([^/]+)\/skills(?:\/([^/]+)\/invoke)?$/.exec(url.pathname);
    if (!personal && !projectRoute) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Skill library storage is unavailable.");
    const reply = (data, status = 200) => { res.setHeader("Cache-Control", "no-store"); sendJson(res, status, { data }); return true; };
    const body = () => readJson(req, maxJsonBytes);
    const decode = value => {
      try { return decodeURIComponent(value); }
      catch { throw new HttpError(400, "extension_contract_invalid", "Invalid skill path."); }
    };
    if (projectRoute) {
      const project = await store.requireProject(user, decode(projectRoute[1]));
      if (!projectRoute[2] && req.method === "GET") return reply(await service.projectSelections(user, project));
      if (!projectRoute[2] && req.method === "PUT") {
        const input = await body();
        return reply(await (saveProject ? saveProject(user, project, input) : service.saveProjectSelections(user, project, input)));
      }
      if (projectRoute[2] && req.method === "POST") return reply(await service.invoke(user, project, decode(projectRoute[2]), await body()));
    } else {
      const [, rawId, action, rawResource] = personal;
      const id = rawId ? decode(rawId) : null;
      if (!id && req.method === "GET") return reply(await service.list(user, { cursor: url.searchParams.get("cursor"), limit: 50 }));
      if (!id && req.method === "POST") return reply(await service.create(user, await body()), 201);
      if (id === "uploads" && !action && req.method === "POST") {
        if (req.headers["content-type"] !== "application/octet-stream" || [...url.searchParams.keys()].some(key => key !== "kind")) {
          throw new HttpError(400, "extension_contract_invalid", "Invalid skill upload.");
        }
        return reply(await service.upload(user, url.searchParams.get("kind"), await readBody(req, 4 * 1024 * 1024)), 201);
      }
      if (id === "uploads" && action && !rawResource && req.method === "DELETE") {
        const input = await body();
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new HttpError(400, "extension_contract_invalid", "Invalid skill upload removal.");
        return reply(await service.removeUpload(user, decode(action)));
      }
      if (id === "import" && !action && req.method === "POST") return reply(await service.import(user, await body()), 201);
      if (id === "defaults" && !action && req.method === "GET") return reply(await service.defaults(user));
      if (id === "defaults" && !action && req.method === "PUT") return reply(await service.saveDefaults(user, await body()));
      if (id && !action && req.method === "GET") return reply(await service.get(user, id));
      if (id && !action && req.method === "PUT") return reply(await service.update(user, id, await body()));
      if (id && !action && req.method === "DELETE") return reply(await service.remove(user, id, await body()));
      if (id && action === "revisions" && req.method === "GET") return reply(await service.history(user, id));
      if (id && action === "restore" && req.method === "POST") return reply(await service.restore(user, id, await body()));
      if (id && action === "resources" && rawResource && req.method === "GET") {
        const bytes = await service.resource(user, id, Number(url.searchParams.get("revision")), decode(rawResource));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", "attachment");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end(bytes); return true;
      }
    }
    throw new HttpError(404, "not_found", "Skill route not found.");
  };
}
