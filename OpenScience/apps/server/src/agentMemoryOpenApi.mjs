import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { AGENT_KEY_SCOPES, AGENT_SUBJECT_PATTERN } from "./agentApiKeys.mjs";
import { AGENT_RECALL_MAX_CAPSULES, AGENT_RECALL_METHOD_MODES } from "./agentMemoryRecall.mjs";
import { MAX_MOUNTED_CAPSULE_METHODS, MAX_MOUNTED_CAPSULE_METHOD_BYTES } from "./capsuleMethods.mjs";
import { BOARD_NEW_DAYS, BOARD_RECENT_DAYS, BOARD_SOURCES } from "./agentMemoryBoard.mjs";
import { HABIT_MIN_OCCURRENCES, HABIT_MIN_SHARE, HABIT_WINDOW, NEVER_LEARNED_HERBS, OBSERVATION_CHANGE_TYPES } from "./agentMemoryObservations.mjs";

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
  /** @param {string} description */
  const pathId = (description) => ({ name: "id", in: "path", required: true, schema: { type: "string", maxLength: 200 }, description });
  const recordId = pathId("A record id from the dashboard.");
  const methodId = pathId("A method id from the dashboard, URL-encoded (it holds colons).");
  const noteId = pathId("A note id from the dashboard's `pending`.");
  const document = {
    openapi: "3.1.0",
    info: {
      title: "EviMed agent memory",
      version: "1.0.0",
      description: [
        "Read and propose research memory on behalf of one account, for an agent that is not EviMed's own.",
        "",
        "Two rules hold everywhere in this API and are worth reading before the endpoints:",
        "",
        "1. Nothing you write becomes an active memory. Every record extracted from an episode stays `pending`, and a note stays an unconfirmed candidate, until the account owner confirms it — on their memory page, or through the dashboard operations with a key carrying `memory.manage`, which a key holds only when its requests come from that person's own clicks. An episode may add evidence to a memory that is already in force; it never changes, replaces or re-activates one. There is no parameter that changes this; a caller's assertion that its user said something outright is not that user saying it.",
        "2. A key's scope is a property of the key. A key bound to a project cannot read or write outside it, and no request field widens that. An integration key (minted with `subjects: true`) may name the person a request is for in the `X-Subject` header — a doctor behind a hospital's HIS — and every read and write is then that person's own memory and nobody else's; without the header it is the key's own account, the institution. A subject is given its memory the first time something is written for it; reading one that has none answers as an empty memory.",
        "",
        "Memory is context, never permission: nothing recalled here loosens a contract, relaxes a safety rule, or reaches a host the platform's gateways would not.",
      ].join("\n"),
    },
    servers: [{ url: basePath }],
    components: {
      parameters: {
        Subject: {
          name: "X-Subject", in: "header", required: false,
          description: "Integration keys only: the opaque identifier of the person this request is for (1–128 letters, digits and . _ : @ / + = -). Absent, the request is the key's own account. Named by any other key, the request is refused with `agent_key_subject_unsupported`. A subject's memory has one project, `default`.",
          schema: { type: "string", pattern: AGENT_SUBJECT_PATTERN.source },
        },
      },
      securitySchemes: {
        agentApiKey: {
          type: "http",
          scheme: "bearer",
          description: `An account API key, minted at POST /api/agent-keys (\`subjects: true\` makes it an integration key). Scopes: ${AGENT_KEY_SCOPES.join(", ")}.`,
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
              description: "`conversation`: the structured records and notes the platform keeps for this account; `capsule`: the facts of its active capsules (or of `capsuleIds`); `all`: both. `agenda` is reserved and currently refused.",
            },
            capsuleIds: {
              type: "array", minItems: 1, maxItems: AGENT_RECALL_MAX_CAPSULES, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 },
              description: "Read these capsules instead of the ones in force — one school at a time, for a side-by-side comparison. Each must be this account's own, or, for a request naming a subject, its institution's. One that is neither is `404 capsule_not_found`, the same answer as one that does not exist.",
            },
            methods: {
              type: "string", enum: [...AGENT_RECALL_METHOD_MODES], default: "all",
              description: "Which methods (做法) to return: `own` — this account's own learned methods; `capsules` — the work-style methods of the capsules read; `all` — both, the account's own first; `none`.",
            },
          },
        },
        Method: {
          type: "object",
          description: "One method, as context: how this person or school works, never a permission or a rule.",
          properties: {
            source: { type: "string", enum: ["learned", "capsule"] },
            id: { type: "string" },
            capsuleId: { type: "string", description: "`capsule` methods only." },
            title: { type: ["string", "null"], description: "The line a person reads: the method's own Chinese title, or the capsule's title." },
            summary: { type: ["string", "null"] },
            whenToUse: { type: ["string", "null"] },
            content: { type: "string", description: "The method's text." },
            digest: { type: "string", description: "`sha256:<hex>` of the text that was handed over." },
            since: { type: ["string", "null"], description: "When a learned method took effect; fourteen days or less is 「新」." },
            contextOnly: { type: "boolean", const: true },
          },
        },
        RecallResponse: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                items: { type: "array", items: { type: "object", additionalProperties: true } },
                sources: { type: "object", properties: { memory: { type: "integer" }, capsule: { type: "integer" } } },
                mode: { type: "string" },
                contextOnly: { type: "boolean", const: true },
                methods: {
                  type: "array", items: { $ref: "#/components/schemas/Method" },
                  description: `At most ${MAX_MOUNTED_CAPSULE_METHODS} methods and ${MAX_MOUNTED_CAPSULE_METHOD_BYTES} bytes of method text, the account's own first — the order a run of ours mounts them in.`,
                },
                capsules: {
                  type: "array", description: "When `capsuleIds` was given: each named capsule, its title and whose it is (`self` or `institution`).",
                  items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, owner: { type: "string", enum: ["self", "institution"] } } },
                },
              },
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
        ObservationRequest: {
          type: "object", required: ["syndrome", "changes"], additionalProperties: false,
          description: "One prescription edit: the candidate formula and the one the doctor sent, as the difference between them. Names only — no dose and no patient field has anywhere to go.",
          properties: {
            observationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "The integrator's id for this edit; the same id posted twice is one edit." },
            syndrome: { type: "string", minLength: 1, maxLength: 64, description: "The syndrome (证候) the formula was for. No digits." },
            lineage: { type: "string", minLength: 1, maxLength: 64, description: "The lineage (诊疗思路) chosen, when one was." },
            stage: { type: "string", enum: ["M04"], default: "M04" },
            changes: {
              type: "array", minItems: 1, maxItems: 30,
              items: {
                oneOf: [
                  { type: "object", required: ["type", "from", "to"], additionalProperties: false,
                    properties: { type: { const: "replace" }, from: { $ref: "#/components/schemas/Herb" }, to: { $ref: "#/components/schemas/Herb" } } },
                  ...OBSERVATION_CHANGE_TYPES.filter((type) => type !== "replace").map((type) => ({
                    type: "object", required: ["type", "herb"], additionalProperties: false,
                    properties: { type: { const: type }, herb: { $ref: "#/components/schemas/Herb" } },
                  })),
                ],
              },
            },
          },
        },
        Herb: { type: "string", pattern: "^[\\p{Script=Han}A-Za-z·（）()]{1,24}$", description: "A herb's name: letters, no digits — a dose is never observed." },
        ExpectedVersion: {
          type: "object", required: ["expectedVersion"], additionalProperties: false,
          properties: { expectedVersion: { type: "integer", minimum: 1, description: "The record's `version` as read; a stale one is `409 memory_conflict`." } },
        },
        RecordEdit: {
          type: "object", required: ["expectedVersion"], additionalProperties: false,
          properties: {
            expectedVersion: { type: "integer", minimum: 1 },
            summary: { type: "string", minLength: 1, maxLength: 2000 },
            value: { type: "string", minLength: 1, maxLength: 100000 },
          },
        },
        ExpectedRevision: {
          type: "object", required: ["expectedRevision"], additionalProperties: false,
          properties: { expectedRevision: { type: "integer", minimum: 1, description: "The method's or note's `revision` as read." } },
        },
        MethodRollback: {
          type: "object", required: ["expectedRevision", "targetRevision"], additionalProperties: false,
          properties: {
            expectedRevision: { type: "integer", minimum: 1 },
            targetRevision: { type: "integer", minimum: 1, description: "A revision from `GET /methods/{id}`." },
          },
        },
        Settings: {
          type: "object", additionalProperties: false,
          properties: {
            learningPaused: { type: "boolean", description: "Nothing new is learned: no episode, observation or run writes a memory." },
            recallPaused: { type: "boolean", description: "Nothing is recalled into an answer." },
          },
        },
        Source: {
          type: "string", enum: Object.keys(BOARD_SOURCES),
          description: `Where a memory came from: ${Object.entries(BOARD_SOURCES).map(([code, label]) => `\`${code}\` ${label}`).join("；")}.`,
        },
        BoardRecord: {
          type: "object",
          properties: {
            id: { type: "string" }, kind: { type: "string" }, scope: { type: "string" },
            summary: { type: "string" }, value: { type: "string" },
            status: { type: "string", enum: ["active", "pending", "archived"] },
            version: { type: "integer" },
            source: { $ref: "#/components/schemas/Source" }, sourceLabel: { type: "string" },
            basis: { type: "object", description: "How it is known, counted from its own evidence (依据次数): observations, separate runs, separate conversations.",
              properties: { kind: { type: ["string", "null"] }, observations: { type: "integer" }, runs: { type: "integer" }, conversations: { type: "integer" } } },
            usage: { type: "object", description: "How often it was handed to an answer, and when last (使用情况).",
              properties: { count: { type: "integer" }, lastUsedAt: { type: ["string", "null"] } } },
            quotes: { type: "array", items: { type: "object", additionalProperties: true }, description: "The last three pieces of evidence, word for word." },
            history: { type: "array", items: { type: "object", additionalProperties: true }, description: "The last five revisions, newest first, each with who changed it." },
            wasTrue: { type: "array", items: { type: "object", additionalProperties: true }, description: "「曾经如此」: earlier values and replaced records, each with when it held (`from`, `until`)." },
          },
        },
        BoardHabit: {
          type: "object",
          properties: {
            id: { type: "string" }, title: { type: "string" }, summary: { type: "string" },
            status: { type: "string", enum: ["approved", "retired"] }, statusReason: { type: ["string", "null"] },
            since: { type: ["string", "null"] }, isNew: { type: "boolean", description: `Effective for ${BOARD_NEW_DAYS} days or less (「新」).` },
            source: { $ref: "#/components/schemas/Source" }, sourceLabel: { type: "string" },
            basis: { type: ["object", "null"], additionalProperties: true, description: "For a habit learned from prescription edits: what it was counted from." },
            usage: { type: "object", additionalProperties: true }, revision: { type: "integer" },
          },
        },
        BoardChange: {
          type: "object",
          description: "One line of 「最近变化」, with the act that takes it back: POST `undo.path` with `undo.expectedVersion` or `undo.expectedRevision`.",
          properties: {
            type: { type: "string", enum: ["record", "habit"] }, change: { type: "string" }, summary: { type: "string" }, at: { type: "string" },
            undo: { type: "object", properties: { action: { type: "string", enum: ["undo", "retire", "restore"] }, path: { type: "string" },
              expectedVersion: { type: "integer" }, expectedRevision: { type: "integer" } } },
          },
        },
        Dashboard: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                switches: { $ref: "#/components/schemas/Settings" },
                records: { type: "array", items: { $ref: "#/components/schemas/BoardRecord" }, description: "What is in force." },
                pending: { type: "array", items: { type: "object", additionalProperties: true },
                  description: "What waits for the person: records held for them (`type: record`, confirm with POST /records/{id}/confirm) and notes an outside agent proposed (`type: note`, POST /notes/{id}/confirm or /reject)." },
                forgotten: { type: "array", items: { $ref: "#/components/schemas/BoardRecord" }, description: "Forgotten, restorable." },
                habits: { type: "array", items: { $ref: "#/components/schemas/BoardHabit" } },
                recentChanges: { type: "array", items: { $ref: "#/components/schemas/BoardChange" }, description: `What changed by itself in the last ${BOARD_RECENT_DAYS} days, newest first.` },
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
          description: "Searches both forms of this account's memory — the structured records the platform keeps (profile, preferences, behaviours, corrections, notes) and the facts of its active capsules, or of the capsules named in `capsuleIds` — and returns each item with `source` (`memory` or `capsule`) and its provenance. Memory records come first, then capsule facts; `limit` bounds the union. A record whose origin is `inferred` is the platform's own guess and has not been confirmed by anyone. A fact read out of a knowledge-base document is returned only to a recall in that document's project. It also returns `methods`: how this account works (its learned methods) and how the capsules read work (their work-style entries), the account's own first. Reading a method counts nothing.",
          security: [{ agentApiKey: ["memory.read"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/RecallRequest" }),
          responses: {
            200: { description: "Matching memory, hydrated from the record store, and the methods that apply.", content: { "application/json": { schema: { $ref: "#/components/schemas/RecallResponse" } } } },
            400: errorResponse("Malformed request."),
            404: errorResponse("A capsule named in `capsuleIds` is unavailable (`capsule_not_found`)."),
            ...common,
          },
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
            "The transcript endpoint. The platform's own extractor reads the turns and decides what is worth remembering, subject to the same evidence rules a run of ours is subject to: every candidate must quote its source byte for byte, and everything it produces is `pending` until the account owner confirms it. A candidate that would change or replace a memory already in force is refused and counted in `rejected`.",
            "This is the only way to add memory in bulk. There is no endpoint that writes a record directly, because a record with no evidence behind it is what the record shape exists to make impossible.",
          ].join(" "),
          security: [{ agentApiKey: ["memory.write"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/EpisodeRequest" }),
          responses: {
            202: { description: "Extraction ran. Every record it wrote is `pending`, so `activated` is zero on this path by construction; `pending` counts them and `rejected` counts what the extractor or the hold refused." },
            400: errorResponse("Malformed request."),
            ...common,
          },
        },
      },
      "/observations": {
        post: {
          summary: "Observe one prescription edit",
          description: [
            `The learning signal: what the doctor changed in a candidate formula. It is counted in code across the doctor's most recent ${HABIT_WINDOW} edits under the same syndrome; a change seen at least ${HABIT_MIN_OCCURRENCES} times and in at least ${Math.round(HABIT_MIN_SHARE * 100)}% of them becomes a habit — worded once through the platform's model gateway, written to the method ledger, in effect at once and returned by recall — and a habit whose share falls below half that over enough later edits is retired. The counts are recomputed when the dashboard reads them, never typed into prose.`,
            `A change naming a toxic herb (${NEVER_LEARNED_HERBS.join("、")}) is recorded for the dashboard's 「不学习」 line and never learned from. A doctor who paused learning is not observed.`,
          ].join(" "),
          security: [{ agentApiKey: ["memory.observe"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ObservationRequest" }),
          responses: {
            202: { description: "`recorded`, or why not (`paused`, `duplicate`); `neverLearned`; and `habits` — each learned, retired, or failed to be written (the observation stands either way)." },
            400: errorResponse("Malformed request, a dose, or a patient field (`agent_observation_invalid`)."),
            ...common,
          },
        },
      },
      "/dashboard": {
        get: {
          summary: "The memory dashboard",
          description: "Everything a person's own memory page shows, in one read: the switches, what is in force with where each came from (`source`), how established it is (`basis`) and how often it was used (`usage`), 「曾经如此」 (`wasTrue`), what waits for them, what they forgot, their habits, and 「最近变化」 with the act that takes each back. Derived when read from the record store and the method ledger; nothing here is stored twice. A subject with no memory yet reads an empty dashboard.",
          security: [{ agentApiKey: ["memory.read"] }],
          responses: { 200: { description: "The dashboard.", content: { "application/json": { schema: { $ref: "#/components/schemas/Dashboard" } } } }, ...common },
        },
      },
      "/settings": {
        put: {
          summary: "Turn learning or recall on or off",
          description: "The dashboard's switches (功能开关). Pausing deletes nothing.",
          security: [{ agentApiKey: ["memory.manage"] }],
          requestBody: jsonBody({ $ref: "#/components/schemas/Settings" }),
          responses: { 200: { description: "The switches as they now are." }, ...common },
        },
      },
      "/records/{id}": {
        patch: {
          summary: "Edit a memory",
          description: "The person's own edit: the memory becomes theirs (`source: self`), and a proposal they edit is in force.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [recordId],
          requestBody: jsonBody({ $ref: "#/components/schemas/RecordEdit" }),
          responses: { 200: { description: "The record as edited." }, 404: errorResponse("No such memory."), 409: errorResponse("It changed since it was read."), ...common },
        },
      },
      "/records/{id}/confirm": {
        post: {
          summary: "Confirm a proposal",
          description: "A record waiting for its owner (`pending`) is put in force as the person's own statement.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [recordId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedVersion" }),
          responses: { 200: { description: "The record, in force." }, 404: errorResponse("No such memory."), 409: errorResponse("Not pending, or changed since it was read."), ...common },
        },
      },
      "/records/{id}/forget": {
        post: {
          summary: "Forget a memory",
          description: "Out of every answer from now on, kept restorable, and remembered as rejected so the next extraction does not write it back.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [recordId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedVersion" }),
          responses: { 200: { description: "The record, forgotten." }, 404: errorResponse("No such memory."), 409: errorResponse("Already forgotten, or changed since it was read."), ...common },
        },
      },
      "/records/{id}/restore": {
        post: {
          summary: "Restore a forgotten memory",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [recordId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedVersion" }),
          responses: { 200: { description: "The record, in force again." }, 404: errorResponse("No such memory."), 409: errorResponse("Not forgotten, or changed since it was read."), ...common },
        },
      },
      "/records/{id}/undo": {
        post: {
          summary: "Undo the last change to a memory",
          description: "The previous state saved forward, or — for a memory whose only change was its writing — its removal, remembered as rejected. The act 「最近变化」 offers on a record line.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [recordId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedVersion" }),
          responses: { 200: { description: "The record as it now is, or null when the undo removed it." }, 404: errorResponse("No such memory."), 409: errorResponse("It changed since it was read."), ...common },
        },
      },
      "/methods/{id}": {
        get: {
          summary: "One habit and its versions",
          description: "The method's text and each revision whose text, line or status differs from the one before — a counter update is not a version. An earlier text is marked `wasTrue` (「曾经如此」).",
          security: [{ agentApiKey: ["memory.read"] }],
          parameters: [methodId],
          responses: { 200: { description: "The method and its versions, newest first." }, 404: errorResponse("No such method."), ...common },
        },
      },
      "/methods/{id}/retire": {
        post: {
          summary: "Stop a habit (停用)",
          description: "It leaves every later recall and run; restorable.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [methodId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedRevision" }),
          responses: { 200: { description: "The method, retired." }, 404: errorResponse("No such method."), 409: errorResponse("It changed since it was read."), ...common },
        },
      },
      "/methods/{id}/restore": {
        post: {
          summary: "Take a stop back",
          description: "The latest revision in which the method was in force, saved forward.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [methodId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedRevision" }),
          responses: { 200: { description: "The method, in force again." }, 404: errorResponse("No such method."), 409: errorResponse("Not retired, never in force, or changed since it was read."), ...common },
        },
      },
      "/methods/{id}/rollback": {
        post: {
          summary: "Go back to an earlier version (回到上一版)",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [methodId],
          requestBody: jsonBody({ $ref: "#/components/schemas/MethodRollback" }),
          responses: { 200: { description: "The method at that version, saved forward." }, 404: errorResponse("No such method or revision."), 409: errorResponse("It changed since it was read."), ...common },
        },
      },
      "/notes/{id}/confirm": {
        post: {
          summary: "Confirm a proposed note",
          description: "A note an outside agent proposed (`POST /note`) is put in force.",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [noteId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedRevision" }),
          responses: { 200: { description: "The note, in force." }, 404: errorResponse("No such proposed note."), 409: errorResponse("It changed since it was read."), ...common },
        },
      },
      "/notes/{id}/reject": {
        post: {
          summary: "Reject a proposed note",
          security: [{ agentApiKey: ["memory.manage"] }],
          parameters: [noteId],
          requestBody: jsonBody({ $ref: "#/components/schemas/ExpectedRevision" }),
          responses: { 200: { description: "The note, retired." }, 404: errorResponse("No such proposed note."), 409: errorResponse("It changed since it was read."), ...common },
        },
      },
      "/subject": {
        delete: {
          summary: "Forget one person entirely",
          description: "An integration key only, naming the person in X-Subject: their account and everything in it is deleted the way an account is — the recall index first, then the records. `deleted` is false when there was nothing to delete.",
          security: [{ agentApiKey: ["memory.manage"] }],
          responses: { 200: { description: "Whether anything was deleted." }, ...common },
        },
      },
    },
  };
  // Every operation takes the subject header and can be refused for it.
  for (const operations of Object.values(document.paths)) {
    for (const operation of Object.values(/** @type {Record<string, any>} */ (operations))) {
      operation.parameters = [{ $ref: "#/components/parameters/Subject" }, ...(operation.parameters ?? [])];
      operation.responses[400] ??= errorResponse("Malformed request.");
      operation.responses[400] = errorResponse(`${operation.responses[400].description} Also: an X-Subject that is not an identifier (\`agent_subject_invalid\`), named by a key that is not an integration key (\`agent_key_subject_unsupported\`), or a subject request naming a project other than \`default\` (\`agent_subject_project_unsupported\`).`);
    }
  }
  return document;
}
