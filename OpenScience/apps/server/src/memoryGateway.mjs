import { carriesPlatformContext, maskIdentifiers, unwrapUserWrappers } from "@evimed/domain";
import {
  recordGatewayCommit, recordGatewayMasked, recordGatewayMessage, recordGatewayRefusal, recordGatewayRequest,
  recordGatewayUpstreamFailure, recordGatewayWithheld, recordLedgerFailure,
} from "./nativeMemoryMetrics.mjs";
import { DERIVED_INDEX_SEGMENT, nativeMemoryFile } from "./openVikingSessions.mjs";
import { HttpError } from "./security.mjs";

/**
 * The memory gateway: `/internal/memory/v1/…`, the one door between a runtime and OpenViking's native memory engine.
 *
 * Hidden knowledge: the official DSH memory plugin (`@openviking/dsh-memory-plugin`, pinned in `deps-version.json`) runs
 * unmodified in the runtime. It was written to hold the engine's key and talk to the engine. Here it holds nothing: its
 * endpoint is a loopback bridge in the runtime that adds the runtime's workload token, and the bridge's only upstream is
 * this gateway. So every request below is exactly an OpenViking request — the same path under the prefix, the same body,
 * the same answer envelope — and what the gateway adds is everything the plugin cannot know and the runtime must not hold:
 *
 *  1. **Identity.** The workload token fixes account and project. `X-OpenViking-Account` / `-User` from the caller are
 *     never read, a request that asserts `X-OpenViking-Role` is refused, and the engine's key is written by
 *     `OpenVikingClient.request` alone.
 *  2. **The caller's own space.** Every URI a request or a tool names must be under `viking://user/<own>/`; the listing of
 *     `viking://user` is answered here with the caller alone.
 *  3. **The person's words only.** A message carrying a block the platform injected (`PLATFORM_CONTEXT_TAGS`, the plugin's
 *     own `openviking-context` among them) is accepted and never forwarded; a mid-run correction loses its wrapper and
 *     keeps its words; only `text` parts go on (with tool results off the plugin still sends every tool call's name and
 *     input); `peer_id` is dropped (a peer would move the profile under the peer); identifier-shaped spans are masked.
 *  4. **Recall that can find our types.** `purpose` and `quotas` are removed from a search (the plugin hard-codes
 *     `purpose: "coding"`, which retrieves by upstream's buckets and can never return a custom type or the profile),
 *     `query_expansion` is forced off (it is one more model call and about three seconds), and the shared areas, the
 *     derived index subtree (`memories/evimed`: PostgreSQL's copies and the capsule facts) and the files the person marked
 *     sensitive are excluded.
 *  5. **Five tools.** The engine's MCP server advertises twenty, one of which lists every user of the account. `tools/list`
 *     answers `search`, `read`, `list`, `remember` and `forget` with this platform's own short descriptions — `remember`
 *     only when the person asks, because during a captured conversation it costs four extra extraction calls — and a call
 *     of anything else is refused here.
 *  6. **Who is not learned from, who is not read for** (`memoryAdmission.mjs`). Writes are accepted and not forwarded;
 *     reads find nothing.
 *  7. **Failing fast.** A memory service that accepts a connection and does not answer delays a new conversation's first
 *     prompt by eighteen seconds (measured); one that refuses costs nothing. The engine is asked with short deadlines and
 *     a failure is a 5xx at once.
 *  8. **The ledger.** Every commit the engine accepts is written to the overlay with its archive and task, and an account
 *     is registered with the engine's admin routes the first time it is seen (settings and deletion answer 404 until then).
 *  9. **Never forwarded at all:** `stats/*` (account-wide counts), `admin/*`, `content/write`, `DELETE fs`, `pack/*`,
 *     `fs/attrs/*` — those are the memory page's, made by the control plane itself.
 *
 * Build to delete: items 3 (tool parts), 4 (`purpose`) and 5 (the descriptions) go when the plugin grows the switches
 * (`mcpEnabled` and `noAutoInject` are declared in 0.5.20 and read by no code).
 *
 * @module memoryGateway
 */

export const MEMORY_GATEWAY_PATH = "/internal/memory/v1";

/** The name a runtime reads the gateway's base URL under. Empty or absent: this account's memory is not on the native engine. */
export const MEMORY_GATEWAY_URL_ENV = "EVIMED_MEMORY_GATEWAY_URL";

/** The tag the unmodified plugin wraps its own injected profile block in; registered as an injection tag in the domain. */
export const PLUGIN_CONTEXT_TAG = "openviking-context";

const SESSION = "[A-Za-z0-9_.@-]{1,200}";
/** method + path under the prefix → handler. Nothing outside this table reaches the engine. */
const ROUTES = Object.freeze([
  ["GET", /^\/health$/, "health"],
  ["GET", /^\/api\/v1\/system\/status$/, "status"],
  ["POST", /^\/api\/v1\/sessions$/, "sessionCreate"],
  ["GET", new RegExp(`^/api/v1/sessions/(${SESSION})$`), "sessionRead"],
  ["POST", new RegExp(`^/api/v1/sessions/(${SESSION})/messages$`), "messageWrite"],
  ["POST", new RegExp(`^/api/v1/sessions/(${SESSION})/commit$`), "commit"],
  ["POST", /^\/api\/v1\/search\/search$/, "search"],
  ["GET", /^\/api\/v1\/content\/read$/, "read"],
  ["GET", /^\/api\/v1\/fs\/ls$/, "list"],
  ["GET", /^\/api\/v1\/skills$/, "skills"],
  ["POST", /^\/mcp$/, "mcp"],
  ["DELETE", /^\/mcp$/, "mcpClose"],
]);

/** The pattern a metric label carries for a gateway path, so a caller cannot mint labels. @param {string} pathname */
export function memoryGatewayRoutePattern(pathname) {
  const rest = pathname.slice(MEMORY_GATEWAY_PATH.length);
  for (const [, pattern, name] of ROUTES) if (/** @type {RegExp} */ (pattern).test(rest)) return `${MEMORY_GATEWAY_PATH}/:${name}`;
  return `${MEMORY_GATEWAY_PATH}/:other`;
}

/**
 * The five model-facing tools, as this platform describes them. Short on purpose: a tool's description is paid for on
 * every request, and upstream's `remember` ("use when the user shares preferences, important facts or decisions") makes a
 * model call it after an ordinary statement the conversation capture already holds.
 */
export const MEMORY_GATEWAY_TOOLS = Object.freeze({
  search: {
    description: "Search the user's long-term memories (their background, standing preferences, projects, decisions, corrections) by meaning. Use when the question points at something said in an earlier conversation. Returns ranked memory files with their text; read one with `read` for the whole file.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for, in the user's language." },
        limit: { type: "integer", default: 5, minimum: 1, maximum: 20, description: "How many results." },
        target_uri: { type: "string", description: "Optional: a directory of the user's memories to search within, from `list`." },
      },
    },
  },
  read: {
    description: "Read one or more of the user's memory files by URI (from the memory index, `search` or `list`).",
    inputSchema: { type: "object", required: ["uris"], properties: { uris: { type: "array", items: { type: "string" }, maxItems: 10, description: "viking:// URIs of memory files." } } },
  },
  list: {
    description: "List the user's memory files and directories. Without a URI it lists the top of their memories.",
    inputSchema: { type: "object", properties: { uri: { type: "string", description: "A directory of the user's memories." }, recursive: { type: "boolean", default: false } } },
  },
  remember: {
    description: "Keep something in long-term memory. Use ONLY when the user explicitly asks you to remember something (\"记住…\", \"remember that…\"). Pass their own words as a user message. Do not call it for ordinary statements: the conversation is learned from without it. Takes about ten seconds to appear.",
    inputSchema: {
      type: "object", required: ["messages"],
      properties: { messages: { type: "array", maxItems: 6, items: { type: "object", required: ["role", "content"], properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } } } } },
    },
  },
  forget: {
    description: "Delete one memory file, when the user asks to forget it. Name the file by its URI. Irreversible.",
    inputSchema: { type: "object", required: ["uri"], properties: { uri: { type: "string", description: "The viking:// URI of one memory file." } } },
  },
});
const TOOL_NAMES = Object.freeze(Object.keys(MEMORY_GATEWAY_TOOLS));
/** The tools that read memory, as opposed to the two that change it. */
const READ_TOOLS = new Set(["search", "read", "list"]);
/** The JSON-RPC methods of the MCP handshake and of tool use; nothing else is forwarded. */
const MCP_FORWARDED_METHODS = new Set(["initialize", "server/discover", "notifications/initialized", "notifications/cancelled", "ping", "tools/list", "tools/call"]);
/** Listings the server would offer and this gateway does not: answered empty, here. */
const MCP_EMPTY_LISTS = Object.freeze({ "prompts/list": { prompts: [] }, "resources/list": { resources: [] }, "resources/templates/list": { resourceTemplates: [] } });

/** What a read tool answers a caller whose memory is not read, by why. Said to the model, in the words the recall tool uses. */
const NOT_READ = Object.freeze({
  paused: "用户已暂停记忆（整个账号或本项目）：这里不读取，也不代表没有相关记忆。",
  trial: "这是一段试用别人胶囊的对话：只读这个胶囊，不读用户自己的记忆。",
  other: "这段对话不读取长期记忆。",
});
/** What `remember` answers a caller whose conversation is not learned from. */
const NOT_KEPT = Object.freeze({
  paused: "用户已暂停记忆（整个账号或本项目）：这条没有记下。需要记住的话，请用户先在记忆设置里恢复记忆。",
  trial: "这是一段试用别人胶囊的对话：这条没有记下。需要记住的话，请用户在普通对话里再说一次。",
  clinical_context: "本次对话读取了受试者资料，内容保留在该研究中，不写入长期记忆。",
  other: "这段对话不写入长期记忆：这条没有记下。",
});

const ok = (/** @type {unknown} */ result) => ({ status: "ok", result, error: null });
const refusal = (/** @type {string} */ code, /** @type {string} */ message) => ({ status: "error", result: null, error: { code, message } });

/** Whether a viking:// URI is inside one account's own space (`viking://~` is the engine's alias for it). */
function insideOwnSpace(uri, userRoot) {
  const text = String(uri ?? "");
  if (/(?:^|\/)\.\.(?:\/|$)/.test(text)) return false;
  if (text === "viking://~" || text.startsWith("viking://~/")) return true;
  return text === userRoot || text.startsWith(`${userRoot}/`);
}

/** A URI with the engine's own-space alias written out. */
const absolute = (/** @type {string} */ uri, /** @type {string} */ userRoot) => (uri === "viking://~" ? userRoot : uri.startsWith("viking://~/") ? `${userRoot}/${uri.slice("viking://~/".length)}` : uri);

/**
 * What to do with one captured message: forward it, reduced to the person's or the assistant's own text, or drop it.
 *
 * A platform tag anywhere in the text (after a researcher's own wrapper is removed) drops the whole message, for either
 * role: an assistant message echoing an injected block is evidence of nothing. What goes on is the role, the text and the
 * time — never a tool part, a peer, or a field this gateway does not know.
 * @param {any} body
 * @returns {{ forward: { role: string, parts: { type: "text", text: string }[], created_at?: string }, masked: boolean } | { drop: "invalid" | "platform_context" | "no_text" }}
 */
export function filterCapturedMessage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !["user", "assistant"].includes(body.role)) return { drop: "invalid" };
  const texts = typeof body.content === "string" ? [body.content]
    : Array.isArray(body.parts) ? body.parts.filter((/** @type {any} */ part) => part?.type === "text" && typeof part.text === "string").map((/** @type {any} */ part) => part.text) : [];
  if (carriesPlatformContext(unwrapUserWrappers(texts.join("\n")))) return { drop: "platform_context" };
  let masked = false;
  /** @type {{ type: "text", text: string }[]} */
  const parts = [];
  for (const text of texts) {
    const own = unwrapUserWrappers(text);
    if (!own) continue;
    const safe = maskIdentifiers(own);
    if (safe !== own) masked = true;
    parts.push({ type: "text", text: safe });
  }
  if (!parts.length) return { drop: "no_text" };
  return { forward: { role: body.role, parts, ...(typeof body.created_at === "string" && body.created_at.length <= 40 ? { created_at: body.created_at } : {}) }, masked };
}

/** The JSON-RPC messages of a buffered `text/event-stream` body. @param {string} text */
export function parseEventStream(text) {
  /** @type {any[]} */
  const messages = [];
  /** @type {string[]} */
  let data = [];
  const flush = () => {
    if (!data.length) return;
    const joined = data.join("\n").trim();
    data = [];
    if (joined && joined !== "[DONE]") messages.push(JSON.parse(joined));
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line === "") { flush(); continue; }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  flush();
  return messages;
}

const toolText = (/** @type {unknown} */ id, /** @type {string} */ text) => ({ jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text }], isError: false } });
const rpcError = (/** @type {unknown} */ id, /** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * @param {{
 *   config: Record<string, any>,
 *   runtimeManager: { assertActiveEviMedWorkloadToken: (token: string | undefined) => Promise<{ userId: string, projectId: string }> },
 *   store: { userById: (id: string) => Promise<any>, requireProject: (user: any, projectId: string) => Promise<any> },
 *   sessions: import("./openVikingSessions.mjs").OpenVikingSessions | null,
 *   admission: { admit: (caller: { user: any, project: any, engineSessionId?: string | null }) => Promise<import("./memoryAdmission.mjs").MemoryAdmission> },
 *   overlay?: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay | null,
 *   memoryTool?: { forget: (user: any, project: any, uri: string) => Promise<{ removed: boolean }> } | null,
 *   now?: () => number,
 * }} dependencies
 *   `memoryTool.forget` is the memory page's own deletion (the file, its revision, the rejection that keeps it from coming
 *   back); absent, `forget` is forwarded to the engine and only the file goes.
 * @returns {(req: any, res: any, onFailure?: (failure: any) => void) => Promise<void>}
 */
export function createMemoryGatewayHandler({ config, runtimeManager, store, sessions, admission, overlay = null, memoryTool = null, now = () => Date.now() }) {
  const enabled = config.ovNativeMemoryEnabled === true && config.memoryEnabled !== false && Boolean(sessions?.configured);
  const maxBodyBytes = Math.max(1_024, Number(config.memoryGatewayMaxBodyBytes) || 1_048_576);
  const ratePerMinute = Math.max(0, Number(config.memoryGatewayRatePerMinute ?? 600) || 0);
  const commitsPerHour = Math.max(0, Number(config.memoryGatewayCommitsPerHour ?? 120) || 0);
  /** @type {Map<string, { until: number, count: number }>} */
  const requestWindows = new Map();
  /** @type {Map<string, { until: number, count: number }>} */
  const commitWindows = new Map();
  /** Accounts this process has already registered with the engine's admin routes. @type {Set<string>} */
  const registered = new Set();

  /** @param {Map<string, { until: number, count: number }>} windows @param {string} key @param {number} span @param {number} limit */
  function overLimit(windows, key, span, limit) {
    if (!limit) return false;
    const at = now();
    if (windows.size > 10_000) for (const [name, window] of windows) if (window.until <= at) windows.delete(name);
    const held = windows.get(key);
    const window = !held || held.until <= at ? { until: at + span, count: 0 } : held;
    window.count += 1;
    windows.set(key, window);
    return window.count > limit;
  }

  /** Tell the engine's admin routes about an account the first time this process sees it. Never a reason a request fails. */
  async function ensureRegistered(userId) {
    if (registered.has(userId) || !sessions) return;
    try {
      const held = overlay?.configured ? await overlay.account(userId) : null;
      if (!held?.registeredAt) {
        await sessions.register(userId);
        if (overlay?.configured) await overlay.noteRegistered(userId);
      }
      registered.add(userId);
    } catch { /* the worker registers what the gateway could not */ }
  }

  /** Conversations whose project this process has already put in the overlay's ledger. @type {Set<string>} */
  const noted = new Set();
  /** @param {string} userId @param {string} sessionId @param {string} projectId */
  async function noteSession(userId, sessionId, projectId) {
    const key = `${userId}\u0000${sessionId}`;
    if (noted.has(key) || !overlay?.configured) return;
    try {
      await overlay.noteSession(userId, sessionId, projectId);
      if (noted.size > 5_000) noted.clear();
      noted.add(key);
    } catch { recordLedgerFailure(); }
  }

  /**
   * A conversation read a patient record: what it had already sent the engine goes too. Its text is the study's, and the
   * messages still pending in its session would otherwise be archived by the engine's own idle commit. Asked once per
   * conversation per process, never waited on.
   * @type {Set<string>}
   */
  const droppedSessions = new Set();
  /** @param {string} userId @param {string} sessionId */
  function dropClinicalSession(userId, sessionId) {
    const key = `${userId}\u0000${sessionId}`;
    if (droppedSessions.has(key) || !sessions) return;
    if (droppedSessions.size > 10_000) droppedSessions.clear();
    droppedSessions.add(key);
    void sessions.deleteSession(userId, sessionId).catch(() => { droppedSessions.delete(key); });
  }

  /** @param {any} req @returns {Promise<Buffer>} */
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) throw new HttpError(413, "memory_gateway_payload_too_large", "The memory request is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** The answer for an engine failure: the engine's own status for the refusals the plugin understands, 5xx otherwise. */
  function upstreamFailure(error) {
    const code = String(/** @type {any} */ (error)?.code ?? "");
    const upstreamStatus = Number(/** @type {any} */ (error)?.upstreamStatus) || 0;
    if ([400, 404, 409, 412, 422].includes(upstreamStatus)) {
      return { status: upstreamStatus, json: refusal(String(/** @type {any} */ (error)?.upstreamCode ?? "UPSTREAM_REFUSED"), "The memory service refused the request."), outcome: "forwarded" };
    }
    recordGatewayUpstreamFailure(code);
    const unavailable = code === "memory_index_timeout" || code === "memory_index_unavailable" || /^memory_index_url_|_api_key_/.test(code);
    return { status: unavailable ? 503 : 502, json: refusal("memory_gateway_upstream_unavailable", "The memory service is not reachable."), outcome: "failed", failure: code || "memory_gateway_upstream_unavailable" };
  }

  /** @type {Record<string, (ctx: any) => Promise<{ status: number, json?: unknown, text?: string, contentType?: string, outcome: string }>>} */
  const handlers = {
    // Liveness and version only: the engine's own body also names its auth mode and the identity it saw.
    async health() {
      return { status: 200, json: await /** @type {any} */ (sessions).health(), outcome: "forwarded" };
    },
    // Answered here: the plugin only wants its own user space's name.
    async status(ctx) {
      return { status: 200, json: ok({ initialized: true, user: ctx.engineUser }), outcome: "local" };
    },
    async sessionCreate(ctx) {
      const sessionId = typeof ctx.json?.session_id === "string" ? ctx.json.session_id : "";
      if (!new RegExp(`^${SESSION}$`).test(sessionId)) throw new HttpError(400, "memory_gateway_body_invalid", "A session id is required.");
      const admitted = await ctx.admit(sessionId);
      const local = ok({ session_id: sessionId, uri: `${ctx.userRoot}/sessions/${sessionId}`, user: { account_id: ctx.account, user_id: ctx.engineUser } });
      // Policy (memory types, auto-commit) is the deployment's, in `ov.conf`: only the id is the caller's to choose. A
      // caller that is not learned from gets no session upstream at all — an empty one would still be scanned for idle commits.
      // A conversation whose turn in progress the platform started may hold the person's turns too: its session is made.
      if (!admitted.native || (!admitted.learn && admitted.learnReason !== "automated_run")) {
        recordGatewayWithheld(admitted.learnReason ?? "legacy_engine");
        return { status: 200, json: local, outcome: "withheld" };
      }
      await ensureRegistered(ctx.user.id);
      return { status: 200, json: await /** @type {any} */ (sessions).createSession(ctx.user.id, sessionId), outcome: "forwarded" };
    },
    async sessionRead(ctx) {
      const sessionId = ctx.match[1];
      const admitted = await ctx.admit(sessionId);
      if (!admitted.native) {
        recordGatewayWithheld("legacy_engine");
        return { status: 200, json: ok({ session_id: sessionId, message_count: 0, commit_count: 0, pending_tokens: 0 }), outcome: "withheld" };
      }
      return { status: 200, json: await /** @type {any} */ (sessions).readSession(ctx.user.id, sessionId), outcome: "forwarded" };
    },
    async messageWrite(ctx) {
      const sessionId = ctx.match[1];
      const accepted = { status: 200, json: ok({ session_id: sessionId, message_count: 0, pending_tokens: 0 }) };
      const admitted = await ctx.admit(sessionId);
      if (!admitted.learn) {
        recordGatewayMessage("not_learning");
        recordGatewayWithheld(admitted.learnReason ?? "legacy_engine");
        if (admitted.learnReason === "clinical_context") dropClinicalSession(ctx.user.id, sessionId);
        return { ...accepted, outcome: "withheld" };
      }
      const decision = filterCapturedMessage(ctx.json);
      if ("drop" in decision) {
        recordGatewayMessage(decision.drop);
        if (decision.drop === "invalid") throw new HttpError(400, "memory_gateway_body_invalid", "A message needs a role and text.");
        return { ...accepted, outcome: "local" };
      }
      if (decision.masked) recordGatewayMasked();
      await ensureRegistered(ctx.user.id);
      let answer;
      try {
        answer = await /** @type {any} */ (sessions).addMessage(ctx.user.id, sessionId, decision.forward);
      } catch (error) {
        // A conversation whose session start the gateway answered itself (it began as a platform turn): made now.
        if (/** @type {any} */ (error)?.code !== "memory_index_not_found") throw error;
        await /** @type {any} */ (sessions).createSession(ctx.user.id, sessionId);
        answer = await /** @type {any} */ (sessions).addMessage(ctx.user.id, sessionId, decision.forward);
      }
      recordGatewayMessage("forwarded");
      // Which project this conversation is held in, noted once: the engine's own idle commits never pass the gateway.
      await noteSession(ctx.user.id, sessionId, ctx.project.id);
      return { status: 200, json: answer, outcome: "forwarded" };
    },
    async commit(ctx) {
      const sessionId = ctx.match[1];
      const nothing = { status: 200, json: ok({ session_id: sessionId, status: "skipped", task_id: null, archive_uri: null, archived: false, reason: "no_messages" }) };
      // A commit sends nothing new: it archives what was forwarded. So it follows the account's switches, not the turn in
      // progress — a platform-started turn's messages never reached the session it would archive.
      const admitted = await ctx.admit(sessionId);
      if (!admitted.native || (!admitted.learn && admitted.learnReason !== "automated_run")) {
        recordGatewayCommit("not_learning");
        recordGatewayWithheld(admitted.learnReason ?? "legacy_engine");
        if (admitted.learnReason === "clinical_context") dropClinicalSession(ctx.user.id, sessionId);
        return { ...nothing, outcome: "withheld" };
      }
      // Each commit is one extraction call. Over the hourly bound it is answered as "nothing pending": the messages stay
      // in the session and the next commit, or the engine's own idle commit, archives them.
      if (overLimit(commitWindows, String(ctx.user.id), 3_600_000, commitsPerHour)) {
        recordGatewayCommit("rate_limited");
        return { ...nothing, outcome: "local" };
      }
      const keep = Number.isInteger(ctx.json?.keep_recent_count) && ctx.json.keep_recent_count >= 0 && ctx.json.keep_recent_count <= 1_000 ? ctx.json.keep_recent_count : 0;
      let answer;
      try {
        answer = await /** @type {any} */ (sessions).commit(ctx.user.id, sessionId, { keepRecentCount: keep });
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "memory_index_not_found") { recordGatewayCommit("nothing_pending"); return { ...nothing, outcome: "local" }; }
        recordGatewayCommit("failed");
        throw error;
      }
      const result = answer?.result ?? {};
      if (result.status === "accepted" && typeof result.archive_uri === "string" && result.archive_uri) {
        recordGatewayCommit("accepted");
        try {
          await overlay?.recordCommit({ userId: ctx.user.id, archiveUri: result.archive_uri, engineSession: sessionId, projectId: ctx.project.id, origin: "gateway", taskId: typeof result.task_id === "string" ? result.task_id : null });
        } catch { recordLedgerFailure(); }
      } else {
        recordGatewayCommit("nothing_pending");
      }
      return { status: 200, json: answer, outcome: "forwarded" };
    },
    async search(ctx) {
      const given = ctx.json && typeof ctx.json === "object" && !Array.isArray(ctx.json) ? ctx.json : {};
      const context = given.mode === "context";
      const admitted = await ctx.admit(typeof given.session_id === "string" ? given.session_id : null);
      if (!admitted.recall) {
        recordGatewayWithheld(admitted.recallReason ?? "legacy_engine");
        return { status: 200, json: ok(context ? { entries: [], rendered: "", digest: "" } : { memories: [], resources: [], skills: [], total: 0 }), outcome: "withheld" };
      }
      if (given.target_uri !== undefined && (typeof given.target_uri !== "string" || !insideOwnSpace(given.target_uri, ctx.userRoot))) {
        throw new HttpError(403, "memory_gateway_uri_refused", "The search target is outside the caller's own space.");
      }
      const { purpose: _purpose, quotas: _quotas, peer_scope: _peerScope, ...rest } = given;
      const body = { ...rest, query_expansion: "off", exclude_uris: await ctx.excluded(Array.isArray(given.exclude_uris) ? given.exclude_uris : []) };
      // List mode searches a target; with none it would search every scope the account can see.
      if (!context && !body.target_uri) body.target_uri = `${ctx.userRoot}/memories`;
      return { status: 200, json: await /** @type {any} */ (sessions).search(ctx.user.id, body), outcome: "forwarded" };
    },
    async read(ctx) {
      const uri = String(ctx.query.get("uri") ?? "");
      if (!insideOwnSpace(uri, ctx.userRoot)) throw new HttpError(403, "memory_gateway_uri_refused", "The URI is outside the caller's own space.");
      const admitted = await ctx.admit(null);
      const missing = { status: 404, json: refusal("NOT_FOUND", "File not found."), outcome: "withheld" };
      if (!admitted.recall) { recordGatewayWithheld(admitted.recallReason ?? "legacy_engine"); return missing; }
      if (await ctx.hidden(absolute(uri, ctx.userRoot))) return { ...missing, outcome: "local" };
      const text = await /** @type {any} */ (sessions).read(ctx.user.id, uri, { timeoutMs: /** @type {any} */ (sessions).fastTimeoutMs * 2 });
      if (text === null) return { ...missing, outcome: "forwarded" };
      return { status: 200, json: ok(text), outcome: "forwarded" };
    },
    async list(ctx) {
      const uri = String(ctx.query.get("uri") ?? "");
      // `viking://user` is how the plugin discovers its user space: the answer is the caller and nobody else.
      if (uri === "viking://user") {
        return { status: 200, json: { ...ok([{ name: ctx.engineUser, size: 0, isDir: true, uri: ctx.userRoot }]), has_more: false }, outcome: "local" };
      }
      if (!insideOwnSpace(uri, ctx.userRoot)) throw new HttpError(403, "memory_gateway_uri_refused", "The URI is outside the caller's own space.");
      const admitted = await ctx.admit(null);
      const empty = { status: 200, json: { ...ok([]), has_more: false } };
      if (!admitted.recall) { recordGatewayWithheld(admitted.recallReason ?? "legacy_engine"); return { ...empty, outcome: "withheld" }; }
      if (await ctx.hidden(absolute(uri, ctx.userRoot))) return { ...empty, outcome: "local" };
      /** @type {Record<string, string>} */
      const query = {};
      for (const name of ["uri", "output", "recursive", "abs_limit", "node_limit", "offset", "limit"]) {
        const value = ctx.query.get(name);
        if (value !== null && value.length <= 600) query[name] = value;
      }
      let body;
      try {
        body = await /** @type {any} */ (sessions).client.request({ path: "/api/v1/fs/ls", userId: ctx.user.id, query, timeoutMs: /** @type {any} */ (sessions).fastTimeoutMs * 2 });
      } catch (error) {
        // A directory the engine has not made yet (it makes an account's tree at its first session) is an empty one.
        if (/** @type {any} */ (error)?.code === "memory_index_not_found") return { ...empty, outcome: "forwarded" };
        throw error;
      }
      const hiddenUris = await ctx.hiddenSet();
      const entries = (Array.isArray(body?.result) ? body.result : []).filter((/** @type {any} */ entry) => !hiddenUris.some((/** @type {string} */ prefix) => String(entry?.uri ?? "") === prefix || String(entry?.uri ?? "").startsWith(`${prefix}/`)));
      return { status: 200, json: { ...body, result: entries }, outcome: "forwarded" };
    },
    // OpenViking's skill store is not part of this product's memory: the catalogue is empty and nothing is asked upstream.
    async skills() {
      return { status: 200, json: ok({ root_uris: [], skills: [], total: 0 }), outcome: "local" };
    },
    async mcp(ctx) {
      const incoming = ctx.json;
      const list = (Array.isArray(incoming) ? incoming : [incoming]).filter((/** @type {any} */ message) => message && typeof message === "object");
      if (!list.length) throw new HttpError(400, "memory_gateway_body_invalid", "The MCP request holds no message.");
      /** @type {any[]} */ const local = [];
      /** @type {any[]} */ const forward = [];
      const toolListIds = new Set();
      /** Runs after the engine answered a forwarded tool call. @type {Map<unknown, (answer: any) => Promise<void>>} */
      const afterCall = new Map();
      let handshake = true;
      for (const message of list) {
        const method = typeof message.method === "string" ? message.method : "";
        if (method in MCP_EMPTY_LISTS) { local.push({ jsonrpc: "2.0", id: message.id ?? null, result: /** @type {any} */ (MCP_EMPTY_LISTS)[method] }); continue; }
        if (method && !MCP_FORWARDED_METHODS.has(method)) {
          if (message.id !== undefined) local.push(rpcError(message.id, -32601, `Method not available: ${method}`));
          continue;
        }
        if (method === "tools/list") { if (message.id !== undefined) toolListIds.add(message.id); forward.push(message); continue; }
        if (method !== "tools/call") { forward.push(message); continue; }
        handshake = false;
        const name = String(message.params?.name ?? "");
        const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
        if (!TOOL_NAMES.includes(name)) {
          recordGatewayRefusal("memory_gateway_tool_refused");
          local.push(rpcError(message.id, -32601, `Tool not available: ${name}`));
          continue;
        }
        const admitted = await ctx.admit(null);
        // Every URI a tool names stays inside the caller's own space: `read` takes `uris`, `list` and `forget` `uri`, `search` `target_uri`.
        const named = [args.uri, args.target_uri, ...(Array.isArray(args.uris) ? args.uris : [args.uris])].filter((value) => typeof value === "string" && value);
        if (named.some((uri) => !insideOwnSpace(uri, ctx.userRoot))) {
          recordGatewayRefusal("memory_gateway_uri_refused");
          local.push(rpcError(message.id, -32602, "The URI is outside the user's own memories."));
          continue;
        }
        if (READ_TOOLS.has(name)) {
          if (!admitted.recall) {
            recordGatewayWithheld(admitted.recallReason ?? "legacy_engine");
            local.push(toolText(message.id, /** @type {any} */ (NOT_READ)[admitted.recallReason ?? ""] ?? NOT_READ.other));
            continue;
          }
          const hiddenUris = await ctx.hiddenSet();
          const isHidden = (/** @type {string} */ uri) => { const full = absolute(uri, ctx.userRoot); return hiddenUris.some((/** @type {string} */ prefix) => full === prefix || full.startsWith(`${prefix}/`)); };
          if (name === "read") {
            const uris = (Array.isArray(args.uris) ? args.uris : [args.uris]).filter((/** @type {unknown} */ uri) => typeof uri === "string" && uri && !isHidden(uri)).slice(0, 10);
            if (!uris.length) { local.push(toolText(message.id, "没有可读取的记忆文件。")); continue; }
            forward.push({ ...message, params: { ...message.params, arguments: { uris } } });
          } else if (name === "list") {
            const uri = typeof args.uri === "string" && args.uri ? args.uri : `${ctx.userRoot}/memories`;
            if (isHidden(uri)) { local.push(toolText(message.id, "（空）")); continue; }
            forward.push({ ...message, params: { ...message.params, arguments: { uri, recursive: args.recursive === true } } });
          } else {
            const limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit)) || 5));
            const target = typeof args.target_uri === "string" && args.target_uri && !isHidden(args.target_uri) ? args.target_uri : `${ctx.userRoot}/memories`;
            forward.push({ ...message, params: { ...message.params, arguments: {
              query: String(args.query ?? "").slice(0, 2_000), limit, target_uri: target, query_expansion: "off", exclude_uris: await ctx.excluded([]),
            } } });
          }
          continue;
        }
        if (name === "remember") {
          if (!admitted.learn) {
            recordGatewayWithheld(admitted.learnReason ?? "legacy_engine");
            local.push(toolText(message.id, /** @type {any} */ (NOT_KEPT)[admitted.learnReason ?? ""] ?? NOT_KEPT.other));
            continue;
          }
          // The same door as a captured message: what the platform wrote is not something to remember.
          const kept = [];
          for (const item of (Array.isArray(args.messages) ? args.messages : []).slice(0, 6)) {
            const decision = filterCapturedMessage({ role: item?.role, content: typeof item?.content === "string" ? item.content : "" });
            if ("drop" in decision) { recordGatewayMessage(decision.drop); continue; }
            if (decision.masked) recordGatewayMasked();
            kept.push({ role: decision.forward.role, content: decision.forward.parts.map((part) => part.text).join("\n") });
          }
          if (!kept.length) { local.push(toolText(message.id, "没有可以记下的内容。")); continue; }
          await ensureRegistered(ctx.user.id);
          forward.push({ ...message, params: { ...message.params, arguments: { messages: kept } } });
          // The engine answers in prose that names the one-shot session and the task: read them into the ledger.
          afterCall.set(message.id, async (answer) => {
            const text = String(answer?.result?.content?.[0]?.text ?? "");
            const found = /session (mcp-store-[A-Za-z0-9_.@-]{1,180}), task_id=([A-Za-z0-9-]{8,64})/.exec(text);
            if (!found) return;
            recordGatewayCommit("accepted");
            try {
              await overlay?.recordCommit({ userId: ctx.user.id, archiveUri: `${ctx.userRoot}/sessions/${found[1]}/history/archive_001`, engineSession: found[1], projectId: ctx.project.id, origin: "tool", taskId: found[2] });
            } catch { recordLedgerFailure(); }
          });
          continue;
        }
        // forget: one memory file of the caller, never a directory, never the derived index or anything outside `memories/`.
        const target = absolute(String(args.uri ?? ""), ctx.userRoot);
        if (args.recursive === true || !nativeMemoryFile(target, `${ctx.userRoot}/memories`)) {
          recordGatewayRefusal("memory_gateway_uri_refused");
          local.push(rpcError(message.id, -32602, "Only one memory file of the user can be forgotten at a time."));
          continue;
        }
        if (!admitted.native || admitted.learnReason === "internal_project" || admitted.learnReason === "trial") {
          recordGatewayWithheld(admitted.learnReason ?? "legacy_engine");
          local.push(toolText(message.id, NOT_READ.other));
          continue;
        }
        if (memoryTool) {
          const outcome = await memoryTool.forget(ctx.user, ctx.project, target);
          local.push(toolText(message.id, outcome.removed ? `Deleted: ${target}` : `Not found: ${target}`));
        } else {
          forward.push({ ...message, params: { ...message.params, arguments: { uri: target } } });
        }
      }
      const batch = Array.isArray(incoming);
      if (!forward.length) {
        // Only notifications and nothing to say back: accepted, as the engine answers them.
        if (!local.length) return { status: 202, text: "", outcome: "local" };
        return { status: 200, json: batch ? local : local[0], outcome: "local" };
      }
      // The handshake of a new kernel waits on this: asked with the short deadline.
      const answer = await /** @type {any} */ (sessions).mcp(ctx.user.id, batch ? forward : forward[0], handshake ? { timeoutMs: /** @type {any} */ (sessions).fastTimeoutMs } : {});
      const stream = answer.contentType.includes("text/event-stream");
      /** @type {any[]} */
      let messages = [];
      if (answer.text.trim()) {
        try { messages = stream ? parseEventStream(answer.text) : [JSON.parse(answer.text)].flat(); }
        catch { throw new HttpError(502, "memory_gateway_upstream_invalid", "The memory service answered something that is not MCP."); }
      }
      for (const message of messages) {
        if (toolListIds.has(message?.id) && Array.isArray(message?.result?.tools)) {
          message.result.tools = message.result.tools.filter((/** @type {any} */ tool) => TOOL_NAMES.includes(tool?.name))
            .map((/** @type {any} */ tool) => ({ name: tool.name, ...MEMORY_GATEWAY_TOOLS[/** @type {keyof typeof MEMORY_GATEWAY_TOOLS} */ (tool.name)] }));
        }
        const after = afterCall.get(message?.id);
        if (after) await after(message).catch(() => {});
      }
      const all = [...messages, ...local];
      if (!all.length) return { status: answer.status, text: answer.text, contentType: answer.contentType || "application/json", outcome: "forwarded" };
      if (stream) return { status: answer.status, text: all.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""), contentType: "text/event-stream", outcome: "forwarded" };
      return { status: answer.status, json: batch ? all : all[0], outcome: "forwarded" };
    },
    // The engine keeps no MCP session (it sends no `Mcp-Session-Id`): there is nothing to close.
    async mcpClose() {
      return { status: 200, text: "", outcome: "local" };
    },
  };

  return async (req, res, onFailure) => {
    let route = "unknown";
    const send = (/** @type {{ status: number, json?: unknown, text?: string, contentType?: string }} */ answer) => {
      const body = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? "");
      res.writeHead(answer.status, { "Content-Type": answer.contentType ?? "application/json", "Cache-Control": "no-store" });
      res.end(body);
    };
    try {
      const url = new URL(req.url, "http://evimed.local");
      const rest = url.pathname.slice(MEMORY_GATEWAY_PATH.length);
      const found = ROUTES.map(([method, pattern, name]) => ({ method, match: /** @type {RegExp} */ (pattern).exec(rest), name }))
        .find((candidate) => candidate.method === req.method && candidate.match);
      route = found ? String(found.name) : "unknown";
      if (!enabled) throw new HttpError(404, "memory_gateway_disabled", "The memory gateway is not available in this deployment.");
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      /** @type {{ userId: string, projectId: string }} */
      let identity;
      try { identity = await runtimeManager.assertActiveEviMedWorkloadToken(token); }
      catch { throw new HttpError(401, "memory_gateway_unauthenticated", "The memory gateway does not know this caller."); }
      // A caller cannot assert a role, and the identity headers it sends are never read.
      if (req.headers["x-openviking-role"] !== undefined) throw new HttpError(403, "memory_gateway_role_refused", "A caller cannot assert a role.");
      if (!found) throw new HttpError(404, "memory_gateway_route_refused", `${req.method} is not a memory gateway route here.`);
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "memory_gateway_unauthenticated", "The memory gateway does not know this caller.");
      const project = await store.requireProject(user, identity.projectId);
      if (overLimit(requestWindows, JSON.stringify([identity.userId, identity.projectId]), 60_000, ratePerMinute)) {
        throw new HttpError(429, "memory_gateway_rate_limited", "Too many memory requests.");
      }
      const raw = req.method === "GET" || req.method === "DELETE" ? Buffer.alloc(0) : await readBody(req);
      let json;
      if (raw.length) {
        try { json = JSON.parse(raw.toString("utf8")); }
        catch { throw new HttpError(400, "memory_gateway_body_invalid", "The request body is not JSON."); }
      }
      // Body streaming may outlive a runtime stop, a rotation or an account's removal.
      if (raw.length) await runtimeManager.assertActiveEviMedWorkloadToken(token).catch(() => { throw new HttpError(401, "memory_gateway_unauthenticated", "The memory gateway does not know this caller."); });
      const engineUser = /** @type {any} */ (sessions).engineUser(user.id);
      const userRoot = /** @type {any} */ (sessions).userRoot(user.id);
      /** One decision per conversation per request. @type {Map<string, Promise<import("./memoryAdmission.mjs").MemoryAdmission>>} */
      const admissions = new Map();
      /** @type {Promise<string[]> | null} */
      let hiddenList = null;
      const ctx = {
        user, project, json, query: url.searchParams, match: found.match, engineUser, userRoot, account: /** @type {any} */ (sessions).client.account,
        admit: (/** @type {string | null} */ engineSessionId) => {
          const key = engineSessionId ?? "";
          if (!admissions.has(key)) admissions.set(key, admission.admit({ user, project, engineSessionId }));
          return /** @type {Promise<import("./memoryAdmission.mjs").MemoryAdmission>} */ (admissions.get(key));
        },
        // What recall never reads: the derived index subtree and the files the person marked sensitive.
        hiddenSet: () => {
          hiddenList ??= (async () => [`${userRoot}/memories/${DERIVED_INDEX_SEGMENT}`, ...(overlay?.configured ? await overlay.sensitiveUris(user.id).catch(() => []) : [])])();
          return hiddenList;
        },
        hidden: async (/** @type {string} */ uri) => (await ctx.hiddenSet()).some((prefix) => uri === prefix || uri.startsWith(`${prefix}/`)),
        // `exclude_uris` of a search: the account-shared areas hold nothing of this user's and their scaffolding ranks as hits.
        excluded: async (/** @type {unknown[]} */ given) => [...new Set([
          ...given.filter((uri) => typeof uri === "string" && uri.length <= 600), "viking://resources", "viking://agent", ...(await ctx.hiddenSet()),
        ])].slice(0, 200),
      };
      const answer = await handlers[route](ctx);
      recordGatewayRequest(route, answer.outcome);
      send(answer);
    } catch (error) {
      const own = error instanceof HttpError && /^memory_gateway_/.test(error.code);
      if (own) {
        recordGatewayRefusal(/** @type {HttpError} */ (error).code);
        recordGatewayRequest(route, "refused");
        onFailure?.({ code: /** @type {HttpError} */ (error).code, status: /** @type {HttpError} */ (error).status });
        if (!res.headersSent) send({ status: /** @type {HttpError} */ (error).status, json: refusal(/** @type {HttpError} */ (error).code, /** @type {HttpError} */ (error).message) });
        return;
      }
      const code = error instanceof HttpError ? error.code : "";
      if (/^(?:memory_index_|openviking_)/.test(code)) {
        const failure = upstreamFailure(error);
        recordGatewayRequest(route, failure.outcome);
        if (failure.failure) onFailure?.({ code: failure.failure, status: failure.status });
        if (!res.headersSent) send(failure);
        return;
      }
      // Not the engine's and not this gateway's: the project is gone, a store could not be read, or a defect here.
      const status = error instanceof HttpError ? error.status : 502;
      recordGatewayRequest(route, "failed");
      onFailure?.({ code: code || "memory_gateway_failed", status });
      if (!res.headersSent) send({ status, json: refusal(code || "memory_gateway_failed", "The memory gateway could not answer.") });
    }
  };
}
