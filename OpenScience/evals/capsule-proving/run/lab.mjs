import { createForgetRequestJudge } from '../../../apps/server/src/nativeMemoryForgetRequests.mjs';
// The product's memory stack, in process, against the lab engine and the lab PostgreSQL: the engine-layer half of the
// capsule proving runner (contract "Lab surface").
//
// Everything that decides what is learned and what the model is handed is the product's own code from this checkout:
// the memory gateway (`createMemoryGatewayHandler`, served on a loopback HTTP server exactly as the plugin's bridge
// reaches it), its door (`filterCapturedMessage`), its project line, its commit ledger, the real admission, the overlay,
// the settings store, the research-memory store, the worker that settles commits (line origins, refused lines, raw
// history), the history index, the consolidation and the resident profile. What the runner supplies is only what a
// deployment would get from parts that do not exist here:
//  - a runtime manager that maps a per-(user, project) bearer to `{ userId, projectId }` (the workload token);
//  - a store that reads users and projects from `evimed_control` (the product's store also creates project directories);
//  - the source of a conversation for raw history (`resolveSource`): the dataset's session stands in for the run ledger,
//    the commit ledger's session binding is the proof (production also requires agent-run rows, which a lab has none of);
//  - the namespace policies (every project is an ordinary owned one; no shared GEO project exists here).
//
// Recorded deviations from production: one commit per session by default (`commitEvery: "turn"` commits after every
// user turn, as production's attended-turn commits do); engine calls get `engineTimeoutMs` (30 s) where production gives
// the gateway's 4 s; consolidation never runs by itself (`consolidate()`); no capsule half in search (no capsule facts
// exist in a lab account); the conversation title of a history excerpt is the session's first user message; a message the
// product writes without a time (the project line, a promoted choice) is given the conversation's time (`LabClockSessions`).
//
// Keys, the database URL and bearers are read from files or minted here and never logged: every message that leaves this
// module goes through `redact`, and only the first line of an error is ever printed.
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { ControlPlaneDatabase } from "../../../apps/server/src/controlPlaneDatabase.mjs";
import { GeoNativeMemoryContext } from "../../../apps/server/src/geoNativeMemoryContext.mjs";
import { createMemoryAdmission } from "../../../apps/server/src/memoryAdmission.mjs";
import { MEMORY_GATEWAY_PATH, MEMORY_GATEWAY_TOOLS, createMemoryGatewayHandler, filterCapturedMessage, parseEventStream } from "../../../apps/server/src/memoryGateway.mjs";
import { MemoryHistory, MemoryHistoryLedger, historyTitle } from "../../../apps/server/src/memoryHistory.mjs";
import { MemorySettingsStore } from "../../../apps/server/src/memorySettings.mjs";
import { migrateMemorySettings } from "../../../apps/server/src/memorySettingsPersistence.mjs";
import { defaultDeepSeekModel } from "../../../apps/server/src/modelGateway.mjs";
import { NativeMemoryConsolidation } from "../../../apps/server/src/nativeMemoryConsolidation.mjs";
import { nativeMemoryCounters } from "../../../apps/server/src/nativeMemoryMetrics.mjs";
import { NativeMemoryOverlay } from "../../../apps/server/src/nativeMemoryOverlay.mjs";
import { createRejectionJudge } from "../../../apps/server/src/nativeMemoryRejections.mjs";
import { createPastedInstructionJudge } from "../../../apps/server/src/nativeMemoryPastedInstructions.mjs";
import { NativeMemoryStore } from "../../../apps/server/src/nativeMemoryStore.mjs";
import { NativeMemoryWorker } from "../../../apps/server/src/nativeMemoryWorker.mjs";
import { withNativeMemoryWrite } from "../../../apps/server/src/nativeMemoryWriteFence.mjs";
import { OpenVikingClient } from "../../../apps/server/src/openVikingClient.mjs";
import { OPENVIKING_MEMORY_TYPES } from "../../../apps/server/src/openVikingLayout.mjs";
import { OpenVikingResources } from "../../../apps/server/src/openVikingResources.mjs";
import { OpenVikingSessions, observationFile, platformSessionOf } from "../../../apps/server/src/openVikingSessions.mjs";
import { ResidentProfiles } from "../../../apps/server/src/residentProfile.mjs";
import { DEFAULT_PROJECT_NAME } from "../../../apps/server/src/store.mjs";
import { projectContextLine } from "../../../packages/domain/index.mjs";

/** The catch-all project of every account (`residentProfile.mjs`, `memoryGateway.mjs` name it the same). */
export const DEFAULT_PROJECT_ID = "default";
/** The tools that change memory: `memory.callTool` refuses them unless the memory object was opened with `readOnly: false`. */
const WRITE_TOOLS = new Set(["remember", "forget"]);
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoOk = (/** @type {unknown} */ value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// ------------------------------------------------------------------------------------------------------------- helpers

/**
 * A text with every secret and anything shaped like a database URL replaced.
 * @param {unknown} text @param {readonly (string | null | undefined)[]} [secrets]
 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\bBearer\s+\S+/g, "Bearer [redacted]");
}

/** The first line of an error, code first, redacted. @param {unknown} error @param {readonly (string | null | undefined)[]} [secrets] */
export function firstLine(error, secrets = []) {
  const err = /** @type {any} */ (error);
  const code = typeof err?.code === "string" && err.code ? err.code : "";
  const message = String(err?.message ?? err ?? "").split("\n")[0];
  return redact(code && !message.startsWith(code) ? `${code}: ${message}` : message || code || "error", secrets).slice(0, 300);
}

/** @param {string} value */
const safeToken = (value) => String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
const shortHash = (/** @type {string} */ value) => createHash("sha256").update(value).digest("hex").slice(0, 10);

/**
 * The engine session of one dataset session: `dsh-<runId>-<userKey>-<sessionId>`. The `dsh-` prefix is what raw history
 * indexes (`platformSessionOf`); the rest is held to the plugin's own alphabet and length.
 * @param {string} runId @param {string} userKey @param {string} sessionId
 */
export function engineSessionId(runId, userKey, sessionId) {
  let id = safeToken(`${runId}-${userKey}-${sessionId}`);
  if (id.length > 160) id = `${id.slice(0, 149)}-${shortHash(id)}`;
  const engine = `dsh-${id}`;
  if (!platformSessionOf(engine)) throw new Error("the engine session id is outside the plugin's alphabet");
  return engine;
}

/** The control-plane user of one dataset user in one run. @param {string} runId @param {string} userKey */
export function controlUserId(runId, userKey) {
  const id = safeToken(`evlab_${runId}_${userKey}`);
  return id.length > 120 ? `${id.slice(0, 109)}_${shortHash(id)}` : id;
}

/** The prefix of every control-plane user of one run. @param {string} runId */
export function controlUserPrefix(runId) {
  return safeToken(`evlab_${runId}_`);
}

/**
 * When each message of a session was spoken: its own `at`, else the session's `at` plus one second per message index.
 * @param {{ at: string, messages: { at?: string }[] }} session @returns {string[]}
 */
export function messageTimes(session) {
  const base = Date.parse(session.at);
  if (!Number.isFinite(base)) throw new Error("a session needs an ISO time");
  return session.messages.map((message, index) => (isoOk(message.at) ? new Date(/** @type {string} */ (message.at)).toISOString() : new Date(base + index * 1_000).toISOString()));
}

/** The message as the plugin posts it (`capture.mjs`): text parts and the time. @param {{ role: string, text: string }} message @param {string} createdAt */
export function capturedBody(message, createdAt) {
  return { role: message.role, parts: [{ type: "text", text: String(message.text ?? "") }], created_at: createdAt };
}

/**
 * The turns of a conversation as `[start, end)` message ranges: a turn starts at a user message and runs to the next one;
 * messages before the first user message belong to the first turn.
 * @param {{ role: string }[]} messages @returns {[number, number][]}
 */
export function splitTurns(messages) {
  const firstUser = messages.findIndex((message) => message.role === "user");
  const starts = [];
  messages.forEach((message, index) => { if (message.role === "user" && index > firstUser) starts.push(index); });
  const ranges = [];
  let start = 0;
  for (const next of starts) { if (next > start) ranges.push(/** @type {[number, number]} */ ([start, next])); start = next; }
  if (start < messages.length) ranges.push(/** @type {[number, number]} */ ([start, messages.length]));
  return ranges;
}

/**
 * The relative path of a memory file a snapshot keeps, or null: `.md`, no dot segment, not `identity.md`/`soul.md`
 * (the filter of `run_native_eval.mjs`'s `readMemoryFiles`).
 * @param {string} uri @param {string} root
 */
export function memoryFileRel(uri, root) {
  if (!uri.startsWith(`${root}/`)) return null;
  const rel = uri.slice(root.length + 1);
  if (!rel.endsWith(".md") || rel.split("/").some((segment) => segment.startsWith(".")) || /^(identity|soul)\.md$/.test(rel)) return null;
  return rel;
}

/**
 * What one extraction diff did: operations on memory files, and the observation notes apart (as `run_native_eval` counts).
 * @param {any} diff @param {string} root
 */
export function countDiffOperations(diff, root) {
  const counts = { adds: 0, updates: 0, deletes: 0, observations: 0 };
  if (!diff?.operations) {
    counts.adds = Number(diff?.summary?.total_adds) || 0;
    counts.updates = Number(diff?.summary?.total_updates) || 0;
    counts.deletes = Number(diff?.summary?.total_deletes) || 0;
    return counts;
  }
  for (const list of /** @type {const} */ (["adds", "updates", "deletes"])) {
    for (const operation of Array.isArray(diff.operations[list]) ? diff.operations[list] : []) {
      if (observationFile(String(operation?.uri ?? ""), root)) counts.observations += 1; else counts[list] += 1;
    }
  }
  return counts;
}

/** The extraction's model tokens from a commit task (`token_usage.llm`). @param {any} task */
export function taskUsage(task) {
  const llm = task?.result?.token_usage?.llm ?? {};
  return { promptTokens: Number(llm.prompt_tokens) || 0, completionTokens: Number(llm.completion_tokens) || 0, cachedTokens: Number(llm.cached_tokens) || 0 };
}

/**
 * The engine tokens of each commit of one session: the engine's `token_usage` is cumulative over a session (measured on the lab
 * engine: a session's second commit reported its first commit's tokens plus its own), so each commit is the difference from the one
 * before, and the session's total is the last commit's figure.
 * @param {any[]} tasks the session's commit tasks, oldest first (null for a commit without a task)
 */
export function sessionUsage(tasks) {
  const zero = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  let previous = zero;
  const perCommit = tasks.map((task) => {
    if (!task) return { ...zero };
    const current = taskUsage(task);
    const delta = { promptTokens: Math.max(0, current.promptTokens - previous.promptTokens), completionTokens: Math.max(0, current.completionTokens - previous.completionTokens),
      cachedTokens: Math.max(0, current.cachedTokens - previous.cachedTokens) };
    if (current.promptTokens >= previous.promptTokens) previous = current;
    return delta;
  });
  return { perCommit, total: { ...previous } };
}

/**
 * The engine client the lab hands every product piece: the product's `OpenVikingSessions`, except that a message written without a
 * time (the gateway's project line, a promoted repeated choice) is given the time of the conversation the account is in. In
 * production those writes happen at that very moment, so the engine's wall clock is the conversation's; in a lab replaying a dataset
 * months later the wall clock is not, and the engine dated what it extracted by it (measured: a project card dated the day of the
 * run instead of the conversation's day).
 */
export class LabClockSessions extends OpenVikingSessions {
  /** @param {any} client @param {any} options @param {Map<string, string>} clock control-plane user id → ISO time of the conversation now being written */
  constructor(client, options, clock) {
    super(client, options);
    this.clock = clock;
  }

  /** @param {string} userId @param {string} sessionId @param {any} message @param {{ timeoutMs?: number }} [options] */
  addMessage(userId, sessionId, message, options) {
    const at = this.clock.get(userId);
    const stamped = at && message && typeof message === "object" && !Array.isArray(message) && typeof message.created_at !== "string" ? { ...message, created_at: at } : message;
    return super.addMessage(userId, sessionId, stamped, options);
  }
}

/** The five tools as `[{ name, description, inputSchema }]`, the product's own text and schemas. */
export function memoryTools() {
  return Object.entries(MEMORY_GATEWAY_TOOLS).map(([name, tool]) => ({ name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) }));
}

/**
 * A gateway answer to one `tools/call` as text blocks. JSON-RPC errors and gateway refusals become one error block.
 * @param {{ status: number, contentType: string, text: string }} response @param {unknown} id
 * @returns {{ blocks: string[], isError: boolean }}
 */
export function toolAnswer({ status, contentType, text }, id) {
  /** @type {any[]} */
  let messages = [];
  try {
    messages = /event-stream/i.test(contentType) ? parseEventStream(text) : String(text ?? "").trim() ? [JSON.parse(text)].flat() : [];
  } catch {
    return { blocks: [`memory_gateway_invalid: the gateway answered something that is not JSON (HTTP ${status})`], isError: true };
  }
  if (status >= 400) {
    const body = messages[0];
    const code = typeof body?.error?.code === "string" ? body.error.code : `http_${status}`;
    return { blocks: [`${code}: ${String(body?.error?.message ?? "the memory gateway refused the call")}`], isError: true };
  }
  const message = messages.find((item) => item?.id === id) ?? messages[0];
  if (!message) return { blocks: [], isError: true };
  if (message.error) return { blocks: [String(message.error.message ?? "error")], isError: true };
  const content = Array.isArray(message.result?.content) ? message.result.content : [];
  return { blocks: content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text), isError: message.result?.isError === true };
}

/**
 * The model-facing half of the lab surface over one bearer: `tools`, `callTool` (real JSON-RPC `tools/call` to the
 * gateway's `/mcp`) and `fetchJSON` (the gateway's REST routes, answering as the plugin's own `createOvHttp` does:
 * `{ ok, status, result, error }`, never throwing).
 * @param {{ base: string, token: string, readOnly?: boolean, executeForget?: boolean, ready?: Promise<unknown> | null, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createMemoryClient({ base, token, readOnly = true, executeForget = false, ready = null, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  let rpcId = 0;
  const auth = { authorization: `Bearer ${token}` };
  return {
    tools: memoryTools(),
    executeForget,
    /** @param {string} name @param {Record<string, any>} [args] @returns {Promise<{ blocks: string[], isError: boolean }>} */
    async callTool(name, args = {}) {
      if (readOnly && WRITE_TOOLS.has(name) && !(name === "forget" && executeForget)) return { blocks: [`lab_read_only: ${name} is not executed by this memory object`], isError: true };
      await ready;
      const id = ++rpcId;
      try {
        const response = await fetchImpl(`${base}/mcp`, {
          method: "POST", signal: AbortSignal.timeout(timeoutMs),
          headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args && typeof args === "object" ? args : {} } }),
        });
        return toolAnswer({ status: response.status, contentType: response.headers.get("content-type") ?? "", text: await response.text() }, id);
      } catch (error) {
        return { blocks: [`lab_gateway_unreachable: ${firstLine(error, [token])}`], isError: true };
      }
    },
    /** @param {string} path @param {RequestInit & { headers?: Record<string, string> }} [init] @param {{ timeoutMs?: number }} [options] */
    async fetchJSON(path, init = {}, options = {}) {
      await ready;
      try {
        const response = await fetchImpl(`${base}${path}`, {
          ...init, signal: AbortSignal.timeout(Math.max(1_000, Number(options.timeoutMs) || timeoutMs)),
          headers: { "Content-Type": "application/json", ...(init.headers ?? {}), ...auth },
        });
        const body = await response.json().catch(() => null);
        const contentType = response.headers.get("content-type") ?? "";
        if (body === null && response.ok && contentType && !/json/i.test(contentType)) {
          return { ok: false, status: response.status, result: null, error: { message: `non-JSON response (${contentType})` } };
        }
        if (!response.ok || body?.status === "error") {
          return { ok: false, status: response.status, result: null, error: body?.error || { message: `HTTP ${response.status}` } };
        }
        return { ok: true, status: response.status, result: body?.result ?? body ?? {} };
      } catch (error) {
        return { ok: false, status: 0, result: null, error: { message: firstLine(error, [token]) } };
      }
    },
  };
}

/**
 * The gateway handler served on a loopback port, as the plugin's bridge reaches it. `base` ends in `/internal/memory/v1`.
 * @param {(req: any, res: any) => Promise<void>} handler
 */
export async function startGatewayServer(handler) {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    base: `http://127.0.0.1:${address.port}${MEMORY_GATEWAY_PATH}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}

/** One gateway per answer configuration; every handler receives the same engine, overlay and identities.
 * @param {any} shared @param {Record<string, any>} config @param {{name: string, config: Record<string, any>}[]} variants
 */
export async function startLabGateways(shared, config, variants = []) {
  const gateways = new Map();
  try {
    for (const entry of [{ name: "", config: {} }, ...variants]) {
      const merged = { ...config, ...entry.config };
      const handler = createMemoryGatewayHandler({ ...shared, config: merged,
        ...(shared.historySearchFor ? { historySearch:shared.historySearchFor(merged) } : {}),
        admission: entry.name && shared.admissionFor ? shared.admissionFor(merged) : shared.admission });
      gateways.set(entry.name, { ...await startGatewayServer(handler), handler, config: merged });
    }
  } catch (error) {
    await Promise.all([...gateways.values()].map((gateway) => gateway.close()));
    throw error;
  }
  return { gateways, close: async () => { await Promise.all([...gateways.values()].map((gateway) => gateway.close())); } };
}

/** The same resident providers as the product composition root; the store owns scope/privacy filtering.
 * @param {{config: any, memorySettings: any, nativeMemory: any}} parts
 */
export function createLabResidentProfiles({ config, memorySettings, nativeMemory }) {
  return new ResidentProfiles({
    config, store: memorySettings, capsules: null,
    projectCard: (userId, projectId) => nativeMemory.residentCard(userId, projectId),
    nativeFiles: (userId, projectId, limit) => nativeMemory.openingFiles(userId, projectId, limit),
    nativeIndex: (userId, projectId) => nativeMemory.openingIndex(userId, projectId),
    safetyNotes: (userId, projectId) => nativeMemory.safetyNotes(userId, projectId),
  });
}

/** Advance the product's asynchronous explicit entry; retain every product result without translating it.
 * @param {any} consolidation @param {string} userId
 * @param {{mode?: string, pollMs?: number, timeoutMs?: number}} [options]
 */
export async function pollLabConsolidation(consolidation, userId, { mode = "merge", pollMs = 3_000, timeoutMs = 1_800_000 } = {}) {
  const started = Date.now();
  const results = [];
  let outcome;
  do {
    if (results.length) await sleep(pollMs);
    const result = await consolidation.consolidate(userId, { mode, force: true });
    results.push(result);
    outcome = typeof result === "string" ? result : result?.outcome;
  } while (outcome === "submitted" && Date.now() - started < timeoutMs);
  return { outcome, results };
}

/** Feature-detect the product method so older checkouts remain usable.
 * @param {any} consolidation @param {string} userId @param {any} [options]
 */
export async function verifyLabExisting(consolidation, userId, options = {}) {
  const method = /** @type {any} */ (NativeMemoryConsolidation.prototype).verifyExisting;
  if (typeof method !== "function") throw Object.assign(new Error("verify_unavailable: this checkout has no existing-line verification"), { code: "verify_unavailable" });
  return method.call(consolidation, userId, options);
}

/** Plant into both representations, retaining the original source revisions for verification.
 * @param {any} parts @param {LabUser} user @param {string} rel @param {string} text
 */
export async function replaceLabFile({ sessions, overlay }, user, rel, text) {
  if (!rel.endsWith(".md") || rel.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("a memory file path under memories/ ending in .md");
  const uri = `${sessions.memoryRoot(user.userId)}/${rel}`;
  return withNativeMemoryWrite(overlay.database, user.userId, async () => {
    const held = await overlay.file(user.userId, uri);
    const before = await sessions.read(user.userId, uri);
    const memoryType = held?.memoryType ?? rel.split("/")[0].replace(/\.md$/, "");
    await sessions.replace(user.userId, uri, text);
    // Consolidation reads engine bytes; product verification and page reads can read overlay.body instead.
    // Like a product edit, refresh the cached body/hash and record the revision. Do not reject the true
    // line as a user's deletion: this is an injected defect, and its original evidence must remain usable.
    await overlay.addRevision({ userId: user.userId, uri, memoryType, change: "updated", actor: "platform",
      reason: "eval_corruption", before, after: text, projectId: held?.projectId ?? null });
    await overlay.upsertFile({ userId: user.userId, uri, memoryType, body: text });
    return { uri, rel };
  });
}

/** @param {string} file */
async function secretFrom(file) {
  if (!file) return "";
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error("a secret file is empty");
  return value;
}

// ---------------------------------------------------------------------------------------------------------------- lab

/**
 * @typedef {{ userId: string, userKey: string, engineUser: string }} LabUser
 * @typedef {{ sessionId: string, at: string, project?: { id: string, name: string } | null, messages: { role: string, text: string, at?: string }[], attachments?: any[] }} LabSession
 */

/** Run the product's per-user settlement work without its account scheduler or consolidation.
 * A completed engine task can still owe summary cleanup and overlay/history ingestion. Never advance past it.
 * @param {{worker: any, overlay: any, userId: string, deadline: number, waitTask: Function, pollMs?: number}} input
 */
export async function settleLabCommits({ worker, overlay, userId, deadline, waitTask, pollMs = 2_000 }) {
  let settled = 0;
  let rounds = 0;
  const transient = new Set(["memory_index_conflict", "memory_index_timeout", "memory_engine_unavailable", "memory_summary_rebuild_failed"]);
  for (;;) {
    rounds += 1;
    try { await worker.drainSummaryInvalidations(userId); }
    catch (error) {
      if (!transient.has(error?.code) || Date.now() >= deadline) throw error;
      await sleep(pollMs);
      continue;
    }
    settled += await worker.processCommits({ userId, limit: 50 });
    const open = await overlay.openCommits({ userId, limit: 50 });
    if (!open.length) return { settled, rounds, open: 0 };
    if (Date.now() >= deadline) throw Object.assign(new Error(`Product commits remain unsettled: ${open.length}`), { code: "lab_unsettled_commits" });
    for (const commit of open.filter(commit => commit.state === "pending" && commit.taskId)) {
      await waitTask(userId, commit.taskId, deadline);
    }
    // A completed task may still have a writer lease or a retryable cleanup conflict. The hosted worker tries on
    // its next pass; poll within the session's deadline rather than spinning eight times and advancing anyway.
    await sleep(pollMs);
  }
}

/**
 * Open the lab: the product's memory stack against the lab engine and PostgreSQL.
 * @param {{ engineUrl: string, engineKeyFile: string, account: string, databaseUrlFile: string, historySearch?: boolean, deepseekKeyFile?: string | null,
 *   now?: (() => Date) | null, runId?: string | null, commitEvery?: "session" | "turn", extractionTimeoutMs?: number, pollMs?: number,
 *   stockEngine?: boolean, configOverrides?: Record<string, any>, answerVariants?: {name: string, config: Record<string, any>}[], rejectionJudge?: boolean,
 *   gatewayTimeoutMs?: number, residentCardTimeoutMs?: number, engineTimeoutMs?: number, databasePoolMax?: number, report?: (line: string) => void }} options
 */
export async function openLab({
  engineUrl, engineKeyFile, account, databaseUrlFile, historySearch = true, deepseekKeyFile = null, now = null, runId = null,
  commitEvery = "session", extractionTimeoutMs = 300_000, pollMs = 2_000, gatewayTimeoutMs = 4_000, residentCardTimeoutMs = 1_500,
  configOverrides = {}, answerVariants = [], rejectionJudge = true, stockEngine = false,
  engineTimeoutMs = 30_000, databasePoolMax = 8, report = (line) => process.stderr.write(`${line}\n`),
}) {
  if (typeof account !== "string" || !/^evlab-[A-Za-z0-9_-]{1,100}$/.test(account)) throw new Error("the lab engine account is evlab-<runId>");
  const run = runId ?? account.slice("evlab-".length);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(run)) throw new Error("a run id is 1-64 of [A-Za-z0-9_-]");
  if (!["session", "turn"].includes(commitEvery)) throw new Error("commitEvery is session or turn");
  const engineKey = await secretFrom(engineKeyFile);
  const databaseUrl = await secretFrom(databaseUrlFile);
  const deepseekKey = deepseekKeyFile ? await secretFrom(deepseekKeyFile) : "";
  let databasePassword = "";
  try { databasePassword = decodeURIComponent(new URL(databaseUrl).password); } catch { /* not a URL: redacted whole */ }
  const secrets = [engineKey, databaseUrl, deepseekKey, databasePassword];
  /** @type {Set<string>} */
  const bearers = new Set();
  const scrub = (/** @type {unknown} */ text) => redact(text, [...secrets, ...bearers]);
  const say = (/** @type {string} */ line) => report(scrub(line).split("\n")[0]);
  const errorLine = (/** @type {unknown} */ error) => firstLine(error, [...secrets, ...bearers]);

  const config = {
    memoryEngineEnabled: true, memoryEnabled: true, memoryRecallEnabled: true,
    memoryHistorySearchEnabled: historySearch === true,
    memoryGatewayCommitsPerHour: 0, memoryGatewayRatePerMinute: 1_000_000, memoryGatewayMaxBodyBytes: 1_048_576, memoryGatewayTimeoutMs: gatewayTimeoutMs,
    memoryContextLimit: 8, memoryContextMaxChars: 20_000, memoryProfileMaxRecords: 24, memoryResidentCardTimeoutMs: residentCardTimeoutMs,
    nativeMemoryReplayAttempts: 5, nativeMemoryConsolidationEnabled: true, nativeMemoryConsolidationIntervalDays: 7,
    nativeMemoryRejectionJudgeEnabled: Boolean(deepseekKey), nativeMemoryRejectionJudgeDailyCalls: 40,
    deepseekProviderEnabled: Boolean(deepseekKey), deepseekApiKey: deepseekKey, deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: defaultDeepSeekModel, memoryExtractionModel: defaultDeepSeekModel, memoryExtractionTimeoutMs: 30_000, production: false,
    ...configOverrides,
    ...(rejectionJudge ? {} : { nativeMemoryRejectionJudgeEnabled: false }),
  };

  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax, databaseConnectionTimeoutMs: 10_000 });
  /** @type {{ close: () => Promise<unknown> } | null} */
  let server = null;
  try {
    await database.query("SELECT 1");
    await migrateMemorySettings(database);
    const overlay = new NativeMemoryOverlay({ database });
    await overlay.migrate();
    const client = new OpenVikingClient({ openVikingUrl: engineUrl, openVikingApiKey: engineKey, openVikingAccount: account, openVikingRequestTimeoutMs: engineTimeoutMs });
    client.writeAdmission = (userId, operation) => withNativeMemoryWrite(database, userId, operation);
    /** The conversation time each account is at, for writes the product makes without one (`LabClockSessions`). @type {Map<string, string>} */
    const conversationClock = new Map();
    const sessions = new LabClockSessions(client, { timeoutMs: engineTimeoutMs, fastTimeoutMs: Math.max(1_000, Math.round(engineTimeoutMs / 3)) }, conversationClock);
    const health = await sessions.health();
    if (!health.healthy) throw new Error(`the lab engine is not healthy (${health.status})`);
    // A run's own engine account (production's single account exists from `ov.conf`); 409 is an account an earlier attempt made.
    // The engine wants an admin user for a new account: a placeholder that never holds memory.
    try { await client.request({ method: "POST", path: "/api/v1/admin/accounts", body: { account_id: account, admin_user_id: "evlab-admin" } }); }
    catch (error) { if (Number(/** @type {any} */ (error)?.upstreamStatus) !== 409) throw error; }
    const memorySettings = new MemorySettingsStore(config, { database });
    const admission = createMemoryAdmission({ config, memorySettings });
    const contexts = new GeoNativeMemoryContext({
      database, documents: null, sessions, proveCapture: null, settingsForOwner: (userId) => memorySettings.settings(userId),
      // Every project of a lab account is an ordinary owned one: no shared GEO namespace exists here.
      policies: { forProject: async () => ({ kind: "owned" }), policiesForOwner: async () => [], read: () => { throw new Error("no shared namespace in the lab"); } },
    });
    const productRejectionJudge = createRejectionJudge({ config: rejectionJudge ? config : { ...config, deepseekApiKey: "", nativeMemoryRejectionJudgeEnabled: false } });
    const nativeMemory = new NativeMemoryStore({ sessions, overlay, memoryContexts: contexts, rejectionJudge: productRejectionJudge, ...(now ? { now } : {}), report: say });
    const worker = new NativeMemoryWorker({ config, memorySettings, sessions, overlay, nativeMemory, memoryContexts: contexts, rejectionJudge: productRejectionJudge,
      forgetRequestJudge: createForgetRequestJudge({ config }),
      pastedInstructionJudge: createPastedInstructionJudge({ config }), now, report: say });
    const resources = new OpenVikingResources({ client });
    const profilesFor = (selectedConfig) => createLabResidentProfiles({ config: selectedConfig, memorySettings, nativeMemory });
    const residentProfiles = profilesFor(config);

    /** @param {string} userId @param {string} projectId */
    const projectRow = async (userId, projectId) => {
      const row = (await database.query(`SELECT p.id, p.name, u.created_at::text AS account_created_at, p.created_at::text AS project_created_at
          FROM evimed_control.projects p JOIN evimed_control.users u ON u.id=p.user_id WHERE p.user_id=$1 AND p.id=$2`, [userId, projectId])).rows[0];
      return row ? { id: String(row.id), name: String(row.name), userId, tenantId: userId, accountCreatedAt: row.account_created_at, projectCreatedAt: row.project_created_at } : null;
    };
    const store = {
      /** @param {string} id */
      userById: async (id) => {
        const row = (await database.query("SELECT id, name FROM evimed_control.users WHERE id=$1", [id])).rows[0];
        return row ? { id: String(row.id), name: String(row.name), tenantId: String(row.id) } : null;
      },
      /** @param {any} user @param {string} projectId */
      requireProject: async (user, projectId = DEFAULT_PROJECT_ID) => {
        const project = await projectRow(user.id, projectId);
        if (!project) throw Object.assign(new Error("Project not found."), { status: 404, code: "project_not_found" });
        return project;
      },
    };
    /** @type {Map<string, Promise<void>>} */
    const projectsMade = new Map();
    /** A project row, made the way the product's store makes one (`projectFor`). @param {string} userId @param {{ id: string, name: string } | null | undefined} project */
    const ensureProject = (userId, project) => {
      const id = project?.id && project.id !== DEFAULT_PROJECT_ID ? project.id : DEFAULT_PROJECT_ID;
      const key = `${userId}\u0000${id}`;
      if (!projectsMade.has(key)) {
        const made = database.query(`INSERT INTO evimed_control.projects(user_id, id, name, quota_bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, id) DO NOTHING`,
          [userId, id, id === DEFAULT_PROJECT_ID ? DEFAULT_PROJECT_NAME : String(project?.name ?? id).slice(0, 200), 10 * 1024 ** 3]).then(() => undefined);
        made.catch(() => projectsMade.delete(key));
        projectsMade.set(key, made);
      }
      return /** @type {Promise<void>} */ (projectsMade.get(key));
    };

    /** Conversation metadata for raw history, by `${userId}\0${engineSession}`. @type {Map<string, { title: string, at: string }>} */
    const conversations = new Map();
    const history = new MemoryHistory({
      config, ledger: new MemoryHistoryLedger({ database, overlay, client }), contexts,
      resolveSource: async (commit, memoryContext) => {
        if (memoryContext?.kind !== "owned") return null;
        const ownerId = memoryContext.ownerId;
        const projectId = commit.projectId ?? memoryContext.projectId;
        if (!projectId) return null;
        const project = await projectRow(ownerId, projectId);
        if (!project) return null;
        const base = { projectId, projectCreatedAt: project.projectCreatedAt, project };
        if (!commit.engineSession) return base;
        const sessionId = platformSessionOf(commit.engineSession);
        if (!sessionId) return null;
        // The commit ledger's binding is the proof that this conversation is this project's (production also asks the run ledger).
        if (await overlay.projectOfSession(ownerId, commit.engineSession) !== projectId) return null;
        const meta = conversations.get(`${ownerId}\u0000${commit.engineSession}`);
        return { ...base, sessionId, runs: [], conversationTitle: historyTitle(meta?.title ?? "Conversation"), projectTitle: historyTitle(project.name, "Project"),
          conversationUrl: `/app/chat/${encodeURIComponent(sessionId)}` };
      },
      eligible: async () => true,
      admitMessage: async (memoryContext, source, message) => (await admission.admit({ user: { id: memoryContext.ownerId }, project: source.project,
        engineSessionId: `dsh-${source.sessionId}`, at: isoOk(message?.created_at) ? Date.parse(message.created_at) : null })).learn,
    });
    worker.history = history;
    worker.verification.history = history;
    nativeMemory.history = history;

    /** @type {Map<string, { taskId: string, adds: number, updates: number, deletes: number, added: number, updated: number, deleted: number }[]>} */
    const consolidationTasks = new Map();
    const consolidation = new NativeMemoryConsolidation({
      config, memorySettings, sessions, resources, overlay, verification: worker.verification, now: () => new Date(), report: say,
      ingest: async (userId, task) => {
        const counts = await worker.ingestConsolidation(userId, task);
        const list = consolidationTasks.get(userId) ?? [];
        list.push({ taskId: task.taskId, adds: task.adds.length, updates: task.updates.length, deletes: task.deletes.length, ...counts });
        consolidationTasks.set(userId, list);
        return counts;
      },
    });

    /** bearer → identity, and (user, project) → bearer @type {Map<string, { userId: string, projectId: string }>} */
    const identities = new Map();
    /** @type {Map<string, string>} */
    const tokens = new Map();
    /** @param {string} userId @param {string} projectId */
    const tokenFor = (userId, projectId) => {
      const key = `${userId}\u0000${projectId}`;
      let token = tokens.get(key);
      if (!token) {
        token = `lab-${randomBytes(24).toString("hex")}`;
        tokens.set(key, token);
        identities.set(token, { userId, projectId });
        bearers.add(token);
      }
      return token;
    };
    const runtimeManager = {
      /** @param {string | undefined} token */
      assertActiveEviMedWorkloadToken: async (token) => {
        const identity = token ? identities.get(token) : undefined;
        if (!identity) throw new Error("unknown workload");
        return identity;
      },
    };
    const gatewayGroup = await startLabGateways({
      runtimeManager, store, sessions, admission, overlay, memoryContexts: contexts, memoryTool: nativeMemory,
      admissionFor: (merged) => createMemoryAdmission({ config: merged, memorySettings }),
      historySecrets: history.secrets,
      historySearch: (request) => history.search(request),
      historySearchFor: selected => request => history.search(request,{ retrievalV2:selected.memoryHistoryRetrievalV2Enabled === true }),
    }, config, answerVariants);
    const gateway = gatewayGroup.gateways.get("");
    const handler = gateway.handler;
    server = gatewayGroup;

    /** One REST call of the plugin's own kind through the gateway; a refusal throws. @param {string} token @param {string} method @param {string} path @param {unknown} [body] */
    const gatewayCall = async (token, method, path, body) => {
      const response = await fetch(`${gateway.base}${path}`, {
        method, signal: AbortSignal.timeout(engineTimeoutMs * 2),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.status === "error") throw Object.assign(new Error(`gateway ${method} ${path.split("?")[0].replace(/sessions\/[^/]+/, "sessions/:id")} -> ${response.status}: ${json?.error?.code ?? "refused"}`), { code: json?.error?.code ?? `http_${response.status}` });
      return json;
    };

    /** @param {string} userId @param {string} taskId @param {number} deadline */
    const waitTask = async (userId, taskId, deadline) => {
      for (;;) {
        const task = await sessions.task(userId, taskId).catch((error) => ({ status: "unreadable", error: errorLine(error) }));
        if (!task) return { status: "gone" };
        if (["completed", "failed", "cancelled", "canceled"].includes(String(task.status))) return task;
        if (Date.now() >= deadline) return { ...task, status: "timeout" };
        await sleep(pollMs);
      }
    };

    /**
     * The worker settles what the ledger is owed for this account: the session's commit, and what settling it starts (a promoted
     * repeated choice, a replay), waited for in bounded rounds.
     * @param {string} userId @param {number} deadline
     */
    const settle = (userId, deadline) => settleLabCommits({ worker, overlay, userId, deadline, waitTask, pollMs });

    /** The messages of the session's archives that came from the conversation (the project line is the gateway's own). @param {string} userId @param {any[]} commits @param {string | null} line */
    const archivedMessages = async (userId, commits, line) => {
      let count = 0;
      for (const commit of commits) {
        const raw = await sessions.read(userId, `${commit.archiveUri}/messages.jsonl`).catch(() => null);
        for (const text of String(raw ?? "").split("\n")) {
          if (!text.trim()) continue;
          let message;
          try { message = JSON.parse(text); } catch { continue; }
          const body = typeof message?.content === "string" ? message.content : Array.isArray(message?.parts) ? message.parts.map((/** @type {any} */ part) => part?.text ?? "").join("") : "";
          if (line && message?.role === "assistant" && body === line) continue;
          count += 1;
        }
      }
      return count;
    };

    const facts = { engineVersion: health.version, templatesMounted: /** @type {boolean | null} */ (null), memoryTypes: /** @type {string[] | null} */ (null), policyRewritten: 0 };

    const lab = {
      runId: run, account, config, facts,
      /** The product's pieces, for a caller that needs one directly (tests, probes). */
      parts: { database, overlay, sessions, client, worker, nativeMemory, history, consolidation, contexts, admission, memorySettings, residentProfiles, handler, gatewayBase: gateway.base },

      async health() { return sessions.health(); },

      /**
       * The engine user and the control-plane user row of one dataset user (idempotent: a rerun finds both).
       * @param {string} userKey @returns {Promise<LabUser>}
       */
      async user(userKey) {
        const userId = controlUserId(run, userKey);
        await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $2, 'development') ON CONFLICT (id) DO NOTHING", [userId, `capsule proving ${String(userKey).slice(0, 60)}`]);
        await ensureProject(userId, null);
        await sessions.register(userId);
        await overlay.noteRegistered(userId);
        // The worker's policy check (`#syncPolicy`): the account's type allowlist is the deployment's, restated when it is not.
        const held = stockEngine ? null : await sessions.settings(userId);
        const expected = [...OPENVIKING_MEMORY_TYPES].sort();
        if (held && !(held.memoryTypes.length === expected.length && held.memoryTypes.every((type, index) => type === expected[index]))) {
          const settings = await memorySettings.settings(userId);
          await sessions.setLearning(userId, !settings.learningPaused);
          facts.policyRewritten += 1;
        }
        // The experiment varies only the engine templates. Its default policy must never be restated with product types.
        // processCommits normally leaves policy sync to tick; guard that path too for any future lab worker invocation.
        if (stockEngine) worker.policyChecked.set(userId, Infinity);
        facts.memoryTypes ??= (await sessions.settings(userId))?.memoryTypes ?? null;
        if (!stockEngine && facts.templatesMounted === null) {
          // 400 "not editable" means the deployment's templates are mounted; 404 means the engine fell back to its built-in types.
          try { await client.request({ path: `/api/v1/admin/accounts/${account}/memory-templates/people`, userId }); facts.templatesMounted = true; }
          catch (error) { const status = Number(/** @type {any} */ (error)?.upstreamStatus) || 0; facts.templatesMounted = status === 400 ? true : status === 404 ? false : null; }
        }
        return { userId, userKey: String(userKey), engineUser: sessions.engineUser(userId) };
      },

      /** Conversation metadata for raw history without ingesting (a resumed run notes the sessions it skips). @param {LabUser} user @param {LabSession} session */
      noteConversation(user, session) {
        const first = session.messages.find((message) => message.role === "user") ?? session.messages[0];
        conversations.set(`${user.userId}\u0000${engineSessionId(run, user.userKey, session.sessionId)}`, { title: String(first?.text ?? "").slice(0, 200), at: session.at });
      },

      /**
       * One dataset session, as the product would learn it: messages through the gateway's door (with `created_at`), the
       * project line where production writes it, a commit through `commitSession`, the extraction awaited, the worker's settle.
       * Attachments are never sent. A rerun of a session already committed resumes from its commits instead of sending again.
       * @param {LabUser} user @param {LabSession} session @param {{ commitEvery?: "session" | "turn", timeoutMs?: number, resumeMessages?: boolean }} [options]
       */
      async ingestSession(user, session, { commitEvery: mode = commitEvery, timeoutMs = extractionTimeoutMs, resumeMessages = false } = {}) {
        const started = Date.now();
        const deadline = started + timeoutMs;
        const project = session.project && session.project.id !== DEFAULT_PROJECT_ID ? session.project : null;
        const projectId = project?.id ?? DEFAULT_PROJECT_ID;
        await ensureProject(user.userId, project);
        lab.noteConversation(user, session);
        const engineSession = engineSessionId(run, user.userKey, session.sessionId);
        const token = tokenFor(user.userId, projectId);
        const times = messageTimes(session);
        const bodies = session.messages.map((message, index) => capturedBody(message, times[index]));
        const forwardedAt = bodies.map((body) => "forward" in filterCapturedMessage(body));
        const dropped = forwardedAt.filter((forwarded) => !forwarded).length;
        const owner = await store.userById(user.userId);
        const projectView = await store.requireProject(owner, projectId);
        const line = project ? projectContextLine(project.name) : null;
        const turns = mode === "turn" ? splitTurns(session.messages) : [/** @type {[number, number]} */ ([0, session.messages.length])];
        const prior = await overlay.commitsOfSession(user.userId, engineSession);
        /** @type {{ taskId: string | null, archiveUri: string | null, outcome: string, task?: any }[]} */
        const commits = [];
        let resumed = false;
        const commitNow = async () => {
          const answer = await handler.commitSession({ user: owner, project: projectView, engineSessionId: engineSession });
          const result = answer?.json?.result ?? {};
          commits.push({ taskId: typeof result.task_id === "string" ? result.task_id : null, archiveUri: typeof result.archive_uri === "string" ? result.archive_uri : null, outcome: answer.commit });
        };
        if (prior.length && mode === "session" && !resumeMessages) {
          resumed = true;
          for (const commit of prior) commits.push({ taskId: commit.taskId, archiveUri: commit.archiveUri, outcome: "resumed" });
        } else {
          let skipThrough = -1;
          if (prior.length) {
            // A turn-by-turn session cut short: its pending messages close as one commit, and what the archives hold is not sent again.
            resumed = true;
            for (const commit of prior) commits.push({ taskId: commit.taskId, archiveUri: commit.archiveUri, outcome: "resumed" });
            const pending = Number((await sessions.readSession(user.userId, engineSession).catch(() => null))?.result?.message_count) || 0;
            if (pending > 0) { await commitNow(); }
            const archived = await archivedMessages(user.userId, [...prior, ...commits.filter((commit) => commit.outcome !== "resumed" && commit.archiveUri)], line);
            let seen = 0;
            for (let index = 0; index < bodies.length && seen < archived; index += 1) if (forwardedAt[index]) { seen += 1; skipThrough = index; }
          } else {
            // Never committed: what an interrupted attempt left pending goes, so nothing is sent twice.
            const pending = Number((await sessions.readSession(user.userId, engineSession).catch(() => null))?.result?.message_count) || 0;
            if (pending > 0) await sessions.deleteSession(user.userId, engineSession);
          }
          await gatewayCall(token, "POST", "/api/v1/sessions", { session_id: engineSession });
          for (const [start, end] of turns) {
            if (end - 1 <= skipThrough) continue;
            for (let index = Math.max(start, skipThrough + 1); index < end; index += 1) {
              conversationClock.set(user.userId, times[index]);
              await gatewayCall(token, "POST", `/api/v1/sessions/${engineSession}/messages`, bodies[index]);
            }
            await commitNow();
          }
        }
        if (times.length) conversationClock.set(user.userId, times[times.length - 1]);
        const extractionStarted = Date.now();
        for (const commit of commits) if (commit.taskId) commit.task = await waitTask(user.userId, commit.taskId, deadline);
        const extractionMs = Date.now() - extractionStarted;
        const revisionMark = Number((await database.query("SELECT coalesce(max(id), 0)::text AS id FROM evimed_memory.native_revisions WHERE user_id=$1", [user.userId])).rows[0]?.id ?? 0);
        const settled = await settle(user.userId, Math.max(deadline, Date.now() + 60_000));
        const root = sessions.memoryRoot(user.userId);
        const operations = { adds: 0, updates: 0, deletes: 0 };
        let observations = 0;
        const extractionTokens = sessionUsage(commits.map((commit) => commit.task ?? null));
        const usage = extractionTokens.total;
        for (const commit of commits) {
          if (!commit.archiveUri) continue;
          const diffUri = typeof commit.task?.result?.memory_diff_uri === "string" ? commit.task.result.memory_diff_uri : `${commit.archiveUri}/memory_diff.json`;
          const text = await sessions.read(user.userId, diffUri).catch(() => null);
          let diff = null;
          try { diff = text ? JSON.parse(text) : null; } catch { diff = null; }
          const counted = countDiffOperations(diff, root);
          operations.adds += counted.adds; operations.updates += counted.updates; operations.deletes += counted.deletes; observations += counted.observations;
        }
        const refusals = (await database.query(`SELECT reason, count(*)::int AS n FROM evimed_memory.native_revisions WHERE user_id=$1 AND id>$2::bigint AND actor='platform' GROUP BY reason`,
          [user.userId, String(revisionMark)])).rows;
        const last = commits.at(-1) ?? null;
        const ledger = last?.archiveUri ? await overlay.commit(user.userId, last.archiveUri) : null;
        const historyRow = last?.archiveUri ? (await database.query("SELECT state, reason, indexed_chunks FROM evimed_memory.history_archives WHERE owner_id=$1 AND archive_uri=$2 ORDER BY updated_at DESC LIMIT 1",
          [user.userId, last.archiveUri])).rows[0] ?? null : null;
        return {
          sessionId: session.sessionId, engineSession, at: session.at, project: project ? project.id : null,
          messages: session.messages.length, userTurns: session.messages.filter((message) => message.role === "user").length, dropped,
          attachmentsWithheld: Array.isArray(session.attachments) ? session.attachments.length : 0,
          commit: { taskId: last?.taskId ?? null, status: String(last?.task?.status ?? last?.outcome ?? "none"), outcome: last?.outcome ?? "none", archiveUri: last?.archiveUri ?? null },
          ...(commits.length > 1 ? { commits: commits.map((commit, index) => ({ taskId: commit.taskId, status: String(commit.task?.status ?? commit.outcome), outcome: commit.outcome, usage: extractionTokens.perCommit[index] })) } : {}),
          operations, observations, usage,
          ledger: ledger ? { forgetRequests: ledger.extraction?.forgetRequests ?? null, state: ledger.state, operations: ledger.operations, error: ledger.error ? scrub(ledger.error).slice(0, 200) : "" } : null,
          refused: Object.fromEntries(refusals.map((row) => [String(row.reason || "unspecified"), Number(row.n)])),
          settle: settled,
          history: historyRow ? { state: historyRow.state, reason: historyRow.reason, chunks: Number(historyRow.indexed_chunks) || 0 } : null,
          ...(resumed ? { resumed: true } : {}),
          commitEvery: mode, extractionMs, ms: Date.now() - started,
        };
      },

      /**
       * Every memory file of the account, by path under `memories/` (`run_native_eval`'s filter), and its size.
       * @param {LabUser} user
       * @returns {Promise<{ files: Record<string, string>, metrics: { files: number, chars: number },
       *   openingUsage: Record<string, {usedCount: number, lastUsedAt: string|null}>, openingListing?: Record<string, string[]> }>}
       */
      async snapshot(user) {
        const root = sessions.memoryRoot(user.userId);
        const nodes = await sessions.tree(user.userId, root, { levelLimit: 8 });
        const wanted = nodes.filter((node) => !node.isDir).map((node) => ({ uri: node.uri, rel: memoryFileRel(node.uri, root) })).filter((item) => item.rel)
          .sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
        /** @type {Record<string, string>} */
        const files = {};
        for (let index = 0; index < wanted.length; index += 6) {
          const batch = wanted.slice(index, index + 6);
          const texts = await Promise.all(batch.map((item) => sessions.read(user.userId, item.uri)));
          batch.forEach((item, position) => { files[/** @type {string} */ (item.rel)] = texts[position] ?? ""; });
        }
        // Usage and the actual startup REST selection make the by-use experiment auditable.
        const held = await overlay.files(user.userId);
        const openingUsage = Object.fromEntries([...held.values()].map((file) => [memoryFileRel(file.uri, root),
          { usedCount: file.usedCount, lastUsedAt: file.lastUsedAt }]).filter(([rel]) => rel));
        let openingListing;
        if (config.memoryOpeningByUseEnabled === true) {
          const memory = lab.memoryFor(user);
          openingListing = {};
          for (const group of ["preferences", "entities"]) {
            const response = await memory.fetchJSON(`/api/v1/fs/ls?uri=${encodeURIComponent(`${root}/${group}`)}&output=agent&recursive=true&abs_limit=512&node_limit=512`);
            if (!response.ok) throw new Error(`opening listing failed: ${response.status}`);
            openingListing[group] = response.result.filter((entry) => !entry.isDir).map((entry) => entry.rel_path ?? entry.name);
          }
        }
        return { files, metrics: { files: Object.keys(files).length, chars: Object.values(files).reduce((sum, text) => sum + text.length, 0) },
          openingUsage, ...(openingListing ? { openingListing } : {}) };
      },

      /**
       * What the answering model reaches memory through, in one project of the account.
       * @param {LabUser} user @param {{ project?: { id: string, name: string } | null, variant?: string, readOnly?: boolean, executeForget?: boolean }} [options]
       */
      memoryFor(user, { project = null, variant = "", readOnly = true, executeForget = false } = {}) {
        const selected = gatewayGroup.gateways.get(variant);
        if (!selected) throw new Error(`unknown answer variant ${variant}`);
        const profiles = variant ? profilesFor(selected.config) : residentProfiles;
        // Reads share the same memory. With opening-by-use enabled, reads count as use, so variants are not independent.
        const named = project && project.id !== DEFAULT_PROJECT_ID ? project : null;
        const projectId = named?.id ?? DEFAULT_PROJECT_ID;
        const ready = ensureProject(user.userId, named);
        ready.catch(() => {});
        const memoryClient = createMemoryClient({ base: selected.base, token: tokenFor(user.userId, projectId), readOnly, executeForget, ready, timeoutMs: engineTimeoutMs * 2 });
        return {
          ...memoryClient,
          config: selected.config,
          project: named,
          /** The product dispatch path, including native index and use-ranked files in the default project. */
          async residentBlock() {
            await ready;
            const block = await profiles.forDispatch(user.userId, { projectId, sessionId: null, attended: true });
            return block.text ? block.text : null;
          },
        };
      },

      /** Poll the product's explicit consolidation entry, preserving its mode and result history.
       * @param {LabUser} user @param {{ mode?: string, timeoutMs?: number }} [options]
       */
      async consolidate(user, { mode = config.nativeMemoryConsolidationMode ?? "merge", timeoutMs = 1_800_000 } = {}) {
        const started = Date.now();
        consolidationTasks.delete(user.userId);
        const before = nativeMemoryCounters();
        const { outcome, results } = await pollLabConsolidation(consolidation, user.userId, { mode, timeoutMs, pollMs: Math.max(pollMs, 3_000) });
        const after = nativeMemoryCounters();
        const delta = (name) => Object.fromEntries(Object.entries(after[name]).map(([key, value]) => [key, value - (before[name][key] ?? 0)]));
        return { outcome, mode, results, ticks: results.length,
          tasks: consolidationTasks.get(user.userId) ?? [], verification: delta("verificationLines"),
          verificationJudge: delta("verificationJudge"), ms: Date.now() - started };
      },

      /** Verify existing lines independently of the engine merge. */
      async verifyExisting(user, { limit = 200 } = {}) {
        return verifyLabExisting(consolidation, user.userId, { limit, mode: "verify" });
      },

      /** Plant a corruption into both the engine and the control-plane overlay. */
      async replaceFile(user, relPath, text) { return replaceLabFile({ sessions, overlay }, user, String(relPath ?? ""), String(text ?? "")); },

      /** Erase one account: the product's own account erasure, then its control-plane row. @param {LabUser} user */
      async eraseUser(user) {
        const erased = await nativeMemory.eraseAccount(user.userId);
        await history.drainDeletes(user.userId).catch(() => {});
        await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.userId]);
        for (const [key, token] of tokens) if (key.startsWith(`${user.userId}\u0000`)) { tokens.delete(key); identities.delete(token); }
        for (const key of projectsMade.keys()) if (key.startsWith(`${user.userId}\u0000`)) projectsMade.delete(key);
        return erased;
      },

      /** Delete the whole engine account and every control-plane row of this run (users, and the history ledger rows they leave). */
      async eraseAccount() {
        // The engine deletes an account as a task of its own, and one asked right after a user's deletion was measured to end with
        // the account active again: the listing is read until the account is gone, and the deletion is asked again when it reverts.
        const listed = async () => {
          const body = await client.request({ path: "/api/v1/admin/accounts" });
          return (Array.isArray(body?.result) ? body.result : []).find((/** @type {any} */ entry) => entry?.account_id === account) ?? null;
        };
        let engine = "pending";
        for (let attempt = 0; attempt < 4 && engine === "pending"; attempt += 1) {
          try { await client.request({ method: "DELETE", path: `/api/v1/admin/accounts/${account}` }); }
          catch (error) {
            const status = Number(/** @type {any} */ (error)?.upstreamStatus);
            if (status === 404) { engine = attempt ? "deleted" : "absent"; break; }
            if (status !== 409 && status !== 412) { engine = `failed: ${errorLine(error)}`; break; }
          }
          for (let poll = 0; poll < 30; poll += 1) {
            await sleep(1_000);
            const entry = await listed().catch(() => undefined);
            if (entry === null) { engine = "deleted"; break; }
            if (entry && entry.status !== "deleting") break;
          }
        }
        const prefix = controlUserPrefix(run);
        for (const table of ["history_chunks", "history_archives", "history_fences"]) {
          await database.query(`DELETE FROM evimed_memory.${table} WHERE left(owner_id, length($1)) = $1`, [prefix]).catch(() => {});
        }
        const removed = await database.query("DELETE FROM evimed_control.users WHERE left(id, length($1)) = $1", [prefix]);
        tokens.clear(); identities.clear(); projectsMade.clear();
        return { engine, users: removed.rowCount ?? 0 };
      },

      async close() {
        await gatewayGroup.close();
        server = null;
        await database.close();
      },

      redact: scrub,
      errorLine,
    };
    return lab;
  } catch (error) {
    if (server) await server.close().catch(() => {});
    await database.close().catch(() => {});
    throw new Error(`the lab could not open: ${firstLine(error, secrets)}`);
  }
}
