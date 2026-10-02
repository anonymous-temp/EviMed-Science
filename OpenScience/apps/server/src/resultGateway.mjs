import { canonicalJson, mcpToolName } from "@evimed/domain";
import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const RESULT_GATEWAY_PATH = "/internal/results/v1";

/** The pending native call, not a runtime-provided model/actor label, binds the
 * first calculation. Status reads still reauthorize the current project. */
export function createResultGateway({ runtimeManager, store, service, agentRuns, resolveSession = (_project, _sessionId) => null }) {
  const identity = async token => {
    try { return runtimeManager.assertActiveModelGatewayToken(token); }
    catch {
      try { return await runtimeManager.assertActiveEviMedWorkloadToken(token); }
      catch { throw new HttpError(401, "result_workload_unavailable", "The calculation workload is unavailable."); }
    }
  };
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url ?? "/", "http://evimed.local");
      const operation = url.pathname.slice(RESULT_GATEWAY_PATH.length + 1);
      if (req.method !== "POST" || !["start", "status", "cancel"].includes(operation) || url.search) throw new HttpError(404, "not_found", "Calculation operation not found.");
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const auth = await identity(token);
      const user = await store.userById(auth.userId);
      if (!user) throw new HttpError(401, "result_workload_unavailable", "The calculation workload is unavailable.");
      const project = await store.requireProject(user, auth.projectId);
      if (!service) throw new HttpError(503, "result_calculation_unavailable", "Calculations are unavailable.");
      const input = await readJson(req, 16384);
      const fields = operation === "start" ? ["method", "inputPath", "parameters", "requestId"] : ["jobId"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new HttpError(400, "result_calculation_invalid", "Unsupported calculation fields.");
      let result;
      if (operation === "start") {
        let context;
        /** @type {any} */
        let ownedSession = null;
        try { context = JSON.parse(String(req.headers["x-evimed-execution-context"] ?? "")); } catch { /* rejected below */ }
        if (context?.v !== 1 || !["sessionId", "callId"].every(key => typeof context[key] === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(context[key]))) {
          throw new HttpError(403, "result_invocation_unavailable", "A current native calculation call is required.");
        }
        const revalidate = async () => {
          const fresh = await identity(token);
          if (fresh.userId !== auth.userId || fresh.projectId !== auth.projectId) throw new HttpError(403, "result_invocation_unavailable", "The calculation scope changed.");
          ownedSession = resolveSession(project, context.sessionId);
          const transcript = await runtimeManager.sessionTranscript(project, context.sessionId, { wake: false,
            ...(ownedSession?.child ? { parentSessionId: ownedSession.parentSessionId } : {}) });
          const turn = transcript?.turns?.at(-1);
          const calls = (transcript?.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
            .filter(item => item.part.type === "tool" && item.part.callId === context.callId);
          if (transcript?.sessionId !== context.sessionId || transcript.truncated || !turn || turn.end !== null || calls.length !== 1
            || calls[0].part.status !== "pending" || calls[0].message.turnStartSeq !== turn.startSeq
            || ![mcpToolName("research_calculate"), "research_calculate"].includes(calls[0].part.tool)) {
            throw new HttpError(403, "result_invocation_unavailable", "The native calculation call is unavailable.");
          }
          const actual = calls[0].part.input;
          if (!actual || (actual.action ?? "start") !== "start" || actual.method !== input.method || actual.inputPath !== input.inputPath
            || canonicalJson(actual.parameters ?? {}) !== canonicalJson(input.parameters ?? {})
            || actual.requestId && actual.requestId !== input.requestId) throw new HttpError(403, "result_invocation_unavailable", "The calculation request differs from its native call.");
        };
        await revalidate();
        const run = (await agentRuns.activeRuns(project)).find(item => item.id === ownedSession?.runId || item.sessionId === context.sessionId);
        result = await service.calculate(user.id, project, input, { kind: "engine", sessionId: context.sessionId,
          callId: context.callId, runId: run?.id ?? null, parentSessionId: ownedSession?.parentSessionId ?? null,
          branchId: ownedSession?.branchId ?? null }, revalidate);
      } else {
        if (typeof input.jobId !== "string" || !/^replay_[a-f0-9]{64}$/.test(input.jobId)) throw new HttpError(400, "result_calculation_invalid", "Invalid calculation identity.");
        await identity(token);
        result = operation === "status" ? await service.status(user.id, project.id, input.jobId) : await service.cancel(user.id, project.id, input.jobId);
      }
      sendJson(res, operation === "start" ? 202 : 200, { data: result });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "result_calculation_unavailable", "The calculation is unavailable.");
      onFailure?.({ code: safe.code, status: safe.status }); sendError(res, safe);
    }
  };
}
