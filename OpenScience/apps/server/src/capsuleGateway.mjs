import { CAPSULE_FACT_KINDS, SOURCE_SCOPE_UNAVAILABLE_CONTEXT } from "@evimed/domain";
import { recallAcrossMemory } from "./memoryRecall.mjs";
import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const CAPSULE_GATEWAY_PATH = "/internal/capsules/v1";

/** The workload credential, never a caller-supplied field, fixes account and project.
 *
 * `memorySubstrate` is the research-memory half of a recall; without it the
 * gateway answers from capsule facts alone, as it did before 2026-09-16.
 *
 * `sessions` tells the gateway which conversation it is answering. The
 * runtime's credential names a project, not a conversation, so the gateway asks
 * the run ledger which conversations are running in it — the rule the model
 * gateway uses to attribute a model call to a run. With exactly one, the recall
 * is that conversation's: the capsule it is trying, and a line in its run's
 * `recalledMemories`. With several at once it cannot tell, and takes the side
 * that protects the researcher: if any of them is trying someone else's
 * capsule, nothing is written.
 *
 * `session` answers for one conversation by its id, which the capsule plugin
 * names at that conversation's first step: what its own state adds to it —
 * the pack a 「试用一次」 conversation is trying (`memorySessions.mjs`). The
 * credential still fixes the account and the project; a conversation of
 * another project is one with no state here.
 *
 * 无痕 and 「本次不用」 were read here until 2026-09-20 and are gone with the bar
 * that was their only control.
 * `subscriptions` is the project's evidence-zone subscriptions (`evidenceZoneSubscription.mjs`, flywheel F18): one more provider of a
 * recall, read for this project alone, appended after what the capsules and memory returned, never counted in the run's recalled
 * memories (a zone's card is reference context, not a memory) and never read in a conversation that is trying someone's pack.
 * @param {{ runtimeManager: any, store: any, service: any, memorySubstrate?: any, evaluationIsolation?: any, handbooks?: any,
 *   subscriptions?: { recall: (userId: string, projectId: string, query: string) => Promise<any[]> } | null,
 *   clinicalContext?: ((identity:any,runs:any[])=>Promise<boolean>) | null,
 *   sessions?: { running: (user: any, project: any) => Promise<{ id: string, sessionId: string }[]>,
 *     state: (userId: string, projectId: string, sessionId: string) => Promise<{ trialCapsuleId?: string | null }>,
 *     notes?: (userId: string, projectId: string, sessionId: string) => Promise<string[]>,
 *     recordRecall: (project: any, runId: string, items: any[]) => Promise<unknown> } | null }} dependencies */
export function createCapsuleGatewayHandler({ runtimeManager, store, service, memorySubstrate = null, sessions = null, handbooks = null, evaluationIsolation = null, subscriptions = null, clinicalContext = null }) {
  const windows = new Map();
  /** @param {any} req @param {any} res @param {(failure:any)=>void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url, "http://evimed.local");
      const action = url.pathname.slice(CAPSULE_GATEWAY_PATH.length + 1);
      if (req.method !== "POST" || url.search || !["recall", "note", "session", "handbook-context", "handbook-attached"].includes(action)) {
        throw new HttpError(404, "not_found", "Capsule operation not found.");
      }
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const identity = await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      await store.requireProject(user, identity.projectId);
      if (!service) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = JSON.stringify([identity.userId, identity.projectId]);
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      if (!windows.has(key) && windows.size >= 10_000) throw new HttpError(503, "capsule_busy", "Research memory is busy.");
      windows.set(key, window);
      if (++window.count > 120) throw new HttpError(429, "capsule_rate_limited", "Too many memory operations.");
      const body = await readJson(req, 64 * 1024);
      const allowed = action === "recall" ? ["query", "factKinds", "since", "scope", "asOf"]
        : action === "handbook-context" ? ["sessionId", "inputs"]
          : action === "handbook-attached" ? ["sessionId", "receipts"]
        : action === "session" ? ["sessionId"] : ["factKind", "content", "origin"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((field) => !allowed.includes(field))) {
        throw new HttpError(400, "capsule_payload_invalid", "Unsupported memory fields.");
      }
      // Body streaming may outlive runtime stop, rotation or account removal.
      await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const currentUser = await store.userById(identity.userId);
      if (!currentUser) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      const project = await store.requireProject(currentUser, identity.projectId);
      if (action === "handbook-context" || action === "handbook-attached") {
        if (!handbooks) { sendJson(res, 200, action === "handbook-context" ? { contexts: [] } : { attached: [] }); return; }
        const answer = action === "handbook-context" ? await handbooks.read(project, body) : await handbooks.acknowledge(project, body);
        sendJson(res, 200, evaluationIsolation ? await evaluationIsolation.filter(identity, "handbook", answer) : answer);
        return;
      }
      if (action === "session") {
        if (typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.sessionId)) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid session id.");
        }
        // An unreadable selection cannot silently widen the knowledge-base scope.
        const notes = sessions?.notes ? await sessions.notes(currentUser.id, identity.projectId, body.sessionId)
          .catch(() => [SOURCE_SCOPE_UNAVAILABLE_CONTEXT]) : [];
        sendJson(res, 200, evaluationIsolation ? await evaluationIsolation.filter(identity, "session-memory", { context: notes.join("\n\n") }) : { context: notes.join("\n\n") });
        return;
      }
      // Whose conversation this is, as far as the ledger can say (see above).
      // A ledger that cannot be read leaves the recall as it was before this
      // existed rather than failing it.
      const running = sessions ? await sessions.running(currentUser, project).catch(() => []) : [];
      if (action === "note" && await clinicalContext?.(identity, running)) {
        sendJson(res, 200, { entry: null, reviewRequired: false, takesEffect: false, contextOnly: true,
          notice: "本次对话读取了受试者资料，内容保留在该研究中，不写入通用研究记忆。" });
        return;
      }
      const states = sessions
        ? await Promise.all(running.map((run) => sessions.state(currentUser.id, identity.projectId, run.sessionId)
          .catch(() => ({ trialCapsuleId: null }))))
        : [];
      // A trial of someone else's capsule writes none of this researcher's
      // memory and reads none of it: the pack reaches the conversation as its
      // first-step context (`memorySessions.mjs`), and that is all it reads
      // (build spec §9.4-5; the recall half landed on 2026-09-29).
      const writesNothing = await evaluationIsolation?.isEvaluation(identity) || states.some((state) => Boolean(state.trialCapsuleId));
      const trialConversation = running.length === 1 && Boolean(states[0]?.trialCapsuleId);
      if (action === "recall") {
        if (body.factKinds !== undefined && (!Array.isArray(body.factKinds) || body.factKinds.length > CAPSULE_FACT_KINDS.length || body.factKinds.some((kind) => !CAPSULE_FACT_KINDS.includes(kind)))) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory kinds.");
        }
        if (body.since != null && (typeof body.since !== "string" || body.since.length > 40 || !Number.isFinite(Date.parse(body.since)))) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory date.");
        }
        if (body.scope !== undefined && !["all", "capsule", "conversation", "agenda"].includes(body.scope)) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory scope.");
        }
        if (trialConversation) {
          sendJson(res, 200, { items: [], mode: "trial", contextOnly: true, sources: { memory: 0, capsule: 0 },
            notice: "这是一段试用别人胶囊的对话：只读这个胶囊，不读用户自己的记忆。" });
          return;
        }
        const recalled = await recallAcrossMemory({ capsules: service, memorySubstrate }, currentUser, {
          ...body, projectId: identity.projectId,
          sessionId: running.length === 1 ? running[0].sessionId : null,
        });
        if (sessions && running.length === 1) {
          await sessions.recordRecall(project, running[0].id, recalled.items).catch(() => null);
        }
        // Reference context of the evidence zones this project follows. A failure to read costs the recall this part only.
        // An evaluation run is frozen at a date and kept from what the platform has written since: no zone card reaches it.
        const reference = subscriptions && body.scope !== "conversation" && typeof body.query === "string" && !(await evaluationIsolation?.isEvaluation(identity))
          ? await subscriptions.recall(currentUser.id, identity.projectId, body.query).catch(() => []) : [];
        const answer = reference.length
          ? { ...recalled, items: [...recalled.items, ...reference], sources: { ...recalled.sources, zone: reference.length } } : recalled;
        sendJson(res, 200, evaluationIsolation ? await evaluationIsolation.filter(identity, "capsule-memory", answer) : answer);
      } else if (writesNothing) {
        // A conversation trying someone else's capsule leaves nothing behind.
        sendJson(res, 200, {
          entry: null, reviewRequired: false, takesEffect: false, contextOnly: true,
          notice: "这是一段试用别人胶囊的对话：这条没有记下。需要记住的话，请用户在普通对话里再说一次。",
        });
      } else {
        // A model's claim that its input was explicit is not the researcher's
        // own statement: the note is written as the assistant's, takes effect
        // at once as context (owner ruling 2026-09-19) and is never mounted as
        // a method (capsuleMethods.mjs). `reviewRequired` stays in the answer
        // as false, for a runtime that still reads it.
        const entry = await service.note(user.id, identity.projectId, { factKind: body.factKind, content: body.content, origin: "inferred" });
        sendJson(res, 200, { entry, reviewRequired: false, takesEffect: true, contextOnly: true });
      }
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "capsule_unavailable", "Research memory is unavailable.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
