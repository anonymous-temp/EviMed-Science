import { createHash } from "node:crypto";
import {
  OPENVIKING_SKILL_NAMES, libraryResourcesUri, nativeMemoryRoot, openVikingUserId, projectGraphUri, projectResourcesRoot, projectSourcesUri, projectWikiUri,
  resourcesRoot, skillUri,
} from "./openVikingLayout.mjs";
import { HttpError } from "./security.mjs";

/**
 * A project's documents, pages and graph in OpenViking: the Resources half of the engine, and its Compile.
 *
 * Layout (`openVikingLayout.mjs`; measured on v0.5.0, lab/knowledge RESULTS 1.4):
 *
 *     viking://user/<uidHash>/resources/
 *     ├── library/<srcId>.md              the account's cross-project library
 *     ├── staging/<token>/…               a file being read by the engine's own parsers, removed when it has been
 *     └── p/<pidHash>/
 *         ├── sources/<srcId>.md          what the control plane pushed: the text it captured from each document
 *         ├── wiki/                       the `llm-wiki` target
 *         └── kg/                         the `knowledge-graph` target
 *
 * Hidden knowledge:
 *
 * - **What is under `sources/` and `library/` is derived.** It is the text PostgreSQL already holds (the capture the
 *   knowledge-base search indexes and every quotation is checked against), pushed so the engine's Compile can read
 *   it. It can be dropped and rebuilt at any time (`scripts/ops/rebuild-ov-resources.mjs`). What is under `wiki/` and
 *   `kg/` is the engine's own work; the product ledger mirrors it, and the mirror is what the product reads.
 * - **A source is pushed with `processing_mode: "vectors_only"`.** A second of work, one embedding call, no model
 *   call. The default mode writes L0/L1 summaries for the file and every directory above it — 76 model calls for eight
 *   abstracts — and a compile does not need them.
 * - **`create` only takes `.md .txt .json .yaml .yml .toml .py .js .ts`**, which is why every source is `<srcId>.md`
 *   whatever the document was. The name is also the join: a page's source link ends in it, and the reader maps it
 *   back to the document.
 * - **Every find, grep and compile names its roots.** Isolation between projects is the path prefix; a `find` with no
 *   target searches everything the user can see. Between users it is the engine's own (another user's subtree answers
 *   403), and the acting user is set by `OpenVikingClient.request` and nowhere else.
 * - **A compile is always submitted with an `Idempotency-Key` and never with `args`.** The same key and body answer
 *   the same task; a non-empty `args` fails the task at submission on v0.5.0.
 * - **`result.updated` of a finished compile lists every file of the target, changed or not.** A mirror compares
 *   content hashes; nothing here interprets that list.
 * - **A task's record expires** (24 h after it ended, 7 d after it failed) and then answers 404, the same answer as a
 *   task that never existed. `task()` returns null for both; a caller must not need the record.
 *
 * Built on `OpenVikingClient.request` — the one place the credential and the identity headers are written — except
 * the multipart upload of `temp_upload`, which that primitive (JSON bodies only) cannot carry: `#upload` below writes
 * the same three headers for that one route.
 *
 * @module openVikingResources
 */

/** What `fs/ls` and `fs/tree` hide unless asked: the L0/L1 sidecars the engine writes beside pages. */
const HIDDEN = /(?:^|\/)\.[^/]*$/;
const SOURCE_FILE = /^(src_[a-f0-9]{32})\.md$/;
const LIST_PAGE = 500;
const LIST_MAX = 20_000;
/** A page of the wiki is a few kilobytes; a pushed document may be megabytes. */
const WRITE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;
const PARSE_TIMEOUT_MS = 300_000;

/** The task states after which a compile will not change. */
export const COMPILE_TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled"]);

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A tag list as a record: `["src=…","sha=…"]` → `{ src, sha }`. Tags that are not `k=v` are left out. @param {unknown} tags */
export function resourceTags(tags) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const tag of Array.isArray(tags) ? tags : []) {
    const at = String(tag).indexOf("=");
    if (at > 0) found[String(tag).slice(0, at)] = String(tag).slice(at + 1);
  }
  return found;
}

/** The file a document is pushed as. @param {string} sourceId */
export function sourceFileName(sourceId) {
  if (!/^src_[a-f0-9]{32}$/.test(String(sourceId))) throw new HttpError(400, "source_id_invalid", "A source id is invalid.");
  return `${sourceId}.md`;
}

/**
 * The idempotency key of one compile submission: the same project, target, round and attempt always name the same
 * task, so a control plane that restarts between submitting and recording finds its task again instead of paying for
 * a second one.
 * @param {{ projectId: string, tree: string, round: number, attempt?: number }} submission
 */
export function compileIdempotencyKey({ projectId, tree, round, attempt = 0 }) {
  return `evimed-${tree}-${sha256(`${projectId}\u0000${tree}\u0000${round}\u0000${attempt}`).slice(0, 40)}`;
}

export class OpenVikingResources {
  /** @param {{ client: any }} dependencies `client`: an `OpenVikingClient` */
  constructor({ client }) {
    this.client = client;
    /** Observable counters (principle 15). */
    this.counters = { pushes: 0, removals: 0, compiles: 0, engineParses: 0, failures: 0 };
  }

  get configured() { return Boolean(this.client?.configured); }

  // -------------------------------------------------------------------------------------------------------------------
  // Layout

  /** @param {string} userId @param {string} projectId */
  roots(userId, projectId) {
    return {
      project: projectResourcesRoot(userId, projectId), sources: projectSourcesUri(userId, projectId),
      wiki: projectWikiUri(userId, projectId), kg: projectGraphUri(userId, projectId), library: libraryResourcesUri(userId),
    };
  }

  /** @param {string} userId @param {string} projectId @param {string} sourceId */
  sourceUri(userId, projectId, sourceId) { return `${projectSourcesUri(userId, projectId)}/${sourceFileName(sourceId)}`; }

  /** @param {string} userId @param {string} sourceId */
  libraryUri(userId, sourceId) { return `${libraryResourcesUri(userId)}/${sourceFileName(sourceId)}`; }

  /** The root of a compiled tree. @param {string} userId @param {string} projectId @param {"wiki" | "kg"} tree */
  treeUri(userId, projectId, tree) { return tree === "kg" ? projectGraphUri(userId, projectId) : projectWikiUri(userId, projectId); }

  /**
   * Whether an address falls inside what one project of one account may read: the project's own subtree or the
   * account's library. The check the `kb_browse` gateway and every route that takes an address from outside rests on.
   * @param {string} userId @param {string} projectId @param {unknown} uri
   */
  inScope(userId, projectId, uri) {
    const value = String(uri ?? "");
    if (!value.startsWith("viking://") || [...value].some((char) => char.charCodeAt(0) < 32) || value.split("/").some((part) => part === "." || part === "..")) return false;
    const { project, library } = this.roots(userId, projectId);
    return [project, library].some((root) => value === root || value.startsWith(`${root}/`));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Sources

  /**
   * Push one document's captured text: created, or replaced when it is already there. Tags carry the document id, the
   * digest of the captured text (what reconciliation compares) and the document type.
   * @param {string} userId @param {string} uri
   * @param {string} text @param {{ sourceId: string, sha: string, docType?: string | null, state?: string | null }} facts
   */
  async pushSource(userId, uri, text, { sourceId, sha, docType = null, state = null }) {
    const tags = [`src=${sourceId}`, `sha=${sha}`, `doctype=${docType || "other"}`, ...(state ? [`state=${state}`] : [])];
    const body = { uri, content: String(text ?? ""), wait: true, processing_mode: "vectors_only", tags, tag_mode: "replace" };
    try {
      // `replace` first. From v0.5.1 it creates a file that is not there and `create` is only its alias (no 409 on an existing
      // file), so the create-then-replace pair this used to be is one call. What v0.5.0 does with `replace` on a missing
      // resource file is in no recorded fixture (only the memory index's own paths are known to create), so a 404 is
      // answered with `create`, which v0.5.0 does take. That branch is dead from v0.5.1.1 and goes with the pin.
      const write = (/** @type {"replace" | "create"} */ mode) => this.client.request({ method: "POST", path: "/api/v1/content/write", userId, body: { ...body, mode }, timeoutMs: WRITE_TIMEOUT_MS });
      /** @type {any} */
      let written;
      try {
        written = await write("replace");
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "memory_index_not_found") throw error;
        written = await write("create");
      }
      this.counters.pushes += 1;
      return { uri, bytes: Number(written?.result?.written_bytes) || Buffer.byteLength(body.content) };
    } catch (error) { this.counters.failures += 1; throw error; }
  }

  /** Remove one pushed document; one that is not there is already removed. @param {string} userId @param {string} uri */
  async removeSource(userId, uri) {
    const removed = await this.client.remove(userId, uri);
    if (removed) this.counters.removals += 1;
    return removed;
  }

  /**
   * The documents pushed under one directory (`sources/` of a project, or the library), each with what its tags say.
   * A directory that does not exist yet holds none.
   * @param {string} userId @param {string} directory
   * @returns {Promise<Array<{ uri: string, sourceId: string, size: number, sha: string | null, docType: string | null, state: string | null, modTime: string | null }>>}
   */
  async listSources(userId, directory) {
    const found = [];
    for (const entry of await this.listAll(userId, directory, { includeTags: true })) {
      const name = String(entry.uri).split("/").pop() ?? "";
      const match = SOURCE_FILE.exec(name);
      if (entry.isDir || !match) continue;
      const tags = resourceTags(entry.tags);
      found.push({ uri: entry.uri, sourceId: match[1], size: Number(entry.size) || 0, sha: tags.sha ?? null, docType: tags.doctype ?? null, state: tags.state ?? null, modTime: entry.modTime ?? null });
    }
    return found;
  }

  /** Replace a file's tags. @param {string} userId @param {string} uri @param {string[]} tags */
  async setTags(userId, uri, tags) {
    return (await this.client.request({ method: "POST", path: "/api/v1/content/set_tags", userId, body: { uri, tags } }))?.result ?? null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reading

  /**
   * One page of a directory. `hasMore` is the engine's own word, read from beside `result`.
   * @param {string} userId @param {string} uri @param {{ limit?: number, offset?: number, includeTags?: boolean }} [options]
   * @returns {Promise<{ entries: any[], hasMore: boolean }>}
   */
  async ls(userId, uri, { limit = LIST_PAGE, offset = 0, includeTags = false } = {}) {
    const body = await this.client.request({ path: "/api/v1/fs/ls", userId, timeoutMs: READ_TIMEOUT_MS,
      query: { uri, limit: Math.max(1, Math.min(1000, limit)), ...(offset > 0 ? { offset } : {}), ...(includeTags ? { include_tags: "true" } : {}) } });
    return { entries: Array.isArray(body?.result) ? body.result : [], hasMore: body?.has_more === true };
  }

  /** Every entry of a directory; none for one that does not exist. @param {string} userId @param {string} uri @param {{ includeTags?: boolean }} [options] */
  async listAll(userId, uri, { includeTags = false } = {}) {
    /** @type {any[]} */
    const entries = [];
    for (let offset = 0; ;) {
      let page;
      try { page = await this.ls(userId, uri, { offset, includeTags }); }
      catch (error) {
        if (/** @type {any} */ (error)?.code === "memory_index_not_found") return entries;
        throw error;
      }
      entries.push(...page.entries);
      if (!page.hasMore || !page.entries.length) return entries;
      offset += page.entries.length;
      if (entries.length >= LIST_MAX) throw new HttpError(502, "memory_index_listing_too_large", `A resource directory exceeded ${LIST_MAX} entries.`);
    }
  }

  /**
   * A whole subtree, files and directories, as the engine lists it. `relPath` is the path under `uri`. An absent root
   * is an empty tree. Hidden sidecars are left out unless asked for.
   * @param {string} userId @param {string} uri @param {{ nodeLimit?: number, levelLimit?: number, showHidden?: boolean }} [options]
   * @returns {Promise<Array<{ uri: string, relPath: string, size: number, isDir: boolean, modTime: string | null, abstract: string }>>}
   */
  async tree(userId, uri, { nodeLimit = 1000, levelLimit = 6, showHidden = false } = {}) {
    let body;
    try {
      body = await this.client.request({ path: "/api/v1/fs/tree", userId, timeoutMs: READ_TIMEOUT_MS,
        query: { uri, node_limit: nodeLimit, level_limit: levelLimit, ...(showHidden ? { show_all_hidden: "true" } : {}) } });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return [];
      throw error;
    }
    return (Array.isArray(body?.result) ? body.result : [])
      .map((/** @type {any} */ entry) => ({ uri: String(entry.uri ?? ""), relPath: String(entry.rel_path ?? ""), size: Number(entry.size) || 0, isDir: entry.isDir === true,
        modTime: typeof entry.modTime === "string" ? entry.modTime : null, abstract: typeof entry.abstract === "string" ? entry.abstract : "" }))
      .filter((/** @type {{ relPath: string }} */ entry) => entry.relPath && (showHidden || !HIDDEN.test(entry.relPath)));
  }

  /** A file's text; `offset` and `limit` count lines from 0. Null for a file that is not there. @param {string} userId @param {string} uri @param {{ offset?: number, limit?: number }} [options] */
  async read(userId, uri, { offset = 0, limit = 0 } = {}) {
    try {
      const body = await this.client.request({ path: "/api/v1/content/read", userId, timeoutMs: READ_TIMEOUT_MS,
        query: { uri, ...(offset > 0 ? { offset } : {}), ...(limit > 0 ? { limit } : {}) } });
      return typeof body?.result === "string" ? body.result : "";
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** A file's stored bytes, which is what a mirror hashes. Null for a file that is not there. @param {string} userId @param {string} uri @returns {Promise<Buffer | null>} */
  async download(userId, uri) {
    try {
      return (await this.client.request({ path: "/api/v1/content/download", userId, query: { uri }, responseType: "bytes", timeoutMs: READ_TIMEOUT_MS })).bytes;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** `{ name, size, modTime, isDir, uri, isLocked, id }`, or null. There is no content hash in it. @param {string} userId @param {string} uri */
  async stat(userId, uri) {
    try { return (await this.client.request({ path: "/api/v1/fs/stat", userId, query: { uri } }))?.result ?? null; }
    catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** A file's tags as a record, or null for a file that is not there. @param {string} userId @param {string} uri */
  async attrs(userId, uri) {
    try { return resourceTags((await this.client.request({ path: "/api/v1/fs/attrs", userId, query: { uri } }))?.result?.attrs?.tags); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /**
   * Lines matching a pattern under one root: `{ line, uri, content }`. The pattern is a regular expression of the
   * engine's; `escapeGrepPattern` makes a literal of an address.
   * @param {string} userId @param {string} uri @param {string} pattern @param {{ limit?: number, caseInsensitive?: boolean }} [options]
   * @returns {Promise<{ matches: Array<{ line: number, uri: string, content: string }>, filesScanned: number }>}
   */
  async grep(userId, uri, pattern, { limit = 100, caseInsensitive = false } = {}) {
    let body;
    try {
      body = await this.client.request({ method: "POST", path: "/api/v1/search/grep", userId, timeoutMs: READ_TIMEOUT_MS,
        body: { uri, pattern: String(pattern), node_limit: Math.max(1, Math.min(500, limit)), ...(caseInsensitive ? { case_insensitive: true } : {}) } });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return { matches: [], filesScanned: 0 };
      throw error;
    }
    const result = body?.result ?? {};
    return {
      matches: (Array.isArray(result.matches) ? result.matches : []).map((/** @type {any} */ match) => ({ line: Number(match.line) || 0, uri: String(match.uri ?? ""), content: String(match.content ?? "") })),
      filesScanned: Number(result.files_scanned) || 0,
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Writing a page back

  /**
   * Write one page of a compiled tree: a person's edit, or their blocks put back after a compile. Unlike a source this
   * is written in the engine's default mode, so the page's summary and vector follow its new text. v0.5.0 has no
   * version precondition on this route — the caller makes sure no compile is writing the same target.
   * @param {string} userId @param {string} uri @param {string} content
   */
  async writePage(userId, uri, content) {
    const written = await this.client.request({ method: "POST", path: "/api/v1/content/write", userId, timeoutMs: WRITE_TIMEOUT_MS,
      body: { uri, content: String(content ?? ""), mode: "replace", wait: false } });
    return { uri, bytes: Number(written?.result?.written_bytes) || 0 };
  }

  /** Remove a whole subtree (a project's resources, a staging directory). @param {string} userId @param {string} uri */
  async removeTree(userId, uri) { return this.client.remove(userId, uri, { recursive: true }); }

  // -------------------------------------------------------------------------------------------------------------------
  // Compile

  /**
   * Submit one compile. Answers the task as the engine reports it: `{ taskId, status, stage }`.
   * @param {string} userId
   * @param {{ from: string[], to: string, skill: string, instruction?: string | null, idempotencyKey: string }} submission
   *   `skill`: one of `OPENVIKING_SKILL_NAMES`
   */
  async submitCompile(userId, { from, to, skill, instruction = null, idempotencyKey }) {
    if (!OPENVIKING_SKILL_NAMES.includes(skill)) throw new HttpError(500, "knowledge_skill_unknown", "That compile skill is not one this deployment installs.");
    if (!Array.isArray(from) || !from.length || from.length > 16) throw new HttpError(500, "knowledge_compile_invalid", "A compile reads between one and sixteen roots.");
    if (!idempotencyKey) throw new HttpError(500, "knowledge_compile_invalid", "A compile is always submitted with an idempotency key.");
    try {
      const body = await this.client.request({ method: "POST", path: "/api/v1/compile", userId, idempotencyKey, timeoutMs: READ_TIMEOUT_MS,
        body: { from, to, skill: skillUri(skill), ...(instruction ? { instruction: String(instruction) } : {}) } });
      this.counters.compiles += 1;
      return compileTask(body?.result);
    } catch (error) { this.counters.failures += 1; throw error; }
  }

  /**
   * Ask the engine to consolidate one account's memories in place (`ov compile --skill memory`, v0.5.0 `docs/en/context-compilation/06-memory-consolidation.md`):
   * deduplicate, merge, split and compact under each type's own schema, facts preserved, no external source — which is why there is no
   * `from`, and why the target is the account's own memories root. It runs inside the engine (no VikingBot) and its model calls go
   * through the model gateway as `memory-extraction`. Answers at once with the task.
   * @param {string} userId
   * @param {{ to: string, instruction?: string | null, idempotencyKey: string }} submission `to`: the account's `memories` root or one memory type's directory
   */
  async submitMemoryConsolidation(userId, { to, instruction = null, idempotencyKey }) {
    if (!(String(to ?? "") === nativeMemoryRoot(userId) || String(to ?? "").startsWith(`${nativeMemoryRoot(userId)}/`))) throw new HttpError(500, "knowledge_compile_invalid", "A memory consolidation targets the account's own memories.");
    if (!idempotencyKey) throw new HttpError(500, "knowledge_compile_invalid", "A compile is always submitted with an idempotency key.");
    try {
      const body = await this.client.request({ method: "POST", path: "/api/v1/compile", userId, idempotencyKey, timeoutMs: READ_TIMEOUT_MS,
        body: { to, skill: "memory", ...(instruction ? { instruction: String(instruction) } : {}) } });
      this.counters.compiles += 1;
      return memoryConsolidationTask(body?.result);
    } catch (error) { this.counters.failures += 1; throw error; }
  }

  /** A consolidation task as the engine reports it now, or null for one it no longer holds. @param {string} userId @param {string} taskId */
  async memoryConsolidationTask(userId, taskId) {
    try { return memoryConsolidationTask((await this.client.request({ path: `/api/v1/tasks/${taskSegment(taskId)}`, userId }))?.result); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** A task as the engine reports it now, or null for one it no longer holds (expired, or never there). @param {string} userId @param {string} taskId */
  async task(userId, taskId) {
    try { return compileTask((await this.client.request({ path: `/api/v1/tasks/${taskSegment(taskId)}`, userId }))?.result); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /** Ask a task to stop. One that already ended answers its final state; one that is gone answers null. @param {string} userId @param {string} taskId */
  async cancelTask(userId, taskId) {
    try { return compileTask((await this.client.request({ method: "POST", path: `/api/v1/tasks/${taskSegment(taskId)}/cancel`, userId }))?.result); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The engine's own parsers

  /**
   * Hand a file neither the local reader nor the parsing API takes to the engine's parsers and read back what they
   * made of it: an archive, a repository, a format with no name. The file goes into a staging directory of this user,
   * is parsed there, read back as Markdown and removed; nothing of it stays in the engine.
   *
   * @param {string} userId @param {{ name: string, bytes: Buffer, token: string, signal?: AbortSignal | null }} file
   *   `token`: a segment unique to this read (the source's id), so two reads never share a staging directory
   * @returns {Promise<{ text: string, files: Array<{ path: string, chars: number }> }>} the parsed files joined in
   *   path order, each under a line naming it; empty text when the engine produced none
   */
  async parseWithEngine(userId, { name, bytes, token, signal = null }) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(token))) throw new HttpError(500, "knowledge_staging_invalid", "A staging token is invalid.");
    const staging = `${resourcesRoot(userId)}/staging/${token}`;
    this.counters.engineParses += 1;
    try {
      await this.client.remove(userId, staging, { recursive: true }).catch(() => false);
      const uploaded = await this.#upload(userId, { name, bytes, signal });
      await this.client.request({ method: "POST", path: "/api/v1/resources", userId, timeoutMs: PARSE_TIMEOUT_MS,
        body: { temp_file_id: uploaded, to: staging, wait: true, processing_mode: "vectors_only" } });
      const entries = (await this.tree(userId, staging, { nodeLimit: 2000, levelLimit: 12 })).filter((entry) => !entry.isDir)
        .sort((left, right) => (left.relPath < right.relPath ? -1 : 1));
      /** @type {string[]} */
      const parts = [];
      const files = [];
      for (const entry of entries) {
        if (signal?.aborted) throw signal.reason ?? new HttpError(499, "source_parse_aborted", "The read was stopped.");
        const text = await this.read(userId, entry.uri);
        if (!text?.trim()) continue;
        files.push({ path: entry.relPath, chars: text.length });
        parts.push(entries.length > 1 ? `<!-- file: ${entry.relPath} -->\n${text.trim()}` : text.trim());
      }
      return { text: parts.join("\n\n"), files };
    } catch (error) { this.counters.failures += 1; throw error; }
    finally {
      await this.client.remove(userId, staging, { recursive: true }).catch(() => false);
    }
  }

  /**
   * `POST /api/v1/resources/temp_upload`, multipart: the one request of this module that does not go through
   * `OpenVikingClient.request`, which carries JSON only. The same credential, the same asserted identity, no role.
   * @param {string} userId @param {{ name: string, bytes: Buffer, signal?: AbortSignal | null }} file @returns {Promise<string>} the temp file id
   */
  async #upload(userId, { name, bytes, signal = null }) {
    if (!this.client.configured) throw new HttpError(503, "memory_index_url_missing", "The memory index is not configured.");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), String(name).split("/").pop() || "upload");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      let response;
      try {
        response = await this.client.fetchImpl(`${this.client.baseUrl}/api/v1/resources/temp_upload`, {
          method: "POST", body: form, signal: controller.signal,
          headers: { Accept: "application/json", "X-API-Key": this.client.apiKey, "X-OpenViking-Account": this.client.account, "X-OpenViking-User": openVikingUserId(userId) },
        });
      } catch {
        throw new HttpError(503, controller.signal.aborted ? "memory_index_timeout" : "memory_index_unavailable", "The memory index is unavailable.");
      }
      const text = await response.text().catch(() => "");
      /** @type {any} */
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      if (!response.ok) {
        const code = response.status === 413 ? "memory_index_payload_too_large" : response.status === 401 || response.status === 403 ? "memory_index_auth_failed" : "memory_index_rejected";
        throw Object.assign(new HttpError(502, code, `POST /api/v1/resources/temp_upload -> ${response.status}`), { upstreamStatus: response.status, upstreamCode: parsed?.error?.code ?? null });
      }
      const id = parsed?.result?.temp_file_id;
      if (typeof id !== "string" || !id) throw new HttpError(502, "memory_index_response_invalid", "The upload answered without a file id.");
      return id;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  status() { return { configured: this.configured, ...this.counters }; }
}

/** A task id as one path segment. @param {unknown} taskId */
function taskSegment(taskId) {
  const id = String(taskId ?? "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new HttpError(500, "knowledge_task_invalid", "A compile task id is invalid.");
  return id;
}

/**
 * A compile task, in the few fields the scheduler reads. `usage` is the engine's own count for the task's compile
 * rounds (input and output tokens, cache hits not told apart); the summaries written after it are not in it.
 * @param {any} task
 */
function compileTask(task) {
  if (!task || typeof task !== "object" || typeof task.task_id !== "string") throw new HttpError(502, "memory_index_response_invalid", "The engine answered without a task.");
  const usage = task.meta?.token_usage;
  const result = task.result && typeof task.result === "object" ? task.result : null;
  return {
    taskId: task.task_id,
    status: String(task.status ?? ""),
    stage: typeof task.stage === "string" ? task.stage : null,
    terminal: COMPILE_TERMINAL_STATES.includes(String(task.status ?? "")),
    error: typeof task.error === "string" && task.error ? task.error.slice(0, 500) : null,
    processingSeconds: Number.isFinite(Number(task.processing_seconds)) ? Number(task.processing_seconds) : null,
    usage: usage && typeof usage === "object" ? { inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0, totalTokens: Number(usage.total_tokens) || 0 } : null,
    result: result ? { pageCount: Number(result.page_count) || 0, linkCount: Number(result.link_count) || 0,
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 20) : [] } : null,
  };
}

/**
 * A memory-consolidation task: its state, and the files it changed as the engine lists them (URIs only, never content), with what went
 * wrong in part. A task that changed nothing and says nothing is a completed no-op; `errors` are read whatever the status.
 * @param {any} task
 */
function memoryConsolidationTask(task) {
  if (!task || typeof task !== "object" || typeof task.task_id !== "string") throw new HttpError(502, "memory_index_response_invalid", "The engine answered without a task.");
  const result = task.result && typeof task.result === "object" ? task.result : null;
  const uris = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.map(String).filter((uri) => uri.startsWith("viking://")).slice(0, 2_000) : []);
  return {
    taskId: task.task_id,
    status: String(task.status ?? ""),
    terminal: COMPILE_TERMINAL_STATES.includes(String(task.status ?? "")),
    error: typeof task.error === "string" && task.error ? task.error.slice(0, 500) : null,
    result: result ? {
      adds: uris(result.adds), updates: uris(result.updates), deletes: uris(result.deletes),
      errors: Array.isArray(result.errors) ? result.errors.map((/** @type {any} */ item) => String(typeof item === "string" ? item : item?.message ?? item?.error ?? "error").slice(0, 300)).slice(0, 20) : [],
      traceId: typeof result.trace_id === "string" ? result.trace_id.slice(0, 120) : null,
    } : null,
  };
}

/** A literal as a pattern for `grep`: every character the engine's regular expressions give a meaning is escaped. @param {string} literal */
export function escapeGrepPattern(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
