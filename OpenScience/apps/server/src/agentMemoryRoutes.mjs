import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { AGENT_RECALL_MAX_CAPSULES, AGENT_RECALL_METHOD_MODES, recallForAgent } from "./agentMemoryRecall.mjs";
import { memoryBoard, methodAction, methodDetail, noteAction, recordAction } from "./agentMemoryBoard.mjs";
import { OBSERVATION_FIELDS, readObservation } from "./agentMemoryObservations.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";
import { assertAgentSubject } from "./agentApiKeys.mjs";
import { agentMemoryOpenApi } from "./agentMemoryOpenApi.mjs";

/**
 * The memory API an agent that is not ours calls.
 *
 * Hidden knowledge: this is deliberately not a new service. Every verb below
 * already existed and was already reachable — `recall` and `note` from the
 * runtime over `/internal/capsules/v1`, `records` from the browser over
 * `/api/memory/records`. What was missing was never the logic; it was a
 * credential an external caller could hold (`agentApiKeys`) and a surface that
 * did not assume a browser session or a container we minted. Building a second
 * implementation of recall for external callers is how the two would diverge,
 * and the divergence would be invisible until an external agent got a different
 * answer from the same store.
 *
 * Three rules that are properties of this surface rather than of the services
 * underneath it, and each one is here because the caller is not ours:
 *
 *  1. **Nothing written here takes effect by itself.** A note arrives as an
 *     `inferred` candidate and every episode-derived record as `pending`
 *     (`recordRun(..., { holdForOwner: true })`); the parameter that would say
 *     otherwise does not exist. A model's claim that its user said something
 *     outright is not the user saying it, and an external agent's claim is one
 *     more step removed. The account owner confirms, or does not. An episode
 *     may add evidence to a memory already in force and never changes one.
 *  2. **Scope comes from the key.** A key bound to a project cannot read or
 *     write outside it, and no request field can widen that. An integration
 *     key may name the person a request is for (`X-Subject`), and then every
 *     read and write is that person's account and nobody else's; without the
 *     header it is the key's own account — the institution's (agentApiKeys.mjs).
 *  3. **`episodes` is an input, not an import.** An external agent posts what
 *     happened — the turns — and extraction decides what, if anything, is worth
 *     remembering, through the same extractor and the same quote-integrity
 *     checks a run of ours goes through. An endpoint that let a caller insert
 *     records directly would be a way to write memory with no evidence behind
 *     it, which is the one thing the record shape exists to prevent.
 *
 * @module agentMemoryRoutes
 */

export const AGENT_MEMORY_PATH = "/api/agent-memory/v1";

/** Per key, per minute. Generous for an agent doing real work, far below what
 * a loop costs. Held in memory on purpose: it protects this process's own
 * resources, and a durable counter would be a database write per call. */
const RATE_LIMIT_PER_MINUTE = 120;
const MAX_TRACKED_KEYS = 10_000;

/** Every operation this surface serves, as the root lists them. A contract test
 *  holds the OpenAPI description's paths to exactly this list. */
export const AGENT_MEMORY_ENDPOINTS = Object.freeze([
  "POST /recall", "POST /note", "GET /records", "POST /episodes",
  "POST /observations", "GET /dashboard", "PUT /settings",
  "PATCH /records/{id}", "POST /records/{id}/confirm", "POST /records/{id}/forget", "POST /records/{id}/restore", "POST /records/{id}/undo",
  "GET /methods/{id}", "POST /methods/{id}/retire", "POST /methods/{id}/restore", "POST /methods/{id}/rollback",
  "POST /notes/{id}/confirm", "POST /notes/{id}/reject",
  "DELETE /subject",
]);

/** The fields each request body may carry, by operation. A contract test holds
 *  the OpenAPI description's request schemas to exactly these lists. */
export const AGENT_MEMORY_REQUEST_FIELDS = Object.freeze({
  recall: Object.freeze(["query", "projectId", "limit", "factKinds", "since", "scope", "capsuleIds", "methods"]),
  note: Object.freeze(["factKind", "content", "projectId"]),
  episodes: Object.freeze(["projectId", "sessionId", "messages"]),
  observations: OBSERVATION_FIELDS,
});

/** @param {any} value @param {string} label @param {number} max */
function boundedString(value, label, max) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, "agent_memory_payload_invalid", `${label} must be 1–${max} characters.`);
  return text;
}

/** @param {any} body @param {readonly string[]} allowed */
function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "agent_memory_payload_invalid", "The request body must be an object.");
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new HttpError(400, "agent_memory_payload_invalid", `Unsupported field(s): ${unknown.sort().join(", ")}.`);
  }
  return body;
}

/**
 * @param {{
 *   config: any, apiKeys: any, store: any, researchMemory: any, capsules: any,
 *   memoryIntelligence: any, memorySubstrate?: any, learning?: any, feedbackEvents?: any, observations?: any,
 *   deleteSubject?: ((ownerId: string, subjectAccountId: string) => Promise<number>) | null,
 *   audit?: ((event: string, status: string, details: Record<string, unknown>) => unknown) | null,
 * }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createAgentMemoryRoutes({
  config, apiKeys, store, researchMemory, capsules, memoryIntelligence, memorySubstrate = null, learning = null,
  feedbackEvents = null, observations = null, deleteSubject = null, audit = null,
}) {
  const enabled = config.agentMemoryApiEnabled === true;
  /** @type {Map<string, {until: number, count: number}>} */
  const windows = new Map();

  return async function agentMemoryRoutes(req, res) {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== AGENT_MEMORY_PATH && !url.pathname.startsWith(`${AGENT_MEMORY_PATH}/`)) return false;
    // Off by default and named when off. This publishes an account's memory to
    // whoever holds a key; a deployment turns it on deliberately.
    if (!enabled) throw new HttpError(503, "agent_memory_disabled", "The agent memory API is not enabled in this deployment.");
    if (!apiKeys) throw new HttpError(503, "product_state_unavailable", "The agent memory API requires durable storage.");

    // Before the key check: the description is not a secret, and an integrator
    // reading it is how they find out what a key would let them do. Still
    // behind the enable switch, so a deployment that has not turned this on
    // does not advertise it either.
    if (url.pathname === `${AGENT_MEMORY_PATH}/openapi.json` && (req.method ?? "GET") === "GET") {
      sendJson(res, 200, agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: RATE_LIMIT_PER_MINUTE }));
      return true;
    }

    const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const identity = await apiKeys.resolve(token);
    const keyAccount = await store.userById(identity.userId);
    if (!keyAccount) throw new HttpError(401, "agent_key_invalid", "The API key is not valid.");

    const now = Date.now();
    for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
    if (!windows.has(identity.keyId) && windows.size >= MAX_TRACKED_KEYS) {
      throw new HttpError(503, "agent_memory_busy", "The agent memory API is busy.");
    }
    const window = windows.get(identity.keyId) ?? { until: now + 60_000, count: 0 };
    windows.set(identity.keyId, window);
    if (++window.count > RATE_LIMIT_PER_MINUTE) throw new HttpError(429, "agent_memory_rate_limited", "Too many memory operations.");

    // Whom this request is for (rule 2). Checked after the rate limit, so a
    // flood of made-up subjects is a flood of refusals, not of accounts.
    const named = req.headers["x-subject"];
    if (named !== undefined && !identity.subjects) {
      throw new HttpError(400, "agent_key_subject_unsupported", "Only an integration key may name a subject.");
    }
    const subject = named === undefined ? null : assertAgentSubject(Array.isArray(named) ? "" : named);
    /**
     * The account this request reads and writes: the subject's, or the key's
     * own. A subject is given its account the first time something is written
     * for it; a read of one that has none creates nothing and is answered as
     * an empty account (`null` here), which is what it is.
     * @param {{ create: boolean }} options
     */
    const accountFor = async ({ create }) => {
      if (!subject) return keyAccount;
      const id = create
        ? (await apiKeys.subjectAccount(keyAccount.id, subject)).userId
        : await apiKeys.findSubjectAccount(keyAccount.id, subject);
      if (!id) return null;
      const found = await store.userById(id);
      if (!found) throw new HttpError(503, "agent_subject_unavailable", "This subject's memory is unavailable.");
      return found;
    };

    /** @param {string} scope */
    const requireScope = (scope) => {
      if (!identity.scopes.includes(scope)) {
        throw new HttpError(403, "agent_key_scope_denied", `This API key does not carry the ${scope} scope.`);
      }
    };
    /** A project the key is allowed to name. A key bound to one project may
     * name that one or none; an unbound key may name any project of its own
     * account, and `requireProject` is what checks the ownership. A subject's
     * account has the one project every account starts with; the institution's
     * projects are the institution's.
     * @param {any} user @param {unknown} requested */
    const projectOf = async (user, requested) => {
      if (subject) {
        if (requested != null && String(requested) !== "default") {
          throw new HttpError(400, "agent_subject_project_unsupported", "A subject's memory has one project, \"default\"; name it or name none.");
        }
        if (requested == null) return null;
        // A subject with no memory yet has no project to make on a read.
        if (user) await store.requireProject(user, "default");
        return "default";
      }
      const wanted = requested == null ? identity.projectId : String(requested);
      if (identity.projectId && wanted !== identity.projectId) {
        throw new HttpError(403, "agent_key_project_denied", "This API key is bound to a different project.");
      }
      if (wanted == null) return null;
      await store.requireProject(user, wanted);
      return wanted;
    };

    const action = url.pathname.slice(AGENT_MEMORY_PATH.length).replace(/^\//, "");
    const method = req.method ?? "GET";
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req, Math.min(config.maxJsonBytes ?? 1_048_576, 256 * 1024)) : null;
    /** The dashboard's acts leave an audit line: which key, which account,
     *  what. Never the subject's own identifier — the account id is its digest.
     *  @param {string} event @param {any} user @param {Record<string, unknown>} [details] */
    const trail = async (event, user, details = {}) => {
      if (audit) await audit(`agent-memory.${event}`, "completed", { keyId: identity.keyId, userId: user?.id ?? null, ...details });
    };
    /** `records/<id>/<act>` and the like: the id and the act, or null. @param {string} prefix */
    const target = (prefix) => {
      const match = new RegExp(`^${prefix}/([^/]+)(?:/([a-z]+))?$`).exec(action);
      if (!match) return null;
      let id;
      try { id = decodeURIComponent(match[1]); } catch { throw new HttpError(400, "agent_memory_payload_invalid", "Invalid identifier."); }
      if (!id || id.length > 200 || [...id].some((character) => character.charCodeAt(0) < 32)) {
        throw new HttpError(400, "agent_memory_payload_invalid", "Invalid identifier.");
      }
      return { id, act: match[2] ?? "" };
    };

    if (action === "recall" && method === "POST") {
      requireScope("memory.read");
      const input = fields(body, AGENT_MEMORY_REQUEST_FIELDS.recall);
      if (!capsules) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
      if (input.factKinds !== undefined && (!Array.isArray(input.factKinds)
        || input.factKinds.length > CAPSULE_FACT_KINDS.length
        || input.factKinds.some((/** @type {any} */ kind) => !CAPSULE_FACT_KINDS.includes(kind)))) {
        throw new HttpError(400, "agent_memory_payload_invalid", "Invalid memory kinds.");
      }
      if (input.since != null && (typeof input.since !== "string" || !Number.isFinite(Date.parse(input.since)))) {
        throw new HttpError(400, "agent_memory_payload_invalid", "since must be an ISO date.");
      }
      if (input.scope !== undefined && !["all", "capsule", "conversation", "agenda"].includes(input.scope)) {
        throw new HttpError(400, "agent_memory_payload_invalid", "Invalid memory scope.");
      }
      // The capsules to read instead of the ones in force: at most eight,
      // each named once.
      if (input.capsuleIds !== undefined && (!Array.isArray(input.capsuleIds) || input.capsuleIds.length < 1
        || input.capsuleIds.length > AGENT_RECALL_MAX_CAPSULES || new Set(input.capsuleIds).size !== input.capsuleIds.length
        || input.capsuleIds.some((/** @type {any} */ id) => typeof id !== "string" || !id.trim() || id.length > 200
          || [...id].some((character) => character.charCodeAt(0) < 32)))) {
        throw new HttpError(400, "agent_memory_payload_invalid", `capsuleIds must name 1–${AGENT_RECALL_MAX_CAPSULES} distinct capsules.`);
      }
      if (input.methods !== undefined && !AGENT_RECALL_METHOD_MODES.includes(input.methods)) {
        throw new HttpError(400, "agent_memory_payload_invalid", `methods must be one of ${AGENT_RECALL_METHOD_MODES.join(", ")}.`);
      }
      const query = boundedString(input.query, "query", 2_000);
      const user = await accountFor({ create: false });
      // A subject never seen has no memory and no methods of its own; it may
      // still read its institution's named capsules.
      const result = await recallForAgent({ capsules, memorySubstrate, learning },
        { user, institution: subject ? keyAccount : null }, {
          query,
          projectId: await projectOf(user, input.projectId),
          limit: input.limit ?? 10,
          factKinds: input.factKinds ?? [],
          since: input.since ?? null,
          scope: input.scope ?? "all",
          ...(input.capsuleIds ? { capsuleIds: input.capsuleIds } : {}),
          methods: input.methods ?? "all",
        });
      sendJson(res, 200, { data: result });
      return true;
    }

    if (action === "note" && method === "POST") {
      requireScope("memory.write");
      const input = fields(body, AGENT_MEMORY_REQUEST_FIELDS.note);
      if (!capsules) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
      const content = boundedString(input.content, "content", 8_000);
      const user = /** @type {any} */ (await accountFor({ create: true }));
      const entry = await capsules.note(user.id, (await projectOf(user, input.projectId)) ?? (subject ? await projectOf(user, "default") : null), {
        factKind: input.factKind,
        content,
        // Not a parameter. See rule 1 in the module header.
        origin: "inferred",
        // Neither is this: a third party's note waits for the account owner,
        // where the platform's own notes take effect (capsuleService.note).
        review: true,
      });
      sendJson(res, 200, { data: { entry, reviewRequired: true, contextOnly: true } });
      return true;
    }

    if (action === "records" && method === "GET") {
      requireScope("memory.read");
      const allowedScopes = new Set(["user", "project", "session", "organization"]);
      const allowedKinds = new Set(["profile", "preference", "behavior", "project_fact", "analysis", "decision", "correction", "follow_up", "run_summary"]);
      const allowedStatuses = new Set(["active", "pending", "superseded", "archived"]);
      const filters = (/** @type {string} */ name, /** @type {Set<string>} */ allowed) => url.searchParams.getAll(name)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter((value) => allowed.has(value));
      const user = await accountFor({ create: false });
      const scopeId = (await projectOf(user, url.searchParams.get("scopeId"))) ?? "";
      const records = !user ? [] : await researchMemory.listRecords(user.id, {
        scopes: filters("scope", allowedScopes),
        kinds: filters("kind", allowedKinds),
        // Active only unless asked otherwise: a pending record is a proposal
        // nobody has agreed to, and an external agent reading it as fact is the
        // failure the pending state exists to prevent.
        statuses: filters("status", allowedStatuses).length ? filters("status", allowedStatuses) : ["active"],
        scopeId,
        query: url.searchParams.get("query") ?? "",
        pageSize: Math.max(1, Math.min(200, Number(url.searchParams.get("pageSize") ?? 50))),
      });
      sendJson(res, 200, { data: records });
      return true;
    }

    if (action === "episodes" && method === "POST") {
      requireScope("memory.write");
      const input = fields(body, AGENT_MEMORY_REQUEST_FIELDS.episodes);
      if (!memoryIntelligence) throw new HttpError(503, "product_state_unavailable", "Memory extraction is unavailable.");
      if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 200) {
        throw new HttpError(400, "agent_memory_payload_invalid", "messages must be a list of 1–200 turns.");
      }
      const sessionId = boundedString(input.sessionId ?? `external-${identity.keyId}`, "sessionId", 120);
      const messages = input.messages.map((/** @type {any} */ message, /** @type {number} */ index) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new HttpError(400, "agent_memory_payload_invalid", `Turn ${index} is not an object.`);
        }
        if (!["user", "assistant"].includes(message.role)) {
          throw new HttpError(400, "agent_memory_payload_invalid", `Turn ${index} must have role user or assistant.`);
        }
        return {
          id: `${sessionId}:${index}`,
          role: message.role,
          // The extractor reads DSH's part shape, and an external caller has no
          // reason to know it; the one thing it must not lose is which words
          // were the user's, because the sender is what origin is decided from.
          parts: [{ type: "text", text: boundedString(message.text, `messages[${index}].text`, 12_000) }],
          sender: message.role === "user" ? "user" : "assistant",
        };
      });
      const user = /** @type {any} */ (await accountFor({ create: true }));
      // A subject's episode belongs to its one project whether or not it is named.
      const projectId = (await projectOf(user, input.projectId)) ?? (subject ? await projectOf(user, "default") : null);
      if (!projectId) throw new HttpError(400, "agent_memory_payload_invalid", "An episode belongs to a project; name one.");
      const project = await store.requireProject(user, projectId);
      const run = {
        id: `ext_${identity.keyId}_${Date.now().toString(36)}`,
        sessionId,
        status: "completed",
        finishedAt: new Date().toISOString(),
      };
      // Held for the owner (rule 1): every record this writes is `pending`,
      // and nothing it says changes or replaces a memory already in force.
      const outcome = await memoryIntelligence.recordRun({ ...project, userId: user.id }, run, messages, { holdForOwner: true });
      sendJson(res, 202, {
        data: {
          episodeId: run.id,
          proposed: outcome.proposed,
          extracted: outcome.extracted,
          // Zero on this path by construction: nothing an external agent sends
          // activates a memory on its own. Reported rather than omitted so a
          // caller can see that it is zero rather than assume it.
          activated: outcome.activated,
          pending: outcome.pending,
          rejected: outcome.rejected,
        },
      });
      return true;
    }

    // The dashboard (agentMemoryBoard.mjs): one read, and the person's acts.
    if (action === "dashboard" && method === "GET") {
      requireScope("memory.read");
      if (!researchMemory?.configured) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
      const user = await accountFor({ create: false });
      sendJson(res, 200, { data: await memoryBoard({ researchMemory, learning, capsules, observations }, user) });
      return true;
    }

    // One prescription edit, counted into habits (agentMemoryObservations.mjs).
    if (action === "observations" && method === "POST") {
      requireScope("memory.observe");
      if (!observations) throw new HttpError(503, "product_state_unavailable", "Observations are unavailable.");
      const observation = readObservation(body);
      const user = /** @type {any} */ (await accountFor({ create: true }));
      // The wording pass is metered to the account's one project.
      await store.requireProject(user, "default");
      const outcome = await observations.observe(user, observation);
      if (outcome.habits.length) await trail("observation.habits", user, { changes: outcome.habits.map((/** @type {any} */ habit) => `${habit.change}:${habit.id}`).join(",") });
      sendJson(res, 202, { data: outcome });
      return true;
    }

    if (action === "settings" && method === "PUT") {
      requireScope("memory.manage");
      const input = fields(body, ["learningPaused", "recallPaused"]);
      const user = /** @type {any} */ (await accountFor({ create: true }));
      const settings = await researchMemory.updateSettings(user.id, input);
      await trail("settings.update", user, { learningPaused: settings.learningPaused, recallPaused: settings.recallPaused });
      sendJson(res, 200, { data: { learningPaused: settings.learningPaused, recallPaused: settings.recallPaused } });
      return true;
    }

    const record = target("records");
    if (record && ((method === "POST" && ["confirm", "forget", "restore", "undo"].includes(record.act)) || (method === "PATCH" && !record.act))) {
      requireScope("memory.manage");
      const user = await accountFor({ create: false });
      if (!user) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const act = record.act || "edit";
      const outcome = await recordAction({ researchMemory, feedbackEvents }, user, record.id, act, body);
      await trail(outcome.event, user, { target: record.id });
      sendJson(res, 200, { data: outcome.record });
      return true;
    }

    const habit = target("methods");
    if (habit && method === "GET" && !habit.act) {
      requireScope("memory.read");
      const user = await accountFor({ create: false });
      if (!user) throw new HttpError(404, "method_not_found", "The method is unavailable.");
      sendJson(res, 200, { data: await methodDetail({ learning }, user, habit.id) });
      return true;
    }
    if (habit && method === "POST" && ["retire", "restore", "rollback"].includes(habit.act)) {
      requireScope("memory.manage");
      const user = await accountFor({ create: false });
      if (!user) throw new HttpError(404, "method_not_found", "The method is unavailable.");
      const changed = await methodAction({ learning }, user, habit.id, habit.act, body);
      await trail(`method.${habit.act}`, user, { target: habit.id });
      sendJson(res, 200, { data: { id: changed.id, revision: changed.revision, status: changed.payload?.status ?? null } });
      return true;
    }

    const note = target("notes");
    if (note && method === "POST" && ["confirm", "reject"].includes(note.act)) {
      requireScope("memory.manage");
      const user = await accountFor({ create: false });
      if (!user) throw new HttpError(404, "note_not_found", "No such proposed note.");
      const changed = await noteAction({ capsules }, user, note.id, note.act, body);
      await trail(`note.${note.act}`, user, { target: note.id });
      sendJson(res, 200, { data: { id: changed.id, revision: changed.revision, status: changed.payload?.status ?? null } });
      return true;
    }

    // Forget one person entirely: their account and everything in it, the way
    // an account is deleted. Only for a subject, and only by its institution.
    if (action === "subject" && method === "DELETE") {
      requireScope("memory.manage");
      if (!subject) throw new HttpError(400, "agent_subject_required", "Name the subject to forget in X-Subject.");
      if (!deleteSubject) throw new HttpError(503, "product_state_unavailable", "Subject deletion is unavailable.");
      const user = await accountFor({ create: false });
      const deleted = user ? await deleteSubject(keyAccount.id, user.id) : 0;
      await trail("subject.delete", user, { deleted });
      sendJson(res, 200, { data: { deleted: deleted > 0 } });
      return true;
    }

    if (action === "" && method === "GET") {
      // What this key can do, from the key. An integrator's first call.
      sendJson(res, 200, { data: {
        version: 1,
        scopes: identity.scopes,
        projectId: identity.projectId,
        // An integration key, and whether this request named a subject.
        subjects: identity.subjects === true,
        speaksFor: subject ? "subject" : "account",
        rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
        endpoints: AGENT_MEMORY_ENDPOINTS,
        notes: [
          "Every episode-derived record stays pending, and every note an unconfirmed candidate, until the account owner confirms it; an episode never changes a memory already in force.",
          "A key bound to a project cannot read or write outside it.",
          "An integration key may name the person a request is for in X-Subject; every read and write is then that person's alone.",
        ],
      } });
      return true;
    }

    throw new HttpError(404, "not_found", "No such agent-memory operation.");
  };
}
