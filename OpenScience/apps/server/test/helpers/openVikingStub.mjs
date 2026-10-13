// An OpenViking that holds files in memory and answers the Resources and Compile routes the way v0.5.0 does — the
// envelopes, the status codes and the quirks the client was written against (`fs/ls` paging with `has_more` beside
// `result`, `create` refusing a file that exists, a finished compile reporting every file as updated, a task that is
// gone answering 404). A compile does what the test tells it to: `compile` is called with the request and the store,
// and whatever it writes into the target is what the "engine" produced.
//
// It is a double with real bounds (a listing is paged at the limit it was asked for), because a double that ignores a
// limit hides the paging bug the real server would show.

/** @typedef {{ content: Buffer, tags: string[], modTime: string }} StubFile */

/**
 * @param {{ compile?: (request: { from: string[], to: string, skill: string, instruction: string | null, user: string }, engine: ReturnType<typeof createOpenVikingStub>) => void | Promise<void>,
 *   compileUsage?: { input_tokens: number, output_tokens: number, total_tokens: number } }} [options]
 */
export function createOpenVikingStub({ compile = () => {}, compileUsage = { input_tokens: 60_000, output_tokens: 5_000, total_tokens: 65_000 } } = {}) {
  /** @type {Map<string, StubFile>} keyed by uri */
  const files = new Map();
  /** @type {Map<string, any>} */
  const tasks = new Map();
  /** @type {Map<string, string>} idempotency key → task id */
  const submissions = new Map();
  /** @type {Array<{ method: string, path: string, user: string, body: any, query: Record<string, string>, headers: Record<string, string> }>} */
  const requests = [];
  let clock = Date.parse("2026-10-13T00:00:00Z");
  let down = false;
  let taskSeq = 0;
  /** How many polls a task stays running before it ends. */
  let pollsToFinish = 1;

  const stamp = () => new Date((clock += 1000)).toISOString();
  const ok = (/** @type {unknown} */ result, extra = {}) => json(200, { status: "ok", result, error: null, ...extra });
  const fail = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) => json(status, { status: "error", result: null, error: { code, message } });
  /** @param {number} status @param {unknown} body */
  function json(status, body) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
  /** The files and directories directly or deeply under a root. @param {string} root */
  const under = (root) => [...files.keys()].filter((uri) => uri.startsWith(`${root}/`)).sort();
  /** @param {string} uri @param {string} user */
  const allowed = (uri, user) => !uri.startsWith("viking://user/") || uri.startsWith(`viking://user/${user}/`) || uri === `viking://user/${user}`;

  const engine = {
    files, tasks, requests,
    /** Put a file as the engine itself would (a compile's write). @param {string} uri @param {string} content @param {string[]} [tags] */
    put(uri, content, tags = []) { files.set(uri, { content: Buffer.from(content, "utf8"), tags, modTime: stamp() }); },
    /** @param {string} uri */
    remove(uri) { for (const key of [...files.keys()]) if (key === uri || key.startsWith(`${uri}/`)) files.delete(key); },
    /** @param {string} uri */
    text(uri) { return files.get(uri)?.content.toString("utf8") ?? null; },
    /** @param {string} root */
    list(root) { return under(root); },
    setDown(/** @type {boolean} */ value) { down = value; },
    setPollsToFinish(/** @type {number} */ value) { pollsToFinish = value; },

    /** The `fetch` the client is given. @param {string | URL} input @param {RequestInit} [init] */
    async fetch(input, init = {}) {
      if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
      const url = new URL(String(input));
      const method = String(init.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(Object.entries(/** @type {Record<string, string>} */ (init.headers ?? {})).map(([name, value]) => [name.toLowerCase(), String(value)]));
      const user = headers["x-openviking-user"] ?? "";
      const query = Object.fromEntries(url.searchParams);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, path: url.pathname, user, body, query, headers });
      const path = url.pathname;
      if (path === "/health") return json(200, { status: "ok", healthy: true, version: "v0.5.0", auth_mode: "trusted" });
      if (headers["x-api-key"] !== "stub-key") return fail(401, "UNAUTHENTICATED", "Invalid API key");
      const uri = String(body?.uri ?? query.uri ?? "");
      if (uri && !allowed(uri, user)) return fail(403, "PERMISSION_DENIED", "Access denied");

      if (path === "/api/v1/content/write" && method === "POST") {
        if (body.mode === "create" && files.has(uri)) return fail(409, "ALREADY_EXISTS", `File already exists: ${uri}`);
        if (body.mode === "create" && !/\.(?:md|txt|json|yaml|yml|toml|py|js|ts)$/.test(uri)) return fail(400, "INVALID_ARGUMENT", "create allows only text extensions");
        const previous = files.get(uri);
        files.set(uri, { content: Buffer.from(String(body.content), "utf8"), tags: Array.isArray(body.tags) ? body.tags : previous?.tags ?? [], modTime: stamp() });
        return ok({ uri, mode: body.mode, written_bytes: Buffer.byteLength(String(body.content)), content_updated: true });
      }
      if (path === "/api/v1/content/set_tags" && method === "POST") {
        const file = files.get(uri);
        if (!file) return fail(404, "NOT_FOUND", "not found");
        file.tags = body.tags;
        return ok({ uri, tags: body.tags });
      }
      if (path === "/api/v1/fs" && method === "DELETE") {
        const before = files.size;
        engine.remove(uri);
        if (before === files.size) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        return ok({ uri, estimated_deleted_count: before - files.size });
      }
      if (path === "/api/v1/fs/ls") {
        const children = new Map();
        for (const key of under(uri)) {
          const rest = key.slice(uri.length + 1);
          const name = rest.split("/")[0];
          const isDir = rest.includes("/");
          if (name.startsWith(".")) continue;
          if (!children.has(name)) children.set(name, { uri: `${uri}/${name}`, size: isDir ? 0 : files.get(key)?.content.length ?? 0, isDir, modTime: files.get(key)?.modTime ?? stamp(), abstract: "",
            ...(query.include_tags === "true" ? { tags: isDir ? [] : files.get(key)?.tags ?? [] } : {}) });
        }
        if (!children.size) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        const all = [...children.values()];
        const offset = Number(query.offset ?? 0);
        const limit = Number(query.limit ?? 1000);
        return ok(all.slice(offset, offset + limit), { has_more: offset + limit < all.length });
      }
      if (path === "/api/v1/fs/tree") {
        const found = under(uri);
        if (!found.length) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        const directories = new Set();
        /** @type {any[]} */
        const entries = [];
        for (const key of found) {
          const rel = key.slice(uri.length + 1);
          if (query.show_all_hidden !== "true" && rel.split("/").some((part) => part.startsWith("."))) continue;
          const parts = rel.split("/");
          for (let depth = 1; depth < parts.length; depth += 1) {
            const dir = parts.slice(0, depth).join("/");
            if (!directories.has(dir)) { directories.add(dir); entries.push({ uri: `${uri}/${dir}`, size: 0, isDir: true, modTime: stamp(), rel_path: dir, abstract: "" }); }
          }
          entries.push({ uri: key, size: files.get(key)?.content.length ?? 0, isDir: false, modTime: files.get(key)?.modTime, rel_path: rel, abstract: "" });
        }
        return ok(entries.slice(0, Number(query.node_limit ?? 1000)));
      }
      if (path === "/api/v1/content/read") {
        const file = files.get(uri);
        if (!file) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        return ok(file.content.toString("utf8"));
      }
      if (path === "/api/v1/content/download") {
        const file = files.get(uri);
        if (!file) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        return new Response(new Uint8Array(file.content), { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      if (path === "/api/v1/fs/attrs") {
        const file = files.get(uri);
        if (!file) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        return ok({ uri, context_type: "resource", attrs: { tags: file.tags } });
      }
      if (path === "/api/v1/fs/stat") {
        const file = files.get(uri);
        if (!file && !under(uri).length) return fail(404, "NOT_FOUND", `not found: ${uri}`);
        return ok({ name: uri.split("/").pop(), size: file?.content.length ?? 0, isDir: !file, uri, modTime: file?.modTime ?? stamp(), isLocked: false, id: "stub" });
      }
      if (path === "/api/v1/search/grep" && method === "POST") {
        const pattern = new RegExp(String(body.pattern), body.case_insensitive ? "i" : "");
        /** @type {any[]} */
        const matches = [];
        const scanned = [...files.keys()].filter((key) => key === uri || key.startsWith(`${uri}/`));
        for (const key of scanned) {
          files.get(key)?.content.toString("utf8").split("\n").forEach((line, index) => { if (pattern.test(line) && matches.length < Number(body.node_limit ?? 100)) matches.push({ line: index + 1, uri: key, content: line }); });
        }
        return ok({ matches, count: matches.length, match_count: matches.length, files_scanned: scanned.length });
      }
      if (path === "/api/v1/compile" && method === "POST") {
        const key = headers["idempotency-key"];
        if (!key) return fail(400, "INVALID_ARGUMENT", "Idempotency-Key is required");
        if (body.args && Object.keys(body.args).length) return fail(400, "INVALID_ARGUMENT", "args are not implemented");
        const fingerprint = JSON.stringify(body);
        const held = submissions.get(key);
        if (held) {
          const task = tasks.get(held);
          if (task.fingerprint !== fingerprint) return fail(409, "CONFLICT", "Idempotency-Key was already used with different parameters");
          return json(202, { status: "ok", result: engine.taskView(task) });
        }
        const id = `cmp_${String(taskSeq += 1).padStart(8, "0")}${"a".repeat(56)}`;
        const task = { id, user, request: body, fingerprint, status: "pending", stage: "queued", polls: 0, result: null, error: null, usage: null, cancelled: false };
        tasks.set(id, task);
        submissions.set(key, id);
        return json(202, { status: "ok", result: engine.taskView(task) });
      }
      const taskMatch = /^\/api\/v1\/tasks\/([^/]+)(\/cancel)?$/.exec(path);
      if (taskMatch) {
        const task = tasks.get(taskMatch[1]);
        if (!task || task.user !== user) return fail(404, "NOT_FOUND", "Task not found or expired");
        if (taskMatch[2]) {
          if (task.status === "pending" || task.status === "running") { task.cancelled = true; task.status = "cancelling"; }
          return ok(engine.taskView(task));
        }
        await engine.advance(task);
        return ok(engine.taskView(task));
      }
      return fail(404, "NOT_FOUND", `no stub route ${method} ${path}`);
    },

    /** One poll's worth of progress. @param {any} task */
    async advance(task) {
      if (["completed", "failed", "cancelled"].includes(task.status)) return;
      if (task.cancelled) { task.status = "cancelled"; task.stage = "cancelled"; return; }
      task.polls += 1;
      if (task.polls < pollsToFinish) { task.status = "running"; task.stage = "compile: agent"; return; }
      try {
        const before = new Set(under(task.request.to));
        await compile({ from: task.request.from, to: task.request.to, skill: task.request.skill, instruction: task.request.instruction ?? null, user: task.user }, engine);
        const after = under(task.request.to);
        // As measured: every file of the target is "updated", whether its bytes changed or not.
        task.result = { from: task.request.from, to: task.request.to, skill: task.request.skill, created: after.filter((uri) => !before.has(uri)), updated: after, unchanged: [],
          page_count: after.filter((uri) => uri.endsWith(".md")).length, link_count: 0, warnings: [] };
        task.usage = compileUsage;
        task.status = "completed"; task.stage = "completed";
      } catch (error) {
        task.status = "failed"; task.stage = "compile: agent"; task.error = String(/** @type {any} */ (error)?.message ?? error);
      }
    },

    /** @param {any} task */
    taskView(task) {
      return { task_id: task.id, task_type: "compile", status: task.status, stage: task.stage, processing_seconds: task.polls * 5, result: task.result, error: task.error,
        meta: { request: task.request, ...(task.usage ? { token_usage: task.usage } : {}) } };
    },

    /** Forget a task, as the engine does a day after it ended. @param {string} id */
    expire(id) { tasks.delete(id); },
  };
  return engine;
}
