/** Restricted, workload-authenticated MCP bridge; the sidecar credential never enters a runtime. */
import { readFileSync } from "node:fs";
const catalogue = JSON.parse(readFileSync(new URL("./toolUniverseCatalogue.json", import.meta.url), "utf8"));
import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const TOOL_UNIVERSE_GATEWAY_PATH = "/internal/tooluniverse/v1/rpc";
const MCP_TOOLS = new Set(["list_tools", "grep_tools", "get_tool_info", "execute_tool"]);
const CLINICAL_TOOLS = new Set(Object.values(catalogue.categories).flat());
const DISCOVERY_PARAMETERS = {
  list_tools: ["mode", "categories", "group_by_category", "brief", "limit", "offset"],
  grep_tools: ["pattern", "field", "search_mode", "limit", "offset", "categories"],
  get_tool_info: ["tool_names", "detail_level"],
};
const LIST_MODES = ["names", "basic", "categories", "by_category", "summary"];
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const unavailable = () => new HttpError(502, "tooluniverse_upstream_unavailable", "The optional scientific tool service is unavailable.");

/** @param {Response} response */
async function readResponse(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** @param {unknown} body */
function validateRequest(body) {
  const value = /** @type {any} */ (body);
  const invalid = () => new HttpError(400, "tooluniverse_request_invalid", "Unsupported scientific tool request.");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["method", "params"].includes(key))) throw invalid();
  if (value.method === "tools/list") {
    if (value.params && (typeof value.params !== "object" || Array.isArray(value.params) || Object.keys(value.params).length)) throw invalid();
    return { method: value.method };
  }
  const params = value.params;
  if (value.method !== "tools/call" || !params || typeof params !== "object" || Array.isArray(params)
    || Object.keys(params).some(key => !["name", "arguments"].includes(key)) || !MCP_TOOLS.has(params.name)) throw invalid();
  if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))) throw invalid();
  if (params.name === "execute_tool") {
    if (!CLINICAL_TOOLS.has(params.arguments?.tool_name)
      || Object.keys(params.arguments).some(key => !["tool_name", "arguments"].includes(key))) throw invalid();
    const tool = params.arguments.tool_name;
    let arguments_ = params.arguments.arguments ?? {};
    if (typeof arguments_ === "string") {
      try { arguments_ = JSON.parse(arguments_); } catch { throw invalid(); }
    }
    if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)
      || Object.keys(arguments_).some(key => !catalogue.parameters[tool].includes(key))) throw invalid();
    // These fields are interpolated into provider paths by the pinned code.
    // Search text is provider query data; identifiers are a closed grammar.
    if (arguments_.pmid !== undefined && !/^[1-9][0-9]{0,11}$/.test(String(arguments_.pmid))) throw invalid();
    if (arguments_.nct_id !== undefined && !/^NCT[0-9]{8}$/.test(String(arguments_.nct_id))) throw invalid();
    if (arguments_.nct_ids !== undefined && (!Array.isArray(arguments_.nct_ids) || arguments_.nct_ids.length > 100
      || arguments_.nct_ids.some(id => typeof id !== "string" || !/^NCT[0-9]{8}$/.test(id)))) throw invalid();
    if (arguments_.source !== undefined && !["MED", "PMC", "PPR", "PAT", "AGR", "CBA", "HIR", "CTX", "ETH", "CIT"].includes(arguments_.source)) throw invalid();
    if (arguments_.article_id !== undefined) {
      const source = arguments_.source ?? "MED";
      const accession = String(arguments_.article_id);
      const pattern = source === "MED" ? /^[1-9][0-9]{0,11}$/ : source === "PMC" ? /^(?:PMC)?[1-9][0-9]{0,11}$/
        : source === "PPR" ? /^PPR[1-9][0-9]{0,11}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
      if (!pattern.test(accession)) throw invalid();
    }
    return { method: value.method, params: { name: params.name, arguments: { tool_name: tool, arguments: arguments_ } } };
  }
  const arguments_ = params.arguments ?? {};
  if (Object.keys(arguments_).some(key => !DISCOVERY_PARAMETERS[params.name].includes(key))) throw invalid();
  if (arguments_.limit !== undefined && (!Number.isInteger(arguments_.limit) || arguments_.limit < 1 || arguments_.limit > 200)) throw invalid();
  if (arguments_.offset !== undefined && (!Number.isInteger(arguments_.offset) || arguments_.offset < 0 || arguments_.offset > 10000)) throw invalid();
  if (arguments_.categories !== undefined && (!Array.isArray(arguments_.categories) || arguments_.categories.length > 5
    || arguments_.categories.some(category => ![...Object.keys(catalogue.categories), "compact_mode"].includes(category)))) throw invalid();
  if (params.name === "grep_tools") {
    if (typeof arguments_.pattern !== "string" || !arguments_.pattern || arguments_.pattern.length > 256
      || (arguments_.search_mode !== undefined && arguments_.search_mode !== "text")
      || (arguments_.field !== undefined && !["name", "description", "type", "category"].includes(arguments_.field))) throw invalid();
  }
  if (params.name === "list_tools" && arguments_.mode !== undefined && !LIST_MODES.includes(arguments_.mode)) throw invalid();
  if (params.name === "get_tool_info") {
    const names = typeof arguments_.tool_names === "string" ? [arguments_.tool_names] : arguments_.tool_names;
    if (!Array.isArray(names) || !names.length || names.length > 20 || names.some(name => typeof name !== "string" || name.length > 128)
      || (arguments_.detail_level !== undefined && !["description", "full"].includes(arguments_.detail_level))) throw invalid();
  }
  return { method: value.method, params: { name: params.name, arguments: arguments_ } };
}

/** @param {string} name @param {any} schema */
function hostedParameterSchema(name, schema) {
  const allowed = catalogue.parameters[name] ?? DISCOVERY_PARAMETERS[name];
  if (!allowed || !schema) return schema;
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => allowed.includes(key)));
  if (name === "grep_tools") {
    properties.search_mode = { type: "string", enum: ["text"], default: "text", description: "Literal case-insensitive matching." };
    properties.pattern = { type: "string", minLength: 1, maxLength: 256, description: "Literal text to match." };
  }
  if (name === "list_tools" && properties.mode) properties.mode = { ...properties.mode, enum: LIST_MODES };
  if (properties.limit) properties.limit = { ...properties.limit, minimum: 1, maximum: 200 };
  if (properties.offset) properties.offset = { ...properties.offset, minimum: 0, maximum: 10000 };
  return { ...schema, properties, required: (schema.required ?? []).filter(key => allowed.includes(key)), additionalProperties: false };
}

/** Project the pinned discovery response onto the same arguments execution accepts. @param {any} result */
function boundedToolInfo(result) {
  const project = (value) => {
    if (Array.isArray(value?.tools)) return { ...value, tools: value.tools.map(project) };
    if (!value?.name || value.error) return value;
    if (!CLINICAL_TOOLS.has(value.name) && !MCP_TOOLS.has(value.name)) return { name: value.name, error: "This tool is not exposed by the deployment." };
    const allowed = catalogue.parameters[value.name] ?? DISCOVERY_PARAMETERS[value.name];
    if (!allowed) return value;
    const { test_examples: _examples, ...rest } = value;
    return { ...rest,
      ...(value.name === "EuropePMC_search_articles" ? { description: "Search Europe PMC metadata with a fielded query. Retrieve full text through EviMed's managed source tools." } : {}),
      ...(value.parameter ? { parameter: hostedParameterSchema(value.name, value.parameter) } : {}),
    };
  };
  return { ...result,
    ...(result.structuredContent ? { structuredContent: project(result.structuredContent) } : {}),
    content: (result.content ?? []).map(item => item.type === "text"
      ? { ...item, text: JSON.stringify(project(JSON.parse(item.text))) } : item),
  };
}

/** @param {{config:any,runtimeManager:any,store:any,evaluationIsolation?:any,fetchImpl?:typeof fetch}} dependencies */
export function createToolUniverseGateway({ config, runtimeManager, store, fetchImpl = fetch, evaluationIsolation = null }) {
  const active = new Set();
  const windows = new Map();
  let inFlight = 0;
  return async (req, res, onFailure = null) => {
    let release = null;
    try {
      if (req.method !== "POST" || req.url !== TOOL_UNIVERSE_GATEWAY_PATH) throw new HttpError(404, "not_found", "Route not found.");
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const identity = await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      await store.requireProject(user, identity.projectId);
      const key = JSON.stringify([identity.userId, identity.projectId]);
      const now = Date.now();
      for (const [id, window] of windows) if (window.until <= now) windows.delete(id);
      if (windows.size >= 10000 && !windows.has(key)) throw new HttpError(503, "tooluniverse_busy", "The scientific tool service is busy.");
      const window = windows.get(key) ?? { until: now + 60000, count: 0 };
      windows.set(key, window);
      if (++window.count > 120) throw new HttpError(429, "tooluniverse_rate_limited", "Too many scientific tool requests.");
      const input = validateRequest(await readJson(req, 1024 * 1024));
      await evaluationIsolation?.assertRequest(identity, "tooluniverse", input);
      await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const currentUser = await store.userById(identity.userId);
      if (!currentUser) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      await store.requireProject(currentUser, identity.projectId);
      const url = String(config.toolUniverseMcpUrl ?? "").trim();
      const credential = String(config.toolUniverseApiToken ?? "");
      if (!url || !/^[A-Za-z0-9_-]{32,256}$/.test(credential)) throw new HttpError(503, "tooluniverse_unavailable", "The optional scientific tool service is not configured.");
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) throw unavailable();
      if (inFlight >= 2 || active.has(key)) throw new HttpError(429, "tooluniverse_busy", "The scientific tool service is busy; retry shortly.");
      inFlight += 1;
      active.add(key);
      release = () => { inFlight -= 1; active.delete(key); };
      const signal = AbortSignal.timeout(60000);
      const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
      let session = null;
      const rpc = async (body) => {
        const response = await fetchImpl(target, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
        const sessionId = response.headers.get("mcp-session-id");
        if (sessionId) {
          if (!/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw unavailable();
          session = sessionId;
          headers["mcp-session-id"] = sessionId;
        }
        const text = await readResponse(response);
        if (!("id" in body)) return null;
        const messages = text.trimStart().startsWith("{") ? [JSON.parse(text)]
          : text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
        const reply = messages.find(message => message?.jsonrpc === "2.0" && message.id === body.id);
        if (!reply || reply.error || !Object.hasOwn(reply, "result")) throw unavailable();
        return reply.result;
      };
      let result;
      try {
        const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "evimed-workload-bridge", version: "1" } } });
        if (typeof initialized?.protocolVersion !== "string") throw unavailable();
        headers["mcp-protocol-version"] = initialized.protocolVersion;
        await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
        await runtimeManager.assertActiveEviMedWorkloadToken(token);
        result = await rpc({ jsonrpc: "2.0", id: 2, ...input });
        if (input.method === "tools/call" && input.params.name === "get_tool_info" && !result?.isError) result = boundedToolInfo(result);
        if (input.method === "tools/list") {
          if (!Array.isArray(result?.tools) || result.tools.length !== MCP_TOOLS.size || new Set(result.tools.map(tool => tool.name)).size !== MCP_TOOLS.size
            || result.tools.some(tool => !MCP_TOOLS.has(tool.name))) throw unavailable();
          result = { ...result, tools: result.tools.map(tool => ({ ...tool, inputSchema: hostedParameterSchema(tool.name, tool.inputSchema) })) };
        }
      } finally {
        if (session) {
          // Close this request's private MCP session, including after failure.
          // A separate short deadline still permits cleanup after the call timed out.
          await fetchImpl(target, { method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(2000) })
            .then(response => response.body?.cancel()).catch(() => {});
        }
      }
      await runtimeManager.assertActiveEviMedWorkloadToken(token);
      if (!await store.userById(identity.userId)) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      sendJson(res, 200, { result: evaluationIsolation ? await evaluationIsolation.filter(identity, "tooluniverse", result) : result });
    } catch (error) {
      const failure = error instanceof HttpError ? error : unavailable();
      onFailure?.({ code: failure.code, status: failure.status });
      sendError(res, failure);
    } finally { release?.(); }
  };
}
