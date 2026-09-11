import { createHash } from "node:crypto";
import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * The OpenViking context database, reached as a derived semantic index.
 *
 * OpenViking stores context as a filesystem under `viking://` and retrieves it
 * hierarchically: a query first matches directory-level L0 abstracts, then
 * descends. That is what we want it for. What it deliberately is *not* used
 * for is holding the authoritative record: its `write` offers `replace`,
 * `append` and `create` and no compare-and-swap, so the `expectedVersion` the
 * control-plane store enforces has no equivalent here. Two concurrent edits of
 * one record would silently keep the later writer's copy. The typed store stays
 * authoritative; everything written through this client is derived and can be
 * rebuilt from it.
 *
 * Identity is asserted, not held. The server runs in `trusted` auth mode behind
 * this control plane, which is the only caller: the account and user travel in
 * headers and the runtime container never learns the endpoint or the key.
 */

// A single path segment per identity, and no user id in a stored path. The
// service is one more place a support engineer may read a directory listing;
// the memo namespace has hashed for the same reason since it was introduced.
function scopedId(prefix, value, purpose) {
  const digest = createHash("sha256").update(`evimed/openviking/${purpose}/v1:${value}`).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

/** The account is one tenant for the whole deployment; users divide it. */
export function openVikingUserId(userId) {
  return scopedId("u", String(userId ?? ""), "user");
}

/** A peer is a content scope inside one user. Ours is the project. */
export function openVikingPeerId(projectId) {
  return scopedId("p", String(projectId ?? ""), "peer");
}

/** Where a record of a given scope lives.
 *
 * The layout is the metadata carrier. OpenViking drops unknown frontmatter
 * fields and excludes frontmatter from both prompts and embedding input, so a
 * sidecar header cannot be relied on to survive a round trip. A URI can:
 * `find` returns it on every hit, and it already encodes scope, scope id, kind
 * and record id. It is also what makes "forget this project" one `rm`.
 *
 * Everything of ours lives under `memories/evimed/` rather than in the
 * built-in `preferences/` and `events/` directories, so that turning the
 * server's own extraction back on could never overwrite a derived copy.
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

/** The subtree a project's memories occupy, for deletion. */
export function projectMemoryUri(userId, projectId) {
  return `viking://user/${openVikingUserId(userId)}/memories/evimed/project/${openVikingPeerId(projectId)}`;
}

/** The server's own default page for `ls`, and the level a leaf file carries. */
const LIST_PAGE_SIZE = 1_000;
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
  return scopedId("c", `${generation}\u0000${capsule}`, "capsule");
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
      const body = await this.#request("/health", { authenticated: false });
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
    return this.#request("/api/v1/content/write", {
      method: "POST",
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
   *  and a 404 means it already does. */
  async remove(userId, uri, { recursive = false } = {}) {
    this.#assertConfigured();
    // Query parameters, not a body: `DELETE /api/v1/fs` reads `uri` and
    // `recursive` from the query string and answers 400 to a JSON body. Found
    // by deleting against a running server, which is the only way this route's
    // shape was ever going to be confirmed.
    const query = new URLSearchParams({ uri, recursive: recursive ? "true" : "false" });
    try {
      await this.#request(`/api/v1/fs?${query.toString()}`, { method: "DELETE", userId });
      return true;
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
    const query = new URLSearchParams({ uri, offset: String(Math.max(0, Number(offset) || 0)) });
    const body = await this.#request(`/api/v1/fs/ls?${query.toString()}`, { userId });
    return Array.isArray(body?.result) ? body.result : [];
  }

  /** Every entry of a directory, as one list.
   *
   * A short page ends the walk, which is the only completion signal the route
   * offers. The page bound is the server's default `node_limit`; the total
   * bound exists so that a server which ignored `offset` would fail loudly
   * instead of paging forever.
   */
  async listAll(userId, uri) {
    const entries = [];
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const page = await this.list(userId, uri, { offset });
      entries.push(...page);
      if (page.length < LIST_PAGE_SIZE) return entries;
      if (entries.length >= LIST_MAX_ENTRIES) {
        throw new HttpError(502, "memory_index_listing_too_large", `A memory index directory exceeded ${LIST_MAX_ENTRIES} entries.`);
      }
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
    const body = await this.#request("/api/v1/search/find", {
      method: "POST",
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

  /** @param {string} relative @param {Record<string, any>} options */
  async #request(relative, { method = "GET", body, userId = null, peerId = null, authenticated = true } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${relative}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(authenticated && this.apiKey ? { "X-API-Key": this.apiKey } : {}),
          // Trusted mode: this control plane is the gateway, so it asserts who
          // the caller is. The server refuses `X-OpenViking-Role: root`, and we
          // never send a role at all — every request runs as a plain user, so a
          // defect here cannot reach another tenant's data.
          ...(authenticated && userId
            ? {
                "X-OpenViking-Account": this.account,
                "X-OpenViking-User": openVikingUserId(userId),
              }
            : {}),
          ...(authenticated && peerId ? { "X-OpenViking-Actor-Peer": openVikingPeerId(peerId) } : {}),
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const code = error?.name === "AbortError" ? "memory_index_timeout" : "memory_index_unavailable";
      throw new HttpError(503, code, "The memory index is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) throw new HttpError(502, "memory_index_response_invalid", "The memory index returned invalid JSON.");
      }
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "memory_index_auth_failed"
        : response.status === 404
          ? "memory_index_not_found"
          : response.status === 409
            ? "memory_index_conflict"
            : response.status === 503
              ? "memory_index_unavailable"
              : response.status === 504
                ? "memory_index_timeout"
                : "memory_index_upstream_error";
      const status = response.status === 404 ? 404 : 502;
      // The path and the upstream status, never the key: the same reasoning as
      // the research-memory client, where a single opaque code cost an hour of
      // probing endpoints by hand to find which of six calls had failed.
      //
      // The reason arrives as `{"status":"error","error":{code,message,details}}`.
      // Reading a top-level `message` found nothing on that wire, so every
      // upstream explanation was replaced by the generic sentence below — which
      // is the same outage as having no reason at all.
      throw new HttpError(status, code, `${method} ${relative} -> ${response.status}: ${upstreamReason(parsed)}`);
    }
    return parsed;
  }
}
