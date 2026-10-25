import { assertClientProject } from "./internalProjects.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";

async function bodyOf(req, limit, allowed) {
  const body = await readJson(req, limit);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "autopilot_payload_invalid", "The proactive research request has unsupported fields.");
  }
  return body;
}

/**
 * @param {{store:any,service:any,maxJsonBytes:number,enabled?:boolean,
 *   stopRun?: ((project: any, runId: string) => Promise<unknown>) | null}} dependencies
 *   `stopRun` stops one run the way the run's own cancel does (the control plane's `stopRunForUser`); the cancel route of one
 *   execution hands it the run of an execution that is going.
 */
export function createAutopilotRoutes({ store, service, maxJsonBytes, enabled = true, stopRun = null }) {
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
    const admitsWork = method === "POST" && parts[0] === "agendas" && (parts.length === 1
      || (parts.length === 3 && ["start", "run-now", "follow-ups", "schedule"].includes(parts[2])));
    if (!enabled && admitsWork) throw new HttpError(503, "task_tools_disabled", "Scheduled tasks are unavailable on this deployment.");
    const reply = (value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    const requireProject = async (projectId) => { assertClientProject(projectId); await store.requireProject(user, projectId); return projectId; };
    const cancellationOptions = async agenda => {
      const project = stopRun ? await store.requireProject(user, agenda.projectId) : null;
      return { stopRun: stopRun ? ({ runId }) => stopRun(project, runId) : null };
    };
    const projectAgenda = agenda => {
      const projected = service.projectAgenda(agenda);
      return { ...projected, payload: { ...projected.payload, schedulingAvailable: enabled, ...(!enabled ? { nextRunAt: null } : {}) } };
    };

    if (parts[0] === "agendas" && parts.length === 1) {
      if (method === "GET") {
        const projectId = url.searchParams.get("projectId");
        if (!projectId) throw new HttpError(400, "project_required", "A project is required.");
        const page = await service.list(user.id, { projectId: await requireProject(projectId) });
        return reply({ ...page, available: enabled, items: page.items.map(projectAgenda) });
      }
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["projectId", "title", "topics", "taskTypes", "dailyBudgetCny", "weeklyBudgetCny", "maxEpisodeCny", "scheduleHour", "timeZone", "prompt", "schedule", "sourceIds", "sha256"]);
        body.projectId = await requireProject(body.projectId);
        return reply(projectAgenda(await service.create(user.id, body)), 201);
      }
    }
    if (parts[0] === "agendas" && parts.length === 2 && ["GET", "PATCH", "DELETE"].includes(method)) {
      const agenda = await service.get(user.id, parts[1]);
      await requireProject(agenda.projectId);
      if (method === "GET") {
        service.assertNotArchived(agenda);
        return reply(projectAgenda(agenda));
      }
      const body = await bodyOf(req, maxJsonBytes, method === "DELETE" ? ["expectedRevision"]
        : ["expectedRevision", "title", "prompt", "schedule", "taskTypes", "dailyBudgetCny", "weeklyBudgetCny", "maxEpisodeCny", "sourceIds", "sha256"]);
      return reply(projectAgenda(method === "DELETE" ? await service.archive(user.id, agenda.id, body, await cancellationOptions(agenda))
        : await service.update(user.id, agenda.id, body)));
    }
    // The question as the researcher reads it — found, unresolved, the material they
    // added — and the material itself: sources of the question's own project,
    // registered by the ordinary knowledge-base upload and only associated here.
    if (parts[0] === "agendas" && parts.length === 3 && parts[2] === "progress" && method === "GET") {
      const agenda = await service.get(user.id, parts[1]);
      await requireProject(agenda.projectId);
      return reply(await service.researchState(user.id, agenda.id));
    }
    if (parts[0] === "agendas" && parts[2] === "materials" && (parts.length === 3 ? method === "POST" : parts.length === 4 && method === "DELETE")) {
      const agenda = await service.get(user.id, parts[1]);
      await requireProject(agenda.projectId);
      if (method === "DELETE") return reply(projectAgenda(await service.removeMaterial(user.id, agenda.id, parts[3])));
      return reply(projectAgenda(await service.addMaterials(user.id, agenda.id, await bodyOf(req, maxJsonBytes, ["sourceIds", "sha256"]))));
    }
    // One execution of a task, canceled on its own: the task keeps its schedule. Idempotent for an execution that is over.
    if (parts[0] === "agendas" && parts.length === 5 && parts[2] === "episodes" && parts[4] === "cancel" && method === "POST") {
      const agenda = await service.get(user.id, parts[1]);
      const project = await store.requireProject(user, await requireProject(agenda.projectId));
      const body = await bodyOf(req, maxJsonBytes, ["requestId"]);
      if (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 160) {
        throw new HttpError(400, "autopilot_payload_invalid", "Canceling an execution needs a request id of 1 to 160 characters.");
      }
      const canceled = await service.cancelEpisode(user.id, agenda.id, parts[3], {
        stopRun: stopRun ? ({ runId }) => stopRun(project, runId) : null,
      });
      return reply(service.projectEpisode(canceled));
    }
    if (parts[0] === "agendas" && parts.length === 3 && method === "POST") {
      const agenda = await service.get(user.id, parts[1]);
      await requireProject(agenda.projectId);
      if (["start", "stop"].includes(parts[2])) {
        const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
        return reply(projectAgenda(parts[2] === "stop" ? await service.stop(user.id, agenda.id, body, await cancellationOptions(agenda))
          : await service.start(user.id, agenda.id, body)));
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
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "autopilot_payload_invalid", "History page size must be between 1 and 100.");
      return reply(await service.listEpisodes(user.id, { projectId: await requireProject(projectId), agendaId: url.searchParams.get("agendaId"), cursor: url.searchParams.get("cursor"), limit }));
    }
    if (parts[0] === "episodes" && parts.length === 2 && method === "GET") {
      const episode = await service.getEpisode(user.id, parts[1]);
      await requireProject(episode.projectId);
      return reply(service.projectEpisode(episode));
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
