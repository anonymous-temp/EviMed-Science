import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * What a project's datasets mean, on the files page (`GET`), and the researcher's own confirmation of
 * what is shown (`POST …/confirm`). The browser may confirm facts as they stand; it may not state a
 * source version or a value: a correction is said in the conversation, where the words are kept.
 * @param {{ store: any, service: any, maxJsonBytes: number }} dependencies
 */
export function createDataSemanticsRoutes({ store, service, maxJsonBytes }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const match = /^\/api\/projects\/([^/]+)\/data-semantics(?:\/([^/]+)(?:\/(confirm))?)?$/.exec(url.pathname);
    if (!match) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    let projectId;
    let datasetId;
    try { projectId = decodeURIComponent(match[1]); datasetId = match[2] ? decodeURIComponent(match[2]) : null; }
    catch { throw new HttpError(400, "semantics_request_invalid", "Invalid data-semantics path."); }
    await store.requireProject(user, projectId);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Recorded data meaning is unavailable.");
    let data;
    if ((req.method ?? "GET") === "GET" && !match[3]) {
      if (datasetId) {
        data = await service.get(user.id, projectId, datasetId);
        if (!data) throw new HttpError(404, "semantics_asset_not_found", "No recorded meaning for that dataset.");
      } else data = { items: await service.list(user.id, projectId) };
    } else if (req.method === "POST" && datasetId && match[3] === "confirm") {
      const input = await readJson(req, maxJsonBytes);
      if (Object.keys(input).some((key) => key !== "targets")) throw new HttpError(400, "semantics_request_invalid", "Confirm takes the facts to confirm.");
      data = await service.confirm(user.id, projectId, datasetId, input.targets);
    } else throw new HttpError(405, "method_not_allowed", "Unsupported data-semantics operation.");
    sendJson(res, 200, { data });
    return true;
  };
}
