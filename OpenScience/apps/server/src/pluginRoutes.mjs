import { HttpError, readJson, sendJson } from "./security.mjs";
/** @param {{store:any,service:any,maxJsonBytes:number}} dependencies */
export function createPluginRoutes({ store, service, maxJsonBytes }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const match = /^\/api\/projects\/([^/]+)\/plugins(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Plugin settings storage is unavailable.");
    let projectId;
    try { projectId = decodeURIComponent(match[1]); } catch { throw new HttpError(400, "plugin_path_invalid", "Invalid project path."); }
    const project = await store.requireProject(user, projectId);
    const [, , pluginId, action] = match;
    // The approved set is the registry the service derives from the recorded
    // community bundle support, not a name written here. An id outside it is
    // refused before any project state is read, on every verb.
    if (pluginId && !service.supports(pluginId)) throw new HttpError(404, "plugin_not_supported", "This plugin is not approved for this runtime image.");
    const reply = value => { res.setHeader("Cache-Control", "no-store"); sendJson(res, 200, { data: value }); return true; };
    if (!pluginId && req.method === "GET") return reply(await service.list(user, project));
    if (pluginId && !action && req.method === "PUT") return reply(await service.save(user, project, await readJson(req, maxJsonBytes), pluginId));
    // Removal is a state change, not a deletion: the binary ships inside the
    // runtime image. It disables the plugin, drops the project's configuration
    // back to its defaults and records that as a revision.
    if (pluginId && !action && req.method === "DELETE") return reply(await service.remove(user, project, await readJson(req, maxJsonBytes), pluginId));
    if (action === "revisions" && req.method === "GET") return reply(await service.history(user, project, pluginId));
    if (action === "rollback" && req.method === "POST") return reply(await service.rollback(user, project, await readJson(req, maxJsonBytes), pluginId));
    if (action === "retry" && req.method === "POST") {
      const body = await readJson(req, maxJsonBytes);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new HttpError(400, "plugin_config_invalid", "Retry accepts no configuration fields.");
      return reply(await service.retry(user, project, pluginId));
    }
    throw new HttpError(404, "not_found", "Plugin route not found.");
  };
}
