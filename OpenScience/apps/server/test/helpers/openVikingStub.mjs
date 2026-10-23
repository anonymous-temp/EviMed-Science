// An OpenViking that lives in a test: the routes the native memory path calls, answering in the envelopes recorded from
// v0.5.0 (`packages/contracts/openviking/fixtures/memory/`). It keeps files, sessions and tasks in memory, runs an
// "extraction" the test supplies at commit, and records every request it was sent — headers included — so a test can
// assert what reached the engine and what did not.
//
// What it copies from the real server, because the code under test depends on it: a commit answers at once with a task and
// an archive URI; the task ends `completed` with a `memory_diff_uri` or `failed` with a `.failed.json` beside the archive's
// `messages.jsonl`; a failed archive is never retried; a file made by `content/write mode=create` has no memory type; a
// settings PATCH without `memory_types` opens the user to every built-in type; an unregistered user's admin routes are 404;
// a user being deleted answers 412; `fs/tree` pages with `has_more`.
import { once } from "node:events";
import { createServer } from "node:http";

const ok = (result, extra = {}) => ({ status: "ok", result, error: null, telemetry: null, profile: null, ...extra });
const fail = (code, message) => ({ status: "error", result: null, error: { code, message }, telemetry: null, profile: null });

const BUILT_IN_TYPES = ["cases", "entities", "events", "experiences", "identity", "preferences", "profile", "soul", "trajectories"];
export const STUB_MEMORY_TYPES = ["corrections", "decisions", "entities", "follow_ups", "preferences", "profile", "project_context", "project_facts"];

export class OpenVikingStub {
  /**
   * @param {{ extract?: (input: { user: string, session: string, messages: any[], files: Map<string, string> }) => { adds?: any[], updates?: any[], deletes?: any[] } | "fail",
   *   account?: string, apiKey?: string }} [options]
   *   `extract` decides what a commit writes: operations in the engine's own diff shape (`{ uri, memory_type, after }`,
   *   `{ uri, memory_type, before, after }`, `{ uri, memory_type, deleted_content }`), or `"fail"` for a failed extraction.
   */
  constructor({ extract = () => ({}), account = "evimed", apiKey = "stub-root-key" } = {}) {
    this.extract = extract;
    this.account = account;
    this.apiKey = apiKey;
    /** @type {Map<string, string>} uri → text (files of every kind: memories, archives' own files) */
    this.files = new Map();
    /** @type {Map<string, string[]>} uri → tags */
    this.tags = new Map();
    /** @type {Map<string, any>} `${user}/${session}` → { messages, archives, commitCount } */
    this.sessions = new Map();
    /** @type {Map<string, any>} task id → task */
    this.tasks = new Map();
    /** @type {Map<string, { learning: boolean, memoryTypes: string[] }>} registered users */
    this.users = new Map();
    /** @type {Set<string>} users being deleted */
    this.deleting = new Set();
    /** @type {any[]} every request, in order */
    this.requests = [];
    this.taskSeq = 0;
    /** Set to a number of milliseconds to make every answer wait that long (a hanging engine). */
    this.delayMs = 0;
    /** Set to a status to answer every data request with it (an engine that is down). */
    this.failWith = 0;
    this.server = null;
    this.url = "";
  }

  async start() {
    this.server = createServer((req, res) => { void this.#handle(req, res); });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${/** @type {any} */ (this.server.address()).port}`;
    return this;
  }

  async close() {
    if (this.server) { this.server.closeAllConnections?.(); await new Promise((resolve) => this.server.close(resolve)); }
  }

  /** Requests whose path starts with a prefix. @param {string} method @param {string} prefix */
  sent(method, prefix) {
    return this.requests.filter((request) => request.method === method && request.path.startsWith(prefix));
  }

  /** Put a memory file in place as the engine's own extraction would have. */
  seedMemory(user, relPath, text, { type = null, tags = [] } = {}) {
    const uri = `viking://user/${user}/memories/${relPath}`;
    this.files.set(uri, text);
    this.tags.set(uri, [...(type ? [`memory_type=${type}`] : []), ...tags]);
    return uri;
  }

  #session(user, id, create = false) {
    const key = `${user}/${id}`;
    if (!this.sessions.has(key) && create) this.sessions.set(key, { id, user, messages: [], archives: 0, commitCount: 0, createdAt: new Date().toISOString() });
    return this.sessions.get(key) ?? null;
  }

  async #handle(req, res) {
    const url = new URL(req.url, "http://stub");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const user = String(req.headers["x-openviking-user"] ?? "");
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, user,
      headers: { ...req.headers } };
    this.requests.push(record);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const send = (status, json, contentType = "application/json") => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    };
    if (url.pathname === "/health") return send(200, { status: "ok", healthy: true, version: "v0.5.0", auth_mode: "trusted", user_id: user || null });
    if (req.headers["x-api-key"] !== this.apiKey) return send(401, fail("UNAUTHENTICATED", "Invalid API key"));
    if (this.failWith) return send(this.failWith, fail("UNAVAILABLE", "stub: down"));
    const admin = /^\/api\/v1\/admin\/accounts\/([^/]+)\/users(?:\/([^/]+)(\/settings)?)?$/.exec(url.pathname);
    if (admin) return this.#admin(req.method, admin, body, user, send);
    if (!user) return send(400, fail("INVALID_ARGUMENT", "Trusted mode requires X-OpenViking-User"));
    if (this.deleting.has(user)) return send(412, fail("FAILED_PRECONDITION", "Identity deletion is in progress"));
    const path = url.pathname;
    const q = url.searchParams;
    const own = `viking://user/${user}`;
    const within = (uri) => uri === own || uri.startsWith(`${own}/`) || uri === "viking://user" || uri.startsWith("viking://resources") || uri.startsWith("viking://agent");

    if (path === "/api/v1/sessions" && req.method === "POST") {
      const id = String(body?.session_id ?? `auto-${this.sessions.size + 1}`);
      if (this.#session(user, id)) return send(409, fail("ALREADY_EXISTS", `Session already exists: ${id}`));
      this.#session(user, id, true);
      return send(200, ok({ session_id: id, uri: `${own}/sessions/${id}`, user: { account_id: this.account, user_id: user } }));
    }
    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)(?:\/(messages|commit))?$/.exec(path);
    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      const session = this.#session(user, id);
      if (!session) return send(404, fail("NOT_FOUND", `Session not found: ${id}`));
      if (!action && req.method === "GET") {
        return send(200, ok({ session_id: id, message_count: session.messages.length, commit_count: session.commitCount, pending_tokens: session.messages.length * 50, uri: `${own}/sessions/${id}` }));
      }
      if (!action && req.method === "DELETE") { this.sessions.delete(`${user}/${id}`); return send(200, ok({ session_id: id })); }
      if (action === "messages" && req.method === "POST") {
        session.messages.push(body);
        return send(200, ok({ session_id: id, message_count: session.messages.length, pending_tokens: session.messages.length * 50 }));
      }
      if (action === "commit" && req.method === "POST") return send(200, ok(this.commitSession(user, id)));
    }
    const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch && req.method === "GET") {
      const task = this.tasks.get(taskMatch[1]);
      if (!task || task.user !== user) return send(404, fail("NOT_FOUND", "Task not found"));
      return send(200, ok(task.public));
    }
    if (path === "/api/v1/fs/tree" || path === "/api/v1/fs/ls") {
      const uri = String(q.get("uri") ?? "");
      if (!within(uri)) return send(403, fail("PERMISSION_DENIED", "Access denied"));
      if (uri === "viking://user") return send(200, ok([{ name: user, size: 4096, isDir: true, uri: own }], { has_more: false }));
      const showHidden = q.get("show_all_hidden") === "true";
      const tagFilter = q.getAll("tags");
      const paths = [...this.files.keys()].filter((file) => file.startsWith(`${uri}/`)).sort();
      if (!paths.length && !this.#dirExists(uri)) return send(404, fail("NOT_FOUND", `Directory not found: ${uri}`));
      /** @type {Map<string, any>} */
      const nodes = new Map();
      const recursive = path === "/api/v1/fs/tree" || q.get("recursive") === "true";
      for (const file of paths) {
        const rel = file.slice(uri.length + 1);
        const segments = rel.split("/");
        if (!showHidden && segments.some((segment) => segment.startsWith("."))) continue;
        if (tagFilter.length && !tagFilter.every((tag) => (this.tags.get(file) ?? []).includes(tag))) continue;
        for (let depth = 1; depth < segments.length; depth += 1) {
          const dirRel = segments.slice(0, depth).join("/");
          if (!tagFilter.length && (recursive || depth === 1) && !nodes.has(dirRel)) nodes.set(dirRel, { uri: `${uri}/${dirRel}`, size: 0, isDir: true, modTime: "2026-10-13T00:00:00.000Z", rel_path: dirRel, abstract: "", tags: [] });
        }
        if (recursive || segments.length === 1) nodes.set(rel, { uri: file, size: Buffer.byteLength(this.files.get(file) ?? ""), isDir: false, modTime: "2026-10-13T00:00:00.000Z", rel_path: rel, abstract: "", tags: this.tags.get(file) ?? [] });
      }
      const all = [...nodes.values()].sort((a, b) => a.rel_path.localeCompare(b.rel_path));
      const offset = Number(q.get("offset") ?? 0) || 0;
      const limit = Number(q.get("limit") ?? q.get("node_limit") ?? 1000) || 1000;
      return send(200, ok(all.slice(offset, offset + limit), { has_more: offset + limit < all.length }));
    }
    if (path === "/api/v1/fs/attrs" && req.method === "GET") {
      const uri = String(q.get("uri") ?? "");
      if (!this.files.has(uri)) return send(404, fail("NOT_FOUND", `File not found: ${uri}`));
      const tags = this.tags.get(uri) ?? [];
      const type = tags.find((tag) => tag.startsWith("memory_type="))?.slice("memory_type=".length);
      return send(200, ok({ uri, context_type: "memory", attrs: { tags, memory: type ? { memory_type: type, version: 1 } : { version: 1 } } }));
    }
    if (path === "/api/v1/fs/attrs/set_tags" && req.method === "POST") {
      const uri = String(body?.uri ?? "");
      if (!this.files.has(uri)) return send(404, fail("NOT_FOUND", `File not found: ${uri}`));
      const system = (this.tags.get(uri) ?? []).filter((tag) => tag.startsWith("memory_type="));
      this.tags.set(uri, [...system, ...(body?.tags ?? []).map(String)]);
      return send(200, ok({ uri, tags: body?.tags ?? [], mode: "replace", success_count: 1, tags_updated: true }));
    }
    if (path === "/api/v1/fs" && req.method === "DELETE") {
      const uri = String(q.get("uri") ?? "");
      if (!within(uri)) return send(403, fail("PERMISSION_DENIED", "Access denied"));
      const recursive = q.get("recursive") === "true";
      const doomed = [...this.files.keys()].filter((file) => file === uri || (recursive && file.startsWith(`${uri}/`)));
      for (const file of doomed) { this.files.delete(file); this.tags.delete(file); }
      return send(200, ok({ uri, estimated_deleted_count: doomed.length }));
    }
    if (path === "/api/v1/content/read" && req.method === "GET") {
      const uri = String(q.get("uri") ?? "");
      if (!within(uri)) return send(403, fail("PERMISSION_DENIED", "Access denied"));
      if (!this.files.has(uri)) return send(404, fail("NOT_FOUND", `File not found: ${uri}`));
      return send(200, ok(this.files.get(uri)));
    }
    if (path === "/api/v1/content/write" && req.method === "POST") {
      const uri = String(body?.uri ?? "");
      if (!within(uri)) return send(403, fail("PERMISSION_DENIED", "Access denied"));
      if (body?.mode === "create" && this.files.has(uri)) return send(409, fail("ALREADY_EXISTS", `File exists: ${uri}`));
      if (body?.mode === "replace" && !this.files.has(uri) && !uri.includes("/memories/evimed/")) return send(404, fail("NOT_FOUND", `File not found: ${uri}`));
      this.files.set(uri, String(body?.content ?? ""));
      if (!this.tags.has(uri)) this.tags.set(uri, []);
      return send(200, ok({ uri, mode: body?.mode, written_bytes: Buffer.byteLength(String(body?.content ?? "")), content_updated: true, vector_status: "complete" }));
    }
    if (path === "/api/v1/search/search" || path === "/api/v1/search/find") {
      const exclude = Array.isArray(body?.exclude_uris) ? body.exclude_uris : [];
      const target = String(body?.target_uri ?? `${own}/memories`);
      if (!within(target)) return send(403, fail("PERMISSION_DENIED", "Access denied"));
      const words = String(body?.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [...this.files.entries()]
        .filter(([uri]) => uri.startsWith(`${target}/`) && uri.includes("/memories/") && !exclude.some((prefix) => uri === prefix || uri.startsWith(`${prefix}/`)))
        .filter(([uri, text]) => words.length === 0 || words.some((word) => `${uri}\n${text}`.toLowerCase().includes(word)))
        .filter(([uri]) => !(body?.tags ?? []).length || (body.tags).every((tag) => (this.tags.get(uri) ?? []).includes(tag)))
        .map(([uri, text], index) => ({ context_type: "memory", uri, level: 2, score: 0.9 - index * 0.01, abstract: text, tags: this.tags.get(uri) ?? [] }))
        .slice(0, Number(body?.limit ?? 10) || 10);
      if (body?.mode === "context") {
        const entries = hits.map((hit) => ({ uri: hit.uri, category: "memories", score: hit.score, detail: "abstract", text: hit.abstract, origin: "self" }));
        return send(200, ok({ entries, rendered: entries.map((entry) => `<memory uri="${entry.uri}">\n${entry.text}\n</memory>`).join("\n"), digest: "" }));
      }
      return send(200, ok({ memories: hits, resources: [], skills: [], total: hits.length }));
    }
    if (path === "/api/v1/pack/export" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from(`PK-stub-pack:${[...this.files.keys()].filter((uri) => uri.startsWith(`${body?.uri}/`)).length}`));
    }
    if (path === "/mcp" && req.method === "POST") return this.#mcp(body, user, send);
    return send(404, fail("NOT_FOUND", `no stub route for ${req.method} ${path}`));
  }

  #dirExists(uri) {
    // An account's tree exists once it has a session or a file; the stub treats a known user's `memories` as present.
    return [...this.sessions.keys()].some((key) => uri.startsWith(`viking://user/${key.split("/")[0]}`)) && /\/(?:memories|sessions)$/.test(uri);
  }

  /** Commit a session as the server does: archive now, extract "in the background" (here: at once). */
  commitSession(user, id) {
    const session = this.#session(user, id);
    const own = `viking://user/${user}`;
    if (!session || session.messages.length === 0) return { session_id: id, status: "skipped", task_id: null, archive_uri: null, archived: false, reason: "no_messages" };
    session.archives += 1;
    session.commitCount += 1;
    const archive = `${own}/sessions/${id}/history/archive_${String(session.archives).padStart(3, "0")}`;
    const messages = session.messages;
    session.messages = [];
    this.files.set(`${archive}/messages.jsonl`, messages.map((message) => JSON.stringify(message)).join("\n"));
    const taskId = `00000000-0000-4000-8000-${String(++this.taskSeq).padStart(12, "0")}`;
    const paused = this.users.get(user)?.learning === false;
    const outcome = paused ? {} : this.extract({ user, session: id, messages, files: this.files });
    if (outcome === "fail") {
      this.files.set(`${archive}/.failed.json`, JSON.stringify({ stage: "memory_extraction", error: "Error code: 429 - stub", failed_at: new Date().toISOString() }));
      this.tasks.set(taskId, { user, public: { task_id: taskId, task_type: "session_commit", status: "failed", resource_id: id, result: null, error: "Error code: 429 - stub" } });
    } else {
      const operations = { adds: outcome.adds ?? [], updates: outcome.updates ?? [], deletes: outcome.deletes ?? [] };
      for (const add of operations.adds) { this.files.set(add.uri, add.after); this.tags.set(add.uri, [`memory_type=${add.memory_type}`]); }
      for (const update of operations.updates) this.files.set(update.uri, update.after);
      for (const removed of operations.deletes) { this.files.delete(removed.uri); this.tags.delete(removed.uri); }
      const diffUri = `${archive}/memory_diff.json`;
      const skipped = outcome.skipped ?? [];
      this.files.set(diffUri, JSON.stringify({ archive_uri: archive, extracted_at: new Date().toISOString(), operations, skipped_operations: skipped,
        summary: { total_adds: operations.adds.length, total_updates: operations.updates.length, total_deletes: operations.deletes.length, total_skipped: skipped.length } }));
      this.files.set(`${archive}/.done`, "");
      this.tasks.set(taskId, { user, public: { task_id: taskId, task_type: "session_commit", status: "completed", resource_id: id,
        result: { session_id: id, archive_uri: archive, memories_extracted: operations.adds.length + operations.updates.length ? { memory_write: operations.adds.length + operations.updates.length } : {},
          memory_extraction: { skipped: skipped.length, skipped_operations: skipped }, effective_memory_types: [...STUB_MEMORY_TYPES], memory_diff_uri: diffUri }, error: null } });
    }
    return { session_id: id, status: "accepted", task_id: taskId, archive_uri: archive, archived: true };
  }

  #admin(method, match, body, user, send) {
    const [, account, target, settings] = match;
    if (account !== this.account) return send(404, fail("NOT_FOUND", "Account not found"));
    if (!target && method === "POST") {
      const id = String(body?.user_id ?? "");
      if (this.users.has(id)) return send(409, fail("ALREADY_EXISTS", `User already exists: ${id}`));
      this.users.set(id, { learning: true, memoryTypes: [...STUB_MEMORY_TYPES] });
      return send(200, ok({ account_id: account, user_id: id }));
    }
    if (target && user && user !== target) return send(400, fail("INVALID_ARGUMENT", "User header does not match"));
    if (target && this.deleting.has(target)) return send(412, fail("FAILED_PRECONDITION", "Identity deletion is in progress"));
    const held = this.users.get(String(target));
    if (!held) return send(404, fail("NOT_FOUND", `User not found: ${target}`));
    const view = () => ok({ account_id: account, user_id: target, memory_policy: { self: { enabled: held.learning }, peer: { enabled: true }, working_memory: { enabled: false }, memory_types: [...held.memoryTypes].sort() } });
    if (settings && method === "GET") return send(200, view());
    if (settings && method === "PATCH") {
      const policy = body?.memory_policy ?? {};
      if (policy.self && typeof policy.self.enabled === "boolean") held.learning = policy.self.enabled;
      // The measured trap: a PATCH that does not restate the allowlist opens the user to every built-in type.
      held.memoryTypes = Array.isArray(policy.memory_types) ? policy.memory_types.map(String) : [...new Set([...BUILT_IN_TYPES, ...STUB_MEMORY_TYPES])];
      return send(200, view());
    }
    if (!settings && method === "DELETE") {
      this.deleting.add(String(target));
      this.users.delete(String(target));
      setTimeout(() => {
        for (const uri of [...this.files.keys()]) if (uri.startsWith(`viking://user/${target}/`)) { this.files.delete(uri); this.tags.delete(uri); }
        for (const key of [...this.sessions.keys()]) if (key.startsWith(`${target}/`)) this.sessions.delete(key);
        this.deleting.delete(String(target));
      }, 30);
      return send(202, ok({ account_id: account, user_id: target, status: "deleting", task_id: "deletion-task" }));
    }
    return send(404, fail("NOT_FOUND", "no stub admin route"));
  }

  #mcp(body, user, send) {
    const list = Array.isArray(body) ? body : [body];
    const out = [];
    for (const message of list) {
      if (!message || message.id === undefined) continue;
      if (message.method === "initialize") out.push({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "openviking", version: "1.27.0" } } });
      else if (message.method === "tools/list") {
        out.push({ jsonrpc: "2.0", id: message.id, result: { tools: ["list_users", "list_groups", "get_acl", "set_acl", "find", "search", "read", "list", "tree", "remember", "write", "edit", "add_resource", "add_skill", "list_watches", "cancel_watch", "grep", "glob", "forget", "health"]
          .map((name) => ({ name, description: `upstream description of ${name}`, inputSchema: { type: "object", properties: { upstream: { type: "string" } } } })) } });
      } else if (message.method === "tools/call") {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        let text = "ok";
        if (name === "read") text = (args.uris ?? []).map((uri) => this.files.get(uri) ?? "").join("\n");
        if (name === "list") text = [...this.files.keys()].filter((uri) => uri.startsWith(`${args.uri}/`)).map((uri) => `[file] ${uri.slice(String(args.uri).length + 1)}`).join("\n");
        if (name === "search") text = `Found: ${[...this.files.keys()].filter((uri) => uri.startsWith(`${args.target_uri}/`) && !(args.exclude_uris ?? []).some((prefix) => uri.startsWith(prefix))).join(", ")}`;
        if (name === "forget") { this.files.delete(args.uri); text = `Deleted: ${args.uri}`; }
        if (name === "remember") {
          const id = `mcp-store-${String(this.sessions.size + 1).padStart(12, "0")}`;
          const session = this.#session(user, id, true);
          session.messages.push(...(args.messages ?? []));
          const committed = this.commitSession(user, id);
          text = `Submitted ${(args.messages ?? []).length} message(s) for memory extraction (session ${id}, task_id=${committed.task_id}). Extraction runs in the background and decides which memories to create or update.`;
        }
        out.push({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: false } });
      } else out.push({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    if (!out.length) return send(202, "");
    return send(200, out.map((message) => `event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`).join(""), "text/event-stream");
  }
}

/** A stub engine and a client configured for it. @param {import("node:test").TestContext} t */
export async function startOpenVikingStub(t, options = {}) {
  const stub = await new OpenVikingStub(options).start();
  t.after(() => stub.close());
  return stub;
}
