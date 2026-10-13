import { OPENVIKING_MEMORY_TYPES, nativeMemoryRoot, openVikingUserId, userRootUri } from "./openVikingLayout.mjs";
import { HttpError } from "./security.mjs";

/**
 * The engine's native memory, as the calls the control plane makes of it: sessions and their commits, the memory
 * files a commit writes, an account's registration and settings, and the MCP endpoint the memory plugin proxies.
 *
 * Hidden knowledge — each of these was measured against v0.5.0 (`lab/memory/RESULTS.md` of the 2026-10-12 course
 * correction; recorded bodies under `packages/contracts/openviking/fixtures/memory/`), and each is a place where the
 * obvious call is wrong:
 *
 *  - **Listing is `fs/tree`, never `fs/ls?recursive`** — the recursive listing stops three levels down and says
 *    nothing about what it left out. `fs/tree` takes an explicit `level_limit` and pages with `has_more`.
 *  - **A count is counted here.** `GET /stats/memories` answers the whole account's total to any user of it; this
 *    module has no call for it on purpose.
 *  - **A type is the first path segment**, not the `memory_type=` tag: a pack restore loses every tag and a reindex
 *    cannot put that one back. The project template writes into `projects/`, which is the one segment that is not
 *    its type's name (`MEMORY_TYPE_OF_SEGMENT`).
 *  - **`content/write mode=create` makes a file the engine does not own**: no type, no tags, and a later extraction
 *    reads it and never updates it. A new memory goes in as a session with one message and a commit (`remember`).
 *  - **A settings PATCH replaces the type allowlist it does not restate**: `{ self: { enabled: false } }` alone
 *    opens that user to every built-in type, `events` among them. `setLearning` always sends the eight.
 *  - **Admin routes do not know a user the data routes have served** until the server's five-minute refresh or an
 *    explicit registration; settings and deletion answer 404 for it meanwhile. `register` is idempotent (409).
 *  - **Deleting a user is a task nobody can poll** (it belongs to `_system`): the signal that it finished is that a
 *    request as that user stops answering 412.
 *  - **A failed commit is never retried** and its archive is not reachable through the session routes again; the
 *    messages stay readable as a file (`history/archive_NNN/messages.jsonl`) beside a `.failed.json`.
 *
 * Every call names the acting account by the platform's own user id; `OpenVikingClient.request` hashes it, writes
 * the three identity headers and owns the deadline and the error names (`OPENVIKING_REQUEST_ERROR_CODES`).
 *
 * @module openVikingSessions
 */

/** The first path segment under `memories/` of each native type's files. */
export const MEMORY_SEGMENT_OF_TYPE = Object.freeze({
  profile: "profile.md",
  preferences: "preferences",
  entities: "entities",
  corrections: "corrections",
  project_context: "projects",
  decisions: "decisions",
  follow_ups: "follow_ups",
  project_facts: "project_facts",
});

/** The reverse: which type a file under `memories/` is, by its first path segment. */
export const MEMORY_TYPE_OF_SEGMENT = Object.freeze(Object.fromEntries(
  Object.entries(MEMORY_SEGMENT_OF_TYPE).map(([type, segment]) => [segment, type])));

/** The types whose files belong to one piece of work, and carry the `project=<id>` tag of the conversation that wrote them. */
export const PROJECT_MEMORY_TYPES = Object.freeze(["project_context", "decisions", "follow_ups", "project_facts"]);

/** The subtree of `memories/` that is not native memory: the derived recall index of PostgreSQL's records and the
 *  capsule facts (`userMemoryRoot`). Native recall and the memory page never read it. */
export const DERIVED_INDEX_SEGMENT = "evimed";

/** The scaffolding the engine writes into every directory; a hit on one names no memory. */
const SCAFFOLD_FILE = /(?:^|\/)\.(?:overview|abstract)\.md$/;

/**
 * What one `viking://` URI is, for the account whose root is given: a native memory file with its type, or not one.
 * @param {string} uri @param {string} root `nativeMemoryRoot(userId)`
 * @returns {{ type: string, relPath: string } | null}
 */
export function nativeMemoryFile(uri, root) {
  const text = String(uri ?? "");
  if (!text.startsWith(`${root}/`)) return null;
  const relPath = text.slice(root.length + 1);
  if (!relPath.endsWith(".md") || SCAFFOLD_FILE.test(relPath) || relPath.split("/").some((segment) => segment.startsWith("."))) return null;
  const segment = relPath.split("/")[0];
  if (segment === DERIVED_INDEX_SEGMENT) return null;
  const type = MEMORY_TYPE_OF_SEGMENT[segment];
  if (!type) return null;
  // The profile is one file at the root; every other type is a directory of files.
  if (type === "profile" ? relPath !== "profile.md" : !relPath.includes("/")) return null;
  return { type, relPath };
}

/** The archive a URI names, or null: `…/sessions/<session>/history/archive_NNN[/…]`. @param {string} uri */
export function parseArchiveUri(uri) {
  const match = /^(viking:\/\/user\/[^/]+)\/sessions\/([A-Za-z0-9_.@-]{1,200})\/history\/(archive_[0-9]{1,9})(?:\/(.*))?$/.exec(String(uri ?? ""));
  return match ? { userRoot: match[1], session: match[2], archive: match[3], rest: match[4] ?? "", archiveUri: `${match[1]}/sessions/${match[2]}/history/${match[3]}` } : null;
}

/** The engine session of one platform conversation, as the unmodified plugin derives it (`deriveDshSessionId`): a
 *  kernel session id is `session_<hex>` and passes through unchanged behind the prefix. */
export const PLUGIN_SESSION_PREFIX = "dsh-";

/** @param {string} engineSessionId @returns {string | null} the platform conversation, or null for a session the plugin did not derive */
export function platformSessionOf(engineSessionId) {
  const text = String(engineSessionId ?? "");
  if (!text.startsWith(PLUGIN_SESSION_PREFIX)) return null;
  const id = text.slice(PLUGIN_SESSION_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
}

const SESSION_ID = /^[A-Za-z0-9_.@-]{1,200}$/;

/** @param {unknown} value */
function sessionSegment(value) {
  const text = String(value ?? "");
  if (!SESSION_ID.test(text)) throw new HttpError(400, "memory_session_invalid", "The memory session id is invalid.");
  return text;
}

/** The full policy a settings PATCH carries, whatever it is changing. @param {boolean} learning */
export function memoryPolicy(learning) {
  return { self: { enabled: Boolean(learning) }, memory_types: [...OPENVIKING_MEMORY_TYPES] };
}

export class OpenVikingSessions {
  /**
   * @param {any} client an `OpenVikingClient`
   * @param {{ timeoutMs?: number, fastTimeoutMs?: number }} [options] `fastTimeoutMs` is the deadline of the calls a
   *   new kernel waits on (health, the MCP handshake, session start): a memory service that hangs delays the first
   *   prompt of a conversation by eighteen seconds, one that refuses costs nothing.
   */
  constructor(client, { timeoutMs = 4_000, fastTimeoutMs = 1_500 } = {}) {
    this.client = client;
    this.timeoutMs = Math.max(250, Number(timeoutMs) || 4_000);
    this.fastTimeoutMs = Math.max(250, Math.min(this.timeoutMs, Number(fastTimeoutMs) || 1_500));
  }

  get configured() { return Boolean(this.client?.configured); }
  /** @param {string} userId */
  engineUser(userId) { return openVikingUserId(userId); }
  /** @param {string} userId */
  memoryRoot(userId) { return nativeMemoryRoot(userId); }
  /** @param {string} userId */
  userRoot(userId) { return userRootUri(userId); }
  /** @param {string} userId @param {string} sessionId the engine's */
  sessionUri(userId, sessionId) { return `${userRootUri(userId)}/sessions/${sessionSegment(sessionId)}`; }

  /** Liveness and version, with no identity (a request that names a user registers it). */
  async health() {
    const body = await this.client.request({ path: "/health", authenticated: false, timeoutMs: this.fastTimeoutMs });
    return { status: String(body?.status ?? "error"), healthy: body?.healthy === true, version: typeof body?.version === "string" ? body.version : "" };
  }

  // ---------------------------------------------------------------- sessions

  /** Create (or find) a session. An existing one answers 409 upstream and is success here. @returns {Promise<any>} the envelope */
  async createSession(userId, sessionId, { timeoutMs = this.fastTimeoutMs } = {}) {
    try {
      return await this.client.request({ method: "POST", path: "/api/v1/sessions", userId, body: { session_id: sessionSegment(sessionId) }, timeoutMs });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "memory_index_conflict") throw error;
      return { status: "ok", result: { session_id: sessionId, uri: this.sessionUri(userId, sessionId), existing: true }, error: null };
    }
  }

  /** @returns {Promise<any>} the envelope */
  readSession(userId, sessionId, { timeoutMs = this.timeoutMs } = {}) {
    return this.client.request({ path: `/api/v1/sessions/${sessionSegment(sessionId)}`, userId, timeoutMs });
  }

  /** One message, as the plugin shapes it (`content`, or `parts`). @returns {Promise<any>} the envelope */
  addMessage(userId, sessionId, message, { timeoutMs = this.timeoutMs } = {}) {
    return this.client.request({ method: "POST", path: `/api/v1/sessions/${sessionSegment(sessionId)}/messages`, userId, body: message, timeoutMs });
  }

  /**
   * Archive what is pending and start its extraction. Answers at once: `{ status: "accepted", task_id, archive_uri }`,
   * or `{ status: "skipped", reason: "no_messages" }`.
   * @returns {Promise<any>} the envelope
   */
  commit(userId, sessionId, { keepRecentCount = 0, timeoutMs = this.timeoutMs } = {}) {
    return this.client.request({
      method: "POST", path: `/api/v1/sessions/${sessionSegment(sessionId)}/commit`, userId,
      body: { keep_recent_count: Math.max(0, Math.trunc(Number(keepRecentCount)) || 0) }, timeoutMs,
    });
  }

  /** @returns {Promise<boolean>} false when it was already gone */
  async deleteSession(userId, sessionId) {
    try {
      await this.client.request({ method: "DELETE", path: `/api/v1/sessions/${sessionSegment(sessionId)}`, userId, timeoutMs: this.timeoutMs });
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return false;
      throw error;
    }
  }

  /** A commit's task: `{ status: "running" | "completed" | "failed", result, error }`, or null when the engine no longer keeps it. */
  async task(userId, taskId) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(taskId ?? ""))) return null;
    try {
      const body = await this.client.request({ path: `/api/v1/tasks/${taskId}`, userId, timeoutMs: this.timeoutMs });
      return body?.result ?? null;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  // ------------------------------------------------------------------- files

  /**
   * Every node under a directory, files and directories, paged to the end. A directory that does not exist is an
   * empty one: the engine makes an account's tree at its first session, not at its first read.
   * @param {string} userId @param {string} uri
   * @param {{ levelLimit?: number, tags?: string[], showHidden?: boolean, maxNodes?: number }} [options]
   * @returns {Promise<{ uri: string, relPath: string, isDir: boolean, size: number, modTime: string | null, tags: string[] }[]>}
   */
  async tree(userId, uri, { levelLimit = 8, tags = [], showHidden = false, maxNodes = 20_000 } = {}) {
    const nodes = [];
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
      let body;
      try {
        body = await this.client.request({
          path: "/api/v1/fs/tree", userId, timeoutMs: this.timeoutMs * 2,
          query: {
            uri, level_limit: levelLimit, node_limit: pageSize, limit: pageSize, offset, include_tags: "true",
            ...(tags.length ? { tags } : {}), ...(showHidden ? { show_all_hidden: "true" } : {}),
          },
        });
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "memory_index_not_found") return nodes;
        throw error;
      }
      const page = Array.isArray(body?.result) ? body.result : [];
      for (const node of page) {
        nodes.push({
          uri: String(node?.uri ?? ""), relPath: String(node?.rel_path ?? ""), isDir: node?.isDir === true,
          size: Number(node?.size) || 0, modTime: typeof node?.modTime === "string" ? node.modTime : null,
          tags: Array.isArray(node?.tags) ? node.tags.map(String) : [],
        });
      }
      if (body?.has_more !== true || page.length === 0) return nodes;
      if (nodes.length >= maxNodes) throw new HttpError(502, "memory_index_listing_too_large", `A memory directory exceeded ${maxNodes} entries.`);
    }
  }

  /** A file's text (a memory's body without its `MEMORY_FIELDS` trailer), or null when there is none. */
  async read(userId, uri, { raw = false, timeoutMs = this.timeoutMs } = {}) {
    try {
      const body = await this.client.request({ path: "/api/v1/content/read", userId, query: { uri, ...(raw ? { raw: "true" } : {}) }, timeoutMs });
      return typeof body?.result === "string" ? body.result : null;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** A memory file's tags and fields: `{ tags, memory: { memory_type, version, source_extraction_id, … } }`, or null. */
  async attrs(userId, uri) {
    try {
      const body = await this.client.request({ path: "/api/v1/fs/attrs", userId, query: { uri }, timeoutMs: this.timeoutMs });
      const attrs = body?.result?.attrs ?? {};
      return { tags: Array.isArray(attrs.tags) ? attrs.tags.map(String) : [], memory: attrs.memory && typeof attrs.memory === "object" ? attrs.memory : {} };
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** Replace a file's own tags (the engine's `memory_type=` tag is not one of them and stays). */
  setTags(userId, uri, tags) {
    return this.client.request({ method: "POST", path: "/api/v1/fs/attrs/set_tags", userId, body: { uri, tags: [...tags] }, timeoutMs: this.timeoutMs });
  }

  /**
   * Replace an existing memory file's body. `wait` re-embeds before answering, so the edit is searchable when this
   * returns (about a second). The engine has no compare-and-swap: the caller holds the hash it last saw.
   */
  replace(userId, uri, content, { wait = true } = {}) {
    return this.client.request({
      method: "POST", path: "/api/v1/content/write", userId, timeoutMs: Math.max(this.timeoutMs, 20_000),
      body: { uri, content: String(content ?? ""), mode: "replace", wait: Boolean(wait) },
    });
  }

  /** Delete a file or a subtree. @returns {Promise<boolean>} false when nothing was there */
  remove(userId, uri, { recursive = false } = {}) {
    return this.client.remove(userId, uri, { recursive });
  }

  // ------------------------------------------------------------------ recall

  /** The plugin's recall (`mode: "context"`) or the list form, body as given. @returns {Promise<any>} the envelope */
  search(userId, body, { timeoutMs = this.timeoutMs } = {}) {
    return this.client.request({ method: "POST", path: "/api/v1/search/search", userId, body, timeoutMs });
  }

  /**
   * Ranked memory files under a target, each with its whole body as `abstract`.
   * @param {string} userId @param {string} query @param {{ target?: string, limit?: number, tags?: string[] }} [options]
   * @returns {Promise<{ uri: string, score: number, text: string, tags: string[] }[]>}
   */
  async find(userId, query, { target, limit = 10, tags = [] } = {}) {
    const body = await this.client.request({
      method: "POST", path: "/api/v1/search/find", userId, timeoutMs: this.timeoutMs * 2,
      body: { query: String(query ?? "").slice(0, 2_000), limit: Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 10)), ...(target ? { target_uri: target } : {}), ...(tags.length ? { tags } : {}) },
    });
    const hits = Array.isArray(body?.result?.memories) ? body.result.memories : [];
    return hits.map((/** @type {any} */ hit) => ({
      uri: String(hit?.uri ?? ""), score: Number(hit?.score) || 0, text: String(hit?.abstract ?? ""), tags: Array.isArray(hit?.tags) ? hit.tags.map(String) : [],
    }));
  }

  // --------------------------------------------------------------------- MCP

  /**
   * One buffered exchange with the engine's MCP endpoint. The answer is a whole event stream, not a live one, and the
   * server keeps no MCP session (it sends no `Mcp-Session-Id`), so nothing but the JSON-RPC body crosses.
   * @returns {Promise<{ status: number, contentType: string, text: string }>}
   */
  mcp(userId, body, { timeoutMs = this.timeoutMs } = {}) {
    return this.client.request({ method: "POST", path: "/mcp", userId, body, responseType: "text", timeoutMs });
  }

  // ----------------------------------------------------------------- account

  /** Make the account known to the admin routes. @returns {Promise<boolean>} true when this call registered it */
  async register(userId) {
    try {
      await this.client.request({
        method: "POST", path: `/api/v1/admin/accounts/${this.client.account}/users`, userId,
        body: { user_id: openVikingUserId(userId), role: "user" }, timeoutMs: this.timeoutMs,
      });
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_conflict") return false;
      throw error;
    }
  }

  /** The account's own policy as the engine holds it, or null before it is registered. */
  async settings(userId) {
    try {
      const body = await this.client.request({ path: `/api/v1/admin/accounts/${this.client.account}/users/${openVikingUserId(userId)}/settings`, userId, timeoutMs: this.timeoutMs });
      const policy = body?.result?.memory_policy ?? {};
      return { learning: policy?.self?.enabled !== false, memoryTypes: Array.isArray(policy?.memory_types) ? policy.memory_types.map(String).sort() : [] };
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** Pause or resume the engine's own extraction for one account, restating the type allowlist every time. */
  async setLearning(userId, learning) {
    await this.register(userId);
    const body = await this.client.request({
      method: "PATCH", path: `/api/v1/admin/accounts/${this.client.account}/users/${openVikingUserId(userId)}/settings`, userId,
      body: { memory_policy: memoryPolicy(learning) }, timeoutMs: this.timeoutMs,
    });
    const policy = body?.result?.memory_policy ?? {};
    return { learning: policy?.self?.enabled !== false, memoryTypes: Array.isArray(policy?.memory_types) ? policy.memory_types.map(String).sort() : [] };
  }

  /**
   * Erase everything the engine holds of one account: sessions, memories, vectors, its usage rows.
   *
   * Registered first, because an account the admin routes have not heard of cannot be deleted (404) while its files
   * stay. The deletion is a task this caller cannot poll, so "done" is read off the account's own next request: 412
   * while it is being deleted, anything else after. The id can be used again afterwards and starts empty.
   * @returns {Promise<{ deleted: boolean, pending: boolean }>} `pending`: still answering 412 when the wait ran out
   */
  async eraseUser(userId, { waitMs = 15_000, pollMs = 250, sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    await this.register(userId).catch((error) => {
      // An account already being deleted cannot be registered again; the wait below reads how that ends.
      if (/** @type {any} */ (error)?.code !== "memory_index_precondition_failed") throw error;
    });
    try {
      await this.client.request({ method: "DELETE", path: `/api/v1/admin/accounts/${this.client.account}/users/${openVikingUserId(userId)}`, userId, timeoutMs: this.timeoutMs });
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === "memory_index_not_found") return { deleted: false, pending: false };
      if (code !== "memory_index_precondition_failed") throw error;
    }
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
      try {
        await this.client.request({ path: "/api/v1/fs/ls", userId, query: { uri: nativeMemoryRoot(userId) }, timeoutMs: this.timeoutMs });
        return { deleted: true, pending: false };
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "memory_index_precondition_failed") return { deleted: true, pending: false };
      }
      if (Date.now() >= deadline) return { deleted: true, pending: true };
      await sleep(pollMs);
    }
  }

  /** The account's memories as the engine's own pack (a ZIP: the files, a manifest with a hash per file). */
  async exportPack(userId) {
    const answer = await this.client.request({
      method: "POST", path: "/api/v1/pack/export", userId, responseType: "bytes", timeoutMs: Math.max(this.timeoutMs, 30_000),
      body: { uri: nativeMemoryRoot(userId), include_vectors: false },
    });
    return /** @type {Buffer} */ (answer.bytes);
  }
}
