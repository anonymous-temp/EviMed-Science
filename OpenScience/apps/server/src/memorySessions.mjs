/**
 * One conversation's memory, over HTTP: what it was handed (「本次用到的背景」),
 * what the researcher set aside for it (「本次不用」), whether it is incognito,
 * and what it wrote down (「本次新记下」).
 *
 * Hidden knowledge: where the panel's data comes from, and why it is complete.
 * A dispatch records the memories it recalled on its run (`recalledMemories`),
 * the capsule gateway appends every recall the run made through the tool, and
 * the terminal hook records the methods the run loaded (`methodsLoaded`). All
 * of it is on the run ledger, so the panel reads the ledger — no second writer
 * and nothing that can disagree with what the run was actually given
 * (2026-09-19 plan §3.3 #3; ChatGPT's "Memory sources" is the same pattern).
 * What the ledger cannot say — what the runtime has mounted right now — is read
 * from the runtime manager, and marked as available rather than used.
 *
 * The control plane is the whole implementation (plan §3.10): 「本次不用」 is a
 * filter in the recall paths and the gateway, and incognito is a pause of both
 * extraction and recall for one conversation. The runtime's plugin is
 * untouched.
 *
 * @module memorySessions
 */

import { selectCapsuleMethods } from "./capsuleMethods.mjs";
import { HttpError, assertObject, readJson, sendJson } from "./security.mjs";

/** A session id as the kernel writes one. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;

/** @param {unknown} value @param {number} max */
function excerpt(value, max = 200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * What the model is told about the methods set aside for a conversation.
 *
 * A mounted method cannot be taken out of a running conversation without a
 * change to the runtime's plugin, which the plan rules out (§3.10); what the
 * control plane can do is say so where this conversation's context is read —
 * at every dispatch, and in every recall answer. One text for both.
 *
 * @param {readonly string[]} names
 */
export function setAsideMethodsNotice(names) {
  return names.length ? `用户在本对话中选择本次不用这些方法：${names.join("、")}。不要调用或参照它们。` : "";
}

/**
 * A set-aside method as the model can recognise it: the skill name it was
 * mounted under, and the researcher's words for it when they differ.
 * @param {{ id: string, label?: string }} item
 */
export function setAsideMethodName(item) {
  const label = String(item.label ?? "").trim();
  return label && label !== item.id ? `${item.id}（${label}）` : String(item.id);
}

/**
 * The names of the methods a conversation set aside, for its dispatch. Best
 * effort: a state that cannot be read leaves the dispatch as it was before
 * 「本次不用」 existed, rather than failing the researcher's turn.
 *
 * @param {any} researchMemory @param {string} userId @param {string} projectId @param {string} sessionId
 * @returns {Promise<string[]>}
 */
export async function setAsideMethodNames(researchMemory, userId, projectId, sessionId) {
  if (!researchMemory?.configured) return [];
  try {
    const state = await researchMemory.sessionState(userId, projectId, sessionId);
    return (state?.excluded ?? []).filter((/** @type {any} */ item) => item.type === "method").map(setAsideMethodName);
  } catch {
    return [];
  }
}

/**
 * The methods the project's runtime has in its skill directory, by the name
 * the run sees: a learned method by its own name (the list the runtime manager
 * kept at its last launch), a capsule method as `method-<directory>`
 * (`capsuleMethods.mjs`). Each carries what its 「不对」 needs — the method's
 * revision, or the capsule entry's.
 *
 * @param {{ runtimeManager: any, capsules?: any, learning?: any, select?: typeof selectCapsuleMethods }} services
 * @param {{ id: string, userId: string }} project
 */
export async function mountedMethodsFor({ runtimeManager, capsules = null, learning = null, select = selectCapsuleMethods }, project) {
  const userId = String(project.userId);
  const methods = [];
  const learned = runtimeManager?.lastMountedLearnedMethods?.get?.(runtimeManager.key(project)) ?? [];
  for (const method of learned) {
    const document = learning ? await learning.getMethod(userId, method.id).catch(() => null) : null;
    methods.push({
      name: String(method.name), label: String(method.name), source: "learned", methodId: String(method.id),
      description: document ? excerpt(document.payload?.frontmatter?.description, 160) : "",
      revision: document?.revision ?? null, status: document?.payload?.status ?? null,
      trial: method.trial === true, available: Boolean(document),
    });
  }
  const fromCapsules = capsules
    ? await select(capsules, { userId, projectId: String(project.id) }).catch(() => [])
    : [];
  for (const method of fromCapsules) {
    const entry = await capsules.documents.get(userId, "fact", method.id).catch(() => null);
    methods.push({
      name: `method-${method.directoryName}`, label: excerpt(method.content, 60), source: "capsule",
      entryId: String(method.id), capsuleId: String(method.capsuleId), factKind: String(method.factKind),
      description: excerpt(method.content, 160), revision: entry?.revision ?? null,
      status: entry?.payload?.status ?? null, available: Boolean(entry),
    });
  }
  return methods;
}

/**
 * Everything one conversation was handed, and what it wrote down.
 *
 * @param {{ researchMemory: any, agentRuns: any, capsules?: any, mountedMethods?: ((project: any) => Promise<any[]>) | null }} services
 * @param {{ id: string }} user @param {{ id: string }} project @param {string} sessionId
 */
export async function sessionBackground({ researchMemory, agentRuns, capsules = null, mountedMethods = null }, user, project, sessionId) {
  const state = await researchMemory.sessionState(user.id, project.id, sessionId);
  const runs = (await agentRuns.list(project)).filter((/** @type {any} */ run) => run.sessionId === sessionId)
    .sort((/** @type {any} */ left, /** @type {any} */ right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
  const setAside = new Set(state.excluded.map((/** @type {any} */ item) => `${item.type}\u0000${item.id}`));

  /** @type {Map<string, { id: string, kind: string, scope: string, runIds: string[] }>} */
  const recalled = new Map();
  /** @type {Map<string, { name: string, digest: string | null, runIds: string[] }>} */
  const loaded = new Map();
  for (const run of runs) {
    for (const item of run.recalledMemories ?? []) {
      const entry = recalled.get(item.id) ?? { id: item.id, kind: item.kind, scope: item.scope, runIds: [] };
      entry.runIds.push(run.id);
      recalled.set(item.id, entry);
    }
    for (const item of run.methodsLoaded ?? []) {
      const entry = loaded.get(item.name) ?? { name: item.name, digest: item.digest ?? null, runIds: [] };
      entry.runIds.push(run.id);
      loaded.set(item.name, entry);
    }
  }

  // Notes have no single-record read; one page of them answers every note id
  // a recall can have handed out.
  const notes = [...recalled.keys()].some((id) => !id.startsWith("record:") && !id.startsWith("capsule:"))
    ? new Map((await researchMemory.list(user.id, { pageSize: 200 }).catch(() => [])).map((/** @type {any} */ note) => [note.id, note]))
    : new Map();
  const memories = [];
  for (const entry of recalled.values()) {
    if (entry.id.startsWith("record:")) {
      const id = entry.id.slice("record:".length);
      const record = await researchMemory.getRecord(user.id, id).catch(() => null);
      memories.push({
        type: "memory", id, kind: record?.kind ?? entry.kind, scope: record?.scope ?? entry.scope,
        summary: record ? excerpt(record.summary || record.value) : "",
        basis: record?.provenance?.basis ?? null, provenance: record?.provenance ?? null,
        status: record?.status ?? null, version: record?.version ?? null,
        available: Boolean(record), runIds: entry.runIds, setAside: setAside.has(`memory\u0000${id}`),
      });
    } else if (entry.id.startsWith("capsule:")) {
      const id = entry.id.slice("capsule:".length);
      const fact = capsules ? await capsules.documents.get(user.id, "fact", id).catch(() => null) : null;
      memories.push({
        type: "capsule", id, kind: fact?.payload?.factKind ?? entry.kind, scope: "capsule",
        summary: fact ? excerpt(fact.payload.content) : "", capsuleId: fact?.payload?.capsuleId ?? null,
        origin: fact?.payload?.origin ?? null, status: fact?.payload?.status ?? null, revision: fact?.revision ?? null,
        available: Boolean(fact), runIds: entry.runIds, setAside: setAside.has(`capsule\u0000${id}`),
      });
    } else {
      const note = notes.get(entry.id);
      memories.push({
        type: "note", id: entry.id, kind: "note", scope: "user",
        summary: note ? excerpt(note.content) : "", available: Boolean(note),
        runIds: entry.runIds, setAside: setAside.has(`note\u0000${entry.id}`),
      });
    }
  }

  const mounted = mountedMethods ? await mountedMethods(project).catch(() => []) : [];
  const methods = [];
  for (const method of mounted) {
    const used = loaded.get(method.name);
    methods.push({
      ...method, used: Boolean(used), runIds: used?.runIds ?? [],
      setAside: setAside.has(`method\u0000${method.name}`),
    });
    loaded.delete(method.name);
  }
  // Loaded in an earlier run and no longer mounted: still part of what this
  // conversation was given, and said as such.
  for (const entry of loaded.values()) {
    methods.push({
      name: entry.name, label: entry.name, source: "earlier", used: true, runIds: entry.runIds,
      setAside: setAside.has(`method\u0000${entry.name}`), available: false,
    });
  }

  const since = runs[0]?.startedAt ? new Date(Date.parse(runs[0].startedAt) - 1_000).toISOString() : null;
  const written = since
    ? await researchMemory.recentChanges(user.id, { since, sessionId, limit: 20 }).catch(() => [])
    : [];
  return {
    sessionId,
    incognito: state.incognito,
    excluded: state.excluded,
    runs: runs.map((/** @type {any} */ run) => ({ id: run.id, status: run.status, startedAt: run.startedAt ?? null })),
    memories,
    methods,
    written,
  };
}

/**
 * @param {{ config: any, researchMemory: any, agentRuns: any, capsules?: any,
 *   mountedMethods?: ((project: any) => Promise<any[]>) | null,
 *   context: (req: any, res: any) => Promise<any>,
 *   audit: (ctx: any, action: string, status: string, details?: any) => Promise<void> }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createMemorySessionRoutes({ config, researchMemory, agentRuns, capsules = null, mountedMethods = null, context, audit }) {
  return async function memorySessionRoutes(req, res) {
    const pathname = new URL(req.url ?? "/", "http://evimed.local").pathname;
    const match = /^\/api\/memory\/sessions\/([^/]+)(\/background|\/exclusions)?$/.exec(pathname);
    if (!match) return false;
    let sessionId;
    try { sessionId = decodeURIComponent(match[1]); } catch { throw new HttpError(400, "memory_session_invalid", "The session id is invalid."); }
    if (!SESSION_ID.test(sessionId)) throw new HttpError(400, "memory_session_invalid", "The session id is invalid.");
    if (!researchMemory?.configured) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
    const ctx = await context(req, res);
    const tail = match[2] ?? "";

    if (tail === "" && req.method === "GET") {
      sendJson(res, 200, { data: await researchMemory.sessionState(ctx.user.id, ctx.project.id, sessionId) });
      return true;
    }
    // The incognito switch: from the next turn on, nothing of this
    // conversation is extracted and nothing is recalled into it.
    if (tail === "" && req.method === "PUT") {
      const body = assertObject(await readJson(req, config.maxJsonBytes), "session memory");
      if (Object.keys(body).some((field) => field !== "incognito")) {
        throw new HttpError(400, "memory_session_invalid", "Only incognito can be set here.");
      }
      const state = await researchMemory.updateSessionState(ctx.user.id, ctx.project.id, sessionId, { incognito: body.incognito });
      await audit(ctx, "memory.session.incognito", "completed", { target: sessionId, incognito: state.incognito });
      sendJson(res, 200, { data: state });
      return true;
    }
    // 「本次不用」 and its way back.
    if (tail === "/exclusions" && (req.method === "POST" || req.method === "DELETE")) {
      const body = assertObject(await readJson(req, config.maxJsonBytes), "session exclusion");
      if (Object.keys(body).some((field) => !["type", "id", "label"].includes(field))) {
        throw new HttpError(400, "memory_session_invalid", "An exclusion is a type, an id and a label.");
      }
      const state = await researchMemory.updateSessionState(ctx.user.id, ctx.project.id, sessionId,
        req.method === "POST" ? { exclude: body } : { include: { type: body.type, id: body.id } });
      await audit(ctx, req.method === "POST" ? "memory.session.exclude" : "memory.session.include", "completed",
        { target: sessionId, type: String(body.type ?? "") });
      sendJson(res, 200, { data: state });
      return true;
    }
    if (tail === "/background" && req.method === "GET") {
      sendJson(res, 200, { data: await sessionBackground({ researchMemory, agentRuns, capsules, mountedMethods }, ctx.user, ctx.project, sessionId) });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "This session memory route does not accept that method.");
  };
}
