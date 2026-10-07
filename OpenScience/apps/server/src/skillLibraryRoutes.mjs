import { HttpError, readBody, readJson, sendJson } from "./security.mjs";

/** @param {{store:any,service:any,maxJsonBytes:number,saveProject?:any}} dependencies */
export function createSkillLibraryRoutes({ store, service, maxJsonBytes, saveProject = null }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const personal = /^\/api\/skills(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    const projectRoute = /^\/api\/projects\/([^/]+)\/skills(?:\/([^/]+)\/invoke)?$/.exec(url.pathname);
    const catalogueRoute = /^\/api\/projects\/([^/]+)\/skills\/(effective|duplicate)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!personal && !projectRoute && !catalogueRoute) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Skill library storage is unavailable.");
    const reply = (data, status = 200) => { res.setHeader("Cache-Control", "no-store"); sendJson(res, status, { data }); return true; };
    const body = () => readJson(req, maxJsonBytes);
    const decode = value => {
      try { return decodeURIComponent(value); }
      catch { throw new HttpError(400, "extension_contract_invalid", "Invalid skill path."); }
    };
    if (catalogueRoute) {
      const project = await store.requireProject(user, decode(catalogueRoute[1]));
      if (catalogueRoute[2] === 'effective' && req.method === 'GET') {
        const allowed = catalogueRoute[3] ? ['sessionId', 'expectedRuntimeGeneration'] : ['sessionId'];
        if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1)) throw new HttpError(400, 'extension_contract_invalid', 'Invalid catalogue query.');
        return reply(catalogueRoute[3] ? await service.effectiveDetail(user, project, { key: decode(catalogueRoute[3]),
          sessionId: url.searchParams.get('sessionId'), expectedRuntimeGeneration: url.searchParams.get('expectedRuntimeGeneration') })
          : await service.effectiveCatalogue(user, project, url.searchParams.get('sessionId')));
      }
      if (catalogueRoute[2] === 'duplicate' && !catalogueRoute[3] && req.method === 'POST') return reply(await service.duplicateNative(user, project, await body()), 201);
    } else if (projectRoute) {
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
      // The platform's own skills, answered from the control plane's packages (no runtime, session or project): the list, one
      // skill's words and full text, and a copy of it into the account's own skills. The skill's id is its package id
      // (`core/stats-integrity`), so it arrives encoded as one path segment.
      if (id === "platform" && !action && req.method === "GET") return reply(await service.listPlatform(user));
      if (id === "platform" && action && !rawResource && req.method === "GET") return reply(await service.readPlatform(user, decode(action)));
      if (id === "platform" && action && rawResource === "copy" && req.method === "POST") return reply(await service.duplicatePlatform(user, decode(action), await body()), 201);
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
      if (id === "import-preview" && !action && req.method === "POST") return reply(await service.previewImport(user, await body()));
      if (id === 'repository-preview' && !action && req.method === 'POST') return reply(await service.previewRepository(user, await body()));
      if (id === "defaults" && !action && req.method === "GET") return reply(await service.defaults(user));
      if (id === "defaults" && !action && req.method === "PUT") return reply(await service.saveDefaults(user, await body()));
      if (id && !action && req.method === "GET") return reply(await service.get(user, id));
      if (id && !action && req.method === "PUT") return reply(await service.update(user, id, await body()));
      if (id && !action && req.method === "DELETE") return reply(await service.remove(user, id, await body()));
      if (id && action === "revisions" && req.method === "GET") return reply(await service.history(user, id));
      if (id && action === "restore" && req.method === "POST") return reply(await service.restore(user, id, await body()));
      // What the skill is (source, licence, version, scripts, dependencies, operations) and whether this runtime can
      // supply what it needs: a label, read for the current revision or a named one.
      if (id && action === "supply" && !rawResource && req.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "revision") || url.searchParams.getAll("revision").length > 1) throw new HttpError(400, "extension_contract_invalid", "Invalid supply query.");
        const revision = url.searchParams.get("revision");
        return reply(await service.supplyOf(user, id, revision === null ? null : Number(revision)));
      }
      // Updating an edited copy toward a newer upstream: the plan changes nothing; the update makes a new revision.
      if (id && action === "update-preview" && !rawResource && req.method === "POST") return reply(await service.updatePreview(user, id, await body()));
      if (id && action === "update" && !rawResource && req.method === "POST") return reply(await service.applyUpdate(user, id, await body()), 201);
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
