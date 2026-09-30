import { HttpError, readJson, sendJson } from "./security.mjs";

async function bodyOf(req, limit, allowed) {
  const body = await readJson(req, limit);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "autopilot_payload_invalid", "The proactive research request has unsupported fields.");
  }
  return body;
}

/** @param {{store:any,service:any,maxJsonBytes:number}} dependencies */
export function createAutopilotRoutes({ store, service, maxJsonBytes }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/autopilot" && !url.pathname.startsWith("/api/autopilot/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Proactive research storage is temporarily unavailable.");
    let parts;
    try { parts = url.pathname.slice("/api/autopilot".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "autopilot_path_invalid", "Invalid proactive research path."); }
    const method = req.method ?? "GET";
    const reply = (value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    const requireProject = async (projectId) => { await store.requireProject(user, projectId); return projectId; };

    if (parts[0] === "agendas" && parts.length === 1) {
      if (method === "GET") {
        const projectId = url.searchParams.get("projectId");
        if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
        return reply(await service.list(user.id, { projectId: await requireProject(projectId) }));
      }
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["projectId", "title", "topics", "taskTypes", "dailyBudgetCny", "weeklyBudgetCny", "maxEpisodeCny", "scheduleHour", "timeZone", "prompt", "schedule"]);
        body.projectId = await requireProject(body.projectId);
        return reply(service.projectAgenda(await service.create(user.id, body)), 201);
      }
    }
    if (parts[0] === "agendas" && parts.length === 2 && ["GET", "PATCH", "DELETE"].includes(method)) {
      const agenda = await service.get(user.id, parts[1]);
      await requireProject(agenda.projectId);
      if (method === "GET") {
        service.assertNotArchived(agenda);
        return reply(service.projectAgenda(agenda));
      }
      const body = await bodyOf(req, maxJsonBytes, method === "DELETE" ? ["expectedRevision"]
        : ["expectedRevision", "title", "prompt", "schedule", "taskTypes", "dailyBudgetCny", "weeklyBudgetCny", "maxEpisodeCny"]);
      return reply(service.projectAgenda(await service[method === "DELETE" ? "archive" : "update"](user.id, agenda.id, body)));
    }
    if (parts[0] === "agendas" && parts.length === 3 && method === "POST") {
      const agenda = await service.get(user.id, parts[1]);
      await requireProject(agenda.projectId);
      if (["start", "stop"].includes(parts[2])) {
        return reply(service.projectAgenda(await service[parts[2]](user.id, agenda.id, await bodyOf(req, maxJsonBytes, ["expectedRevision"]))));
      }
      if (parts[2] === "run-now") return reply(await service.runNow(user.id, agenda.id, await bodyOf(req, maxJsonBytes, ["requestId"])));
      if (parts[2] === "follow-ups") return reply(await service.followUp(user.id, agenda.id, await bodyOf(req, maxJsonBytes, ["requestId", "note", "episodeId"])));
      if (parts[2] === "schedule") {
        return reply(await service.schedule(user.id, agenda.id, await bodyOf(req, maxJsonBytes, ["date"])));
      }
    }
    if (parts[0] === "episodes" && parts.length === 1 && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      return reply(await service.listEpisodes(user.id, { projectId: await requireProject(projectId), agendaId: url.searchParams.get("agendaId") }));
    }
    if (parts[0] === "digests" && parts.length === 1 && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
      return reply(await service.listDigests(user.id, { projectId: await requireProject(projectId) }));
    }
    if (parts[0] === "digests" && parts.length === 2 && method === "GET") {
      const digest = await service.getDigest(user.id, parts[1]);
      await requireProject(digest.projectId);
      return reply(digest);
    }
    if (parts[0] === "digests" && parts.length === 3 && parts[2] === "opened" && method === "POST") {
      const digest = await service.getDigest(user.id, parts[1]);
      await requireProject(digest.projectId);
      await bodyOf(req, maxJsonBytes, []);
      return reply(await service.markDigestOpened(user.id, digest.id));
    }
    if (parts[0] === "digests" && parts.length === 3 && parts[2] === "decisions" && method === "POST") {
      const digest = await service.getDigest(user.id, parts[1]);
      await requireProject(digest.projectId);
      return reply(await service.decide(user.id, digest.id,
        await bodyOf(req, maxJsonBytes, ["action", "claimId", "note"])));
    }
    throw new HttpError(404, "not_found", "Proactive research route not found.");
  };
}
