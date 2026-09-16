import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { AGENT_KEY_SCOPES } from "./agentApiKeys.mjs";

/**
 * The agent-memory API, described.
 *
 * Built rather than written: `CAPSULE_FACT_KINDS` and `AGENT_KEY_SCOPES` are
 * the same values the handlers validate against, so a kind added to the domain
 * cannot be missing here and a scope removed cannot still be documented. A
 * hand-maintained copy of a closed vocabulary is a copy that is wrong the first
 * time the vocabulary moves, and an integrator has no way to tell.
 *
 * @module agentMemoryOpenApi
 */

const ERROR = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
};

/** @param {string} description */
function errorResponse(description) {
  return { description, content: { "application/json": { schema: ERROR } } };
}

/** @param {any} schema @param {string} description */
function jsonBody(schema, description = "") {
  return { required: true, content: { "application/json": { schema } }, ...(description ? { description } : {}) };
}

/**
 * @param {{ basePath: string, rateLimitPerMinute: number }} options
 * @returns {Record<string, any>}
 */
export function agentMemoryOpenApi({ basePath, rateLimitPerMinute }) {
  const common = {
    401: errorResponse("The API key is missing, revoked, expired or unknown. One code for all four: the difference is an enumeration oracle and tells a legitimate holder nothing their own key list does not."),
    403: errorResponse("The key does not carry the required scope, or is bound to a different project."),
    429: errorResponse(`More than ${rateLimitPerMinute} operations in one minute for this key.`),
    503: errorResponse("The API is not enabled in this deployment, or memory storage is unavailable."),
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "EviMed agent memory",
      version: "1.0.0",
      description: [
        "Read and propose research memory on behalf of one account, for an agent that is not EviMed's own.",
        "",
        "Two rules hold everywhere in this API and are worth reading before the endpoints:",
        "",
        "1. Nothing you write becomes an active memory. A note, and every record derived from an episode, arrives as `inferred` and stays `pending` until it is independently re-observed across separate episodes or the account owner confirms it in their inbox. There is no parameter that changes this; a caller's assertion that its user said something outright is not that user saying it.",
        "2. A key's scope is a property of the key. A key bound to a project cannot read or write outside it, and no request field widens that.",
        "",
        "Memory is context, never permission: nothing recalled here loosens a contract, relaxes a safety rule, or reaches a host the platform's gateways would not.",
      ].join("\n"),
    },
    servers: [{ url: basePath }],
    components: {
      securitySchemes: {
        agentApiKey: {
          type: "http",
          scheme: "bearer",
          description: `An account API key, minted at POST /api/agent-keys. Scopes: ${AGENT_KEY_SCOPES.join(", ")}.`,
        },
      },
      schemas: {
        FactKind: { type: "string", enum: [...CAPSULE_FACT_KINDS] },
        RecallRequest: {
          type: "object",
          required: ["query"],
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 2000 },
            projectId: { type: ["string", "null"], description: "Omit when the key is bound to a project." },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            factKinds: { type: "array", items: { $ref: "#/components/schemas/FactKind" } },
            since: { type: "string", format: "date-time" },
            scope: {
              type: "string", enum: ["all", "capsule", "conversation", "agenda"], default: "all",
              description: "`conversation`: the structured records and notes the platform keeps for this account; `capsule`: the facts of its active capsules; `all`: both. `agenda` is reserved and currently refused.",
            },
          },
        },
        NoteRequest: {
          type: "object",
          required: ["factKind", "content"],
          additionalProperties: false,
          properties: {
            factKind: { $ref: "#/components/schemas/FactKind" },
            content: { type: "string", minLength: 1, maxLength: 8000 },
            projectId: { type: ["string", "null"] },
          },
        },
        NoteResponse: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                entry: { type: "object", additionalProperties: true },
                reviewRequired: { type: "boolean", const: true, description: "Always true. See rule 1." },
                contextOnly: { type: "boolean", const: true },
              },
            },
          },
        },
        EpisodeRequest: {
          type: "object",
          required: ["messages"],
          additionalProperties: false,
          properties: {
            projectId: { type: ["string", "null"] },
            sessionId: { type: "string", maxLength: 120 },
            messages: {
              type: "array", minItems: 1, maxItems: 200,
              items: {
                type: "object",
                required: ["role", "text"],
                additionalProperties: false,
                properties: {
                  role: { type: "string", enum: ["user", "assistant"], description: "Which turns were the user's decides what may be recorded as explicit, so getting this wrong is not cosmetic." },
                  text: { type: "string", minLength: 1, maxLength: 12000 },
                },
              },
            },
          },
        },
      },
    },
    security: [{ agentApiKey: [] }],
    paths: {
      "/": {
        get: {
          summary: "What this key can do",
          responses: { 200: { description: "Scopes, project binding, rate limit and the standing rules." }, ...common },
        },
      },
      "/recall": {
        post: {
          summary: "Search this account's memory",
          description: "Searches both forms of this account's memory — the structured records the platform keeps (profile, preferences, behaviours, corrections, notes) and the facts of its active capsules — and returns each item with `source` (`memory` or `capsule`) and its provenance. Memory records come first, then capsule facts; `limit` bounds the union. A record whose origin is `inferred` is the platform's own guess and has not been confirmed by anyone.",
          security: [{ agentApiKey: ["memory.read"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/RecallRequest" }),
          responses: { 200: { description: "Matching memory, hydrated from the record store." }, 400: errorResponse("Malformed request."), ...common },
        },
      },
      "/note": {
        post: {
          summary: "Propose one fact",
          description: "Accepted as a proposal, never as a memory. See rule 1.",
          security: [{ agentApiKey: ["memory.write"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/NoteRequest" }),
          responses: {
            200: { description: "Recorded as pending.", content: { "application/json": { schema: { $ref: "#/components/schemas/NoteResponse" } } } },
            400: errorResponse("Malformed request."),
            ...common,
          },
        },
      },
      "/records": {
        get: {
          summary: "List structured memory records",
          description: "Active records only unless `status` asks otherwise. A pending record is a proposal nobody has agreed to; reading one as fact is the failure the pending state exists to prevent.",
          security: [{ agentApiKey: ["memory.read"] }],
          parameters: [
            { name: "scope", in: "query", schema: { type: "string" } },
            { name: "kind", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" }, description: "Defaults to active." },
            { name: "scopeId", in: "query", schema: { type: "string" }, description: "A project id the key is allowed to name." },
            { name: "query", in: "query", schema: { type: "string" } },
            { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: { 200: { description: "Records, newest first." }, ...common },
        },
      },
      "/episodes": {
        post: {
          summary: "Submit a conversation for extraction",
          description: [
            "The transcript endpoint. The platform's own extractor reads the turns and decides what is worth remembering, subject to the same evidence rules a run of ours is subject to: every candidate must quote its source byte for byte, and everything it produces is pending.",
            "This is the only way to add memory in bulk. There is no endpoint that writes a record directly, because a record with no evidence behind it is what the record shape exists to make impossible.",
          ].join(" "),
          security: [{ agentApiKey: ["memory.write"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/EpisodeRequest" }),
          responses: {
            202: { description: "Extraction ran. `activated` is zero on this path by construction." },
            400: errorResponse("Malformed request."),
            ...common,
          },
        },
      },
    },
  };
}
