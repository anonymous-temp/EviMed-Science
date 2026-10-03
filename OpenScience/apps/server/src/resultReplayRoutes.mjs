import { HttpError, readJson, sendJson } from "./security.mjs";

export function createResultReplayRoutes({ store, service }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const selected = /^\/api\/results\/(rv_[a-f0-9]{64})\/replays$/.exec(url.pathname);
    const replay = /^\/api\/result-replays\/(replay_[a-f0-9]{64})(?:\/(cancel))?$/.exec(url.pathname);
    if (!selected && !replay) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "result_replay_unavailable", "Calculation replay is unavailable.");
    if (selected && req.method === "POST") {
      const input = await readJson(req, 2048);
      if (!input || Object.keys(input).some(key => !["projectId", "digest", "requestId"].includes(key))) throw new HttpError(400, "result_replay_request_invalid", "Select an existing result to recalculate.");
      sendJson(res, 202, { data: await service.request(user.id, selected[1], input) });
    } else if (replay && req.method === "GET" && !replay[2]) sendJson(res, 200, { data: await service.status(user.id, url.searchParams.get("projectId"), replay[1]) });
    else if (replay && req.method === "POST" && replay[2] === "cancel") {
      const input = await readJson(req, 1024);
      sendJson(res, 200, { data: await service.cancel(user.id, input.projectId, replay[1]) });
    } else throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    return true;
  };
}
