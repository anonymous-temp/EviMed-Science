import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { recallAcrossMemory } from "./memoryRecall.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";
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
 *  1. **A note arrives as `inferred` and stays pending.** The parameter that
 *     would say otherwise does not exist. A model's claim that its user said
 *     something outright is not the user saying it, and an external agent's
 *     claim is one more step removed. Promotion happens the way it always does:
 *     repeated independent observation, or the person confirming it in their
 *     own inbox.
 *  2. **Scope comes from the key.** A key bound to a project cannot read or
 *     write outside it, and no request field can widen that.
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

/** @param {any} value @param {string} label @param {number} max */
function boundedString(value, label, max) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, "agent_memory_payload_invalid", `${label} must be 1–${max} characters.`);
  return text;
}

/** @param {any} body @param {string[]} allowed */
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
 *   memoryIntelligence: any, memorySubstrate?: any, audit?: ((event: any) => void) | null,
 * }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createAgentMemoryRoutes({ config, apiKeys, store, researchMemory, capsules, memoryIntelligence, memorySubstrate = null }) {
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
    const user = await store.userById(identity.userId);
    if (!user) throw new HttpError(401, "agent_key_invalid", "The API key is not valid.");

    const now = Date.now();
    for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
    if (!windows.has(identity.keyId) && windows.size >= MAX_TRACKED_KEYS) {
      throw new HttpError(503, "agent_memory_busy", "The agent memory API is busy.");
    }
    const window = windows.get(identity.keyId) ?? { until: now + 60_000, count: 0 };
    windows.set(identity.keyId, window);
    if (++window.count > RATE_LIMIT_PER_MINUTE) throw new HttpError(429, "agent_memory_rate_limited", "Too many memory operations.");

    /** @param {string} scope */
    const requireScope = (scope) => {
      if (!identity.scopes.includes(scope)) {
        throw new HttpError(403, "agent_key_scope_denied", `This API key does not carry the ${scope} scope.`);
      }
    };
    /** A project the key is allowed to name. A key bound to one project may
     * name that one or none; an unbound key may name any project of its own
     * account, and `requireProject` is what checks the ownership. */
    const projectOf = async (requested) => {
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
    const body = method === "POST" ? await readJson(req, Math.min(config.maxJsonBytes ?? 1_048_576, 256 * 1024)) : null;

    if (action === "recall" && method === "POST") {
      requireScope("memory.read");
      const input = fields(body, ["query", "projectId", "limit", "factKinds", "since", "scope"]);
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
      const result = await recallAcrossMemory({ capsules, memorySubstrate }, user, {
        query: boundedString(input.query, "query", 2_000),
        projectId: await projectOf(input.projectId),
        limit: Math.max(1, Math.min(50, Number(input.limit ?? 10))),
        factKinds: input.factKinds ?? [],
        since: input.since ?? null,
        scope: input.scope ?? "all",
      });
      sendJson(res, 200, { data: result });
      return true;
    }

    if (action === "note" && method === "POST") {
      requireScope("memory.write");
      const input = fields(body, ["factKind", "content", "projectId"]);
      if (!capsules) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
      const entry = await capsules.note(user.id, await projectOf(input.projectId), {
        factKind: input.factKind,
        content: boundedString(input.content, "content", 8_000),
        // Not a parameter. See rule 1 in the module header.
        origin: "inferred",
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
      const records = await researchMemory.listRecords(user.id, {
        scopes: filters("scope", allowedScopes),
        kinds: filters("kind", allowedKinds),
        // Active only unless asked otherwise: a pending record is a proposal
        // nobody has agreed to, and an external agent reading it as fact is the
        // failure the pending state exists to prevent.
        statuses: filters("status", allowedStatuses).length ? filters("status", allowedStatuses) : ["active"],
        scopeId: (await projectOf(url.searchParams.get("scopeId"))) ?? "",
        query: url.searchParams.get("query") ?? "",
        pageSize: Math.max(1, Math.min(200, Number(url.searchParams.get("pageSize") ?? 50))),
      });
      sendJson(res, 200, { data: records });
      return true;
    }

    if (action === "episodes" && method === "POST") {
      requireScope("memory.write");
      const input = fields(body, ["projectId", "sessionId", "messages"]);
      if (!memoryIntelligence) throw new HttpError(503, "product_state_unavailable", "Memory extraction is unavailable.");
      const projectId = await projectOf(input.projectId);
      if (!projectId) throw new HttpError(400, "agent_memory_payload_invalid", "An episode belongs to a project; name one.");
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
      const project = await store.requireProject(user, projectId);
      const run = {
        id: `ext_${identity.keyId}_${Date.now().toString(36)}`,
        sessionId,
        status: "completed",
        finishedAt: new Date().toISOString(),
      };
      const outcome = await memoryIntelligence.recordRun({ ...project, userId: user.id }, run, messages);
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

    if (action === "" && method === "GET") {
      // What this key can do, from the key. An integrator's first call.
      sendJson(res, 200, { data: {
        version: 1,
        scopes: identity.scopes,
        projectId: identity.projectId,
        rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
        endpoints: ["POST /recall", "POST /note", "GET /records", "POST /episodes"],
        notes: [
          "Every note and every episode-derived record arrives as inferred and stays pending until it is independently re-observed or the account owner confirms it.",
          "A key bound to a project cannot read or write outside it.",
        ],
      } });
      return true;
    }

    throw new HttpError(404, "not_found", "No such agent-memory operation.");
  };
}
