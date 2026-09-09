import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

/**
 * The OpenViking context database, reached as a derived semantic index.
 *
 * OpenViking stores context as a filesystem under `viking://` and retrieves it
 * hierarchically: a query first matches directory-level L0 abstracts, then
 * descends. That is what we want it for. What it deliberately is *not* used
 * for is holding the authoritative record: its `write` offers `replace`,
 * `append` and `create` and no compare-and-swap, so the `expectedVersion` the
 * research-memory service enforces server-side has no equivalent here. Two
 * concurrent edits of one record would silently keep the later writer's copy.
 * The typed store stays authoritative; everything written through this client
 * is derived and can be rebuilt from it.
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
    try {
      await this.#request("/api/v1/fs", {
        method: "DELETE",
        userId,
        body: { uri, recursive: Boolean(recursive) },
      });
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.code === "memory_index_not_found") return false;
      throw error;
    }
  }

  async list(userId, uri) {
    this.#assertConfigured();
    const body = await this.#request(`/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`, { userId });
    const entries = Array.isArray(body?.result?.entries)
      ? body.result.entries
      : Array.isArray(body?.entries)
        ? body.entries
        : [];
    return entries;
  }

  /** Hierarchical semantic retrieval over the given subtrees.
   *
   * `read_content` inlines each hit's file, which is what makes one round trip
   * enough: without it a recall of eight memories is one search plus eight
   * reads, and the budget that decides which of them reach the prompt cannot
   * run until their lengths are known. */
  async find(userId, query, {
    targets = [],
    limit = 8,
    scoreThreshold = null,
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
        ...(scoreThreshold == null ? {} : { score_threshold: Number(scoreThreshold) }),
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
            : "memory_index_upstream_error";
      const status = response.status === 404 ? 404 : 502;
      // The path and the upstream status, never the key: the same reasoning as
      // the research-memory client, where a single opaque code cost an hour of
      // probing endpoints by hand to find which of six calls had failed.
      const detail = typeof parsed?.message === "string" && parsed.message
        ? parsed.message
        : typeof parsed?.error === "string" && parsed.error
          ? parsed.error
          : "The memory index rejected the request.";
      throw new HttpError(status, code, `${method} ${relative} -> ${response.status}: ${detail}`);
    }
    return parsed;
  }
}
