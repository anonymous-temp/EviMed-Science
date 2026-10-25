import { CAPSULE_FACT_KINDS, SOURCE_SCOPE_UNAVAILABLE_CONTEXT, identifierShapesIn } from "@evimed/domain";
import { recordRecallTool } from "./memoryMetrics.mjs";
import { recallAcrossMemory } from "./memoryRecall.mjs";
import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const CAPSULE_GATEWAY_PATH = "/internal/capsules/v1";

/** What a recall answers while the researcher has paused recall: an answer, not an error, and not "no memories". */
const recallPaused = () => ({
  items: [], mode: "paused", contextOnly: true, sources: { memory: 0, capsule: 0 },
  notice: "用户已暂停记忆（整个账号或本项目）：这里不读取，也不代表没有相关记忆。",
});

/** What a recall answers when nothing reached the relevance floor: an answer the model can act on — look again in other words, or go on without. */
const NOTHING_ABOVE_THE_FLOOR = "没有达到相关度下限的记忆。可以换个说法再查一次，或不依赖记忆直接回答。";

/**
 * The capsule's half of an account's `search` (`memoryGateway.mjs`, item 9): the recall the capsule tool answers with, for the
 * capsules in force (the entries of the whole account and of this project) and the evidence zones the project follows, and nothing of the
 * account's own memory files (those are the engine's). The index nominates and PostgreSQL decides, as for the recall tool, so a fact the
 * person forgot or an entry still waiting for them is never returned however long the index lags. A failure of either half is that half's alone.
 * @param {{ service: { recall: Function } | null, subscriptions?: { recall: (userId: string, projectId: string, query: string) => Promise<any[]> } | null }} dependencies
 * @returns {(request: { user: any, project: any, query: string, limit: number }) => Promise<Record<string, any>[]>}
 */
export function createNativeCapsuleSearch({ service, subscriptions = null }) {
  return async ({ user, project, query, limit }) => {
    if (!service || !String(query ?? "").trim()) return [];
    const [capsule, reference] = await Promise.all([
      recallAcrossMemory({ capsules: service }, user, { query, projectId: project.id, limit, standing: false, scope: "capsule" })
        .then((answer) => answer.items).catch(() => []),
      subscriptions ? subscriptions.recall(user.id, project.id, query).catch(() => []) : [],
    ]);
    return [...capsule, ...reference];
  };
}

/** The workload credential, never a caller-supplied field, fixes account and project.
 *
 * What this answers is the capsule's: its facts, its notes, the methods it mounts — and the route of the input a conversation is about to
 * run (`native-route`, `nativeInputRoute.mjs`). The account's own memory is
 * the engine's, reached through the memory gateway (`memoryGateway.mjs`); the records half this route once added to a recall was
 * the legacy engine's and is gone (2026-10-25).
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
 * `paused` is the researcher's own 「记忆」 switches (`memoryPausedFor`): the account's, 「本项目不使用记忆」, and a trial conversation's.
 * This is where the capsule half and the note honour them (2026-10-10 review M-1). Recall paused answers `mode: "paused"` and reads nothing; learning paused refuses the note by name. Asked of the one
 * running conversation, or of none when several are running (then the account's and the project's switches only); a switch that
 * cannot be read fails the call, so the tool reports memory unavailable instead of reading for a researcher who may have asked for none.
 *
 * 无痕 and 「本次不用」 were read here until 2026-09-20 and are gone with the bar
 * that was their only control.
 * `recallLimit` is how many items the recall tool answers with when the model does not say, and `recallMaxLimit` the most it may ask
 * for (`OPEN_SCIENCE_MEMORY_RECALL_TOOL_LIMIT`, `..._MAX_LIMIT`): a recall that returns what it found above the relevance floor, five
 * at most unless the model asks for more, and says so when it found nothing (review M6, 2026-10-10).
 * `subscriptions` is the project's evidence-zone subscriptions (`evidenceZoneSubscription.mjs`, flywheel F18): one more provider of a
 * recall, read for this project alone, appended after what the capsules and memory returned, never counted in the run's recalled
 * memories (a zone's card is reference context, not a memory) and never read in a conversation that is trying someone's pack.
 * With the memory engine on, a conversation's own entrance is the engine's plugin, whose `search` also covers the capsule's half
 * (`createNativeCapsuleSearch`, `memoryGateway.mjs`), and the capsule's recall and note tools are not registered for it
 * (`packages/socket/plugins/capsule.mjs`, `memoryEnabled`); the recall and note actions here are for a deployment without the engine.
 * @param {{ runtimeManager: any, store: any, service: any, evaluationIsolation?: any, nativeRoutes?: any,
 *   recallLimit?: number, recallMaxLimit?: number,
 *   subscriptions?: { recall: (userId: string, projectId: string, query: string) => Promise<any[]> } | null,
 *   clinicalContext?: ((identity:any,runs:any[])=>Promise<boolean>) | null,
 *   sessions?: { running: (user: any, project: any) => Promise<{ id: string, sessionId: string }[]>,
 *     state: (userId: string, projectId: string, sessionId: string) => Promise<{ trialCapsuleId?: string | null }>,
 *     paused?: (userId: string, projectId: string, sessionId: string | null) => Promise<{ learning: boolean, recall: boolean, trial: boolean }>,
 *     notes?: (userId: string, projectId: string, sessionId: string) => Promise<string[]>,
 *     recordRecall: (project: any, runId: string, items: any[]) => Promise<unknown> } | null }} dependencies */
export function createCapsuleGatewayHandler({ runtimeManager, store, service, sessions = null, nativeRoutes = null, evaluationIsolation = null, subscriptions = null, clinicalContext = null,
  recallLimit = 5, recallMaxLimit = 8 }) {
  const maxLimit = Math.max(1, Math.min(30, Math.trunc(Number(recallMaxLimit)) || 8));
  const defaultLimit = Math.max(1, Math.min(maxLimit, Math.trunc(Number(recallLimit)) || 5));
  const windows = new Map();
  /** @param {any} req @param {any} res @param {(failure:any)=>void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url, "http://evimed.local");
      const action = url.pathname.slice(CAPSULE_GATEWAY_PATH.length + 1);
      if (req.method !== "POST" || url.search || !["recall", "note", "session", "native-route"].includes(action)) {
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
      const allowed = action === "recall" ? ["query", "factKinds", "since", "scope", "limit"]
        : action === "native-route" ? ["sessionId", "inputs"]
        : action === "session" ? ["sessionId"] : ["factKind", "content", "origin"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((field) => !allowed.includes(field))) {
        throw new HttpError(400, "capsule_payload_invalid", "Unsupported memory fields.");
      }
      // Body streaming may outlive runtime stop, rotation or account removal.
      await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const currentUser = await store.userById(identity.userId);
      if (!currentUser) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      const project = await store.requireProject(currentUser, identity.projectId);
      if (action === "native-route") {
        if (!nativeRoutes) { sendJson(res, 200, { routes: [] }); return; }
        const answer = await nativeRoutes.read(project, body);
        sendJson(res, 200, evaluationIsolation ? await evaluationIsolation.filter(identity, "native-route", answer) : answer);
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
      const pause = sessions?.paused
        ? await sessions.paused(currentUser.id, identity.projectId, running.length === 1 ? running[0].sessionId : null)
        : null;
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
        // How many the model wants, within what the platform answers with: absent means the default, and more than the most is
        // the most (a tool call is not refused for asking for a few too many).
        if (body.limit !== undefined && (!Number.isFinite(Number(body.limit)) || Number(body.limit) < 1)) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory limit.");
        }
        const limit = body.limit === undefined ? defaultLimit : Math.min(maxLimit, Math.trunc(Number(body.limit)));
        if (trialConversation) {
          recordRecallTool("trial");
          sendJson(res, 200, { items: [], mode: "trial", contextOnly: true, sources: { memory: 0, capsule: 0 },
            notice: "这是一段试用别人胶囊的对话：只读这个胶囊，不读用户自己的记忆。" });
          return;
        }
        // `standing: false`: this is the lookup; the researcher's standing profile was handed over up front, and an answer
        // padded with it could never be empty (`ResidentProfiles`).
        const recalled = pause?.recall ? recallPaused() : await recallAcrossMemory({ capsules: service }, currentUser, {
          ...body, limit, standing: false, projectId: identity.projectId,
          sessionId: running.length === 1 ? running[0].sessionId : null,
        });
        if (!pause?.recall && sessions && running.length === 1) {
          await sessions.recordRecall(project, running[0].id, recalled.items).catch(() => null);
        }
        // Reference context of the evidence zones this project follows. A failure to read costs the recall this part only.
        // An evaluation run is frozen at a date and kept from what the platform has written since: no zone card reaches it.
        const reference = subscriptions && body.scope !== "conversation" && typeof body.query === "string" && !(await evaluationIsolation?.isEvaluation(identity))
          ? await subscriptions.recall(currentUser.id, identity.projectId, body.query).catch(() => []) : [];
        /** @type {any} */
        const found = reference.length
          ? { ...recalled, items: [...recalled.items, ...reference], sources: { ...recalled.sources, zone: reference.length } } : recalled;
        // Nothing above the relevance floor is an answer, said as one: the model reformulates or goes on, and an empty list
        // is not mistaken for a tool that failed. A recall the researcher paused already carries its own notice, and says so.
        const answer = !pause?.recall && found.items.length === 0 && !found.notice ? { ...found, notice: NOTHING_ABOVE_THE_FLOOR } : found;
        recordRecallTool(pause?.recall ? "paused" : answer.items.length ? "hit" : "empty", answer.items.length);
        sendJson(res, 200, evaluationIsolation ? await evaluationIsolation.filter(identity, "capsule-memory", answer) : answer);
      } else if (writesNothing) {
        // A conversation trying someone else's capsule leaves nothing behind.
        sendJson(res, 200, {
          entry: null, reviewRequired: false, takesEffect: false, contextOnly: true,
          notice: "这是一段试用别人胶囊的对话：这条没有记下。需要记住的话，请用户在普通对话里再说一次。",
        });
      } else if (pause?.learning) {
        // The researcher's own pause (the account's, or 「本项目不使用记忆」): nothing is written, and the answer says that and
        // is not a success. A trial conversation was refused above with its own notice.
        sendJson(res, 200, {
          entry: null, reviewRequired: false, takesEffect: false, contextOnly: true, status: "memory_paused",
          notice: "用户已暂停记忆（整个账号或本项目）：这条没有记下。需要记住的话，请用户先在记忆设置里恢复记忆。",
        });
      } else if (identifierShapesIn(body.content).length) {
        // A credential or anyone's identifier — an ID-card number, a phone, a card, an e-mail, a key — is not kept even when the
        // researcher asks: the conversation has it and the memory never does, and the model is told so to say it in its own
        // words (2026-10-12 review: this path checked nothing, while extraction refused the same text).
        sendJson(res, 200, {
          entry: null, reviewRequired: false, takesEffect: false, contextOnly: true, status: "not_kept",
          notice: "这条含有密钥、证件号、手机号、卡号或邮箱这类信息，没有记下。可以只记住不含这些信息的部分。",
        });
      } else {
        // A model's claim that its input was explicit is not the researcher's
        // own statement: the note is written as the assistant's, takes effect
        // at once as context (owner ruling 2026-09-19) and is never mounted as
        // a method (capsuleMethods.mjs). `reviewRequired` stays in the answer
        // as false, for a runtime that still reads it.
        const entry = await service.note(user.id, identity.projectId, { factKind: body.factKind, content: body.content, origin: "inferred" });
        // "At once" is true of a note that is approved and sits in a capsule that is in force. A note kept in a capsule nothing
        // reads (the researcher switched their capsule off), or one the researcher already undid, is stored and does not take
        // effect, and the model is told so (2026-10-10 review M-8: the answer was a constant).
        const takesEffect = entry?.payload?.status === "approved"
          && await service.inForce(user.id, String(entry.payload.capsuleId));
        sendJson(res, 200, {
          entry, reviewRequired: false, takesEffect, contextOnly: true,
          ...(takesEffect ? {} : { notice: "这条已存下，但目前不会被读取：用户的记忆胶囊没有启用，或这条已被用户撤销。" }),
        });
      }
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "capsule_unavailable", "Research memory is unavailable.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
