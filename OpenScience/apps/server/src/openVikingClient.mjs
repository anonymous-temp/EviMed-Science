import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { openVikingPeerId, openVikingScopedId, openVikingUserId } from "./openVikingLayout.mjs";
import { HttpError } from "./security.mjs";

/**
 * The OpenViking context engine, reached over HTTP by the control plane and by
 * nobody else.
 *
 * Two kinds of thing live in it since v0.5.0 (2026-10-13). The first is what it
 * has held since 2026-09-11: derived copies of the records PostgreSQL owns —
 * research memory and capsule facts — under `memories/evimed/`, ranked by
 * `find` and rebuildable from the typed store. Its `write` offers `replace`,
 * `append` and `create` and no compare-and-swap, so the `expectedVersion` the
 * control-plane store enforces has no equivalent here, and those records stay
 * PostgreSQL's. The second is original: an account's native memory (extracted
 * by the engine from sessions), the documents pushed as resources, and the
 * pages and graphs its Compile writes from them. That part exists nowhere
 * else, which is why the data volume is backed up (`docs/WEB_OPERATIONS_RUNBOOK.md`).
 *
 * Identity is asserted, not held. The server runs in `trusted` auth mode behind
 * this control plane, which is the only caller: the account and user travel in
 * headers and the runtime container never learns the endpoint or the key. The
 * headers are written in one function of this file, `request`, and every module
 * built on the engine goes through it.
 */

export { openVikingPeerId, openVikingUserId };

/** Where a record of a given scope lives.
 *
 * The layout is the metadata carrier. OpenViking drops unknown frontmatter
 * fields and excludes frontmatter from both prompts and embedding input, so a
 * sidecar header cannot be relied on to survive a round trip. A URI can:
 * `find` returns it on every hit, and it already encodes scope, scope id, kind
 * and record id. It is also what makes "forget this project" one `rm`.
 *
 * Everything of ours lives under `memories/evimed/` rather than in the
 * built-in `preferences/` and `events/` directories, so the server's own
 * extraction — on since v0.5.0, writing `memories/<type>/…` — can never
 * overwrite a derived copy, and no memory type is named `evimed`.
 */
export function memoryUri(userId, { scope, scopeId, kind, recordId }) {
  const root = `viking://user/${openVikingUserId(userId)}/memories/evimed`;
  const leaf = `${safeSegment(kind)}/${safeSegment(recordId)}.md`;
  if (scope === "project") return `${root}/project/${openVikingPeerId(scopeId)}/${leaf}`;
  if (scope === "session") return `${root}/session/${safeSegment(scopeId)}/${leaf}`;
  return `${root}/user/${leaf}`;
}

/** The directories one recall searches: the user's own, plus this project and
 *  this session. `find` takes a list of targets, which is how "user OR project
 *  OR session" is expressed without three round trips or client-side filtering
 *  that would drop hits below the limit. */
export function recallTargets(userId, { projectId = null, sessionId = null } = {}) {
  const root = `viking://user/${openVikingUserId(userId)}/memories/evimed`;
  const targets = [`${root}/user`];
  if (projectId) targets.push(`${root}/project/${openVikingPeerId(projectId)}`);
  if (sessionId) targets.push(`${root}/session/${safeSegment(sessionId)}`);
  return targets;
}

/** Everything of one account in the index: the research memory and the capsule tree. */
export function userMemoryRoot(userId) {
  return `viking://user/${openVikingUserId(userId)}/memories/evimed`;
}

/** The three subtrees research memory occupies: the capsule tree beside them is the publication ledger's, not this one's. */
export function researchMemoryRoots(userId) {
  const root = userMemoryRoot(userId);
  return [`${root}/user`, `${root}/project`, `${root}/session`];
}

/** The subtree a project's memories occupy, for deletion. */
export function projectMemoryUri(userId, projectId) {
  return `viking://user/${openVikingUserId(userId)}/memories/evimed/project/${openVikingPeerId(projectId)}`;
}

/** The subtree one conversation's own records occupy (`scope: "session"`), for deletion: a project's conversations are not under the project's. */
export function sessionMemoryUri(userId, sessionId) {
  return `viking://user/${openVikingUserId(userId)}/memories/evimed/session/${safeSegment(sessionId)}`;
}

/** How large a directory this client will read before it refuses, and the level
 *  a leaf file carries. */
const LIST_MAX_ENTRIES = 100_000;
const LEAF_LEVEL = 2;

const segmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function safeSegment(value) {
  const text = String(value ?? "");
  if (!segmentPattern.test(text)) {
    throw new HttpError(400, "memory_id_invalid", "A memory path segment is invalid.");
  }
  return text;
}

/** Parse a hit's URI back into the record it was written from. Returns null
 *  for anything not written by us — a hit from the server's own extraction, or
 *  from a layout an older release wrote. */
export function parseMemoryUri(uri) {
  const match = String(uri ?? "").match(
    /\/memories\/evimed\/(user|project|session)(?:\/([^/]+))?\/([^/]+)\/([^/]+)\.md$/,
  );
  if (!match) return null;
  const [, scope, scopeId, kind, recordId] = match;
  if (scope === "user" && scopeId !== undefined) return null;
  if (scope !== "user" && !scopeId) return null;
  return { scope, scopeId: scope === "user" ? "" : scopeId, kind, recordId };
}

/** Every capsule subtree of one user. This is what account deletion removes. */
export function capsuleTreeUri(userId) {
  return `viking://user/${openVikingUserId(userId)}/memories/evimed/capsule`;
}

/** The single path segment one capsule occupies.
 *
 * The account generation is hashed together with the capsule id, joined by a
 * NUL separator, for the reason the MemOS namespace did the same: an account
 * deleted and recreated under the same public id is a different account, and
 * must not be able to read what the previous generation published. The
 * separator is a byte no identifier may contain, so no two (generation,
 * capsule) pairs can meet by concatenation.
 */
export function capsuleSegment(accountCreatedAt, capsuleId) {
  const generation = String(accountCreatedAt ?? "");
  const capsule = String(capsuleId ?? "");
  if (!generation || !capsule) {
    throw new HttpError(400, "memory_id_invalid", "A capsule index path needs an account generation and a capsule id.");
  }
  return openVikingScopedId("c", `${generation}\u0000${capsule}`, "capsule");
}

/** The subtree one capsule's facts occupy, for recall targeting and deletion. */
export function capsuleMemoryRoot(userId, { accountCreatedAt, capsuleId }) {
  return `${capsuleTreeUri(userId)}/${capsuleSegment(accountCreatedAt, capsuleId)}`;
}

/** Where one fact of a capsule lives.
 *
 * The fact id is base64url-encoded behind an `f` prefix because our ids are not
 * all safe path segments — a runtime note's id is `runtime-note:<sha256>` — and
 * encoding is reversible where escaping a colon would not be. The revision
 * rides in the name so that a readback is exact without reading any file: a
 * leaf either names the revision the snapshot published or it does not belong.
 */
export function capsuleFactUri(userId, { accountCreatedAt, capsuleId, factKind, factId, revision }) {
  if (!CAPSULE_FACT_KINDS.includes(String(factKind))) {
    throw new HttpError(400, "memory_id_invalid", "A capsule fact kind is not one this system records.");
  }
  const encoded = Buffer.from(String(factId ?? ""), "utf8").toString("base64url");
  if (!encoded || encoded.length > 128) {
    throw new HttpError(400, "memory_id_invalid", "A capsule fact id does not fit one path segment.");
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new HttpError(400, "memory_id_invalid", "A capsule fact revision must be a positive integer.");
  }
  return `${capsuleMemoryRoot(userId, { accountCreatedAt, capsuleId })}/${factKind}/f${encoded}.r${revision}.md`;
}

/** Parse a capsule leaf back into the fact it was written from, or null for a
 *  path this layout never produced. */
export function parseCapsuleFactUri(uri) {
  const match = String(uri ?? "").match(
    /\/memories\/evimed\/capsule\/(c-[0-9a-f]{24})\/([a-z_]+)\/f([A-Za-z0-9_-]+)\.r([1-9][0-9]*)\.md$/,
  );
  if (!match) return null;
  const [, segment, factKind, encoded, revision] = match;
  if (!CAPSULE_FACT_KINDS.includes(factKind)) return null;
  const factId = Buffer.from(encoded, "base64url").toString("utf8");
  // Node's base64url decoder ignores what it cannot use, so a foreign name
  // decodes into some string rather than failing. Re-encoding is what makes the
  // round trip exact, and it is the check that keeps a leaf we did not write
  // from being reported as a fact of ours.
  if (!factId || Buffer.from(factId, "utf8").toString("base64url") !== encoded) return null;
  return { capsuleSegment: segment, factKind, factId, revision: Number(revision) };
}

/** What the server said went wrong, as one line and without any request data.
 *  @param {any} parsed */
function upstreamReason(parsed) {
  const error = parsed?.error;
  const message = typeof error?.message === "string" && error.message
    ? error.message
    : typeof error === "string" && error
      ? error
      : typeof parsed?.message === "string" && parsed.message ? parsed.message : "";
  const code = typeof error?.code === "string" && error.code ? error.code : "";
  if (code && message) return `${code}: ${message}`;
  return code || message || "The memory index rejected the request.";
}

const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** `/health`, `/mcp` and everything under `/api/v1/`: a path, never a URL, a query or a traversal. */
const REQUEST_PATH = /^\/(?:health|ready|mcp|api\/v1\/[A-Za-z0-9_.~@:/-]+)$/;
/** The engine's own identifier alphabet (`openviking/core/identifiers.py`). */
const OPENVIKING_IDENTIFIER = /^[A-Za-z0-9_.@-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Every code `OpenVikingClient.request` can raise. The names keep the `memory_index_` prefix the five original
 * calls were written with — the memory substrate, the index worker and the readiness report already read them.
 *
 *  - not configured (503): `memory_index_url_missing`, `memory_index_url_invalid`, and whatever the key file's
 *    loader reported (`openviking_api_key_file_*`);
 *  - no answer (503): `memory_index_timeout`, `memory_index_unavailable` (also the engine's own 503);
 *  - refused (502, or 404 for a missing target): `memory_index_auth_failed` (401 the key, and 403 — another
 *    user's subtree reads `upstreamCode: "PERMISSION_DENIED"`), `memory_index_not_found` (404),
 *    `memory_index_conflict` (409: the file exists, an idempotency key reused with another body),
 *    `memory_index_precondition_failed` (412: the user is being deleted), `memory_index_payload_too_large`
 *    (413), `memory_index_rejected` (400 and 422: the engine refused the arguments), `memory_index_rate_limited`
 *    (429), `memory_index_upstream_error` (anything else);
 *  - unreadable (502): `memory_index_response_invalid`;
 *  - a caller's own defect (500): `memory_index_request_invalid`.
 */
export const OPENVIKING_REQUEST_ERROR_CODES = Object.freeze([
  "memory_index_url_missing", "memory_index_url_invalid",
  "memory_index_timeout", "memory_index_unavailable",
  "memory_index_auth_failed", "memory_index_not_found", "memory_index_conflict",
  "memory_index_precondition_failed", "memory_index_payload_too_large", "memory_index_rejected",
  "memory_index_rate_limited", "memory_index_upstream_error",
  "memory_index_response_invalid", "memory_index_request_invalid",
]);

/** @param {number} status the engine's own */
function requestErrorCode(status) {
  if (status === 401 || status === 403) return "memory_index_auth_failed";
  if (status === 404) return "memory_index_not_found";
  if (status === 409) return "memory_index_conflict";
  if (status === 412) return "memory_index_precondition_failed";
  if (status === 413) return "memory_index_payload_too_large";
  if (status === 400 || status === 422) return "memory_index_rejected";
  if (status === 429) return "memory_index_rate_limited";
  if (status === 503) return "memory_index_unavailable";
  if (status === 504) return "memory_index_timeout";
  return "memory_index_upstream_error";
}

export class OpenVikingClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = String(config.openVikingUrl ?? "").replace(/\/+$/, "");
    this.apiKey = config.openVikingApiKey ?? "";
    this.apiKeyError = config.openVikingApiKeyError ?? null;
    this.account = String(config.openVikingAccount ?? "evimed");
    this.timeoutMs = Number(config.openVikingRequestTimeoutMs ?? 8_000);
    this.fetchImpl = fetchImpl;
    this.urlError = this.#validateUrl();
  }

  #validateUrl() {
    if (!this.baseUrl) return null;
    try {
      const url = new URL(this.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "memory_index_url_invalid";
      return null;
    } catch {
      return "memory_index_url_invalid";
    }
  }

  get configured() {
    return Boolean(this.baseUrl && !this.apiKeyError && !this.urlError);
  }

  async status() {
    if (this.urlError) return { configured: false, connected: false, code: this.urlError };
    if (this.apiKeyError) return { configured: false, connected: false, code: this.apiKeyError };
    if (!this.baseUrl) return { configured: false, connected: false, code: "memory_index_url_missing" };
    try {
      const body = await this.request({ path: "/health", authenticated: false });
      return {
        configured: true,
        connected: String(body?.status ?? "") === "ok",
        code: String(body?.status ?? "") === "ok" ? null : "memory_index_unhealthy",
        version: typeof body?.version === "string" ? body.version : null,
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        code: error instanceof HttpError ? error.code : "memory_index_unavailable",
        version: null,
      };
    }
  }

  /** Write one file, creating parents. `wait` blocks until the semantic and
   *  vector refresh finishes, which materialization wants and a hot path does
   *  not: an unindexed file is invisible to `find`, so a caller that does not
   *  wait must accept that its write is not yet recallable. */
  async write(userId, uri, content, { tags = [], wait = false, timeoutSeconds = null } = {}) {
    this.#assertConfigured();
    return this.request({
      method: "POST",
      path: "/api/v1/content/write",
      userId,
      body: {
        uri,
        content: String(content ?? ""),
        mode: "replace",
        wait: Boolean(wait),
        ...(timeoutSeconds == null ? {} : { timeout: Number(timeoutSeconds) }),
        ...(tags.length ? { tags, tag_mode: "replace" } : {}),
      },
    });
  }

  /** Delete a file or a whole subtree. A missing target is success: this is
   *  called to make the index agree with a store that has already forgotten,
   *  and nothing there means it already does. Resolves false when there was
   *  nothing to delete: a 404 (v0.4.x), or the 200 with
   *  `estimated_deleted_count: 0` that v0.5.0 answers for a target already gone. */
  async remove(userId, uri, { recursive = false } = {}) {
    this.#assertConfigured();
    // Query parameters, not a body: `DELETE /api/v1/fs` reads `uri` and
    // `recursive` from the query string and answers 400 to a JSON body. Found
    // by deleting against a running server, which is the only way this route's
    // shape was ever going to be confirmed.
    try {
      const body = await this.request({ method: "DELETE", path: "/api/v1/fs", query: { uri, recursive: recursive ? "true" : "false" }, userId });
      return body?.result?.estimated_deleted_count !== 0;
    } catch (error) {
      if (error instanceof HttpError && error.code === "memory_index_not_found") return false;
      throw error;
    }
  }

  /** One page of a directory listing.
   *
   * `result` is a bare list — there is no envelope object, no cursor and no
   * total. Reading `result.entries` returned nothing at all against the real
   * server, which is why this is asserted against a recorded response rather
   * than assumed from the shape of the other routes.
   *
   * A `limit` is deliberately never sent: the server truncates to it silently,
   * so a caller who cannot prove the directory is smaller than its limit would
   * read a short listing as a complete one. Paging happens through `offset`
   * over the server's own 1000-entry page.
   */
  async list(userId, uri, { offset = 0 } = {}) {
    this.#assertConfigured();
    const body = await this.request({ path: "/api/v1/fs/ls", query: { uri, offset: Math.max(0, Number(offset) || 0) }, userId });
    return Array.isArray(body?.result) ? body.result : [];
  }

  /** Every entry of a directory, as one list.
   *
   * The walk advances by what the last page actually held and ends on an empty
   * page, so the server's page size is never assumed. It cannot be: the route
   * sends no cursor and no total, `node_limit` is a server-side default this
   * client cannot observe, and both directions of a wrong guess are silent
   * corruption — a smaller page than assumed ends the walk early and reports a
   * full directory as a partial one, a larger one re-reads entries already
   * held. The total bound exists so that a server which ignored `offset` would
   * fail loudly instead of paging forever.
   *
   * A 404 after the first page ends the walk with what was read rather than
   * discarding it: the directory existed when the walk began, so either it is
   * being removed underneath us or the offset ran past its end, and in both
   * cases the pages already read are a true part of it. A 404 on the first page
   * still says "no such directory" and is raised, because only the caller knows
   * whether a missing directory is an error or an empty index.
   */
  async listAll(userId, uri) {
    const entries = [];
    let offset = 0;
    for (;;) {
      /** @type {any[]} */
      let page;
      try {
        page = await this.list(userId, uri, { offset });
      } catch (error) {
        if (offset > 0 && error instanceof HttpError && error.code === "memory_index_not_found") return entries;
        throw error;
      }
      if (!page.length) return entries;
      entries.push(...page);
      if (entries.length >= LIST_MAX_ENTRIES) {
        throw new HttpError(502, "memory_index_listing_too_large", `A memory index directory exceeded ${LIST_MAX_ENTRIES} entries.`);
      }
      offset += page.length;
    }
  }

  /** Hierarchical semantic retrieval over the given subtrees.
   *
   * `read_content` inlines each hit's file, which is what makes one round trip
   * enough: without it a recall of eight memories is one search plus eight
   * reads, and the budget that decides which of them reach the prompt cannot
   * run until their lengths are known.
   *
   * Two parameters are sent on every call rather than left to the server. Its
   * `rerank.threshold` defaults to 0.1 and the retriever applies it even with
   * no reranker configured, so a weak but correct hit disappears unless a
   * threshold is stated; and without `level` the result slots can be spent on
   * directory records, which name no memory of ours. */
  async find(userId, query, {
    targets = [],
    limit = 8,
    scoreThreshold = 0,
    peerId = null,
  } = {}) {
    this.#assertConfigured();
    const body = await this.request({
      method: "POST",
      path: "/api/v1/search/find",
      userId,
      peerId,
      body: {
        query: String(query ?? "").slice(0, 2_000),
        ...(targets.length ? { target_uri: targets } : {}),
        context_type: "memory",
        node_limit: Math.max(1, Math.min(100, Number(limit) || 8)),
        score_threshold: Number(scoreThreshold) || 0,
        level: LEAF_LEVEL,
        read_content: true,
      },
    });
    const result = body?.result ?? body ?? {};
    const memories = Array.isArray(result.memories) ? result.memories : [];
    return memories.map((hit) => ({
      uri: String(hit?.uri ?? ""),
      score: Number(hit?.score) || 0,
      // A leaf hit carries the file; a directory hit carries only its summary.
      // Preferring the read content keeps a recalled memory verbatim, and the
      // abstract is the honest fallback rather than an empty string.
      content: String(hit?.content ?? hit?.overview ?? hit?.abstract ?? ""),
      level: Number(hit?.level) || 0,
    }));
  }

  #assertConfigured() {
    const code = this.urlError ?? this.apiKeyError ?? (!this.baseUrl ? "memory_index_url_missing" : null);
    if (code) throw new HttpError(503, code, "The memory index is not configured.");
  }

  /**
   * One authenticated request to the engine: the primitive the five calls above and every module built on the engine
   * (`openVikingResources.mjs`, `openVikingSessions.mjs`, the startup self-check) are written on.
   *
   * What it owns, so that no caller does:
   *  - **The credential and the identity.** `X-API-Key` on every request; `X-OpenViking-Account` and
   *    `X-OpenViking-User` whenever an acting user is named. `userId` is the platform's own id and is hashed here
   *    (`openVikingUserId`); `openVikingUser` is an id that is already the engine's (read back from a URI or a
   *    listing) and is sent as it is. Neither given, the request carries the key alone, which is what the admin
   *    routes want. `X-OpenViking-Role` is never sent: every request runs as a plain user, so a defect in a caller
   *    cannot reach another tenant's data. A caller cannot add a header; the one it may influence is
   *    `Idempotency-Key` (Compile), through `idempotencyKey`.
   *  - **The deadline.** `timeoutMs`, defaulting to the client's (`OPEN_SCIENCE_OPENVIKING_REQUEST_TIMEOUT_MS`).
   *  - **The error names.** A refusal is an `HttpError` whose `code` is one of `OPENVIKING_REQUEST_ERROR_CODES`
   *    and whose message is `<METHOD> <path> -> <status>: <the engine's own code and sentence>` — the path and the
   *    upstream status, never the key and never a query string (a query carries URIs). `upstreamStatus`,
   *    `upstreamCode` (the engine's `error.code`: `NOT_FOUND`, `PERMISSION_DENIED`, `ALREADY_EXISTS`, …) and
   *    `upstreamDetails` (its `error.details`, e.g. `{ type: "account", resource }`) ride on the error for a
   *    caller that must tell two refusals of one status apart.
   *
   * What comes back: for `responseType: "json"` (the default) the parsed body as the engine sent it — the
   * `{ status, result, … }` envelope, not its `result`, because some routes put what matters beside it (`has_more`
   * of `fs/ls`); null for an empty body. For `"text"` and `"bytes"` (`content/download`, the MCP endpoint's
   * buffered event stream) an object `{ status, contentType, text | bytes }`.
   *
   * @param {{ method?: string, path: string, query?: Record<string, unknown> | null, body?: unknown,
   *   userId?: string | null, openVikingUser?: string | null, peerId?: string | null, timeoutMs?: number | null,
   *   idempotencyKey?: string | null, responseType?: "json" | "text" | "bytes", authenticated?: boolean }} request
   * @returns {Promise<any>}
   */
  async request({
    method = "GET", path, query = null, body = undefined, userId = null, openVikingUser = null, peerId = null,
    timeoutMs = null, idempotencyKey = null, responseType = "json", authenticated = true,
  }) {
    // `/health` is asked before anything is known to be configured: `status()` reports what is missing by name.
    if (authenticated) this.#assertConfigured();
    const verb = String(method).toUpperCase();
    const route = String(path ?? "");
    if (!REQUEST_METHODS.has(verb) || !REQUEST_PATH.test(route) || !["json", "text", "bytes"].includes(responseType)) {
      throw new HttpError(500, "memory_index_request_invalid", "An OpenViking request was built with an invalid method, path or response type.");
    }
    const actingUser = openVikingUser != null ? String(openVikingUser) : userId != null && userId !== "" ? openVikingUserId(userId) : "";
    if (actingUser && !OPENVIKING_IDENTIFIER.test(actingUser)) {
      throw new HttpError(500, "memory_index_request_invalid", "An OpenViking request named an invalid acting user.");
    }
    if (idempotencyKey != null && !IDEMPOTENCY_KEY.test(String(idempotencyKey))) {
      throw new HttpError(500, "memory_index_request_invalid", "An OpenViking idempotency key must be 16 to 128 characters of [A-Za-z0-9_-].");
    }
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) search.append(name, String(item));
    }
    const relative = search.size ? `${route}?${search.toString()}` : route;
    const limit = Number(timeoutMs);
    const deadline = Number.isFinite(limit) && limit > 0 ? limit : this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deadline);
    try {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${relative}`, {
          method: verb,
          headers: {
            Accept: responseType === "json" ? "application/json" : responseType === "text" ? "application/json, text/event-stream" : "*/*",
            ...(authenticated && this.apiKey ? { "X-API-Key": this.apiKey } : {}),
            // Trusted mode: this control plane is the gateway, so it asserts who
            // the caller is. The server refuses `X-OpenViking-Role: root`, and we
            // never send a role at all — every request runs as a plain user, so a
            // defect here cannot reach another tenant's data.
            ...(authenticated && actingUser
              ? {
                  "X-OpenViking-Account": this.account,
                  "X-OpenViking-User": actingUser,
                }
              : {}),
            ...(authenticated && peerId ? { "X-OpenViking-Actor-Peer": openVikingPeerId(peerId) } : {}),
            ...(idempotencyKey == null ? {} : { "Idempotency-Key": String(idempotencyKey) }),
            ...(body === undefined || body === null ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined || body === null ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const code = /** @type {any} */ (error)?.name === "AbortError" ? "memory_index_timeout" : "memory_index_unavailable";
        throw new HttpError(503, code, "The memory index is unavailable.");
      }
      // The body is read under the same deadline: an engine that sends headers and then stalls is not answering.
      /** @type {string} */ let text = "";
      /** @type {Buffer | null} */ let bytes = null;
      try {
        if (responseType === "bytes" && response.ok) bytes = Buffer.from(await response.arrayBuffer());
        else text = await response.text();
      } catch {
        throw new HttpError(503, controller.signal.aborted ? "memory_index_timeout" : "memory_index_unavailable", "The memory index is unavailable.");
      }
      const contentType = String(response.headers?.get?.("content-type") ?? "");
      if (!response.ok) {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        const status = response.status === 404 ? 404 : 502;
        // The path and the upstream status, never the key: the same reasoning as
        // the research-memory client, where a single opaque code cost an hour of
        // probing endpoints by hand to find which of six calls had failed.
        //
        // The reason arrives as `{"status":"error","error":{code,message,details}}`.
        // Reading a top-level `message` found nothing on that wire, so every
        // upstream explanation was replaced by the generic sentence below — which
        // is the same outage as having no reason at all.
        const failure = new HttpError(status, requestErrorCode(response.status), `${verb} ${route} -> ${response.status}: ${upstreamReason(parsed)}`);
        const details = parsed?.error?.details;
        throw Object.assign(failure, {
          upstreamStatus: response.status,
          upstreamCode: typeof parsed?.error?.code === "string" ? parsed.error.code : null,
          // What the refusal was about (`{ type: "account" | "user" | "file" | "directory" | …, resource }`): the one
          // way to tell "this file is not there" from "this account is not registered yet", both 404 NOT_FOUND.
          upstreamDetails: details && typeof details === "object" && !Array.isArray(details) ? details : null,
        });
      }
      if (responseType === "bytes") return { status: response.status, contentType, bytes };
      if (responseType === "text") return { status: response.status, contentType, text };
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(502, "memory_index_response_invalid", "The memory index returned invalid JSON.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
